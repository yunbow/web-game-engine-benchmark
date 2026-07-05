// 3D テーマ2(T3) ― 箱タワー崩し（Babylon.js v8 + Havok 物理 移植版）
// SPEC: ../SPEC.md が唯一の正。ゲーム進行(タワー構築・発射・スコア・入力・カメラ・HUD)は
// three.js + Rapier の参照実装(../three.js/game.js)に合わせてある。
// 物理は必ず Havok を使う（自前物理は不可・統合相性が比較対象）。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const GRAV = -20;
const BOX = 2, BOX_HALF = 1;                 // 箱 2x2x2
const COLS = 20, GAP = 0.05, ROW_H = 2.02;   // タワー配置（ワイドな壁）
const N_INIT = 200, N_STEP = 50, N_MIN = 20, N_MAX = 1500;
const BALL_R = 1.5, MAX_PROJ = 8, FIRE_MS = 2000;
const FIRE_POS = [0, 10, 40], FIRE_VEL = [0, 2, -55];

// 物理マテリアル（SPEC）
const BOX_MASS = 1, BOX_REST = 0.1, BOX_FRIC = 0.6;
const BALL_MASS = 8, BALL_REST = 0.2, BALL_FRIC = 0.4;
const GROUND_REST = 0.1, GROUND_FRIC = 0.8;

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = BABYLON.Color4.FromHexString("#0a0c10ff");
// 既定は左手系。本テーマは対称レイアウトなので手系の違いは挙動に影響しない（SPEC §画面・座標）。
// three.js は右手系だが「左右手系の違いは比較に影響しない」と SPEC が明記しているため既定のまま。

// 固定カメラ（attachControl しない＝手動制御）。位置(0,14,56)・注視(0,10,0)・fov 50°(垂直)。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 14, 56), scene);
camera.setTarget(new BABYLON.Vector3(0, 10, 0));
camera.fov = 50 * Math.PI / 180;     // 垂直FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.1;
camera.maxZ = 2000;
// attachControl を呼ばない＝完全固定。

// ライト: 環境光相当の Hemispheric + 平行光1灯（上方やや手前から）
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#8899bb");
hemi.groundColor = BABYLON.Color3.FromHexString("#8899bb");
hemi.intensity = 0.6;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.4, -1, -0.6).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.1;

// ---- 床（視覚） -------------------------------------------------------------
// 上面 y=0 になるよう、厚み2の box を y=-1 に置く。
const groundMesh = BABYLON.MeshBuilder.CreateBox("ground", { width: 400, height: 2, depth: 400 }, scene);
groundMesh.position.set(0, -1, 0);
const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
groundMat.diffuseColor = BABYLON.Color3.FromHexString("#232830");
groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
groundMesh.material = groundMat;

// ---- 箱: ルートメッシュ + InstancedMesh（比較主軸） -------------------------
// SPEC ノートの推奨どおり「個別mesh+PhysicsAggregate」を採用（Havok と thin instance の
// 自動同期は不確実なため、確実に動く方式を優先）。ただし full mesh ではなく InstancedMesh を
// 使い、ジオメトリ/マテリアルを共有することで GPU 側のバッチ描画を効かせ draw call を抑える。
// 各 InstancedMesh は独立した TransformNode を持つので PhysicsAggregate が毎フレーム
// 位置/姿勢を書き込め、メッシュ変換が物理と同期する。
const boxRoot = BABYLON.MeshBuilder.CreateBox("boxRoot", { size: BOX }, scene);
const boxMat = new BABYLON.StandardMaterial("boxMat", scene);
boxMat.diffuseColor = BABYLON.Color3.FromHexString("#b9a98c"); // 石色
boxMat.specularColor = new BABYLON.Color3(0, 0, 0);
boxRoot.material = boxMat;
boxRoot.setEnabled(false); // ルート自体は描画しない（インスタンスのみ描画）
boxRoot.isVisible = false;

// ---- 砲弾: ルートメッシュ + InstancedMesh -----------------------------------
const ballRoot = BABYLON.MeshBuilder.CreateSphere("ballRoot", { diameter: BALL_R * 2, segments: 16 }, scene);
const ballMat = new BABYLON.StandardMaterial("ballMat", scene);
ballMat.diffuseColor = BABYLON.Color3.FromHexString("#e8533b"); // 赤
ballMat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
ballRoot.material = ballMat;
ballRoot.setEnabled(false);
ballRoot.isVisible = false;

// ---- ゲーム状態 -------------------------------------------------------------
let groundAgg = null;
let boxes = [];     // { mesh: InstancedMesh, agg: PhysicsAggregate }
let boxScored = []; // bool[]
let projs = [];     // { mesh, agg } | null  （長さ MAX_PROJ 固定スロット）
let count = N_INIT, score = 0, fireT = FIRE_MS;
let fps = 60, last = performance.now(), hudT = 0;
let physicsReady = false;

// ---- 物理セットアップ -------------------------------------------------------
function buildGround() {
  // PhysicsAggregate: type BOX, mass 0(静的), restitution0.1, friction0.8
  groundAgg = new BABYLON.PhysicsAggregate(
    groundMesh, BABYLON.PhysicsShapeType.BOX,
    { mass: 0, restitution: GROUND_REST, friction: GROUND_FRIC }, scene);
}

function disposeBoxes() {
  for (const b of boxes) { b.agg.dispose(); b.mesh.dispose(); }
  boxes = []; boxScored = [];
}
function disposeProjs() {
  for (const p of projs) { if (p) { p.agg.dispose(); p.mesh.dispose(); } }
  projs = new Array(MAX_PROJ).fill(null);
}

function buildTower(n) {
  // 既存の箱/砲弾を完全破棄して作り直し（SPEC: N 変更時はタワー再構築・砲弾もクリア）
  disposeBoxes();
  disposeProjs();

  const rows = Math.ceil(n / COLS);
  for (let i = 0; i < n; i++) {
    const c = i % COLS, r = Math.floor(i / COLS);
    const x = (c - (COLS - 1) / 2) * (BOX + GAP);
    const y = BOX_HALF + r * ROW_H;
    const mesh = boxRoot.createInstance("box" + i);
    mesh.position.set(x, y, 0);
    mesh.rotationQuaternion = BABYLON.Quaternion.Identity(); // Havok は quaternion で姿勢を書く
    // DYNAMIC な箱: mass1 / rest0.1 / fric0.6（2x2x2 → shape は size から自動）
    const agg = new BABYLON.PhysicsAggregate(
      mesh, BABYLON.PhysicsShapeType.BOX,
      { mass: BOX_MASS, restitution: BOX_REST, friction: BOX_FRIC }, scene);
    boxes.push({ mesh, agg });
    boxScored.push(false);
  }
  count = n;
}

function fire() {
  // 空きスロット優先。無ければ最古(=添字最小の生存スロット)を回収。
  let slot = projs.findIndex((p) => p === null);
  if (slot < 0) {
    slot = projs.findIndex((p) => p !== null);
    if (slot >= 0) { projs[slot].agg.dispose(); projs[slot].mesh.dispose(); projs[slot] = null; }
    else slot = 0;
  }
  const mesh = ballRoot.createInstance("ball" + slot + "_" + (performance.now() | 0));
  mesh.position.set(FIRE_POS[0], FIRE_POS[1], FIRE_POS[2]);
  mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
  const agg = new BABYLON.PhysicsAggregate(
    mesh, BABYLON.PhysicsShapeType.SPHERE,
    { mass: BALL_MASS, restitution: BALL_REST, friction: BALL_FRIC }, scene);
  // 初速 (0,2,-55)
  agg.body.setLinearVelocity(new BABYLON.Vector3(FIRE_VEL[0], FIRE_VEL[1], FIRE_VEL[2]));
  projs[slot] = { mesh, agg };
}

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  if (!physicsReady) return;
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
function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;

  if (!physicsReady) { scene.render(); return; }

  // 発射タイマ（2.0秒ごと）
  fireT -= dt * 1000;
  if (fireT <= 0) { fireT = FIRE_MS; fire(); }

  // Havok は scene.render() 内で自動ステップ（enablePhysics 後）。
  // 物理→メッシュ変換は Havok プラグインが各 PhysicsBody から mesh の
  // position / rotationQuaternion へ書き戻す（同期は自動）。

  // 箱のスコア判定（中心 y<0.5 初到達で +10）。
  // 物理ステップは scene.render() 内なので、前フレーム結果を見て判定 → render の順でよい。
  for (let i = 0; i < boxes.length; i++) {
    const y = boxes[i].mesh.position.y;
    if (!boxScored[i] && y < 0.5) { boxScored[i] = true; score += 10; }
  }

  // 砲弾の寿命管理（z<-60 or y<-20 で破棄）
  let pn = 0;
  for (let s = 0; s < projs.length; s++) {
    const p = projs[s];
    if (!p) continue;
    const t = p.mesh.position;
    if (t.z < -60 || t.y < -20) { p.agg.dispose(); p.mesh.dispose(); projs[s] = null; continue; }
    pn++;
  }

  scene.render();
  updateHUD(pn);
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// draw call は SceneInstrumentation で取得（T1 版に倣う・ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。

function updateHUD(pn) {
  hudT++;
  if (hudT % 6 !== 0) return; // 数フレームに1回更新
  const draws = instrumentation.drawCallsCounter.current;
  // Tris は概算（SPEC 注記どおり）: 箱12三角×箱数 + 砲弾(16x16 球は約 16*16*2≈512三角)×発数。
  const tris = 12 * boxes.length + 512 * pn;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${boxes.length + pn}\n` +
    `Score   ${score}\n` +
    `Bodies  ${count}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}`;
}

// ---- 起動（Havok WASM 初期化を待つ） ----------------------------------------
// 手順: await HavokPhysics() → new HavokPlugin(true, hk) → scene.enablePhysics(gravity, plugin)
(async () => {
  try {
    const hk = await HavokPhysics();                  // グローバル関数。Promise で wasm インスタンス
    const plugin = new BABYLON.HavokPlugin(true, hk); // 第1引数 true = 物理を 60Hz 等で内部固定ステップ
    scene.enablePhysics(new BABYLON.Vector3(0, GRAV, 0), plugin);
    buildGround();
    buildTower(count);
    physicsReady = true;
    engine.runRenderLoop(frame);
  } catch (e) {
    hud.textContent = "Havok init failed: " + (e && e.message ? e.message : e);
    console.error(e);
  }
})();

addEventListener("resize", () => engine.resize());
