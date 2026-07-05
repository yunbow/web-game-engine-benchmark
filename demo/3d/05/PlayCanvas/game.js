// IIFE で全体を隔離。classic script はグローバルの let/const レキシカルスコープを共有するため、
// トップレベルの `let t` 等が PlayCanvas エンジンの単一文字グローバルと衝突し
// "Identifier 't' has already been declared" になる。関数スコープに閉じて回避する。
(function () {
// 3D テーマ5(T2) ― 広域地形 + カリング/LOD/描画距離（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。数値・挙動は three.js リファレンス実装に完全一致させる。
// 10000本の木を飛行カメラで周回し、距離カリング＋2段LOD＋エンジン自動フラスタムカリングで
// 可視ぶんのみ描画する。グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読む。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const GRID = 100, SP = 8;                       // 100x100=10000本, 間隔8
const DD_INIT = 120, DD_STEP = 40, DD_MIN = 40, DD_MAX = 360;
const CAM_R = 140, CAM_Y = 26, CAM_W = 0.15;    // 周回半径/高さ/角速度
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
    deviceTypes: [pc.DEVICETYPE_WEBGL2],  // WebGL2 を明示（WebGPU は使わない）
    antialias: true,
    alpha: false,
  },
});
const device = app.graphicsDevice;
function applyRepeatingTexture(material, path, tilingX, tilingY) {
  const texture = new pc.Texture(device, {
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
  });
  const image = new Image();
  image.onload = () => {
    texture.setSource(image);
    material.diffuseMap = texture;
    material.diffuseMapTiling = new pc.Vec2(tilingX, tilingY);
    material.update();
  };
  image.src = path;
  return texture;
}
// 960x540 固定解像度
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);

// 環境光（空色寄りのうっすら明）。clearColor はカメラ側で空色 #8fb8e6。
app.scene.ambientLight = new pc.Color(0xbc / 255, 0xc8 / 255, 0xd8 / 255).mulScalar(0.8);

// フォグ（three.js版: Fog(0x8fb8e6, 80, 400) と一致）
app.scene.fog = pc.FOG_LINEAR;
app.scene.fogColor = new pc.Color(0x8f / 255, 0xb8 / 255, 0xe6 / 255);
app.scene.fogStart = 80;
app.scene.fogEnd = 400;

// ---- カメラ（fov60 / near0.5 / far1200・clearColor 空色） --------------------
const camEntity = new pc.Entity("camera");
camEntity.addComponent("camera", {
  fov: 60,
  nearClip: 0.5,
  farClip: 1200,
  clearColor: new pc.Color(0x8f / 255, 0xb8 / 255, 0xe6 / 255),
});
app.root.addChild(camEntity);

// ---- ライト（平行光 + 環境光） ----------------------------------------------
const sun = new pc.Entity("sun");
sun.addComponent("light", {
  type: "directional",
  color: new pc.Color(1, 1, 1),
  intensity: 1.0,
  castShadows: false,
});
// three.js版の sun.position(0.5,1,0.3) は「光源が上方やや手前」。
// PlayCanvas の directional は forward(-Z) が光の進む向き。光が下向きに差すよう、
// 進行方向 (-0.5,-1,-0.3) を forward に向ける。
{
  const dir = new pc.Vec3(-0.5, -1, -0.3).normalize();
  sun.setPosition(0, 0, 0);
  sun.lookAt(dir.x, dir.y, dir.z);
}
app.root.addChild(sun);

// ---- 地面（大判 box・暗緑。three.js版は 900x900 plane） ---------------------
const groundMat = new pc.StandardMaterial();
groundMat.diffuse = new pc.Color(0x24 / 255, 0x40 / 255, 0x2a / 255);
groundMat.useMetalness = false;
groundMat.gloss = 0;
applyRepeatingTexture(groundMat, "../assets/ground_forest_texture.png", 30, 30);
groundMat.update();
const ground = new pc.Entity("ground");
ground.addComponent("render", {
  type: "box",
  material: groundMat,
  castShadows: false,
  receiveShadows: false,
});
// box は 1x1x1。XZ=900、薄い厚みにして上面を y=0 に揃える。
ground.setLocalScale(900, 1, 900);
ground.setPosition(0, -0.5, 0);
app.root.addChild(ground);

// ---- 共有メッシュ / マテリアル（全木で同じ pc.Mesh を共有） ------------------
// three.js版のジオメトリに合わせる:
//  trunk  : Cylinder(r0.4/0.5, h2, 6分割) を +Y へ1ずらし → 幹底 y=0
//  foliage: Cone(r1.7, h4, 8分割) を +Y へ4ずらし
//  lowcone: Cone(r1.7, h6, 4分割) を +Y へ3ずらし（LOD1: 単一低ポリ）
// PlayCanvas の createCylinder/createCone は原点中心生成のため、子 Entity の
// ローカル位置で「+高さ/2」ずらして底を合わせる（メッシュ自体は移動できないため）。
const trunkMesh = pc.createCylinder(device, { radius: 0.45, height: 2, capSegments: 6 });
const foliageMesh = pc.createCone(device, { baseRadius: 1.7, peakRadius: 0, height: 4, capSegments: 8 });
const lowMesh = pc.createCone(device, { baseRadius: 1.7, peakRadius: 0, height: 6, capSegments: 4 });

// 共有メッシュは木10000本で使い回す。Entity 破棄時の参照カウント0破棄を防ぐため
// 参照カウントを永続化（T3 で踏んだ共有メッシュ破棄バグ対策）。
for (const m of [trunkMesh, foliageMesh, lowMesh]) if (m.incRefCount) m.incRefCount();

const trunkMat = new pc.StandardMaterial();
trunkMat.diffuse = new pc.Color(0x8a / 255, 0x63 / 255, 0x3c / 255);
applyRepeatingTexture(trunkMat, "../assets/tree_bark_texture.png", 1, 2);
trunkMat.gloss = 0; trunkMat.useMetalness = false; trunkMat.update();
const foliageMat = new pc.StandardMaterial();
foliageMat.diffuse = new pc.Color(0x4d / 255, 0x8f / 255, 0x4a / 255);
applyRepeatingTexture(foliageMat, "../assets/tree_foliage_texture.png", 2, 2);
foliageMat.gloss = 0; foliageMat.useMetalness = false; foliageMat.update();
const lowMat = new pc.StandardMaterial();
lowMat.diffuse = new pc.Color(0x4b / 255, 0x88 / 255, 0x48 / 255);
applyRepeatingTexture(lowMat, "../assets/tree_foliage_texture.png", 2, 2);
lowMat.gloss = 0; lowMat.useMetalness = false; lowMat.update();

// 各 LOD 用の MeshInstance を作るヘルパ。共有 pc.Mesh をそのまま渡す。
function makeRenderEntity(mesh, material, yOffset) {
  const mi = new pc.MeshInstance(mesh, material);
  const e = new pc.Entity();
  e.addComponent("render", {
    meshInstances: [mi],
    castShadows: false,
    receiveShadows: false,
  });
  e.setLocalPosition(0, yOffset, 0); // 円柱/円錐の底を親原点(=y0)へ合わせる
  return e;
}

// ---- 木を生成（共有メッシュ参照・10000本） ----------------------------------
// 各木 = 親 Entity。子に LOD0(幹+葉) と LOD1(低ポリコーン)。
const trees = [];   // { obj, lod0, lod1, x, z }
function buildForest() {
  const rnd = mulberry32(SEED);
  for (let i = 0; i < GRID * GRID; i++) {
    const c = i % GRID, r = (i / GRID) | 0;
    const x = (c - (GRID - 1) / 2) * SP;
    const z = (r - (GRID - 1) / 2) * SP;
    const hf = 0.8 + rnd() * 0.6;        // 高さ係数（three.js版と同順で消費）
    const ry = rnd() * Math.PI * 2;      // Y回転

    // LOD0: 幹 + 葉（中心揃え→子ローカルで底合わせ）
    const lod0 = new pc.Entity();
    lod0.addChild(makeRenderEntity(trunkMesh, trunkMat, 1));   // 幹: 中心h2→+1で底y0・頂y2
    lod0.addChild(makeRenderEntity(foliageMesh, foliageMat, 4)); // 葉: 中心h4→+4で底y2・頂y6（three版translate(0,4)一致）
    // LOD1: 単一低ポリコーン
    const lod1 = makeRenderEntity(lowMesh, lowMat, 3);          // 円錐 h6 → 底 y0、頂点 y6

    const obj = new pc.Entity();
    obj.addChild(lod0);
    obj.addChild(lod1);
    obj.setPosition(x, 0, z);
    obj.setLocalEulerAngles(0, ry * pc.math.RAD_TO_DEG, 0);
    obj.setLocalScale(1, hf, 1);         // 高さ方向のみスケール（幹底固定）
    obj.enabled = false;                 // 初期は非表示
    app.root.addChild(obj);
    trees.push({ obj, lod0, lod1, x, z });
  }
}
buildForest();

// ---- 状態 / 入力 ------------------------------------------------------------
let drawDist = DD_INIT, fps = 60, inRange = 0;
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") drawDist = Math.min(DD_MAX, drawDist + DD_STEP);
  if (k === "-" || k === "_" || k === "[") drawDist = Math.max(DD_MIN, drawDist - DD_STEP);
  if (k === "r") drawDist = DD_INIT;
});

// ---- メインループ -----------------------------------------------------------
let t = 0;
app.on("update", (dtRaw) => {
  let dt = dtRaw;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  // カメラ自動周回飛行（SPEC: θ=t*0.15）
  const th = t * CAM_W;
  const cx = CAM_R * Math.cos(th), cz = CAM_R * Math.sin(th);
  camEntity.setPosition(cx, CAM_Y, cz);
  camEntity.lookAt(CAM_R * 0.4 * Math.cos(th), 2, CAM_R * 0.4 * Math.sin(th));

  // 距離カリング + LOD（アプリ側）。視錐台カリングは PlayCanvas が MeshInstance.cull で自動。
  const dd2 = drawDist * drawDist;
  const lod2 = (drawDist * 0.5) * (drawDist * 0.5);
  inRange = 0;
  for (let i = 0; i < trees.length; i++) {
    const tr = trees[i];
    const dx = tr.x - cx, dz = tr.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > dd2) { tr.obj.enabled = false; continue; }
    tr.obj.enabled = true; inRange++;
    const near = d2 <= lod2;
    tr.lod0.enabled = near; tr.lod1.enabled = !near;
  }

  updateHUD();
});

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
let hudT = 0;
// 概算三角形数: 表示中の木の LOD ごとの面数を毎フレームの判定で積算するのは重いので、
// HUD 更新時にメッシュ面数から概算する（注記）。
// trunk(6分割円柱)/foliage(8分割円錐)/low(4分割円錐) の indexCount から三角形数を得る。
function meshTris(mesh) {
  const ib = mesh.indexBuffer && mesh.indexBuffer[0];
  return ib ? ib.numIndices / 3 : 0;
}
const TRUNK_TRIS = meshTris(trunkMesh);
const FOLIAGE_TRIS = meshTris(foliageMesh);
const LOW_TRIS = meshTris(lowMesh);

function updateHUD() {
  if (++hudT % 6 !== 0) return;           // 数フレームに1回更新

  // Draws: PlayCanvas v2 系は app.stats.drawCalls.total が正（フラスタムカリング後の実描画）。
  const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
  const draws = (dc.total != null ? dc.total : dc.forward) || 0;

  // Tris 概算: InRange の木の LOD 内訳を取り直すのは高コストのため、
  // InRange 全数を LOD0(幹+葉) とみなした上限概算（注記: 距離分布で実値はこれ以下）。
  const tris = Math.round(inRange * (TRUNK_TRIS + FOLIAGE_TRIS));

  hud.textContent =
    `FPS      ${fps.toFixed(1)}\n` +
    `Objects  ${inRange}\n` +
    `DrawDist ${drawDist}\n` +
    `Draws    ${draws}\n` +
    `Tris     ${tris.toLocaleString()}`;
}

// 木の生成・初期カリングを終えてから描画開始。
app.start();
})();
