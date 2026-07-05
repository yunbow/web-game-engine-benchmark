'use strict';

/*
  テーマ3 トップダウンRPG探索 ― LittleJS 版
  --------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / タイル 32x32 / マップ 100x100 (決定的生成)
   - 0=草 1=道 2=水(不可) 3=壁(不可) 4=木(不可)
   - 移動 160px/s 4方向, Shiftダッシュ2倍, 壁/水/木衝突
   - NPC/敵スライム 初期60体, 簡易徘徊, +/- で増減
   - 可視範囲のタイルのみ描画(カリング)
   - HUD: FPS(移動平均)/Tiles drawn/Entities/自機タイル座標

  実装メモ:
   - WebGL を切ると glCanvas が無くなり HUD(overlayCanvas) の重なり問題を回避できる。
     engineInit 前に glEnable=false を指定して 2D 描画一本化。
   - LittleJS は Y軸"上向き"。タイル配列 row 0 を画面上にしたいので
     ワールド座標は worldY = (MAP_H-1 - ty) としてマップを反転配置する。
   - 座標系: 1ワールド単位 = 1タイル。setCameraScale(TILE) で 32px/タイルに拡大。
   - FPS は gameRenderPost で performance.now() 差分の移動平均を自前算出。
   - 画像は assets が空でも起動する必要があるため textureInfos[i].size で
     読込済みか判定し、未読込なら図形フォールバックで描画する。
*/

// ---- 定数 ----
const TILE = 32;                 // 1タイルのピクセルサイズ(=カメラスケール)
const MAP_W = 100, MAP_H = 100;  // マップタイル数
const VIEW_W = 960, VIEW_H = 540;
const MOVE_SPEED = 160 / TILE;   // 160px/s をワールド単位/s に換算 (=5 tiles/s)

// タイル種別
const T_GRASS = 0, T_PATH = 1, T_WATER = 2, T_WALL = 3, T_TREE = 4;
const BLOCKED = { 2: true, 3: true, 4: true }; // 進入不可タイル

// 図形フォールバックの色
const TILE_COLORS = {
  0: '#3f8f3a', // 草=緑
  1: '#9a7b4f', // 道=茶
  2: '#2f6fce', // 水=青
  3: '#777f88', // 壁=灰
  4: '#2e5a26', // 木の足元(草より濃い緑)
};

// imageSources のインデックス対応 (SPEC のアセット名)
const IMG = {
  grass: 0, path: 1, water: 2, wall: 3, tree: 4, player: 5, npc: 6, slime: 7,
};
const imageSources = [
  '../assets/tile_grass.png',
  '../assets/tile_path.png',
  '../assets/tile_water.png',
  '../assets/tile_wall.png',
  '../assets/tree.png',
  '../assets/player.png',
  '../assets/npc.png',
  '../assets/enemy_slime.png',
];

// ---- グローバル状態 ----
let map;            // Uint8Array MAP_W*MAP_H, idx = ty*MAP_W+tx
let player;         // {pos, knock}
let entities = [];  // NPC/スライム
let entityTarget = 60;
let tilesDrawnThisFrame = 0;
let treesDrawnThisFrame = 0;       // 可視木数（three.js の treesDrawn）
let dashOn = false;                // HUDの[DASH]表示用
let hudEl = null;                  // HTML オーバーレイHUD（#hud）

// タイトル/アトラクト状態
let started = false, blinkT = 0, demoStuckT = 0;
let demoTarget = null;            // {x,y} ワールド単位
let playerSpawn = null;           // 初期スポーン位置(リセット用)
const demoRng = makeRng(20240619); // デモAI(決定的)

// FPS 移動平均
let lastNow = 0;
let fpsAvg = 60;
const FPS_SMOOTH = 0.92;

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

// ---- ワールド<->タイル座標の変換 ----
// マップ row 0 を上に表示するため Y を反転する。
function tileToWorld(tx, ty) {
  return vec2(tx + 0.5, (MAP_H - 1 - ty) + 0.5);
}
function worldToTileX(wx) { return Math.floor(wx); }
function worldToTileY(wy) { return (MAP_H - 1) - Math.floor(wy); }

function mapAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return map[ty * MAP_W + tx];
}

// ============================================================
// 共有デモシミュレーション（全エンジン共通・three.js と同一）
//   three.js 座標系（左上原点・Y下・28x28 corner px）で走り、デモ中の自機経路を
//   全エンジンで一致させる。spawn=makeRng(99) / 巡回=makeRng(20240619) / 160px/s。
//   LittleJS は Y上向きのため、描画時に player.pos へ変換する（後述）。
// ============================================================
const SIM = { map: null, idx: null, demoRnd: null, player: null, target: null, stuckT: 0 };
function simTileAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return SIM.map[SIM.idx(tx, ty)];
}
function simBlockedTile(t) { return t === T_WATER || t === T_WALL || t === T_TREE; }
function simRectBlocked(px, py, w, h) {
  const x0 = Math.floor(px / TILE), y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE), y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      if (simBlockedTile(simTileAt(tx, ty))) return true;
  return false;
}
function simMoveActor(a, dx, dy) {
  if (dx !== 0) { const nx = a.x + dx; if (!simRectBlocked(nx, a.y, a.w, a.h)) a.x = nx; }
  if (dy !== 0) { const ny = a.y + dy; if (!simRectBlocked(a.x, ny, a.w, a.h)) a.y = ny; }
}
function simPickTarget() {
  let tx, ty, g = 0;
  do {
    tx = 1 + Math.floor(SIM.demoRnd() * (MAP_W - 2));
    ty = 1 + Math.floor(SIM.demoRnd() * (MAP_H - 2));
    g++;
  } while (simBlockedTile(simTileAt(tx, ty)) && g < 100);
  SIM.target = { x: tx * TILE, y: ty * TILE };
}
function simInitDemo(m, idx) {
  SIM.map = m; SIM.idx = idx;
  const rnd = makeRng(99);
  let sx = 1, sy = 1;
  for (let i = 0; i < 5000; i++) {
    const tx = 1 + Math.floor(rnd() * (MAP_W - 2));
    const ty = 1 + Math.floor(rnd() * (MAP_H - 2));
    if (!simBlockedTile(m[idx(tx, ty)])) { sx = tx; sy = ty; break; }
  }
  SIM.player = { x: sx * TILE, y: sy * TILE, w: 28, h: 28 };
  SIM.demoRnd = makeRng(20240619);
  SIM.target = null; SIM.stuckT = 0;
  simPickTarget();
}
function simStep(dt) {
  dt = Math.min(dt, 0.05);
  const p = SIM.player;
  if (!SIM.target) simPickTarget();
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const tgx = SIM.target.x + p.w / 2, tgy = SIM.target.y + p.h / 2;
  const dx = tgx - cx, dy = tgy - cy;
  let mx = 0, my = 0;
  if (Math.hypot(dx, dy) < TILE * 0.6) { simPickTarget(); SIM.stuckT = 0; }
  else { if (Math.abs(dx) > Math.abs(dy)) mx = dx > 0 ? 1 : -1; else my = dy > 0 ? 1 : -1; }
  const sp = 160 * dt;
  const bx = p.x, by = p.y;
  simMoveActor(p, mx * sp, my * sp);
  if ((mx !== 0 || my !== 0) && p.x === bx && p.y === by) {
    SIM.stuckT += dt;
    if (SIM.stuckT > 0.4) { simPickTarget(); SIM.stuckT = 0; }
  } else SIM.stuckT = 0;
}
// SIM(corner px, Y下) を LittleJS world(タイル単位, Y上, マップY反転) へ変換
function simToWorldPos() {
  return vec2((SIM.player.x + SIM.player.w / 2) / TILE,
              MAP_H - (SIM.player.y + SIM.player.h / 2) / TILE);
}

// ---- マップ決定的生成 ----
function generateMap() {
  // 全エンジン共通の決定的生成（three.js と同一: mulberry32(1337)・同手順）。
  // map[ty*MAP_W+tx] のタイル内容は three.js と一致（描画のみ Y 反転）。
  map = new Uint8Array(MAP_W * MAP_H);
  const rng = makeRng(1337);
  for (let i = 0; i < map.length; i++) map[i] = T_GRASS;
  const idx = (x, y) => y * MAP_W + x;

  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const r = rng();
      if (r < 0.06) map[idx(x, y)] = T_WATER;
      else if (r < 0.14) map[idx(x, y)] = T_TREE;
      else if (r < 0.17) map[idx(x, y)] = T_WALL;
    }
  }
  const lanes = 6;
  for (let i = 0; i < lanes; i++) {
    const ry = 6 + Math.floor(rng() * (MAP_H - 12));
    for (let x = 1; x < MAP_W - 1; x++) map[idx(x, ry)] = T_PATH;
    const rx = 6 + Math.floor(rng() * (MAP_W - 12));
    for (let y = 1; y < MAP_H - 1; y++) map[idx(rx, y)] = T_PATH;
  }
  for (let x = 0; x < MAP_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, MAP_H - 1)] = T_WALL; }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_WALL; map[idx(MAP_W - 1, y)] = T_WALL; }
}

// 進入可能タイルを探す (スポーン用)
function findOpenTile(rng) {
  for (let tries = 0; tries < 200; tries++) {
    const tx = 1 + Math.floor(rng() * (MAP_W - 2));
    const ty = 1 + Math.floor(rng() * (MAP_H - 2));
    if (!BLOCKED[mapAt(tx, ty)]) return { tx, ty };
  }
  return { tx: MAP_W >> 1, ty: MAP_H >> 1 };
}

// ---- テクスチャ読込判定 ----
function texLoaded(i) {
  return typeof textureInfos !== 'undefined'
    && textureInfos[i]
    && textureInfos[i].size
    && textureInfos[i].size.x > 0;
}
// 画像全体を 1 枚のタイルとして参照する TileInfo を返す。
// tile(index, size, textureIndex): index=テクスチャ内の位置(0), size=画像実サイズ。
function texTile(i) {
  return tile(0, textureInfos[i].size, i);
}

// ---- エンティティ生成 ----
const entRng = makeRng(2024);
function spawnEntity() {
  const o = findOpenTile(entRng);
  const isSlime = entRng() < 0.6; // 6割スライム / 4割NPC
  entities.push({
    pos: tileToWorld(o.tx, o.ty),
    dir: vec2(entRng() * 2 - 1, entRng() * 2 - 1).normalize(),
    speed: 1.2 + entRng() * 1.2,    // tiles/s
    nextTurn: entRng() * 2,
    slime: isSlime,
  });
}
function syncEntityCount() {
  while (entities.length < entityTarget) spawnEntity();
  while (entities.length > entityTarget) entities.pop();
}

// =====================================================
//  LittleJS コールバック
// =====================================================
function gameInit() {
  hudEl = document.getElementById('hud');
  // 表示サイズ固定（既定の全画面拡大を抑止して他エンジンと揃える）
  setCanvasMaxSize(vec2(VIEW_W, VIEW_H));
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(TILE);          // 32px / 1ワールド単位
  setCameraPos(vec2(0, 0));

  generateMap();

  // 自機は中央付近の進入可能タイルから開始
  const prng = makeRng(7);
  const start = findOpenTile(prng);
  player = { pos: tileToWorld(start.tx, start.ty), knock: vec2(0, 0) };
  playerSpawn = tileToWorld(start.tx, start.ty);

  // デモ用シミュレーション初期化（全エンジン共通の経路）。デモ開始位置へ自機を置く。
  simInitDemo(map, (x, y) => y * MAP_W + x);
  player.pos = simToWorldPos();

  entityTarget = 60;
  syncEntityCount();

  pickDemoTarget();
  lastNow = performance.now();
}

// デモAI: 決定的にウェイポイント(開通タイル)を選び自機を歩かせる
function pickDemoTarget() {
  const o = findOpenTile(demoRng);
  demoTarget = tileToWorld(o.tx, o.ty);
}
// !started 中の移動方向(ワールド単位の単位ベクトル, 4方向)を返す
function demoInput() {
  if (!demoTarget) pickDemoTarget();
  const dx = demoTarget.x - player.pos.x;
  const dy = demoTarget.y - player.pos.y;
  if (Math.abs(dx) + Math.abs(dy) < 0.6) { pickDemoTarget(); demoStuckT = 0; return vec2(0, 0); }
  if (Math.abs(dx) > Math.abs(dy)) return vec2(dx > 0 ? 1 : -1, 0);
  return vec2(0, dy > 0 ? 1 : -1);
}
function startGame() {
  started = true;
  player.pos = vec2(playerSpawn.x, playerSpawn.y);
  player.knock = vec2(0, 0);
  entityTarget = 60;
  syncEntityCount();
  const t = document.getElementById('title');
  if (t) t.style.display = 'none';
}

function tryMove(pos, delta) {
  // 軸ごとに衝突判定 (壁ずり)
  const r = 0.3; // 当たり半径(タイル単位)
  let nx = pos.x + delta.x;
  const checkX = delta.x > 0 ? nx + r : nx - r;
  if (!BLOCKED[mapAt(worldToTileX(checkX), worldToTileY(pos.y))]) pos.x = nx;

  let ny = pos.y + delta.y;
  const checkY = delta.y > 0 ? ny + r : ny - r;
  if (!BLOCKED[mapAt(worldToTileX(pos.x), worldToTileY(checkY))]) pos.y = ny;
}

function gameUpdate() {
  const dt = timeDelta; // LittleJS固定 1/60

  // Enter でデモ→プレイ開始
  if (!started && keyWasPressed('Enter')) startGame();

  // ---- 入力 (WASD/矢印) / アトラクト中は共有デモシミュレーション ----
  let dash = false;
  if (!started) {
    // デモ中は共有シミュレーションで自機を駆動（全エンジン同一の経路）
    simStep(dt);
    player.pos = simToWorldPos();
    player.knock = vec2(0, 0);
    dashOn = false;
  } else {
    let mx = 0, my = 0;
    if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) mx -= 1;
    if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) mx += 1;
    // LittleJS は Y上向き: 上キー = +Y
    if (keyIsDown('ArrowUp') || keyIsDown('KeyW')) my += 1;
    if (keyIsDown('ArrowDown') || keyIsDown('KeyS')) my -= 1;
    dash = keyIsDown('ShiftLeft') || keyIsDown('ShiftRight');
    dashOn = dash;
    const spd = MOVE_SPEED * (dash ? 2 : 1);
    const mv = vec2(mx, my);
    if (mv.length() > 0) tryMove(player.pos, mv.normalize(spd * dt));
  }

  // ノックバック適用
  if (player.knock.length() > 0.001) {
    tryMove(player.pos, player.knock.scale(dt));
    player.knock = player.knock.scale(0.85);
  }

  // ---- エンティティ数 増減 (+/-) ----
  // テンキー/メイン行どちらでも反応
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    entityTarget = Math.min(2000, entityTarget + 20);
    syncEntityCount();
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    entityTarget = Math.max(0, entityTarget - 20);
    syncEntityCount();
  }

  // ---- エンティティ徘徊 ----
  for (const e of entities) {
    e.nextTurn -= dt;
    if (e.nextTurn <= 0) {
      e.dir = vec2(entRng() * 2 - 1, entRng() * 2 - 1).normalize();
      e.nextTurn = 0.6 + entRng() * 2;
    }
    const before = e.pos.copy ? e.pos.copy() : vec2(e.pos.x, e.pos.y);
    tryMove(e.pos, e.dir.scale(e.speed * dt));
    // 進めなかったら方向転換
    if (Math.abs(e.pos.x - before.x) < 1e-5 && Math.abs(e.pos.y - before.y) < 1e-5) {
      e.dir = e.dir.scale(-1);
      e.nextTurn = 0.3 + entRng();
    }

    // 自機接触でノックバック
    const d = e.pos.subtract(player.pos);
    if (d.length() < 0.6) {
      const push = d.length() > 1e-4 ? d.normalize() : vec2(1, 0);
      player.knock = push.scale(6);
    }
  }

  // ---- カメラ自機追従 ----
  setCameraPos(player.pos);

  // ---- タイトル点滅 (アトラクト中のみ) ----
  if (!started) {
    blinkT += dt;
    const t = document.getElementById('title');
    if (t) t.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
  }
}

function gameUpdatePost() {}

// ---- タイル/エンティティ描画 (カリング) ----
function drawTileCell(tx, ty) {
  const t = mapAt(tx, ty);
  const wpos = tileToWorld(tx, ty);

  if (t === T_TREE) {
    treesDrawnThisFrame++;
    // 木: 足元は草、その上に木スプライト/三角
    drawRect(wpos, vec2(1, 1), new Color(0.25, 0.5, 0.18));
    if (texLoaded(IMG.tree)) {
      // 木は 32x48 想定 → 高さ1.5タイルぶん上にオフセット
      drawTile(wpos.add(vec2(0, 0.25)), vec2(1, 1.5), texTile(IMG.tree));
    } else {
      drawRect(wpos.add(vec2(0, -0.1)), vec2(0.18, 0.5), new Color(0.4, 0.25, 0.1)); // 幹
      drawRect(wpos.add(vec2(0, 0.25)), vec2(0.8, 0.8), new Color(0.13, 0.4, 0.13)); // 葉
    }
    return;
  }

  if (texLoaded(IMG[['grass', 'path', 'water', 'wall'][t]])) {
    drawTile(wpos, vec2(1, 1), texTile(t));
  } else {
    const c = TILE_COLORS[t];
    drawRect(wpos, vec2(1, 1), new Color().setHex(c));
  }
}

function gameRender() {
  tilesDrawnThisFrame = 0;
  treesDrawnThisFrame = 0;

  // 可視タイル範囲を算出 (カメラ中心 ± 画面半分 + 余白)
  const halfW = (VIEW_W / TILE) / 2;
  const halfH = (VIEW_H / TILE) / 2;
  const cam = cameraPos;

  // ワールドX → タイルX
  const minWX = cam.x - halfW - 1, maxWX = cam.x + halfW + 1;
  const minWY = cam.y - halfH - 2, maxWY = cam.y + halfH + 2; // 木の高さぶん余白

  let txMin = Math.floor(minWX);
  let txMax = Math.ceil(maxWX);
  // Y反転: worldToTileY は大きいworldY→小さいtileY
  let tyTop = worldToTileY(maxWY);
  let tyBot = worldToTileY(minWY);

  txMin = Math.max(0, txMin); txMax = Math.min(MAP_W - 1, txMax);
  tyTop = Math.max(0, tyTop); tyBot = Math.min(MAP_H - 1, tyBot);

  for (let ty = tyTop; ty <= tyBot; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      drawTileCell(tx, ty);
      tilesDrawnThisFrame++;
    }
  }

  // エンティティ描画 (画面内のみ)
  for (const e of entities) {
    if (e.pos.x < minWX - 1 || e.pos.x > maxWX + 1 ||
        e.pos.y < minWY - 1 || e.pos.y > maxWY + 1) continue;
    if (e.slime) {
      if (texLoaded(IMG.slime)) drawTile(e.pos, vec2(1, 1), texTile(IMG.slime));
      else drawRect(e.pos, vec2(0.7, 0.55), new Color(0.3, 0.85, 0.35)); // 緑丸代用
    } else {
      if (texLoaded(IMG.npc)) drawTile(e.pos, vec2(1, 1), texTile(IMG.npc));
      else drawRect(e.pos, vec2(0.7, 0.7), new Color(0.95, 0.85, 0.2)); // 黄
    }
  }

  // 自機
  if (texLoaded(IMG.player)) drawTile(player.pos, vec2(1, 1), texTile(IMG.player));
  else {
    drawRect(player.pos, vec2(0.7, 0.7), new Color(1, 1, 1));
    drawRect(player.pos, vec2(0.5, 0.5), new Color(0.2, 0.4, 0.9));
  }
}

// ---- HUD (overlayCanvas に直接描画して最前面化) ----
function gameRenderPost() {
  // FPS 移動平均を自前算出
  const now = performance.now();
  const dtMs = now - lastNow;
  lastNow = now;
  if (dtMs > 0) {
    const inst = 1000 / dtMs;
    fpsAvg = fpsAvg * FPS_SMOOTH + inst * (1 - FPS_SMOOTH);
  }

  const ptx = worldToTileX(player.pos.x);
  const pty = worldToTileY(player.pos.y);
  const trees = countTreesApprox();   // 木の総数（three.js の treeCount）
  // HUD は他エンジンと同じく HTML オーバーレイ（#hud）。表示内容・書式は three.js に統一。
  if (hudEl) hudEl.textContent =
    `FPS         : ${fpsAvg.toFixed(1)}\n` +
    `Tiles drawn : ${tilesDrawnThisFrame}  (trees: ${treesDrawnThisFrame})\n` +
    `Entities    : ${entities.length + trees}  (NPC+敵:${entities.length} / 木:${trees})\n` +
    `Player tile : (${ptx}, ${pty})  ${dashOn ? '[DASH]' : ''}`;
}

// 可視範囲の木の数は重いので、マップ全体の木の総数をキャッシュして表示
let _treeTotal = -1;
function countTreesApprox() {
  if (_treeTotal < 0) {
    let c = 0;
    for (let i = 0; i < map.length; i++) if (map[i] === T_TREE) c++;
    _treeTotal = c;
  }
  return _treeTotal;
}

// =====================================================
//  起動: WebGL を無効化してから engineInit
// =====================================================
// WebGL を engineInit 前に無効化 (HUD重なり回避 / 2D一本化)。
// グローバル代入 glEnable=false でも良いが、setGLEnable は glCanvas も隠すため安全。
glEnable = false;
if (typeof setGLEnable === 'function') setGLEnable(false);

// 第7引数に #game-container を渡し、960x540 の固定枠内に canvas を生成して
// 他エンジンと表示サイズ・位置・HUD配置を揃える。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
