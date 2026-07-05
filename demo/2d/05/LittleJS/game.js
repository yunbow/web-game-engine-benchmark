'use strict';

/*
  テーマ5 横スクロールアクション ― LittleJS 版
  --------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / タイル 32x32 / マップ 200x17 (=6400x544px, 決定的生成)
   - 0=空 1=地面(ground) 2=ブロック(brick) 3=土管(pipe), solid={1,2,3}
   - 自機: 当たり 24x44(描画32x48) 歩き180 ダッシュ288 重力1800 ジャンプ-640 可変ジャンプ
   - 敵(goomba): 28x28 歩行60 重力あり 壁で反転 / 踏みで撃破(+100,跳ね-380) 横接触でHP-1(無敵1.0s)
   - コイン: 決定的配置 接触で+50/Coins++ / +/- で敵数 20初期 ±10 (0..500)
   - 可視範囲のタイルのみ描画(カリング) / HUD: FPS/Tiles drawn/Entities/座標/Score/Coins/HP/Enemies

  ★ 座標系 / Y軸メモ (最重要) ★
   - LittleJS のワールドは Y軸"上向き"。テーマ3 LittleJS 同様、cameraScale=1 (1ワールド=1px) とし、
     ゲーム論理も「px・Y上向き」の一貫モデルで保持する(画面下=Y小, 画面上=Y大)。
   - タイル配列 row 0 を画面"上"に出すため、worldY = (MAP_H*TILE) - (ty*TILE) で上下反転配置。
     描画時のみ tileToWorld() で変換する(テーマ3の worldToTileY と同じ思想)。
   - したがって "重力" は画面下=Y減少方向なので velY に -gravity を積む。
     "ジャンプ初速 -640(上)" は SPEC の符号だが、本実装の y-up では上昇=+Y なので velY=+640 で表現。
     符号規約を一箇所(JUMP_VEL)に閉じ込め、入力・物理・カメラ・座標表示すべて同じ規約で通す。
   - カメラは setCameraPos で自機を水平追従(x クランプ)。高さ544≈540 のため y はほぼ固定。
   - 画像が無くても起動する必要があるため textureInfos[i].size で読込判定し、
     未読込なら drawRect/drawCircle の図形フォールバックで描画する。
*/

// ---- 画面・マップ定数 (SPEC) ----
const TILE = 32;                       // 1タイル px (=カメラスケール…ではなく論理px)
const MAP_W = 200, MAP_H = 17;         // マップタイル数 (6400 x 544 px)
const VIEW_W = 960, VIEW_H = 540;      // 固定キャンバス
const WORLD_W = MAP_W * TILE;          // 6400
const WORLD_H = MAP_H * TILE;          // 544

// ---- タイル種別 ----
const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = { 1: true, 2: true, 3: true }; // 進入不可

// ---- 物理数値 (SPEC, px / s) ----
const GRAVITY = 1800;        // 重力 px/s^2 (画面下方向 = -Y へ)
const WALK_SPEED = 180;      // 歩き
const DASH_SPEED = 288;      // ダッシュ (=180*1.6)
const JUMP_VEL = 640;        // ジャンプ初速(上=+Y。SPEC の -640 と符号が反転するだけ)
const JUMP_CUT = 0.45;       // 可変ジャンプ: キーを離した時の上昇減衰係数
const STOMP_BOUNCE = 380;    // 踏みつけ後の跳ね(上=+Y)
const PLAYER_W = 24, PLAYER_H = 44;       // 当たり判定
const PLAYER_DRAW_W = 32, PLAYER_DRAW_H = 48; // 描画
const ENEMY_SIZE = 28;       // 敵 当たり=描画
const ENEMY_SPEED = 60;      // 敵 水平歩行
const COIN_SIZE = 24;
const START_HP = 3;
const INVULN_TIME = 1.0;     // 被弾後無敵
const FALL_LIMIT = -64;      // これより下(Y)に落ちたら穴落下扱い

// ---- 敵数(負荷) ----
let enemyTarget = 20;        // 設定値(初期20)
const ENEMY_STEP = 10, ENEMY_MIN = 0, ENEMY_MAX = 500;

// ---- 図形フォールバック色 ----
const TILE_COLORS = {
  1: new Color(0.55, 0.36, 0.18),  // 地面=茶
  2: new Color(0.95, 0.55, 0.15),  // ブロック=橙
  3: new Color(0.20, 0.70, 0.25),  // 土管=緑
};

// ---- imageSources (../assets/, SPEC のファイル名/インデックスに厳密一致) ----
const imageSources = [
  '../assets/player.png',        // 0 (32x48)
  '../assets/enemy_goomba.png',  // 1
  '../assets/tile_ground.png',   // 2
  '../assets/tile_brick.png',    // 3
  '../assets/tile_pipe.png',     // 4
  '../assets/coin.png',          // 5 (24x24)
  '../assets/bg_sky.png',        // 6 (512x512)
  '../assets/player_walk.png',   // 7 (4x32x48)
  '../assets/enemy_goomba_walk.png', // 8 (4x32x32)
];
const TEX = {
  player: 0, goomba: 1, ground: 2, brick: 3, pipe: 4, coin: 5, bg: 6,
  playerWalk: 7, goombaWalk: 8,
};
// タイルID -> テクスチャindex
const TILE_TEX = { 1: TEX.ground, 2: TEX.brick, 3: TEX.pipe };

// ---- グローバル状態 ----
let map;                 // Uint8Array MAP_W*MAP_H, idx = ty*MAP_W+tx
let player;              // {x,y,vx,vy,grounded,face,invuln}
let spawnPoint;          // {x,y} スポーン地点(px, y-up)
let enemies = [];        // goomba 配列
let coins = [];          // {x,y,taken}
let score = 0, coinCount = 0, hp = START_HP;
let tilesDrawnThisFrame = 0;
let useSprites = false;

// ---- タイトル/アトラクト状態 (false=デモ中・操作無効) ----
let started = false, blinkT = 0;
let titleEl = null;            // #title overlay (gameInit で取得)

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

// ---- ワールド(px, y-up) <-> タイル座標の変換 ----
// マップ row 0 を画面上に出すため Y を反転。タイル(tx,ty)の中心ワールド座標。
function tileCenterWorld(tx, ty) {
  return vec2(tx * TILE + TILE / 2, WORLD_H - (ty * TILE + TILE / 2));
}
// 任意のワールドY(px) -> タイルY (上=row小)
function worldToTileY(wy) { return Math.floor((WORLD_H - wy) / TILE); }
function worldToTileX(wx) { return Math.floor(wx / TILE); }

function mapAt(tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return T_GROUND; // 外周は壁扱い
  return map[ty * MAP_W + tx];
}
function isSolid(tx, ty) { return !!SOLID[mapAt(tx, ty)]; }

// ===================================================================
//  マップ決定的生成
// ===================================================================
function generateMap() {
  map = new Uint8Array(MAP_W * MAP_H);
  const rng = makeRng(20260614); // 固定シード(全エンジン共通の見た目を狙う)

  // 最下段2行を地面に。地面runを敷いた後に幅1の穴を1つだけ開ける(連続穴を防ぐ)。
  const GROUND_TOP = MAP_H - 2; // 地面上面のタイル行
  for (let tx = 0; tx < MAP_W; ) {
    const run = 5 + Math.floor(rng() * 6);
    for (let i = 0; i < run && tx < MAP_W; i++, tx++) {
      map[(MAP_H - 1) * MAP_W + tx] = T_GROUND;
      map[GROUND_TOP * MAP_W + tx] = T_GROUND;
    }
    if (tx > 12 && tx < MAP_W - 6 && rng() < 0.30) tx += 1; // 幅1の穴
  }

  // 空中のブロック足場: ジャンプ頂点より上(行<=9)に置き、走路に天井を作らない。
  for (let p = 0; p < 60; p++) {
    const len = 2 + Math.floor(rng() * 4);
    const sx = 8 + Math.floor(rng() * (MAP_W - 16));
    const sy = 4 + Math.floor(rng() * 6);   // 4..9 (上空)
    for (let i = 0; i < len; i++) {
      const tx = sx + i;
      if (tx > 0 && tx < MAP_W - 1) map[sy * MAP_W + tx] = T_BRICK;
    }
  }

  // 土管(pipe): 地上に高さ2〜3。穴の近く(±4)には置かない(越えジャンプが穴に着地するため)。
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (mapAt(g, GROUND_TOP) !== T_GROUND) return false;
    return true;
  };
  for (let p = 0; p < 18; p++) {
    const tx = 14 + Math.floor(rng() * (MAP_W - 24));
    const h = 2 + Math.floor(rng() * 2);
    if (mapAt(tx, GROUND_TOP) !== T_GROUND || !noGapNear(tx)) continue;
    for (let i = 1; i <= h; i++) {
      const ty = GROUND_TOP - i;
      if (ty > 0) map[ty * MAP_W + tx] = T_PIPE;
    }
  }

  // 左右端は壁(縦一列を地面で塞ぐ)
  for (let ty = 0; ty < MAP_H; ty++) {
    map[ty * MAP_W + 0] = T_GROUND;
    map[ty * MAP_W + (MAP_W - 1)] = T_GROUND;
  }
}

// 地面上面 row を返す(穴なら -1)。スポーン位置探索用。
function groundTopRow(tx) {
  for (let ty = 0; ty < MAP_H; ty++) {
    if (isSolid(tx, ty)) return ty;
  }
  return -1;
}

// ===================================================================
//  エンティティ生成 (決定的)
// ===================================================================
const COIN_RNG_SEED = 99001;
const ENEMY_RNG_SEED = 4242;

function generateCoins() {
  coins = [];
  const rng = makeRng(COIN_RNG_SEED);
  for (let c = 0; c < 120; c++) {
    const tx = 5 + Math.floor(rng() * (MAP_W - 10));
    const top = groundTopRow(tx);
    if (top < 0) continue;             // 穴の上には置かない
    // 地面/足場の 1〜3 タイル上の空中に配置
    const above = 1 + Math.floor(rng() * 3);
    const ty = top - above;
    if (ty < 1 || mapAt(tx, ty) !== T_EMPTY) continue;
    const w = tileCenterWorld(tx, ty);
    coins.push({ x: w.x, y: w.y, taken: false });
  }
}

// 敵は「足場のある地形」に決定的にスポーンさせる。
// enemyTarget の増減に対し決定的: シードから順に index 番目の候補を採用。
function buildEnemySpawnCandidates() {
  const rng = makeRng(ENEMY_RNG_SEED);
  const cand = [];
  // マップ全幅から地面のある列を拾い、その上面 1 タイル上に候補を作る。
  for (let attempt = 0; attempt < ENEMY_MAX * 4 && cand.length < ENEMY_MAX; attempt++) {
    const tx = 12 + Math.floor(rng() * (MAP_W - 20));
    const top = groundTopRow(tx);
    if (top < 1) continue;
    const ty = top - 1;
    if (mapAt(tx, ty) !== T_EMPTY) continue;
    const w = tileCenterWorld(tx, ty);
    // 敵の足元を上面に合わせる(中心を上面+半身)
    cand.push({ x: w.x, y: WORLD_H - top * TILE + ENEMY_SIZE / 2, dir: rng() < 0.5 ? -1 : 1 });
  }
  return cand;
}
let enemySpawnCandidates = [];

function syncEnemyCount() {
  // 決定的: 先頭から enemyTarget 体を採用。配置・初期向きは固定。
  enemies = [];
  for (let i = 0; i < enemyTarget && i < enemySpawnCandidates.length; i++) {
    const c = enemySpawnCandidates[i];
    enemies.push({ x: c.x, y: c.y, vx: ENEMY_SPEED * c.dir, vy: 0, alive: true });
  }
}

// ---- ヒットスパーク(撃破エフェクト) ----
let sparks = [];
function addSpark(x, y) { sparks.push({ x, y, t: 0, life: 0.3 }); }

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
function spriteFrame(i, w, h, frame, row = 0) { return tile(vec2(frame * w, row * h), vec2(w, h), i); }

// ===================================================================
//  AABB タイル衝突 (軸分離)
// ===================================================================
// box 中心(cx,cy), 半幅 hw, 半高 hh が solid タイルと重なるか。
function boxHitsSolid(cx, cy, hw, hh) {
  const left = cx - hw, right = cx + hw;
  const bottom = cy - hh, top = cy + hh; // y-up: top>bottom
  const txMin = worldToTileX(left + 0.001);
  const txMax = worldToTileX(right - 0.001);
  // y-up なので worldToTileY は上(大Y)→小row。top=大Y→小row, bottom=小Y→大row。
  const tyMin = worldToTileY(top - 0.001);
  const tyMax = worldToTileY(bottom + 0.001);
  for (let ty = tyMin; ty <= tyMax; ty++)
    for (let tx = txMin; tx <= txMax; tx++)
      if (isSolid(tx, ty)) return true;
  return false;
}

// 軸ごとに移動を解決。x→解決, y→解決。接地フラグ更新。
function movePlayer(p, dt) {
  const hw = PLAYER_W / 2, hh = PLAYER_H / 2;

  // --- X 軸 ---
  let nx = p.x + p.vx * dt;
  if (boxHitsSolid(nx, p.y, hw, hh)) {
    // タイル境界へスナップ(壁ずり)
    if (p.vx > 0) {
      const tx = worldToTileX(nx + hw);
      nx = tx * TILE - hw - 0.01;
    } else if (p.vx < 0) {
      const tx = worldToTileX(nx - hw);
      nx = (tx + 1) * TILE + hw + 0.01;
    }
    p.vx = 0;
  }
  p.x = nx;

  // --- Y 軸 ---
  p.grounded = false;
  let ny = p.y + p.vy * dt;
  if (boxHitsSolid(p.x, ny, hw, hh)) {
    if (p.vy < 0) {
      // 下降中に着地 (画面下=Y減) → 床上面へスナップ
      const tyFloor = worldToTileY(ny - hh);          // 床タイル row
      const floorTopY = WORLD_H - tyFloor * TILE;      // その上面のワールドY
      ny = floorTopY + hh + 0.01;
      p.grounded = true;
    } else if (p.vy > 0) {
      // 上昇中に天井 (Y増) → 天井下面へスナップ
      const tyCeil = worldToTileY(ny + hh);
      const ceilBotY = WORLD_H - (tyCeil + 1) * TILE;
      ny = ceilBotY - hh - 0.01;
    }
    p.vy = 0;
  }
  p.y = ny;
}

// 敵の移動(軸分離 + 壁で反転)
function moveEnemy(e, dt) {
  const hs = ENEMY_SIZE / 2;
  // X
  let nx = e.x + e.vx * dt;
  if (boxHitsSolid(nx, e.y, hs, hs)) {
    e.vx = -e.vx;            // 壁衝突で反転
    nx = e.x;
  }
  e.x = nx;
  // Y (重力)
  e.vy -= GRAVITY * dt;       // 画面下=Y減
  let ny = e.y + e.vy * dt;
  if (boxHitsSolid(e.x, ny, hs, hs)) {
    if (e.vy < 0) {
      const tyFloor = worldToTileY(ny - hs);
      const floorTopY = WORLD_H - tyFloor * TILE;
      ny = floorTopY + hs + 0.01;
    } else {
      const tyCeil = worldToTileY(ny + hs);
      const ceilBotY = WORLD_H - (tyCeil + 1) * TILE;
      ny = ceilBotY - hs - 0.01;
    }
    e.vy = 0;
  }
  e.y = ny;
}

// ---- AABB 重なり判定 (中心+半サイズ) ----
function aabbOverlap(ax, ay, ahw, ahh, bx, by, bhw, bhh) {
  return Math.abs(ax - bx) < ahw + bhw && Math.abs(ay - by) < ahh + bhh;
}

// ===================================================================
//  自機リスポーン
// ===================================================================
function respawnPlayer() {
  player.x = spawnPoint.x;
  player.y = spawnPoint.y;
  player.vx = 0; player.vy = 0;
  player.grounded = false;
  player.invuln = 0;
  hp = START_HP;             // HP を 3 に戻す(スコア・敵は保持)
}

// ===================================================================
//  デモAI / タイトル開始
// ===================================================================
// デモAI (決定的, Math.random 不使用): 右走行 + 接地時に前方の壁/穴で自動ジャンプ。
// ※本実装は Y軸"上向き"・座標は"中心"基準。three.js 版(Y下向き・左上基準)の demoAI を
//   この座標系へ移植する:
//    - 前方 = x + 半幅 + 余白。中段 = 中心 y、足元 = 中心 y - 半高(=下端)。
//    - 穴判定 = 数タイル先の足元"直下"のタイルが空。
//    - ジャンプ: 接地中は 壁 or 穴 で発火 / 空中で上昇中(y-up は vy>0)は保持(可変ジャンプ伸長)。
function demoAI(p) {
  const hw = PLAYER_W / 2, hh = PLAYER_H / 2;
  const aheadX = p.x + hw + 4;
  const midY = p.y;                 // 体の中段(中心)
  const footY = p.y - hh + 2;       // 足元(下端のすぐ内側)
  const tAhead = worldToTileX(aheadX);
  const wallAhead =
    isSolid(tAhead, worldToTileY(midY)) ||
    isSolid(tAhead, worldToTileY(footY));
  // 前方の穴: 数タイル先の足元直下(さらに下=Y減)に地面が無い
  const gapProbeX = p.x + hw + TILE * 1.2;
  const belowY = (p.y - hh) - TILE * 0.5;   // 足元より下(Y減方向)
  const gapAhead = p.grounded &&
    !isSolid(worldToTileX(gapProbeX), worldToTileY(belowY));
  let jump = false;
  if (p.grounded) jump = wallAhead || gapAhead;
  else if (p.vy > 0) jump = true;   // 上昇中(y-up: vy>0)は保持
  return { move: 1, jump };
}

// Enter でデモ→プレイ開始: スコア/コイン/敵を新規リセットし操作有効化、タイトルを消す。
function startGame() {
  started = true;
  score = 0; coinCount = 0;
  for (const c of coins) c.taken = false;   // コインを全復活
  enemyTarget = 20;                          // ENEMY_INIT
  syncEnemyCount();
  respawnPlayer();
  if (titleEl) titleEl.style.display = 'none';
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);              // 1ワールド単位 = 1px (テーマ3と思想は同じ, スケールは1)
  setGravity(vec2(0, 0));         // エンジン物理は使わず自前実装

  // テクスチャ読込判定(1枚でも読めれば sprites 使用)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  generateMap();
  generateCoins();
  enemySpawnCandidates = buildEnemySpawnCandidates();

  // スポーン地点: tx=3 の地面上面の少し上
  const startTx = 3;
  const top = groundTopRow(startTx);
  const sy = WORLD_H - top * TILE + PLAYER_H / 2; // 上面 + 半身
  spawnPoint = { x: startTx * TILE + TILE / 2, y: sy };

  player = {
    x: spawnPoint.x, y: spawnPoint.y, vx: 0, vy: 0,
    grounded: false, face: 1, invuln: 0,
  };

  enemyTarget = 20;
  syncEnemyCount();
  score = 0; coinCount = 0; hp = START_HP;
  sparks = [];

  // タイトル/アトラクト初期化
  titleEl = document.getElementById('title');
  started = false; blinkT = 0;
}

function gameUpdate() {
  const dt = timeDelta; // デルタタイム基準 (LittleJS 既定 1/60)

  // ---- Enter でデモ→プレイ開始 ----
  if (!started && keyWasPressed('Enter')) startGame();

  // ---- 敵数 増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    enemyTarget = clamp(enemyTarget + ENEMY_STEP, ENEMY_MIN, ENEMY_MAX);
    syncEnemyCount();
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    enemyTarget = clamp(enemyTarget - ENEMY_STEP, ENEMY_MIN, ENEMY_MAX);
    syncEnemyCount();
  }

  // ---- 入力: 水平移動 / ジャンプ ----
  // アトラクト中(!started)は操作無効・デモAIが自機を駆動。通常時はキー入力。
  let mx = 0, jumpHeld = false, spd = WALK_SPEED;
  if (!started) {
    const d = demoAI(player);
    mx = d.move; jumpHeld = d.jump;
  } else {
    if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) mx -= 1;
    if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) mx += 1;
    const dash = keyIsDown('ShiftLeft') || keyIsDown('ShiftRight');
    spd = dash ? DASH_SPEED : WALK_SPEED;
    jumpHeld = keyIsDown('Space') || keyIsDown('ArrowUp') || keyIsDown('KeyW');
  }
  player.vx = mx * spd;
  if (mx !== 0) player.face = mx;

  // ---- ジャンプ(接地時のみ) + 可変ジャンプ ----
  if (jumpHeld && player.grounded) {
    player.vy = JUMP_VEL;     // 上昇=+Y
  }
  // 可変ジャンプ: 上昇中(vy>0)にキーを離したら上昇を減衰
  if (!jumpHeld && player.vy > 0) {
    player.vy *= JUMP_CUT;
  }

  // ---- 重力(画面下=Y減なので -GRAVITY) ----
  player.vy -= GRAVITY * dt;

  // ---- 物理解決(軸分離 AABB) ----
  movePlayer(player, dt);

  // ---- 穴落下判定 → HP-1 + リスポーン ----
  if (player.y < FALL_LIMIT) {
    hp -= 1;
    if (hp <= 0) { respawnPlayer(); }
    else {
      // HP は減らしたまま、位置だけスポーンへ
      player.x = spawnPoint.x; player.y = spawnPoint.y;
      player.vx = 0; player.vy = 0; player.invuln = INVULN_TIME;
    }
  }

  if (player.invuln > 0) player.invuln -= dt;

  // ---- 敵更新 ----
  const phw = PLAYER_W / 2, phh = PLAYER_H / 2, ehs = ENEMY_SIZE / 2;
  for (const e of enemies) {
    if (!e.alive) continue;
    moveEnemy(e, dt);

    // 自機との衝突
    if (aabbOverlap(player.x, player.y, phw, phh, e.x, e.y, ehs, ehs)) {
      // 踏みつけ: 自機が落下中(vy<0=下降) かつ 自機足元が敵中心より上
      const stomping = player.vy < 0 && (player.y - phh) > e.y - ehs * 0.4;
      if (stomping) {
        e.alive = false;
        score += 100;
        addSpark(e.x, e.y);
        player.vy = STOMP_BOUNCE;  // 跳ね(上=+Y)
      } else if (player.invuln <= 0) {
        // 横接触: 被弾(HP-1, ノックバック, 無敵)
        hp -= 1;
        player.invuln = INVULN_TIME;
        const dir = (player.x < e.x) ? -1 : 1;
        player.vx = dir * 220;
        player.vy = 260;
        if (hp <= 0) respawnPlayer();
      }
    }
  }
  // 撃破済み敵を除去
  for (let i = enemies.length - 1; i >= 0; i--) if (!enemies[i].alive) enemies.splice(i, 1);

  // ---- コイン取得 ----
  const chs = COIN_SIZE / 2;
  for (const c of coins) {
    if (c.taken) continue;
    if (aabbOverlap(player.x, player.y, phw, phh, c.x, c.y, chs, chs)) {
      c.taken = true;
      coinCount += 1;
      score += 50;
    }
  }

  // ---- スパーク更新 ----
  for (let i = sparks.length - 1; i >= 0; i--) {
    sparks[i].t += dt;
    if (sparks[i].t >= sparks[i].life) sparks.splice(i, 1);
  }

  // ---- カメラ自機水平追従 (x クランプ, y はほぼ固定) ----
  const camX = clamp(player.x, VIEW_W / 2, WORLD_W - VIEW_W / 2);
  const camY = WORLD_H / 2;  // 高さ544≈540 のためほぼ縦スクロール無し
  setCameraPos(vec2(camX, camY));
}

function gameUpdatePost() {}

// ===================================================================
//  描画 (ワールド空間, カリング)
// ===================================================================
function gameRender() {
  tilesDrawnThisFrame = 0;
  const cam = cameraPos;

  // ---- 背景(空) ----
  if (spriteReady(TEX.bg)) {
    // 画面全体を覆うようカメラ中心にタイル描画(視差は付けず単純表示)
    drawTile(vec2(cam.x, cam.y), vec2(VIEW_W, VIEW_H), tile(0, textureInfos[TEX.bg].size, TEX.bg));
  } else {
    drawRect(vec2(cam.x, cam.y), vec2(VIEW_W, VIEW_H), new Color(0.46, 0.73, 0.96)); // 空色
  }

  // ---- 可視タイル範囲を算出(カリング) ----
  const minWX = cam.x - VIEW_W / 2, maxWX = cam.x + VIEW_W / 2;
  let txMin = Math.floor(minWX / TILE) - 1;
  let txMax = Math.floor(maxWX / TILE) + 1;
  txMin = Math.max(0, txMin); txMax = Math.min(MAP_W - 1, txMax);
  // 縦はマップ全高が画面内に収まるため全行描画(0..MAP_H-1)
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const t = mapAt(tx, ty);
      if (t === T_EMPTY) continue;
      const w = tileCenterWorld(tx, ty);
      const texI = TILE_TEX[t];
      if (spriteReady(texI)) {
        drawTile(w, vec2(TILE, TILE), texTile(texI));
      } else {
        drawRect(w, vec2(TILE, TILE), TILE_COLORS[t]);
      }
      tilesDrawnThisFrame++;
    }
  }

  // ---- コイン(画面内のみ) ----
  for (const c of coins) {
    if (c.taken) continue;
    if (c.x < minWX - TILE || c.x > maxWX + TILE) continue;
    if (spriteReady(TEX.coin)) {
      drawTile(vec2(c.x, c.y), vec2(COIN_SIZE, COIN_SIZE), texTile(TEX.coin));
    } else {
      drawCircle(vec2(c.x, c.y), COIN_SIZE / 2, new Color(1, 0.85, 0.15)); // 黄丸
    }
  }

  // ---- 敵(画面内のみ) ----
  for (const e of enemies) {
    if (e.x < minWX - TILE || e.x > maxWX + TILE) continue;
    if (spriteReady(TEX.goombaWalk)) {
      const frame = Math.floor((time * 7) + e.x * 0.01) % 4;
      drawTile(vec2(e.x, e.y), vec2(ENEMY_SIZE, ENEMY_SIZE), spriteFrame(TEX.goombaWalk, 32, 32, frame, e.vx < 0 ? 1 : 0));
    } else if (spriteReady(TEX.goomba)) {
      drawTile(vec2(e.x, e.y), vec2(ENEMY_SIZE, ENEMY_SIZE), texTile(TEX.goomba));
    } else {
      drawCircle(vec2(e.x, e.y), ENEMY_SIZE / 2, new Color(0.55, 0.30, 0.12)); // 茶丸
    }
  }

  // ---- 自機(無敵中は点滅) ----
  const blink = player.invuln > 0 && (Math.floor(player.invuln * 20) % 2 === 0);
  if (!blink) {
    if (spriteReady(TEX.playerWalk)) {
      const frame = Math.abs(player.vx) > 5 && player.grounded ? Math.floor(time * 9) % 4 : 0;
      const sz = vec2(PLAYER_DRAW_W, PLAYER_DRAW_H);
      drawTile(vec2(player.x, player.y), sz, spriteFrame(TEX.playerWalk, 32, 48, frame, player.face < 0 ? 1 : 0));
    } else if (spriteReady(TEX.player)) {
      // face で左右反転(size.x を負に)
      const sz = vec2(PLAYER_DRAW_W * player.face, PLAYER_DRAW_H);
      drawTile(vec2(player.x, player.y), sz, texTile(TEX.player));
    } else {
      drawRect(vec2(player.x, player.y), vec2(PLAYER_DRAW_W, PLAYER_DRAW_H), new Color(0.9, 0.18, 0.18)); // 赤矩形
    }
  }

  // ---- ヒットスパーク ----
  for (const s of sparks) {
    const k = s.t / s.life;
    drawCircle(vec2(s.x, s.y), 6 + k * 18, new Color(1, 0.95, 0.4, 1 - k));
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function gameRenderPost() {
  // FPS 指数移動平均(エンジン内蔵 frameRate を平滑化)
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const ptx = worldToTileX(player.x);
  const pty = worldToTileY(player.y);
  const entities = enemies.length + coins.filter(c => !c.taken).length;

  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS         : ' + fpsAvg.toFixed(1) + '\n' +
      'Tiles drawn : ' + tilesDrawnThisFrame + '\n' +
      'Entities    : ' + entities + '  (敵 ' + enemies.length + ' + コイン ' + coins.filter(c => !c.taken).length + ')\n' +
      'Player      : (' + ptx + ', ' + pty + ')\n' +
      'Score       : ' + score + '   Coins: ' + coinCount + '   HP: ' + Math.max(0, hp) + '\n' +
      'Enemies     : ' + enemies.length + ' / ' + enemyTarget +
      (useSprites ? '   [sprites]' : '   [shapes fallback]');
  }

  // ---- タイトル点滅 (アトラクト中のみ, 約0.45s周期) ----
  if (!started && titleEl) {
    blinkT += timeDelta;
    titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
  }
}

// ===================================================================
//  起動: engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)
// ===================================================================
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources);
