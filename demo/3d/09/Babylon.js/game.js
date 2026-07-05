// 3D テーマ9(T9) ― ナビ群衆 A*（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。A* / グリッド / 障害物 / PRNG / ゴール移動 / 経路追従 /
// Repaths のロジックは three.js リファレンス実装(../three.js/game.js)とビット単位で同一。
// 描画レイヤだけを Babylon の thin instances に置き換えている。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GW = 40, CSZ = 2;
const N_INIT = 150, N_STEP = 50, N_MIN = 20, N_MAX = 1000;
const SPEED = 6, GOAL_MS = 4000, WALL_P = 0.18;
const SEED = 0x9e3779b9 >>> 0;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const cellX = (gx) => (gx - (GW - 1) / 2) * CSZ;
const cellZ = (gz) => (gz - (GW - 1) / 2) * CSZ;

// ---- グリッド / 障害物（決定的） --------------------------------------------
const blocked = new Uint8Array(GW * GW);
const freeCells = [];
for (let gz = 0; gz < GW; gz++) for (let gx = 0; gx < GW; gx++) {
  const b = rnd() < WALL_P ? 1 : 0;
  blocked[gz * GW + gx] = b;
  if (!b) freeCells.push(gz * GW + gx);
}

// ---- 自前 A*（4近傍・マンハッタン・バイナリヒープ） -------------------------
// three.js 版と完全同一。結果（経路）が4ライブラリで一致することが SPEC 要件。
const gScore = new Float64Array(GW * GW);
const came = new Int32Array(GW * GW);
const inHeap = new Uint8Array(GW * GW);
function astar(startIdx, goalIdx, outPath) {
  outPath.length = 0;
  if (startIdx === goalIdx || blocked[goalIdx]) return false;
  gScore.fill(Infinity); came.fill(-1); inHeap.fill(0);
  const ggx = goalIdx % GW, ggz = (goalIdx / GW) | 0;
  const heap = [];   // [f, idx]
  const push = (f, idx) => { heap.push(f, idx); let c = heap.length / 2 - 1; while (c > 0) { const p = ((c - 1) >> 1); if (heap[p * 2] <= heap[c * 2]) break; [heap[p*2],heap[c*2]]=[heap[c*2],heap[p*2]]; [heap[p*2+1],heap[c*2+1]]=[heap[c*2+1],heap[p*2+1]]; c = p; } };
  const pop = () => { const idx = heap[1]; const n = heap.length / 2 - 1; heap[0] = heap[n*2]; heap[1] = heap[n*2+1]; heap.length -= 2; let c = 0; const sz = heap.length/2; while (true) { let l=c*2+1, r=c*2+2, s=c; if(l<sz&&heap[l*2]<heap[s*2])s=l; if(r<sz&&heap[r*2]<heap[s*2])s=r; if(s===c)break; [heap[c*2],heap[s*2]]=[heap[s*2],heap[c*2]]; [heap[c*2+1],heap[s*2+1]]=[heap[s*2+1],heap[c*2+1]]; c=s; } return idx; };
  gScore[startIdx] = 0;
  const sgx = startIdx % GW, sgz = (startIdx / GW) | 0;
  push(Math.abs(sgx - ggx) + Math.abs(sgz - ggz), startIdx);
  while (heap.length) {
    const cur = pop();
    if (cur === goalIdx) {
      let c = goalIdx; while (c !== -1) { outPath.push(c); c = came[c]; } outPath.reverse(); return true;
    }
    const cx = cur % GW, cz = (cur / GW) | 0, cg = gScore[cur];
    for (let d = 0; d < 4; d++) {
      const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = cz + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || nx >= GW || nz < 0 || nz >= GW) continue;
      const ni = nz * GW + nx; if (blocked[ni]) continue;
      const ng = cg + 1;
      if (ng < gScore[ni]) { gScore[ni] = ng; came[ni] = cur; push(ng + Math.abs(nx - ggx) + Math.abs(nz - ggz), ni); }
    }
  }
  return false;
}

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（WebGPU は使わない）。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// !!! 最重要トラップ: Babylon は既定が左手系。右手系にして three.js と座標を一致させる。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#0e131aff");

// 透視投影カメラ（斜め見下ろし・操作なし）。fov は垂直55°。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 70, 60), scene);
camera.fov = 55 * Math.PI / 180;     // 垂直FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.5;
camera.maxZ = 600;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
// attachControl を呼ばない＝固定カメラ

// ライト: 環境光相当の Hemispheric + 平行光1灯
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#8090a0");
hemi.groundColor = BABYLON.Color3.FromHexString("#8090a0");
hemi.intensity = 0.8;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.4, -1, -0.5).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.0;

// ---- 地面 -------------------------------------------------------------------
const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: GW * CSZ + 8, height: GW * CSZ + 8 }, scene);
const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
groundMat.diffuseColor = BABYLON.Color3.FromHexString("#1a2230");
groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
ground.material = groundMat;

// ---- 壁（thin instances・box 高さ3） ----------------------------------------
const wallIdx = [];
for (let i = 0; i < GW * GW; i++) if (blocked[i]) wallIdx.push(i);
const walls = BABYLON.MeshBuilder.CreateBox("walls", { width: CSZ * 0.96, height: 3, depth: CSZ * 0.96 }, scene);
const wallMat = new BABYLON.StandardMaterial("wallMat", scene);
wallMat.diffuseColor = BABYLON.Color3.FromHexString("#4a5568");
wallMat.specularColor = new BABYLON.Color3(0, 0, 0);
walls.material = wallMat;
{
  const wallMatrices = new Float32Array(16 * wallIdx.length);
  const scaleV = new BABYLON.Vector3(1, 1, 1);
  const quat = BABYLON.Quaternion.Identity();
  const posV = new BABYLON.Vector3();
  const mtx = new BABYLON.Matrix();
  for (let i = 0; i < wallIdx.length; i++) {
    const c = wallIdx[i];
    posV.set(cellX(c % GW), 1.5, cellZ((c / GW) | 0));   // 中心 y=1.5 → 底 y=0
    BABYLON.Matrix.ComposeToRef(scaleV, quat, posV, mtx);
    mtx.copyToArray(wallMatrices, i * 16);
  }
  walls.thinInstanceSetBuffer("matrix", wallMatrices, 16, true); // 静的（壁は動かない）
  walls.thinInstanceCount = wallIdx.length;
}
walls.alwaysSelectAsActiveMesh = true;

// ---- ゴールマーカー（単一円柱・明るい黄） -----------------------------------
const goalMesh = BABYLON.MeshBuilder.CreateCylinder("goal", { diameter: 1.6, height: 4, tessellation: 12 }, scene);
const goalMat = new BABYLON.StandardMaterial("goalMat", scene);
goalMat.disableLighting = true;            // three.js は MeshBasicMaterial（無影の単色）
goalMat.emissiveColor = BABYLON.Color3.FromHexString("#ffd54a");
goalMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
goalMesh.material = goalMat;

// ---- エージェント（thin instances・cone 直立・底 y=0） -----------------------
// three.js: ConeGeometry(0.7,2.0,8) を translate(0,1,0)。Babylon の Cylinder(diameterTop:0)
// は +Y 向き・原点中心なので、合成行列で y=+1 オフセットして底 y=0・先端 y=2 にする。
const agents = BABYLON.MeshBuilder.CreateCylinder("agents", {
  diameterTop: 0, diameterBottom: 1.4, height: 2.0, tessellation: 8
}, scene);
const agentMat = new BABYLON.StandardMaterial("agentMat", scene);
agentMat.diffuseColor = BABYLON.Color3.FromHexString("#49c9ff");
agentMat.emissiveColor = BABYLON.Color3.FromHexString("#0a3550");
agentMat.specularColor = new BABYLON.Color3(0, 0, 0);
agents.material = agentMat;

// thin instance 行列バッファ（毎フレーム書き換え＝static=false）
const agentMatrices = new Float32Array(16 * N_MAX);
agents.thinInstanceSetBuffer("matrix", agentMatrices, 16, false);
agents.thinInstanceCount = N_INIT;
// thin instance はルートメッシュ境界でカリングされる。個体が盤面全体に散り毎フレーム動く
// ため、境界再計算ではなく常にアクティブ扱いにしてカリングを回避（小惑星版と同理由）。
agents.alwaysSelectAsActiveMesh = true;

// エージェント状態（SoA）
const ax = new Float32Array(N_MAX), az = new Float32Array(N_MAX);   // ワールド座標
const ay = new Float32Array(N_MAX);                                  // 向き（atan2）
const acell = new Int32Array(N_MAX);                                 // 現在セル
const paths = [];                                                    // 各エージェントの経路(セル配列)
const pidx = new Int32Array(N_MAX);                                  // 経路インデックス
for (let i = 0; i < N_MAX; i++) paths.push([]);

let count = N_INIT, goalIdx = 0, repaths = 0;
const tmpPath = [];

function placeAgents(n) {
  const r2 = mulberry32(SEED ^ 0x1234);
  for (let i = 0; i < n; i++) {
    const c = freeCells[(r2() * freeCells.length) | 0];
    acell[i] = c; ax[i] = cellX(c % GW); az[i] = cellZ((c / GW) | 0); ay[i] = 0; pidx[i] = 0; paths[i].length = 0;
  }
}
function pickGoal() {
  const r3 = mulberry32(SEED ^ (0x9999 + repaths));
  goalIdx = freeCells[(r3() * freeCells.length) | 0];
  goalMesh.position.set(cellX(goalIdx % GW), 2, cellZ((goalIdx / GW) | 0));
}
function repathAll() {
  for (let i = 0; i < count; i++) {
    if (astar(acell[i], goalIdx, tmpPath)) { paths[i] = tmpPath.slice(); pidx[i] = 0; }
    else { paths[i].length = 0; }
  }
  repaths += count;
}
function setCount(n) { count = Math.max(N_MIN, Math.min(N_MAX, n | 0)); placeAgents(count); repathAll(); }
placeAgents(N_INIT); pickGoal(); repathAll();

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
  if (k === "r") setCount(N_INIT);
});

// ---- メインループ -----------------------------------------------------------
const scaleV = new BABYLON.Vector3(1, 1, 1);
const quat = new BABYLON.Quaternion();
const posV = new BABYLON.Vector3();
const mtx = new BABYLON.Matrix();
let fps = 60, hudT = 0, goalT = 0;

function frame() {
  // Babylon の getDeltaTime() は常に非負（ms）。万一の 0 / 巨大値に備えクランプ。
  // 負dt や 0除算は全エージェントを NaN 化＝不可視にする既知の罠。
  let dt = engine.getDeltaTime() / 1000;
  dt = Math.min(0.05, Math.max(0, dt));
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;

  goalT += dt * 1000;
  if (goalT >= GOAL_MS) { goalT = 0; pickGoal(); repathAll(); } // ゴール移動→全再計算

  for (let i = 0; i < count; i++) {
    const path = paths[i];
    if (pidx[i] < path.length) {
      const c = path[pidx[i]]; const tx = cellX(c % GW), tz = cellZ((c / GW) | 0);
      let dx = tx - ax[i], dz = tz - az[i]; const dist = Math.hypot(dx, dz);
      const step = SPEED * dt;
      if (dist < 1e-6) { acell[i] = c; pidx[i]++; }            // 既に到達（0除算回避）
      else if (dist <= step) { ax[i] = tx; az[i] = tz; acell[i] = c; pidx[i]++; }
      else { ax[i] += (dx / dist) * step; az[i] += (dz / dist) * step; ay[i] = Math.atan2(dx, dz); }
    }
    // 行列合成: 位置(ax, +1, az)・Y回転 ay・等倍。+1 で円錐の底を y=0 に乗せる。
    BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Y, ay[i], quat);
    posV.set(ax[i], 1.0, az[i]);
    BABYLON.Matrix.ComposeToRef(scaleV, quat, posV, mtx);
    mtx.copyToArray(agentMatrices, i * 16);
  }
  agents.thinInstanceCount = count;
  agents.thinInstanceBufferUpdated("matrix");

  scene.render();
  updateHUD();
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// Draws は SceneInstrumentation から（ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回更新
  const draws = instrumentation.drawCallsCounter.current;
  // Tris: 概算。cone(8分割)≈16三角/個 × count、box(壁)≈12三角/個 × 壁数、ゴール円柱 ≈48三角。
  const tris = 16 * count + 12 * wallIdx.length + 48;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${count}\n` +
    `Agents  ${count}\n` +
    `Repaths ${repaths.toLocaleString()}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}`;
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
