// 3D テーマ8(T8) ― PBR + ポストプロセス(Bloom)（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。多数の PBR 球を環境反射＋Bloom 付きで描画する。球数が主軸。
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const N_INIT = 200, N_STEP = 100, N_MIN = 50, N_MAX = 2000;
const R = 0.7, SP = 2.2;
const CAM_R = 30, CAM_Y = 8, CAM_W = 0.2;
const SEED = 0x9e3779b9 >>> 0;
const ENV_URL = "../assets/env_equirect.png"; // 任意。無ければ RoomEnvironment

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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.info.autoReset = false; // EffectComposer の全パスを集計するため手動リセット
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f2a);
scene.environmentIntensity = 0.5; // 環境反射を控えめに（白飛び防止）
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000);

// 直接光（金属ハイライト用）
scene.add(new THREE.AmbientLight(0x404a5a, 0.35));
const d1 = new THREE.DirectionalLight(0xffffff, 1.0); d1.position.set(1, 1, 0.6); scene.add(d1);
const d2 = new THREE.DirectionalLight(0xffd9a8, 0.6); d2.position.set(-0.8, 0.5, -0.6); scene.add(d2);

// 環境（反射）: 任意 equirect → 無ければ RoomEnvironment
const pmrem = new THREE.PMREMGenerator(renderer);
function useRoomEnv() {
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}
new THREE.TextureLoader().load(
  ENV_URL,
  (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = tex; scene.background = tex;
    document.getElementById("note").textContent = "PBR + post: env_equirect.png + UnrealBloom";
  },
  undefined,
  () => useRoomEnv()   // 読込失敗（未配置）→ 手続き的環境
);

// ---- PBR 球 -----------------------------------------------------------------
const sphereGeo = new THREE.SphereGeometry(R, 24, 16);
let spheres = [];
function clearSpheres() {
  for (const m of spheres) { scene.remove(m); m.material.dispose(); }
  spheres = [];
}
let count = N_INIT;
function buildSpheres(n) {
  clearSpheres();
  const rnd = mulberry32(SEED);
  const k = Math.ceil(Math.cbrt(n));
  const half = (k - 1) / 2;
  for (let i = 0; i < n; i++) {
    const ix = i % k, iy = ((i / k) | 0) % k, iz = (i / (k * k)) | 0;
    const metalness = rnd() < 0.5 ? 1.0 : rnd();         // 半分は完全金属
    const roughness = 0.05 + rnd() * 0.95;
    const c = new THREE.Color().setHSL(rnd(), 0.7, 0.5);
    const emissiveOn = rnd() < 0.15;                      // 約15%は発光（Bloom）
    const mat = new THREE.MeshStandardMaterial({
      color: c, metalness, roughness,
      emissive: emissiveOn ? new THREE.Color().setHSL(rnd(), 0.9, 0.6) : 0x000000,
      emissiveIntensity: emissiveOn ? 2.0 : 0,
    });
    const m = new THREE.Mesh(sphereGeo, mat);
    m.position.set((ix - half) * SP, (iy - half) * SP, (iz - half) * SP);
    scene.add(m);
    spheres.push(m);
  }
  count = n;
}
buildSpheres(N_INIT);

// ---- ポストプロセス（Bloom） ------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.35, 0.4, 0.9); // strength/radius/threshold（発光部のみ滲ませる）
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") buildSpheres(Math.min(N_MAX, count + N_STEP));
  if (k === "-" || k === "_" || k === "[") buildSpheres(Math.max(N_MIN, count - N_STEP));
  if (k === "r") buildSpheres(N_INIT);
});

// ---- メインループ -----------------------------------------------------------
let fps = 60, last = performance.now(), hudT = 0, t = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  const a = t * CAM_W;
  camera.position.set(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
  camera.lookAt(0, 0, 0);

  renderer.info.reset();   // 直前にリセット → composer の全パスを集計
  composer.render();
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
    `Spheres ${count}\n` +
    `Draws   ${info.calls}\n` +
    `Tris    ${info.triangles.toLocaleString()}\n` +
    `Post    bloom`;
}

requestAnimationFrame(frame);
