// 3D テーマ8(T8) ― PBR + ポストプロセス(Bloom)（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。多数の PBR 球を環境反射＋Bloom 付きで描画する。球数が主軸。
// ロジック（PRNG の消費順・配置・PBRパラメータ・カメラ周回）は three.js リファレンス
// (../three.js/game.js) と同一にしてある。描画レイヤを Babylon の PBRMaterial +
// DefaultRenderingPipeline に置き換えている。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const N_INIT = 200, N_STEP = 100, N_MIN = 50, N_MAX = 2000;
const R = 0.7, SP = 2.2;
const CAM_R = 30, CAM_Y = 8, CAM_W = 0.2;
const SEED = 0x9e3779b9 >>> 0;
const ENV_URL = "../assets/env_equirect.png"; // 任意。無ければ手続き的環境

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// HSL→RGB（three.js の Color.setHSL と同じ式）。0..1 の RGB を返す。
function hslToRgb(h, s, l) {
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
  return new BABYLON.Color3(r, g, b);
}

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（WebGPU は使わない）。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// three.js と座標系を揃える（Y軸上向き・右手系）。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#1a1f2aff");
// 環境反射を控えめに（白飛び防止）。three.js の scene.environmentIntensity = 0.5 相当。
scene.environmentIntensity = 0.5;

// 透視投影カメラ（手動更新・デフォルト操作なし）。fov は垂直50°。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(CAM_R, CAM_Y, 0), scene);
camera.fov = 50 * Math.PI / 180;   // 垂直FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.1;
camera.maxZ = 1000;
// attachControl は呼ばない＝完全手動制御（自動周回）。

// ---- 直接光（金属ハイライト用） ---------------------------------------------
// three.js: AmbientLight(0x404a5a,0.35) + DirectionalLight(白1.0) + DirectionalLight(暖色0.6)
// Babylon の PBR では HemisphericLight を弱い環境光として、DirectionalLight 2灯を主光源に。
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#404a5a");
hemi.groundColor = BABYLON.Color3.FromHexString("#404a5a");
hemi.intensity = 0.35;
// 平行光は three.js の position 方向（光源→原点）を direction に変換。
const d1 = new BABYLON.DirectionalLight("d1", new BABYLON.Vector3(-1, -1, -0.6).normalize(), scene);
d1.diffuse = new BABYLON.Color3(1, 1, 1);
d1.intensity = 2.0;   // Babylon PBR スケールに合わせ強め（金属ハイライト確保）
const d2 = new BABYLON.DirectionalLight("d2", new BABYLON.Vector3(0.8, -0.5, 0.6).normalize(), scene);
d2.diffuse = BABYLON.Color3.FromHexString("#ffd9a8");
d2.intensity = 1.2;

// ---- 環境（反射）: 任意 equirect → 無ければ手続き的環境 -----------------------
function useDefaultEnv() {
  // CreateDefaultEnvironment 相当: skybox/ground は作らず、PBR 反射用の環境のみ与える。
  scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
  // createDefaultEnvironment は scene.environmentTexture を設定する。
  scene.clearColor = BABYLON.Color4.FromHexString("#1a1f2aff");
}
// HTMLImageElement で存在チェック → あれば equirect 環境テクスチャ、無ければフォールバック。
(function loadEnv() {
  const probe = new Image();
  probe.onload = () => {
    const tex = new BABYLON.Texture(ENV_URL, scene, false, false);
    tex.coordinatesMode = BABYLON.Texture.EQUIRECTANGULAR_MODE;
    scene.environmentTexture = tex;
    document.getElementById("note").textContent =
      "PBR + post: env_equirect.png + DefaultRenderingPipeline";
  };
  probe.onerror = () => useDefaultEnv();
  probe.src = ENV_URL;
})();

// ---- PBR 球 -----------------------------------------------------------------
// 共有球メッシュ（半径0.7）。three.js の SphereGeometry(0.7,24,16) に対応。
// CreateSphere の diameter=直径。segments は経度・緯度の分割。
const sphereGeo = BABYLON.MeshBuilder.CreateSphere("sphereGeo", { diameter: R * 2, segments: 24 }, scene);
sphereGeo.isVisible = false; // 親テンプレートは非表示。クローンを表示する。
// 球1個あたりの三角形数（HUD の Tris 概算用）。segments=24 の球の概算。
const TRIS_PER_SPHERE = 24 * 24 * 2;

let spheres = [];   // クローンしたメッシュ
let materials = []; // 各球の PBR マテリアル
let count = N_INIT;

function clearSpheres() {
  for (const m of spheres) m.dispose();
  for (const mat of materials) mat.dispose();
  spheres = [];
  materials = [];
}

function buildSpheres(n) {
  clearSpheres();
  const rnd = mulberry32(SEED);
  const k = Math.ceil(Math.cbrt(n));
  const half = (k - 1) / 2;
  for (let i = 0; i < n; i++) {
    const ix = i % k, iy = ((i / k) | 0) % k, iz = (i / (k * k)) | 0;
    // --- 乱数の消費順を three.js とビット単位で一致させる ---
    const metalness = rnd() < 0.5 ? 1.0 : rnd();   // 半分は完全金属
    const roughness = 0.05 + rnd() * 0.95;
    const baseColor = hslToRgb(rnd(), 0.7, 0.5);    // 彩度高めのベース色
    const emissiveOn = rnd() < 0.15;                // 約15%は発光（Bloom）
    const emissiveColor = emissiveOn ? hslToRgb(rnd(), 0.9, 0.6) : BABYLON.Color3.Black();

    // PBRMetallicRoughnessMaterial: metallic/roughness/baseColor を直接指定できる PBR。
    const mat = new BABYLON.PBRMetallicRoughnessMaterial("pbr" + i, scene);
    mat.baseColor = baseColor;
    mat.metallic = metalness;
    mat.roughness = roughness;
    if (emissiveOn) {
      // three.js は emissiveIntensity=2.0 で強め発光 → Bloom で滲ませる。
      mat.emissiveColor = emissiveColor.scale(2.0);
    }

    const m = sphereGeo.clone("sphere" + i);
    m.material = mat;
    m.isVisible = true;
    m.position.set((ix - half) * SP, (iy - half) * SP, (iz - half) * SP);
    spheres.push(m);
    materials.push(mat);
  }
  count = n;
}
buildSpheres(N_INIT);

// ---- ポストプロセス（Bloom + ACES トーンマップ + FXAA） ----------------------
const pipe = new BABYLON.DefaultRenderingPipeline("p", true, scene, [camera]);
pipe.bloomEnabled = true;
pipe.bloomThreshold = 0.9;
pipe.bloomWeight = 0.4;
pipe.bloomKernel = 64;
pipe.fxaaEnabled = true;
pipe.imageProcessing.toneMappingEnabled = true;
pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
pipe.imageProcessing.exposure = 1.0;

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") buildSpheres(Math.min(N_MAX, count + N_STEP));
  if (k === "-" || k === "_" || k === "[") buildSpheres(Math.max(N_MIN, count - N_STEP));
  if (k === "r") buildSpheres(N_INIT);
});

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// draw call は SceneInstrumentation から取得（ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。

function updateHUD() {
  const draws = instrumentation.drawCallsCounter.current;
  const tris = TRIS_PER_SPHERE * count; // 概算（個別メッシュ × segments=24 の球）
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${count}\n` +
    `Spheres ${count}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}\n` +
    `Post    bloom`;
}

// ---- メインループ -----------------------------------------------------------
let fps = 60, last = performance.now(), hudT = 0, t = 0;
const camTarget = BABYLON.Vector3.Zero();

function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;            // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  // カメラ自動周回（決定的・時間ベース）: pos=(30cos(t*0.2),8,30sin(t*0.2)), target=(0,0,0)
  const a = t * CAM_W;
  camera.position.set(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
  camera.setTarget(camTarget);

  scene.render();

  if (++hudT % 6 === 0) updateHUD(); // 数フレームに1回更新
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
