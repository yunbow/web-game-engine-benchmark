// 3D テーマ4(T6) ― GPUパーティクル（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。粒子挙動の基準は three.js リファレンス(../three.js/game.js)。
// Babylon は WebGL2 の transform feedback による GPUParticleSystem を使う（真のGPUパーティクル）。
// 粒子の軌道は内部実装が違うため three.js と完全一致しないが、「粒子数・噴出の見た目の性質・
// 加算発光・数値の意味」を SPEC に合わせて揃える。
//
// 注意（決定的について）: GPUParticleSystem はエンジン内部で乱数（Math.random）を使うため、
// 粒子の個々の軌道は他ライブラリと完全一致しない（SPEC 注記どおり）。
// ゲームロジック側では Math.random を新たに使わない。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const N_MAX = 500000, N_INIT = 20000, N_STEP = 20000, N_MIN = 5000;
const LIFE = 3.0, GRAVITY = -9.0;
const SPEED_MIN = 4, SPEED_MAX = 10;

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（WebGPU は使わない）。GPUParticleSystem は WebGL2 が前提。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// 右手系（Y軸上向き・SPEC準拠）。背景 #05060a。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#05060aff");

// カメラ固定: 位置(0,8,26) / 注視(0,5,0) / fov=55°(垂直) / near0.1 / far2000。
// attachControl は呼ばない＝完全固定。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 8, 26), scene);
camera.setTarget(new BABYLON.Vector3(0, 5, 0));
camera.fov = 55 * Math.PI / 180;     // 垂直FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.1;
camera.maxZ = 2000;
// ライト不要（加算発光のため粒子は自発光色）。

// ---- パーティクルテクスチャ（コード生成・画像ファイル不使用） ----------------
// 小さな放射状グラデ（中心が明るく端で 0）を DynamicTexture で生成。
// SPEC: 点スプライトはソフトエッジの円形。加算ブレンドで重なって発光が増す。
function makeParticleTexture() {
  const S = 64;
  const dt = new BABYLON.DynamicTexture("pTex", { width: S, height: S }, scene, false);
  const ctx = dt.getContext();
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.75)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  dt.hasAlpha = true;
  dt.update();
  return dt;
}
const particleTexture = makeParticleTexture();

// ---- GPUParticleSystem 構築（IsSupported を確認） ---------------------------
const gpuSupported = BABYLON.GPUParticleSystem.IsSupported;
let system;
if (gpuSupported) {
  // capacity は最大数ぶん確保（再生成なしで activeParticleCount を増減できる）。
  system = new BABYLON.GPUParticleSystem("p", { capacity: N_MAX }, scene);
  // 表示数は activeParticleCount で制御（初期 N_INIT）。
  system.activeParticleCount = N_INIT;
} else {
  // 非対応環境では CPU の ParticleSystem にフォールバック（HUD/READMEに明記）。
  system = new BABYLON.ParticleSystem("p", N_MAX, scene);
}

system.particleTexture = particleTexture;

// エミッタ＝原点。点エミッタ（PointParticleEmitter）で direction1/2 のコーンに噴出。
system.emitter = BABYLON.Vector3.Zero();
system.createPointEmitter(
  // direction1 / direction2: 上方(+Y)を中心とする広めのコーン。
  // 仰角 35〜90° 相当 ⇒ 水平成分を ±0.7 程度に抑え +Y を強める。
  new BABYLON.Vector3(-0.7, 1.0, -0.7),
  new BABYLON.Vector3(0.7, 1.0, 0.7)
);

// 初速の速さ域 4〜10 u/s。
system.minEmitPower = SPEED_MIN;
system.maxEmitPower = SPEED_MAX;

// 重力 (0,-9,0)。放物線で上がって落ちる。
system.gravity = new BABYLON.Vector3(0, GRAVITY, 0);

// 寿命 3.0s（固定）。
system.minLifeTime = LIFE;
system.maxLifeTime = LIFE;

// emitRate = N / LIFE（寿命中に定常充填＝定常噴水）。activeParticleCount 変更時に追従。
system.emitRate = N_INIT / LIFE;

// 色グラデ（加算）: 黄#fff1a8(a=1) → 橙#ff8a3d → 赤紫#8c1f59(a=0)。
// #fff1a8 = (1.0, 0.945, 0.659) / #ff8a3d = (1.0, 0.541, 0.239) / #8c1f59 = (0.549, 0.122, 0.349)
system.addColorGradient(0.0, new BABYLON.Color4(1.0, 0.945, 0.659, 1.0));
system.addColorGradient(0.5, new BABYLON.Color4(1.0, 0.541, 0.239, 1.0));
system.addColorGradient(1.0, new BABYLON.Color4(0.549, 0.122, 0.349, 0.0));

// 加算ブレンド（深度書き込みは GPUParticleSystem 既定でOFF：重なって発光が加算される）。
system.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;

// サイズ: 誕生時大→寿命で縮小。透視で遠いほど小さく（パースペクティブは Babylon が自動処理）。
system.minSize = 0.25;
system.maxSize = 0.6;
system.addSizeGradient(0.0, 1.0);   // 誕生時 = 大（minSize/maxSize に係数1.0）
system.addSizeGradient(1.0, 0.2);   // 寿命末 = 小（縮小）

system.start();

// ---- 状態 / 入力 ------------------------------------------------------------
let count = N_INIT, fps = 60, last = performance.now(), hudT = 0;

function setCount(n) {
  count = Math.max(N_MIN, Math.min(N_MAX, n | 0));
  // 表示数と充填レートを同時に更新（再生成不要）。
  if (gpuSupported) system.activeParticleCount = count;
  system.emitRate = count / LIFE;
}

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
  if (k === "r") setCount(N_INIT);
});

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// Draws は SceneInstrumentation の drawCallsCounter から取得（ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。

function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回更新（描画負荷を測る邪魔をしない）
  const draws = instrumentation.drawCallsCounter.current;
  const mode = gpuSupported ? "GPU" : "CPU(fallback)";
  hud.textContent =
    `FPS       ${fps.toFixed(1)}\n` +
    `Objects   ${count}\n` +
    `Particles ${count}\n` +
    `Draws     ${draws}\n` +
    `Points    ${count.toLocaleString()}\n` +   // 描画点数 = activeParticleCount (=N)
    `Mode      ${mode}`;
}

// ---- メインループ -----------------------------------------------------------
function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  scene.render();
  updateHUD();
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
