'use strict';

/*
  テーマ9 アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― LittleJS 版
  --------------------------------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / タイル菱形 TILE_W=64, TILE_H=32 / マップ 64x64 (決定的生成)
   - 地面: 0=草(grass) 1=土/畑(soil) 2=水(water) / 静的オブジェクト: 木 tree / 家 house
   - カメラ: 矢印/WASD でワールドをスクロール(中心をワールド内クランプ)
   - 可視範囲のアイソメ範囲だけカリングして描画(HUD `Tiles drawn`)
   - ユニット(初期60): 決定的にうろつく(40px/s 相当, 水タイル回避) / 毎フレーム再ソート
   - +/- でユニット数 ±20 (0..2000) / G グリッド / R リセット
   - HUD: FPS / Tiles drawn / Objects sorted / Units(cur/set) / camera world(gx,gy)

  ★ アイソメ投影（SPEC 共通式） ★
   - グリッド(gx,gy) → 画面オフセット(px):
       isoX = (gx - gy) * (TILE_W/2)   // = (gx-gy)*32
       isoY = (gx + gy) * (TILE_H/2)   // = (gx+gy)*16
   - 深度キー depth = gx + gy。小さいほど奥(先に描く)、大きいほど手前(後に描く)。

  ★ 座標系 / Y軸メモ (最重要) ★
   - SPEC のアイソメ式は「画面ピクセル・Y下向き」(isoY が大きいほど画面下)で定義される。
     一方 LittleJS のワールドは **Y軸が上向き**。テーマ5 同様 cameraScale=1 (1ワールド=1px) とし、
     iso 計算は SPEC の Y下向き px のまま行い、LittleJS へ渡す瞬間だけ Y 符号を反転する。
       worldFromIso(isoX, isoY) = vec2(isoX, -isoY)
   - これにより「アイソメで奥(isoY 小)=画面上=LittleJS の Y 大」という自然な見た目になる。
     iso 計算・カリング・深度ソートはすべて Y下向き px の一貫モデルで行い、
     描画関数(drawTile/drawRect)へ座標を渡す一点だけで Y を反転する規約に閉じ込めた。
   - 描画順(z-order)は LittleJS では「draw 関数を呼ぶ順序」で決まる(後勝ち=手前)。
     したがって 2層方式: ①地面を先に全部描く(高さ0で重ならないのでソート不要) →
     ②可視オブジェクト+ユニットを depth=gx+gy 昇順にソートして描く(painter's algorithm)。
   - 画像が無くても起動する必要があるため textureInfos[i].size で読込判定し、
     未読込なら drawRect/drawTile/drawCircle の図形フォールバック(菱形ポリゴンを矩形回転で近似)で描画する。
*/

// ---- アイソメ・マップ定数 (SPEC) ----
const TILE_W = 64, TILE_H = 32;        // タイル菱形サイズ(px)
const HALF_W = TILE_W / 2;             // 32
const HALF_H = TILE_H / 2;             // 16
const MAP_N = 64;                      // 64x64 タイル
const VIEW_W = 960, VIEW_H = 540;      // 固定キャンバス

// ---- 地面種別 ----
const G_GRASS = 0, G_SOIL = 1, G_WATER = 2;

// ---- 静的オブジェクト種別 ----
const O_TREE = 0, O_HOUSE = 1;

// ---- ユニット (負荷の主役) ----
const UNIT_INIT = 60;
const UNIT_STEP = 20, UNIT_MIN = 0, UNIT_MAX = 2000;
const UNIT_SPEED_PX = 40;              // 40px/s 相当(画面ピクセル基準)
// 連続グリッド座標での速度に換算: 画面上の1グリッドステップは概ね対角 ~36px。
// 単純化のため「グリッド座標 1 ≒ TILE_W/2 px」とみなし grid/s に換算する。
const UNIT_SPEED_GRID = UNIT_SPEED_PX / HALF_W; // grid/s
const UNIT_RADIUS = 10;                // 描画半径(px 相当)
const UNIT_ARRIVE = 0.35;              // 目的地到達判定(グリッド距離)

// ---- 図形フォールバック色 ----
const GROUND_COLOR = {
  0: new Color(0.36, 0.62, 0.28),  // 草=緑
  1: new Color(0.55, 0.40, 0.22),  // 土/畑=茶
  2: new Color(0.20, 0.45, 0.78),  // 水=青
};
const COLOR_TREE_TRUNK = new Color(0.45, 0.30, 0.16);
const COLOR_TREE_LEAF  = new Color(0.18, 0.55, 0.22);
const COLOR_HOUSE_WALL = new Color(0.62, 0.62, 0.66);
const COLOR_HOUSE_ROOF = new Color(0.70, 0.28, 0.24);
const COLOR_UNIT       = new Color(0.95, 0.55, 0.18);
const COLOR_GRID       = new Color(0, 0, 0, 0.28);

// ---- imageSources (../assets/, SPEC のファイル名/インデックスに厳密一致) ----
const imageSources = [
  '../assets/tile_grass.png',  // 0 (64x32)
  '../assets/tile_soil.png',   // 1 (64x32)
  '../assets/tile_water.png',  // 2 (64x32)
  '../assets/tree.png',        // 3 (48x64)
  '../assets/house.png',       // 4 (64x64)
  '../assets/villager.png',    // 5 (24x32)
];
const TEX = { grass: 0, soil: 1, water: 2, tree: 3, house: 4, villager: 5 };
const GROUND_TEX = { 0: TEX.grass, 1: TEX.soil, 2: TEX.water };

// ---- グローバル状態 ----
let ground;              // Uint8Array MAP_N*MAP_N, idx = gy*MAP_N+gx (地面種別)
let objects = [];        // 静的オブジェクト {gx,gy,type}
let units = [];          // ユニット {gx,gy, tgx,tgy, seed}
let unitTarget = UNIT_INIT;

let camGX = MAP_N / 2;   // カメラ中心のワールド・グリッド座標
let camGY = MAP_N / 2;
let showGrid = false;

let tilesDrawn = 0;      // 可視地面タイル数
let objectsSorted = 0;   // 深度ソートした可視オブジェクト+ユニット数
let useSprites = false;

// 描画用 一時バッファ(毎フレーム再利用してGC負荷を抑える)
let drawList = [];

// FPS 指数移動平均
let fpsAvg = 60;

const hudEl = () => document.getElementById('hud');

// ---- 決定的疑似乱数 (mulberry32) ----
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ===================================================================
//  アイソメ投影 / 座標変換
// ===================================================================
// グリッド(gx,gy) -> アイソメ画面オフセット px (Y下向き)。
function isoX(gx, gy) { return (gx - gy) * HALF_W; }
function isoY(gx, gy) { return (gx + gy) * HALF_H; }

// iso px(Y下向き) -> LittleJS ワールド座標(Y上向き)。カメラ中心を原点に置く。
//  ・カメラ中心のグリッド (camGX,camGY) を画面中心(=ワールド原点)に合わせる。
function worldFromGrid(gx, gy) {
  const ix = isoX(gx, gy) - isoX(camGX, camGY);
  const iy = isoY(gx, gy) - isoY(camGX, camGY);
  // Y下向き iso → LittleJS Y上向き へ反転
  return vec2(ix, -iy);
}

function groundAt(gx, gy) {
  if (gx < 0 || gx >= MAP_N || gy < 0 || gy >= MAP_N) return G_WATER; // 外周は水
  return ground[gy * MAP_N + gx];
}
function isWaterCell(gx, gy) { return groundAt(gx, gy) === G_WATER; }

// ===================================================================
//  マップ決定的生成
// ===================================================================
function generateMap() {
  ground = new Uint8Array(MAP_N * MAP_N);
  const rng = makeRng(20260615); // 固定シード(全エンジン共通の見た目を狙う)

  // 値ノイズ風: 数個の正弦合成 + 乱数しきいで草/土/水を決定的に分布。
  // 川(水)は対角の帯として通す。畑(土)は塊で散布。
  for (let gy = 0; gy < MAP_N; gy++) {
    for (let gx = 0; gx < MAP_N; gx++) {
      let t = G_GRASS;
      // --- 水: 蛇行する川(対角 + 正弦の揺らぎ) ---
      const river = gx - gy + Math.round(Math.sin(gy * 0.45) * 4);
      if (Math.abs(river - 6) <= 2) t = G_WATER;
      // --- 池(決定的な数か所) ---
      const pondR = rng();
      if (t === G_GRASS && pondR < 0.015) t = G_WATER;
      ground[gy * MAP_N + gx] = t;
    }
  }
  // --- 畑(土)の塊: 決定的な位置に矩形パッチ ---
  const prng = makeRng(7777);
  for (let p = 0; p < 22; p++) {
    const cx = 3 + Math.floor(prng() * (MAP_N - 8));
    const cy = 3 + Math.floor(prng() * (MAP_N - 8));
    const w = 2 + Math.floor(prng() * 4);
    const h = 2 + Math.floor(prng() * 4);
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (gx >= 0 && gx < MAP_N && gy >= 0 && gy < MAP_N &&
            ground[gy * MAP_N + gx] !== G_WATER)
          ground[gy * MAP_N + gx] = G_SOIL;
      }
  }
}

function generateObjects() {
  objects = [];
  const rng = makeRng(13579);
  // 木: 草/土の上に決定的に散布。
  for (let i = 0; i < 700; i++) {
    const gx = Math.floor(rng() * MAP_N);
    const gy = Math.floor(rng() * MAP_N);
    if (isWaterCell(gx, gy)) continue;
    if (rng() < 0.35) continue; // 間引き
    objects.push({ gx, gy, type: O_TREE });
  }
  // 家: 集落として塊で配置(草地優先)。
  const hrng = makeRng(24680);
  for (let c = 0; c < 14; c++) {
    const cx = 4 + Math.floor(hrng() * (MAP_N - 10));
    const cy = 4 + Math.floor(hrng() * (MAP_N - 10));
    const n = 2 + Math.floor(hrng() * 5);
    for (let k = 0; k < n; k++) {
      const gx = cx + Math.floor(hrng() * 4);
      const gy = cy + Math.floor(hrng() * 4);
      if (gx < 0 || gx >= MAP_N || gy < 0 || gy >= MAP_N) continue;
      if (isWaterCell(gx, gy)) continue;
      objects.push({ gx, gy, type: O_HOUSE });
    }
  }
}

// ===================================================================
//  ユニット (決定的うろつき)
// ===================================================================
// 各ユニットは固定シードを持ち、目的地を決定的に巡回。水タイルは避ける。
function pickTarget(u) {
  // 自身の seed を進めて次の目的地グリッドを決定。陸(非水)になるまで数回試行。
  for (let tries = 0; tries < 12; tries++) {
    u.seed = (u.seed + 0x9E3779B9) >>> 0;
    let t = Math.imul(u.seed ^ (u.seed >>> 15), 1 | u.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r1 = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    u.seed = (u.seed + 0x85EBCA6B) >>> 0;
    let t2 = Math.imul(u.seed ^ (u.seed >>> 13), 1 | u.seed);
    t2 = (t2 + Math.imul(t2 ^ (t2 >>> 9), 61 | t2)) ^ t2;
    const r2 = ((t2 ^ (t2 >>> 12)) >>> 0) / 4294967296;
    const gx = clamp(Math.floor(r1 * MAP_N), 0, MAP_N - 1);
    const gy = clamp(Math.floor(r2 * MAP_N), 0, MAP_N - 1);
    if (!isWaterCell(gx, gy)) { u.tgx = gx + 0.5; u.tgy = gy + 0.5; return; }
  }
  // 全部水だった場合は現在地に留まる(まれ)
  u.tgx = u.gx; u.tgy = u.gy;
}

// 候補スポーン: 決定的に陸セルへ配置。unitTarget の増減に対し決定的(先頭から N 体)。
let unitSpawnCandidates = [];
function buildUnitSpawnCandidates() {
  const rng = makeRng(55555);
  const cand = [];
  for (let attempt = 0; attempt < UNIT_MAX * 6 && cand.length < UNIT_MAX; attempt++) {
    const gx = Math.floor(rng() * MAP_N);
    const gy = Math.floor(rng() * MAP_N);
    if (isWaterCell(gx, gy)) continue;
    // 各候補に決定的シードを与える(配置順 index ベース)
    cand.push({ gx: gx + 0.5, gy: gy + 0.5, seed: (0xABCD1234 ^ (cand.length * 2654435761)) >>> 0 });
  }
  return cand;
}

function syncUnitCount() {
  // 決定的: 先頭から unitTarget 体を採用。位置・初期目的地は固定。
  units = [];
  for (let i = 0; i < unitTarget && i < unitSpawnCandidates.length; i++) {
    const c = unitSpawnCandidates[i];
    const u = { gx: c.gx, gy: c.gy, tgx: c.gx, tgy: c.gy, seed: c.seed >>> 0, face: 0, animT: 0 };
    pickTarget(u);
    units.push(u);
  }
}

function updateUnits(dt) {
  const step = UNIT_SPEED_GRID * dt; // 1フレームのグリッド移動量
  for (const u of units) {
    const bx = u.gx, by = u.gy;
    let dx = u.tgx - u.gx;
    let dy = u.tgy - u.gy;
    let dist = Math.hypot(dx, dy);
    if (dist < UNIT_ARRIVE) {
      pickTarget(u);                  // 到達したら次の決定的目的地へ
      dx = u.tgx - u.gx; dy = u.tgy - u.gy; dist = Math.hypot(dx, dy);
      if (dist < 1e-6) continue;
    }
    const nx = u.gx + (dx / dist) * step;
    const ny = u.gy + (dy / dist) * step;
    // 水セルへ踏み込もうとしたら目的地を選び直す(回避)。
    if (isWaterCell(Math.floor(nx), Math.floor(ny))) {
      pickTarget(u);
      continue;
    }
    u.gx = nx; u.gy = ny;
    const mdx = u.gx - bx, mdy = u.gy - by;
    const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
    u.face = unitFaceFromMove(mdx, mdy, u.face);
    u.animT = moving ? (u.animT || 0) + dt : 0;
  }
}

function unitFaceFromMove(dx, dy, current = 0) {
  if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
  const sx = dx - dy;
  const sy = dx + dy;
  if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
  return sy < 0 ? 1 : 0;
}

// ===================================================================
//  テクスチャ読込判定 / フォールバック
// ===================================================================
function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}
function texTile(i) { return tile(0, textureInfos[i].size, i); }
function villagerFrame(face, animT) {
  const frame = Math.floor((animT || 0) * 8) % 4;
  return tile(vec2(frame * 24, (face || 0) * 32), vec2(24, 32), TEX.villager);
}

// 菱形(アイソメ・タイル)をフォールバック描画。LittleJS の drawPoly で 4頂点ポリゴンを描く。
// 頂点はワールド原点まわりのローカルオフセット、pos で worldPos へ平行移動する。
//  ・上(奥) / 右 / 下(手前) / 左 の順。LittleJS は Y上向きなので「上」= +HALF_H。
const DIAMOND_PTS = [
  vec2(0,  HALF_H),  // 上
  vec2(HALF_W, 0),   // 右
  vec2(0, -HALF_H),  // 下
  vec2(-HALF_W, 0),  // 左
];
function drawIsoDiamond(worldPos, color) {
  drawPoly(DIAMOND_PTS, color, 0, BLACK, worldPos);
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);              // 1ワールド単位 = 1px (テーマ5と同思想)
  setCameraPos(vec2(0, 0));       // ワールド原点を画面中心に。iso オフセットで配置する。
  setGravity(vec2(0, 0));

  // テクスチャ読込判定(1枚でも読めれば sprites 使用)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  generateMap();
  generateObjects();
  unitSpawnCandidates = buildUnitSpawnCandidates();

  camGX = MAP_N / 2;
  camGY = MAP_N / 2;
  showGrid = false;
  unitTarget = UNIT_INIT;
  syncUnitCount();
}

function gameUpdate() {
  const dt = timeDelta;

  // ---- リセット ----
  if (keyWasPressed('KeyR')) {
    gameInit();
    return;
  }

  // ---- グリッド表示トグル ----
  if (keyWasPressed('KeyG')) showGrid = !showGrid;

  // ---- ユニット数 増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    unitTarget = clamp(unitTarget + UNIT_STEP, UNIT_MIN, UNIT_MAX);
    syncUnitCount();
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    unitTarget = clamp(unitTarget - UNIT_STEP, UNIT_MIN, UNIT_MAX);
    syncUnitCount();
  }

  // ---- カメラスクロール(矢印/WASD) ----
  // グリッド軸で動かす(画面の上下左右に概ね一致するよう gx/gy を増減)。
  const camSpeed = 8 * dt; // グリッド/s
  let dgx = 0, dgy = 0;
  if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) { dgx -= 1; dgy += 1; } // 画面左へ
  if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) { dgx += 1; dgy -= 1; } // 画面右へ
  if (keyIsDown('ArrowUp') || keyIsDown('KeyW')) { dgx -= 1; dgy -= 1; }   // 画面上(奥)へ
  if (keyIsDown('ArrowDown') || keyIsDown('KeyS')) { dgx += 1; dgy += 1; } // 画面下(手前)へ
  if (dgx || dgy) {
    camGX = clamp(camGX + dgx * camSpeed, 0, MAP_N - 1);
    camGY = clamp(camGY + dgy * camSpeed, 0, MAP_N - 1);
  }

  // ---- ユニット更新(決定的うろつき) ----
  updateUnits(dt);
}

function gameUpdatePost() {}

// ===================================================================
//  描画 (アイソメ + 2層 painter's algorithm + カリング)
// ===================================================================
// 可視グリッド範囲を算出: 画面四隅(LittleJS ワールド)を iso 逆変換してグリッド窓を得る。
//  iso 逆変換: gx = (isoX/HALF_W + isoY/HALF_H)/2, gy = (isoY/HALF_H - isoX/HALF_W)/2
//  ここで isoX,isoY はカメラ中心基準のオフセット(Y下向き)。
function computeVisibleRange() {
  const halfWpx = VIEW_W / 2, halfHpx = VIEW_H / 2;
  // 画面四隅の iso オフセット(カメラ中心基準, Y下向き)。余白を1タイル分付ける。
  const corners = [
    [-halfWpx, -halfHpx], [halfWpx, -halfHpx],
    [-halfWpx, halfHpx], [halfWpx, halfHpx],
  ];
  let gxMin = Infinity, gxMax = -Infinity, gyMin = Infinity, gyMax = -Infinity;
  for (const [sx, sy] of corners) {
    // 画面四隅 → カメラ中心基準オフセット。LittleJS は Y上向きなので sy はそのまま
    // 画面px(Y下向き)に対し符号反転済みの値として扱う(下記参照)。
    // ここでは sx,sy は「カメラ中心からの px (Y下向き)」として計算する。
    const ix = sx + isoX(camGX, camGY);
    const iy = sy + isoY(camGX, camGY);
    const gx = (ix / HALF_W + iy / HALF_H) / 2;
    const gy = (iy / HALF_H - ix / HALF_W) / 2;
    gxMin = Math.min(gxMin, gx); gxMax = Math.max(gxMax, gx);
    gyMin = Math.min(gyMin, gy); gyMax = Math.max(gyMax, gy);
  }
  return {
    gxMin: clamp(Math.floor(gxMin) - 2, 0, MAP_N - 1),
    gxMax: clamp(Math.ceil(gxMax) + 2, 0, MAP_N - 1),
    gyMin: clamp(Math.floor(gyMin) - 2, 0, MAP_N - 1),
    gyMax: clamp(Math.ceil(gyMax) + 2, 0, MAP_N - 1),
  };
}

let visRange = { gxMin: 0, gxMax: 0, gyMin: 0, gyMax: 0 };

function gameRender() {
  tilesDrawn = 0;
  objectsSorted = 0;

  // 背景(空)
  drawRect(vec2(0, 0), vec2(VIEW_W, VIEW_H), new Color(0.12, 0.16, 0.20));

  const r = computeVisibleRange();
  visRange = r;

  // ===== 第1層: 地面タイル(高さ0で重ならないのでソート不要) =====
  for (let gy = r.gyMin; gy <= r.gyMax; gy++) {
    for (let gx = r.gxMin; gx <= r.gxMax; gx++) {
      const g = groundAt(gx, gy);
      const wp = worldFromGrid(gx, gy);
      if (spriteReady(GROUND_TEX[g])) {
        // タイル画像は 64x32。Y上向きなのでサイズはそのまま(LittleJS が上下を扱う)。
        drawTile(wp, vec2(TILE_W, TILE_H), texTile(GROUND_TEX[g]));
      } else {
        drawIsoDiamond(wp, GROUND_COLOR[g]);
      }
      // グリッド線(任意)
      if (showGrid) {
        drawIsoOutline(gx, gy);
      }
      tilesDrawn++;
    }
  }
}

// グリッド線: 菱形の輪郭を drawPoly の線幅(塗りつぶし無し)で描く。
function drawIsoOutline(gx, gy) {
  const c = worldFromGrid(gx, gy);
  drawPoly(DIAMOND_PTS, CLEAR_WHITE, 1, COLOR_GRID, c);
}

// ===== 第2層: 可視オブジェクト+ユニットを depth=gx+gy 昇順にソートして描画 =====
//  LittleJS は描画順=z-order なので、配列を sort してから順に draw する(painter's)。
function gameRenderPost() {
  const r = visRange;
  drawList.length = 0; // 再利用バッファをクリア

  // --- 可視オブジェクト収集 ---
  for (const o of objects) {
    if (o.gx < r.gxMin || o.gx > r.gxMax || o.gy < r.gyMin || o.gy > r.gyMax) continue;
    drawList.push(o);
  }
  // --- 可視ユニット収集(連続座標なので毎フレーム変わる→毎フレーム再ソート) ---
  for (const u of units) {
    if (u.gx < r.gxMin || u.gx > r.gxMax || u.gy < r.gyMin || u.gy > r.gyMax) continue;
    drawList.push(u);
  }

  // --- 深度ソート: depth = gx+gy 昇順(同値はオブジェクト→ユニットの順で安定) ---
  drawList.sort((a, b) => {
    const da = a.gx + a.gy, db = b.gx + b.gy;
    if (da !== db) return da - db;
    // 安定化: type を持つ静的オブジェクトを先(奥)に
    const ta = (a.type !== undefined) ? 0 : 1;
    const tb = (b.type !== undefined) ? 0 : 1;
    return ta - tb;
  });
  objectsSorted = drawList.length;

  // --- painter's: 奥(depth小)から手前(depth大)へ順に描く ---
  for (const e of drawList) {
    if (e.type === O_TREE) drawTreeAt(e.gx, e.gy);
    else if (e.type === O_HOUSE) drawHouseAt(e.gx, e.gy);
    else drawUnitAt(e.gx, e.gy, e.face || 0, e.animT || 0);
  }

  updateHud();
}

// オブジェクト/ユニット描画: iso 接地点(セル中心)を求め、背の高いものは上(Y+)へ伸ばす。
function drawTreeAt(gx, gy) {
  const base = worldFromGrid(gx, gy);
  if (spriteReady(TEX.tree)) {
    // 足元(菱形中心)を base に合わせ、画像中心を上へ持ち上げる(Y上向きなので +)。
    const sz = textureInfos[TEX.tree].size;
    drawTile(vec2(base.x, base.y + sz.y / 2 - HALF_H / 2), vec2(sz.x, sz.y), texTile(TEX.tree));
  } else {
    // 幹(縦矩形) + 葉(円)
    drawRect(vec2(base.x, base.y + 12), vec2(6, 20), COLOR_TREE_TRUNK);
    drawCircle(vec2(base.x, base.y + 26), 12, COLOR_TREE_LEAF);
  }
}

function drawHouseAt(gx, gy) {
  const base = worldFromGrid(gx, gy);
  if (spriteReady(TEX.house)) {
    const sz = textureInfos[TEX.house].size;
    drawTile(vec2(base.x, base.y + sz.y / 2 - HALF_H / 2), vec2(sz.x, sz.y), texTile(TEX.house));
  } else {
    // 壁(箱) + 屋根(回転矩形で三角風)
    drawRect(vec2(base.x, base.y + 14), vec2(40, 28), COLOR_HOUSE_WALL);
    drawRect(vec2(base.x, base.y + 30), vec2(30, 18), COLOR_HOUSE_ROOF, Math.PI / 4);
  }
}

function drawUnitAt(gx, gy, face = 0, animT = 0) {
  const base = worldFromGrid(gx, gy);
  if (spriteReady(TEX.villager)) {
    drawTile(vec2(base.x, base.y + 32 / 2 - HALF_H / 2), vec2(24, 32), villagerFrame(face, animT));
  } else {
    // 橙丸(足元を base から少し上に)
    drawCircle(vec2(base.x, base.y + UNIT_RADIUS), UNIT_RADIUS, COLOR_UNIT);
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function updateHud() {
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS          : ' + fpsAvg.toFixed(1) + '\n' +
      'Tiles drawn  : ' + tilesDrawn + '\n' +
      'Objects sorted: ' + objectsSorted + '\n' +
      'Units        : ' + units.length + ' / ' + unitTarget + '\n' +
      'Camera(gx,gy): (' + camGX.toFixed(1) + ', ' + camGY.toFixed(1) + ')' +
      (useSprites ? '   [sprites]' : '   [shapes fallback]') + '\n' +
      '矢印/WASD=スクロール  +/-=ユニット数  G=グリッド  R=リセット';
  }
}

// ===================================================================
//  起動
// ===================================================================
// 第7引数 rootElement に #game-container を渡し、canvas をそこへ生成させる
// (three.js 版と同じ 960x540・上端中央配置。CSS の !important でサイズ固定)。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
