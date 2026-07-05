// 3D テーマ8(T8) ― PBR マテリアル + ポストプロセス(Bloom)（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装に数値・挙動を完全一致させる。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD, v2.7.x) から読み込む。
//
// 【最重要】classic script のグローバル let/const 衝突（"Identifier 't' has already
// been declared" 等。3d/05 で実際に発生し node --check では検出されない）を避けるため、
// ファイル全体を IIFE で隔離する。
(function () {
  "use strict";

  // ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
  var W = 960, H = 540;
  var N_INIT = 200, N_STEP = 100, N_MIN = 50, N_MAX = 2000;
  var R = 0.7, SP = 2.2;
  var CAM_R = 30, CAM_Y = 8, CAM_W = 0.2;
  var SEED = 0x9e3779b9 >>> 0;
  var ENV_URL = "../assets/env_equirect.png"; // 任意。無ければ ambient + 2平行光フォールバック

  // ---- 決定的疑似乱数（mulberry32, Math.random 不使用）。three.js 版と同順で消費 ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // HSL → RGB（three.js Color.setHSL と同じ式。s/l は 0..1）-----------------------
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  function hslColor(h, s, l) {
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return new pc.Color(r, g, b);
  }

  // ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） ----------------
  var canvas = document.getElementById("app");
  var app = new pc.Application(canvas, {
    graphicsDeviceOptions: {
      deviceTypes: [pc.DEVICETYPE_WEBGL2], // WebGL2 を明示（WebGPU は使わない）
      antialias: true,
      alpha: false,
    },
  });
  var device = app.graphicsDevice;
  // 960x540 固定解像度
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);

  // 環境光（フォールバック時の弱い ambient。env が読めたら控えめに上書きされる）。
  app.scene.ambientLight = new pc.Color(0x40 / 255, 0x4a / 255, 0x5a / 255).mulScalar(0.35);

  // ---- カメラ -----------------------------------------------------------------
  var camEntity = new pc.Entity("camera");
  camEntity.addComponent("camera", {
    fov: 50,                 // 垂直基準・度（SPEC: fov 50）
    nearClip: 0.1,
    farClip: 1000,
    clearColor: new pc.Color(0x1a / 255, 0x1f / 255, 0x2a / 255), // #1a1f2a
  });
  app.root.addChild(camEntity);

  // ---- ポストプロセス（Bloom） + トーンマッピング(ACES) ------------------------
  // PlayCanvas 2.x は pc.CameraFrame（RenderPassCameraFrame を内包）で SSAO/Bloom/
  // ToneMapping/Grading 等を engine-only で統合できる。bloom.intensity>0 で有効化、
  // rendering.toneMapping=TONEMAP_ACES で ACES Filmic。変更後は update() が必須。
  var bloomEnabled = false;
  var cameraFrame = null;
  try {
    if (pc.CameraFrame) {
      cameraFrame = new pc.CameraFrame(app, camEntity.camera);
      cameraFrame.rendering.toneMapping = pc.TONEMAP_ACES; // ACES Filmic（SPEC）
      cameraFrame.rendering.samples = 4;                   // MSAA（FXAA 代替の簡易AA）
      cameraFrame.bloom.intensity = 0.04; // 発光部のみ滲ませる控えめな強度
      cameraFrame.bloom.blurLevel = 16;
      cameraFrame.update();
      bloomEnabled = true;
    }
  } catch (e) {
    // CameraFrame が利用できない環境では擬似グロー（emissive 球の明るさ）にとどめる。
    cameraFrame = null;
    bloomEnabled = false;
  }
  if (!bloomEnabled) {
    // フォールバック: せめてカメラ単体で ACES トーンマップを掛ける（あれば）。
    if (pc.TONEMAP_ACES != null && "toneMapping" in camEntity.camera) {
      try { camEntity.camera.toneMapping = pc.TONEMAP_ACES; } catch (e2) {}
    }
  }

  // ---- 直接光（金属ハイライト用。平行光2灯 + 弱い ambient） ---------------------
  // PlayCanvas の directional はエンティティの forward(-Z) を光の進行方向とする。
  // three.js 版は light.position を「光源位置」に置き原点側を照らす（向き = -position）。
  // 同じ見えにするため forward を -position 方向へ向ける。
  function addDirLight(name, color, intensity, px, py, pz) {
    var e = new pc.Entity(name);
    e.addComponent("light", {
      type: "directional",
      color: color,
      intensity: intensity,
      castShadows: false,
    });
    e.setPosition(0, 0, 0);
    e.lookAt(-px, -py, -pz); // 光源(px,py,pz)から原点を照らす向き
    app.root.addChild(e);
    return e;
  }
  addDirLight("d1", new pc.Color(1, 1, 1), 1.0, 1, 1, 0.6);
  addDirLight("d2", new pc.Color(1, 0xd9 / 255, 0xa8 / 255), 0.6, -0.8, 0.5, -0.6);

  // ---- 環境（反射）: 任意 equirect → 無ければ ambient フォールバック -------------
  // env が読めたら envAtlas に変換して PBR 反射に使い、ambient を控えめに戻す。
  var noteEl = document.getElementById("note");
  (function loadEnv() {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      try {
        // equirect Texture を生成
        var src = new pc.Texture(device, {
          width: img.width,
          height: img.height,
          format: pc.PIXELFORMAT_R8_G8_B8_A8,
          mipmaps: false,
          projection: pc.TEXTUREPROJECTION_EQUIRECT,
          addressU: pc.ADDRESS_CLAMP_TO_EDGE,
          addressV: pc.ADDRESS_CLAMP_TO_EDGE,
        });
        src.setSource(img);
        // equirect → envAtlas（プレフィルタ済み反射用アトラス）
        var atlas = pc.EnvLighting.generateAtlas(src, {});
        app.scene.envAtlas = atlas;
        app.scene.skyboxIntensity = 0.5; // 反射控えめ（白飛び防止）
        // 環境反射が出るので ambient は弱める
        app.scene.ambientLight = new pc.Color(0x20 / 255, 0x26 / 255, 0x30 / 255);
        noteEl.textContent = bloomEnabled
          ? "PBR + post: StandardMaterial(metalness) + bloom (env_equirect.png)"
          : "PBR + post: StandardMaterial(metalness) + emissive glow (no bloom, env_equirect.png)";
      } catch (e) {
        // 変換失敗時はフォールバックのまま
      }
    };
    img.onerror = function () { /* 未配置 → ambient フォールバックのまま起動 */ };
    img.src = ENV_URL;
  })();

  // ---- PBR 球 -----------------------------------------------------------------
  // 共有球メッシュ（半径 0.7）。three.js の SphereGeometry(0.7,24,16) 相当に分割を合わせる。
  var sphereMesh = pc.createSphere(device, { radius: R, latitudeBands: 16, longitudeBands: 24 });
  // 共有メッシュを永続化（球 Entity を作り直しても破棄されないよう参照カウントを増やす）。
  if (sphereMesh.incRefCount) sphereMesh.incRefCount();

  var triPerSphere = (sphereMesh.indexBuffer && sphereMesh.indexBuffer[0])
    ? sphereMesh.indexBuffer[0].numIndices / 3 : 0;

  var sphereParent = new pc.Entity("spheres");
  app.root.addChild(sphereParent);
  var spheres = [];
  var count = N_INIT;

  function clearSpheres() {
    for (var i = 0; i < spheres.length; i++) {
      var ent = spheres[i];
      // マテリアルを破棄（球ごとに固有マテリアル）
      var mi = ent.render && ent.render.meshInstances;
      if (mi && mi[0] && mi[0].material && mi[0].material.destroy) mi[0].material.destroy();
      ent.destroy();
    }
    spheres = [];
  }

  function buildSpheres(n) {
    clearSpheres();
    var rnd = mulberry32(SEED);
    var k = Math.ceil(Math.cbrt(n));
    var half = (k - 1) / 2;
    for (var i = 0; i < n; i++) {
      var ix = i % k, iy = ((i / k) | 0) % k, iz = (i / (k * k)) | 0;
      // three.js 版と同順で rnd を消費（決定的一致）:
      //   metalness = rnd()<0.5 ? 1.0 : rnd()
      //   roughness = 0.05 + rnd()*0.95
      //   color HSL  = setHSL(rnd(),0.7,0.5)
      //   emissiveOn = rnd()<0.15
      //   emissive   = setHSL(rnd(),0.9,0.6) （emissiveOn のときのみ）
      var metalness = rnd() < 0.5 ? 1.0 : rnd();
      var roughness = 0.05 + rnd() * 0.95;
      var col = hslColor(rnd(), 0.7, 0.5);
      var emissiveOn = rnd() < 0.15;
      var emCol = emissiveOn ? hslColor(rnd(), 0.9, 0.6) : null;

      var mat = new pc.StandardMaterial();
      mat.useMetalness = true;          // 物理ベース（metalness ワークフロー）
      mat.diffuse = col;                // ベース色（金属時は反射色になる）
      mat.metalness = metalness;
      // PlayCanvas は gloss(0..1)。three.js roughness の逆。
      mat.gloss = 1.0 - roughness;
      mat.useMetalnessSpecularColor = false;
      if (emissiveOn) {
        mat.emissive = emCol;
        mat.emissiveIntensity = 2.0;    // Bloom 用に高め（three.js と同値）
      } else {
        mat.emissive = new pc.Color(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
      mat.update();

      var ent = new pc.Entity();
      ent.addComponent("render", {
        meshInstances: [new pc.MeshInstance(sphereMesh, mat)],
        castShadows: false,
        receiveShadows: false,
      });
      ent.setLocalPosition((ix - half) * SP, (iy - half) * SP, (iz - half) * SP);
      sphereParent.addChild(ent);
      spheres.push(ent);
    }
    count = n;
  }
  buildSpheres(N_INIT);

  // ---- 入力 -------------------------------------------------------------------
  addEventListener("keydown", function (e) {
    var k = e.key.toLowerCase();
    if (k === "+" || k === "=" || k === "]") buildSpheres(Math.min(N_MAX, count + N_STEP));
    if (k === "-" || k === "_" || k === "[") buildSpheres(Math.max(N_MIN, count - N_STEP));
    if (k === "r") buildSpheres(N_INIT);
  });

  // ---- メインループ -----------------------------------------------------------
  var fps = 60, t = 0;
  app.on("update", function (dtRaw) {
    var dt = dtRaw;
    if (dt > 0.05) dt = 0.05; // スパイク抑制
    fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
    t += dt;

    // カメラ自動周回（決定的・時間ベース）: 半径30 / 高さ8 / 角速度0.2
    var a = t * CAM_W;
    camEntity.setPosition(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
    camEntity.lookAt(0, 0, 0);

    updateHUD();
  });

  // ---- HUD --------------------------------------------------------------------
  var hud = document.getElementById("hud");
  var hudT = 0;
  function updateHUD() {
    hudT++;
    if (hudT % 6 !== 0) return; // 数フレームに1回更新
    // Draws: v2 系は app.stats.drawCalls.total が正。
    var dc = (app.stats && app.stats.drawCalls) || {};
    var draws = (dc.total != null ? dc.total : dc.forward) || 0;
    // Tris は概算（共有球面数 × 球数）。Bloom/MSAA の追加パスは含めない。
    var tris = Math.round(triPerSphere * count);
    hud.textContent =
      "FPS     " + fps.toFixed(1) + "\n" +
      "Objects " + count + "\n" +
      "Spheres " + count + "\n" +
      "Draws   " + draws + "\n" +
      "Tris    " + tris.toLocaleString() + "\n" +
      "Post    " + (bloomEnabled ? "bloom" : "none");
  }

  app.start();
})();
