// 3D テーマ10(T10) ― 大量レイキャスト（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。ロジック（ターゲット配置・レイ方向・スキャナ・カメラ・入力）は
// three.js リファレンス実装(../three.js/game.js)と同一式・同一座標にしてある。
// レイ-メッシュ交差だけを Babylon の機構（BABYLON.Ray.intersectsMeshes）へ置き換えている。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const M = 120, SHELL = 28, BOX = 4;
const N_INIT = 1500, N_STEP = 1500, N_MIN = 500, N_MAX = 15000;
const FAR = 200;
const CAM_R = 55, CAM_Y = 20, CAM_W = 0.15;
const GOLDEN = 2.399963229728653; // 黄金角

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（WebGPU は使わない）。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// !!! 最重要トラップ: Babylon は既定が左手系。three.js（右手系・Y上）と座標を揃えるため
// 右手系にする。これでフィボナッチ球の座標式がそのまま three.js と一致する。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#05080dff");

// 透視投影カメラ（手動更新・デフォルト操作なし＝attachControl を呼ばない）。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(CAM_R, CAM_Y, 0), scene);
camera.fov = 55 * Math.PI / 180;     // 垂直FOV 55°（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.5;
camera.maxZ = 1000;
camera.setTarget(BABYLON.Vector3.Zero());

// ライト: 環境光相当の Hemispheric + 平行光1灯
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#8090a0");
hemi.groundColor = BABYLON.Color3.FromHexString("#8090a0");
hemi.intensity = 0.7;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.4, -1, -0.5).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.0;

// ---- ターゲット（M個の box を「個別 mesh」に） ------------------------------
// SPEC: 半径28のフィボナッチ球殻上に一辺4の軸整列(無回転)ボックスを配置。
// 採用方式: 個別 mesh の配列を作り、毎フレーム ray.intersectsMeshes([...]) で
// 最近交差を確実に取得する（thin instance picking は最近 thin instance の交差点を
// 安定して取りにくいため、確実さを優先して個別 mesh を採用＝120ドロー）。
// 描画負荷を抑えるため共有マテリアル＋freezeWorldMatrix を使う。
const targetMat = new BABYLON.StandardMaterial("targetMat", scene);
targetMat.diffuseColor = BABYLON.Color3.FromHexString("#6d8db0"); // 中明度
targetMat.specularColor = new BABYLON.Color3(0, 0, 0);

const targets = [];
for (let i = 0; i < M; i++) {
  const box = BABYLON.MeshBuilder.CreateBox("t" + i, { size: BOX }, scene);
  const y = 1 - 2 * (i + 0.5) / M, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * GOLDEN;
  box.position.set(Math.cos(th) * r * SHELL, y * SHELL, Math.sin(th) * r * SHELL);
  // rotation は 0（軸整列・無回転）。
  box.material = targetMat;
  box.isPickable = true;
  box.freezeWorldMatrix();          // 静止なのでワールド行列を凍結（交差判定でも使える）
  targets.push(box);
}

// スキャナ原点マーカー（自発光小球）
const scanner = BABYLON.MeshBuilder.CreateSphere("scanner", { diameter: 1.6, segments: 12 }, scene);
const scannerMat = new BABYLON.StandardMaterial("scannerMat", scene);
scannerMat.disableLighting = true;
scannerMat.emissiveColor = BABYLON.Color3.FromHexString("#6cff9a");
scannerMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
scanner.material = scannerMat;
scanner.isPickable = false;

// ---- 当たり点マーカー（thin instances の小球） -------------------------------
// 半径0.4の球 = 直径0.8。毎フレーム matrix を更新する。
const hits = BABYLON.MeshBuilder.CreateSphere("hits", { diameter: 0.8, segments: 6 }, scene);
const hitsMat = new BABYLON.StandardMaterial("hitsMat", scene);
hitsMat.disableLighting = true;                              // three.js は MeshBasicMaterial
hitsMat.emissiveColor = BABYLON.Color3.FromHexString("#ffd54a");
hitsMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
hits.material = hitsMat;
hits.isPickable = false;
const hitMatrices = new Float32Array(16 * N_MAX);
hits.thinInstanceSetBuffer("matrix", hitMatrices, 16, false);
hits.thinInstanceCount = 0;
// thin instance はルートメッシュ境界でカリングされる。当たり点は球殻全体に散るため
// 常にアクティブ扱いにしてカリングで全消失するのを防ぐ。
hits.alwaysSelectAsActiveMesh = true;

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
// Ray は使い回し（GC 回避）。length=FAR で far 上限を表現。
const ray = new BABYLON.Ray(BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, 0, 1), FAR);
const origin = ray.origin, dir = ray.direction;
const scaleV = new BABYLON.Vector3(1, 1, 1);
const quatId = BABYLON.Quaternion.Identity();
const posV = new BABYLON.Vector3();
const mtx = new BABYLON.Matrix();
let fps = 60, hudT = 0, t = 0, hitCount = 0;

function frame() {
  let dt = engine.getDeltaTime() / 1000;
  dt = Math.min(0.05, Math.max(0, dt));
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  // カメラ周回（決定的）
  const a = t * CAM_W;
  camera.position.set(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
  camera.setTarget(BABYLON.Vector3.Zero());

  // スキャナ原点（微小上下）＋ レイ全体をゆっくり Y 回転
  origin.set(0, Math.sin(t * 0.7) * 2, 0);
  scanner.position.copyFrom(origin);
  const rot = t * 0.1, cs = Math.cos(rot), sn = Math.sin(rot);

  hitCount = 0;
  for (let i = 0; i < count; i++) {
    // 方向（Y回転を適用）。three.js と同じ式。
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    dir.set(dx * cs - dz * sn, dy, dx * sn + dz * cs);
    ray.length = FAR; // intersectsMeshes は ray.length を far 上限として尊重する
    // intersectsMeshes(meshes, fastCheck, results): fastCheck=false で全メッシュを評価し
    // 距離でソートして返す → [0] が最近。fastCheck=true だと最初の交差で打ち切るため
    // 最近が取れない。必ず false（=最近交差を保証）。
    const picks = ray.intersectsMeshes(targets, false);
    if (picks.length) {
      const p = picks[0].pickedPoint; // ワールド座標の交差点
      posV.set(p.x, p.y, p.z);
      BABYLON.Matrix.ComposeToRef(scaleV, quatId, posV, mtx);
      mtx.copyToArray(hitMatrices, hitCount * 16);
      hitCount++;
    }
  }
  hits.thinInstanceCount = hitCount;
  if (hitCount > 0) hits.thinInstanceBufferUpdated("matrix");

  scene.render();
  updateHUD();
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。

function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回更新
  const draws = instrumentation.drawCallsCounter.current;
  // Tris 概算: ターゲット box 12三角/個 × M + スキャナ球 + 当たり点球(0.8径,6分割)≈ 60三角/個。
  const tris = 12 * M + 60 * hitCount;
  hud.textContent =
    `FPS    ${fps.toFixed(1)}\n` +
    `Objects ${M}\n` +
    `Rays   ${count}\n` +
    `Hits   ${hitCount}\n` +
    `Draws  ${draws}\n` +
    `Tris   ${tris.toLocaleString()}`;
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
