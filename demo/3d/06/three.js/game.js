// 3D テーマ6(T5) ― 動的シャドウ光源（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。柱64本の上を N 個のスポットライトが周回し、各光源が
// 1024 のシャドウマップを生成する。光源数が比較の主軸。
import * as THREE from "three";

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const COLS = 8, PILLARS = COLS * COLS, GAP = 6;
const L_INIT = 4, L_STEP = 2, L_MIN = 1, L_MAX = 12;
const SHADOW_RES = 1024;
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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c12);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.5, 500);
const textureLoader = new THREE.TextureLoader();
const themeTexture = textureLoader.load("../assets/theme_texture.png");
themeTexture.colorSpace = THREE.SRGBColorSpace;
themeTexture.wrapS = themeTexture.wrapT = THREE.RepeatWrapping;
themeTexture.repeat.set(16, 16);
camera.position.set(0, 28, 40);
camera.lookAt(0, 2, 0);

scene.add(new THREE.AmbientLight(0x223044, 0.8)); // 弱い環境光（影が真っ黒にならない程度）

// 地面（影を受ける）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x55606a, roughness: 1, metalness: 0, map: themeTexture })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 柱（影を落とし受ける）
const pillarMat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.9, metalness: 0, map: themeTexture });
const boxGeo = new THREE.BoxGeometry(2, 1, 2); // 高さは scale.y で
(() => {
  const rnd = mulberry32(SEED);
  for (let i = 0; i < PILLARS; i++) {
    const c = i % COLS, r = (i / COLS) | 0;
    const h = 3 + rnd() * 6;
    const m = new THREE.Mesh(boxGeo, pillarMat);
    m.position.set((c - 3.5) * GAP, h / 2, (r - 3.5) * GAP);
    m.scale.set(1, h, 1);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
})();

// ---- スポットライト（影あり）プール ----------------------------------------
const lights = [];   // { light, target }
function makeLight() {
  const light = new THREE.SpotLight(0xffffff, 600, 120, (50 * Math.PI / 180) / 2, 0.4, 1.5);
  light.castShadow = true;
  light.shadow.mapSize.set(SHADOW_RES, SHADOW_RES);
  light.shadow.camera.near = 5; light.shadow.camera.far = 90;
  light.shadow.bias = -0.0005;
  const target = new THREE.Object3D();
  target.position.set(0, 1, 0);
  scene.add(target); light.target = target;
  scene.add(light);
  return { light };
}
function setLightCount(n) {
  n = Math.max(L_MIN, Math.min(L_MAX, n | 0));
  while (lights.length < n) lights.push(makeLight());
  while (lights.length > n) {
    const e = lights.pop();
    e.light.dispose(); scene.remove(e.light); scene.remove(e.light.target);
  }
}
setLightCount(L_INIT);

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setLightCount(lights.length + L_STEP);
  if (k === "-" || k === "_" || k === "[") setLightCount(lights.length - L_STEP);
  if (k === "r") setLightCount(L_INIT);
});

// ---- メインループ -----------------------------------------------------------
const col = new THREE.Color();
let fps = 60, last = performance.now(), hudT = 0, t = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  const n = lights.length;
  for (let i = 0; i < n; i++) {
    const phi = (i * Math.PI * 2) / n;
    const a = t * 0.4 + phi;
    lights[i].light.position.set(22 * Math.cos(a), 30, 22 * Math.sin(a));
    col.setHSL(i / n, 0.85, 0.6);
    lights[i].light.color.copy(col);
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
    `FPS    ${fps.toFixed(1)}\n` +
    `Objects ${PILLARS}\n` +
    `Lights ${lights.length}\n` +
    `Draws  ${info.calls}\n` +
    `Tris   ${info.triangles.toLocaleString()}`;
}

requestAnimationFrame(frame);
