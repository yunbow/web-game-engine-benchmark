// 3D テーマ9(T9) ― ナビ群衆 A*（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。障害物グリッドを多数エージェントが自前A*で経路探索し、
// ゴール移動時に全エージェントが一斉再計算する。エージェント数が主軸。
import * as THREE from "three";

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

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e131a);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.5, 600);
const textureLoader = new THREE.TextureLoader();
const themeTexture = textureLoader.load("../assets/theme_texture.png");
themeTexture.colorSpace = THREE.SRGBColorSpace;
themeTexture.wrapS = themeTexture.wrapT = THREE.RepeatWrapping;
themeTexture.repeat.set(20, 20);
camera.position.set(0, 70, 60);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0x8090a0, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(0.4, 1, 0.5); scene.add(sun);

scene.add(new THREE.Mesh(new THREE.PlaneGeometry(GW * CSZ + 8, GW * CSZ + 8),
  new THREE.MeshLambertMaterial({ color: 0x1a2230, map: themeTexture })).rotateX(-Math.PI / 2));

// 壁（インスタンス）
const wallIdx = [];
for (let i = 0; i < GW * GW; i++) if (blocked[i]) wallIdx.push(i);
const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(CSZ * 0.96, 3, CSZ * 0.96),
  new THREE.MeshLambertMaterial({ color: 0x4a5568, map: themeTexture }), wallIdx.length);
{ const m = new THREE.Object3D(); for (let i = 0; i < wallIdx.length; i++) { const c = wallIdx[i]; m.position.set(cellX(c % GW), 1.5, cellZ((c / GW) | 0)); m.updateMatrix(); walls.setMatrixAt(i, m.matrix); } }
scene.add(walls);

// ゴールマーカー
const goalMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 4, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd54a }));
scene.add(goalMesh);

// ---- エージェント（インスタンス cone） --------------------------------------
const agentGeo = new THREE.ConeGeometry(0.7, 2.0, 8); agentGeo.translate(0, 1.0, 0); // 直立（底 y=0・先端 y=2）
const agents = new THREE.InstancedMesh(agentGeo,
  new THREE.MeshLambertMaterial({ color: 0x49c9ff, emissive: 0x0a3550 }), N_MAX);
agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
agents.frustumCulled = false;
scene.add(agents);

// エージェント状態（SoA）
const ax = new Float32Array(N_MAX), az = new Float32Array(N_MAX);   // ワールド座標
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
    acell[i] = c; ax[i] = cellX(c % GW); az[i] = cellZ((c / GW) | 0); pidx[i] = 0; paths[i].length = 0;
  }
}
function pickGoal() { const r3 = mulberry32(SEED ^ (0x9999 + repaths)); goalIdx = freeCells[(r3() * freeCells.length) | 0]; goalMesh.position.set(cellX(goalIdx % GW), 2, cellZ((goalIdx / GW) | 0)); }
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
const dummy = new THREE.Object3D();
let fps = 60, last = performance.now(), hudT = 0, goalT = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05; else if (dt < 0) dt = 0; // 初フレームは rAF時刻 < performance.now で負になりうる→下限0
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
      else { ax[i] += (dx / dist) * step; az[i] += (dz / dist) * step; dummy.rotation.y = Math.atan2(dx, dz); }
    }
    dummy.position.set(ax[i], 0, az[i]);
    dummy.updateMatrix();
    agents.setMatrixAt(i, dummy.matrix);
  }
  agents.count = count;
  agents.instanceMatrix.needsUpdate = true;

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
    `Agents  ${count}\n` +
    `Repaths ${repaths.toLocaleString()}\n` +
    `Draws   ${info.calls}\n` +
    `Tris    ${info.triangles.toLocaleString()}`;
}

requestAnimationFrame(frame);
