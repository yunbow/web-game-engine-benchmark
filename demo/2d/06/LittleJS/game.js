'use strict';

/*
  テーマ6 タワーディフェンス(経路探索 × 多数ユニット追従) ― LittleJS 版
  --------------------------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / タイル 32x32 / グリッド 30x17 (=960x544px, 決定的生成)
   - 0=通路(path/buildable) 1=壁(wall, 配置・通行不可)
   - スタート=左端中央 / ゴール=右端中央。外周は壁(開口部のみ空ける)+内部に決定的な障害物。
   - A*(4方向, コスト1, マンハッタン距離)でスタート→ゴール経路を計算。
     壁 AND タワータイルを通行不可として扱い、設置/撤去で再計算(Path recalcs++)。
     ゴール到達不能になる配置は拒否。
   - 敵(creep): 半径10(描画径~24) 移動70px/s HP30。0.5s間隔で上限まで供給。
     経路(タイル中心の列)に沿って進む。経路が変わると現在地から再追従。
     ゴール到達→Lives-1+消滅 / HP0→Gold+5,Score+10,hit_spark。
   - タワー: 射程96 連射0.6s ダメージ10。射程内の最も進行度が高い敵を狙い projectile 発射。
     弾速320px/s, 当たり判定 距離<敵半径+弾半径6。
   - 資源: Gold120 / Lives20 / Score0。Lives0 で GAME OVER(R で再開)。
   - 敵数(負荷): 初期30 ±10 (下限10 上限500)。
   - 物理エンジンは使わない(追従・弾直進・距離判定はすべて自前)。

  ★ 座標系 / Y軸メモ (最重要) ★
   - LittleJS のワールドは Y軸"上向き"。一方この題材は単一画面のグリッドで
     プラットフォーマー的な重力が無いため、テーマ5のような px・y-up モデルではなく、
     「グリッド/論理は y-down(row 0 が画面上)」という素直なモデルで保持し、
     描画/入力変換の境界でのみ Y を反転する方針にした(変換を関数に閉じ込める)。
   - カメラは setCameraScale(1)(1ワールド=1px) + setCameraPos(VIEW中心) で
     960x544 グリッドを画面にそのまま収める。
   - タイル(tx,ty) の中心ワールド座標 = tileCenterWorld():
        worldX = tx*TILE + TILE/2
        worldY = WORLD_H - (ty*TILE + TILE/2)   ← row 0 を画面上へ出すため Y 反転
     creep/projectile も論理は y-down の px(scrX,scrY)で保持し、描画時のみ
     worldY = WORLD_H - scrY に反転する(scrToWorld())。
   - ★ mousePos は LittleJS ワールド座標(y-up)で来る。タイルへ変換するには
     先に Y を反転(scrY = WORLD_H - mousePos.y)してから floor(scrY/TILE) する。
     ここを間違えると上下逆のタイルにタワーが建つ(theme-5 の罠と同根)。
   - 画像が無くても起動する必要があるため textureInfos[i].size で読込判定し、
     未読込なら drawRect/drawCircle 等の図形フォールバックで描画する。
*/

// ---- 画面・グリッド定数 (SPEC) ----
const TILE = 32;                       // 1タイル px
const GRID_W = 30, GRID_H = 17;        // グリッドタイル数 (960 x 544 px)
const VIEW_W = 960, VIEW_H = 540;      // 固定キャンバス
const WORLD_W = GRID_W * TILE;         // 960
const WORLD_H = GRID_H * TILE;         // 544

// ---- タイル種別 ----
const T_PATH = 0, T_WALL = 1;          // 0=通路(配置可) 1=壁(配置・通行不可)

// ---- 数値 (SPEC, px / s) ----
const CREEP_RADIUS = 10;               // 敵半径(当たり)
const CREEP_DRAW = 24;                 // 敵描画径
const CREEP_SPEED = 70;                // 敵移動 px/s
const CREEP_HP = 30;                   // 敵HP
const SPAWN_INTERVAL = 0.5;            // スポーン間隔 s
const TOWER_RANGE = 96;                // タワー射程 px
const TOWER_COOLDOWN = 0.6;            // 連射間隔 s
const TOWER_DMG = 10;                  // 弾ダメージ
const TOWER_COST = 25;                 // 設置コスト
const PROJ_SPEED = 320;                // 弾速 px/s
const PROJ_RADIUS = 6;                 // 弾半径(当たり)
const KILL_GOLD = 5, KILL_SCORE = 10;  // 撃破報酬
const START_GOLD = 120, START_LIVES = 20;

// ---- 敵数(負荷) ----
let enemyCap = 30;                     // 同時出現上限(初期30)
const CAP_STEP = 10, CAP_MIN = 10, CAP_MAX = 500;

// ---- 図形フォールバック色 ----
const C_PATH   = new Color(0.16, 0.17, 0.20);  // 通路=濃灰
const C_WALL   = new Color(0.42, 0.44, 0.48);  // 壁=灰
const C_CREEP  = new Color(0.90, 0.22, 0.22);  // 敵=赤丸
const C_TOWER  = new Color(0.25, 0.55, 0.95);  // タワー=青矩形
const C_PROJ   = new Color(1.0, 0.85, 0.20);   // 弾=黄丸
const C_BASE   = new Color(0.20, 0.80, 0.30);  // ゴール=緑
const C_SPARK  = new Color(1.0, 1.0, 1.0);     // spark=白丸
const C_PATHLINE = new Color(0.40, 0.75, 1.0, 0.18); // 経路ハイライト(薄)
const C_RANGE  = new Color(0.30, 0.60, 1.0, 0.06);   // タワー射程(薄)

// ---- imageSources (../assets/, SPEC のファイル名/インデックスに厳密一致) ----
const imageSources = [
  '../assets/creep.png',       // 0 (24x24)
  '../assets/tower.png',       // 1 (32x32)
  '../assets/projectile.png',  // 2 (12x12)
  '../assets/tile_path.png',   // 3 (32x32)
  '../assets/tile_wall.png',   // 4 (32x32)
  '../assets/base.png',        // 5 (32x32)
  '../assets/hit_spark.png',   // 6 (32x32)
];
const TEX = {
  creep: 0, tower: 1, proj: 2, path: 3, wall: 4, base: 5, spark: 6,
};

// ---- グローバル状態 ----
let map;                 // Uint8Array GRID_W*GRID_H, idx = ty*GRID_W+tx (0=path,1=wall)
let towers;              // Uint8Array 同レイアウト (1=タワー有り)
let startCell, goalCell; // {tx,ty}
let path = [];           // 現在のA*経路(タイル列) [{tx,ty}, ...] (start→goal)
let pathStepDist = [];   // path[i] までの累積距離(進行度算出用, px)
let pathRecalcs = 0;     // 経路再計算 累計回数

let creeps = [];         // 生存 creep(プールから貸出された分)
let projectiles = [];    // 生存 projectile
let towerList = [];      // タワー実体 {tx,ty,cx,cy,cool}
let sparks = [];         // hit_spark エフェクト

let spawnTimer = 0;      // スポーン蓄積タイマ
let gold = START_GOLD, lives = START_LIVES, score = 0;
let gameOver = false;
let useSprites = false;
let creepSeq = 0;        // creep 連番(同進行度時の決定的タイブレーク等に使用可)

// FPS 指数移動平均
let fpsAvg = 60;

// ---- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ----
let started = false, blinkT = 0;
// デモAI: 決定的な固定座標へ数基自動配置して防衛デモにする (Math.random 不使用)
const DEMO_TOWERS = [
  [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
  [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
];
let demoIdx = 0, demoTimer = 0;

const hudEl = () => document.getElementById('hud');
const titleEl = () => document.getElementById('title');

// ---- 決定的疑似乱数 (mulberry32) ― Math.random は不使用 ----
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
//  座標変換 (論理 y-down px <-> ワールド y-up / タイル)
// ===================================================================
// タイル(tx,ty) の中心ワールド座標(y-up)。row 0 を画面上に出すため Y 反転。
function tileCenterWorld(tx, ty) {
  return vec2(tx * TILE + TILE / 2, WORLD_H - (ty * TILE + TILE / 2));
}
// 論理 y-down の px(scrX,scrY) -> ワールド(y-up)
function scrToWorld(sx, sy) { return vec2(sx, WORLD_H - sy); }
// タイル(tx,ty) の中心 論理 px(y-down)
function tileCenterScr(tx, ty) { return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 }; }

// LittleJS mousePos(ワールド, y-up) -> タイル座標。Y は反転してから割る。
function mouseToTile() {
  const m = mousePos;                       // ワールド座標(y-up)
  const sx = m.x;
  const sy = WORLD_H - m.y;                 // 論理 y-down へ
  const tx = Math.floor(sx / TILE);
  const ty = Math.floor(sy / TILE);
  return { tx, ty };
}

function inBounds(tx, ty) { return tx >= 0 && tx < GRID_W && ty >= 0 && ty < GRID_H; }
function mapAt(tx, ty) { return inBounds(tx, ty) ? map[ty * GRID_W + tx] : T_WALL; }
function towerAt(tx, ty) { return inBounds(tx, ty) ? towers[ty * GRID_W + tx] : 1; }
// A* で通行可能か: グリッド内 かつ 壁でない かつ タワーが無い。
function isWalkable(tx, ty) {
  return inBounds(tx, ty) && map[ty * GRID_W + tx] === T_PATH && towers[ty * GRID_W + tx] === 0;
}

// ===================================================================
//  マップ決定的生成
// ===================================================================
function generateMap() {
  map = new Uint8Array(GRID_W * GRID_H);
  const rng = makeRng(20260615); // 固定シード(全エンジン共通の見た目を狙う)

  // 外周を壁で囲む
  for (let tx = 0; tx < GRID_W; tx++) {
    map[0 * GRID_W + tx] = T_WALL;
    map[(GRID_H - 1) * GRID_W + tx] = T_WALL;
  }
  for (let ty = 0; ty < GRID_H; ty++) {
    map[ty * GRID_W + 0] = T_WALL;
    map[ty * GRID_W + (GRID_W - 1)] = T_WALL;
  }

  // スタート=左端中央 / ゴール=右端中央。外周の開口部を空ける。
  const midY = (GRID_H - 1) >> 1; // = 8
  startCell = { tx: 0, ty: midY };
  goalCell  = { tx: GRID_W - 1, ty: midY };
  map[midY * GRID_W + 0] = T_PATH;            // 左端 開口
  map[midY * GRID_W + (GRID_W - 1)] = T_PATH; // 右端 開口

  // 内部に決定的な障害物(壁ブロック)を散らす。
  // 縦の"櫛"壁を一定間隔で立て、毎回どこか1マスを空けて迷路状に(必ず経路が残る)。
  for (let tx = 4; tx < GRID_W - 4; tx += 4) {
    // この列に空ける隙間の行(決定的)
    const gapY = 2 + Math.floor(rng() * (GRID_H - 4));
    for (let ty = 1; ty < GRID_H - 1; ty++) {
      if (ty === gapY) continue;        // 通り抜け穴
      // 中央ライン(start/goal の行)は塞がない方が見やすいので確率で空ける
      if (ty === midY && rng() < 0.5) continue;
      if (rng() < 0.78) map[ty * GRID_W + tx] = T_WALL;
    }
  }

  // 散発的な単発ブロック(start/goal セルは避ける)
  for (let k = 0; k < 26; k++) {
    const tx = 2 + Math.floor(rng() * (GRID_W - 4));
    const ty = 2 + Math.floor(rng() * (GRID_H - 4));
    if (tx === startCell.tx && ty === startCell.ty) continue;
    if (tx === goalCell.tx && ty === goalCell.ty) continue;
    map[ty * GRID_W + tx] = T_WALL;
  }

  // start/goal とその隣接(開口部)は必ず通路にしておく。
  map[startCell.ty * GRID_W + startCell.tx] = T_PATH;
  map[goalCell.ty * GRID_W + goalCell.tx] = T_PATH;
  map[startCell.ty * GRID_W + 1] = T_PATH;
  map[goalCell.ty * GRID_W + (GRID_W - 2)] = T_PATH;

  // 生成直後に経路が存在することを保証(無ければ中央ラインを掘る)
  towers = new Uint8Array(GRID_W * GRID_H);
  if (!computeAStar(startCell, goalCell)) {
    for (let tx = 1; tx < GRID_W - 1; tx++) map[midY * GRID_W + tx] = T_PATH;
  }
}

// ===================================================================
//  A* 経路探索 (4方向, コスト1, マンハッタン距離ヒューリスティック)
//   壁 AND タワータイルを通行不可として扱う(isWalkable)。
//   見つかれば cells 配列(start→goal)を返す。無ければ null。
//   ※ start/goal セル自体は walkable とみなして始点/終点に含める。
// ===================================================================
function aStarSearch(start, goal) {
  const N = GRID_W * GRID_H;
  const idx = (tx, ty) => ty * GRID_W + tx;
  const sI = idx(start.tx, start.ty), gI = idx(goal.tx, goal.ty);

  const gScore = new Float32Array(N).fill(Infinity);
  const fScore = new Float32Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);

  const h = (tx, ty) => Math.abs(tx - goal.tx) + Math.abs(ty - goal.ty);

  // 単純なバイナリヒープ(オープンセット)。要素 = セルindex。
  const heap = [];
  const heapPush = (i) => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (fScore[heap[p]] <= fScore[heap[c]]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = 2 * p + 2;
        let s = p;
        if (l < heap.length && fScore[heap[l]] < fScore[heap[s]]) s = l;
        if (r < heap.length && fScore[heap[r]] < fScore[heap[s]]) s = r;
        if (s === p) break;
        [heap[p], heap[s]] = [heap[s], heap[p]];
        p = s;
      }
    }
    return top;
  };

  gScore[sI] = 0;
  fScore[sI] = h(start.tx, start.ty);
  heapPush(sI);

  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];

  while (heap.length) {
    const cur = heapPop();
    if (cur === gI) {
      // 復元
      const cells = [];
      let i = gI;
      while (i !== -1) {
        cells.push({ tx: i % GRID_W, ty: (i / GRID_W) | 0 });
        i = cameFrom[i];
      }
      cells.reverse();
      return cells;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const ctx = cur % GRID_W, cty = (cur / GRID_W) | 0;
    for (let d = 0; d < 4; d++) {
      const ntx = ctx + DX[d], nty = cty + DY[d];
      if (!inBounds(ntx, nty)) continue;
      const nI = idx(ntx, nty);
      // start/goal は探索対象に含める。中間セルは isWalkable で判定。
      const isEnd = (nI === gI);
      if (!isEnd && !isWalkable(ntx, nty)) continue;
      if (closed[nI]) continue;
      const tentative = gScore[cur] + 1;
      if (tentative < gScore[nI]) {
        cameFrom[nI] = cur;
        gScore[nI] = tentative;
        fScore[nI] = tentative + h(ntx, nty);
        heapPush(nI);
      }
    }
  }
  return null;
}

// start→goal の経路を計算して path / pathStepDist を更新。見つかれば true。
function computeAStar(start, goal) {
  const cells = aStarSearch(start, goal);
  if (!cells) return false;
  path = cells;
  // 各ウェイポイント中心(論理 px)までの累積距離(進行度の基準)
  pathStepDist = new Array(cells.length);
  let acc = 0;
  for (let i = 0; i < cells.length; i++) {
    if (i > 0) {
      const a = tileCenterScr(cells[i - 1].tx, cells[i - 1].ty);
      const b = tileCenterScr(cells[i].tx, cells[i].ty);
      acc += Math.hypot(b.x - a.x, b.y - a.y);
    }
    pathStepDist[i] = acc;
  }
  return true;
}

// タワー設置/撤去後に経路を再計算(再計算カウンタ++)し、全 creep を再追従させる。
function recomputePathAndReroute() {
  pathRecalcs++;
  computeAStar(startCell, goalCell);
  for (const c of creeps) rerouteCreep(c);
}

// ===================================================================
//  creep / projectile プール
//   生成/破棄での GC を避けるため固定プールから貸出/返却する。
// ===================================================================
const creepPool = [];
const projPool = [];

function getCreep() {
  let c = creepPool.pop();
  if (!c) c = { x: 0, y: 0, hp: 0, seg: 0, alive: false, id: 0 };
  return c;
}
function freeCreep(c) { c.alive = false; creepPool.push(c); }

function getProj() {
  let p = projPool.pop();
  if (!p) p = { x: 0, y: 0, vx: 0, vy: 0, alive: false };
  return p;
}
function freeProj(p) { p.alive = false; projPool.push(p); }

// creep を現在地から最寄りの「これから向かうべきウェイポイント」に再追従させる。
// seg = 次に目指す path index。現在地から最も近い経路セル以降を辿る。
function rerouteCreep(c) {
  if (!path || path.length === 0) { c.seg = 0; return; }
  // 現在のタイル位置
  const ctx = clamp(Math.floor(c.x / TILE), 0, GRID_W - 1);
  const cty = clamp(Math.floor(c.y / TILE), 0, GRID_H - 1);
  // 経路上で現在地に最も近いセルを探し、その次を次ウェイポイントにする。
  let best = 0, bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = Math.abs(path[i].tx - ctx) + Math.abs(path[i].ty - cty);
    if (d < bestD) { bestD = d; best = i; }
  }
  // 現在地が経路セルそのものなら次を、ずれていればそのセルを目指す。
  c.seg = (bestD === 0) ? Math.min(best + 1, path.length - 1) : best;
}

function spawnCreep() {
  const c = getCreep();
  const s = tileCenterScr(startCell.tx, startCell.ty);
  c.x = s.x; c.y = s.y;
  c.hp = CREEP_HP;
  c.alive = true;
  c.id = creepSeq++;
  c.seg = Math.min(1, path.length - 1); // start の次ウェイポイントを目指す
  creeps.push(c);
}

// creep の進行度(px, ゴールへ近いほど大)。最も進行度が高い敵を狙う用。
function creepProgress(c) {
  // seg-1 までの累積 + 現在 seg へ向かう途中分
  if (!path.length) return 0;
  const seg = clamp(c.seg, 1, path.length - 1);
  const base = pathStepDist[seg - 1] || 0;
  const tgt = tileCenterScr(path[seg].tx, path[seg].ty);
  const prev = tileCenterScr(path[seg - 1].tx, path[seg - 1].ty);
  const segLen = Math.hypot(tgt.x - prev.x, tgt.y - prev.y) || 1;
  const doneInSeg = Math.hypot(c.x - prev.x, c.y - prev.y);
  return base + clamp(doneInSeg, 0, segLen);
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

// ===================================================================
//  タワー設置 / 撤去
// ===================================================================
function tryPlaceTower(tx, ty) {
  if (gameOver) return;
  if (!inBounds(tx, ty)) return;
  if (mapAt(tx, ty) !== T_PATH) return;          // 通路タイルのみ
  if (towerAt(tx, ty)) return;                    // 既に有り
  if (tx === startCell.tx && ty === startCell.ty) return; // start/goal は塞がない
  if (tx === goalCell.tx && ty === goalCell.ty) return;
  if (gold < TOWER_COST) return;                  // ゴールド不足

  // 仮置きして経路が残るか試す(ゴール到達不能になる配置は拒否)。
  towers[ty * GRID_W + tx] = 1;
  if (!aStarSearch(startCell, goalCell)) {
    towers[ty * GRID_W + tx] = 0;                 // 経路を塞ぐので取消
    return;
  }
  // 確定
  gold -= TOWER_COST;
  const w = tileCenterScr(tx, ty);
  towerList.push({ tx, ty, cx: w.x, cy: w.y, cool: 0 });
  recomputePathAndReroute();
}

function tryRemoveTower(tx, ty) {
  if (!inBounds(tx, ty) || !towerAt(tx, ty)) return;
  towers[ty * GRID_W + tx] = 0;
  for (let i = towerList.length - 1; i >= 0; i--) {
    if (towerList[i].tx === tx && towerList[i].ty === ty) { towerList.splice(i, 1); break; }
  }
  recomputePathAndReroute(); // 返金なし・経路再計算
}

// ---- hit_spark ----
function addSpark(x, y) { sparks.push({ x, y, t: 0, life: 0.3 }); }

// ===================================================================
//  リスタート / 初期化
// ===================================================================
function resetGame() {
  generateMap();                 // map / towers / start / goal / 初期経路
  computeAStar(startCell, goalCell);
  pathRecalcs = 0;
  creeps.length = 0;
  projectiles.length = 0;
  towerList.length = 0;
  sparks.length = 0;
  spawnTimer = 0;
  gold = START_GOLD; lives = START_LIVES; score = 0;
  gameOver = false;
  creepSeq = 0;
  demoIdx = 0; demoTimer = 0;   // デモAIの自動配置進捗もリセット
}

// Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
function startGame() {
  started = true;
  resetGame();
  const t = titleEl();
  if (t) t.style.display = 'none';
}

// デモAI: 一定間隔で次の候補タイルへタワーを試行設置 (tryPlaceTower が不正配置を弾く)
function demoTick(dt) {
  demoTimer += dt;
  if (demoTimer >= 0.8 && demoIdx < DEMO_TOWERS.length && gold >= TOWER_COST) {
    demoTimer = 0;
    const cell = DEMO_TOWERS[demoIdx++];
    tryPlaceTower(cell[0], cell[1]);
  }
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);                  // 1ワールド単位 = 1px
  setGravity(vec2(0, 0));             // エンジン物理は使わない
  // 960x544 グリッドを画面中央に収める(VIEW_H=540 だが 4px 差は許容範囲)。
  setCameraPos(vec2(WORLD_W / 2, WORLD_H / 2));

  // テクスチャ読込判定(1枚でも読めれば sprites 使用)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  enemyCap = 30;
  resetGame();
}

function gameUpdate() {
  const dt = timeDelta; // デルタタイム基準(既定 1/60)

  // ---- 敵数 上限 増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    enemyCap = clamp(enemyCap + CAP_STEP, CAP_MIN, CAP_MAX);
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    enemyCap = clamp(enemyCap - CAP_STEP, CAP_MIN, CAP_MAX);
  }

  // ---- リスタート (R) ----
  if (keyWasPressed('KeyR')) { resetGame(); }

  // ---- Enter: デモ→プレイ開始 ----
  if (keyWasPressed('Enter') && !started) { startGame(); }

  // ---- マウス: 左=設置 / 右=撤去 (アトラクト中は無効) ----
  if (started) {
    if (mouseWasPressed(0)) {
      const { tx, ty } = mouseToTile();
      tryPlaceTower(tx, ty);
    }
    if (mouseWasPressed(2)) {
      const { tx, ty } = mouseToTile();
      tryRemoveTower(tx, ty);
    }
  }

  // タイトル点滅 (約0.45秒周期) — HTML #title オーバーレイ
  {
    const t = titleEl();
    if (t) {
      if (!started) { blinkT += dt; t.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
    }
  }

  // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
  if (gameOver && !started) { resetGame(); }
  // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
  if (!started) demoTick(dt);

  // GAME OVER 中も負荷比較(+/-)とリスタートは効くが、シミュレーションは止める。
  if (gameOver) return;

  // ---- スポーン: 0.5s 間隔・生存数 < 上限 のときのみ供給 ----
  spawnTimer += dt;
  while (spawnTimer >= SPAWN_INTERVAL) {
    spawnTimer -= SPAWN_INTERVAL;
    if (creeps.length < enemyCap && path.length > 1) spawnCreep();
  }

  // ---- creep 追従更新(経路に沿って線形移動) ----
  for (let i = creeps.length - 1; i >= 0; i--) {
    const c = creeps[i];
    if (!c.alive) { creeps.splice(i, 1); freeCreep(c); continue; }

    if (path.length <= 1) continue; // 経路が無い(理論上無い想定)
    let step = CREEP_SPEED * dt;    // このフレームで進める距離
    // 複数ウェイポイントを跨ぐ場合に対応するループ
    while (step > 0 && c.seg < path.length) {
      const tgt = tileCenterScr(path[c.seg].tx, path[c.seg].ty);
      const dx = tgt.x - c.x, dy = tgt.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d <= step) {
        // ウェイポイント到達
        c.x = tgt.x; c.y = tgt.y;
        step -= d;
        if (c.seg >= path.length - 1) break; // ゴールセル到達
        c.seg++;
      } else {
        c.x += (dx / d) * step;
        c.y += (dy / d) * step;
        step = 0;
      }
    }

    // ゴール到達判定(最終セル中心に十分近い)
    const g = tileCenterScr(goalCell.tx, goalCell.ty);
    if (Math.hypot(c.x - g.x, c.y - g.y) < CREEP_SPEED * dt + 1 && c.seg >= path.length - 1) {
      lives -= 1;
      c.alive = false;
      creeps.splice(i, 1); freeCreep(c);
      if (lives <= 0) { lives = 0; gameOver = true; }
    }
  }

  // ---- タワー射撃 ----
  for (const t of towerList) {
    t.cool -= dt;
    if (t.cool > 0) continue;
    // 射程内で最も進行度が高い(ゴールに近い)敵を狙う。
    let target = null, bestProg = -1;
    const r2 = TOWER_RANGE * TOWER_RANGE;
    for (const c of creeps) {
      if (!c.alive) continue;
      const dx = c.x - t.cx, dy = c.y - t.cy;
      if (dx * dx + dy * dy > r2) continue;
      const prog = creepProgress(c);
      if (prog > bestProg) { bestProg = prog; target = c; }
    }
    if (target) {
      // 発射(現在の標的方向へ直進。誘導はしない簡易弾)
      const dx = target.x - t.cx, dy = target.y - t.cy;
      const d = Math.hypot(dx, dy) || 1;
      const p = getProj();
      p.x = t.cx; p.y = t.cy;
      p.vx = (dx / d) * PROJ_SPEED;
      p.vy = (dy / d) * PROJ_SPEED;
      p.alive = true;
      projectiles.push(p);
      t.cool = TOWER_COOLDOWN;
    }
  }

  // ---- projectile 更新 ----
  const hitR = CREEP_RADIUS + PROJ_RADIUS;
  const hitR2 = hitR * hitR;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // 画面外で消滅
    if (p.x < -16 || p.x > WORLD_W + 16 || p.y < -16 || p.y > WORLD_H + 16) {
      projectiles.splice(i, 1); freeProj(p); continue;
    }
    // 敵との当たり判定(最初に当たった敵にダメージ)
    let hit = false;
    for (const c of creeps) {
      if (!c.alive) continue;
      const dx = c.x - p.x, dy = c.y - p.y;
      if (dx * dx + dy * dy <= hitR2) {
        c.hp -= TOWER_DMG;
        if (c.hp <= 0) {
          c.alive = false;
          gold += KILL_GOLD;
          score += KILL_SCORE;
          addSpark(c.x, c.y);
        }
        hit = true;
        break;
      }
    }
    if (hit) { projectiles.splice(i, 1); freeProj(p); }
  }

  // ---- spark 更新 ----
  for (let i = sparks.length - 1; i >= 0; i--) {
    sparks[i].t += dt;
    if (sparks[i].t >= sparks[i].life) sparks.splice(i, 1);
  }
}

function gameUpdatePost() {}

// ===================================================================
//  描画 (ワールド空間)
// ===================================================================
function gameRender() {
  // ---- 背景(画面塗り) ----
  drawRect(vec2(WORLD_W / 2, WORLD_H / 2), vec2(WORLD_W, WORLD_H), new Color(0.08, 0.09, 0.11));

  // ---- タイル ----
  for (let ty = 0; ty < GRID_H; ty++) {
    for (let tx = 0; tx < GRID_W; tx++) {
      const t = map[ty * GRID_W + tx];
      const w = tileCenterWorld(tx, ty);
      if (t === T_WALL) {
        if (spriteReady(TEX.wall)) drawTile(w, vec2(TILE, TILE), texTile(TEX.wall));
        else drawRect(w, vec2(TILE - 1, TILE - 1), C_WALL);
      } else {
        if (spriteReady(TEX.path)) drawTile(w, vec2(TILE, TILE), texTile(TEX.path));
        else drawRect(w, vec2(TILE - 1, TILE - 1), C_PATH);
      }
    }
  }

  // ---- 現在経路ハイライト(薄い細矩形を重ねて可視化) ----
  for (let i = 0; i < path.length; i++) {
    const w = tileCenterWorld(path[i].tx, path[i].ty);
    drawRect(w, vec2(TILE * 0.5, TILE * 0.5), C_PATHLINE);
  }

  // ---- ゴール(自陣) ----
  {
    const w = tileCenterWorld(goalCell.tx, goalCell.ty);
    if (spriteReady(TEX.base)) drawTile(w, vec2(TILE, TILE), texTile(TEX.base));
    else {
      drawRect(w, vec2(TILE - 4, TILE - 4), C_BASE);          // 緑の自陣
      drawRect(vec2(w.x, w.y), vec2(3, TILE - 8), new Color(1, 1, 1, 0.7)); // 旗ポール風
    }
  }
  // スタート地点マーカ(薄い枠)
  {
    const w = tileCenterWorld(startCell.tx, startCell.ty);
    drawRect(w, vec2(TILE - 6, TILE - 6), new Color(0.9, 0.9, 0.3, 0.25));
  }

  // ---- タワー(+ 射程の薄い表示) ----
  for (const t of towerList) {
    const w = scrToWorld(t.cx, t.cy);
    drawRect(w, vec2(TOWER_RANGE * 2, 2), C_RANGE); // 射程の目安(十字の薄い線)
    drawRect(w, vec2(2, TOWER_RANGE * 2), C_RANGE);
    if (spriteReady(TEX.tower)) drawTile(w, vec2(TILE, TILE), texTile(TEX.tower));
    else {
      drawRect(w, vec2(TILE - 6, TILE - 6), C_TOWER);
      drawRect(w, vec2(8, 8), new Color(0.8, 0.9, 1.0)); // 砲口
    }
  }

  // ---- creep(敵) ----
  for (const c of creeps) {
    if (!c.alive) continue;
    const w = scrToWorld(c.x, c.y);
    if (spriteReady(TEX.creep)) {
      drawTile(w, vec2(CREEP_DRAW, CREEP_DRAW), texTile(TEX.creep));
    } else {
      drawCircle(w, CREEP_DRAW / 2, C_CREEP);   // 赤丸
    }
    // HP バー(ダメージを受けた敵のみ)
    if (c.hp < CREEP_HP) {
      const frac = clamp(c.hp / CREEP_HP, 0, 1);
      const barW = CREEP_DRAW;
      const by = w.y + CREEP_DRAW / 2 + 4; // y-up: 上に出す
      drawRect(vec2(w.x, by), vec2(barW, 3), new Color(0, 0, 0, 0.6));
      drawRect(vec2(w.x - barW / 2 + barW * frac / 2, by), vec2(barW * frac, 3), new Color(0.3, 0.9, 0.3));
    }
  }

  // ---- projectile(弾) ----
  for (const p of projectiles) {
    const w = scrToWorld(p.x, p.y);
    if (spriteReady(TEX.proj)) drawTile(w, vec2(12, 12), texTile(TEX.proj));
    else drawCircle(w, PROJ_RADIUS, C_PROJ);   // 黄丸
  }

  // ---- hit_spark ----
  for (const s of sparks) {
    const w = scrToWorld(s.x, s.y);
    const k = s.t / s.life;
    if (spriteReady(TEX.spark)) {
      const sz = 16 + k * 20;
      drawTile(w, vec2(sz, sz), texTile(TEX.spark));
    } else {
      drawCircle(w, 6 + k * 16, new Color(1, 1, 1, 1 - k)); // 白丸
    }
  }

  // ---- マウスカーソル下のタイルをハイライト(設置可否) ----
  if (!gameOver && started) {
    const { tx, ty } = mouseToTile();
    if (inBounds(tx, ty)) {
      const buildable = mapAt(tx, ty) === T_PATH && !towerAt(tx, ty)
        && !(tx === startCell.tx && ty === startCell.ty)
        && !(tx === goalCell.tx && ty === goalCell.ty);
      const w = tileCenterWorld(tx, ty);
      const col = buildable
        ? new Color(0.3, 1.0, 0.4, 0.25)
        : new Color(1.0, 0.3, 0.3, 0.25);
      drawRect(w, vec2(TILE, TILE), col);
    }
  }

  // ---- GAME OVER オーバレイ (プレイ中のみ。アトラクト中はループ再開) ----
  if (gameOver && started) {
    drawRect(vec2(WORLD_W / 2, WORLD_H / 2), vec2(WORLD_W, WORLD_H), new Color(0, 0, 0, 0.55));
    drawTextScreen('GAME OVER', vec2(VIEW_W / 2, VIEW_H / 2 - 10), 48, new Color(1, 0.3, 0.3));
    drawTextScreen('Press R to restart', vec2(VIEW_W / 2, VIEW_H / 2 + 36), 22, new Color(1, 1, 1));
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function gameRenderPost() {
  // FPS 指数移動平均
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS          : ' + fpsAvg.toFixed(1) + '\n' +
      'Enemies      : ' + creeps.length + ' / ' + enemyCap + '\n' +
      'Towers       : ' + towerList.length + '\n' +
      'Projectiles  : ' + projectiles.length + '\n' +
      'Path recalcs : ' + pathRecalcs + '\n' +
      'Path len     : ' + path.length + '\n' +
      'Gold         : ' + gold + '\n' +
      'Lives        : ' + lives + '\n' +
      'Score        : ' + score +
      (useSprites ? '   [sprites]' : '   [shapes fallback]') +
      (gameOver && started ? '   *** GAME OVER ***' : '');
  }
}

// ===================================================================
//  起動: engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)
// ===================================================================
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources);
