// 3D テーマ10(T10) ― 大量レイキャスト（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。中心スキャナから毎フレーム N 本のレイを全方位へ放ち、
// THREE.Raycaster で M ターゲット（InstancedMesh）との最近交差を求め当たり点を描画する。レイ数が主軸。
import * as THREE from "three";

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const M = 120, SHELL = 28, BOX = 4;
const N_INIT = 1500, N_STEP = 1500, N_MIN = 500, N_MAX = 15000;
const FAR = 200;
const CAM_R = 55, CAM_Y = 20, CAM_W = 0.15;
const GOLDEN = 2.399963229728653; // 黄金角

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080d);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.5, 1000);
const textureLoader = new THREE.TextureLoader();
const targetTexture = textureLoader.load("../assets/theme_texture.png");
targetTexture.colorSpace = THREE.SRGBColorSpace;

scene.add(new THREE.AmbientLight(0x8090a0, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(0.4, 1, 0.5); scene.add(sun);

// ---- ターゲット（M個の box を1つの InstancedMesh に。Raycaster はこれを交差判定） ----
const targets = new THREE.InstancedMesh(
  new THREE.BoxGeometry(BOX, BOX, BOX),
  new THREE.MeshLambertMaterial({ color: 0x6d8db0, map: targetTexture }), M);
{
  const d = new THREE.Object3D();
  for (let i = 0; i < M; i++) {
    const y = 1 - 2 * (i + 0.5) / M, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * GOLDEN;
    d.position.set(Math.cos(th) * r * SHELL, y * SHELL, Math.sin(th) * r * SHELL);
    d.rotation.set(0, 0, 0); // 軸整列（無回転）。PlayCanvasの自前ray-AABBと結果を揃えるため
    d.updateMatrix(); targets.setMatrixAt(i, d.matrix);
  }
  targets.instanceMatrix.needsUpdate = true;
}
scene.add(targets);

// スキャナ原点マーカー
const scanner = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), new THREE.MeshBasicMaterial({ color: 0x6cff9a }));
scene.add(scanner);

// 当たり点マーカー（インスタンス）
const hits = new THREE.InstancedMesh(new THREE.SphereGeometry(0.4, 6, 5),
  new THREE.MeshBasicMaterial({ color: 0xffd54a }), N_MAX);
hits.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
hits.frustumCulled = false;
scene.add(hits);

// ---- レイ方向（フィボナッチ球・決定的）。N 変更時に再構築 --------------------
let count = N_INIT;
let dirs = new Float32Array(0);
function buildDirs(n) {
  dirs = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * GOLDEN;
    dirs[i * 3] = Math.cos(th) * r; dirs[i * 3 + 1] = y; dirs[i * 3 + 2] = Math.sin(th) * r;
  }
}
buildDirs(N_INIT);
function setCount(n) { count = Math.max(N_MIN, Math.min(N_MAX, n | 0)); buildDirs(count); }

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
  if (k === "r") setCount(N_INIT);
});

// ---- メインループ -----------------------------------------------------------
const ray = new THREE.Raycaster(); ray.far = FAR;
const origin = new THREE.Vector3(), dir = new THREE.Vector3(), dummy = new THREE.Object3D();
let fps = 60, last = performance.now(), hudT = 0, t = 0, hitCount = 0;

function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05; else if (dt < 0) dt = 0;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  // カメラ周回
  const a = t * CAM_W;
  camera.position.set(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
  camera.lookAt(0, 0, 0);

  // スキャナ原点（微小上下）＋ レイ全体をゆっくり Y 回転
  origin.set(0, Math.sin(t * 0.7) * 2, 0);
  scanner.position.copy(origin);
  const rot = t * 0.1, cs = Math.cos(rot), sn = Math.sin(rot);

  hitCount = 0;
  for (let i = 0; i < count; i++) {
    // 方向（Y回転を適用）
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    dir.set(dx * cs - dz * sn, dy, dx * sn + dz * cs);
    ray.set(origin, dir);
    const hit = ray.intersectObject(targets, false);
    if (hit.length) {
      const p = hit[0].point;
      dummy.position.set(p.x, p.y, p.z); dummy.updateMatrix();
      hits.setMatrixAt(hitCount++, dummy.matrix);
    }
  }
  hits.count = hitCount;
  hits.instanceMatrix.needsUpdate = true;

  renderer.render(scene, camera);
  updateHUD();
  requestAnimationFrame(frame);
}

const hud = document.getElementById("hud");
function updateHUD() {
  if (++hudT % 6 !== 0) return;
  const info = renderer.info.render;
  hud.textContent =
    `FPS    ${fps.toFixed(1)}\n` +
    `Objects ${M}\n` +
    `Rays   ${count}\n` +
    `Hits   ${hitCount}\n` +
    `Draws  ${info.calls}\n` +
    `Tris   ${info.triangles.toLocaleString()}`;
}

requestAnimationFrame(frame);
