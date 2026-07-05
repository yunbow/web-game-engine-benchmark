// 3D テーマ9(T9) ― ナビ群衆 A*（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)とロジックを完全一致させる。
//
// A-Frame は three.js 上の宣言的フレームワーク。大量描画(InstancedMesh)・自前A*・経路追従は
// 宣言的タグでは表現できないため、カスタムコンポーネント `crowd` の中で AFRAME.THREE を直接使い、
// グリッド/障害物/A*/エージェント/ゴールを生成して el.object3D に載せる。
// three は別途読み込まず、A-Frame 同梱の AFRAME.THREE を使う。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GW = 40, CSZ = 2;
const N_INIT = 150, N_STEP = 50, N_MIN = 20, N_MAX = 1000;
const SPEED = 6, GOAL_MS = 4000, WALL_P = 0.18;
const SEED = 0x9e3779b9 >>> 0;

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cellX = (gx) => (gx - (GW - 1) / 2) * CSZ;
const cellZ = (gz) => (gz - (GW - 1) / 2) * CSZ;

AFRAME.registerComponent("crowd", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    const root = this.el.object3D; // a-scene の object3D に追加する親

    // ---- グリッド / 障害物（決定的） --------------------------------------
    const rnd = mulberry32(SEED);
    const blocked = new Uint8Array(GW * GW);
    const freeCells = [];
    for (let gz = 0; gz < GW; gz++) for (let gx = 0; gx < GW; gx++) {
      const b = rnd() < WALL_P ? 1 : 0;
      blocked[gz * GW + gx] = b;
      if (!b) freeCells.push(gz * GW + gx);
    }
    this.blocked = blocked;
    this.freeCells = freeCells;

    // ---- A* 用ワークバッファ ---------------------------------------------
    this.gScore = new Float64Array(GW * GW);
    this.came = new Int32Array(GW * GW);
    this.inHeap = new Uint8Array(GW * GW);

    // ---- ライト -----------------------------------------------------------
    root.add(new THREE.AmbientLight(0x8090a0, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(0.4, 1, 0.5);
    root.add(sun);

    // ---- 地面（大判の平面・暗色） ----------------------------------------
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GW * CSZ + 8, GW * CSZ + 8),
      new THREE.MeshLambertMaterial({ color: 0x1a2230 })
    );
    ground.rotateX(-Math.PI / 2);
    root.add(ground);

    // ---- 壁（インスタンス・高さ3） ---------------------------------------
    const wallIdx = [];
    for (let i = 0; i < GW * GW; i++) if (blocked[i]) wallIdx.push(i);
    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CSZ * 0.96, 3, CSZ * 0.96),
      new THREE.MeshLambertMaterial({ color: 0x4a5568 }), wallIdx.length);
    {
      const m = new THREE.Object3D();
      for (let i = 0; i < wallIdx.length; i++) {
        const c = wallIdx[i];
        m.position.set(cellX(c % GW), 1.5, cellZ((c / GW) | 0));
        m.updateMatrix();
        walls.setMatrixAt(i, m.matrix);
      }
    }
    root.add(walls);

    // ---- ゴールマーカー（単一円柱） --------------------------------------
    const goalMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.8, 4, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd54a }));
    root.add(goalMesh);
    this.goalMesh = goalMesh;

    // ---- エージェント（インスタンス cone・直立） -------------------------
    const agentGeo = new THREE.ConeGeometry(0.7, 2.0, 8);
    agentGeo.translate(0, 1.0, 0); // 直立（底 y=0・先端 y=2）
    const agents = new THREE.InstancedMesh(agentGeo,
      new THREE.MeshLambertMaterial({ color: 0x49c9ff, emissive: 0x0a3550 }), N_MAX);
    agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    agents.frustumCulled = false;
    root.add(agents);
    this.agents = agents;

    // ---- エージェント状態（SoA） -----------------------------------------
    this.ax = new Float32Array(N_MAX);   // ワールド座標 x
    this.az = new Float32Array(N_MAX);   // ワールド座標 z
    this.acell = new Int32Array(N_MAX);  // 現在セル
    this.paths = [];                     // 各エージェントの経路(セル配列)
    this.pidx = new Int32Array(N_MAX);   // 経路インデックス
    for (let i = 0; i < N_MAX; i++) this.paths.push([]);

    this.count = N_INIT;
    this.goalIdx = 0;
    this.repaths = 0;
    this.tmpPath = [];

    // ---- 初期配置 + ゴール + 一斉経路計算 --------------------------------
    this.placeAgents(N_INIT);
    this.pickGoal();
    this.repathAll();

    // ---- カメラ（宣言した #rig の camera 本体を一度だけ手動設定） --------
    // 重要: cameraEl.object3D は Group。Group.lookAt は +Z を対象へ向ける（非カメラ分岐）ため、
    // 子の PerspectiveCamera(-Z を見る)が真後ろを向く。よって THREE.Camera 本体を直接制御する。
    this.cameraEl = sceneEl.querySelector("#rig");
    this.cameraSet = false;
    this.trySetCamera();

    // ---- 入力 -------------------------------------------------------------
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.setCount(this.count + N_STEP);
      if (k === "-" || k === "_" || k === "[") this.setCount(this.count - N_STEP);
      if (k === "r") this.setCount(N_INIT);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- ループ用テンポラリ / HUD ----------------------------------------
    this.dummy = new THREE.Object3D();
    this.fps = 60;
    this.hudT = 0;
    this.goalT = 0;
    this.hud = document.getElementById("hud");
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
  },

  // camera 本体(object3D 'camera')に位置・lookAt を一度だけ設定。
  // init 時点で未生成のことがあるため tick 側からも再試行する。
  trySetCamera: function () {
    if (this.cameraSet || !this.cameraEl) return;
    const cam = this.cameraEl.getObject3D("camera");
    if (!cam) return;
    cam.position.set(0, 70, 60);
    cam.lookAt(0, 0, 0); // isCamera 分岐 → -Z が対象を向く（正しい）
    this.cameraSet = true;
  },

  // ---- 自前 A*（4近傍・マンハッタン・バイナリヒープ） --------------------
  astar: function (startIdx, goalIdx, outPath) {
    const blocked = this.blocked, gScore = this.gScore, came = this.came, inHeap = this.inHeap;
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
  },

  placeAgents: function (n) {
    const freeCells = this.freeCells, paths = this.paths;
    const r2 = mulberry32(SEED ^ 0x1234);
    for (let i = 0; i < n; i++) {
      const c = freeCells[(r2() * freeCells.length) | 0];
      this.acell[i] = c; this.ax[i] = cellX(c % GW); this.az[i] = cellZ((c / GW) | 0); this.pidx[i] = 0; paths[i].length = 0;
    }
  },

  pickGoal: function () {
    const freeCells = this.freeCells;
    const r3 = mulberry32(SEED ^ (0x9999 + this.repaths));
    this.goalIdx = freeCells[(r3() * freeCells.length) | 0];
    this.goalMesh.position.set(cellX(this.goalIdx % GW), 2, cellZ((this.goalIdx / GW) | 0));
  },

  repathAll: function () {
    const tmpPath = this.tmpPath, paths = this.paths;
    for (let i = 0; i < this.count; i++) {
      if (this.astar(this.acell[i], this.goalIdx, tmpPath)) { paths[i] = tmpPath.slice(); this.pidx[i] = 0; }
      else { paths[i].length = 0; }
    }
    this.repaths += this.count;
  },

  setCount: function (n) {
    this.count = Math.max(N_MIN, Math.min(N_MAX, n | 0));
    this.placeAgents(this.count);
    this.repathAll();
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し [0, 0.05] でクランプ。
  // 下限0必須（初回 timeDelta が負/未定義のとき NaN 化を防ぐ）。
  tick: function (time, timeDelta) {
    if (!this.cameraSet) this.trySetCamera();

    let dt = (timeDelta || 0) / 1000;
    dt = Math.min(0.05, Math.max(0, dt)); // スパイク抑制 + 下限0（負dt回避）
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;

    this.goalT += dt * 1000;
    if (this.goalT >= GOAL_MS) { this.goalT = 0; this.pickGoal(); this.repathAll(); } // ゴール移動→全再計算

    const dummy = this.dummy;
    const ax = this.ax, az = this.az, acell = this.acell, paths = this.paths, pidx = this.pidx;
    const count = this.count;
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
      this.agents.setMatrixAt(i, dummy.matrix);
    }
    this.agents.count = count;
    this.agents.instanceMatrix.needsUpdate = true;

    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const renderer = this.el.sceneEl.renderer;
    const info = renderer ? renderer.info.render : { calls: 0, triangles: 0 };
    this.hud.textContent =
      `FPS     ${this.fps.toFixed(1)}\n` +
      `Objects ${this.count}\n` +
      `Agents  ${this.count}\n` +
      `Repaths ${this.repaths.toLocaleString()}\n` +
      `Draws   ${info.calls}\n` +
      `Tris    ${info.triangles.toLocaleString()}`;
  }
});
