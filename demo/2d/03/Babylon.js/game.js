"use strict";

/* =========================================================================
 * テーマ3: トップダウンRPG探索 ―  Babylon.js 版
 *
 * 2D タイルマップを 3D エンジン (Babylon.js) で実装する。
 *  - 正射影(Orthographic)カメラを真上から見下ろし、ワールドは XY 平面。
 *  - タイル/エンティティは SpriteManager + Sprite で描画。
 *  - カメラ可視範囲のタイルのみをスプライトプールに割り当てる(カリング)。
 * ========================================================================= */

/* ---------- 定数 ---------- */
const VIEW_W = 960;
const VIEW_H = 540;
const TILE = 32;            // タイルサイズ px
const MAP_W = 100;          // マップ幅 (タイル)
const MAP_H = 100;          // マップ高 (タイル)
const MAP_PX_W = MAP_W * TILE;
const MAP_PX_H = MAP_H * TILE;

const MOVE_SPEED = 160;     // px/s
const DASH_MULT = 2;
const KNOCKBACK = 90;       // px ノックバック量

const INITIAL_ENTITIES = 60;
const MIN_ENTITIES = 0;
const MAX_ENTITIES = 2000;

// タイル種別: 0=草,1=道,2=水(不可),3=壁(不可),4=木(不可)
const T_GRASS = 0, T_PATH = 1, T_WATER = 2, T_WALL = 3, T_TREE = 4;
const BLOCKED = new Set([T_WATER, T_WALL, T_TREE]);

// フォールバック色 (SPEC: 草=緑,道=茶,水=青,壁=灰,自機=白,NPC=黄,slime=緑丸)
const COLOR = {
  grass: "#3e8e41",
  path:  "#9c6b3f",
  water: "#2f6fd0",
  wall:  "#777777",
  tree:  "#1f5d2a",
  player:"#ffffff",
  npc:   "#ffd23f",
  slime: "#4ee06a",
};

const ASSET_DIR = "../assets/";
const ASSETS = {
  tile_grass:  "tile_grass.png",
  tile_path:   "tile_path.png",
  tile_water:  "tile_water.png",
  tile_wall:   "tile_wall.png",
  tree:        "tree.png",
  player:      "player.png",
  npc:         "npc.png",
  enemy_slime: "enemy_slime.png",
};

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- マップ決定的生成 ---------- */
function generateMap() {
  // 全エンジン共通の決定的生成（three.js と同一: mulberry32(1337)・同手順）。
  const rnd = mulberry32(1337);
  const map = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < map.length; i++) map[i] = T_GRASS;
  const idx = (x, y) => y * MAP_W + x;

  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const r = rnd();
      if (r < 0.06) map[idx(x, y)] = T_WATER;
      else if (r < 0.14) map[idx(x, y)] = T_TREE;
      else if (r < 0.17) map[idx(x, y)] = T_WALL;
    }
  }
  const lanes = 6;
  for (let i = 0; i < lanes; i++) {
    const ry = 6 + Math.floor(rnd() * (MAP_H - 12));
    for (let x = 1; x < MAP_W - 1; x++) map[idx(x, ry)] = T_PATH;
    const rx = 6 + Math.floor(rnd() * (MAP_W - 12));
    for (let y = 1; y < MAP_H - 1; y++) map[idx(rx, y)] = T_PATH;
  }
  for (let x = 0; x < MAP_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, MAP_H - 1)] = T_WALL; }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_WALL; map[idx(MAP_W - 1, y)] = T_WALL; }
  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return map[ty * MAP_W + tx];
}

// ============================================================
// 共有デモシミュレーション（全エンジン共通・three.js と同一）
//   three.js 座標系（左上原点・Y下・28x28 corner px）で走り、デモ中の自機経路を
//   全エンジンで一致させる。spawn=mulberry32(99) / 巡回=mulberry32(20240619) / 160px/s。
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
function simInitDemo(map, idx) {
  SIM.map = map; SIM.idx = idx;
  const rnd = mulberry32(99);
  let sx = 1, sy = 1;
  for (let i = 0; i < 5000; i++) {
    const tx = 1 + Math.floor(rnd() * (MAP_W - 2));
    const ty = 1 + Math.floor(rnd() * (MAP_H - 2));
    if (!simBlockedTile(map[idx(tx, ty)])) { sx = tx; sy = ty; break; }
  }
  SIM.player = { x: sx * TILE, y: sy * TILE, w: 28, h: 28 };
  SIM.demoRnd = mulberry32(20240619);
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

/* ---------- ワールド <-> Babylon座標 ----------
 * ワールドは px 空間 (0..MAP_PX_W, 0..MAP_PX_H), 原点左上, +y 下方向。
 * Babylon は +y 上方向なので y を反転して扱う。
 * world(px) -> babylon: bx = px - MAP_PX_W/2 ; by = MAP_PX_H/2 - py
 */
function toBabylonX(px) { return px - MAP_PX_W / 2; }
function toBabylonY(py) { return MAP_PX_H / 2 - py; }

/* ---------- フォールバック用テクスチャ生成 ---------- */
function makeColorTexture(scene, hex, opts) {
  opts = opts || {};
  const size = 64;
  const dt = new BABYLON.DynamicTexture("fb_" + hex + (opts.tag || ""), size, scene, false);
  dt.hasAlpha = true;
  const ctx = dt.getContext();
  ctx.clearRect(0, 0, size, size);
  if (opts.circle) {
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();
  } else {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, size, size);
    // 軽い枠でタイル境界を視認しやすく
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  }
  dt.update();
  return dt;
}

/* =========================================================================
 *  メイン
 * ========================================================================= */
window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("renderCanvas");
  const hud = document.getElementById("hud");
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false }, true);
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.07, 0.1, 1);
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;

  // --- 正射影カメラ (真上から見下ろし) ---
  const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
  camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -VIEW_W / 2;
  camera.orthoRight = VIEW_W / 2;
  camera.orthoTop = VIEW_H / 2;
  camera.orthoBottom = -VIEW_H / 2;
  camera.setTarget(BABYLON.Vector3.Zero());
  camera.minZ = 0.1;
  camera.maxZ = 1000;

  // sprite が見えるよう環境光
  new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 0, -1), scene);

  /* ---------- アセット読込 (欠落時はフォールバック) ---------- */
  // 各 SpriteManager は単一テクスチャを使う。タイル種別ごとに 1 manager。
  const map = generateMap();
  // 木の総数（Entities集計用・three.jsの treeCount と同義）。1回だけ数えてキャッシュ。
  let TREE_TOTAL = 0;
  for (let i = 0; i < map.length; i++) if (map[i] === T_TREE) TREE_TOTAL++;

  // 各タイル種別ごとの SpriteManager をプール上限つきで作成。
  // 可視タイル数の上限: 画面に入るタイル数 + 余白
  const colsVisible = Math.ceil(VIEW_W / TILE) + 4;
  const rowsVisible = Math.ceil(VIEW_H / TILE) + 4;
  const maxVisibleTiles = colsVisible * rowsVisible; // 各種別あたりの上限

  const tileManagers = {}; // type -> {mgr, pool:[], color, isTree}
  const tileDefs = [
    { type: T_GRASS, key: "tile_grass", color: COLOR.grass, tree: false },
    { type: T_PATH,  key: "tile_path",  color: COLOR.path,  tree: false },
    { type: T_WATER, key: "tile_water", color: COLOR.water, tree: false },
    { type: T_WALL,  key: "tile_wall",  color: COLOR.wall,  tree: false },
    { type: T_TREE,  key: "tree",       color: COLOR.tree,  tree: true  },
  ];

  let usingFallback = { tiles: false, entities: false };

  function buildTileManager(def) {
    const url = ASSET_DIR + ASSETS[def.key];
    const mgr = new BABYLON.SpriteManager(
      "tm_" + def.key, url, maxVisibleTiles, { width: TILE, height: def.tree ? 48 : TILE }, scene
    );
    // 画像欠落 -> フォールバックの DynamicTexture に差し替え
    mgr.texture.onLoadObservable.addOnce(() => {});
    const img = new Image();
    img.onerror = () => {
      usingFallback.tiles = true;
      const fb = makeColorTexture(scene, def.color, { tag: def.key });
      mgr.texture.dispose();
      mgr.texture = fb;
      mgr.cellWidth = 64;
      mgr.cellHeight = 64;
    };
    img.src = url;
    mgr.isPickable = false;
    tileManagers[def.type] = { mgr, pool: [], def };
  }
  tileDefs.forEach(buildTileManager);

  /* ---------- エンティティ用 SpriteManager ---------- */
  function buildEntityManager(key, color, circle, capacity) {
    const url = ASSET_DIR + ASSETS[key];
    const mgr = new BABYLON.SpriteManager("em_" + key, url, capacity, { width: TILE, height: TILE }, scene);
    const img = new Image();
    img.onerror = () => {
      usingFallback.entities = true;
      const fb = makeColorTexture(scene, color, { circle: circle, tag: key });
      mgr.texture.dispose();
      mgr.texture = fb;
      mgr.cellWidth = 64;
      mgr.cellHeight = 64;
    };
    img.src = url;
    mgr.isPickable = false;
    return mgr;
  }

  const npcMgr   = buildEntityManager("npc",         COLOR.npc,   false, MAX_ENTITIES + 8);
  const slimeMgr = buildEntityManager("enemy_slime", COLOR.slime, true,  MAX_ENTITIES + 8);
  const playerMgr = buildEntityManager("player",     COLOR.player,false, 4);

  /* ---------- プレイヤー ---------- */
  // 歩行可能な開始タイルを探す
  let startTx = Math.floor(MAP_W / 2), startTy = Math.floor(MAP_H / 2);
  outer: for (let r = 0; r < 30; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = startTx + dx, ty = startTy + dy;
        if (!BLOCKED.has(tileAt(map, tx, ty))) { startTx = tx; startTy = ty; break outer; }
      }
    }
  }
  const player = {
    x: startTx * TILE + TILE / 2,
    y: startTy * TILE + TILE / 2,
    spr: new BABYLON.Sprite("player", playerMgr),
  };
  player.spr.width = TILE;
  player.spr.height = TILE;
  player.spr.position.z = -3; // 手前

  /* ---------- デモ用シミュレーション初期化（全エンジン共通の経路） ---------- */
  simInitDemo(map, (x, y) => y * MAP_W + x);
  player.x = SIM.player.x + SIM.player.w / 2;
  player.y = SIM.player.y + SIM.player.h / 2;

  /* ---------- タイトル/アトラクト状態 ---------- */
  const titleEl = document.getElementById("title");
  let started = false, blinkT = 0, demoStuckT = 0;
  const spawnPx = player.x, spawnPy = player.y;
  const demoRnd = mulberry32(20240619); // デモAI(決定的)
  let demoTarget = null;
  function pickDemoTarget() {
    for (let i = 0; i < 100; i++) {
      const tx = 1 + Math.floor(demoRnd() * (MAP_W - 2));
      const ty = 1 + Math.floor(demoRnd() * (MAP_H - 2));
      if (!BLOCKED.has(tileAt(map, tx, ty))) {
        demoTarget = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
        return;
      }
    }
    demoTarget = { x: spawnPx, y: spawnPy };
  }
  pickDemoTarget();
  function demoInput() {
    if (!demoTarget) pickDemoTarget();
    const dx = demoTarget.x - player.x, dy = demoTarget.y - player.y;
    if (Math.hypot(dx, dy) < TILE * 0.6) { pickDemoTarget(); demoStuckT = 0; return [0, 0]; }
    if (Math.abs(dx) > Math.abs(dy)) return [dx > 0 ? 1 : -1, 0];
    return [0, dy > 0 ? 1 : -1];
  }
  function startGame() {
    started = true;
    player.x = spawnPx; player.y = spawnPy;
    setEntityCount(INITIAL_ENTITIES);
    titleEl.style.display = "none";
  }

  /* ---------- エンティティ(NPC/スライム) ---------- */
  // ent: {type:'npc'|'slime', x,y, spr, dir, timer}
  const entities = [];
  const entRnd = mulberry32(98765);

  function randomWalkableTile() {
    for (let i = 0; i < 200; i++) {
      const tx = 1 + Math.floor(entRnd() * (MAP_W - 2));
      const ty = 1 + Math.floor(entRnd() * (MAP_H - 2));
      if (!BLOCKED.has(tileAt(map, tx, ty))) return { tx, ty };
    }
    return { tx: startTx, ty: startTy };
  }

  function spawnEntity() {
    const isSlime = entRnd() < 0.5;
    const { tx, ty } = randomWalkableTile();
    const mgr = isSlime ? slimeMgr : npcMgr;
    const spr = new BABYLON.Sprite("e" + entities.length, mgr);
    spr.width = TILE;
    spr.height = TILE;
    spr.position.z = -2;
    const e = {
      type: isSlime ? "slime" : "npc",
      x: tx * TILE + TILE / 2,
      y: ty * TILE + TILE / 2,
      spr,
      dir: Math.floor(entRnd() * 4),
      timer: entRnd() * 1.2,
      speed: isSlime ? 55 : 35,
    };
    entities.push(e);
  }
  function despawnEntity() {
    const e = entities.pop();
    if (e) e.spr.dispose();
  }
  function setEntityCount(n) {
    n = Math.max(MIN_ENTITIES, Math.min(MAX_ENTITIES, n));
    while (entities.length < n) spawnEntity();
    while (entities.length > n) despawnEntity();
  }
  setEntityCount(INITIAL_ENTITIES);

  /* ---------- 入力 ---------- */
  const keys = Object.create(null);
  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === "Enter" && !started) startGame();
    if (e.key === "+" || e.key === "=" || e.key === "Add") {
      setEntityCount(entities.length + 10);
    } else if (e.key === "-" || e.key === "_" || e.key === "Subtract") {
      setEntityCount(entities.length - 10);
    }
    if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(e.key.toLowerCase())) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
  window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

  /* ---------- 衝突判定 ---------- */
  const HALF = TILE * 0.35; // 自機の当たり半径(やや小さめ)
  function canBeAt(px, py) {
    // AABB の四隅をチェック
    const pts = [
      [px - HALF, py - HALF], [px + HALF, py - HALF],
      [px - HALF, py + HALF], [px + HALF, py + HALF],
    ];
    for (const [cx, cy] of pts) {
      const tx = Math.floor(cx / TILE);
      const ty = Math.floor(cy / TILE);
      if (BLOCKED.has(tileAt(map, tx, ty))) return false;
    }
    return true;
  }
  function moveAxis(px, py, dx, dy) {
    // 軸分離移動: x と y を別々に試す
    let nx = px + dx, ny = py;
    if (canBeAt(nx, ny)) px = nx;
    ny = py + dy;
    if (canBeAt(px, ny)) py = ny;
    return [px, py];
  }

  /* ---------- FPS 移動平均 ---------- */
  const fpsBuf = [];
  let fpsAvg = 0;
  function pushFps(dt) {
    if (dt <= 0) return;
    fpsBuf.push(1 / dt);
    if (fpsBuf.length > 30) fpsBuf.shift();
    let s = 0; for (const v of fpsBuf) s += v;
    fpsAvg = s / fpsBuf.length;
  }

  /* ---------- カリング: 可視タイル描画 ---------- */
  let tilesDrawn = 0;
  function renderVisibleTiles() {
    // カメラ中心(ワールドpx)
    const camPx = player.x;
    const camPy = player.y;
    const halfCols = Math.ceil(VIEW_W / TILE / 2) + 2;
    const halfRows = Math.ceil(VIEW_H / TILE / 2) + 2;
    const ctx = Math.floor(camPx / TILE);
    const cty = Math.floor(camPy / TILE);
    const x0 = Math.max(0, ctx - halfCols);
    const x1 = Math.min(MAP_W - 1, ctx + halfCols);
    const y0 = Math.max(0, cty - halfRows);
    const y1 = Math.min(MAP_H - 1, cty + halfRows);

    // 各 manager のプール使用カウンタをリセット
    for (const t in tileManagers) tileManagers[t]._used = 0;

    tilesDrawn = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const type = map[ty * MAP_W + tx];
        const tm = tileManagers[type];
        const idx = tm._used++;
        let spr = tm.pool[idx];
        if (!spr) {
          spr = new BABYLON.Sprite("t", tm.mgr);
          spr.width = TILE;
          spr.height = tm.def.tree ? 48 : TILE;
          tm.pool[idx] = spr;
        }
        spr.isVisible = true;
        // タイル中心
        const wx = tx * TILE + TILE / 2;
        const wy = ty * TILE + TILE / 2;
        spr.position.x = toBabylonX(wx);
        // 木は背が高い(32x48)ので底辺を合わせ少し上にオフセット
        if (tm.def.tree) {
          spr.position.y = toBabylonY(wy) + 8;
          spr.position.z = -1; // タイルより手前(木の重なり)
        } else {
          spr.position.y = toBabylonY(wy);
          spr.position.z = 0;
        }
        tilesDrawn++;
      }
    }
    // 余ったプールスプライトを隠す
    for (const t in tileManagers) {
      const tm = tileManagers[t];
      for (let i = tm._used; i < tm.pool.length; i++) {
        if (tm.pool[i].isVisible) tm.pool[i].isVisible = false;
      }
    }
  }

  /* ---------- エンティティ更新 (徘徊 + カリング表示) ---------- */
  const DIRV = [[0,-1],[0,1],[-1,0],[1,0]];
  function updateEntities(dt) {
    const viewHalfW = VIEW_W / 2 + TILE;
    const viewHalfH = VIEW_H / 2 + TILE;
    for (const e of entities) {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.timer = 0.6 + entRnd() * 1.6;
        e.dir = (entRnd() < 0.25) ? -1 : Math.floor(entRnd() * 4); // -1=停止
      }
      if (e.dir >= 0) {
        const [vx, vy] = DIRV[e.dir];
        const nx = e.x + vx * e.speed * dt;
        const ny = e.y + vy * e.speed * dt;
        // 簡易衝突: 進入不可なら方向転換
        const tx = Math.floor(nx / TILE), ty = Math.floor(ny / TILE);
        if (!BLOCKED.has(tileAt(map, tx, ty))) {
          e.x = nx; e.y = ny;
        } else {
          e.timer = 0; // 次フレームで方向再抽選
        }
      }
      // カメラ視野外は非表示(描画負荷削減)
      const sx = e.x - player.x;
      const sy = e.y - player.y;
      if (Math.abs(sx) > viewHalfW || Math.abs(sy) > viewHalfH) {
        if (e.spr.isVisible) e.spr.isVisible = false;
      } else {
        e.spr.isVisible = true;
        e.spr.position.x = toBabylonX(e.x);
        e.spr.position.y = toBabylonY(e.y);
      }
    }
  }

  /* ---------- ノックバック ---------- */
  function handleCollisions() {
    const r = TILE * 0.6;
    for (const e of entities) {
      if (e.type !== "slime") continue;
      const dx = player.x - e.x;
      const dy = player.y - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 1;
        const [kx, ky] = moveAxis(player.x, player.y, (dx / d) * KNOCKBACK, (dy / d) * KNOCKBACK);
        player.x = kx; player.y = ky;
      }
    }
  }

  /* ---------- メインループ ---------- */
  let hudTimer = 0;
  scene.onBeforeRenderObservable.add(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.1) dt = 0.1; // タブ復帰などのスパイク抑制
    pushFps(dt);

    // 入力 -> 移動
    let dashing = false;
    if (!started) {
      // デモ中は共有シミュレーションで自機を駆動（全エンジン同一の経路）
      simStep(dt);
      player.x = SIM.player.x + SIM.player.w / 2;
      player.y = SIM.player.y + SIM.player.h / 2;
    } else {
      let dx = 0, dy = 0;
      if (keys["arrowleft"] || keys["a"]) dx -= 1;
      if (keys["arrowright"] || keys["d"]) dx += 1;
      if (keys["arrowup"] || keys["w"]) dy -= 1;     // 画面上 = ワールド -y
      if (keys["arrowdown"] || keys["s"]) dy += 1;
      if (dx !== 0 && dy !== 0) { const s = Math.SQRT1_2; dx *= s; dy *= s; }
      dashing = !!keys["shift"];
      const speed = MOVE_SPEED * (dashing ? DASH_MULT : 1);
      if (dx !== 0 || dy !== 0) {
        const [nx, ny] = moveAxis(player.x, player.y, dx * speed * dt, dy * speed * dt);
        player.x = nx; player.y = ny;
      }
    }

    handleCollisions();

    // プレイヤー表示
    player.spr.position.x = toBabylonX(player.x);
    player.spr.position.y = toBabylonY(player.y);

    // カメラ追従 (マップ端でクランプ)
    let camPx = player.x, camPy = player.y;
    camPx = Math.max(VIEW_W / 2, Math.min(MAP_PX_W - VIEW_W / 2, camPx));
    camPy = Math.max(VIEW_H / 2, Math.min(MAP_PX_H - VIEW_H / 2, camPy));
    camera.position.x = toBabylonX(camPx);
    camera.position.y = toBabylonY(camPy);

    // 描画(カリング)
    renderVisibleTiles();
    updateEntities(dt);

    // HUD (約 10Hz 更新)
    hudTimer += dt;
    if (hudTimer >= 0.1) {
      hudTimer = 0;
      const ptx = Math.floor(player.x / TILE);
      const pty = Math.floor(player.y / TILE);
      const visTrees = tileManagers[T_TREE]._used || 0;   // 可視木数（three.js の treesDrawn）
      // 表示内容・書式は three.js に統一
      hud.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${tilesDrawn}  (trees: ${visTrees})\n` +
        `Entities    : ${entities.length + TREE_TOTAL}  (NPC+敵:${entities.length} / 木:${TREE_TOTAL})\n` +
        `Player tile : (${ptx}, ${pty})  ${dashing ? '[DASH]' : ''}`;
    }

    // タイトル点滅 (アトラクト中のみ)
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
    }
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
});
