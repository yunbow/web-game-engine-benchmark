/* ============================================================================
 * テーマ6 タワーディフェンス（経路探索 × 多数ユニット追従）― KAPLAY 実装
 * 共通仕様 SPEC.md / 基準実装 PixiJS に厳密準拠。性能比較用。
 *
 * 本テーマの主軸は「描画」ではなく CPU 側 AI ロジック:
 *   - グリッド A* 経路探索 (4方向 / コスト1 / マンハッタン距離ヒューリスティック)
 *   - 多数ユニット (creep) の経路追従更新
 *   - タワー射撃 (射程内の最進行度敵を狙い projectile 発射)
 *
 * KAPLAY は「全部入り」2D ライブラリだが、本テーマでは描画・ループ・入力のみ
 * KAPLAY を使い、A* / 経路追従 / 弾の直進 / 距離判定はすべて自前実装する
 * (エンジン組み込みの経路探索は使わない＝再計算回数を観測する目的)。
 *   - 座標系は Y 下向き・原点左上 = グリッド画面座標とそのまま一致 (変換不要)。
 *   - creep / projectile / spark はプール再利用 (生成破棄コストを抑える)。
 *   - 決定的擬似乱数 (mulberry32, Math.random は使わない)。
 * ========================================================================== */

// ---- 定数 (SPEC) — 全エンジン共通値 ----------------------------------------
const TILE = 32;
const GRID_W = 30;            // 30 タイル
const GRID_H = 17;            // 17 タイル
const VIEW_W = 960;
const VIEW_H = 540;           // 960 x 540 (グリッドは 960 x 544 だが下4pxは画面外)

const START_TX = 0, START_TY = 8;          // 左端中央 (開口部)
const GOAL_TX = GRID_W - 1, GOAL_TY = 8;   // 右端中央

const T_PATH = 0, T_WALL = 1;

const CREEP_R = 10;           // 半径10 (描画直径 ~24)
const CREEP_SPEED = 70;       // 70 px/s
const CREEP_HP = 30;          // HP 30
const SPAWN_INTERVAL = 0.5;   // 0.5s ごとにスポーン

const TOWER_COST = 25;        // 設置 25 Gold
const TOWER_RANGE = 96;       // 射程 96 px
const TOWER_FIRE_CD = 0.6;    // 連射間隔 0.6 s
const PROJ_DMG = 10;          // 弾ダメージ 10
const PROJ_SPEED = 320;       // 弾速 320 px/s
const PROJ_R = 6;             // 弾半径 6

const CAP_INIT = 30;
const CAP_STEP = 10;
const CAP_MIN = 10;
const CAP_MAX = 500;

const GOLD_INIT = 120;
const LIVES_INIT = 20;
const GOLD_KILL = 5;
const SCORE_KILL = 10;

// アセット (../assets/ から。失敗時は単色図形フォールバック)
const ASSET_DEFS = {
  creep:      '../assets/creep.png',
  tower:      '../assets/tower.png',
  projectile: '../assets/projectile.png',
  tile_path:  '../assets/tile_path.png',
  tile_wall:  '../assets/tile_wall.png',
  base:       '../assets/base.png',
  hit_spark:  '../assets/hit_spark.png',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const idx = (tx, ty) => ty * GRID_W + tx;

// ---- 決定的擬似乱数 (mulberry32) — 全エンジン共通の決定的マップ生成のため -----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- A* 経路探索 -----------------------------------------------------------
// 4方向 (上下左右), コスト1, マンハッタン距離ヒューリスティック。自前実装。
// 返り値: タイル列 [{tx,ty}, ...] (start→goal を含む) / 到達不能なら null。
function aStar(map, sx, sy, gx, gy, towerBlocked) {
  if (map[idx(gx, gy)] === T_WALL) return null;
  const N = GRID_W * GRID_H;
  const came = new Int32Array(N).fill(-1);
  const gScore = new Float32Array(N).fill(Infinity);
  const fScore = new Float32Array(N).fill(Infinity);
  const inOpen = new Uint8Array(N);
  const closed = new Uint8Array(N);

  const startId = idx(sx, sy);
  const goalId = idx(gx, gy);
  const h = (tx, ty) => Math.abs(tx - gx) + Math.abs(ty - gy);

  gScore[startId] = 0;
  fScore[startId] = h(sx, sy);
  const open = [startId];
  inOpen[startId] = 1;

  const isBlocked = (tx, ty) => {
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return true;
    if (map[idx(tx, ty)] === T_WALL) return true;
    if (towerBlocked && towerBlocked.has(idx(tx, ty))) return true;
    return false;
  };

  const DX = [1, -1, 0, 0];
  const DY = [0, 0, 1, -1];

  while (open.length > 0) {
    // open から最小 fScore を線形探索で取り出す (510 セルと小さいので十分)
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestI]]) bestI = i;
    }
    const current = open[bestI];
    open[bestI] = open[open.length - 1];
    open.pop();
    inOpen[current] = 0;

    if (current === goalId) {
      const path = [];
      let c = current;
      while (c !== -1) {
        path.push({ tx: c % GRID_W, ty: Math.floor(c / GRID_W) });
        c = came[c];
      }
      path.reverse();
      return path;
    }
    closed[current] = 1;
    const cx = current % GRID_W;
    const cy = Math.floor(current / GRID_W);

    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (isBlocked(nx, ny)) continue;
      const nId = idx(nx, ny);
      if (closed[nId]) continue;
      const tentative = gScore[current] + 1;
      if (tentative < gScore[nId]) {
        came[nId] = current;
        gScore[nId] = tentative;
        fScore[nId] = tentative + h(nx, ny);
        if (!inOpen[nId]) { open.push(nId); inOpen[nId] = 1; }
      }
    }
  }
  return null;
}

// ---- マップ決定的生成 (PixiJS 基準と同一手順・同一シード) -------------------
function generateMap() {
  const rnd = mulberry32(20250615);
  const map = new Uint8Array(GRID_W * GRID_H); // 既定 0 = 通路

  for (let x = 0; x < GRID_W; x++) {
    map[idx(x, 0)] = T_WALL;
    map[idx(x, GRID_H - 1)] = T_WALL;
  }
  for (let y = 0; y < GRID_H; y++) {
    map[idx(0, y)] = T_WALL;
    map[idx(GRID_W - 1, y)] = T_WALL;
  }
  map[idx(START_TX, START_TY)] = T_PATH;
  map[idx(GOAL_TX, GOAL_TY)] = T_PATH;

  const blocks = 26;
  for (let i = 0; i < blocks; i++) {
    const bx = 2 + Math.floor(rnd() * (GRID_W - 4));
    const by = 2 + Math.floor(rnd() * (GRID_H - 4));
    const vertical = rnd() < 0.5;
    const len = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < len; k++) {
      const wx = vertical ? bx : bx + k;
      const wy = vertical ? by + k : by;
      if (wx <= 1 || wx >= GRID_W - 2 || wy <= 1 || wy >= GRID_H - 2) continue;
      if (wy === START_TY && (wx <= 2 || wx >= GRID_W - 3)) continue;
      map[idx(wx, wy)] = T_WALL;
    }
  }

  // 疎通保証: スタート→ゴールが通れるまで、中央水平ラインの壁を決定的に間引く
  let guard = 0;
  while (!aStar(map, START_TX, START_TY, GOAL_TX, GOAL_TY) && guard < 4000) {
    guard++;
    let removed = false;
    for (let x = 1; x < GRID_W - 1 && !removed; x++) {
      if (map[idx(x, START_TY)] === T_WALL) {
        map[idx(x, START_TY)] = T_PATH;
        removed = true;
      }
    }
    if (!removed) break;
  }
  return map;
}

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: [20, 24, 31],   // 0x14181f
  crisp: true,
  global: false,              // 名前空間 k.* を明示利用 (グローバル汚染を避ける)
});

// === アセット読み込み (失敗してもフォールバックで起動) ======================
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { await k.loadSprite(key, url); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

function start() {
  // タイル中心の px 座標
  const cellCenterX = (tx) => tx * TILE + TILE / 2;
  const cellCenterY = (ty) => ty * TILE + TILE / 2;

  // =====================================================================
  // ゲーム状態 (R リスタートで丸ごと再構築)
  // =====================================================================
  let map;                 // Uint8Array (壁/通路)
  let towers;              // [{tx,ty,cd}]
  let towerBlocked;        // Set<cellId> (タワーが塞ぐセル)
  let creeps;              // [{x,y,hp,path,wp,sprite}]
  let projectiles;         // [{x,y,vx,vy,sprite}]
  let sparks;              // [{x,y,life,max,sprite}]
  let currentPath;         // 現在のスタート→ゴール経路 (タイル列)
  let pathRecalcs;         // 経路再計算の累計回数 (HUD の比較指標)
  let gold, lives, score;
  let enemyCap;            // 同時出現上限 (負荷)
  let spawnTimer;
  let gameOver;

  // ---- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ----
  let started = false, blinkT = 0;
  const DEMO_TOWERS = [
    [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
    [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
  ];
  let demoIdx = 0, demoTimer = 0;
  const titleEl = document.getElementById('title');
  function startGame() { started = true; reset(); titleEl.style.display = 'none'; }
  function demoTick(dt) {
    demoTimer += dt;
    if (demoTimer >= 0.8 && demoIdx < DEMO_TOWERS.length && gold >= TOWER_COST) {
      demoTimer = 0;
      const [tx, ty] = DEMO_TOWERS[demoIdx++];
      placeTower(tx, ty);
    }
  }

  // ---- スプライトプール (creep / projectile / spark は破棄せず再利用) ----
  const creepPool = [], projPool = [], sparkPool = [];
  const tilePool = [];     // 30x17 全タイル (最大 510 枚を再利用)
  const towerSprites = []; // タワー毎の固定スプライト

  // タイルスプライト生成 (奥に固定。fallback は矩形)
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const tx = i % GRID_W, ty = Math.floor(i / GRID_W);
    let comps;
    if (loaded.tile_path) comps = [k.sprite('tile_path')];
    else comps = [k.rect(TILE, TILE), k.color(42, 47, 58), k.outline(1, k.rgb(58, 65, 80))];
    const s = k.add([...comps, k.pos(tx * TILE, ty * TILE), k.anchor('topleft'), k.z(0)]);
    if (loaded.tile_path) { s.width = TILE; s.height = TILE; }
    tilePool.push(s);
  }

  // ゴール (base) スプライト (固定)
  let baseSprite;
  if (loaded.base) {
    baseSprite = k.add([k.sprite('base'), k.pos(GOAL_TX * TILE, GOAL_TY * TILE), k.anchor('topleft'), k.z(5)]);
    baseSprite.width = TILE; baseSprite.height = TILE;
  } else {
    baseSprite = k.add([k.rect(TILE - 6, TILE - 6), k.color(63, 196, 99), k.opacity(0.85),
      k.pos(GOAL_TX * TILE + 3, GOAL_TY * TILE + 3), k.anchor('topleft'), k.z(5)]);
  }

  // 経路ハイライト (図形で薄く重ねて可視化。経路更新時のみ再構築)
  let pathCells = [];   // セル塗り用の薄い矩形群
  function clearPathGfx() { for (const o of pathCells) k.destroy(o); pathCells = []; }
  function redrawPath() {
    clearPathGfx();
    if (!currentPath || currentPath.length === 0) return;
    for (const c of currentPath) {
      const r = k.add([k.rect(TILE - 8, TILE - 8), k.color(95, 168, 255), k.opacity(0.10),
        k.pos(c.tx * TILE + 4, c.ty * TILE + 4), k.anchor('topleft'), k.z(1)]);
      pathCells.push(r);
    }
  }

  // タイル種別に応じてテクスチャ/色を貼り直す
  function refreshTiles() {
    for (let ty = 0; ty < GRID_H; ty++) {
      for (let tx = 0; tx < GRID_W; tx++) {
        const s = tilePool[idx(tx, ty)];
        const wall = (map[idx(tx, ty)] === T_WALL);
        if (loaded.tile_path && loaded.tile_wall) {
          s.use(k.sprite(wall ? 'tile_wall' : 'tile_path'));
          s.width = TILE; s.height = TILE;
        } else if (loaded.tile_path || loaded.tile_wall) {
          // 片方だけ画像があるケースは色で塗り分け (簡略)
          s.use(k.sprite(loaded.tile_wall ? 'tile_wall' : 'tile_path'));
          s.width = TILE; s.height = TILE;
          s.opacity = wall ? 1 : 0.6;
        } else {
          s.color = wall ? k.rgb(107, 114, 128) : k.rgb(42, 47, 58);
        }
      }
    }
  }

  // ---- プールからの取得ヘルパ ----
  function getCreepSprite() {
    let s = creepPool.pop();
    if (!s) {
      if (loaded.creep) { s = k.add([k.sprite('creep'), k.anchor('center'), k.z(20)]); s.width = 24; s.height = 24; }
      else s = k.add([k.circle(CREEP_R), k.color(226, 64, 46), k.outline(2, k.rgb(138, 24, 16)), k.anchor('center'), k.z(20)]);
    }
    s.hidden = false; s.opacity = 1;
    return s;
  }
  function getProjSprite() {
    let s = projPool.pop();
    if (!s) {
      if (loaded.projectile) { s = k.add([k.sprite('projectile'), k.anchor('center'), k.z(30)]); s.width = 12; s.height = 12; }
      else s = k.add([k.circle(PROJ_R), k.color(242, 211, 60), k.anchor('center'), k.z(30)]);
    }
    s.hidden = false;
    return s;
  }
  function getSparkSprite() {
    let s = sparkPool.pop();
    if (!s) {
      if (loaded.hit_spark) { s = k.add([k.sprite('hit_spark'), k.anchor('center'), k.z(40)]); s.width = 16; s.height = 16; }
      else s = k.add([k.circle(7), k.color(255, 255, 255), k.anchor('center'), k.z(40)]);
    }
    s.hidden = false; s.opacity = 1; s.scale = k.vec2(1);
    return s;
  }

  function computePath() {
    return aStar(map, START_TX, START_TY, GOAL_TX, GOAL_TY, towerBlocked);
  }

  // ---- creep を現在地のセルから再経路付け (再計算カウンタ +1) ----
  function repathCreep(c) {
    const ctx = clamp(Math.floor(c.x / TILE), 0, GRID_W - 1);
    const cty = clamp(Math.floor(c.y / TILE), 0, GRID_H - 1);
    const p = aStar(map, ctx, cty, GOAL_TX, GOAL_TY, towerBlocked);
    pathRecalcs++;
    if (p && p.length > 0) {
      c.path = p;
      c.wp = p.length > 1 ? 1 : 0;
    }
  }

  function spawnCreep() {
    if (!currentPath || currentPath.length === 0) return;
    const s = getCreepSprite();
    creeps.push({
      x: cellCenterX(START_TX), y: cellCenterY(START_TY),
      hp: CREEP_HP, maxHp: CREEP_HP,
      path: currentPath, wp: currentPath.length > 1 ? 1 : 0,
      sprite: s,
    });
  }

  function killCreep(i, byTower) {
    const c = creeps[i];
    c.sprite.hidden = true;
    creepPool.push(c.sprite);
    creeps[i] = creeps[creeps.length - 1];
    creeps.pop();
    if (byTower) { gold += GOLD_KILL; score += SCORE_KILL; spawnSpark(c.x, c.y); }
  }

  function spawnSpark(x, y) {
    const s = getSparkSprite();
    s.pos = k.vec2(x, y);
    sparks.push({ x, y, life: 0.3, max: 0.3, sprite: s });
  }

  // ---- タワー設置 (左クリック) ----
  function placeTower(tx, ty) {
    if (gameOver) return false;
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
    if (map[idx(tx, ty)] === T_WALL) return false;
    if (towerBlocked.has(idx(tx, ty))) return false;
    if ((tx === START_TX && ty === START_TY) || (tx === GOAL_TX && ty === GOAL_TY)) return false;
    if (gold < TOWER_COST) return false;

    // 仮設置して経路が残るか検証 (塞ぐ配置は拒否)
    towerBlocked.add(idx(tx, ty));
    const newPath = computePath();
    if (!newPath) { towerBlocked.delete(idx(tx, ty)); return false; }

    gold -= TOWER_COST;
    let s;
    if (loaded.tower) { s = k.add([k.sprite('tower'), k.pos(tx * TILE, ty * TILE), k.anchor('topleft'), k.z(10)]); s.width = TILE; s.height = TILE; }
    else s = k.add([k.rect(TILE - 8, TILE - 8, { radius: 4 }), k.color(63, 127, 216), k.outline(2, k.rgb(28, 78, 156)),
      k.pos(tx * TILE + 4, ty * TILE + 4), k.anchor('topleft'), k.z(10)]);
    towers.push({ tx, ty, cd: 0 });
    towerSprites.push({ tx, ty, sprite: s });

    // 経路更新 + 全 creep 再経路付け
    currentPath = newPath;
    pathRecalcs++;
    redrawPath();
    for (const c of creeps) repathCreep(c);
    return true;
  }

  // ---- タワー撤去 (右クリック) ----
  function removeTower(tx, ty) {
    const i = towers.findIndex((t) => t.tx === tx && t.ty === ty);
    if (i < 0) return false;
    towers.splice(i, 1);
    const si = towerSprites.findIndex((t) => t.tx === tx && t.ty === ty);
    if (si >= 0) { k.destroy(towerSprites[si].sprite); towerSprites.splice(si, 1); }
    towerBlocked.delete(idx(tx, ty));
    currentPath = computePath();
    pathRecalcs++;
    redrawPath();
    for (const c of creeps) repathCreep(c);
    return true;
  }

  // =====================================================================
  // 初期化 / リスタート
  // =====================================================================
  function reset() {
    if (creeps) for (const c of creeps) { c.sprite.hidden = true; creepPool.push(c.sprite); }
    if (projectiles) for (const p of projectiles) { p.sprite.hidden = true; projPool.push(p.sprite); }
    if (sparks) for (const sp of sparks) { sp.sprite.hidden = true; sparkPool.push(sp.sprite); }
    for (const t of towerSprites) k.destroy(t.sprite);
    towerSprites.length = 0;

    map = generateMap();
    refreshTiles();

    towers = [];
    towerBlocked = new Set();
    creeps = [];
    projectiles = [];
    sparks = [];
    pathRecalcs = 0;
    gold = GOLD_INIT;
    lives = LIVES_INIT;
    score = 0;
    enemyCap = CAP_INIT;
    spawnTimer = 0;
    gameOver = false;
    demoIdx = 0; demoTimer = 0;   // デモAIの自動配置進捗もリセット

    currentPath = computePath();
    pathRecalcs++; // 初回計算もカウント
    redrawPath();
  }
  reset();

  // =====================================================================
  // 入力 (マウス左右クリック / +/- / R)
  // =====================================================================
  // 右クリックメニュー抑止
  k.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function mouseTile() {
    const m = k.mousePos();   // KAPLAY 内座標 (CSS スケールは内部で吸収)
    return { tx: Math.floor(m.x / TILE), ty: Math.floor(m.y / TILE) };
  }
  k.onMousePress('left', () => { if (!started) return; const { tx, ty } = mouseTile(); placeTower(tx, ty); });
  k.onMousePress('right', () => { if (!started) return; const { tx, ty } = mouseTile(); removeTower(tx, ty); });

  k.onKeyPress(['=', 'kpadd'], () => { enemyCap = clamp(enemyCap + CAP_STEP, CAP_MIN, CAP_MAX); });
  k.onKeyPress(['minus', 'kpsubtract'], () => { enemyCap = clamp(enemyCap - CAP_STEP, CAP_MIN, CAP_MAX); });
  k.onKeyPress('r', () => reset());
  k.onKeyPress('enter', () => { if (!started) startGame(); });

  // =====================================================================
  // HUD + メインループ (dt() デルタタイム駆動)
  // =====================================================================
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;

  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05); // スパイク抑制
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
    if (gameOver && !started) reset();
    // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
    if (!started) demoTick(dt);

    if (!gameOver) {
      // 1) スポーン (0.5s ごと / 生存数が上限未満のときのみ供給)
      spawnTimer += dt;
      while (spawnTimer >= SPAWN_INTERVAL) {
        spawnTimer -= SPAWN_INTERVAL;
        if (creeps.length < enemyCap) spawnCreep();
      }

      // 2) creep 経路追従 (ウェイポイントへ線形移動)
      for (let i = creeps.length - 1; i >= 0; i--) {
        const c = creeps[i];
        let remain = CREEP_SPEED * dt;
        while (remain > 0 && c.wp < c.path.length) {
          const wpx = cellCenterX(c.path[c.wp].tx);
          const wpy = cellCenterY(c.path[c.wp].ty);
          const dx = wpx - c.x, dy = wpy - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= remain) { c.x = wpx; c.y = wpy; remain -= dist; c.wp++; }
          else { c.x += (dx / dist) * remain; c.y += (dy / dist) * remain; remain = 0; }
        }
        if (c.wp >= c.path.length) {
          lives -= 1;
          killCreep(i, false);
          if (lives <= 0) { lives = 0; gameOver = true; }
        }
      }

      // 3) タワー射撃 (射程内の最進行度敵を狙う)
      for (const t of towers) {
        t.cd -= dt;
        if (t.cd > 0) continue;
        const tcx = cellCenterX(t.tx), tcy = cellCenterY(t.ty);
        let best = null, bestProgress = -1;
        for (const c of creeps) {
          const dx = c.x - tcx, dy = c.y - tcy;
          if (dx * dx + dy * dy > TOWER_RANGE * TOWER_RANGE) continue;
          if (c.wp > bestProgress) { bestProgress = c.wp; best = c; }
        }
        if (best) {
          const dx = best.x - tcx, dy = best.y - tcy;
          const d = Math.hypot(dx, dy) || 1;
          const s = getProjSprite();
          s.pos = k.vec2(tcx, tcy);
          projectiles.push({ x: tcx, y: tcy, vx: (dx / d) * PROJ_SPEED, vy: (dy / d) * PROJ_SPEED, sprite: s });
          t.cd = TOWER_FIRE_CD;
        }
      }

      // 4) 弾の直進 + 当たり判定 (距離 < 敵半径 + 弾半径)
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.x += p.vx * dt; p.y += p.vy * dt;
        let hit = false;
        if (p.x < -20 || p.x > VIEW_W + 20 || p.y < -20 || p.y > GRID_H * TILE + 20) {
          hit = true;
        } else {
          for (let j = 0; j < creeps.length; j++) {
            const c = creeps[j];
            const dx = c.x - p.x, dy = c.y - p.y, rr = CREEP_R + PROJ_R;
            if (dx * dx + dy * dy <= rr * rr) {
              c.hp -= PROJ_DMG; hit = true;
              if (c.hp <= 0) killCreep(j, true);
              break;
            }
          }
        }
        if (hit) {
          p.sprite.hidden = true;
          projPool.push(p.sprite);
          projectiles[i] = projectiles[projectiles.length - 1];
          projectiles.pop();
        }
      }
    } // !gameOver

    // 5) スプライト位置反映
    for (const c of creeps) c.sprite.pos = k.vec2(c.x, c.y);
    for (const p of projectiles) p.sprite.pos = k.vec2(p.x, p.y);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.opacity = clamp(t, 0, 1);
      sp.sprite.scale = k.vec2(1 + (1 - t) * 0.8);
      if (sp.life <= 0) {
        sp.sprite.hidden = true;
        sparkPool.push(sp.sprite);
        sparks[i] = sparks[sparks.length - 1];
        sparks.pop();
      }
    }

    // 6) HUD (約120msごと更新)
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const pathLen = currentPath ? currentPath.length : 0;
      hudEl.textContent =
        `FPS          : ${fpsAvg.toFixed(1)}\n` +
        `Enemies      : ${creeps.length} / ${enemyCap}   (+/- で増減, 上限 ${CAP_MAX})\n` +
        `Towers       : ${towers.length}   Projectiles : ${projectiles.length}\n` +
        `Path recalcs : ${pathRecalcs}   Path len : ${pathLen}\n` +
        `Gold : ${gold}   Lives : ${lives}   Score : ${score}` +
        (gameOver && started ? `\n--- GAME OVER ---  R で再開` : ``);
    }

    // タイトル点滅 (約0.45秒周期)
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  console.log('[KAPLAY] theme6 tower-defense started.');
}
