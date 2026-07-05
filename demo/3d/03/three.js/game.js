// 3D テーマ3(T4) ― スキンドキャラ大群（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。共有 glTF を N 体複製し、各個体を独立アニメ再生する。
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GLB_URL = "../assets/CesiumMan.glb";
const N_INIT = 50, N_STEP = 25, N_MIN = 10, N_MAX = 1000;
const SPACING = 2.2, TARGET_H = 1.7;
const SEED = 0x9e3779b9 >>> 0;

// ---- 決定的疑似乱数（mulberry32） -------------------------------------------
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
scene.background = new THREE.Color(0x10131a);
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 2000);
const textureLoader = new THREE.TextureLoader();
const groundTexture = textureLoader.load("../assets/theme_texture.png");
groundTexture.colorSpace = THREE.SRGBColorSpace;
groundTexture.wrapS = groundTexture.wrapT = THREE.RepeatWrapping;
groundTexture.repeat.set(10, 10);
camera.position.set(0, 12, 26);
camera.lookAt(0, 1.5, 0);

scene.add(new THREE.AmbientLight(0x8899bb, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(0.4, 1, 0.6);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshLambertMaterial({ color: 0x1b2030, map: groundTexture })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// ---- 状態 -------------------------------------------------------------------
let count = N_INIT, fps = 60, last = performance.now(), hudT = 0;
let baseModel = null, walkClip = null, modelScale = 1, footOffset = 0, fallback = false;
const crowd = [];   // { root, mixer }

// ---- グリッド配置 -----------------------------------------------------------
function placeAt(obj, i, n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const c = i % cols, r = Math.floor(i / cols);
  obj.position.set((c - (cols - 1) / 2) * SPACING, footOffset, (r - (rows - 1) / 2) * SPACING);
}

// ---- 群衆構築 ---------------------------------------------------------------
function clearCrowd() {
  for (const e of crowd) { scene.remove(e.root); if (e.mixer) e.mixer.stopAllAction(); }
  crowd.length = 0;
}

function buildCrowd(n) {
  clearCrowd();
  const rnd = mulberry32(SEED);
  for (let i = 0; i < n; i++) {
    const speed = 0.8 + rnd() * 0.4;        // timeScale [0.8,1.2]
    const phase = rnd();                     // 開始位相 [0,1)*clipDuration
    let root, mixer = null;
    if (!fallback) {
      root = SkeletonUtils.clone(baseModel);  // スキン独立クローン（必須: 通常clone不可）
      root.scale.setScalar(modelScale);
      mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(walkClip);
      action.play();
      action.time = phase * walkClip.duration;
      mixer.timeScale = speed;
    } else {
      // フォールバック: 上下に弾むカプセル（スキニング無し）
      root = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.4, 1.0, 4, 8),
        new THREE.MeshLambertMaterial({ color: 0x8ab4ff })
      );
      root.userData.speed = speed * 3; root.userData.phase = phase * Math.PI * 2;
    }
    placeAt(root, i, n);
    scene.add(root);
    crowd.push({ root, mixer });
  }
  count = n;
}

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") rebuild(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") rebuild(count - N_STEP);
  if (k === "r") rebuild(count);
});
function rebuild(n) { buildCrowd(Math.max(N_MIN, Math.min(N_MAX, n | 0))); }

// ---- メインループ -----------------------------------------------------------
let tAccum = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  tAccum += dt;

  if (!fallback) {
    for (const e of crowd) e.mixer.update(dt);
  } else {
    for (const e of crowd) e.root.position.y = footOffset + Math.max(0, Math.sin(tAccum * e.root.userData.speed + e.root.userData.phase)) * 0.4;
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
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${count}\n` +
    `Chars   ${count}${fallback ? " (fallback: no skin)" : ""}\n` +
    `Draws   ${info.calls}\n` +
    `Tris    ${info.triangles.toLocaleString()}`;
}

// ---- glTF ロード → 起動 -----------------------------------------------------
new GLTFLoader().load(
  GLB_URL,
  (gltf) => {
    baseModel = gltf.scene;
    walkClip = gltf.animations[0];
    // バウンディングボックスから身長 TARGET_H に合わせるスケールと接地オフセットを算出
    const box = new THREE.Box3().setFromObject(baseModel);
    const h = box.max.y - box.min.y || 1;
    modelScale = TARGET_H / h;
    footOffset = -box.min.y * modelScale;
    buildCrowd(N_INIT);
    requestAnimationFrame(frame);
  },
  undefined,
  (err) => {
    console.warn("glTF load failed, using primitive fallback:", err);
    fallback = true; footOffset = 1.0;
    buildCrowd(N_INIT);
    requestAnimationFrame(frame);
  }
);
