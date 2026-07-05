// 3D テーマ1 ― インスタンス小惑星フィールド（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。数値・挙動はここを基準に他3ライブラリへ移植する。
import * as THREE from "three";

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

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true }); // WebGL2 既定
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 2000);
const textureLoader = new THREE.TextureLoader();

scene.add(new THREE.AmbientLight(0x6677aa, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(0.5, 1, 0.3); // 方向(-0.5,-1,-0.3)の逆
scene.add(sun);

// ---- 小惑星: InstancedMesh（比較主軸） --------------------------------------
const astGeo = new THREE.IcosahedronGeometry(1, 0);   // 低ポリ 20面
const astMat = new THREE.MeshLambertMaterial();
textureLoader.load("../assets/theme_texture.png", (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  astMat.map = tex;
  astMat.needsUpdate = true;
});
const asteroids = new THREE.InstancedMesh(astGeo, astMat, AST_MAX);
asteroids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(asteroids);

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
const col = new THREE.Color();
for (let i = 0; i < AST_MAX; i++) {
  initAsteroid(i, true);
  col.setHSL(0.07 + rnd() * 0.08, 0.35, 0.35 + rnd() * 0.25); // 茶〜灰の岩色
  asteroids.setColorAt(i, col);
}
asteroids.instanceColor.needsUpdate = true;

// ---- 弾: InstancedMesh -------------------------------------------------------
const bulGeo = new THREE.SphereGeometry(BULLET_R, 8, 6);
const bulMat = new THREE.MeshBasicMaterial({ color: 0xffe66d });
const bullets = new THREE.InstancedMesh(bulGeo, bulMat, MAX_BULLETS);
bullets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(bullets);
const bx = new Float32Array(MAX_BULLETS), by = new Float32Array(MAX_BULLETS), bz = new Float32Array(MAX_BULLETS);
const bAlive = new Uint8Array(MAX_BULLETS);

// ---- 自機 -------------------------------------------------------------------
const player = new THREE.Mesh(
  new THREE.ConeGeometry(1.4, 4, 12),
  new THREE.MeshLambertMaterial({ color: 0x49c9ff })
);
player.rotation.x = -Math.PI / 2; // コーンを -Z 方向へ向ける
scene.add(player);
const pp = new THREE.Vector3(0, 0, 0);

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
const dummy = new THREE.Object3D();
const q = new THREE.Quaternion();
const axis = new THREE.Vector3();
let last = performance.now(), fps = 60;

function frame(now) {
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
  player.position.copy(pp);

  // カメラ追従（自機後方やや上）
  camera.position.set(pp.x, pp.y + 6, pp.z + 22);
  camera.lookAt(pp.x, pp.y + 2, pp.z);

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
    dummy.position.set(bx[b], by[b], bz[b]);
    dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bullets.setMatrixAt(bn++, dummy.matrix);
  }
  bullets.count = bn;
  bullets.instanceMatrix.needsUpdate = true;

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
    axis.set(sax[i], say[i], saz[i]);
    q.setFromAxisAngle(axis, sang[i]);
    dummy.position.set(sx[i], sy[i], sz[i]);
    dummy.quaternion.copy(q);
    dummy.scale.set(r, r, r);
    dummy.updateMatrix();
    asteroids.setMatrixAt(i, dummy.matrix);
  }
  asteroids.count = activeCount;
  asteroids.instanceMatrix.needsUpdate = true;

  renderer.render(scene, camera);
  updateHUD(bn);
  if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden"; }
  requestAnimationFrame(frame);
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
const titleEl = document.getElementById("title");
let hudT = 0;
function updateHUD(bn) {
  hudT++;
  if (hudT % 6 !== 0) return; // 数フレームに1回更新（描画負荷を測る邪魔をしない）
  const info = renderer.info.render;
  hud.textContent =
    `FPS       ${fps.toFixed(1)}\n` +
    `Objects   ${activeCount + bn}\n` +
    `Score     ${score}\n` +
    `HP        ${hp}\n` +
    `Asteroids ${activeCount}\n` +
    `Draws     ${info.calls}\n` +
    `Tris      ${info.triangles.toLocaleString()}`;
}

requestAnimationFrame(frame);
