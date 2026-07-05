// 3D テーマ1 ― インスタンス小惑星フィールド（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。ロジック（PRNG・当たり判定・リサイクル・入力・カメラ・発射）は
// three.js リファレンス実装(../three.js/game.js)とビット単位で同一にしてある。
// 描画レイヤだけを Babylon の thin instances に置き換えている。

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

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（WebGPU は使わない）。preserveDrawingBuffer は不要。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// !!! 最重要トラップ: Babylon は既定が左手系。右手系にしないと Z が反転し、
// 小惑星が -Z(奥) から +Z(手前) へ流れる SPEC の挙動が壊れる。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#05060aff");

// 透視投影カメラ（手動更新・デフォルト操作なし）。fov は垂直60°。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 6, 22), scene);
camera.fov = 60 * Math.PI / 180;     // 垂直FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.1;
camera.maxZ = 2000;
// デフォルトの入力（マウス/キーボード移動）は付けない＝手動制御
// （attachControl を呼ばない）

// ライト: 環境光相当の Hemispheric + 平行光1灯
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#6677aa");
hemi.groundColor = BABYLON.Color3.FromHexString("#6677aa");
hemi.intensity = 0.7;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, -0.3).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.0;

// ---- 小惑星: thin instances（比較主軸） -------------------------------------
// 低ポリ正二十面体（20面相当）。three.js の IcosahedronGeometry(1,0) に対応。
const asteroids = BABYLON.MeshBuilder.CreateIcoSphere("ast", { radius: 1, subdivisions: 1, flat: true }, scene);
const astMat = new BABYLON.StandardMaterial("astMat", scene);
astMat.disableLighting = false;             // ライティングあり（three.js は Lambert）
astMat.specularColor = new BABYLON.Color3(0, 0, 0);
// thinInstanceSetBuffer("color", ...) を呼ぶと Babylon が自動で per-instance color を
// 有効化する（INSTANCESCOLOR define）。useVertexColor 等の追加フラグは不要。
asteroids.material = astMat;

// per-instance 状態（SoA）
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

// thin instance 用バッファ（行列16 + 色4）。色は初期化時に決定的に焼き込む。
const astMatrices = new Float32Array(16 * AST_MAX);
const astColors = new Float32Array(4 * AST_MAX);

// HSL→RGB（three.js の Color.setHSL と同じ式）で岩色を生成
function hslToRgb(h, s, l, out, off) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  out[off] = r; out[off + 1] = g; out[off + 2] = b; out[off + 3] = 1;
}

for (let i = 0; i < AST_MAX; i++) {
  initAsteroid(i, true);
  hslToRgb(0.07 + rnd() * 0.08, 0.35, 0.35 + rnd() * 0.25, astColors, i * 4); // 茶〜灰の岩色
}
// 色バッファは静的（毎フレーム更新しない）
asteroids.thinInstanceSetBuffer("color", astColors, 4, true);
// 行列バッファ（毎フレーム書き換えるので static=false）
asteroids.thinInstanceSetBuffer("matrix", astMatrices, 16, false);
asteroids.thinInstanceCount = AST_INIT;
// thin instance はルートメッシュの境界で frustum カリングされる。インスタンスは
// フィールド全体に散るので、ルートの境界では正しく覆えず全体が消えうる。
// 毎フレーム個体が動くため境界再計算ではなく、常にアクティブ扱いにしてカリングを回避。
asteroids.alwaysSelectAsActiveMesh = true;

// ---- 弾: thin instances -----------------------------------------------------
const bullets = BABYLON.MeshBuilder.CreateSphere("bul", { diameter: BULLET_R * 2, segments: 8 }, scene);
const bulMat = new BABYLON.StandardMaterial("bulMat", scene);
bulMat.disableLighting = true;                                  // three.js は MeshBasicMaterial
bulMat.emissiveColor = BABYLON.Color3.FromHexString("#ffe66d");
bulMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
bullets.material = bulMat;
const bulMatrices = new Float32Array(16 * MAX_BULLETS);
bullets.thinInstanceSetBuffer("matrix", bulMatrices, 16, false);
bullets.thinInstanceCount = 0;
bullets.alwaysSelectAsActiveMesh = true; // 小惑星と同理由でカリング回避

const bx = new Float32Array(MAX_BULLETS), by = new Float32Array(MAX_BULLETS), bz = new Float32Array(MAX_BULLETS);
const bAlive = new Uint8Array(MAX_BULLETS);

// ---- 自機 -------------------------------------------------------------------
// Cone = diameterTop:0 の Cylinder。three.js の ConeGeometry(1.4,4,12) に対応（半径1.4→直径2.8）。
const player = BABYLON.MeshBuilder.CreateCylinder("player", {
  diameterTop: 0, diameterBottom: 2.8, height: 4, tessellation: 12
}, scene);
const playerMat = new BABYLON.StandardMaterial("playerMat", scene);
playerMat.diffuseColor = BABYLON.Color3.FromHexString("#49c9ff");
playerMat.specularColor = new BABYLON.Color3(0, 0, 0);
player.material = playerMat;
// 既定の Cylinder/Cone は +Y 向き。右手系で X 軸まわり -90°回転すると先端が -Z（奥）を向く。
// three.js リファレンスと同じ右手系・同じ rotation.x=-PI/2 なので見た目も一致する。
player.rotation.x = -Math.PI / 2;
const pp = new BABYLON.Vector3(0, 0, 0);

// ---- ゲーム状態 -------------------------------------------------------------
let activeCount = AST_INIT;
let score = 0, hp = 3, invuln = 0, over = false, autoplay = false, autoT = 0;
let started = false, blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
let fireT = 0;

// ---- 入力 -------------------------------------------------------------------
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

// ---- メインループ -----------------------------------------------------------
const scaleV = new BABYLON.Vector3(1, 1, 1);
const quat = new BABYLON.Quaternion();
const posV = new BABYLON.Vector3();
const mtx = new BABYLON.Matrix();
const camTarget = new BABYLON.Vector3();
let last = performance.now(), fps = 60;
let hudT = 0;

// 早期に弾行列用の単位スケール/無回転（弾は回転しない）
const bulScale = new BABYLON.Vector3(1, 1, 1);
const bulQuat = BABYLON.Quaternion.Identity();

function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
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
  player.position.copyFrom(pp);

  // カメラ追従（自機後方やや上）: 位置 = 自機+(0,6,22), 注視 = 自機+(0,2,0)
  camera.position.set(pp.x, pp.y + 6, pp.z + 22);
  camTarget.set(pp.x, pp.y + 2, pp.z);
  camera.setTarget(camTarget);

  // 発射
  if (!over) {
    fireT -= dt * 1000;
    if (fireT <= 0) {
      fireT = FIRE_MS;
      for (let b = 0; b < MAX_BULLETS; b++) if (!bAlive[b]) { bAlive[b] = 1; bx[b] = pp.x; by[b] = pp.y; bz[b] = pp.z; break; }
    }
  }

  // 弾更新
  let bn = 0;
  for (let b = 0; b < MAX_BULLETS; b++) {
    if (!bAlive[b]) continue;
    bz[b] -= BULLET_SPEED * dt;
    if (bz[b] < Z_FAR) { bAlive[b] = 0; continue; }
    posV.set(bx[b], by[b], bz[b]);
    BABYLON.Matrix.ComposeToRef(bulScale, bulQuat, posV, mtx);
    mtx.copyToArray(bulMatrices, bn * 16);
    bn++;
  }
  bullets.thinInstanceCount = bn;
  if (bn > 0) bullets.thinInstanceBufferUpdated("matrix");

  // 小惑星更新 + 当たり判定（当たり判定はライブラリ非依存の自前球判定）
  const pr = PLAYER_R;
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
    BABYLON.Quaternion.RotationAxisToRef(new BABYLON.Vector3(sax[i], say[i], saz[i]), sang[i], quat);
    scaleV.set(r, r, r);
    posV.set(sx[i], sy[i], sz[i]);
    BABYLON.Matrix.ComposeToRef(scaleV, quat, posV, mtx);
    mtx.copyToArray(astMatrices, i * 16);
  }
  asteroids.thinInstanceCount = activeCount;
  asteroids.thinInstanceBufferUpdated("matrix");

  scene.render();
  updateHUD(bn);
  if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden"; }
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
const titleEl = document.getElementById("title");
// draw call は SceneInstrumentation で取得（ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。
function updateHUD(bn) {
  hudT++;
  if (hudT % 6 !== 0) return; // 数フレームに1回更新（描画負荷を測る邪魔をしない）
  // Draws: Babylon の SceneInstrumentation から（ベストエフォート）。
  const draws = instrumentation.drawCallsCounter.current;
  // Tris: 概算。小惑星(20面)×表示数 + 弾(8x?分割の球は約 8*6*2 を概算で 不要、自前計算)。
  // three.js の SphereGeometry(0.5,8,6) は (8*6*2 - 8*2) = 80 三角形相当だが、
  // ここでは SPEC 注記どおり概算: 小惑星 20面/個 + 弾 1個あたり ~96 三角(8分割球) を加算。
  const astTris = 20 * activeCount;
  const bulTris = 96 * bn; // CreateSphere(segments:8) のおおよその三角形数（概算）
  const tris = astTris + bulTris;
  hud.textContent =
    `FPS       ${fps.toFixed(1)}\n` +
    `Objects   ${activeCount + bn}\n` +
    `Score     ${score}\n` +
    `HP        ${hp}\n` +
    `Asteroids ${activeCount}\n` +
    `Draws     ${draws}\n` +
    `Tris      ${tris.toLocaleString()}`;
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
