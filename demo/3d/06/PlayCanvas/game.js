// 3D テーマ6(T5) ― 動的シャドウ光源（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。柱64本の上を N 個のスポットライトが周回し、各光源が
// 1024 のシャドウマップを生成する。光源数が比較の主軸。three.js リファレンスに挙動を一致させる。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。
//
// 【最重要】classic script はグローバルの let/const レキシカルスコープを共有するため、
// トップレベルに `let t` 等の単一文字宣言を置くと PlayCanvas の minified グローバルと衝突し
// "Identifier 't' has already been declared" で起動失敗する（3d/05 PlayCanvas で実際に発生）。
// node --check では検出できずブラウザでのみ出るので、全体を IIFE で隔離する。
(function () {
  "use strict";

  // ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
  const W = 960, H = 540;
  const COLS = 8, PILLARS = COLS * COLS, GAP = 6;
  const L_INIT = 4, L_STEP = 2, L_MIN = 1, L_MAX = 12;
  const SHADOW_RES = 1024;
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
  // 弱い環境光（暗い青・低強度。影が真っ黒に潰れない程度）
  app.scene.ambientLight = new pc.Color(0x22 / 255, 0x30 / 255, 0x44 / 255).mulScalar(0.8);

  // ---- カメラ -----------------------------------------------------------------
  // 位置(0,28,40)/注視(0,2,0)/fov55/near0.5/far500。背景 clearColor #0a0c12。
  const camEntity = new pc.Entity("camera");
  camEntity.addComponent("camera", {
    fov: 55,
    nearClip: 0.5,
    farClip: 500,
    clearColor: new pc.Color(0x0a / 255, 0x0c / 255, 0x12 / 255),
  });
  camEntity.setPosition(0, 28, 40);
  camEntity.lookAt(0, 2, 0);
  app.root.addChild(camEntity);

  // ---- 共有マテリアル -----------------------------------------------------------
  // 地面: 中明度グレー、影を受ける。
  const groundMat = new pc.StandardMaterial();
  groundMat.diffuse = new pc.Color(0x55 / 255, 0x60 / 255, 0x6a / 255);
  groundMat.useMetalness = false;
  groundMat.gloss = 0;
  groundMat.update();

  // 柱: 明るめグレー、影を落とし受ける。
  const pillarMat = new pc.StandardMaterial();
  pillarMat.diffuse = new pc.Color(0xaa / 255, 0xb0 / 255, 0xb8 / 255);
  pillarMat.useMetalness = false;
  pillarMat.gloss = 0;
  pillarMat.update();

  // ---- 共有メッシュ（incRefCount で永続化＝破棄バグ対策） -----------------------
  // 地面: 大判 box（200x200、薄い厚み）。box の方が plane より法線・receive が安定。
  const groundMesh = pc.createBox(device, { halfExtents: new pc.Vec3(100, 0.5, 100) });
  groundMesh.incRefCount();
  // 柱: 断面 2x2、高さ1の単位 box（高さは Entity の localScale.y で表現）。
  const pillarMesh = pc.createBox(device, { halfExtents: new pc.Vec3(1, 0.5, 1) });
  pillarMesh.incRefCount();

  // ---- 地面 -------------------------------------------------------------------
  const ground = new pc.Entity("ground");
  ground.addComponent("render", {
    meshInstances: [new pc.MeshInstance(groundMesh, groundMat)],
    castShadows: false,
    receiveShadows: true,
  });
  ground.setPosition(0, -0.5, 0); // 上面を y=0 に
  app.root.addChild(ground);

  // ---- 柱（8x8=64本・mulberry32 で決定的・three.js版と同順） --------------------
  (function () {
    const rnd = mulberry32(SEED);
    for (let i = 0; i < PILLARS; i++) {
      const c = i % COLS, r = (i / COLS) | 0;
      const h = 3 + rnd() * 6; // 高さ 3〜9（three.js版と同じ消費順）
      const e = new pc.Entity("pillar" + i);
      e.addComponent("render", {
        meshInstances: [new pc.MeshInstance(pillarMesh, pillarMat)],
        castShadows: true,
        receiveShadows: true,
      });
      // 単位 box(高さ1) を h 倍。中心 y=h/2、間隔6・中心揃え。
      e.setLocalScale(1, h, 1);
      e.setPosition((c - 3.5) * GAP, h / 2, (r - 3.5) * GAP);
      app.root.addChild(e);
    }
  })();

  // ---- スポットライト（影あり）プール ----------------------------------------
  // PlayCanvas の spot は forward(-Z) が照射方向。lookAt(0,1,0) で中心を向ける。
  // three.js: SpotLight(0xffffff, 600, 120, 25deg, 0.4, 1.5) / 解像度1024 / bias -0.0005。
  const lights = []; // pc.Entity の配列
  function makeLight() {
    const e = new pc.Entity("spot");
    e.addComponent("light", {
      type: "spot",
      color: new pc.Color(1, 1, 1),
      intensity: 1.0,
      range: 120,
      innerConeAngle: 40,
      outerConeAngle: 50,           // スポット角 ≈ 50°
      castShadows: true,
      shadowResolution: SHADOW_RES, // 1024
      shadowType: pc.SHADOW_PCF3,   // PCF ソフト影
      shadowBias: 0.02,
      normalOffsetBias: 0.05,
    });
    // 注: spot のシャドウ視錐台 near/far は range と cone から自動算出される。
    // three.js の shadow.camera.far(90) に相当する shadowDistance は directional 専用のため指定不可。
    app.root.addChild(e);
    return e;
  }
  function setLightCount(n) {
    n = Math.max(L_MIN, Math.min(L_MAX, n | 0));
    while (lights.length < n) lights.push(makeLight());
    while (lights.length > n) {
      const e = lights.pop();
      e.destroy(); // light entity を作り直し（destroy→再生成）
    }
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
  const col = new pc.Color();
  let fps = 60, simT = 0;

  app.on("update", (dtRaw) => {
    let dt = dtRaw;
    if (dt > 0.05) dt = 0.05;                 // スパイク抑制
    fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
    simT += dt;

    const n = lights.length;
    for (let i = 0; i < n; i++) {
      const phi = (i * Math.PI * 2) / n;
      const a = simT * 0.4 + phi;
      const e = lights[i];
      // 高さ30/半径22/角速度0.4/位相 i*2π/N
      e.setPosition(22 * Math.cos(a), 30, 22 * Math.sin(a));
      e.lookAt(0, 1, 0); // spot の forward(-Z) を中心へ
      // 色: 色相 i/N（彩度高め・明るめ）。HSL→RGB。
      hslToColor(i / n, 0.85, 0.6, col);
      e.light.color = col;
    }

    updateHUD();
  });

  // HSL(0..1) → pc.Color。three.js Color.setHSL と同じ式。
  function hslToColor(h, s, l, out) {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    out.set(r, g, b);
    return out;
  }

  // ---- HUD --------------------------------------------------------------------
  // Objects=64（柱）、Lights=N、Draws=app.stats.drawCalls.total（シャドウパスも計上されうる）、
  // Tris は概算（柱面数×64 + 地面面数。注記参照）。数フレームに1回更新。
  const hud = document.getElementById("hud");
  let hudT = 0;
  const PILLAR_TRIS = pillarMesh.indexBuffer[0] ? pillarMesh.indexBuffer[0].numIndices / 3 : 12;
  const GROUND_TRIS = groundMesh.indexBuffer[0] ? groundMesh.indexBuffer[0].numIndices / 3 : 12;
  function updateHUD() {
    if (++hudT % 6 !== 0) return; // 数フレームに1回更新
    const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
    const draws = (dc.total != null ? dc.total : dc.forward) || 0;
    // Tris 概算: メインパスの幾何のみ（柱64 + 地面）。シャドウパス分は含めない近似。
    const tris = Math.round(PILLAR_TRIS * PILLARS + GROUND_TRIS);
    hud.textContent =
      `FPS    ${fps.toFixed(1)}\n` +
      `Objects ${PILLARS}\n` +
      `Lights ${lights.length}\n` +
      `Draws  ${draws}\n` +
      `Tris   ${tris.toLocaleString()}`;
  }

  // app.start() は全シーン構築後に呼ぶ（順序に注意）。
  app.start();
})();
