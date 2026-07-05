// 3D テーマ2(T3) ― 箱タワー崩し（PlayCanvas エンジンのみ + ammo.js/Bullet 物理）
// SPEC: ../SPEC.md が唯一の正。数値・挙動は three.js+Rapier リファレンス実装に一致させる。
// 物理は ammo.js(Bullet) を必ず使う（自前物理は不可・統合相性が比較対象）。
// グローバル `pc`(playcanvas-stable.min.js) / `Ammo`(ammojs-typed asm.js) は CDN から読む。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GRAV = -20;
const BOX = 2, BOX_HALF = 1;                 // 箱 2x2x2
const COLS = 20, GAP = 0.05, ROW_H = 2.02;   // タワー配置（ワイドな壁）
const N_INIT = 200, N_STEP = 50, N_MIN = 20, N_MAX = 1500;
const BALL_R = 1.5, MAX_PROJ = 8, FIRE_MS = 2000;
const FIRE_POS = [0, 10, 40], FIRE_VEL = [0, 2, -55];

// 物理マテリアル定数
const BOX_MASS = 1, BOX_REST = 0.1, BOX_FRIC = 0.6;
const BALL_MASS = 8, BALL_REST = 0.2, BALL_FRIC = 0.4;
const GROUND_REST = 0.1, GROUND_FRIC = 0.8;

// ---- 起動はファイル末尾の Ammo().then(start) から。以降は start() 内で全構築。----

function start() {
  // ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） --------------
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
  // 環境光（ほんのり青）
  app.scene.ambientLight = new pc.Color(0x88 / 255, 0x99 / 255, 0xbb / 255).mulScalar(0.6);

  // ---- 物理（ammo/Bullet）初期化 -------------------------------------------
  // グローバル Ammo は boot 側で確定済み。PlayCanvas v2 はエンジンのみ(WasmModule)構成だと
  // onLibraryLoaded が自動発火しないことがあるため、確実に明示呼び出しする:
  //   RigidBodyComponent.onLibraryLoaded()（静的）= 内部 ammo 一時オブジェクト(_ammoVec1/_ammoQuat等)生成
  //   system.onLibraryLoaded()                    = dynamicsWorld 生成
  // collision（ammo 衝突形状の生成基盤）→ rigidbody の順で初期化する。
  // collision を初期化しないと床/箱の shape が作られず body.impl 不整合になる。
  if (app.systems.collision && app.systems.collision.onLibraryLoaded) app.systems.collision.onLibraryLoaded();
  if (pc.RigidBodyComponent && pc.RigidBodyComponent.onLibraryLoaded) pc.RigidBodyComponent.onLibraryLoaded();
  if (app.systems.rigidbody.onLibraryLoaded) app.systems.rigidbody.onLibraryLoaded();
  // 重力を SPEC 値に設定（dynamicsWorld 生成後）
  app.systems.rigidbody.gravity = new pc.Vec3(0, GRAV, 0);

  // ---- カメラ（固定） -------------------------------------------------------
  const camEntity = new pc.Entity("camera");
  camEntity.addComponent("camera", {
    fov: 50,                 // 垂直基準・度
    nearClip: 0.1,
    farClip: 2000,
    clearColor: new pc.Color(0x0a / 255, 0x0c / 255, 0x10 / 255),
  });
  app.root.addChild(camEntity);
  camEntity.setPosition(0, 14, 56);
  camEntity.lookAt(0, 10, 0);

  // ---- ライト（平行光 + 環境光） --------------------------------------------
  const sun = new pc.Entity("sun");
  sun.addComponent("light", {
    type: "directional",
    color: new pc.Color(1, 1, 1),
    intensity: 1.1,
    castShadows: false,
  });
  app.root.addChild(sun);
  // 上方やや手前から（three.js版 sun.position(0.4,1,0.6) に相当する向き）。
  // directional は forward(-Z) を光の進行方向とする。光源が (0.4,1,0.6) 側にある
  // ＝光は (-0.4,-1,-0.6) 方向へ進む。
  {
    const dir = new pc.Vec3(-0.4, -1, -0.6).normalize();
    sun.setPosition(0, 0, 0);
    sun.lookAt(dir.x, dir.y, dir.z);
  }

  // ---- 共有メッシュ / マテリアル（プリミティブのみ・画像/GLB不使用） ----------
  const boxMesh = pc.createBox(device, { halfExtents: new pc.Vec3(BOX_HALF, BOX_HALF, BOX_HALF) });
  const boxMat = new pc.StandardMaterial();
  boxMat.diffuse = new pc.Color(0xb9 / 255, 0xa9 / 255, 0x8c / 255); // 石色
  boxMat.useMetalness = false;
  boxMat.update();

  const ballMesh = pc.createSphere(device, { radius: BALL_R, latitudeBands: 12, longitudeBands: 16 });
  const ballMat = new pc.StandardMaterial();
  ballMat.diffuse = new pc.Color(0xe8 / 255, 0x53 / 255, 0x3b / 255); // 赤
  ballMat.useMetalness = false;
  ballMat.update();

  // 共有メッシュは参照カウントを +1 して永続化する。
  // MeshInstance は mesh の refCount を増減し 0 で GPU バッファを破棄する。砲弾(FIFO destroy)や
  // 箱(rebuild時 destroy)で全インスタンスが消えると共有 mesh が破棄され、次に同じ mesh で
  // MeshInstance を作ると破棄済みバッファ参照になり描画が 'impl' で落ちる。これを防ぐ。
  if (boxMesh.incRefCount) boxMesh.incRefCount();
  if (ballMesh.incRefCount) ballMesh.incRefCount();

  const groundMat = new pc.StandardMaterial();
  groundMat.diffuse = new pc.Color(0x23 / 255, 0x28 / 255, 0x30 / 255); // 暗灰
  groundMat.useMetalness = false;
  groundMat.update();

  // メッシュの三角形数（HUD の Tris 概算用）
  const boxTris = boxMesh.indexBuffer[0] ? boxMesh.indexBuffer[0].numIndices / 3 : 0;
  const ballTris = ballMesh.indexBuffer[0] ? ballMesh.indexBuffer[0].numIndices / 3 : 0;

  // ---- 床（静的 rigidbody・大判 box） ---------------------------------------
  // three.js版: BoxGeometry(400,2,400), position(0,-1,0)（上面 y=0）。
  const ground = new pc.Entity("ground");
  ground.setPosition(0, -1, 0); // 上面 y=0。rigidbody 追加より前に位置を確定。
  ground.addComponent("render", {
    meshInstances: [new pc.MeshInstance(
      pc.createBox(device, { halfExtents: new pc.Vec3(200, 1, 200) }), groundMat)],
    castShadows: false,
    receiveShadows: false,
  });
  ground.addComponent("collision", {
    type: "box",
    halfExtents: new pc.Vec3(200, 1, 200),
  });
  ground.addComponent("rigidbody", {
    type: "static",
    restitution: GROUND_REST,
    friction: GROUND_FRIC,
  });
  app.root.addChild(ground);

  // ---- ゲーム状態 -----------------------------------------------------------
  // 1剛体=1Entity 方式（PlayCanvas の素直な統合）。描画は各 Entity の render。
  // ※ draw call が箱数ぶん増える（インスタンシングしていない）→ README に明記。
  let boxEntities = [];   // { entity, scored }
  let projEntities = [];  // pc.Entity（FIFO プール）
  let count = N_INIT, score = 0, fireT = FIRE_MS;
  let fps = 60;

  function makeBox(x, y, z) {
    const e = new pc.Entity();
    // 位置は「rigidbody コンポーネント追加より前」に確定する。createBody は entity の
    // transform を読んで剛体を生成するため、後から setPosition すると dynamic 剛体は
    // body→entity 同期で原点に戻され、全箱が原点に重なってしまう。
    e.setPosition(x, y, z);
    e.addComponent("render", {
      meshInstances: [new pc.MeshInstance(boxMesh, boxMat)],
      castShadows: false, receiveShadows: false,
    });
    e.addComponent("collision", {
      type: "box",
      halfExtents: new pc.Vec3(BOX_HALF, BOX_HALF, BOX_HALF),
    });
    e.addComponent("rigidbody", {
      type: "dynamic",
      mass: BOX_MASS,
      restitution: BOX_REST,
      friction: BOX_FRIC,
    });
    app.root.addChild(e);
    return e;
  }

  function clearAll() {
    for (const b of boxEntities) b.entity.destroy();
    for (const p of projEntities) p.destroy();
    boxEntities = [];
    projEntities = [];
  }

  function buildTower(n) {
    clearAll();
    const rows = Math.ceil(n / COLS);
    for (let i = 0; i < n; i++) {
      const c = i % COLS, r = Math.floor(i / COLS);
      const x = (c - (COLS - 1) / 2) * (BOX + GAP); // 2.05 間隔
      const y = BOX_HALF + r * ROW_H;               // 下段が地面接地
      const e = makeBox(x, y, 0);
      boxEntities.push({ entity: e, scored: false });
    }
    count = n;
  }

  function fire() {
    // 最大 MAX_PROJ。超過分は最古を destroy（FIFO リサイクル）。
    if (projEntities.length >= MAX_PROJ) {
      const old = projEntities.shift();
      if (old) old.destroy();
    }
    const e = new pc.Entity();
    // 位置を rigidbody 追加より前に確定（createBody が正しい位置で剛体を作る）。
    e.setPosition(FIRE_POS[0], FIRE_POS[1], FIRE_POS[2]);
    e.addComponent("render", {
      meshInstances: [new pc.MeshInstance(ballMesh, ballMat)],
      castShadows: false, receiveShadows: false,
    });
    e.addComponent("collision", { type: "sphere", radius: BALL_R });
    e.addComponent("rigidbody", {
      type: "dynamic",
      mass: BALL_MASS,
      restitution: BALL_REST,
      friction: BALL_FRIC,
    });
    app.root.addChild(e);
    // 初速は body 生成後（addChild 後）に設定。
    e.rigidbody.linearVelocity = new pc.Vec3(FIRE_VEL[0], FIRE_VEL[1], FIRE_VEL[2]);
    projEntities.push(e);
  }

  // ---- 入力（素の addEventListener） ----------------------------------------
  function rebuild(n) {
    n = Math.max(N_MIN, Math.min(N_MAX, n | 0));
    score = 0; fireT = FIRE_MS;
    buildTower(n);
  }
  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "+" || k === "=" || k === "]") rebuild(count + N_STEP);
    else if (k === "-" || k === "_" || k === "[") rebuild(count - N_STEP);
    else if (k === " ") { e.preventDefault(); fire(); }
    else if (k === "r") rebuild(count);
  });

  // ---- メインループ（物理は PlayCanvas/ammo が内部で進める） -----------------
  // 各 Entity の render は rigidbody に追従するため、描画同期コードは不要。
  app.on("update", (dt) => {
    if (dt > 0.05) dt = 0.05;               // スパイク抑制
    fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;

    // 発射タイマ（2.0秒ごと）
    fireT -= dt * 1000;
    if (fireT <= 0) { fireT = FIRE_MS; fire(); }

    // 箱: スコア判定（中心 y < 0.5 初到達で +10）
    for (const b of boxEntities) {
      if (!b.scored && b.entity.getPosition().y < 0.5) { b.scored = true; score += 10; }
    }

    // 砲弾: 寿命（z < -60 または y < -20 で destroy）
    for (let i = projEntities.length - 1; i >= 0; i--) {
      const p = projEntities[i].getPosition();
      if (p.z < -60 || p.y < -20) {
        projEntities[i].destroy();
        projEntities.splice(i, 1);
      }
    }

    updateHUD();
  });

  // ---- HUD ------------------------------------------------------------------
  const hud = document.getElementById("hud");
  let hudT = 0;
  function updateHUD() {
    if (++hudT % 6 !== 0) return; // 数フレームに1回更新
    // Draws: v2 系は app.stats.drawCalls.total が正。
    const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
    const draws = (dc.total != null ? dc.total : dc.forward) || 0;
    const pn = projEntities.length;
    // Tris は概算（インスタンシング非使用だが device 統計に頼らず自前で概算・注記）。
    const tris = Math.round(boxTris * boxEntities.length + ballTris * pn + 12 /*床*/);
    hud.textContent =
      `FPS     ${fps.toFixed(1)}\n` +
      `Objects ${boxEntities.length + pn}\n` +
      `Score   ${score}\n` +
      `Bodies  ${count}\n` +
      `Draws   ${draws}\n` +
      `Tris    ${tris.toLocaleString()}`;
  }

  // ---- 初期タワー構築 → 開始 ------------------------------------------------
  // ここに来る時点でグローバル Ammo は初期化済み（boot で代入してから start を呼ぶ）。
  // よって new pc.Application 内で rigidbody システムが Ammo を認識し dynamicsWorld を生成済み。
  buildTower(N_INIT);
  app.start();
}

// ---- 起動（公式 pc.WasmModule 経由で ammo をロード） -------------------------
// setConfig は new pc.Application（rigidbody システムが 'Ammo' を購読する）より前に必須。
// MozillaReality 製 ammo（PlayCanvas が歴史的に対応）の wasm + asm フォールバックを指定。
// 手動 window.Ammo 代入では onLibraryLoaded が発火せず createBody で落ちるため必ずこの経路。
const GH = "https://cdn.jsdelivr.net/gh/MozillaReality/ammo.js@8bbc0ea/builds";
pc.WasmModule.setConfig("Ammo", {
  glueUrl: `${GH}/ammo.wasm.js`,
  wasmUrl: `${GH}/ammo.wasm.wasm`,
  fallbackUrl: `${GH}/ammo.js`,
});
// ammo ロード完了 → グローバル Ammo に代入してから start()（=new pc.Application）。
// PlayCanvas の rigidbody は new pc.Application 時点のグローバル Ammo で初期化されるため、
// 必ず「Ammo 確定 → アプリ生成」の順にする。
pc.WasmModule.getInstance("Ammo", (instance) => {
  if (typeof window.Ammo === "undefined" && instance) window.Ammo = instance;
  start();
});
