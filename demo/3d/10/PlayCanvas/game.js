// 3D テーマ10(T10) ― 大量レイキャスト（LIDAR スキャナ・PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。数値・挙動は three.js リファレンス実装に完全一致させる。
// 中心スキャナから毎フレーム N 本のレイを全方位へ放ち、M ターゲット(軸整列 box)との
// 最近交差を「自前のレイ-AABB(スラブ法)」で求め、当たり点をインスタンス描画する。レイ数が主軸。
//
// 【最重要】classic script のグローバル衝突を避けるため、全体を IIFE で包む。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。
(function () {
  "use strict";

  // ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
  const W = 960, H = 540;
  const M = 120, SHELL = 28, BOX = 4;
  const N_INIT = 1500, N_STEP = 1500, N_MIN = 500, N_MAX = 15000;
  const FAR = 200;
  const CAM_R = 55, CAM_Y = 20, CAM_W = 0.15;
  const GOLDEN = 2.399963229728653; // 黄金角
  const HALF = BOX / 2;             // 軸整列 AABB の半幅 = 2

  // ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） ----------------
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
  // 環境光: three 版 AmbientLight(0x8090a0, 0.7)
  app.scene.ambientLight = new pc.Color(0x80 / 255, 0x90 / 255, 0xa0 / 255).mulScalar(0.7);

  // ---- カメラ -----------------------------------------------------------------
  const camEntity = new pc.Entity("camera");
  camEntity.addComponent("camera", {
    fov: 55,                 // 垂直基準・度（SPEC: fov 55）
    nearClip: 0.5,
    farClip: 1000,
    clearColor: new pc.Color(0x05 / 255, 0x08 / 255, 0x0d / 255), // #05080d
  });
  app.root.addChild(camEntity);

  // ---- ライト（平行光1灯 + 環境光） -------------------------------------------
  // three 版: DirectionalLight position(0.4,1,0.5)。three の DirectionalLight は
  // 「position から原点(target)へ」向かう = 光の進行方向は -(0.4,1,0.5)。
  // PlayCanvas の directional はエンティティ forward(-Z) を光の進行方向とする。
  const sun = new pc.Entity("sun");
  sun.addComponent("light", {
    type: "directional",
    color: new pc.Color(1, 1, 1),
    intensity: 1.0,
    castShadows: false,
  });
  {
    // 光の進行方向 = (0,0,0) - (0.4,1,0.5) = -(0.4,1,0.5) を forward に向ける。
    const d = new pc.Vec3(-0.4, -1, -0.5).normalize();
    sun.setPosition(0, 0, 0);
    sun.lookAt(d.x, d.y, d.z);
  }
  app.root.addChild(sun);

  // ---- 共有: 行列計算用の一時オブジェクト -------------------------------------
  const tmpMat = new pc.Mat4();
  const tmpPos = new pc.Vec3();
  const tmpRot = new pc.Quat();
  const tmpScale = new pc.Vec3();
  const IDENT_Q = new pc.Quat(); // 単位回転

  // ---- ハードウェアインスタンシング用 ヘルパ（T1方式） ------------------------
  // per-instance の 4x4 行列を float32(16要素×count) で持つ VertexBuffer を作り、
  // MeshInstance.setInstancing で割り当てる。毎フレーム setData で更新する。
  function createInstancedRender(parentEntity, mesh, material, maxCount) {
    const meshInstance = new pc.MeshInstance(mesh, material);
    const format = pc.VertexFormat.getDefaultInstancingFormat(device);
    const vb = new pc.VertexBuffer(device, format, maxCount, {
      usage: pc.BUFFER_DYNAMIC,
    });
    meshInstance.setInstancing(vb);
    const data = new Float32Array(maxCount * 16);

    const entity = new pc.Entity();
    entity.addComponent("render", {
      meshInstances: [meshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    parentEntity.addChild(entity);

    return { meshInstance, vb, data, entity };
  }

  // ---- インスタンス行列を Float32Array に書き込む（列優先 = PlayCanvas Mat4） --
  function writeMatrix(data, idx, px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
    tmpPos.set(px, py, pz);
    tmpRot.set(qx, qy, qz, qw);
    tmpScale.set(sx, sy, sz);
    tmpMat.setTRS(tmpPos, tmpRot, tmpScale);
    data.set(tmpMat.data, idx * 16); // 列優先 16
  }

  // ---- メッシュ生成（プリミティブのみ・画像/GLB不使用） ------------------------
  // ターゲット: 一辺 BOX の box（中明度色, Lambert 相当）
  const boxMesh = pc.createBox(device, { halfExtents: new pc.Vec3(HALF, HALF, HALF) });
  const boxMat = new pc.StandardMaterial();
  boxMat.diffuse = new pc.Color(0x6d / 255, 0x8d / 255, 0xb0 / 255); // three: 0x6d8db0
  boxMat.useMetalness = false;
  boxMat.gloss = 0;
  boxMat.specular = new pc.Color(0, 0, 0);
  boxMat.update();

  // 当たり点マーカー: 半径 0.4 の小球（自発光・黄色 #ffd54a）
  const hitMesh = pc.createSphere(device, { radius: 0.4, latitudeBands: 5, longitudeBands: 6 });
  const hitMat = new pc.StandardMaterial();
  hitMat.diffuse = new pc.Color(0, 0, 0);
  hitMat.emissive = new pc.Color(1, 0xd5 / 255, 0x4a / 255); // #ffd54a
  hitMat.useLighting = false;
  hitMat.update();

  const targetInst = createInstancedRender(app.root, boxMesh, boxMat, M);
  const hitInst = createInstancedRender(app.root, hitMesh, hitMat, N_MAX);

  // ---- ターゲット（M個・半径28フィボナッチ球殻・軸整列 box・決定的） ----------
  // 位置を保持（AABB 中心 = この位置。AABB = center ± HALF, 軸整列）
  const tpx = new Float32Array(M), tpy = new Float32Array(M), tpz = new Float32Array(M);
  {
    const td = targetInst.data;
    for (let i = 0; i < M; i++) {
      const y = 1 - 2 * (i + 0.5) / M;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * GOLDEN;
      const x = Math.cos(th) * r * SHELL;
      const yy = y * SHELL;
      const z = Math.sin(th) * r * SHELL;
      tpx[i] = x; tpy[i] = yy; tpz[i] = z;
      // 軸整列（無回転）・スケール1（メッシュ自体が一辺 BOX）
      writeMatrix(td, i, x, yy, z, IDENT_Q.x, IDENT_Q.y, IDENT_Q.z, IDENT_Q.w, 1, 1, 1);
    }
    targetInst.vb.setData(td);
    targetInst.meshInstance.instancingCount = M;
  }

  // ---- スキャナ原点マーカー（自発光小球） -------------------------------------
  const scannerMesh = pc.createSphere(device, { radius: 0.8, latitudeBands: 8, longitudeBands: 12 });
  const scannerMat = new pc.StandardMaterial();
  scannerMat.diffuse = new pc.Color(0, 0, 0);
  scannerMat.emissive = new pc.Color(0x6c / 255, 1, 0x9a / 255); // #6cff9a
  scannerMat.useLighting = false;
  scannerMat.update();
  const scanner = new pc.Entity("scanner");
  scanner.addComponent("render", { meshInstances: [new pc.MeshInstance(scannerMesh, scannerMat)], castShadows: false });
  app.root.addChild(scanner);

  // ---- レイ方向（フィボナッチ球・決定的）。N 変更時に再構築 --------------------
  let count = N_INIT;
  let dirs = new Float32Array(0);
  function buildDirs(n) {
    dirs = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = 1 - 2 * (i + 0.5) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * GOLDEN;
      dirs[i * 3] = Math.cos(th) * r;
      dirs[i * 3 + 1] = y;
      dirs[i * 3 + 2] = Math.sin(th) * r;
    }
  }
  buildDirs(N_INIT);
  function setCount(n) { count = Math.max(N_MIN, Math.min(N_MAX, n | 0)); buildDirs(count); }

  // ---- 入力（three.js版と同じ素の addEventListener 実装） ----------------------
  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
    if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
    if (k === "r") setCount(N_INIT);
  });

  // ---- 自前 レイ-AABB（スラブ法）。最近交差 t を返す。なければ -1 -------------
  // AABB は軸整列で center ± HALF。dir は正規化済み前提。t は [0, FAR]。
  // 1/dir を渡して除算を省く。dir 成分が 0 のときは無限大として扱う（IEEE754 で自然）。
  function rayAABB(ox, oy, oz, idx, idy, idz, cx, cy, cz) {
    const minx = cx - HALF, maxx = cx + HALF;
    const miny = cy - HALF, maxy = cy + HALF;
    const minz = cz - HALF, maxz = cz + HALF;

    let t1 = (minx - ox) * idx, t2 = (maxx - ox) * idx;
    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);

    t1 = (miny - oy) * idy; t2 = (maxy - oy) * idy;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));

    t1 = (minz - oz) * idz; t2 = (maxz - oz) * idz;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));

    // 交差なし、または箱が背後
    if (tmax < Math.max(tmin, 0)) return -1;
    // origin が箱内なら tmin<0 → 0 を採用（前方の最初の当たり）
    return tmin >= 0 ? tmin : 0;
  }

  // ---- メインループ -----------------------------------------------------------
  let fps = 60, t = 0, hitCount = 0;

  app.on("update", (dtRaw) => {
    let dt = dtRaw;
    if (dt > 0.05) dt = 0.05; else if (dt < 0) dt = 0; // スパイク抑制（three 版と同条件）
    fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
    t += dt;

    // カメラ周回（決定的）
    const a = t * CAM_W;
    camEntity.setPosition(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
    camEntity.lookAt(0, 0, 0);

    // スキャナ原点（微小上下）＋ レイ全体をゆっくり Y 回転
    const ox = 0, oy = Math.sin(t * 0.7) * 2, oz = 0;
    scanner.setPosition(ox, oy, oz);
    const rot = t * 0.1, cs = Math.cos(rot), sn = Math.sin(rot);

    // レイキャスト（N × M スラブ法 ray-AABB, 最小 t を採用）
    hitCount = 0;
    const hd = hitInst.data;
    for (let i = 0; i < count; i++) {
      // 方向（Y回転を適用・three 版と同式）。フィボナッチ方向は単位長。
      const dx0 = dirs[i * 3], dy0 = dirs[i * 3 + 1], dz0 = dirs[i * 3 + 2];
      const dx = dx0 * cs - dz0 * sn;
      const dy = dy0;
      const dz = dx0 * sn + dz0 * cs;
      // 逆数（dir は単位長なので正規化不要）
      const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;

      let best = -1;
      for (let j = 0; j < M; j++) {
        const tt = rayAABB(ox, oy, oz, idx, idy, idz, tpx[j], tpy[j], tpz[j]);
        if (tt >= 0 && tt <= FAR && (best < 0 || tt < best)) best = tt;
      }
      if (best >= 0) {
        // 当たり点 = origin + dir * best
        const hx = ox + dx * best, hy = oy + dy * best, hz = oz + dz * best;
        writeMatrix(hd, hitCount, hx, hy, hz, IDENT_Q.x, IDENT_Q.y, IDENT_Q.z, IDENT_Q.w, 1, 1, 1);
        hitCount++;
      }
    }
    hitInst.vb.setData(hd);
    hitInst.meshInstance.instancingCount = hitCount;

    updateHUD();
  });

  // ---- HUD --------------------------------------------------------------------
  const hud = document.getElementById("hud");
  let hudT = 0;
  // 三角形数概算: box 12面 × M(可視は常に全数) + 小球面数 × hitCount + スキャナ
  const boxTris = boxMesh.indexBuffer[0] ? boxMesh.indexBuffer[0].numIndices / 3 : 12;
  const hitTris = hitMesh.indexBuffer[0] ? hitMesh.indexBuffer[0].numIndices / 3 : 0;
  function updateHUD() {
    if (++hudT % 6 !== 0) return; // 数フレームに1回更新
    const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
    const draws = (dc.total != null ? dc.total : dc.forward) || 0;
    const tris = Math.round(boxTris * M + hitTris * hitCount);
    hud.textContent =
      `FPS     ${fps.toFixed(1)}\n` +
      `Objects ${M}\n` +
      `Rays    ${count}\n` +
      `Hits    ${hitCount}\n` +
      `Draws   ${draws}\n` +
      `Tris    ${tris.toLocaleString()}`;
  }

  app.start();
})();
