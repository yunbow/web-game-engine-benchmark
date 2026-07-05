/* ============================================================================
 * テーマ3 トップダウンRPG探索 (マップ歩行) - KAPLAY 実装
 * 共通仕様 SPEC.md / 正準実装 PixiJS に厳密準拠。性能比較用。
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリ。以下はライブラリ機構を使う:
 *   - ゲームループ (onUpdate / dt())
 *   - 入力 (isKeyDown / onKeyPress)
 *   - スプライト/図形描画。座標系は Y 下向き・原点左上 = 画面座標と一致。
 * ただし「広大マップ(100x100)を可視範囲だけ描く」ためカメラは使わず、自前で
 * camX/camY を計算し world オフセットを引いた位置にスプライトを再配置する
 * (PixiJS 正準実装と同じスプライトプール再利用カリング)。
 * ========================================================================== */

// ---- 定数 (SPEC / PixiJS と同一値) -----------------------------------------
const TILE = 32;
const MAP_W = 100;
const MAP_H = 100;
const VIEW_W = 960;
const VIEW_H = 540;
const SPEED = 160;          // px/s
const DASH_MULT = 2;
const INIT_ENTITIES = 60;   // NPC+敵スライム 初期合計
const SLIME_SPEED = 50;     // px/s
const KNOCKBACK = 90;       // ノックバック量(px)

// タイル種別: 0=草, 1=道, 2=水, 3=壁, 4=木
const T_GRASS = 0, T_PATH = 1, T_WATER = 2, T_WALL = 3, T_TREE = 4;
const BLOCKED = new Set([T_WATER, T_WALL, T_TREE]);

// フォールバック色 (SPEC: 草=緑, 道=茶, 水=青, 壁=灰, 自機=白, NPC=黄, slime=緑丸)
const COLORS = {
  grass: [74, 124, 58], path: [155, 107, 58], water: [47, 111, 176],
  wall: [107, 107, 107], tree: [47, 93, 42], treeTrunk: [90, 58, 26],
  player: [255, 255, 255], npc: [242, 211, 60], slime: [111, 208, 111],
};

const ASSET_DEFS = {
  tile_grass:  '../assets/tile_grass.png',
  tile_path:   '../assets/tile_path.png',
  tile_water:  '../assets/tile_water.png',
  tile_wall:   '../assets/tile_wall.png',
  tree:        '../assets/tree.png',
  player:      '../assets/player.png',
  player_walk: '../assets/player_walk.png',
  npc:         '../assets/npc.png',
  npc_walk:    '../assets/npc_walk.png',
  enemy_slime: '../assets/enemy_slime.png',
  enemy_slime_walk: '../assets/enemy_slime_walk.png',
};

// ---- 決定的擬似乱数 (mulberry32) — PixiJS と同一 ---------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- マップ決定的生成 (固定シード) — PixiJS と同一手順 ---------------------
function generateMap() {
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

// 矩形(px)が衝突タイルに重なるか
function rectBlocked(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE);
  const y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE);
  const y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (BLOCKED.has(tileAt(map, tx, ty))) return true;
    }
  }
  return false;
}

const clampv = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: [16, 20, 24],
  crisp: true,
  global: false,            // 名前空間 k.* を明示利用 (グローバル汚染を避ける)
});

// === アセット読み込み (失敗してもフォールバックで起動) ======================
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      if (key.endsWith('_walk')) await k.loadSprite(key, url, { sliceX: 4, sliceY: 4 });
      else await k.loadSprite(key, url);
      loaded[key] = true;
    }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

function start() {
  const map = generateMap();

  // ---- スプライト or 図形フォールバックのヘルパ ----
  // タイル(32x32) / 木(32x48) は再利用プールへ。可視範囲ぶんだけ確保する。
  function makeTileSprite() {
    if (loaded.tile_grass) {
      const s = k.add([k.sprite('tile_grass'), k.pos(0, 0), k.anchor('topleft'), { _tile: true }]);
      s.width = TILE; s.height = TILE; s.hidden = true;
      return s;
    }
    const s = k.add([k.rect(TILE, TILE), k.pos(0, 0), k.color(...COLORS.grass), k.anchor('topleft'), { _tile: true }]);
    s.hidden = true; return s;
  }
  function makeTreeSprite() {
    if (loaded.tree) {
      const s = k.add([k.sprite('tree'), k.pos(0, 0), k.anchor('topleft'), k.z(0), { _tree: true }]);
      s.width = 32; s.height = 48; s.hidden = true;
      return s;
    }
    // フォールバック: 円(葉) + 幹。anchor topleft の枠内 (32x48) に描く。
    const s = k.add([k.pos(0, 0), k.z(0), k.anchor('topleft'), { _tree: true }]);
    s.hidden = true;
    s.onDraw(() => {
      k.drawRect({ pos: k.vec2(13, 32), width: 6, height: 16, color: k.rgb(...COLORS.treeTrunk) });
      k.drawCircle({ pos: k.vec2(16, 18), radius: 15, color: k.rgb(...COLORS.tree) });
    });
    return s;
  }

  const tileTexByType = {
    [T_GRASS]: 'tile_grass', [T_PATH]: 'tile_path', [T_WATER]: 'tile_water',
    [T_WALL]: 'tile_wall', [T_TREE]: 'tile_grass', // 木の地面は草
  };
  const fbColorByType = {
    [T_GRASS]: COLORS.grass, [T_PATH]: COLORS.path, [T_WATER]: COLORS.water,
    [T_WALL]: COLORS.wall, [T_TREE]: COLORS.grass,
  };

  // 可視範囲タイル数 (PixiJS と同じ +2 マージン)
  const colsVis = Math.ceil(VIEW_W / TILE) + 2;
  const rowsVis = Math.ceil(VIEW_H / TILE) + 2;
  const POOL = colsVis * rowsVis;

  const tilePool = [];
  for (let i = 0; i < POOL; i++) tilePool.push(makeTileSprite());
  const treePool = [];
  for (let i = 0; i < POOL; i++) treePool.push(makeTreeSprite());

  // ---- エンティティ図形ヘルパ (NPC / slime / player) ----
  function makeActorSprite(kind) {
    const walkKey = kind === 'slime' ? 'enemy_slime_walk' : `${kind}_walk`;
    if (loaded[walkKey]) {
      const s = k.add([k.sprite(walkKey, { frame: 0 }), k.pos(0, 0), k.anchor('topleft'), k.z(0), {
        walkKey,
        animT: 0,
        faceDir: 'down',
      }]);
      s.width = TILE; s.height = TILE;
      return s;
    }
    if (kind === 'player' && loaded.player) {
      const s = k.add([k.sprite('player'), k.pos(0, 0), k.anchor('topleft'), k.z(0)]); s.width = TILE; s.height = TILE; return s;
    }
    if (kind === 'npc' && loaded.npc) {
      const s = k.add([k.sprite('npc'), k.pos(0, 0), k.anchor('topleft'), k.z(0)]); s.width = TILE; s.height = TILE; return s;
    }
    if (kind === 'slime' && loaded.enemy_slime) {
      const s = k.add([k.sprite('enemy_slime'), k.pos(0, 0), k.anchor('topleft'), k.z(0)]); s.width = TILE; s.height = TILE; return s;
    }
    // 図形フォールバック (anchor topleft の 32x32 枠に描画)
    const s = k.add([k.pos(0, 0), k.anchor('topleft'), k.z(0)]);
    if (kind === 'player') {
      s.onDraw(() => k.drawRect({ pos: k.vec2(2, 2), width: TILE - 4, height: TILE - 4, radius: 5, color: k.rgb(...COLORS.player) }));
    } else if (kind === 'npc') {
      s.onDraw(() => k.drawRect({ pos: k.vec2(3, 3), width: TILE - 6, height: TILE - 6, radius: 5, color: k.rgb(...COLORS.npc) }));
    } else {
      s.onDraw(() => k.drawCircle({ pos: k.vec2(16, 18), radius: 12, color: k.rgb(...COLORS.slime) }));
    }
    return s;
  }

  // ---- プレイヤー (非ブロックタイルにスポーン) ----
  function walkRow(sprite, dx, dy) {
    if (dx !== 0 || dy !== 0) sprite.faceDir = Math.abs(dx) > Math.abs(dy)
      ? (dx < 0 ? 'left' : 'right')
      : (dy < 0 ? 'up' : 'down');
    return { down: 0, up: 1, left: 2, right: 3 }[sprite.faceDir || 'down'];
  }
  function updateActorFrame(sprite, dx, dy, moving, dt) {
    if (!sprite.walkKey) return;
    sprite.animT = moving ? sprite.animT + dt : 0;
    const row = walkRow(sprite, dx, dy);
    const col = moving ? Math.floor(sprite.animT * 8) % 4 : 0;
    sprite.frame = row * 4 + col;
  }
  function findOpenTile() {
    const rnd = mulberry32(99);
    for (let tries = 0; tries < 5000; tries++) {
      const tx = 1 + Math.floor(rnd() * (MAP_W - 2));
      const ty = 1 + Math.floor(rnd() * (MAP_H - 2));
      if (!BLOCKED.has(tileAt(map, tx, ty))) return { tx, ty };
    }
    return { tx: 1, ty: 1 };
  }
  const spawn = findOpenTile();
  const player = {
    x: spawn.tx * TILE, y: spawn.ty * TILE,
    w: 28, h: 28, kx: 0, ky: 0, // ノックバック速度
    sprite: makeActorSprite('player'),
  };

  // ---- タイトル/アトラクト状態 ----
  let started = false, blinkT = 0, demoStuckT = 0;
  const titleEl = document.getElementById('title');
  const demoRnd = mulberry32(20240619); // デモAI(決定的)
  let demoTarget = null;
  function pickDemoTarget() {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(demoRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(demoRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(map, tx, ty)) && guard < 100);
    demoTarget = { x: tx * TILE, y: ty * TILE };
  }
  pickDemoTarget();
  function demoInput() {
    if (!demoTarget) pickDemoTarget();
    const dx = (demoTarget.x + player.w / 2) - (player.x + player.w / 2);
    const dy = (demoTarget.y + player.h / 2) - (player.y + player.h / 2);
    if (Math.hypot(dx, dy) < TILE * 0.6) { pickDemoTarget(); demoStuckT = 0; return { mx: 0, my: 0 }; }
    // 距離の大きい軸を選んで進む（上下左右の4方向）
    return Math.abs(dx) > Math.abs(dy)
      ? { mx: dx > 0 ? 1 : -1, my: 0 }
      : { mx: 0, my: dy > 0 ? 1 : -1 };
  }

  // ---- エンティティ(NPC / スライム) ----
  const entRnd = mulberry32(424242);
  const entities = []; // {type, x,y, w,h, vx,vy, t, sprite}

  function spawnEntity(type) {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(entRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(entRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(map, tx, ty)) && guard < 50);
    entities.push({
      type, x: tx * TILE + 2, y: ty * TILE + 2, w: 28, h: 28,
      vx: 0, vy: 0, t: entRnd() * 3,
      sprite: makeActorSprite(type),
    });
  }
  function removeEntity() {
    const e = entities.pop();
    if (e) k.destroy(e.sprite);
  }
  function setEntityCount(n) {
    n = Math.max(0, n);
    while (entities.length < n) spawnEntity(entities.length % 2 === 0 ? 'slime' : 'npc');
    while (entities.length > n) removeEntity();
  }
  setEntityCount(INIT_ENTITIES);

  // 木総数(マップ全体・固定)を一度だけ数える
  let _treeCount = -1;
  function countTrees() {
    if (_treeCount >= 0) return _treeCount;
    let c = 0;
    for (let i = 0; i < map.length; i++) if (map[i] === T_TREE) c++;
    _treeCount = c; return c;
  }

  // ---- 入力: 負荷調整 (+/-) ----
  k.onKeyPress(['=', 'kpadd'], () => setEntityCount(entities.length + 10));
  k.onKeyPress(['minus', 'kpsubtract'], () => setEntityCount(entities.length - 10));

  // ---- Enter でデモ→プレイ開始 (新規リセット) ----
  function startGame() {
    started = true;
    player.x = spawn.tx * TILE; player.y = spawn.ty * TILE;
    player.kx = 0; player.ky = 0;
    setEntityCount(INIT_ENTITIES);
    if (titleEl) titleEl.style.display = 'none';
  }
  k.onKeyPress('enter', () => { if (!started) startGame(); });

  // ---- 移動・衝突 (軸分離) ----
  function moveActor(actor, dx, dy) {
    if (dx !== 0) {
      const nx = actor.x + dx;
      if (!rectBlocked(map, nx, actor.y, actor.w, actor.h)) actor.x = nx;
    }
    if (dy !== 0) {
      const ny = actor.y + dy;
      if (!rectBlocked(map, actor.x, ny, actor.w, actor.h)) actor.y = ny;
    }
  }
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;
  let tilesDrawn = 0, treesDrawn = 0;

  // ---- メインループ ----
  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // --- プレイヤー入力 (アトラクト中はデモAI) ---
    let mx = 0, my = 0;
    if (!started) {
      const d = demoInput();
      mx = d.mx; my = d.my;
    } else {
      if (k.isKeyDown('left') || k.isKeyDown('a')) mx -= 1;
      if (k.isKeyDown('right') || k.isKeyDown('d')) mx += 1;
      if (k.isKeyDown('up') || k.isKeyDown('w')) my -= 1;
      if (k.isKeyDown('down') || k.isKeyDown('s')) my += 1;
    }
    const dash = (started && k.isKeyDown('shift')) ? DASH_MULT : 1;
    const sp = SPEED * dash * dt;
    const _bx = player.x, _by = player.y;
    moveActor(player, mx * sp, my * sp);
    updateActorFrame(player.sprite, player.x - _bx, player.y - _by, player.x !== _bx || player.y !== _by, dt);
    if (!started) {
      if ((mx !== 0 || my !== 0) && player.x === _bx && player.y === _by) {
        demoStuckT += dt;
        if (demoStuckT > 0.4) { pickDemoTarget(); demoStuckT = 0; }
      } else demoStuckT = 0;
    }

    // ノックバック適用(減衰)
    if (player.kx !== 0 || player.ky !== 0) {
      moveActor(player, player.kx * dt, player.ky * dt);
      player.kx = 0; player.ky *= 0.85;
      if (Math.abs(player.kx) < 1) player.kx = 0;
      if (Math.abs(player.ky) < 1) player.ky = 0;
    }

    // --- エンティティ更新(簡易徘徊) ---
    for (const e of entities) {
      e.t -= dt;
      if (e.t <= 0) {
        e.t = 0.6 + entRnd() * 2.0;
        const dir = Math.floor(entRnd() * 5);
        const s = (e.type === 'slime' ? SLIME_SPEED : SLIME_SPEED * 0.7);
        e.vx = 0; e.vy = 0;
        if (dir === 0) e.vy = -s;
        else if (dir === 1) e.vy = s;
        else if (dir === 2) e.vx = -s;
        else if (dir === 3) e.vx = s;
      }
      if (e.vx !== 0 || e.vy !== 0) {
        const bx = e.x, by = e.y;
        moveActor(e, e.vx * dt, e.vy * dt);
        if (e.x === bx && e.y === by) e.t = 0;
        updateActorFrame(e.sprite, e.x - bx, e.y - by, e.x !== bx || e.y !== by, dt);
      } else {
        updateActorFrame(e.sprite, 0, 0, false, dt);
      }
      if (e.type === 'slime' && aabb(player, e)) {
        const cx = (player.x + player.w / 2) - (e.x + e.w / 2);
        const cy = (player.y + player.h / 2) - (e.y + e.h / 2);
        const len = Math.hypot(cx, cy) || 1;
        player.kx = 0;
        player.ky = (cy / len) * KNOCKBACK;
      }
    }

    // --- カメラ追従 (world オフセット計算) ---
    const camX = Math.round(player.x + player.w / 2 - VIEW_W / 2);
    const camY = Math.round(player.y + player.h / 2 - VIEW_H / 2);
    const maxCamX = MAP_W * TILE - VIEW_W;
    const maxCamY = MAP_H * TILE - VIEW_H;
    const clX = clampv(camX, 0, maxCamX);
    const clY = clampv(camY, 0, maxCamY);

    // --- タイルカリング描画 (可視範囲のみ / スプライトプール再利用) ---
    const startTx = Math.floor(clX / TILE);
    const startTy = Math.floor(clY / TILE);
    tilesDrawn = 0;
    let pi = 0, ti = 0;
    for (let row = 0; row < rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        const s = tilePool[pi++];
        if (!s) break;
        if (loaded.tile_grass) s.use(k.sprite(tileTexByType[type]));
        else s.color = k.rgb(...fbColorByType[type]);
        s.width = TILE; s.height = TILE;
        s.pos.x = tx * TILE - clX; s.pos.y = ty * TILE - clY;
        s.hidden = false;
        tilesDrawn++;
        // 木は地面(草)の上に重ねる
        if (type === T_TREE) {
          const tr = treePool[ti++];
          if (tr) {
            tr.pos.x = tx * TILE - clX;
            tr.pos.y = ty * TILE - 16 - clY; // 32x48 を足元合わせ
            tr.z = ty * TILE + 48;
            tr.hidden = false;
          }
        }
      }
    }
    for (; pi < tilePool.length; pi++) tilePool[pi].hidden = true;
    treesDrawn = ti;
    for (; ti < treePool.length; ti++) treePool[ti].hidden = true;

    // --- エンティティ描画 + 深度ソート(y順 = z) ---
    for (const e of entities) {
      e.sprite.pos.x = e.x - 2 - clX;
      e.sprite.pos.y = e.y - 2 - clY;
      e.sprite.z = e.y + e.h;
    }
    player.sprite.pos.x = player.x - 2 - clX;
    player.sprite.pos.y = player.y - 2 - clY;
    player.sprite.z = player.y + player.h;

    // --- HUD ---
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const ptx = Math.floor((player.x + player.w / 2) / TILE);
      const pty = Math.floor((player.y + player.h / 2) / TILE);
      const treeCount = countTrees();
      hudEl.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${tilesDrawn}  (trees: ${treesDrawn})\n` +
        `Entities    : ${entities.length + treeCount}  (NPC+敵:${entities.length} / 木:${treeCount})\n` +
        `Player tile : (${ptx}, ${pty})  ${dash > 1 ? '[DASH]' : ''}`;
    }

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!started) {
      blinkT += dt;
      if (titleEl) titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  console.log('KAPLAY トップダウンRPG探索 started.');
}
