// 3D テーマ4(T6) ― GPUパーティクル（魔法/噴水）（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。数値・色・寿命・カメラは three.js リファレンスに一致させる。
// PlayCanvas では particlesystem コンポーネント（GPU 加速）で噴水を表現する。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const N_MAX = 500000, N_INIT = 20000, N_STEP = 20000, N_MIN = 5000;
const LIFE = 3.0, GRAVITY = -9.0;
const SPEED_MIN = 4, SPEED_MAX = 10;
const SPEED_MID = (SPEED_MIN + SPEED_MAX) / 2; // 7（initialVelocity 代表値）

// ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） ----------------
const canvas = document.getElementById("app");
const app = new pc.Application(canvas, {
  graphicsDeviceOptions: {
    deviceTypes: [pc.DEVICETYPE_WEBGL2], // WebGL2 を明示（WebGPU は使わない）
    antialias: true,
    alpha: false,
  },
});
const device = app.graphicsDevice;
// 960x540 固定解像度
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);
// ライト不要（加算発光のため。粒子は自発光色）。

// ---- numParticles 実上限の算出 ----------------------------------------------
// particlesystem は per-particle 状態を sqrt(numParticles) 四方のテクスチャに格納する。
// よって実上限は maxTextureSize^2。SPEC の N_MAX=500000 は ~708^2 で通常の
// maxTextureSize(>=4096) に十分収まるが、安全のためデバイス上限でクランプする。
const TEX_MAX = device.maxTextureSize || 4096;
const N_CAP = Math.min(N_MAX, TEX_MAX * TEX_MAX);

// ---- カメラ -----------------------------------------------------------------
const camEntity = new pc.Entity("camera");
camEntity.addComponent("camera", {
  fov: 55,                 // 垂直基準・度
  nearClip: 0.1,
  farClip: 2000,
  clearColor: new pc.Color(0x05 / 255, 0x06 / 255, 0x0a / 255), // #05060a
});
camEntity.setPosition(0, 8, 26);
camEntity.lookAt(0, 5, 0);
app.root.addChild(camEntity);

// ---- パーティクルテクスチャ（放射状グラデを canvas で生成 → pc.Texture） -----
// 画像ファイル不使用。ソフトな円形スプライト（中心白→外周透明）。加算で発光が乗る。
function createParticleTexture() {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.25)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);

  const tex = new pc.Texture(device, {
    width: S, height: S,
    format: pc.PIXELFORMAT_R8_G8_B8_A8,
    mipmaps: true,
  });
  tex.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
  tex.magFilter = pc.FILTER_LINEAR;
  tex.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
  tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
  tex.setSource(c);
  return tex;
}
const particleTex = createParticleTexture();

// ---- カラー / アルファ / スケール / 速度カーブ -------------------------------
// 色（加算ブレンド）: 黄 #fff1a8 → 橙 #ff8a3d → 赤紫。three.js の c0/c1/c2 と一致。
// #fff1a8 = (1.000, 0.945, 0.659) / #ff8a3d = (1.000, 0.541, 0.239) / 赤紫 = (0.55, 0.12, 0.35)
const colorGraph = new pc.CurveSet([
  [0, 1.00, 0.5, 1.00, 1, 0.55], // R
  [0, 0.945, 0.5, 0.541, 1, 0.12], // G
  [0, 0.659, 0.5, 0.239, 1, 0.35], // B
]);
colorGraph.type = pc.CURVE_LINEAR;

// アルファ: 1 → 0（寿命でフェードアウト）
const alphaGraph = new pc.Curve([0, 1, 1, 0]);
alphaGraph.type = pc.CURVE_LINEAR;

// スケール: 誕生大 → 消滅小（three.js の gl_PointSize 1.0→0.3 相当）
const scaleGraph = new pc.Curve([0, 0.6, 1, 0.15]);
scaleGraph.type = pc.CURVE_LINEAR;

// 速度カーブ（重力 (0,-9,0) を時間で近似）:
// PlayCanvas に明示 gravity が無いため velocityGraph(ワールド速度) の Y を時間で
// 線形に減少させ、上昇→落下の放物線を近似する。LIFE=3s で v_y(t)=v0 + g*t（g=-9）。
// 代表初速 SPEED_MID=7 を上方軸に与える。t=0→+7, t=LIFE→ 7 + (-9)*3 = -20。
const VY0 = SPEED_MID;                 // +7
const VY1 = SPEED_MID + GRAVITY * LIFE; // -20
// 水平（XZ）成分: 広めのコーンの広がりを velocityGraph2 との範囲指定で表現する。
// velocityGraph(中心) を 0、velocityGraph2 で ±水平速度幅を与え、Yは VY0→VY1。
const velocityGraph = new pc.CurveSet([
  [0, 0, 1, 0],         // X 中心 0
  [0, VY0, 1, VY1],     // Y: +7 → -20（重力近似の放物線）
  [0, 0, 1, 0],         // Z 中心 0
]);
velocityGraph.type = pc.CURVE_LINEAR;
// velocityGraph2 を与えると [graph, graph2] の範囲でランダム化される（広がり=コーン）。
// 水平の広がり ±5、Y も少し散らして 4〜10 域に近づける。
const velocityGraph2 = new pc.CurveSet([
  [0, 5, 1, 3],          // X 幅
  [0, VY0 + 3, 1, VY1 - 3], // Y 幅（初速 4〜10 域・落下も散らす）
  [0, 5, 1, 3],          // Z 幅
]);
velocityGraph2.type = pc.CURVE_LINEAR;

// ---- particlesystem を内包する Entity を（再）生成する -----------------------
// numParticles の変更は再初期化が要るため、count 変更時は Entity ごと作り直す。
let emitter = null;
let count = Math.max(N_MIN, Math.min(N_CAP, N_INIT));

function buildEmitter(n) {
  if (emitter) { emitter.destroy(); emitter = null; }
  const e = new pc.Entity("fountain");
  e.addComponent("particlesystem", {
    numParticles: n,
    lifetime: LIFE,            // 寿命 3.0s
    rate: LIFE / n,            // 寿命中に n 個を定常充填する emit 間隔
    rate2: LIFE / n,           // rate と同値（間隔のゆらぎ無し）
    startAngle: 0,
    startAngle2: 0,
    loop: true,
    preWarm: true,             // 起動時から定常噴水（無人ベンチ向け）
    lighting: false,           // 自発光（ライト不要）
    halfLambert: false,
    intensity: 1,
    depthWrite: false,         // 深度書き込み OFF（加算で重なり発光）
    depthSoftening: 0,
    blendType: pc.BLEND_ADDITIVE, // 加算ブレンド
    emitterShape: pc.EMITTERSHAPE_SPHERE,
    emitterRadius: 0.3,        // 原点付近の小半径エミッタ
    emitterRadiusInner: 0,
    // initialVelocity は球状エミッタからの放射状初速（全方向）。強すぎると下方にも飛ぶため
    // 小さめにし、上方噴出＋重力の主軸は velocityGraph(Y) で与える。コーンの広がり寄与。
    initialVelocity: 2,
    colorMap: particleTex,     // canvas 生成のソフト円形スプライト
    colorGraph: colorGraph,
    alphaGraph: alphaGraph,
    scaleGraph: scaleGraph,
    velocityGraph: velocityGraph,
    velocityGraph2: velocityGraph2,
    // localVelocityGraph は使わず、ワールド velocityGraph で重力放物線を近似する。
    sort: pc.PARTICLESORT_NONE, // ソート無効（GPU モード維持・加算なので順不同で可）
    animTilesX: 1, animTilesY: 1,
  });
  e.setPosition(0, 0, 0); // エミッタ = 原点 (0,0,0)
  app.root.addChild(e);
  // particlesystem コンポーネントの内部システムを取得して再生
  if (e.particlesystem) {
    e.particlesystem.reset();
    e.particlesystem.play();
  }
  emitter = e;
}

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
  else if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
  else if (k === "r") setCount(N_INIT);
});
function setCount(n) {
  const c = Math.max(N_MIN, Math.min(N_CAP, n | 0));
  if (c === count && emitter) return;
  count = c;
  buildEmitter(count); // numParticles 変更は再生成で対応
}

// ---- メインループ / HUD ------------------------------------------------------
let fps = 60, hudT = 0;
const hud = document.getElementById("hud");

app.on("update", (dtRaw) => {
  let dt = dtRaw;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  updateHUD();
});

function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回更新
  // Draws: v2 系は app.stats.drawCalls.total が正。
  const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
  const draws = (dc.total != null ? dc.total : dc.forward) || 0;
  hud.textContent =
    `FPS       ${fps.toFixed(1)}\n` +
    `Objects   ${count}\n` +
    `Particles ${count}\n` +
    `Draws     ${draws}\n` +
    `Points    ${count.toLocaleString()}`;
}

// ---- 起動 -------------------------------------------------------------------
buildEmitter(count);
app.start();
