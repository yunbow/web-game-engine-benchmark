// 3D テーマ2(T3) ― 箱タワー崩し（three.js + Rapier3d リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。物理は Rapier3d を使う（自前物理は不可・統合相性が比較対象）。
import * as THREE from "three";
import * as RAPIERmod from "@dimforge/rapier3d-compat";
const RAPIER = RAPIERmod.default ?? RAPIERmod; // jsdelivr +esm は default 包装される場合がある

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GRAV = -20;
const BOX = 2, BOX_HALF = 1;                 // 箱 2x2x2
const COLS = 20, GAP = 0.05, ROW_H = 2.02;   // タワー配置（ワイドな壁）
const N_INIT = 200, N_STEP = 50, N_MIN = 20, N_MAX = 1500;
const BALL_R = 1.5, MAX_PROJ = 8, FIRE_MS = 2000;
const FIRE_POS = [0, 10, 40], FIRE_VEL = [0, 2, -55];

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 2000);
const textureLoader = new THREE.TextureLoader();
const themeTexture = textureLoader.load("../assets/theme_texture.png");
themeTexture.colorSpace = THREE.SRGBColorSpace;
themeTexture.wrapS = themeTexture.wrapT = THREE.RepeatWrapping;
themeTexture.repeat.set(12, 12);
camera.position.set(0, 14, 56);
camera.lookAt(0, 10, 0);

scene.add(new THREE.AmbientLight(0x8899bb, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(0.4, 1, 0.6);
scene.add(sun);

// 床（視覚）
const groundMesh = new THREE.Mesh(
  new THREE.BoxGeometry(400, 2, 400),
  new THREE.MeshLambertMaterial({ color: 0x232830, map: themeTexture })
);
groundMesh.position.set(0, -1, 0); // 上面 y=0
scene.add(groundMesh);

// 箱 InstancedMesh（比較主軸）
const boxMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(BOX, BOX, BOX),
  new THREE.MeshLambertMaterial({ color: 0xb9a98c, map: themeTexture }),
  N_MAX
);
boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
boxMesh.frustumCulled = false;
scene.add(boxMesh);

// 砲弾 InstancedMesh
const ballMesh = new THREE.InstancedMesh(
  new THREE.SphereGeometry(BALL_R, 16, 12),
  new THREE.MeshLambertMaterial({ color: 0xe8533b }),
  MAX_PROJ
);
ballMesh.frustumCulled = false;
scene.add(ballMesh);

// ---- ゲーム状態 -------------------------------------------------------------
let world = null;
let boxBodies = [];     // Rapier RigidBody[]
let boxScored = [];     // bool[]
let projBodies = [];    // {body, alive}
let count = N_INIT, score = 0, fireT = FIRE_MS;
let fps = 60, last = performance.now(), hudT = 0;

const dummy = new THREE.Object3D();

// ---- 物理セットアップ -------------------------------------------------------
function buildWorld() {
  if (world) world.free();
  world = new RAPIER.World({ x: 0, y: GRAV, z: 0 });
  world.timestep = 1 / 60;

  // 床（静的）
  const gBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(200, 1, 200).setRestitution(0.1).setFriction(0.8), gBody);

  boxBodies = []; boxScored = []; projBodies = [];
  buildTower(count);
}

function buildTower(n) {
  // 既存の箱/砲弾を除去
  for (const b of boxBodies) world.removeRigidBody(b);
  for (const p of projBodies) if (p.alive) world.removeRigidBody(p.body);
  boxBodies = []; boxScored = []; projBodies = [];

  const rows = Math.ceil(n / COLS);
  for (let i = 0; i < n; i++) {
    const c = i % COLS, r = Math.floor(i / COLS);
    const x = (c - (COLS - 1) / 2) * (BOX + GAP);
    const y = BOX_HALF + r * ROW_H;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, 0));
    // density 0.125 → 質量 = 8(体積) * 0.125 = 1
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF)
        .setRestitution(0.1).setFriction(0.6).setDensity(0.125), body);
    boxBodies.push(body); boxScored.push(false);
  }
  // hud のスケール用に count を同期
  count = n;
}

function fire() {
  let slot = projBodies.findIndex((p) => !p.alive);
  if (slot < 0) {
    if (projBodies.length >= MAX_PROJ) { // 最古を回収
      const old = projBodies.shift();
      if (old.alive) world.removeRigidBody(old.body);
    }
    slot = projBodies.length;
  }
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(FIRE_POS[0], FIRE_POS[1], FIRE_POS[2])
      .setLinvel(FIRE_VEL[0], FIRE_VEL[1], FIRE_VEL[2]));
  // density で質量 8 に: 球体積 4/3πr^3 = 14.137 → density = 8/14.137 = 0.566
  world.createCollider(
    RAPIER.ColliderDesc.ball(BALL_R).setRestitution(0.2).setFriction(0.4).setDensity(0.566), body);
  const proj = { body, alive: true };
  if (slot < projBodies.length) projBodies[slot] = proj; else projBodies.push(proj);
}

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") rebuild(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") rebuild(count - N_STEP);
  if (k === " ") { e.preventDefault(); fire(); }
  if (k === "r") rebuild(count);
});
function rebuild(n) {
  n = Math.max(N_MIN, Math.min(N_MAX, n | 0));
  score = 0; fireT = FIRE_MS;
  buildTower(n);
}

// ---- メインループ -----------------------------------------------------------
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;

  if (world) {
    // 発射タイマ
    fireT -= dt * 1000;
    if (fireT <= 0) { fireT = FIRE_MS; fire(); }

    world.step();

    // 箱の同期 + スコア
    for (let i = 0; i < boxBodies.length; i++) {
      const t = boxBodies[i].translation();
      const q = boxBodies[i].rotation();
      dummy.position.set(t.x, t.y, t.z);
      dummy.quaternion.set(q.x, q.y, q.z, q.w);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      boxMesh.setMatrixAt(i, dummy.matrix);
      if (!boxScored[i] && t.y < 0.5) { boxScored[i] = true; score += 10; }
    }
    boxMesh.count = boxBodies.length;
    boxMesh.instanceMatrix.needsUpdate = true;

    // 砲弾の同期 + 寿命
    let pn = 0;
    for (const p of projBodies) {
      if (!p.alive) continue;
      const t = p.body.translation();
      if (t.z < -60 || t.y < -20) { world.removeRigidBody(p.body); p.alive = false; continue; }
      dummy.position.set(t.x, t.y, t.z);
      dummy.quaternion.set(0, 0, 0, 1);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      ballMesh.setMatrixAt(pn++, dummy.matrix);
    }
    ballMesh.count = pn;
    ballMesh.instanceMatrix.needsUpdate = true;

    renderer.render(scene, camera);
    updateHUD(pn);
  }
  requestAnimationFrame(frame);
}

const hud = document.getElementById("hud");
function updateHUD(pn) {
  if (++hudT % 6 !== 0) return;
  const info = renderer.info.render;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${boxBodies.length + pn}\n` +
    `Score   ${score}\n` +
    `Bodies  ${count}\n` +
    `Draws   ${info.calls}\n` +
    `Tris    ${info.triangles.toLocaleString()}`;
}

// ---- 起動（Rapier WASM 初期化を待つ） ---------------------------------------
RAPIER.init().then(() => {
  buildWorld();
  requestAnimationFrame(frame);
}).catch((e) => {
  document.getElementById("hud").textContent = "Rapier init failed: " + e.message;
  console.error(e);
});
