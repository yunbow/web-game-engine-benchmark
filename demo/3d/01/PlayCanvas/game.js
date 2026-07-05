// 3D テーマ1 ― インスタンス小惑星フィールド（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。数値・挙動は three.js リファレンス実装に完全一致させる。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const FIELD_X = 60, FIELD_Y = 34;     // 自機可動 & 小惑星散布の半幅
const Z_FAR = -1200, Z_NEAR = 30;     // 出現(奥)〜消滅(手前)
const PLAYER_SPEED = 60;              // u/s
const PLAYER_R = 2.0;
const BULLET_SPEED = 400, BULLET_R = 0.5, FIRE_MS = 150, MAX_BULLETS = 64;
const AST_MAX = 50000, AST_INIT = 2000, AST_STEP = 1000, AST_MIN = 1000;
const SEED = 0x9e3779b9 >>> 0;
const INVULN = 1.0;                    // 被弾後無敵秒

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const rng = (lo, hi) => lo + (hi - lo) * rnd();

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
app.scene.ambientLight = new pc.Color(0x66 / 255, 0x77 / 255, 0xaa / 255).mulScalar(0.7);
// 背景クリアカラー（暗い宇宙色）はカメラ側で設定する。

// ---- カメラ -----------------------------------------------------------------
const camEntity = new pc.Entity("camera");
camEntity.addComponent("camera", {
  fov: 60,                 // 垂直基準・度
  nearClip: 0.1,
  farClip: 2000,
  clearColor: new pc.Color(0x05 / 255, 0x06 / 255, 0x0a / 255),
});
app.root.addChild(camEntity);

// ---- ライト -----------------------------------------------------------------
// 平行光: 方向 (-0.5,-1,-0.3) 正規化, 白, 強度1.0。
// PlayCanvas の directional はエンティティの forward(-Z)を光の向きとする。
const sun = new pc.Entity("sun");
sun.addComponent("light", {
  type: "directional",
  color: new pc.Color(1, 1, 1),
  intensity: 1.0,
  castShadows: false,
});
// forward が (-0.5,-1,-0.3) 正規化方向を向くよう回転させる。
{
  const dir = new pc.Vec3(-0.5, -1, -0.3).normalize();
  // forward(0,0,-1) を dir に向ける: dir を look 方向として lookAt を使う。
  sun.setPosition(0, 0, 0);
  sun.lookAt(dir.x, dir.y, dir.z);
}
app.root.addChild(sun);

// ---- 共有: 行列計算用の一時オブジェクト -------------------------------------
const tmpMat = new pc.Mat4();
const tmpPos = new pc.Vec3();
const tmpRot = new pc.Quat();
const tmpScale = new pc.Vec3();
const tmpAxis = new pc.Vec3();

// ---- ハードウェアインスタンシング用 ヘルパ ----------------------------------
// per-instance の 4x4 行列を float32(16要素×count) で持つ VertexBuffer を作り、
// MeshInstance.setInstancing で割り当てる。毎フレーム setData で更新する。
function createInstancedRender(parentEntity, mesh, material, maxCount) {
  const meshInstance = new pc.MeshInstance(mesh, material);

  // インスタンス行列用 VertexBuffer（getDefaultInstancingFormat = float32x4 ×4）
  const format = pc.VertexFormat.getDefaultInstancingFormat(device);
  const vb = new pc.VertexBuffer(device, format, maxCount, {
    usage: pc.BUFFER_DYNAMIC,
  });
  meshInstance.setInstancing(vb);
  // CPU 側の行列データ配列（16 float × maxCount）
  const data = new Float32Array(maxCount * 16);

  // RenderComponent ではなく、直接 MeshInstance を Entity の render に載せる。
  const entity = new pc.Entity();
  entity.addComponent("render", {
    meshInstances: [meshInstance],
    castShadows: false,
    receiveShadows: false,
  });
  parentEntity.addChild(entity);

  return { meshInstance, vb, data, entity };
}

// ---- メッシュ生成（低ポリ） --------------------------------------------------
// 小惑星: 低ポリ正二十面体相当。PlayCanvas には Icosahedron プリミティブが無いため
// createSphere の低分割（20面前後の低ポリ）で代用する。
const astMesh = pc.createSphere(device, { radius: 1, latitudeBands: 3, longitudeBands: 4 });
const astMat = new pc.StandardMaterial();
astMat.diffuse = new pc.Color(0.55, 0.45, 0.38); // 岩色（単色。色ティント省略・README参照）
astMat.useMetalness = false;
astMat.shininess = 10;
astMat.update();

// 弾: 小球（低分割）。Basic 相当（自発光で常時黄色）。
const bulMesh = pc.createSphere(device, { radius: BULLET_R, latitudeBands: 6, longitudeBands: 8 });
const bulMat = new pc.StandardMaterial();
bulMat.diffuse = new pc.Color(0, 0, 0);
bulMat.emissive = new pc.Color(1, 0xe6 / 255, 0x6d / 255); // #ffe66d
bulMat.useLighting = true;
bulMat.update();

const astInst = createInstancedRender(app.root, astMesh, astMat, AST_MAX);
const bulInst = createInstancedRender(app.root, bulMesh, bulMat, MAX_BULLETS);

// ---- 小惑星 per-instance 状態（SoA） ----------------------------------------
const sx = new Float32Array(AST_MAX), sy = new Float32Array(AST_MAX), sz = new Float32Array(AST_MAX);
const svz = new Float32Array(AST_MAX), sr = new Float32Array(AST_MAX);
const sax = new Float32Array(AST_MAX), say = new Float32Array(AST_MAX), saz = new Float32Array(AST_MAX);
const sang = new Float32Array(AST_MAX), saspd = new Float32Array(AST_MAX);

function initAsteroid(i, spreadZ) {
  sx[i] = rng(-FIELD_X, FIELD_X);
  sy[i] = rng(-FIELD_Y, FIELD_Y);
  sz[i] = spreadZ ? rng(Z_FAR, Z_NEAR) : Z_FAR + rng(0, 60);
  svz[i] = rng(80, 160);
  sr[i] = rng(2.0, 5.0);
  // 自転軸（正規化）
  let ax = rng(-1, 1), ay = rng(-1, 1), az = rng(-1, 1);
  const L = Math.hypot(ax, ay, az) || 1; ax /= L; ay /= L; az /= L;
  sax[i] = ax; say[i] = ay; saz[i] = az;
  sang[i] = rng(0, Math.PI * 2);
  saspd[i] = rng(-1.5, 1.5);
}
for (let i = 0; i < AST_MAX; i++) {
  initAsteroid(i, true);
  // 色ティントはインスタンシングでは省略（README に明記）。three.js版の setColorAt 相当を
  // 決定論を崩さないため rnd() の消費数だけ合わせる（位置・速度系列を一致させる）。
  rnd(); rnd();
}

// ---- 弾 状態 ----------------------------------------------------------------
const bx = new Float32Array(MAX_BULLETS), by = new Float32Array(MAX_BULLETS), bz = new Float32Array(MAX_BULLETS);
const bAlive = new Uint8Array(MAX_BULLETS);

// ---- 自機（cone, -Z 向き） ---------------------------------------------------
const playerMesh = pc.createCone(device, { baseRadius: 1.4, peakRadius: 0, height: 4, heightSegments: 1, capSegments: 12 });
const playerMat = new pc.StandardMaterial();
playerMat.diffuse = new pc.Color(0x49 / 255, 0xc9 / 255, 1);
playerMat.update();
const player = new pc.Entity("player");
player.addComponent("render", { meshInstances: [new pc.MeshInstance(playerMesh, playerMat)], castShadows: false });
// cone は +Y 方向に尖る。-Z へ向けるため x を -90° 回転。
player.setLocalEulerAngles(-90, 0, 0);
app.root.addChild(player);
const pp = new pc.Vec3(0, 0, 0);

// ---- ゲーム状態 -------------------------------------------------------------
let activeCount = AST_INIT;
let score = 0, hp = 3, invuln = 0, over = false, autoplay = false, autoT = 0;
let started = false, blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
let fireT = 0;

// ---- 入力（three.js版と同じ素の addEventListener 実装） ----------------------
const keys = {};
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === "+" || k === "=" || k === "]") setCount(activeCount + AST_STEP);
  if (k === "-" || k === "_" || k === "[") setCount(activeCount - AST_STEP);
  if (k === "p") autoplay = !autoplay;
  if (k === "enter" && !started) startGame();
  if (k === "r") restart();
});
addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
function setCount(n) { activeCount = Math.max(AST_MIN, Math.min(AST_MAX, n | 0)); }
function restart() { score = 0; hp = 3; invuln = 0; over = false; pp.set(0, 0, 0); document.getElementById("over").style.display = "none"; }
// Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
function startGame() { started = true; restart(); document.getElementById("title").style.display = "none"; }
const titleEl = document.getElementById("title");

// ---- インスタンス行列を Float32Array に書き込む（列優先 = PlayCanvas Mat4） ---
// pc.Mat4.setTRS で TRS を組み、.data(Float32Array, 列優先16要素)を data へコピーする。
function writeMatrix(data, idx, px, py, pz, qx, qy, qz, qw, s) {
  tmpPos.set(px, py, pz);
  tmpRot.set(qx, qy, qz, qw);
  tmpScale.set(s, s, s);
  tmpMat.setTRS(tmpPos, tmpRot, tmpScale);
  const md = tmpMat.data; // 列優先 16
  data.set(md, idx * 16);
}

// ---- メインループ -----------------------------------------------------------
let last = performance.now(), fps = 60;

app.on("update", (dtRaw) => {
  let dt = dtRaw;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;

  if (over && !started) restart();   // アトラクト中の被弾死はデモをループ再開

  // 入力 → 自機移動
  if (!over) {
    let mx = 0, my = 0;
    if (!started || autoplay) { autoT += dt; mx = Math.sin(autoT * 0.8); my = Math.sin(autoT * 1.3) * 0.6; }
    else {
      if (keys["a"] || keys["arrowleft"]) mx -= 1;
      if (keys["d"] || keys["arrowright"]) mx += 1;
      if (keys["w"] || keys["arrowup"]) my += 1;
      if (keys["s"] || keys["arrowdown"]) my -= 1;
    }
    pp.x = Math.max(-FIELD_X, Math.min(FIELD_X, pp.x + mx * PLAYER_SPEED * dt));
    pp.y = Math.max(-FIELD_Y, Math.min(FIELD_Y, pp.y + my * PLAYER_SPEED * dt));
    if (invuln > 0) invuln -= dt;
  }
  player.setPosition(pp.x, pp.y, pp.z);

  // カメラ追従（自機後方やや上）
  camEntity.setPosition(pp.x, pp.y + 6, pp.z + 22);
  camEntity.lookAt(pp.x, pp.y + 2, pp.z);

  // 発射
  if (!over) {
    fireT -= dt * 1000;
    if (fireT <= 0) {
      fireT = FIRE_MS;
      for (let b = 0; b < MAX_BULLETS; b++) if (!bAlive[b]) { bAlive[b] = 1; bx[b] = pp.x; by[b] = pp.y; bz[b] = pp.z; break; }
    }
  }

  // 弾更新（生存ぶんを詰めてインスタンス行列に書く）
  let bn = 0;
  const bd = bulInst.data;
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (!bAlive[b]) continue;
    bz[b] -= BULLET_SPEED * dt;
    if (bz[b] < Z_FAR) { bAlive[b] = 0; continue; }
    writeMatrix(bd, bn, bx[b], by[b], bz[b], 0, 0, 0, 1, 1);
    bn++;
  }
  bulInst.vb.setData(bd);
  bulInst.meshInstance.instancingCount = bn;

  // 小惑星更新 + 当たり判定（自前球判定）
  const pr = PLAYER_R;
  const ad = astInst.data;
  for (let i = 0; i < activeCount; i++) {
    let z = sz[i] + svz[i] * dt;
    if (z > Z_NEAR) { initAsteroid(i, false); z = sz[i]; }   // リサイクル(奥へ)
    sz[i] = z;
    const r = sr[i];

    // 弾 × 小惑星（z ゲートで早期 continue）
    for (let b = 0; b < MAX_BULLETS; b++) {
      if (!bAlive[b]) continue;
      const dz = bz[b] - z; if (dz < -r - 1 || dz > r + 1) continue;
      const dx = bx[b] - sx[i], dy = by[b] - sy[i];
      const rr = r + BULLET_R;
      if (dx * dx + dy * dy + dz * dz <= rr * rr) { bAlive[b] = 0; score += 10; initAsteroid(i, false); z = sz[i]; break; }
    }
    // 小惑星 × 自機
    if (!over && invuln <= 0) {
      const dx = pp.x - sx[i], dy = pp.y - sy[i], dz = pp.z - sz[i];
      const rr = r + pr;
      if (dx * dx + dy * dy + dz * dz <= rr * rr) {
        hp--; invuln = INVULN; initAsteroid(i, false);
        if (hp <= 0) { hp = 0; over = true; if (started) document.getElementById("over").style.display = "grid"; }
      }
    }

    // 行列を更新（位置・自転・スケール）
    sang[i] += saspd[i] * dt;
    tmpAxis.set(sax[i], say[i], saz[i]);
    tmpRot.setFromAxisAngle(tmpAxis, sang[i] * pc.math.RAD_TO_DEG); // PlayCanvas は度
    writeMatrix(ad, i, sx[i], sy[i], sz[i], tmpRot.x, tmpRot.y, tmpRot.z, tmpRot.w, r);
  }
  astInst.vb.setData(ad);
  astInst.meshInstance.instancingCount = activeCount;

  updateHUD(bn);
  if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden"; }
});

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
let hudT = 0;
function updateHUD(bn) {
  hudT++;
  if (hudT % 6 !== 0) return; // 数フレームに1回更新
  // Draws/Tris は PlayCanvas のレンダラ統計から取得（ベストエフォート）。
  // Draws: v2 系は app.stats.drawCalls.total が正（device.stats ではない）。
  const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
  const draws = (dc.total != null ? dc.total : dc.forward) || 0;
  // 三角形数: 概算（小惑星メッシュ面数 × activeCount + 弾メッシュ面数 × bn）。
  // インスタンシングのため device 統計には正確な合計が出ないので自前で概算する（注記）。
  const astTris = astMesh.indexBuffer[0] ? astMesh.indexBuffer[0].numIndices / 3 : 0;
  const bulTris = bulMesh.indexBuffer[0] ? bulMesh.indexBuffer[0].numIndices / 3 : 0;
  const tris = Math.round(astTris * activeCount + bulTris * bn);
  hud.textContent =
    `FPS       ${fps.toFixed(1)}\n` +
    `Objects   ${activeCount + bn}\n` +
    `Score     ${score}\n` +
    `HP        ${hp}\n` +
    `Asteroids ${activeCount}\n` +
    `Draws     ${draws}\n` +
    `Tris      ${tris.toLocaleString()}`;
}

app.start();
