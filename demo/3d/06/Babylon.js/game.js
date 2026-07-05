// 3D テーマ6(T5) ― 動的シャドウ光源（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。柱64本の上を N 個のスポットライトが周回し、各光源が
// 1024 のシャドウマップ(ShadowGenerator)を生成する。光源数が比較の主軸。
// 数値（柱配置・PRNG・光源周回・カメラ）は three.js リファレンスと完全一致させる。

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

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（WebGPU は使わない）。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// three.js は Y-up・右手系が既定。柱グリッドと光源周回 pos=(22cos,30,22sin) を
// リファレンスとビット一致させるため右手系に揃える（Babylon 既定は左手系）。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#0a0c12ff");

// 透視投影カメラ（固定・デフォルト操作なし = attachControl を呼ばない）。
// fov は垂直 55°（FOVMODE_VERTICAL_FIXED 既定）。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 28, 40), scene);
camera.fov = 55 * Math.PI / 180;
camera.minZ = 0.5;
camera.maxZ = 500;
camera.setTarget(new BABYLON.Vector3(0, 2, 0));

// 弱い環境光（影が真っ黒に潰れない程度。three.js の AmbientLight(0x223044,0.8) 相当）。
// Hemispheric は全方位の弱い拡散光として使う。
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#223044");
hemi.groundColor = BABYLON.Color3.FromHexString("#223044");
hemi.specular = new BABYLON.Color3(0, 0, 0);
hemi.intensity = 0.25;

// ---- 地面（影を受ける） -----------------------------------------------------
const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 200, height: 200 }, scene);
const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
groundMat.diffuseColor = BABYLON.Color3.FromHexString("#55606a");
groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
ground.material = groundMat;
ground.receiveShadows = true;

// ---- 柱（影を落とし・受ける） -----------------------------------------------
const pillarMat = new BABYLON.StandardMaterial("pillarMat", scene);
pillarMat.diffuseColor = BABYLON.Color3.FromHexString("#aab0b8");
pillarMat.specularColor = new BABYLON.Color3(0, 0, 0);

const pillars = [];
(() => {
  const rnd = mulberry32(SEED);
  for (let i = 0; i < PILLARS; i++) {
    const c = i % COLS, r = (i / COLS) | 0;
    const h = 3 + rnd() * 6; // three.js と同順・同値
    // 単位高さ 1 のボックスを Y スケールで伸ばす（three.js の scale.y と同等）。
    const m = BABYLON.MeshBuilder.CreateBox("pillar" + i, { width: 2, height: 1, depth: 2 }, scene);
    m.material = pillarMat;
    m.scaling.set(1, h, 1);
    m.position.set((c - 3.5) * GAP, h / 2, (r - 3.5) * GAP);
    m.receiveShadows = true; // 柱も影を受ける
    pillars.push(m);
  }
})();

// ---- スポットライト（影あり）プール ----------------------------------------
// 各エントリ: { light, sg }。N 変更時は dispose して作り直す。
const lights = [];

function makeLight(i, n) {
  const phi = (i * Math.PI * 2) / n;
  const pos = new BABYLON.Vector3(22 * Math.cos(phi), 30, 22 * Math.sin(phi));
  // direction は中心 (0,1,0) を指す（後で毎フレーム更新）。
  const dir = new BABYLON.Vector3(0, 1, 0).subtract(pos).normalize();
  // SpotLight(name, position, direction, angle(rad), exponent, scene)。angle ≈ 50°。
  const light = new BABYLON.SpotLight("spot" + i, pos, dir, 50 * Math.PI / 180, 1.5, scene);
  // Babylon の SpotLight は非物理（intensity は ~1 オーダー）。three.js の物理 intensity=600 を
  // そのまま使うと露出オーバーで真っ白になるため、Babylon 系の適正値にする。
  light.intensity = 2.0;
  light.range = 120;                // この距離で減衰しきる（底まで届く）
  light.shadowMinZ = 5;             // shadow.camera.near
  light.shadowMaxZ = 90;            // shadow.camera.far
  light.specular = new BABYLON.Color3(0, 0, 0);

  // シャドウマップ生成器: 1024、PCF ソフト影。
  const sg = new BABYLON.ShadowGenerator(SHADOW_RES, light);
  sg.usePercentageCloserFiltering = true;     // PCF ソフト影（three.js PCFSoftShadowMap 相当）
  sg.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
  sg.bias = 0.0005;
  // 柱 64 本を shadow caster に登録（地面・柱とも receiveShadows=true 済み）。
  for (let p = 0; p < pillars.length; p++) sg.addShadowCaster(pillars[p]);

  return { light, sg };
}

function disposeLight(e) {
  e.sg.dispose();      // シャドウマップ(RenderTarget)を解放
  e.light.dispose();
}

// N 変更時は φ_i が N に依存するため、全光源を作り直す。
function setLightCount(n) {
  n = Math.max(L_MIN, Math.min(L_MAX, n | 0));
  while (lights.length) disposeLight(lights.pop());
  for (let i = 0; i < n; i++) lights.push(makeLight(i, n));
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
let fps = 60, last = performance.now(), hudT = 0, t = 0;
const center = new BABYLON.Vector3(0, 1, 0);
const tmpDir = new BABYLON.Vector3();

function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  const n = lights.length;
  for (let i = 0; i < n; i++) {
    const phi = (i * Math.PI * 2) / n;
    const a = t * 0.4 + phi;
    const L = lights[i].light;
    L.position.set(22 * Math.cos(a), 30, 22 * Math.sin(a));
    // direction = 正規化( center - pos )。中心を指す。
    center.subtractToRef(L.position, tmpDir);
    tmpDir.normalize();
    L.direction.copyFrom(tmpDir);
    // 色相を光源ごとに変える（hue=i/n, sat=0.85, val=1）。
    L.diffuse = BABYLON.Color3.FromHSV((360 * i) / n, 0.85, 1);
  }

  scene.render();
  updateHUD(n);
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。Babylon はシャドウマップ生成パス（各光源 1 パス）も
// drawCalls に計上するため、three.js（メインパスのみ）より大きい値になりうる点に注意。

function updateHUD(n) {
  if (++hudT % 6 !== 0) return;
  const draws = instrumentation.drawCallsCounter.current;
  // Tris: 概算（注記）。地面 plane=2 + 柱 box 12 面/個 × 64。
  const tris = 2 + 12 * PILLARS;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${PILLARS}\n` +
    `Lights  ${n}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}`;
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
