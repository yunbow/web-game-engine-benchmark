// 3D テーマ3(T4) ― スキンドキャラ大群（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。ロジック（PRNG・配置・スケール算出・入力・カメラ・数値）は
// three.js リファレンス実装(../three.js/game.js)と挙動・順序を一致させてある。
// 比較主軸 = 共有 glTF を N 体複製し、各個体が独立スケルトン＋AnimationGroup を
// 毎フレーム更新するスループット。three.js の SkeletonUtils.clone + AnimationMixer に対し、
// Babylon は AssetContainer.instantiateModelsToScene で「独立スケルトン＋AnimationGroup」を複製する。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const GLB_ROOT = "../assets/", GLB_FILE = "CesiumMan.glb";
const N_INIT = 50, N_STEP = 25, N_MIN = 10, N_MAX = 1000;
const SPACING = 2.2, TARGET_H = 1.7;
const SEED = 0x9e3779b9 >>> 0;

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
// three.js 版とビット単位で同一。消費順序も同一（speed→phase）。
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
// WebGL2 既定（WebGPU 不使用）。スキニングは頂点シェーダ（GPU スキニング）で行われる。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// 注: 既定の左手系のまま。three.js は +Z 手前だが、本テーマはその場歩行のみで前後移動が無く、
// 全個体 +Z 同一向き・カメラ正面という見え方を一致させればよい。左手系のまま (0,12,26) から
// 原点を見れば three.js と同じ「正面やや上から見下ろす群衆」になる。
scene.clearColor = BABYLON.Color4.FromHexString("#10131aff");

// 透視投影カメラ（固定・デフォルト操作なし）。fov は垂直50°。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 12, 26), scene);
camera.fov = 50 * Math.PI / 180;     // 垂直 FOV（FOVMODE_VERTICAL_FIXED 既定）
camera.minZ = 0.1;
camera.maxZ = 2000;
camera.setTarget(new BABYLON.Vector3(0, 1.5, 0));
// attachControl は呼ばない＝完全固定カメラ。

// ライト: 環境光相当の Hemispheric + 平行光1灯（上方やや手前）。影は無し。
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#8899bb");
hemi.groundColor = BABYLON.Color3.FromHexString("#404a5a");
hemi.intensity = 0.8;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.4, -1, -0.6).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.1;

// 地面: 大判 ground（暗色）。y=0。
const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 400, height: 400 }, scene);
const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
groundMat.diffuseColor = BABYLON.Color3.FromHexString("#1b2030");
groundMat.specularColor = new BABYLON.Color3(0, 0, 0);
ground.material = groundMat;

// ---- 状態 -------------------------------------------------------------------
let count = N_INIT, fps = 60, last = performance.now(), hudT = 0, tAccum = 0;
let container = null;            // AssetContainer（共有グラフ。複製元）
let modelScale = 1, footOffset = 0, charTris = 0, fallback = false;
const crowd = [];                // { root, groups, mat?, speed, phase, baseY }

// ---- グリッド配置（three.js 版と同一式） ------------------------------------
function placeAt(node, i, n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const c = i % cols, r = Math.floor(i / cols);
  node.position.set(
    (c - (cols - 1) / 2) * SPACING,
    footOffset,
    (r - (rows - 1) / 2) * SPACING
  );
}

// ---- 群衆構築 ---------------------------------------------------------------
function clearCrowd() {
  for (const e of crowd) {
    if (e.groups) for (const g of e.groups) g.dispose();   // AnimationGroup を破棄
    if (e.root) e.root.dispose(false, true);               // 子メッシュ・スケルトンごと破棄
    if (e.mat) e.mat.dispose();
  }
  crowd.length = 0;
}

function buildCrowd(n) {
  clearCrowd();
  const rnd = mulberry32(SEED);
  for (let i = 0; i < n; i++) {
    const speed = 0.8 + rnd() * 0.4;        // timeScale [0.8,1.2]（= speedRatio）
    const phase = rnd();                     // 開始位相 [0,1)

    if (!fallback) {
      // 独立複製: メッシュ＋スケルトン＋AnimationGroup が個体ごとに新規生成される。
      // これが three.js の SkeletonUtils.clone + 個別 AnimationMixer に対応する負荷の主役。
      const entries = container.instantiateModelsToScene(
        (src) => `c${i}_${src}`,   // 命名（任意）
        false                      // cloneMaterials=false（マテリアルは共有でよい）
      );
      const root = entries.rootNodes[0];
      root.scaling.set(modelScale, modelScale, modelScale);
      placeAt(root, i, n);

      const groups = entries.animationGroups;
      const g = groups[0];
      if (g) {
        // ループ再生・speedRatio=個体速度。start(loop, speedRatio, from, to)。
        g.start(true, speed, g.from, g.to);
        // 開始位相: クリップ長(from..to フレーム)に phase を掛けたフレームへ移動（ベストエフォート）。
        const f = g.from + (g.to - g.from) * phase;
        g.goToFrame(f);
      }
      crowd.push({ root, groups, speed, phase, baseY: footOffset });
    } else {
      // フォールバック: 上下に弾むカプセル（スキニング無し）。同数・同配置でアニメ。
      const root = BABYLON.MeshBuilder.CreateCapsule("fb" + i, {
        radius: 0.4, height: 1.8, tessellation: 8, subdivisions: 1
      }, scene);
      const mat = new BABYLON.StandardMaterial("fbMat" + i, scene);
      mat.diffuseColor = BABYLON.Color3.FromHexString("#8ab4ff");
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      root.material = mat;
      placeAt(root, i, n);
      crowd.push({ root, groups: null, mat, speed: speed * 3, phase: phase * Math.PI * 2, baseY: footOffset });
    }
  }
  count = n;
}

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") rebuild(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") rebuild(count - N_STEP);
  if (k === "r") rebuild(count);
});
function rebuild(n) { buildCrowd(Math.max(N_MIN, Math.min(N_MAX, n | 0))); }

// ---- メインループ -----------------------------------------------------------
function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  tAccum += dt;

  // 非フォールバック時: アニメは AnimationGroup が scene.render 内で自動更新される
  //（各個体が独立スケルトンを毎フレーム評価する＝負荷の主役）。手動更新は不要。
  if (fallback) {
    for (const e of crowd) {
      e.root.position.y = e.baseY + Math.max(0, Math.sin(tAccum * e.speed + e.phase)) * 0.4;
    }
  }

  scene.render();
  updateHUD();
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// draw call は SceneInstrumentation から取得（ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
// drawCallsCounter は既定で有効。

function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回（描画負荷の測定を阻害しない）
  const draws = instrumentation.drawCallsCounter.current;
  // Tris: 概算（キャラ1体の三角形数 × N + 地面2三角）。three.js は renderer.info の実測だが、
  // Babylon では概算で代替（SPEC 注記どおり可）。
  const tris = charTris * count + 2;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${count}\n` +
    `Chars   ${count}${fallback ? " (fallback: no skin)" : ""}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}`;
}

// ---- glTF ロード → 起動 -----------------------------------------------------
// AssetContainer で 1 回だけロードし、各キャラは instantiateModelsToScene で複製する。
BABYLON.SceneLoader.LoadAssetContainer(
  GLB_ROOT, GLB_FILE, scene,
  (loaded) => {
    container = loaded;
    // 複製されたメッシュがシーンに出ないよう、元コンテナはシーンに add しない
    //（LoadAssetContainer は既定でシーンに追加しない）。

    // 身長 TARGET_H に合わせる統一スケールと接地オフセットを算出。
    // コンテナのメッシュ階層のワールド境界から求める（three.js の Box3.setFromObject 相当）。
    let min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
    let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
    let found = false, tri = 0;
    for (const m of container.meshes) {
      if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      const wmin = bb.minimumWorld, wmax = bb.maximumWorld;
      min = BABYLON.Vector3.Minimize(min, wmin);
      max = BABYLON.Vector3.Maximize(max, wmax);
      found = true;
      const idx = m.getTotalIndices ? m.getTotalIndices() : 0;
      tri += idx > 0 ? (idx / 3) : 0;
    }
    const h = (found ? (max.y - min.y) : 1) || 1;
    modelScale = TARGET_H / h;
    footOffset = (found ? -min.y : 0) * modelScale;   // 接地オフセット
    charTris = Math.round(tri);

    buildCrowd(N_INIT);
    engine.runRenderLoop(frame);
  },
  null,
  (_scene, message, _exception) => {
    // GLB 読込失敗 → 図形フォールバックで必ず起動。
    console.warn("glTF load failed, using primitive fallback:", message);
    fallback = true;
    footOffset = 1.0;
    charTris = 0;
    buildCrowd(N_INIT);
    engine.runRenderLoop(frame);
  }
);

addEventListener("resize", () => engine.resize());
