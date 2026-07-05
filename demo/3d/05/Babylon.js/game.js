// 3D テーマ5(T2) ― 広域地形 + カリング/LOD/描画距離（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。ロジック（PRNG・配置・距離カリング・2段LOD・カメラ周回飛行）は
// three.js リファレンス実装(../three.js/game.js)と同一にしてある。描画レイヤだけ Babylon に置換。
//
// 移植方針（性能の肝）:
//   trunk / foliage / lowCone の 3 つを「元メッシュ」として 1 度だけ作り setEnabled(false)。
//   各木はその 3 メッシュの InstancedMesh（mesh.createInstance）として生成する。
//   Babylon は InstancedMesh を「個別に」フラスタムカリングするので、視錐台外は自動で描かれない
//   （thinInstance だとルート境界一括判定になりカリングが効かないため不採用）。
//   距離カリングは各インスタンスの setEnabled(true/false)、LOD は LOD0(幹+葉)群と
//   LOD1(低コーン)の enable 切替で行う。静的なので freezeWorldMatrix() で CPU を軽くする。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GRID = 100, SP = 8;                       // 100x100=10000本, 間隔8
const DD_INIT = 120, DD_STEP = 40, DD_MIN = 40, DD_MAX = 360;
const CAM_R = 140, CAM_Y = 26, CAM_W = 0.15;    // 周回半径/高さ/角速度
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
// WebGL2 既定（第4引数で adaptToDeviceRatio）。WebGPU は使わない。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// three.js リファレンスと同じ右手系（Y上）に揃える。これで木の配置・カメラ角が一致する。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#8fb8e6ff");
// fog: three.js は Fog(80,400) 相当（LINEAR）。空色でフェードさせる。
scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
scene.fogColor = BABYLON.Color3.FromHexString("#8fb8e6");
scene.fogStart = 80;
scene.fogEnd = 400;

function loadRepeatingTexture(path, uScale, vScale) {
  const texture = new BABYLON.Texture(path, scene);
  texture.uScale = uScale;
  texture.vScale = vScale;
  texture.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
  texture.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
  return texture;
}
const groundTexture = loadRepeatingTexture("../assets/ground_forest_texture.png", 30, 30);
const barkTexture = loadRepeatingTexture("../assets/tree_bark_texture.png", 1, 2);
const foliageTexture = loadRepeatingTexture("../assets/tree_foliage_texture.png", 2, 2);

// 透視投影カメラ（手動更新・デフォルト操作なし）。fov は垂直60°。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(CAM_R, CAM_Y, 0), scene);
camera.fov = 60 * Math.PI / 180;                // 垂直FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.5;
camera.maxZ = 1200;
// attachControl は呼ばない（自動周回飛行のみ）

// ライト: 環境光相当の Hemispheric + 平行光1灯（上方）
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#bcc8d8");
hemi.groundColor = BABYLON.Color3.FromHexString("#bcc8d8");
hemi.intensity = 0.8;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, -0.3).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.0;

// ---- 地面: 大判の平面 暗緑 --------------------------------------------------
const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 900, height: 900 }, scene);
const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
groundMat.diffuseColor = BABYLON.Color3.FromHexString("#24402a");
groundMat.diffuseTexture = groundTexture;
groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
ground.material = groundMat;

// ---- 共有元メッシュ / マテリアル（全木で共有） ------------------------------
// three.js の geo.translate に合わせて pivot を寄せる:
//   trunk: Cylinder(top0.4, bottom0.5, h2, 6分割) を +1 移動（底が y=0）
//   foliage: Cone(r1.7, h4, 8分割) を +4 移動（幹頂上に乗る）
//   lowCone(LOD1): Cone(r1.7, h6, 4分割) を +3 移動（底が y=0）
// Babylon の CreateCylinder は中心原点・+Y向き。bakeTransformIntoVertices で頂点を持ち上げる。
const trunkMat = new BABYLON.StandardMaterial("trunkMat", scene);
trunkMat.diffuseColor = BABYLON.Color3.FromHexString("#8a633c");
trunkMat.diffuseTexture = barkTexture;
trunkMat.specularColor = new BABYLON.Color3(0, 0, 0);
const foliageMat = new BABYLON.StandardMaterial("foliageMat", scene);
foliageMat.diffuseColor = BABYLON.Color3.FromHexString("#4d8f4a");
foliageMat.diffuseTexture = foliageTexture;
foliageMat.specularColor = new BABYLON.Color3(0, 0, 0);
const lowMat = new BABYLON.StandardMaterial("lowMat", scene);
lowMat.diffuseColor = BABYLON.Color3.FromHexString("#4b8848");
lowMat.diffuseTexture = foliageTexture;
lowMat.specularColor = new BABYLON.Color3(0, 0, 0);

const trunkSrc = BABYLON.MeshBuilder.CreateCylinder("trunkSrc", {
  diameterTop: 0.8, diameterBottom: 1.0, height: 2, tessellation: 6
}, scene);
trunkSrc.bakeTransformIntoVertices(BABYLON.Matrix.Translation(0, 1, 0));
trunkSrc.material = trunkMat;
trunkSrc.setEnabled(false);

// Cone = diameterTop:0 の Cylinder。three.js ConeGeometry(1.7,4,8) → 直径3.4。
const foliageSrc = BABYLON.MeshBuilder.CreateCylinder("foliageSrc", {
  diameterTop: 0, diameterBottom: 3.4, height: 4, tessellation: 8
}, scene);
foliageSrc.bakeTransformIntoVertices(BABYLON.Matrix.Translation(0, 4, 0));
foliageSrc.material = foliageMat;
foliageSrc.setEnabled(false);

// LOD1: 単一低ポリコーン ConeGeometry(1.7,6,4) → 直径3.4・4分割。
const lowSrc = BABYLON.MeshBuilder.CreateCylinder("lowSrc", {
  diameterTop: 0, diameterBottom: 3.4, height: 6, tessellation: 4
}, scene);
lowSrc.bakeTransformIntoVertices(BABYLON.Matrix.Translation(0, 3, 0));
lowSrc.material = lowMat;
lowSrc.setEnabled(false);

// 三角形数（概算用）。bake 後の indices/3。
const TRI_TRUNK = (trunkSrc.getTotalIndices() / 3) | 0;
const TRI_FOLIAGE = (foliageSrc.getTotalIndices() / 3) | 0;
const TRI_LOW = (lowSrc.getTotalIndices() / 3) | 0;
const TRI_LOD0 = TRI_TRUNK + TRI_FOLIAGE;       // 幹+葉
const TRI_GROUND = (ground.getTotalIndices() / 3) | 0;

// ---- 木を生成（InstancedMesh・共有ジオメトリ参照） --------------------------
// 各木 = { trunk, foliage, low, x, z }。trunk/foliage が LOD0、low が LOD1。
const trees = [];
function buildForest() {
  const rnd = mulberry32(SEED);
  for (let i = 0; i < GRID * GRID; i++) {
    const c = i % GRID, r = (i / GRID) | 0;
    const x = (c - (GRID - 1) / 2) * SP;
    const z = (r - (GRID - 1) / 2) * SP;
    // PRNG 消費順は three.js と同一: hf を先、ry を後。
    const hf = 0.8 + rnd() * 0.6;               // 高さ係数 0.8〜1.4
    const ry = rnd() * Math.PI * 2;             // Y回転

    const trunk = trunkSrc.createInstance("t" + i);
    const foliage = foliageSrc.createInstance("f" + i);
    const low = lowSrc.createInstance("l" + i);

    for (const m of [trunk, foliage, low]) {
      m.position.set(x, 0, z);
      m.rotation.y = ry;
      m.scaling.y = hf;                         // 高さだけスケール（three.js は scale.set(1,hf,1)）
      m.setEnabled(false);
      // 静的なのでワールド行列を固定。enable は freeze と独立に効く。
      m.freezeWorldMatrix();
      m.doNotSyncBoundingInfo = false;          // フラスタムカリング判定に境界は必要
    }
    trees.push({ trunk, foliage, low, x, z });
  }
}
buildForest();

// ---- 状態 / 入力 ------------------------------------------------------------
let drawDist = DD_INIT, fps = 60, last = performance.now(), hudT = 0;
let inRange = 0, nearCnt = 0, farCnt = 0;       // HUD 用（メインループで集計）
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") drawDist = Math.min(DD_MAX, drawDist + DD_STEP);
  if (k === "-" || k === "_" || k === "[") drawDist = Math.max(DD_MIN, drawDist - DD_STEP);
  if (k === "r") drawDist = DD_INIT;
});

// ---- メインループ -----------------------------------------------------------
let t = 0;
const camTarget = new BABYLON.Vector3();
function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;                     // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  // カメラ自動周回飛行（決定的・時間ベース）
  const th = t * CAM_W;
  const cx = CAM_R * Math.cos(th), cz = CAM_R * Math.sin(th);
  camera.position.set(cx, CAM_Y, cz);
  camTarget.set(CAM_R * 0.4 * Math.cos(th), 2, CAM_R * 0.4 * Math.sin(th));
  camera.setTarget(camTarget);

  // 距離カリング + LOD（アプリ側）。視錐台カリングは Babylon が InstancedMesh 単位で自動実行。
  const dd2 = drawDist * drawDist;
  const lod2 = (drawDist * 0.5) * (drawDist * 0.5);
  inRange = 0; nearCnt = 0; farCnt = 0;
  for (let i = 0; i < trees.length; i++) {
    const tr = trees[i];
    const dx = tr.x - cx, dz = tr.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > dd2) {
      // 描画距離外: 全インスタンス非表示
      tr.trunk.setEnabled(false);
      tr.foliage.setEnabled(false);
      tr.low.setEnabled(false);
      continue;
    }
    inRange++;
    const near = d2 <= lod2;
    if (near) nearCnt++; else farCnt++;
    // LOD0 = 幹+葉、LOD1 = 低コーン。enable 切替で排他表示。
    tr.trunk.setEnabled(near);
    tr.foliage.setEnabled(near);
    tr.low.setEnabled(!near);
  }

  scene.render();
  updateHUD();
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// Draws は SceneInstrumentation の drawCallsCounter から取得（フラスタムカリング後の実描画）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。

function updateHUD() {
  if (++hudT % 6 !== 0) return;                 // 数フレームに1回更新
  const draws = instrumentation.drawCallsCounter.current;
  // Tris は概算（注記）: メインループで集計した距離内の内訳から積算する。
  // 近距離(LOD0)=幹+葉、中距離(LOD1)=低コーン + 地面。視錐台カリング前の InRange ベースなので上限概算。
  const tris = TRI_GROUND + nearCnt * TRI_LOD0 + farCnt * TRI_LOW;
  hud.textContent =
    `FPS      ${fps.toFixed(1)}\n` +
    `Objects  ${inRange}\n` +
    `DrawDist ${drawDist}\n` +
    `Draws    ${draws}\n` +
    `Tris     ${tris.toLocaleString()}`;
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
