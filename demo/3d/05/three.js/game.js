// 3D テーマ5(T2) ― 広域地形 + カリング/LOD/描画距離（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。10000本の木を飛行カメラで周回し、距離カリング＋2段LOD＋
// エンジン自動フラスタムカリングで可視ぶんのみ描画する。
import * as THREE from "three";

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GRID = 100, SP = 8;                // 100x100=10000本, 間隔8
const DD_INIT = 120, DD_STEP = 40, DD_MIN = 40, DD_MAX = 360;
const CAM_R = 140, CAM_Y = 26, CAM_W = 0.15;   // 周回半径/高さ/角速度
const SEED = 0x9e3779b9 >>> 0;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8e6);
scene.fog = new THREE.Fog(0x8fb8e6, 80, 400);
const camera = new THREE.PerspectiveCamera(60, W / H, 0.5, 1200);
const textureLoader = new THREE.TextureLoader();
function loadRepeatingTexture(path, repeatX, repeatY) {
  const texture = textureLoader.load(path);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}
const groundTexture = loadRepeatingTexture("../assets/ground_forest_texture.png", 30, 30);
const barkTexture = loadRepeatingTexture("../assets/tree_bark_texture.png", 1, 2);
const foliageTexture = loadRepeatingTexture("../assets/tree_foliage_texture.png", 2, 2);

scene.add(new THREE.AmbientLight(0xbcc8d8, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(900, 900),
  new THREE.MeshLambertMaterial({ color: 0x24402a, map: groundTexture })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// ---- 共有ジオメトリ / マテリアル（全木で共有） ------------------------------
const trunkGeo = new THREE.CylinderGeometry(0.4, 0.5, 2, 6); trunkGeo.translate(0, 1, 0);
const foliageGeo = new THREE.ConeGeometry(1.7, 4, 8); foliageGeo.translate(0, 4, 0);
const lowGeo = new THREE.ConeGeometry(1.7, 6, 4); lowGeo.translate(0, 3, 0); // LOD1: 単一低ポリ
const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a633c, map: barkTexture });
const foliageMat = new THREE.MeshLambertMaterial({ color: 0x4d8f4a, map: foliageTexture });
const lowMat = new THREE.MeshLambertMaterial({ color: 0x4b8848, map: foliageTexture });

// ---- 木を生成（共有ジオメトリ参照） -----------------------------------------
const trees = [];   // { obj, lod0, lod1, x, z }
function buildForest() {
  const rnd = mulberry32(SEED);
  for (let i = 0; i < GRID * GRID; i++) {
    const c = i % GRID, r = (i / GRID) | 0;
    const x = (c - (GRID - 1) / 2) * SP;
    const z = (r - (GRID - 1) / 2) * SP;
    const hf = 0.8 + rnd() * 0.6;       // 高さ係数
    const ry = rnd() * Math.PI * 2;

    const lod0 = new THREE.Group();
    lod0.add(new THREE.Mesh(trunkGeo, trunkMat), new THREE.Mesh(foliageGeo, foliageMat));
    const lod1 = new THREE.Mesh(lowGeo, lowMat);

    const obj = new THREE.Group();
    obj.add(lod0, lod1);
    obj.position.set(x, 0, z);
    obj.rotation.y = ry;
    obj.scale.set(1, hf, 1);
    obj.visible = false;
    scene.add(obj);
    trees.push({ obj, lod0, lod1, x, z });
  }
}
buildForest();

// ---- 状態 / 入力 ------------------------------------------------------------
let drawDist = DD_INIT, fps = 60, last = performance.now(), hudT = 0, inRange = 0;
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") drawDist = Math.min(DD_MAX, drawDist + DD_STEP);
  if (k === "-" || k === "_" || k === "[") drawDist = Math.max(DD_MIN, drawDist - DD_STEP);
  if (k === "r") drawDist = DD_INIT;
});

// ---- メインループ -----------------------------------------------------------
let t = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  // カメラ自動周回飛行
  const th = t * CAM_W;
  const cx = CAM_R * Math.cos(th), cz = CAM_R * Math.sin(th);
  camera.position.set(cx, CAM_Y, cz);
  camera.lookAt(CAM_R * 0.4 * Math.cos(th), 2, CAM_R * 0.4 * Math.sin(th));

  // 距離カリング + LOD（アプリ側）。視錐台カリングは three が自動で行う。
  const dd2 = drawDist * drawDist;
  const lod2 = (drawDist * 0.5) * (drawDist * 0.5);
  inRange = 0;
  for (let i = 0; i < trees.length; i++) {
    const tr = trees[i];
    const dx = tr.x - cx, dz = tr.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > dd2) { tr.obj.visible = false; continue; }
    tr.obj.visible = true; inRange++;
    const near = d2 <= lod2;
    tr.lod0.visible = near; tr.lod1.visible = !near;
  }

  renderer.render(scene, camera);
  updateHUD();
  requestAnimationFrame(frame);
}

const hud = document.getElementById("hud");
function updateHUD() {
  if (++hudT % 6 !== 0) return;
  const info = renderer.info.render;
  hud.textContent =
    `FPS      ${fps.toFixed(1)}\n` +
    `Objects  ${inRange}\n` +
    `DrawDist ${drawDist}\n` +
    `Draws    ${info.calls}\n` +
    `Tris     ${info.triangles.toLocaleString()}`;
}

requestAnimationFrame(frame);
