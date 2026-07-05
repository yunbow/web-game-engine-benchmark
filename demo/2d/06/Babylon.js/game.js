"use strict";

/* =========================================================================
 * テーマ6: タワーディフェンス (経路探索 × 多数ユニット追従) ― Babylon.js 版
 *
 * 3Dエンジン Babylon.js で 2D グリッドのタワーディフェンスを実装する。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を再現。
 *    画面は 30x17 タイル (960x544 px) のグリッド全体を 1 画面に収める (スクロール無し)。
 *  - 敵/弾/経路ハイライトは種別ごとの SpriteManager + スプライトプールで大量描画する。
 *  - 物理エンジンは使わない。経路探索(A*)・経路追従・弾の直進・距離判定はすべて自前。
 *  - テクスチャがあれば Sprite、無ければ単色 Plane/Disc にフォールバックして必ず起動する。
 *
 * 本テーマの主眼は「CPU側 AI ロジック(A* 経路探索) ＋ 多数ユニットの経路追従更新 ＋
 * タワー射撃」を同時に回したときの性能。タワー設置/撤去のたびに経路を再計算し、
 * 生存中の全敵が現在地から経路を取り直す。
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;
const TILE = 32;             // タイルサイズ px
const GRID_W = 30;           // グリッド幅 (タイル) → 30x32 = 960
const GRID_H = 17;           // グリッド高 (タイル) → 17x32 = 544 (画面 540 に収める)

// グリッド種別: 0=通路(path/buildable), 1=壁(wall)
const T_PATH = 0, T_WALL = 1;

// スタート/ゴール (左端中央 / 右端中央)
const START_TX = 0;
const START_TY = (GRID_H - 1) >> 1;   // = 8
const GOAL_TX = GRID_W - 1;           // = 29
const GOAL_TY = (GRID_H - 1) >> 1;    // = 8

// 敵 (creep)
const CREEP_R = 10;          // 当たり半径
const CREEP_DRAW = 24;       // 描画直径
const CREEP_SPEED = 70;      // px/s
const CREEP_HP = 30;
const SPAWN_INTERVAL = 0.5;  // スポーン間隔 s

// タワー
const TOWER_COST = 25;
const TOWER_RANGE = 96;      // 射程 px
const TOWER_FIRE_INTERVAL = 0.6; // 連射間隔 s
const TOWER_DMG = 10;        // 弾ダメージ

// 弾 (projectile)
const PROJ_SPEED = 320;      // px/s
const PROJ_R = 6;            // 弾半径
const PROJ_DRAW = 12;        // 描画直径

// 報酬
const KILL_GOLD = 5;
const KILL_SCORE = 10;

// 資源初期値
const INIT_GOLD = 120;
const INIT_LIVES = 20;

// 敵数 (負荷)
const INITIAL_CAP = 30;
const CAP_STEP = 10;
const MIN_CAP = 10;
const MAX_CAP = 500;

// スパーク (撃破エフェクト)
const SPARK_LIFE = 0.28;

/* ---------- アセット定義 ---------- */
const ASSET_DIR = "../assets/";
const ASSETS = {
  creep:  { file: "creep.png",      w: CREEP_DRAW, h: CREEP_DRAW, fallback: "#e23b3b", shape: "circle" },
  tower:  { file: "tower.png",      w: TILE,       h: TILE,       fallback: "#3b7be2", shape: "rect" },
  proj:   { file: "projectile.png", w: PROJ_DRAW,  h: PROJ_DRAW,  fallback: "#ffd23f", shape: "circle" },
  path:   { file: "tile_path.png",  w: TILE,       h: TILE,       fallback: "#2a2f36", shape: "rect" },
  wall:   { file: "tile_wall.png",  w: TILE,       h: TILE,       fallback: "#5a626b", shape: "rect" },
  base:   { file: "base.png",       w: TILE,       h: TILE,       fallback: "#2eaa4a", shape: "rect" },
  spark:  { file: "hit_spark.png",  w: TILE,       h: TILE,       fallback: "#ffffff", shape: "circle" },
  // 経路ハイライト用 (画像不要・図形のみ)。明るい色で現在経路を薄く可視化する。
  phl:    { file: "__no_image__",   w: TILE,       h: TILE,       fallback: "#3fd0c0", shape: "rect" },
};

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じマップ/敵配置を生成する。
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
 *  マップ決定的生成
 *  外周を壁で囲み (スタート/ゴール開口部のみ空ける)、内部に決定的な壁ブロックを散らす。
 *  生成後に A* で連結性を確認し、塞いでしまった壁は取り除いて必ず経路を残す。
 * ========================================================================= */
function generateMap() {
  const rnd = mulberry32(0x7DEF);
  const map = new Uint8Array(GRID_W * GRID_H); // 0=path
  const idx = (tx, ty) => ty * GRID_W + tx;

  // --- 外周を壁で囲む ---
  for (let tx = 0; tx < GRID_W; tx++) {
    map[idx(tx, 0)] = T_WALL;
    map[idx(tx, GRID_H - 1)] = T_WALL;
  }
  for (let ty = 0; ty < GRID_H; ty++) {
    map[idx(0, ty)] = T_WALL;
    map[idx(GRID_W - 1, ty)] = T_WALL;
  }
  // スタート/ゴールの開口部を空ける (左端中央 / 右端中央)
  map[idx(START_TX, START_TY)] = T_PATH;
  map[idx(GOAL_TX, GOAL_TY)] = T_PATH;

  // --- 内部に決定的な壁ブロックを散らす ---
  // スタート/ゴール直近は空けて、確実に出入口を確保する。
  for (let ty = 1; ty < GRID_H - 1; ty++) {
    for (let tx = 1; tx < GRID_W - 1; tx++) {
      // 出入口周辺 (左右各2列) は障害物を置かない
      if (tx <= 2 || tx >= GRID_W - 3) continue;
      if (rnd() < 0.22) map[idx(tx, ty)] = T_WALL;
    }
  }

  // --- 連結性を保証: ゴール到達不能なら、経路上に必要な壁を順次除去する ---
  // (決定的生成 + 決定的除去なので結果は毎回同じ)
  let guard = 0;
  while (!hasPathOnGrid(map, null) && guard < GRID_W * GRID_H) {
    guard++;
    // スタート→ゴールへ向かう中央行の壁を 1 つ取り除いて道を通す
    let removed = false;
    const midY = START_TY;
    for (let tx = 1; tx < GRID_W - 1 && !removed; tx++) {
      if (map[idx(tx, midY)] === T_WALL) { map[idx(tx, midY)] = T_PATH; removed = true; }
    }
    if (!removed) break;
  }

  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return T_WALL; // 外周は壁扱い
  return map[ty * GRID_W + tx];
}

/* =========================================================================
 *  A* 経路探索 (4方向, コスト1, マンハッタン距離ヒューリスティック)
 *  start→goal を計算する。壁 (map==1) と「タワーの置かれたタイル(blocked集合)」を通行不可に扱う。
 *  経路はタイルセル列 [{tx,ty}, ...] を返す。到達不能なら null。
 * ========================================================================= */
const DIRS = [ [1, 0], [-1, 0], [0, 1], [0, -1] ];

// blocked: Set<cellIndex> もしくは null。タワーの占有タイルを通行不可として扱う。
function astar(map, blocked, sx, sy, gx, gy) {
  const N = GRID_W * GRID_H;
  const ci = (tx, ty) => ty * GRID_W + tx;

  const passable = (tx, ty) => {
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
    if (map[ty * GRID_W + tx] === T_WALL) return false;
    if (blocked && blocked.has(ty * GRID_W + tx)) return false;
    return true;
  };

  const startC = ci(sx, sy);
  const goalC = ci(gx, gy);
  if (!passable(sx, sy) || !passable(gx, gy)) return null;

  const gScore = new Float64Array(N).fill(Infinity);
  const fScore = new Float64Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);

  const h = (c) => {
    const tx = c % GRID_W, ty = (c / GRID_W) | 0;
    return Math.abs(tx - gx) + Math.abs(ty - gy);
  };

  gScore[startC] = 0;
  fScore[startC] = h(startC);

  // バイナリヒープ (open set)。f 値最小を取り出す。
  const heap = [];
  const heapPush = (c) => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fScore[heap[p]] <= fScore[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const n = heap.length;
      for (;;) {
        let l = 2 * i + 1, r = 2 * i + 2, sm = i;
        if (l < n && fScore[heap[l]] < fScore[heap[sm]]) sm = l;
        if (r < n && fScore[heap[r]] < fScore[heap[sm]]) sm = r;
        if (sm === i) break;
        const t = heap[sm]; heap[sm] = heap[i]; heap[i] = t;
        i = sm;
      }
    }
    return top;
  };

  heapPush(startC);

  while (heap.length > 0) {
    const cur = heapPop();
    if (cur === goalC) {
      // 経路復元
      const cells = [];
      let c = cur;
      while (c !== -1) {
        cells.push({ tx: c % GRID_W, ty: (c / GRID_W) | 0 });
        c = cameFrom[c];
      }
      cells.reverse();
      return cells;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const ctx = cur % GRID_W, cty = (cur / GRID_W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = ctx + DIRS[d][0], ny = cty + DIRS[d][1];
      if (!passable(nx, ny)) continue;
      const nc = ci(nx, ny);
      if (closed[nc]) continue;
      const tentative = gScore[cur] + 1;
      if (tentative < gScore[nc]) {
        cameFrom[nc] = cur;
        gScore[nc] = tentative;
        fScore[nc] = tentative + h(nc);
        heapPush(nc);
      }
    }
  }
  return null; // 到達不能
}

// マップ + blocked でスタート→ゴールに経路があるか (連結性チェック用)
function hasPathOnGrid(map, blocked) {
  return astar(map, blocked, START_TX, START_TY, GOAL_TX, GOAL_TY) !== null;
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
scene.clearColor = new BABYLON.Color4(0.08, 0.10, 0.12, 1.0); // 背景 (グリッド外も含む)
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) ---
// orthoTop < orthoBottom で y 下向きの 2D 画面に一致させる。スクロールしないので固定窓。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
// 正射影は orthoLeft/Right/Top/Bottom が「ビュー空間」の表示窓を定義する。
// ビュー空間 = ワールド - カメラ位置 なので、ワールド 0..960 をそのまま窓にするには
// カメラの x/y は 0 のままにする(原点に置く)。ここで中央(480,270)へ動かすと
// オフセットが二重に効き、マップが画面左上の 1/4 に縮んで描画されてしまう。
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

const managers = {}; // key -> SpriteManager or null
const SPRITE_CAPACITY = 2048;

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
function fallbackMat(key) {
  if (fallbackMats[key]) return fallbackMats[key];
  const a = ASSETS[key];
  const m = new BABYLON.StandardMaterial("fm_" + key, scene);
  const c = BABYLON.Color3.FromHexString(a.fallback || "#888888");
  m.emissiveColor = c;
  m.diffuseColor = c;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.backFaceCulling = false;
  fallbackMats[key] = m;
  return m;
}

// テンプレ mesh (矩形 or 円)。インスタンス毎に clone する。
const fallbackTemplates = {};
function fallbackTemplate(key) {
  if (fallbackTemplates[key]) return fallbackTemplates[key];
  const a = ASSETS[key];
  let mesh;
  if (a.shape === "circle") {
    mesh = BABYLON.MeshBuilder.CreateDisc("ft_" + key, { radius: 0.5, tessellation: 18 }, scene);
  } else {
    // 1x1 の Plane を基準にし、scaling で実サイズへ
    mesh = BABYLON.MeshBuilder.CreatePlane("ft_" + key, { width: 1, height: 1 }, scene);
  }
  mesh.material = fallbackMat(key);
  mesh.isPickable = false;
  mesh.setEnabled(false);
  fallbackTemplates[key] = mesh;
  return mesh;
}

/* ---------- 統一スプライトラッパ ----------
 * { setPos(x,y,z), setVisible(b), setSize(w,h), setAlpha(a), dispose() }
 * 座標は画面 px をそのまま渡す (ortho が px 等倍なので変換不要)。
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
      setAlpha(al) { sp.color = new BABYLON.Color4(1, 1, 1, al); },
      dispose() { sp.dispose(); },
    };
  } else {
    const mesh = fallbackTemplate(key).clone("c_" + key);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    // 経路ハイライト等の半透明描画に備えてマテリアルを複製可能にする
    let myMat = null;
    return {
      kind: "mesh", obj: mesh,
      setPos(x, y, z) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = (z == null ? 0 : z); },
      setVisible(b) { mesh.setEnabled(b); },
      setSize(w, h) { mesh.scaling.x = w; mesh.scaling.y = h; },
      setAlpha(al) {
        if (!myMat) {
          myMat = fallbackMat(key).clone("am_" + key);
          mesh.material = myMat;
        }
        myMat.alpha = al;
      },
      dispose() { mesh.dispose(); if (myMat) myMat.dispose(); },
    };
  }
}

/* =========================================================================
 *  ゲーム状態
 * ========================================================================= */
let map = generateMap();

const Game = {
  creeps: [],        // {spr,x,y,hp,alive,path,wp,prog}
  towers: [],        // {spr,tx,ty,cx,cy,cool}
  projectiles: [],   // {spr,x,y,vx,vy,target,alive}
  effects: [],       // 撃破スパーク {spr,x,y,life}
  towerSet: new Set(),   // タワー占有セル index (A* の blocked に渡す)
  currentPath: null,     // 現在のスタート→ゴール経路 (セル列)
  pathRecalcs: 0,        // 経路再計算 累計
  gold: INIT_GOLD,
  lives: INIT_LIVES,
  score: 0,
  cap: INITIAL_CAP,      // 同時出現上限 (負荷値)
  spawnTimer: 0,
  over: false,
};

const cellIndex = (tx, ty) => ty * GRID_W + tx;
const tileCenterX = (tx) => tx * TILE + TILE / 2;
const tileCenterY = (ty) => ty * TILE + TILE / 2;

/* ---------- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ---------- */
let started = false, blinkT = 0;
const titleEl = document.getElementById("title");
// デモAI: 決定的な固定座標へ数基自動配置して防衛デモにする (Math.random 不使用)
const DEMO_TOWERS = [
  [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
  [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
];
let demoIdx = 0, demoTimer = 0;
function startGame() {
  started = true;
  restart();
  if (titleEl) titleEl.style.display = "none";
}
function demoTick(dt) {
  demoTimer += dt;
  if (demoTimer >= 0.8 && demoIdx < DEMO_TOWERS.length && Game.gold >= TOWER_COST) {
    demoTimer = 0;
    const cell = DEMO_TOWERS[demoIdx++];
    tryPlaceTower(cell[0], cell[1]);
  }
}

/* =========================================================================
 *  経路: 現在のグローバル経路 (スタート→ゴール) の計算
 * ========================================================================= */
// タワー設置/撤去・リスタート時に呼び、グローバル経路を更新 + 全敵を再追従させる。
function recomputeGlobalPath(repathCreeps) {
  Game.currentPath = astar(map, Game.towerSet, START_TX, START_TY, GOAL_TX, GOAL_TY);
  Game.pathRecalcs++;
  if (repathCreeps) {
    for (const c of Game.creeps) {
      if (c.alive) repathCreep(c);
    }
  }
}

// 起点セルが通行可能か (壁でもタワーでもない)
function cellPassable(tx, ty) {
  if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
  if (map[ty * GRID_W + tx] === T_WALL) return false;
  if (Game.towerSet.has(ty * GRID_W + tx)) return false;
  return true;
}

// 敵を「現在セルから」ゴールまで再経路。現在地に最も近いセルを起点に A* する。
function repathCreep(c) {
  let ctx = Math.max(0, Math.min(GRID_W - 1, Math.floor(c.x / TILE)));
  let cty = Math.max(0, Math.min(GRID_H - 1, Math.floor(c.y / TILE)));
  // 起点セルがタワー設置等で通行不可になった場合、隣接の通行可能セルへ寄せる
  if (!cellPassable(ctx, cty)) {
    let found = false;
    for (let d = 0; d < 4 && !found; d++) {
      const nx = ctx + DIRS[d][0], ny = cty + DIRS[d][1];
      if (cellPassable(nx, ny)) { ctx = nx; cty = ny; found = true; }
    }
  }
  const path = astar(map, Game.towerSet, ctx, cty, GOAL_TX, GOAL_TY);
  Game.pathRecalcs++;
  if (path && path.length > 0) {
    c.path = path;
    // 起点セル(現在地)は飛ばし、次のウェイポイントから向かう
    c.wp = path.length > 1 ? 1 : 0;
  } else {
    // 経路が無い場合は最後の経路を維持 (設置側で必ず連結を保証しているため通常起きない)
    if (!c.path) { c.path = [{ tx: ctx, ty: cty }]; c.wp = 0; }
  }
}

/* =========================================================================
 *  敵 (creep) ― プール再利用
 * ========================================================================= */
const creepPool = [];
function getCreepSprite() {
  let s = creepPool.pop();
  if (!s) { s = createEntitySprite("creep"); s.setSize(CREEP_DRAW, CREEP_DRAW); }
  s.setVisible(true);
  return s;
}
function returnCreepSprite(s) {
  s.setVisible(false);
  s.setPos(-9999, -9999);
  creepPool.push(s);
}

function spawnCreep() {
  const spr = getCreepSprite();
  const c = {
    spr,
    x: tileCenterX(START_TX),
    y: tileCenterY(START_TY),
    hp: CREEP_HP,
    alive: true,
    path: null,
    wp: 0,     // 次に向かうウェイポイント index
  };
  // スタートセルからゴールへの経路を割り当てる
  const path = (Game.currentPath && Game.currentPath.length > 0)
    ? Game.currentPath
    : astar(map, Game.towerSet, START_TX, START_TY, GOAL_TX, GOAL_TY);
  c.path = path || [{ tx: START_TX, ty: START_TY }];
  c.wp = c.path.length > 1 ? 1 : 0;
  spr.setPos(c.x, c.y, -2);
  Game.creeps.push(c);
}

function liveCreepCount() {
  let n = 0;
  for (const c of Game.creeps) if (c.alive) n++;
  return n;
}

/* =========================================================================
 *  タワー / 弾 ― プール再利用 (弾)
 * ========================================================================= */
const projPool = [];
function getProjSprite() {
  let s = projPool.pop();
  if (!s) { s = createEntitySprite("proj"); s.setSize(PROJ_DRAW, PROJ_DRAW); }
  s.setVisible(true);
  return s;
}
function returnProjSprite(s) {
  s.setVisible(false);
  s.setPos(-9999, -9999);
  projPool.push(s);
}

// 左クリック: 通路タイルにタワー設置。経路を塞ぐ配置は不可。
function tryPlaceTower(tx, ty) {
  if (Game.over) return;
  if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return;
  if (tileAt(map, tx, ty) === T_WALL) return;             // 壁には置けない
  if (tx === START_TX && ty === START_TY) return;          // スタート不可
  if (tx === GOAL_TX && ty === GOAL_TY) return;            // ゴール不可
  const ci = cellIndex(tx, ty);
  if (Game.towerSet.has(ci)) return;                       // 既に設置済み
  if (Game.gold < TOWER_COST) return;                      // 資金不足

  // 仮に設置して連結性を確認。塞ぐなら拒否。
  Game.towerSet.add(ci);
  if (!hasPathOnGrid(map, Game.towerSet)) {
    Game.towerSet.delete(ci); // ロールバック
    return;
  }

  // 設置確定
  Game.gold -= TOWER_COST;
  const spr = createEntitySprite("tower");
  spr.setSize(TILE - 2, TILE - 2);
  const cx = tileCenterX(tx), cy = tileCenterY(ty);
  spr.setPos(cx, cy, -1);
  Game.towers.push({ spr, tx, ty, cx, cy, cool: 0 });

  recomputeGlobalPath(true); // 経路再計算 + 全敵 re-path
}

// 右クリック: タワー撤去 (返金なし)。経路を再計算。
function tryRemoveTower(tx, ty) {
  if (Game.over) return;
  const ci = cellIndex(tx, ty);
  if (!Game.towerSet.has(ci)) return;
  for (let i = 0; i < Game.towers.length; i++) {
    const t = Game.towers[i];
    if (t.tx === tx && t.ty === ty) {
      t.spr.dispose();
      Game.towers.splice(i, 1);
      break;
    }
  }
  Game.towerSet.delete(ci);
  recomputeGlobalPath(true);
}

/* =========================================================================
 *  入力
 * ========================================================================= */
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

// 右クリックのコンテキストメニューを抑制
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

// 画面 px → グリッド (ortho が px 等倍なので直接割り算)
function pointerToTile(ev) {
  const rect = canvas.getBoundingClientRect();
  // canvas は CSS でも 960x540 なのでスケール補正を入れて堅牢にする
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (ev.clientX - rect.left) * sx;
  const py = (ev.clientY - rect.top) * sy;
  return { tx: Math.floor(px / TILE), ty: Math.floor(py / TILE) };
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.focus();
  if (!started) return;   // アトラクト中はプレイヤー操作を無効化
  if (Game.over) {
    // GAME OVER 中のクリックでリスタート
    restart();
    return;
  }
  const { tx, ty } = pointerToTile(ev);
  if (ev.button === 0) {
    tryPlaceTower(tx, ty);   // 左クリック: 設置
  } else if (ev.button === 2) {
    tryRemoveTower(tx, ty);  // 右クリック: 撤去
  }
});

window.addEventListener("keydown", (ev) => {
  const k = ev.key;
  if (k === "+" || k === "=" || k === "Add") {
    setCap(Game.cap + CAP_STEP);
  } else if (k === "-" || k === "_" || k === "Subtract") {
    setCap(Game.cap - CAP_STEP);
  } else if (k === "r" || k === "R") {
    restart();
  } else if (k === "Enter") {
    if (!started) startGame();
  }
});
window.addEventListener("blur", () => {});

function setCap(n) {
  Game.cap = Math.max(MIN_CAP, Math.min(MAX_CAP, n));
}

/* =========================================================================
 *  更新
 * ========================================================================= */
function update(dt) {
  if (Game.over) return;

  /* --- スポーン: 0.5s 間隔で、生存数が上限未満のときのみ供給 --- */
  Game.spawnTimer -= dt;
  if (Game.spawnTimer <= 0) {
    Game.spawnTimer += SPAWN_INTERVAL;
    if (liveCreepCount() < Game.cap) spawnCreep();
    // タイマーが大きく遅れた場合の暴走防止
    if (Game.spawnTimer < 0) Game.spawnTimer = SPAWN_INTERVAL;
  }

  /* --- 敵: 経路追従 --- */
  for (const c of Game.creeps) {
    if (!c.alive) continue;
    const path = c.path;
    if (!path || c.wp >= path.length) {
      // 経路末尾 = ゴール到達扱い
      reachGoal(c);
      continue;
    }
    let remain = CREEP_SPEED * dt;
    // 1フレームで複数ウェイポイントをまたぐ可能性に対応
    while (remain > 0 && c.wp < path.length) {
      const wpt = path[c.wp];
      const tx2 = tileCenterX(wpt.tx);
      const ty2 = tileCenterY(wpt.ty);
      const dx = tx2 - c.x, dy = ty2 - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= remain || dist < 0.0001) {
        // ウェイポイント到達
        c.x = tx2; c.y = ty2;
        remain -= dist;
        c.wp++;
      } else {
        c.x += (dx / dist) * remain;
        c.y += (dy / dist) * remain;
        remain = 0;
      }
    }
    if (c.wp >= path.length) {
      reachGoal(c);
    }
  }

  /* --- タワー: 射程内の最も進行度の高い敵を狙撃 --- */
  for (const t of Game.towers) {
    t.cool -= dt;
    if (t.cool > 0) continue;
    const target = pickTarget(t);
    if (target) {
      fireProjectile(t, target);
      t.cool = TOWER_FIRE_INTERVAL;
    }
  }

  /* --- 弾: 直進 + 命中判定 --- */
  for (let i = Game.projectiles.length - 1; i >= 0; i--) {
    const p = Game.projectiles[i];
    if (!p.alive) { removeProjectile(i); continue; }

    // 標的が消滅していたら最後の方向に直進し続ける (画面外で破棄)
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // 画面外破棄
    if (p.x < -40 || p.x > VIEW_W + 40 || p.y < -40 || p.y > VIEW_H + 40) {
      removeProjectile(i);
      continue;
    }

    // 命中: 弾と全生存敵の距離判定 (距離 < 敵半径 + 弾半径)
    let hit = null;
    const hitR = CREEP_R + PROJ_R;
    if (p.target && p.target.alive) {
      // まず標的を優先判定
      if (Math.hypot(p.x - p.target.x, p.y - p.target.y) < hitR) hit = p.target;
    }
    if (!hit) {
      for (const c of Game.creeps) {
        if (!c.alive) continue;
        if (Math.hypot(p.x - c.x, p.y - c.y) < hitR) { hit = c; break; }
      }
    }
    if (hit) {
      hit.hp -= TOWER_DMG;
      if (hit.hp <= 0) killCreep(hit);
      removeProjectile(i);
    }
  }

  /* --- スパーク (撃破エフェクト) --- */
  for (let i = Game.effects.length - 1; i >= 0; i--) {
    const f = Game.effects[i];
    f.life -= dt;
    f.y -= 40 * dt;
    if (f.life <= 0) {
      returnSpark(f.spr);
      Game.effects.splice(i, 1);
    }
  }
}

// 射程内で「最も進行度が高い (ゴールに近い)」敵を選ぶ。
// 進行度 = 残ウェイポイント数が少ないほど高い。
function pickTarget(t) {
  let best = null;
  let bestProg = -Infinity;
  const r2 = TOWER_RANGE * TOWER_RANGE;
  for (const c of Game.creeps) {
    if (!c.alive) continue;
    const dx = c.x - t.cx, dy = c.y - t.cy;
    if (dx * dx + dy * dy > r2) continue;
    // 進行度: 経路長 - 残り。大きいほどゴールに近い。
    const prog = (c.path ? c.path.length - c.wp : 0) * -1; // 残りが少ない=大きい
    if (prog > bestProg) { bestProg = prog; best = c; }
  }
  return best;
}

function fireProjectile(t, target) {
  const spr = getProjSprite();
  const dx = target.x - t.cx, dy = target.y - t.cy;
  const dist = Math.hypot(dx, dy) || 1;
  const p = {
    spr,
    x: t.cx, y: t.cy,
    vx: (dx / dist) * PROJ_SPEED,
    vy: (dy / dist) * PROJ_SPEED,
    target,
    alive: true,
  };
  spr.setPos(p.x, p.y, -3);
  Game.projectiles.push(p);
}

function removeProjectile(i) {
  returnProjSprite(Game.projectiles[i].spr);
  Game.projectiles.splice(i, 1);
}

function killCreep(c) {
  c.alive = false;
  returnCreepSprite(c.spr);
  Game.gold += KILL_GOLD;
  Game.score += KILL_SCORE;
  spawnSpark(c.x, c.y);
}

function reachGoal(c) {
  c.alive = false;
  returnCreepSprite(c.spr);
  Game.lives -= 1;
  if (Game.lives <= 0) {
    Game.lives = 0;
    gameOver();
  }
}

function spawnSpark(x, y) {
  const s = getSpark();
  s.setSize(20, 20);
  s.setPos(x, y, -4);
  Game.effects.push({ spr: s, x, y, life: SPARK_LIFE });
}

/* ---------- スパーク プール ---------- */
const sparkPool = [];
function getSpark() {
  let s = sparkPool.pop();
  if (!s) s = createEntitySprite("spark");
  s.setVisible(true);
  return s;
}
function returnSpark(s) {
  s.setVisible(false);
  s.setPos(-9999, -9999);
  sparkPool.push(s);
}

function gameOver() {
  Game.over = true;
  if (!started) return;   // アトラクト中は GAME OVER 表示を出さず、ループ側で再開する
  const go = document.getElementById("gameover");
  document.getElementById("goScore").textContent =
    "Score " + Game.score + " / Towers " + Game.towers.length;
  go.style.display = "flex";
}

/* =========================================================================
 *  リスタート (マップ・ゴールド・ライフ初期化)
 * ========================================================================= */
function restart() {
  // 全敵/弾/タワー/スパークを破棄
  for (const c of Game.creeps) c.spr.dispose();
  for (const p of Game.projectiles) p.spr.dispose();
  for (const t of Game.towers) t.spr.dispose();
  for (const f of Game.effects) f.spr.dispose();
  Game.creeps.length = 0;
  Game.projectiles.length = 0;
  Game.towers.length = 0;
  Game.effects.length = 0;
  // プールも破棄してクリーンに作り直す
  for (const s of creepPool) s.dispose(); creepPool.length = 0;
  for (const s of projPool) s.dispose(); projPool.length = 0;
  for (const s of sparkPool) s.dispose(); sparkPool.length = 0;

  Game.towerSet.clear();
  Game.gold = INIT_GOLD;
  Game.lives = INIT_LIVES;
  Game.score = 0;
  Game.spawnTimer = 0;
  Game.pathRecalcs = 0;
  Game.over = false;
  demoIdx = 0; demoTimer = 0;   // デモAIの自動配置進捗もリセット

  map = generateMap(); // 決定的なので毎回同じマップ
  recomputeGlobalPath(false);

  document.getElementById("gameover").style.display = "none";
  canvas.focus();
}

/* =========================================================================
 *  描画
 *   - グリッドタイル (通路/壁/ゴール) はプールで一括描画 (静的だが毎フレーム位置確定)
 *   - 経路ハイライト: 現在経路のセルを薄い矩形で重ねる
 *   - 敵/弾/スパーク はワールド px をそのまま置く
 * ========================================================================= */
let tileSprites = null;   // 静的タイル (一度だけ構築し以後位置変えず)
let baseSprite = null;
let startSprite = null;

// 静的タイル (通路/壁) を一度だけ構築する。壁/通路は決定的でリスタート以外変わらない。
function buildStaticTiles() {
  if (tileSprites) { for (const s of tileSprites) s.dispose(); }
  tileSprites = [];
  for (let ty = 0; ty < GRID_H; ty++) {
    for (let tx = 0; tx < GRID_W; tx++) {
      const type = map[ty * GRID_W + tx];
      const key = (type === T_WALL) ? "wall" : "path";
      const s = createEntitySprite(key);
      s.setSize(TILE - 1, TILE - 1); // わずかに隙間を空けてグリッド感を出す
      s.setPos(tileCenterX(tx), tileCenterY(ty), 5); // 一番奥
      tileSprites.push(s);
    }
  }
  // ゴール (base) とスタートマーカー
  if (baseSprite) baseSprite.dispose();
  baseSprite = createEntitySprite("base");
  baseSprite.setSize(TILE - 2, TILE - 2);
  baseSprite.setPos(tileCenterX(GOAL_TX), tileCenterY(GOAL_TY), 4);

  if (startSprite) startSprite.dispose();
  startSprite = createEntitySprite("base"); // スタートも base 図形を流用 (色は同緑)
  startSprite.setSize(TILE - 2, TILE - 2);
  startSprite.setAlpha(0.5);
  startSprite.setPos(tileCenterX(START_TX), tileCenterY(START_TY), 4);
}

/* ---------- 経路ハイライト (薄い矩形をプールで重ねる) ----------
 * 現在のスタート→ゴール経路セルへ "phl" (明るい青緑) の半透明矩形を重ねて可視化する。
 * phl は画像を持たないので必ず図形フォールバックになる (= 画像不要で経路が見える)。
 */
const pathPool = [];
let pathUsed = 0;
function renderPathHighlight() {
  pathUsed = 0;
  const path = Game.currentPath;
  if (path) {
    for (const cell of path) {
      let s = pathPool[pathUsed];
      if (!s) {
        s = createEntitySprite("phl");
        s.setSize(TILE - 10, TILE - 10);
        s.setAlpha(0.35); // 薄く重ねる
        pathPool[pathUsed] = s;
      }
      s.setVisible(true);
      s.setPos(tileCenterX(cell.tx), tileCenterY(cell.ty), 3); // タイルより手前/タワーより奥
      pathUsed++;
    }
  }
  for (let i = pathUsed; i < pathPool.length; i++) pathPool[i].setVisible(false);
}

function renderEntities() {
  for (const c of Game.creeps) {
    if (!c.alive) continue;
    c.spr.setPos(c.x, c.y, -2);
  }
  for (const p of Game.projectiles) {
    p.spr.setPos(p.x, p.y, -3);
  }
  for (const f of Game.effects) {
    f.spr.setPos(f.x, f.y, -4);
  }
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

  const live = liveCreepCount();
  const pathLen = Game.currentPath ? Game.currentPath.length : 0;
  const renderMode = managers.creep ? "Sprite(tex)" : "Plane(fallback)";

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>         <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Enemies</span>     <span class="hudVal">' + live + ' / ' + Game.cap + '</span>' +
      '  <span class="hudLabel">Towers</span> <span class="hudVal">' + Game.towers.length + '</span>\n' +
    '<span class="hudLabel">Projectiles</span> <span class="hudVal">' + Game.projectiles.length + '</span>\n' +
    '<span class="hudLabel">Path recalcs</span> <span class="hudVal">' + Game.pathRecalcs + '</span>' +
      '  <span class="hudLabel">Path len</span> <span class="hudVal">' + pathLen + '</span>\n' +
    '<span class="hudLabel">Gold</span> <span class="hudVal">' + Game.gold + '</span>' +
      '  <span class="hudLabel">Lives</span> <span class="hudVal">' + Game.lives + '</span>' +
      '  <span class="hudLabel">Score</span> <span class="hudVal">' + Game.score + '</span>\n' +
    '<span class="warn">Render</span>      <span class="hudVal">' + renderMode + '</span>' +
      (assetsAllOk ? '' : '  <span style="color:#888">(一部/全アセット欠落→図形描画)</span>');
}

/* =========================================================================
 *  起動: アセット確認 → 構築 → ループ開始
 * ========================================================================= */
let assetsAllOk = true;

async function boot() {
  const keysToCheck = ["creep", "tower", "proj", "path", "wall", "base", "spark"];
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

  buildStaticTiles();
  recomputeGlobalPath(false);

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制 (SPEC: clamp)

    // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
    if (Game.over && !started) restart();
    // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
    if (!started) demoTick(dt);

    update(dt);

    // タイトル点滅 (約0.45秒周期)
    if (!started && titleEl) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
    }

    renderPathHighlight();
    renderEntities();
    updateHud(dt);
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
