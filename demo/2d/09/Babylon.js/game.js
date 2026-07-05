"use strict";

/* =========================================================================
 * テーマ9: アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― Babylon.js 版
 *
 * 3Dエンジン Babylon.js で 2D アイソメトリックシーンを実装する。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を px 等倍で再現。
 *  - アイソメ投影は SPEC の式: screenX=(gx-gy)*TILE_W/2, screenY=(gx+gy)*TILE_H/2。
 *  - 深度キー = gx+gy。値が小さいほど奥(先に描く)、大きいほど手前(後に描く)。
 *  - カメラスクロールは ortho 窓を画面オフセット分だけ平行移動して表現する。
 *  - 2層方式: (1)地面タイル=高さ0で重ならないのでソート不要・カリングのみ /
 *             (2)木・家・ユニット=背が高く前後が入れ替わるので可視分のみ gx+gy で毎フレーム再ソート。
 *  - 物理は使わず、ユニットの決定的徘徊(40px/s・水回避)を自前実装する。
 *  - テクスチャがあれば Sprite、無ければ単色 Plane/Disc にフォールバックして必ず起動する。
 *
 * ★ Babylon の深度順について（本テーマの肝）★
 *  Babylon の Sprite は同一 SpriteManager 内で「描画リストへ追加された順」に近い順序で描かれ、
 *  画面 y で自動深度ソートはしてくれない。そこで本実装では:
 *    - 可視のオブジェクト(木/家/ユニット)を毎フレーム配列へ集めて gx+gy 昇順にソートし、
 *    - ソート順に沿って position.z を「奥(小さい depth)=大きい z（カメラから遠い）→
 *      手前(大きい depth)=小さい z（カメラに近い）」と単調に割り当てる。
 *    - 正射影でも z は深度テスト(depthBuffer)に効くため、z を painter 順に並べれば
 *      Sprite/Mesh いずれでも正しい前後遮蔽になる。地面は z=GROUND_Z 固定の最奥に置く。
 *  → 「可視オブジェクトを gx+gy でソートして z を単調割り当て」これが Babylon での深度実現方法。
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;

const TILE_W = 64;            // アイソメ菱形の幅
const TILE_H = 32;            // アイソメ菱形の高さ
const HW = TILE_W / 2;        // 32
const HH = TILE_H / 2;        // 16

const MAP_N = 64;             // 64x64 タイル

// 地面種別
const G_GRASS = 0, G_SOIL = 1, G_WATER = 2;

// 静的オブジェクト種別
const O_TREE = 0, O_HOUSE = 1;

// ユニット (負荷)
const INITIAL_UNITS = 60;
const UNIT_STEP = 20;
const MIN_UNITS = 0;
const MAX_UNITS = 2000;
const UNIT_SPEED = 40 / TILE_H; // 40 px/s 相当。連続グリッド座標へ換算 (画面 y は gx+gy で TILE_H/タイル)
                                // → 1タイル進む画面移動は概ね TILE_H。grid速度 ≒ 40/32 ≒ 1.25 tile/s。
const UNIT_RADIUS = 10;        // 描画/接近判定半径(px)

// カメラスクロール速度 (px/s)
const SCROLL_SPEED = 420;

/* ---------- 深度(z)割り当て範囲 ----------
 * 正射影カメラは position.z=-100, minZ=0.1, maxZ=1000。z が大きいほどカメラから遠い(奥)。
 * 地面は最奥固定。オブジェクト/ユニットは可視ソート順で OBJ_Z_FAR..OBJ_Z_NEAR を線形補間。
 */
const GROUND_Z = 50;          // 地面: 最奥
const OBJ_Z_FAR = 40;         // depth 最小(最奥)のオブジェクト
const OBJ_Z_NEAR = 5;         // depth 最大(最手前)のオブジェクト
const GRID_Z = 48;            // グリッド線: 地面とオブジェクトの中間

/* ---------- アセット定義 ---------- */
const ASSET_DIR = "../assets/";
const ASSETS = {
  grass:    { file: "tile_grass.png", w: TILE_W, h: TILE_H, fallback: "#4f9d3a", shape: "diamond" },
  soil:     { file: "tile_soil.png",  w: TILE_W, h: TILE_H, fallback: "#9a6b3f", shape: "diamond" },
  water:    { file: "tile_water.png", w: TILE_W, h: TILE_H, fallback: "#3a7bd5", shape: "diamond" },
  tree:     { file: "tree.png",       w: 48, h: 64, fallback: "#2f7d32", shape: "tree" },
  house:    { file: "house.png",      w: 64, h: 64, fallback: "#b0b0b8", shape: "house" },
  villager: { file: "villager.png",   w: 24, h: 32, fallback: "#ff9933", shape: "circle" },
};

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じマップ/オブジェクト/ユニット挙動を生成する。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
 *  アイソメトリック投影 (SPEC 共通式)
 * ========================================================================= */
// グリッド連続座標 (gx,gy) → ワールド画面座標 (px)。カメラオフセットは後段で加算。
function isoX(gx, gy) { return (gx - gy) * HW; }
function isoY(gx, gy) { return (gx + gy) * HH; }
// 深度キー
function depthKey(gx, gy) { return gx + gy; }

/* =========================================================================
 *  マップ決定的生成
 * ========================================================================= */
// 地面種別(草/土/水) + 静的オブジェクト(木/家) を固定シードで散布する。
let groundMap;   // Uint8Array MAP_N*MAP_N
let objects;     // [{ kind, gx, gy }] 静的オブジェクト

function tileIndex(gx, gy) { return gy * MAP_N + gx; }
function groundAt(gx, gy) {
  if (gx < 0 || gx >= MAP_N || gy < 0 || gy >= MAP_N) return G_WATER;
  return groundMap[tileIndex(gx, gy)];
}
function isWaterAt(gx, gy) { return groundAt(gx, gy) === G_WATER; }

// (gx,gy) に背の高い静的オブジェクトがあるか (ユニットの徘徊回避に使用)
let objBlocked; // Uint8Array: 1=木/家あり
function isBlocked(gx, gy) {
  if (gx < 0 || gx >= MAP_N || gy < 0 || gy >= MAP_N) return true;
  return objBlocked[tileIndex(gx, gy)] === 1;
}

function generateWorld() {
  const rnd = mulberry32(0x1509);
  groundMap = new Uint8Array(MAP_N * MAP_N);

  // --- 地面: 数個の水たまり(湖/池)を置き、残りを草、所々を畑(土) にする ---
  // まず全面草。
  for (let i = 0; i < MAP_N * MAP_N; i++) groundMap[i] = G_GRASS;

  // 水たまり: 楕円状の池を数個。
  const pondCount = 5;
  for (let p = 0; p < pondCount; p++) {
    const cx = 6 + Math.floor(rnd() * (MAP_N - 12));
    const cy = 6 + Math.floor(rnd() * (MAP_N - 12));
    const rx = 3 + Math.floor(rnd() * 5);
    const ry = 3 + Math.floor(rnd() * 5);
    for (let gy = cy - ry; gy <= cy + ry; gy++) {
      for (let gx = cx - rx; gx <= cx + rx; gx++) {
        if (gx < 0 || gx >= MAP_N || gy < 0 || gy >= MAP_N) continue;
        const dx = (gx - cx) / rx, dy = (gy - cy) / ry;
        if (dx * dx + dy * dy <= 1.0) groundMap[tileIndex(gx, gy)] = G_WATER;
      }
    }
  }

  // 畑(土): 矩形の畑区画を数個。
  const farmCount = 8;
  for (let f = 0; f < farmCount; f++) {
    const fx = 2 + Math.floor(rnd() * (MAP_N - 10));
    const fy = 2 + Math.floor(rnd() * (MAP_N - 10));
    const fw = 3 + Math.floor(rnd() * 5);
    const fh = 3 + Math.floor(rnd() * 5);
    for (let gy = fy; gy < fy + fh; gy++) {
      for (let gx = fx; gx < fx + fw; gx++) {
        if (gx < 0 || gx >= MAP_N || gy < 0 || gy >= MAP_N) continue;
        if (groundMap[tileIndex(gx, gy)] === G_WATER) continue; // 水は畑にしない
        groundMap[tileIndex(gx, gy)] = G_SOIL;
      }
    }
  }

  // --- 静的オブジェクト: 木/家 を散布 (水の上には置かない) ---
  objects = [];
  objBlocked = new Uint8Array(MAP_N * MAP_N);
  for (let gy = 0; gy < MAP_N; gy++) {
    for (let gx = 0; gx < MAP_N; gx++) {
      if (isWaterAt(gx, gy)) continue;
      const g = groundAt(gx, gy);
      const r = rnd();
      if (g === G_GRASS && r < 0.10) {
        objects.push({ kind: O_TREE, gx: gx + 0.5, gy: gy + 0.5 });
        objBlocked[tileIndex(gx, gy)] = 1;
      } else if (r < 0.03) {
        // 草/畑 どちらでも低確率で家
        objects.push({ kind: O_HOUSE, gx: gx + 0.5, gy: gy + 0.5 });
        objBlocked[tileIndex(gx, gy)] = 1;
      }
    }
  }
}

/* =========================================================================
 *  Babylon セットアップ
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.14, 0.19, 0.25, 1.0); // 暗い地色
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) ---
// orthoTop < orthoBottom で y 下向きの 2D 画面に一致させる。
// カメラスクロールは ortho 窓を平行移動して表現する。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

// sprite/plane が見えるよう環境光 (マテリアルは emissive/unlit だが念のため)
const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* ---------- テクスチャ存在チェック ---------- */
// SpriteManager は読込失敗時に黒テクスチャになるので、事前に Image で存在確認する。
function checkImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

// テクスチャがあれば Sprite、無ければ Plane/Disc/ポリゴンを使う統一ラッパを構築する。
const managers = {}; // key -> SpriteManager or null
const SPRITE_CAPACITY = 8192;

function makeManager(key, capacity) {
  const a = ASSETS[key];
  const sm = new BABYLON.SpriteManager(
    "sm_" + key, ASSET_DIR + a.file, capacity || SPRITE_CAPACITY,
    { width: a.w, height: a.h }, scene
  );
  sm.isPickable = false;
  return sm;
}

// フォールバック用 単色マテリアル (共有)
const fallbackMats = {};
function fallbackMatFromHex(name, hex) {
  if (fallbackMats[name]) return fallbackMats[name];
  const m = new BABYLON.StandardMaterial("fm_" + name, scene);
  const c = BABYLON.Color3.FromHexString(hex);
  m.emissiveColor = c;
  m.diffuseColor = c;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.backFaceCulling = false;
  fallbackMats[name] = m;
  return m;
}

/* ---------- フォールバック図形テンプレート ----------
 * SPEC: 地面=菱形ポリゴン / 木=茶幹+緑円 / 家=灰菱形柱 / ユニット=橙丸。
 * いずれも単位サイズで作り、clone 後に scaling/位置で実サイズへ。
 */
const fallbackTemplates = {};

// アイソメ菱形(4頂点) を単位 (幅1,高さ1) で作る。中心原点・y 下向きを考慮。
function makeDiamondTemplate(name, hex) {
  // 頂点: 上(0,-0.5) 右(0.5,0) 下(0,0.5) 左(-0.5,0)。y 下向きなので上が -y。
  const positions = [
    0, -0.5, 0,   // 上
    0.5, 0, 0,    // 右
    0, 0.5, 0,    // 下
    -0.5, 0, 0,   // 左
  ];
  const indices = [0, 1, 2, 0, 2, 3];
  const mesh = new BABYLON.Mesh("ft_" + name, scene);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
  vd.applyToMesh(mesh);
  mesh.material = fallbackMatFromHex(name, hex);
  mesh.isPickable = false;
  mesh.setEnabled(false);
  return mesh;
}

function fallbackTemplate(key) {
  if (fallbackTemplates[key]) return fallbackTemplates[key];
  const a = ASSETS[key];
  let mesh;
  if (a.shape === "diamond") {
    mesh = makeDiamondTemplate(key, a.fallback);
  } else if (a.shape === "circle") {
    mesh = BABYLON.MeshBuilder.CreateDisc("ft_" + key, { radius: 0.5, tessellation: 18 }, scene);
    mesh.material = fallbackMatFromHex(key, a.fallback);
    mesh.isPickable = false;
    mesh.setEnabled(false);
  } else if (a.shape === "tree") {
    // 茶幹(細い矩形) + 緑円(キャノピー) を1メッシュにまとめる。
    const trunk = BABYLON.MeshBuilder.CreatePlane("trunk", { width: 0.18, height: 0.5 }, scene);
    trunk.position.y = 0.20; // y 下向き: +y は下。幹は足元(下寄り)。
    const trunkMat = fallbackMatFromHex("treeTrunk", "#6b4423");
    trunk.material = trunkMat;
    const canopy = BABYLON.MeshBuilder.CreateDisc("canopy", { radius: 0.42, tessellation: 18 }, scene);
    canopy.position.y = -0.18; // 上(奥行き上方)にキャノピー
    canopy.material = fallbackMatFromHex(key, a.fallback);
    mesh = BABYLON.Mesh.MergeMeshes([trunk, canopy], true, true, undefined, false, true);
    mesh.name = "ft_" + key;
    mesh.isPickable = false;
    mesh.setEnabled(false);
  } else if (a.shape === "house") {
    // 灰の菱形柱風: 上面菱形 + 本体矩形 をまとめる。
    const body = BABYLON.MeshBuilder.CreatePlane("houseBody", { width: 0.8, height: 0.7 }, scene);
    body.position.y = 0.1;
    body.material = fallbackMatFromHex(key, a.fallback);
    const roof = makeDiamondTemplate("houseRoof", "#8a5a3a");
    roof.position.y = -0.30;
    roof.scaling.x = 0.9; roof.scaling.y = 0.45;
    roof.setEnabled(true);
    mesh = BABYLON.Mesh.MergeMeshes([body, roof], true, true, undefined, false, true);
    mesh.name = "ft_" + key;
    mesh.isPickable = false;
    mesh.setEnabled(false);
  } else {
    mesh = BABYLON.MeshBuilder.CreatePlane("ft_" + key, { width: 1, height: 1 }, scene);
    mesh.material = fallbackMatFromHex(key, a.fallback);
    mesh.isPickable = false;
    mesh.setEnabled(false);
  }
  fallbackTemplates[key] = mesh;
  return mesh;
}

/* ---------- 統一スプライトラッパ ----------
 * { setPos(x,y,z), setVisible(b), setSize(w,h), dispose() }
 * 座標はワールド画面 px をそのまま渡す (ortho が px 等倍なので変換不要)。
 */
function createEntitySprite(key) {
  const a = ASSETS[key];
  if (managers[key]) {
    const sp = new BABYLON.Sprite("s_" + key, managers[key]);
    sp.width = a.w;
    sp.height = a.h;
    return {
      kind: "sprite", obj: sp,
      setPos(x, y, z) { sp.position.x = x; sp.position.y = y; sp.position.z = (z == null ? 0 : z); },
      setVisible(b) { sp.isVisible = b; },
      setSize(w, h) { sp.width = w; sp.height = h; },
      dispose() { sp.dispose(); },
    };
  } else {
    const mesh = fallbackTemplate(key).clone("c_" + key);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    return {
      kind: "mesh", obj: mesh,
      setPos(x, y, z) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = (z == null ? 0 : z); },
      setVisible(b) { mesh.setEnabled(b); },
      setSize(w, h) { mesh.scaling.x = w; mesh.scaling.y = h; },
      dispose() { mesh.dispose(); },
    };
  }
}

/* =========================================================================
 *  ゲーム状態
 * ========================================================================= */
const Game = {
  camGx: MAP_N / 2,   // カメラ中心のワールドグリッド座標
  camGy: MAP_N / 2,
  camPxX: 0,          // カメラ中心のワールド画面 px (iso 変換結果)
  camPxY: 0,
  units: [],          // {gx,gy,tx,ty,seed,spr}
  unitSetting: INITIAL_UNITS,
  tilesDrawn: 0,
  objectsSorted: 0,
  showGrid: false,
};

/* ---------- カメラのワールド px 範囲 ----------
 * iso 投影では画面 x は (gx-gy)*HW、画面 y は (gx+gy)*HH。
 * 全タイルの iso 座標が収まるワールド px 矩形を求め、カメラ中心をその中でクランプする。
 */
const WORLD_MIN_X = isoX(0, MAP_N - 1);            // 左端 (gx=0,gy=max)
const WORLD_MAX_X = isoX(MAP_N - 1, 0);            // 右端
const WORLD_MIN_Y = isoY(0, 0);                    // 上端 = 0
const WORLD_MAX_Y = isoY(MAP_N - 1, MAP_N - 1);    // 下端

function clampCamera() {
  // カメラ中心グリッドを [0, MAP_N-1] にクランプ → px へ。
  Game.camGx = Math.max(0, Math.min(MAP_N - 1, Game.camGx));
  Game.camGy = Math.max(0, Math.min(MAP_N - 1, Game.camGy));
  Game.camPxX = isoX(Game.camGx, Game.camGy);
  Game.camPxY = isoY(Game.camGx, Game.camGy);
}

// 画面左上に対応するワールド px オフセット。ortho 窓をここへ移動する。
function camOffsetX() { return Game.camPxX - VIEW_W / 2; }
function camOffsetY() { return Game.camPxY - VIEW_H / 2; }

/* =========================================================================
 *  ユニット (負荷の主役) ― 決定的にうろつく
 * ========================================================================= */
// 各ユニットは固定シードで決定的に生成され、決定的な目的地へ向かい、着いたら次の目的地へ。
// 水タイルは避ける (目的地が水なら別の決定的目的地を選ぶ)。
function spawnPointFor(seed) {
  // 水でない初期位置を決定的に探す。
  const rnd = mulberry32(seed ^ 0xA53C);
  for (let i = 0; i < 64; i++) {
    const gx = rnd() * (MAP_N - 1);
    const gy = rnd() * (MAP_N - 1);
    if (!isWaterAt(Math.floor(gx), Math.floor(gy))) return { gx, gy };
  }
  return { gx: MAP_N / 2, gy: MAP_N / 2 };
}

// 次の決定的目的地 (水・障害物でないタイル)。各ユニットは自分の rng 状態を進める。
function pickTarget(u) {
  for (let i = 0; i < 32; i++) {
    const tx = u.rng() * (MAP_N - 1);
    const ty = u.rng() * (MAP_N - 1);
    const fx = Math.floor(tx), fy = Math.floor(ty);
    if (!isWaterAt(fx, fy) && !isBlocked(fx, fy)) return { tx, ty };
  }
  return { tx: u.gx, ty: u.gy };
}

function makeUnit(index) {
  const seed = (0x5000 + index * 0x9E37) >>> 0;
  const sp = spawnPointFor(seed);
  const u = {
    gx: sp.gx, gy: sp.gy,
    tx: sp.gx, ty: sp.gy,
    rng: mulberry32(seed),
    face: 0,
    animT: 0,
    spr: createEntitySprite("villager"),
  };
  u.spr.setSize(ASSETS.villager.w, ASSETS.villager.h);
  const t = pickTarget(u);
  u.tx = t.tx; u.ty = t.ty;
  return u;
}

// 設定値 n に合わせてユニットを決定的に再構築する。
function setUnitCount(n) {
  n = Math.max(MIN_UNITS, Math.min(MAX_UNITS, n));
  Game.unitSetting = n;
  for (const u of Game.units) u.spr.dispose();
  Game.units.length = 0;
  for (let i = 0; i < n; i++) Game.units.push(makeUnit(i));
}

function unitFaceFromMove(dx, dy, current = 0) {
  if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
  const sx = dx - dy;
  const sy = dx + dy;
  if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
  return sy < 0 ? 1 : 0;
}

function updateUnits(dt) {
  const step = UNIT_SPEED * dt; // grid 単位の移動量
  for (const u of Game.units) {
    const bx = u.gx, by = u.gy;
    let dx = u.tx - u.gx;
    let dy = u.ty - u.gy;
    let dist = Math.hypot(dx, dy);
    if (dist < 0.05) {
      // 到着 → 次の決定的目的地へ
      const t = pickTarget(u);
      u.tx = t.tx; u.ty = t.ty;
      dx = u.tx - u.gx; dy = u.ty - u.gy;
      dist = Math.hypot(dx, dy) || 1;
    }
    let nx = u.gx + (dx / dist) * step;
    let ny = u.gy + (dy / dist) * step;
    // 水タイルへは踏み込まない (踏みそうなら目的地を選び直す)
    if (isWaterAt(Math.floor(nx), Math.floor(ny))) {
      const t = pickTarget(u);
      u.tx = t.tx; u.ty = t.ty;
    } else {
      u.gx = nx; u.gy = ny;
    }
    const mdx = u.gx - bx, mdy = u.gy - by;
    const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
    u.face = unitFaceFromMove(mdx, mdy, u.face);
    u.animT = moving ? (u.animT || 0) + dt : 0;
  }
}

/* =========================================================================
 *  描画 (1): 地面タイル ― 可視カリングのみ (ソート不要・最奥固定 z)
 * ========================================================================= */
// 種別ごとの SpriteManager/フォールバックと、再利用するスプライトプールを持つ。
const groundPools = {}; // groundType -> { key, pool:[], used }
const groundKeyByType = { [G_GRASS]: "grass", [G_SOIL]: "soil", [G_WATER]: "water" };

function initGroundPools() {
  for (const t of [G_GRASS, G_SOIL, G_WATER]) {
    groundPools[t] = { key: groundKeyByType[t], pool: [], used: 0 };
  }
}

// 画面に入りうる iso グリッド範囲を求める。逆変換:
//   gx = (sx/HW + sy/HH)/2 + cgx ,  gy = (sy/HH - sx/HW)/2 + cgy   (近似)
// 画面四隅のワールド px から (gx+gy),(gx-gy) の範囲を取り、整数タイルへ展開する。
function visibleGridBounds() {
  const ox = camOffsetX(), oy = camOffsetY();
  // 画面四隅のワールド px
  const corners = [
    [ox, oy], [ox + VIEW_W, oy],
    [ox, oy + VIEW_H], [ox + VIEW_W, oy + VIEW_H],
  ];
  let sumMin = Infinity, sumMax = -Infinity, difMin = Infinity, difMax = -Infinity;
  for (const [px, py] of corners) {
    // px = (gx-gy)*HW → (gx-gy) = px/HW ; py = (gx+gy)*HH → (gx+gy) = py/HH
    const sum = py / HH;     // gx+gy
    const dif = px / HW;     // gx-gy
    if (sum < sumMin) sumMin = sum; if (sum > sumMax) sumMax = sum;
    if (dif < difMin) difMin = dif; if (dif > difMax) difMax = dif;
  }
  // gx=(sum+dif)/2, gy=(sum-dif)/2。余白 +2 タイルで切れを防ぐ。
  const pad = 2;
  return {
    gxMin: Math.max(0, Math.floor((sumMin + difMin) / 2) - pad),
    gxMax: Math.min(MAP_N - 1, Math.ceil((sumMax + difMax) / 2) + pad),
    gyMin: Math.max(0, Math.floor((sumMin - difMax) / 2) - pad),
    gyMax: Math.min(MAP_N - 1, Math.ceil((sumMax - difMin) / 2) + pad),
  };
}

function renderGround() {
  const b = visibleGridBounds();
  const ox = camOffsetX(), oy = camOffsetY();
  for (const t in groundPools) groundPools[t].used = 0;

  Game.tilesDrawn = 0;
  for (let gy = b.gyMin; gy <= b.gyMax; gy++) {
    for (let gx = b.gxMin; gx <= b.gxMax; gx++) {
      // タイル中心の iso 画面座標。タイル菱形の中心は (gx+0.5,gy+0.5) 相当に置く。
      const cx = gx + 0.5, cy = gy + 0.5;
      const sx = isoX(cx, cy) - ox;
      const sy = isoY(cx, cy) - oy;
      // 画面外のタイルはスキップ (菱形半分の余白)
      if (sx < -HW || sx > VIEW_W + HW || sy < -TILE_H || sy > VIEW_H + TILE_H) continue;

      const type = groundMap[tileIndex(gx, gy)];
      const gp = groundPools[type];
      const idx = gp.used++;
      let spr = gp.pool[idx];
      if (!spr) {
        spr = createEntitySprite(gp.key);
        spr.setSize(TILE_W, TILE_H);
        gp.pool[idx] = spr;
      }
      spr.setVisible(true);
      spr.setPos(sx, sy, GROUND_Z); // 地面は最奥固定
      Game.tilesDrawn++;
    }
  }
  // 余ったプールを隠す
  for (const t in groundPools) {
    const gp = groundPools[t];
    for (let i = gp.used; i < gp.pool.length; i++) gp.pool[i].setVisible(false);
  }
}

/* =========================================================================
 *  描画 (2): オブジェクト + ユニット ― 可視分のみ gx+gy で毎フレーム再ソート
 * ========================================================================= */
// 木/家用プール (種別ごと) と、ユニットは自前スプライトを持つ。
const objPools = { tree: { pool: [], used: 0 }, house: { pool: [], used: 0 } };

function getObjSprite(kind) {
  const key = kind === O_TREE ? "tree" : "house";
  const pool = objPools[key];
  const idx = pool.used++;
  let spr = pool.pool[idx];
  if (!spr) {
    spr = createEntitySprite(key);
    spr.setSize(ASSETS[key].w, ASSETS[key].h);
    pool.pool[idx] = spr;
  }
  return spr;
}

// 毎フレーム再利用するソート用バッファ。{depth, draw()} 形式は重いので
// 軽量に「描画候補」を配列へ積み、depth でソートして z を割り当てる。
const drawList = []; // {depth, sx, sy, kind, ref}  kind: "obj"|"unit"

function renderObjectsAndUnits() {
  const b = visibleGridBounds();
  const ox = camOffsetX(), oy = camOffsetY();
  drawList.length = 0;
  objPools.tree.used = 0;
  objPools.house.used = 0;

  // --- 可視オブジェクト(木/家) を収集 ---
  for (const o of objects) {
    if (o.gx < b.gxMin || o.gx > b.gxMax + 1 || o.gy < b.gyMin || o.gy > b.gyMax + 1) continue;
    const sx = isoX(o.gx, o.gy) - ox;
    const sy = isoY(o.gx, o.gy) - oy;
    if (sx < -TILE_W || sx > VIEW_W + TILE_W || sy < -96 || sy > VIEW_H + TILE_H) continue;
    drawList.push({ depth: depthKey(o.gx, o.gy), sx, sy, type: "obj", kind: o.kind });
  }

  // --- 可視ユニットを収集 ---
  for (const u of Game.units) {
    if (u.gx < b.gxMin || u.gx > b.gxMax + 1 || u.gy < b.gyMin || u.gy > b.gyMax + 1) {
      u.spr.setVisible(false);
      continue;
    }
    const sx = isoX(u.gx, u.gy) - ox;
    const sy = isoY(u.gx, u.gy) - oy;
    if (sx < -TILE_W || sx > VIEW_W + TILE_W || sy < -TILE_H || sy > VIEW_H + TILE_H) {
      u.spr.setVisible(false);
      continue;
    }
    drawList.push({ depth: depthKey(u.gx, u.gy), sx, sy, type: "unit", ref: u });
  }

  // --- 深度ソート (gx+gy 昇順 = 奥→手前) ---
  // 安定ソートが要件 (同 depth はオブジェクト→ユニットの順で安定)。
  // JS の Array.sort は現行エンジンで安定。depth が同値なら type 順で軽く整える。
  drawList.sort((a, b2) => (a.depth - b2.depth) || (a.type === b2.type ? 0 : (a.type === "obj" ? -1 : 1)));

  Game.objectsSorted = drawList.length;

  // --- ソート順に z を単調割り当て (奥=大きい z, 手前=小さい z) ---
  const n = drawList.length;
  for (let i = 0; i < n; i++) {
    const d = drawList[i];
    // i=0(最奥)→OBJ_Z_FAR, i=n-1(最手前)→OBJ_Z_NEAR
    const z = n <= 1 ? OBJ_Z_NEAR : OBJ_Z_FAR + (OBJ_Z_NEAR - OBJ_Z_FAR) * (i / (n - 1));
    if (d.type === "obj") {
      const spr = getObjSprite(d.kind);
      spr.setVisible(true);
      // 背の高いオブジェクトは足元(菱形中心)を基準に、上方向へ伸ばす。
      const h = (d.kind === O_TREE) ? ASSETS.tree.h : ASSETS.house.h;
      spr.setPos(d.sx, d.sy - h / 2 + HH, z); // 足元をタイル中心へ合わせ上へ
    } else {
      const u = d.ref;
      u.spr.setVisible(true);
      u.spr.setFrame((u.face || 0) * 4 + (Math.floor((u.animT || 0) * 8) % 4));
      u.spr.setPos(d.sx, d.sy - ASSETS.villager.h / 2 + HH, z);
    }
  }

  // 余った木/家プールを隠す
  for (const key in objPools) {
    const pool = objPools[key];
    for (let i = pool.used; i < pool.pool.length; i++) pool.pool[i].setVisible(false);
  }
}

/* =========================================================================
 *  グリッド線 (G トグル) ― 可視タイル境界を線で表示
 * ========================================================================= */
let gridLines = null;
function rebuildGrid() {
  if (gridLines) { gridLines.dispose(); gridLines = null; }
  if (!Game.showGrid) return;
  const b = visibleGridBounds();
  const ox = camOffsetX(), oy = camOffsetY();
  const lines = [];
  // 各タイルの菱形 4 辺を描く (可視範囲のみ)。
  for (let gy = b.gyMin; gy <= b.gyMax; gy++) {
    for (let gx = b.gxMin; gx <= b.gxMax; gx++) {
      const top = [isoX(gx, gy) - ox, isoY(gx, gy) - oy];
      const right = [isoX(gx + 1, gy) - ox, isoY(gx + 1, gy) - oy];
      const bottom = [isoX(gx + 1, gy + 1) - ox, isoY(gx + 1, gy + 1) - oy];
      const left = [isoX(gx, gy + 1) - ox, isoY(gx, gy + 1) - oy];
      const toV = (p) => new BABYLON.Vector3(p[0], p[1], GRID_Z);
      lines.push([toV(top), toV(right), toV(bottom), toV(left), toV(top)]);
    }
  }
  if (lines.length === 0) return;
  gridLines = BABYLON.MeshBuilder.CreateLineSystem("grid", { lines }, scene);
  gridLines.color = new BABYLON.Color3(0.9, 0.9, 0.95);
  gridLines.alpha = 0.25;
  gridLines.isPickable = false;
}

/* =========================================================================
 *  入力
 * ========================================================================= */
const keys = Object.create(null);
window.addEventListener("keydown", (ev) => {
  const k = ev.key.toLowerCase();
  keys[k] = true;
  if (ev.key === "+" || ev.key === "=" || ev.key === "Add") {
    setUnitCount(Game.unitSetting + UNIT_STEP);
  } else if (ev.key === "-" || ev.key === "_" || ev.key === "Subtract") {
    setUnitCount(Game.unitSetting - UNIT_STEP);
  }
  if (k === "g") { Game.showGrid = !Game.showGrid; }
  if (k === "r") { resetGame(); }
  if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) ev.preventDefault();
});
window.addEventListener("keyup", (ev) => { keys[ev.key.toLowerCase()] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);
canvas.addEventListener("click", () => canvas.focus());

function applyScroll(dt) {
  // カメラ中心を「ワールド px」で動かし、グリッド座標へ逆変換してクランプする。
  // 画面 x+ は (gx-gy) 増加、画面 y+ は (gx+gy) 増加。
  let dpx = 0, dpy = 0;
  if (keys["arrowleft"] || keys["a"]) dpx -= 1;
  if (keys["arrowright"] || keys["d"]) dpx += 1;
  if (keys["arrowup"] || keys["w"]) dpy -= 1;
  if (keys["arrowdown"] || keys["s"]) dpy += 1;
  if (dpx === 0 && dpy === 0) return;
  const mag = Math.hypot(dpx, dpy) || 1;
  const mvx = (dpx / mag) * SCROLL_SPEED * dt;
  const mvy = (dpy / mag) * SCROLL_SPEED * dt;
  // ワールド px → グリッド: sum=py/HH=gx+gy, dif=px/HW=gx-gy
  const newPxX = Game.camPxX + mvx;
  const newPxY = Game.camPxY + mvy;
  const sum = newPxY / HH;
  const dif = newPxX / HW;
  Game.camGx = (sum + dif) / 2;
  Game.camGy = (sum - dif) / 2;
  clampCamera();
}

/* =========================================================================
 *  リセット
 * ========================================================================= */
function resetGame() {
  Game.camGx = MAP_N / 2;
  Game.camGy = MAP_N / 2;
  clampCamera();
  setUnitCount(Game.unitSetting);
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;
function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const cgx = Game.camGx.toFixed(1);
  const cgy = Game.camGy.toFixed(1);
  const renderMode = managers.villager ? "Sprite(tex)" : "Mesh(fallback)";

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>           <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Tiles drawn</span>   <span class="hudVal">' + Game.tilesDrawn + '</span>\n' +
    '<span class="hudLabel">Objects sorted</span> <span class="hudVal">' + Game.objectsSorted + '</span>\n' +
    '<span class="hudLabel">Units</span>         <span class="hudVal">' + Game.units.length + ' / ' + Game.unitSetting + '</span>\n' +
    '<span class="hudLabel">Camera</span>        <span class="hudVal">(' + cgx + ', ' + cgy + ')</span>\n' +
    '<span class="warn">Render</span>        <span class="hudVal">' + renderMode + '</span>' +
      (assetsAllOk ? '' : '  <span style="color:#888">(アセット欠落→図形描画)</span>');
}

/* =========================================================================
 *  カメラ ortho 窓の平行移動 (スクロール反映)
 * ========================================================================= */
function applyCamera() {
  const ox = camOffsetX(), oy = camOffsetY();
  camera.orthoLeft = ox;
  camera.orthoRight = ox + VIEW_W;
  camera.orthoTop = oy;
  camera.orthoBottom = oy + VIEW_H;
  camera.position.x = ox + VIEW_W / 2;
  camera.position.y = oy + VIEW_H / 2;
}

/* =========================================================================
 *  起動: アセット確認 → 構築 → ループ開始
 * ========================================================================= */
let assetsAllOk = true;

async function boot() {
  generateWorld();

  const keysToCheck = ["grass", "soil", "water", "tree", "house", "villager"];
  const results = await Promise.all(
    keysToCheck.map((k) => checkImage(ASSET_DIR + ASSETS[k].file))
  );
  keysToCheck.forEach((k, idx) => {
    if (results[idx]) {
      try { managers[k] = makeManager(k); }
      catch (e) { managers[k] = null; assetsAllOk = false; }
    } else {
      managers[k] = null;
      assetsAllOk = false;
    }
  });

  initGroundPools();
  resetGame();           // カメラ中心 & ユニット初期化
  setUnitCount(INITIAL_UNITS);

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制
    applyScroll(dt);
    updateUnits(dt);
    applyCamera();
    renderGround();
    renderObjectsAndUnits();
    rebuildGrid();
    updateHud(dt);
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
