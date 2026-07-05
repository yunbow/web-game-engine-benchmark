// 3D テーマ3(T4) ― スキンドキャラ大群（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)に挙動・数値を一致させる。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。
//
// 主軸: スキンドメッシュ(スケルタルアニメ)を N 体、各個体が独立にアニメ再生するスループット比較。
// 共有 glTF(CesiumMan.glb) を container として 1 回ロードし、各キャラは
//   container.instantiateRenderEntity() で render エンティティを複製 +
//   anim コンポーネントに glb 同梱の歩行 AnimTrack を assignAnimation してループ再生する。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const GLB_URL = "../assets/CesiumMan.glb";
const N_INIT = 50, N_STEP = 25, N_MIN = 10, N_MAX = 1000;
const SPACING = 2.2, TARGET_H = 1.7;
const SEED = 0x9e3779b9 >>> 0;

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
// three.js 版と同一実装・同一消費順序（個体ごとに speed→phase の順で 2 回引く）。
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） ----------------
const canvas = document.getElementById("app");
const app = new pc.Application(canvas, {
  graphicsDeviceOptions: {
    deviceTypes: [pc.DEVICETYPE_WEBGL2], // WebGL2 を明示（WebGPU は使わない）
    antialias: true,
    alpha: false,
  },
  keyboard: new pc.Keyboard(window),
});
const device = app.graphicsDevice;
// 960x540 固定解像度
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);
// 環境光（three.js: AmbientLight 0x8899bb, intensity 0.8 相当）
app.scene.ambientLight = new pc.Color(0x88 / 255, 0x99 / 255, 0xbb / 255).mulScalar(0.8);

// ---- カメラ（固定） ----------------------------------------------------------
// 位置(0,12,26) / 注視(0,1.5,0) / fov 50° / near 0.1 / far 2000 / clearColor #10131a
const camEntity = new pc.Entity("camera");
camEntity.addComponent("camera", {
  fov: 50,
  nearClip: 0.1,
  farClip: 2000,
  clearColor: new pc.Color(0x10 / 255, 0x13 / 255, 0x1a / 255),
});
camEntity.setPosition(0, 12, 26);
camEntity.lookAt(0, 1.5, 0);
app.root.addChild(camEntity);

// ---- ライト（平行光1灯・上方やや手前） --------------------------------------
// three.js: DirectionalLight(white,1.1), position(0.4,1,0.6) → 光は原点方向へ。
// PlayCanvas の directional はエンティティの forward(-Z) を光の進行方向とするため、
// 光源位置(0.4,1,0.6) から原点を見る向き = (-0.4,-1,-0.6) を forward にする。
const sun = new pc.Entity("sun");
sun.addComponent("light", {
  type: "directional",
  color: new pc.Color(1, 1, 1),
  intensity: 1.1,
  castShadows: false,
});
sun.setPosition(0.4, 1, 0.6);
sun.lookAt(0, 0, 0);
app.root.addChild(sun);

// ---- 地面（大判 box: y=0 を上面に） -----------------------------------------
// three.js は plane(400x400, y=0)。PlayCanvas は box(厚み)で代用し上面を y=0 に合わせる。
const groundMat = new pc.StandardMaterial();
groundMat.diffuse = new pc.Color(0x1b / 255, 0x20 / 255, 0x30 / 255);
groundMat.useMetalness = false;
groundMat.gloss = 0.1;
groundMat.update();
const ground = new pc.Entity("ground");
ground.addComponent("render", {
  type: "box",
  material: groundMat,
  castShadows: false,
  receiveShadows: false,
});
ground.setLocalScale(400, 1, 400);
ground.setPosition(0, -0.5, 0); // box は中心原点・高さ1 → 上面 y=0
app.root.addChild(ground);

// ---- 状態 -------------------------------------------------------------------
let count = N_INIT, fps = 60, hudT = 0, tAccum = 0;
let container = null;     // ContainerResource（共有・破棄しない）
let walkTrack = null;     // 歩行 AnimTrack（共有）
let walkDuration = 1;     // クリップ長（秒）
let modelScale = 1, footOffset = 0;
let fallback = false;
let started = false;
const crowd = [];         // { entity, speed, phase }（fallback時は y バウンス用に speed/phase 使用）

// フォールバック用の共有メッシュ/マテリアル（カプセル）。
let fbMaterial = null;

// ---- グリッド配置（SPEC: cols=ceil(sqrt(n)), 間隔2.2, 中心揃え） --------------
function placeAt(entity, i, n, y) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const c = i % cols, r = Math.floor(i / cols);
  entity.setPosition((c - (cols - 1) / 2) * SPACING, y, (r - (rows - 1) / 2) * SPACING);
}

// ---- 群衆構築 ---------------------------------------------------------------
function clearCrowd() {
  for (const e of crowd) {
    // instantiateRenderEntity は内部でメッシュ/マテリアル等のリソースを共有する。
    // entity.destroy() は複製したエンティティ階層と、その anim インスタンス状態を破棄するだけで、
    // 共有元の container リソース（メッシュ/スケルトン/AnimTrack）は破棄しない（container は保持し続ける）。
    e.entity.destroy();
  }
  crowd.length = 0;
}

function buildCrowd(n) {
  clearCrowd();
  const rnd = mulberry32(SEED);
  for (let i = 0; i < n; i++) {
    const speed = 0.8 + rnd() * 0.4;   // timeScale [0.8,1.2]
    const phase = rnd();               // 開始位相 [0,1) → *clipDuration
    let entity;

    if (!fallback) {
      // スキン独立クローン: render エンティティ階層を複製（スキン/スケルトンも複製される）。
      entity = container.instantiateRenderEntity();
      entity.setLocalScale(modelScale, modelScale, modelScale);

      // anim コンポーネントを付与し、歩行 AnimTrack をループ割当 → 即再生。
      // assignAnimation は状態グラフが無ければ自動生成し、activate:true で再生開始する。
      entity.addComponent("anim", { activate: true });
      // 第3引数 layerName=undefined（baseLayer に割当）, speed=1(等倍で割当), loop=true。
      // 個体ごとの timeScale はコンポーネント全体の speed 倍率で与える（state speed と二重適用しない）。
      entity.anim.assignAnimation("Walk", walkTrack, undefined, 1, true);
      entity.anim.speed = speed;   // 個体ごとの再生速度 [0.8,1.2]
      // 開始位相をずらして群衆同期を防ぐ（baseLayer の再生位置を進める）。
      const layer = entity.anim.baseLayer;
      if (layer) {
        try { layer.activeStateCurrentTime = phase * walkDuration; } catch (e) { /* best effort */ }
      }
      placeAt(entity, i, n, footOffset);
    } else {
      // フォールバック: 上下に弾むカプセル（スキニング無し）。
      entity = new pc.Entity("fb");
      entity.addComponent("render", {
        type: "capsule",
        material: fbMaterial,
        castShadows: false,
        receiveShadows: false,
      });
      // capsule の既定は半径0.5/高さ2程度。three.js の CapsuleGeometry(0.4,1.0) と見た目を概ね合わせる。
      entity.setLocalScale(0.8, 0.9, 0.8);
      placeAt(entity, i, n, footOffset);
    }

    app.root.addChild(entity);
    crowd.push({ entity, speed, phase });
  }
  count = n;
}

function rebuild(n) {
  if (!started) return;
  buildCrowd(Math.max(N_MIN, Math.min(N_MAX, n | 0)));
}

// ---- 入力（three.js版と同じ素の addEventListener 実装） ----------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") rebuild(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") rebuild(count - N_STEP);
  if (k === "r") rebuild(count);
});

// ---- メインループ -----------------------------------------------------------
// 非フォールバック時、スケルトン更新は anim コンポーネントが app の update で自動進行する。
// フォールバック時のみ自前で y バウンスを更新する。
app.on("update", (dtRaw) => {
  let dt = dtRaw;
  if (dt > 0.05) dt = 0.05;             // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  tAccum += dt;

  if (fallback) {
    for (const e of crowd) {
      // three.js 版: y = footOffset + max(0, sin(t*speed*3 + phase*2π))*0.4
      const y = footOffset + Math.max(0, Math.sin(tAccum * e.speed * 3 + e.phase * Math.PI * 2)) * 0.4;
      const p = e.entity.getPosition();
      e.entity.setPosition(p.x, y, p.z);
    }
  }

  updateHUD();
});

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
function updateHUD() {
  if (++hudT % 6 !== 0) return;         // 数フレームに1回更新
  // Draws: v2 系は app.stats.drawCalls.total が正。
  const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
  const draws = (dc.total != null ? dc.total : dc.forward) || 0;
  // Tris: PlayCanvas のスキンドメッシュ統計は概算扱い。app.stats.frame.triangles があれば使い、
  // 無ければ device 統計から拾う（注記: 概算）。
  const fr = (app.stats && app.stats.frame) || {};
  const tris = fr.triangles != null ? fr.triangles
    : (device.stats && device.stats.frame && device.stats.frame.triangles) || 0;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${count}\n` +
    `Chars   ${count}${fallback ? " (fallback: no skin)" : ""}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}`;
}

// ---- glTF(GLB) コンテナ ロード → 起動 --------------------------------------
// loadFromUrl(url, 'container', cb) でコンテナとして非同期読込。cb(err, asset)。
// asset.resource が ContainerResource。app.start() はロード完了後・群衆構築後に呼ぶ。
app.assets.loadFromUrl(GLB_URL, "container", (err, asset) => {
  if (err || !asset || !asset.resource) {
    console.warn("glTF container load failed, using primitive fallback:", err);
    startFallback();
    return;
  }
  try {
    container = asset.resource;

    // 同梱アニメ(AnimTrack)を取得。container.animations は Asset 配列（各 .resource が AnimTrack）。
    // 念のため AnimTrack 直格納のケースもフォールバックで吸収する。
    const anims = container.animations || [];
    if (!anims.length) throw new Error("no animations in glb");
    const first = anims[0];
    walkTrack = (first && first.resource) ? first.resource : first; // Asset or AnimTrack
    walkDuration = (walkTrack && walkTrack.duration) ? walkTrack.duration : 1;

    // バウンディングボックスから身長 TARGET_H に合わせるスケールと接地オフセットを算出。
    // 一旦 1 体だけ実体化し、render エンティティ階層の aabb を集計する。
    const probe = container.instantiateRenderEntity();
    app.root.addChild(probe);
    probe.syncHierarchy && probe.syncHierarchy(); // world 変換を確定させてから aabb を読む
    const renders = probe.findComponents("render");
    const aabb = new pc.BoundingBox();
    let inited = false;
    for (const rc of renders) {
      for (const mi of rc.meshInstances) {
        // 優先: MeshInstance.aabb（world空間・スキン考慮）。null/非有限なら mesh.aabb(object空間)で代替。
        let b = mi.aabb;
        if (!b || !isFinite(b.halfExtents.y) || b.halfExtents.y <= 0) b = mi.mesh && mi.mesh.aabb;
        if (!b) continue;
        if (!inited) { aabb.copy(b); inited = true; }
        else aabb.add(b);
      }
    }
    let h = 1;
    if (inited) {
      const min = aabb.getMin(), max = aabb.getMax();
      h = (max.y - min.y);
      if (!isFinite(h) || h <= 1e-4) h = 1;     // 異常値ガード
      modelScale = TARGET_H / h;
      footOffset = -min.y * modelScale;          // スケール適用後に min.y を持ち上げて接地
      if (!isFinite(footOffset)) footOffset = 0;
    }
    probe.destroy();

    buildCrowd(N_INIT);
    started = true;
    app.start();
  } catch (e2) {
    console.warn("glb anim setup failed, using primitive fallback:", e2);
    startFallback();
  }
});

function startFallback() {
  fallback = true;
  footOffset = 1.0;
  fbMaterial = new pc.StandardMaterial();
  fbMaterial.diffuse = new pc.Color(0x8a / 255, 0xb4 / 255, 1);
  fbMaterial.update();
  buildCrowd(N_INIT);
  started = true;
  app.start();
}
