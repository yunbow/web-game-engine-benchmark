// 3D テーマ9(T9) ― ナビ群衆 A*（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。数値・挙動は three.js リファレンス実装に完全一致させる。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。
//
// 【最重要】classic script のため、全体を IIFE で包んでグローバル名前空間の
//          let/const 衝突（"Identifier 't' has already been declared" 等）を回避する。
(function () {
  "use strict";

  // ---- 共通定数（SPEC 準拠・全ライブラリ一致） ------------------------------
  const W = 960, H = 540;
  const GW = 40, CSZ = 2;
  const N_INIT = 150, N_STEP = 50, N_MIN = 20, N_MAX = 1000;
  const SPEED = 6, GOAL_MS = 4000, WALL_P = 0.18;
  const SEED = 0x9e3779b9 >>> 0;

  // ---- 決定的疑似乱数（mulberry32, Math.random 不使用） --------------------
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

  // ---- グリッド / 障害物（決定的） ------------------------------------------
  const blocked = new Uint8Array(GW * GW);
  const freeCells = [];
  for (let gz = 0; gz < GW; gz++) for (let gx = 0; gx < GW; gx++) {
    const b = rnd() < WALL_P ? 1 : 0;
    blocked[gz * GW + gx] = b;
    if (!b) freeCells.push(gz * GW + gx);
  }

  // ---- 自前 A*（4近傍・マンハッタン・バイナリヒープ） -----------------------
  // three.js リファレンスと同一アルゴリズム＝同じ経路になること。
  const gScore = new Float64Array(GW * GW);
  const came = new Int32Array(GW * GW);
  const inHeap = new Uint8Array(GW * GW);
  function astar(startIdx, goalIdx, outPath) {
    outPath.length = 0;
    if (startIdx === goalIdx || blocked[goalIdx]) return false;
    gScore.fill(Infinity); came.fill(-1); inHeap.fill(0);
    const ggx = goalIdx % GW, ggz = (goalIdx / GW) | 0;
    const heap = [];   // [f, idx]
    const push = (f, idx) => { heap.push(f, idx); let c = heap.length / 2 - 1; while (c > 0) { const p = ((c - 1) >> 1); if (heap[p * 2] <= heap[c * 2]) break; [heap[p * 2], heap[c * 2]] = [heap[c * 2], heap[p * 2]]; [heap[p * 2 + 1], heap[c * 2 + 1]] = [heap[c * 2 + 1], heap[p * 2 + 1]]; c = p; } };
    const pop = () => { const idx = heap[1]; const n = heap.length / 2 - 1; heap[0] = heap[n * 2]; heap[1] = heap[n * 2 + 1]; heap.length -= 2; let c = 0; const sz = heap.length / 2; while (true) { let l = c * 2 + 1, r = c * 2 + 2, s = c; if (l < sz && heap[l * 2] < heap[s * 2]) s = l; if (r < sz && heap[r * 2] < heap[s * 2]) s = r; if (s === c) break; [heap[c * 2], heap[s * 2]] = [heap[s * 2], heap[c * 2]]; [heap[c * 2 + 1], heap[s * 2 + 1]] = [heap[s * 2 + 1], heap[c * 2 + 1]]; c = s; } return idx; };
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

  // ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） --------------
  const canvas = document.getElementById("app");
  const app = new pc.Application(canvas, {
    graphicsDeviceOptions: {
      deviceTypes: [pc.DEVICETYPE_WEBGL2], // WebGL2 を明示（WebGPU は使わない）
      antialias: true,
      alpha: false,
    },
  });
  const device = app.graphicsDevice;
  // 960x540 固定解像度
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);
  // 環境光 #8090a0 × 0.8 相当
  app.scene.ambientLight = new pc.Color(0x80 / 255, 0x90 / 255, 0xa0 / 255).mulScalar(0.8);

  // ---- カメラ（固定・斜め見下ろし） ----------------------------------------
  const camEntity = new pc.Entity("camera");
  camEntity.addComponent("camera", {
    fov: 55,
    nearClip: 0.5,
    farClip: 600,
    clearColor: new pc.Color(0x0e / 255, 0x13 / 255, 0x1a / 255), // #0e131a
  });
  app.root.addChild(camEntity);
  camEntity.setPosition(0, 70, 60);
  camEntity.lookAt(0, 0, 0);

  // ---- ライト（平行光1灯 + 環境光） ----------------------------------------
  const sun = new pc.Entity("sun");
  sun.addComponent("light", {
    type: "directional",
    color: new pc.Color(1, 1, 1),
    intensity: 1.0,
    castShadows: false,
  });
  // three.js: sun.position(0.4,1,0.5) からの平行光＝向きは原点へ向かう (-0.4,-1,-0.5)。
  {
    const dir = new pc.Vec3(-0.4, -1, -0.5).normalize();
    sun.setPosition(0, 0, 0);
    sun.lookAt(dir.x, dir.y, dir.z);
  }
  app.root.addChild(sun);

  // ---- 共有: 行列計算用の一時オブジェクト -----------------------------------
  const tmpMat = new pc.Mat4();
  const tmpPos = new pc.Vec3();
  const tmpRot = new pc.Quat();
  const tmpScale = new pc.Vec3(1, 1, 1);

  // インスタンス行列を Float32Array に書き込む（列優先 = PlayCanvas Mat4）。
  function writeMatrix(data, idx, px, py, pz, qx, qy, qz, qw) {
    tmpPos.set(px, py, pz);
    tmpRot.set(qx, qy, qz, qw);
    tmpScale.set(1, 1, 1);
    tmpMat.setTRS(tmpPos, tmpRot, tmpScale);
    data.set(tmpMat.data, idx * 16);
  }

  // ---- ハードウェアインスタンシング用 ヘルパ --------------------------------
  // per-instance の 4x4 行列を float32(16要素×count) で持つ VertexBuffer を作り、
  // MeshInstance.setInstancing で割り当て、毎フレーム setData で更新する。
  function createInstancedRender(parentEntity, mesh, material, maxCount) {
    const meshInstance = new pc.MeshInstance(mesh, material);
    const format = pc.VertexFormat.getDefaultInstancingFormat(device);
    const vb = new pc.VertexBuffer(device, format, maxCount, { usage: pc.BUFFER_DYNAMIC });
    meshInstance.setInstancing(vb);
    const data = new Float32Array(maxCount * 16);
    const entity = new pc.Entity();
    entity.addComponent("render", {
      meshInstances: [meshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    parentEntity.addChild(entity);
    return { meshInstance, vb, data, mesh };
  }

  function meshTris(mesh) {
    return mesh.indexBuffer && mesh.indexBuffer[0] ? mesh.indexBuffer[0].numIndices / 3 : 0;
  }

  // ---- 地面（大判の平面・暗color） -----------------------------------------
  const groundMesh = pc.createPlane(device, { halfExtents: new pc.Vec2((GW * CSZ + 8) / 2, (GW * CSZ + 8) / 2) });
  const groundMat = new pc.StandardMaterial();
  groundMat.diffuse = new pc.Color(0x1a / 255, 0x22 / 255, 0x30 / 255);
  groundMat.useMetalness = false;
  groundMat.update();
  const ground = new pc.Entity("ground");
  ground.addComponent("render", { meshInstances: [new pc.MeshInstance(groundMesh, groundMat)], castShadows: false });
  // pc.createPlane は既に XZ 平面（法線 +Y）なので回転不要。
  ground.setPosition(0, 0, 0);
  app.root.addChild(ground);

  // ---- 壁（hardware instancing・box 高さ3） ---------------------------------
  const wallIdx = [];
  for (let i = 0; i < GW * GW; i++) if (blocked[i]) wallIdx.push(i);
  const wallMesh = pc.createBox(device, {
    halfExtents: new pc.Vec3(CSZ * 0.96 / 2, 3 / 2, CSZ * 0.96 / 2),
  });
  wallMesh.incRefCount();
  const wallMat = new pc.StandardMaterial();
  wallMat.diffuse = new pc.Color(0x4a / 255, 0x55 / 255, 0x68 / 255);
  wallMat.useMetalness = false;
  wallMat.update();
  const wallInst = createInstancedRender(app.root, wallMesh, wallMat, Math.max(1, wallIdx.length));
  {
    const wd = wallInst.data;
    for (let i = 0; i < wallIdx.length; i++) {
      const c = wallIdx[i];
      writeMatrix(wd, i, cellX(c % GW), 1.5, cellZ((c / GW) | 0), 0, 0, 0, 1);
    }
    wallInst.vb.setData(wd);
    wallInst.meshInstance.instancingCount = wallIdx.length;
  }

  // ---- ゴールマーカー（単一円柱） ------------------------------------------
  const goalMesh = pc.createCylinder(device, { radius: 0.8, height: 4 });
  const goalMat = new pc.StandardMaterial();
  goalMat.useLighting = false;                 // Basic 相当（常時明るい）
  goalMat.emissive = new pc.Color(1, 0xd5 / 255, 0x4a / 255); // #ffd54a
  goalMat.diffuse = new pc.Color(0, 0, 0);
  goalMat.update();
  const goal = new pc.Entity("goal");
  goal.addComponent("render", { meshInstances: [new pc.MeshInstance(goalMesh, goalMat)], castShadows: false });
  app.root.addChild(goal);

  // ---- エージェント（hardware instancing・円錐・直立） ----------------------
  // three.js: ConeGeometry(0.7,2.0,8) を translate(0,1.0,0)＝底 y=0・先端 y=2。
  // pc.createCone は中心原点（高さ -h/2..+h/2）。translate 相当に +1.0 して直立させる。
  const agentMesh = pc.createCone(device, { baseRadius: 0.7, peakRadius: 0, height: 2.0, capSegments: 8 });
  agentMesh.incRefCount();
  const agentMat = new pc.StandardMaterial();
  agentMat.diffuse = new pc.Color(0x49 / 255, 0xc9 / 255, 1); // #49c9ff
  agentMat.emissive = new pc.Color(0x0a / 255, 0x35 / 255, 0x50 / 255);
  agentMat.useMetalness = false;
  agentMat.update();
  const agentInst = createInstancedRender(app.root, agentMesh, agentMat, N_MAX);

  // ---- エージェント状態（SoA） ---------------------------------------------
  const ax = new Float32Array(N_MAX), az = new Float32Array(N_MAX);   // ワールド座標
  const acell = new Int32Array(N_MAX);                                 // 現在セル
  const ayaw = new Float32Array(N_MAX);                                // 進行方向(ラジアン)
  const paths = [];                                                    // 各エージェントの経路(セル配列)
  const pidx = new Int32Array(N_MAX);                                  // 経路インデックス
  for (let i = 0; i < N_MAX; i++) paths.push([]);

  let count = N_INIT, goalIdx = 0, repaths = 0;
  const tmpPath = [];

  function placeAgents(n) {
    const r2 = mulberry32(SEED ^ 0x1234);
    for (let i = 0; i < n; i++) {
      const c = freeCells[(r2() * freeCells.length) | 0];
      acell[i] = c; ax[i] = cellX(c % GW); az[i] = cellZ((c / GW) | 0); pidx[i] = 0; paths[i].length = 0; ayaw[i] = 0;
    }
  }
  function pickGoal() {
    const r3 = mulberry32(SEED ^ (0x9999 + repaths));
    goalIdx = freeCells[(r3() * freeCells.length) | 0];
    goal.setPosition(cellX(goalIdx % GW), 2, cellZ((goalIdx / GW) | 0));
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

  // ---- 入力（three.js版と同じ素の addEventListener 実装） -------------------
  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
    if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
    if (k === "r") setCount(N_INIT);
  });

  // ---- メインループ ---------------------------------------------------------
  let fps = 60, goalT = 0;
  const agentTris = meshTris(agentMesh);

  app.on("update", (dtRaw) => {
    // PlayCanvas の update dt は常に非負だが、念のため [0,0.05] にクランプ。
    let dt = dtRaw;
    if (dt > 0.05) dt = 0.05; else if (dt < 0) dt = 0;
    fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;

    goalT += dt * 1000;
    if (goalT >= GOAL_MS) { goalT = 0; pickGoal(); repathAll(); } // ゴール移動→全再計算

    const ad = agentInst.data;
    for (let i = 0; i < count; i++) {
      const path = paths[i];
      if (pidx[i] < path.length) {
        const c = path[pidx[i]];
        const tx = cellX(c % GW), tz = cellZ((c / GW) | 0);
        const dx = tx - ax[i], dz = tz - az[i];
        const dist = Math.hypot(dx, dz);
        const step = SPEED * dt;
        if (dist < 1e-6) {                       // 既に到達（0除算回避＝NaN化防止）
          acell[i] = c; pidx[i]++;
        } else if (dist <= step) {
          ax[i] = tx; az[i] = tz; acell[i] = c; pidx[i]++;
        } else {
          ax[i] += (dx / dist) * step; az[i] += (dz / dist) * step;
          ayaw[i] = Math.atan2(dx, dz);          // 進行方向へ向ける
        }
      }
      // yaw(ラジアン) を Y 軸回りクォータニオンへ。
      const half = ayaw[i] * 0.5;
      const sy = Math.sin(half), cy = Math.cos(half);
      // createCone は原点中心（y=-1..+1）。底を y=0 に合わせるため +1.0 ずらす
      // （three.js版の geometry.translate(0,1.0,0) 相当）。
      writeMatrix(ad, i, ax[i], 1.0, az[i], 0, sy, 0, cy);
    }
    agentInst.vb.setData(ad);
    agentInst.meshInstance.instancingCount = count;

    updateHUD();
  });

  // ---- HUD ------------------------------------------------------------------
  const hud = document.getElementById("hud");
  let hudT = 0;
  function updateHUD() {
    if (++hudT % 6 !== 0) return;
    const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
    const draws = (dc.total != null ? dc.total : dc.forward) || 0;
    const tris = Math.round(agentTris * count);  // エージェント概算（壁/地面/ゴールは別途固定）
    hud.textContent =
      `FPS     ${fps.toFixed(1)}\n` +
      `Objects ${count}\n` +
      `Agents  ${count}\n` +
      `Repaths ${repaths.toLocaleString()}\n` +
      `Draws   ${draws}\n` +
      `Tris    ${tris.toLocaleString()}`;
  }

  app.start();
})();
