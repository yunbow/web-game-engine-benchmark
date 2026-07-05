/* =========================================================================
 * テーマ3 トップダウンRPG探索 ― PixiJS v8 実装
 * 仕様: SPEC.md (タイル32x32, マップ100x100, 可視カリング, カメラ追従)
 * =========================================================================*/

// ---- 定数 -----------------------------------------------------------------
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

// フォールバック色
const COLORS = {
  grass: 0x4a7c3a, path: 0x9b6b3a, water: 0x2f6fb0,
  wall: 0x6b6b6b, tree: 0x2f5d2a, treeTrunk: 0x5a3a1a,
  player: 0xffffff, npc: 0xf2d33c, slime: 0x6fd06f,
};

// ---- 決定的擬似乱数 (mulberry32) -----------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- マップ決定的生成 ------------------------------------------------------
// 全エンジン共通の見た目を狙い、固定シードで生成する。
function generateMap() {
  const rnd = mulberry32(1337);
  const map = new Uint8Array(MAP_W * MAP_H);

  // ベースは草
  for (let i = 0; i < map.length; i++) map[i] = T_GRASS;

  const idx = (x, y) => y * MAP_W + x;

  // 散布: 水の池、木の林
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const r = rnd();
      if (r < 0.06) map[idx(x, y)] = T_WATER;
      else if (r < 0.14) map[idx(x, y)] = T_TREE;
      else if (r < 0.17) map[idx(x, y)] = T_WALL;
    }
  }

  // 道: 水平/垂直の幹線を数本引く(草/木の上書き、水は橋として道に)
  const lanes = 6;
  for (let i = 0; i < lanes; i++) {
    const ry = 6 + Math.floor(rnd() * (MAP_H - 12));
    for (let x = 1; x < MAP_W - 1; x++) map[idx(x, ry)] = T_PATH;
    const rx = 6 + Math.floor(rnd() * (MAP_W - 12));
    for (let y = 1; y < MAP_H - 1; y++) map[idx(rx, y)] = T_PATH;
  }

  // 外周は壁
  for (let x = 0; x < MAP_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, MAP_H - 1)] = T_WALL; }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_WALL; map[idx(MAP_W - 1, y)] = T_WALL; }

  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return map[ty * MAP_W + tx];
}

// 矩形(px)が衝突タイルに重なるか判定
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

// ---- フォールバックテクスチャ生成 (Graphics→Texture) ----------------------
function makeFallbackTextures(app) {
  const tex = {};
  const g = (draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, resolution: 1 });
    gr.destroy();
    return t;
  };

  tex.tile_grass = g((gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.grass);
    gr.rect(0, 0, TILE, TILE).stroke({ width: 1, color: 0x3c6630, alpha: 0.5 });
  });
  tex.tile_path = g((gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.path);
    gr.rect(0, 0, TILE, TILE).stroke({ width: 1, color: 0x7d5530, alpha: 0.5 });
  });
  tex.tile_water = g((gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.water);
    gr.rect(4, 8, 10, 3).fill({ color: 0x6fa8e0, alpha: 0.6 });
    gr.rect(16, 20, 10, 3).fill({ color: 0x6fa8e0, alpha: 0.6 });
  });
  tex.tile_wall = g((gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.wall);
    gr.rect(0, 0, TILE, TILE).stroke({ width: 2, color: 0x444444 });
    gr.moveTo(0, 16).lineTo(TILE, 16).stroke({ width: 1, color: 0x4f4f4f });
  });
  // 木: 32x48 (幹+葉)。タイル下端に足を合わせて配置する。
  tex.tree = g((gr) => {
    gr.rect(13, 32, 6, 16).fill(COLORS.treeTrunk);
    gr.circle(16, 18, 15).fill(COLORS.tree);
    gr.circle(16, 18, 15).stroke({ width: 1, color: 0x214219 });
  });
  tex.player = g((gr) => {
    gr.roundRect(2, 2, TILE - 4, TILE - 4, 5).fill(COLORS.player);
    gr.roundRect(2, 2, TILE - 4, TILE - 4, 5).stroke({ width: 2, color: 0x2244aa });
    gr.circle(11, 13, 2.5).fill(0x222222);
    gr.circle(21, 13, 2.5).fill(0x222222);
  });
  tex.npc = g((gr) => {
    gr.roundRect(3, 3, TILE - 6, TILE - 6, 5).fill(COLORS.npc);
    gr.roundRect(3, 3, TILE - 6, TILE - 6, 5).stroke({ width: 2, color: 0xa8901a });
  });
  tex.enemy_slime = g((gr) => {
    gr.circle(16, 18, 12).fill(COLORS.slime);
    gr.circle(16, 18, 12).stroke({ width: 2, color: 0x3e9e3e });
    gr.circle(11, 15, 2).fill(0x143a14);
    gr.circle(21, 15, 2).fill(0x143a14);
  });
  return tex;
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
    tile_grass: '../assets/tile_grass.png',
    tile_path: '../assets/tile_path.png',
    tile_water: '../assets/tile_water.png',
    tile_wall: '../assets/tile_wall.png',
    tree: '../assets/tree.png',
    player: '../assets/player.png',
    player_walk: '../assets/player_walk.png',
    npc: '../assets/npc.png',
    npc_walk: '../assets/npc_walk.png',
    enemy_slime: '../assets/enemy_slime.png',
    enemy_slime_walk: '../assets/enemy_slime_walk.png',
  };
  const tex = {};
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key];
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形フォールバック
    }
  }
  return tex;
}

function makeWalkFrames(texture) {
  if (!texture || !texture.source) return null;
  const frames = [];
  const rows = Math.max(1, Math.floor(texture.source.height / TILE));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < 4; col++) {
      frames.push(new PIXI.Texture({
        source: texture.source,
        frame: new PIXI.Rectangle(col * TILE, row * TILE, TILE, TILE),
      }));
    }
  }
  return frames;
}

function walkRow(sprite, dx, dy) {
  if (dx !== 0 || dy !== 0) sprite._faceDir = Math.abs(dx) > Math.abs(dy)
    ? (dx < 0 ? 'left' : 'right')
    : (dy < 0 ? 'up' : 'down');
  if (!sprite._faceDir) sprite._faceDir = 'down';
  return { down: 0, up: 1, left: 2, right: 3 }[sprite._faceDir];
}

function updateWalkSprite(sprite, frames, dx, dy, moving, dt, fallback) {
  if (!frames) {
    sprite.texture = fallback;
    return;
  }
  sprite._animT = moving ? (sprite._animT || 0) + dt : 0;
  const rows = frames.length / 4;
  const row = Math.min(walkRow(sprite, dx, dy), rows - 1);
  const col = moving ? Math.floor(sprite._animT * 8) % 4 : 0;
  sprite.texture = frames[row * 4 + col];
}

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: 0x101418,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  // v8: app.view → app.canvas
  document.getElementById('game-container').appendChild(app.canvas);

  const map = generateMap();
  const tex = await loadTextures(app);
  const walkFrames = {
    player: makeWalkFrames(tex.player_walk),
    npc: makeWalkFrames(tex.npc_walk),
    slime: makeWalkFrames(tex.enemy_slime_walk),
  };

  // ---- シーングラフ ----
  // world: カメラに合わせて移動するコンテナ。tileLayer + entityLayer を内包。
  const world = new PIXI.Container();
  app.stage.addChild(world);

  const tileLayer = new PIXI.Container();
  const entityLayer = new PIXI.Container();
  world.addChild(tileLayer);
  world.addChild(entityLayer);

  // ---- タイル描画プール (可視範囲のみ描画 / スプライト再利用カリング) ----
  // 画面に収まる最大タイル数ぶんのスプライトを確保し、毎フレーム可視タイルへ
  // テクスチャ・座標を割り当てて再利用する。木は別レイヤーで深度ソートのため
  // タイルプールには含めず、可視範囲内の木スプライトも再利用する。
  const colsVis = Math.ceil(VIEW_W / TILE) + 2;
  const rowsVis = Math.ceil(VIEW_H / TILE) + 2;
  const tilePool = [];
  for (let i = 0; i < colsVis * rowsVis; i++) {
    const s = new PIXI.Sprite(tex.tile_grass);
    s.visible = false;
    tilePool.push(s);
    tileLayer.addChild(s);
  }

  const tileTexByType = {
    [T_GRASS]: tex.tile_grass,
    [T_PATH]: tex.tile_path,
    [T_WATER]: tex.tile_water,
    [T_WALL]: tex.tile_wall,
    // 木の地面は草を敷く
    [T_TREE]: tex.tile_grass,
  };

  // 木スプライトプール(可視範囲ぶん)。entityLayer 内で深度ソート対象。
  const treePool = [];
  for (let i = 0; i < colsVis * rowsVis; i++) {
    const s = new PIXI.Sprite(tex.tree);
    s.visible = false;
    s.width = 32; s.height = 48;
    treePool.push(s);
    entityLayer.addChild(s);
  }

  // ---- プレイヤー ----
  // 開通している(非ブロック)タイルを探してスポーン
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
    x: spawn.tx * TILE,
    y: spawn.ty * TILE,
    w: 28, h: 28,
    kx: 0, ky: 0, // ノックバック速度
  };

  // ---- タイトル/アトラクト状態 ----
  let started = false, blinkT = 0;
  const titleEl = document.getElementById('title');
  // デモAI: 決定的にウェイポイント(開通タイル)を選び自機を歩かせる
  const demoRnd = mulberry32(20240619);
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
  let demoStuckT = 0;
  // !started 中はプレイヤー入力の代わりにこの mx,my を返す
  function demoInput(dt) {
    if (!demoTarget) pickDemoTarget();
    const cx = player.x + player.w / 2, cy = player.y + player.h / 2;
    const tx = demoTarget.x + player.w / 2, ty = demoTarget.y + player.h / 2;
    const dx = tx - cx, dy = ty - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < TILE * 0.6) { pickDemoTarget(); demoStuckT = 0; return { mx: 0, my: 0 }; }
    // 主軸方向へ進む(4方向移動)。距離の大きい軸を選ぶ。
    let mx = 0, my = 0;
    if (Math.abs(dx) > Math.abs(dy)) mx = dx > 0 ? 1 : -1;
    else my = dy > 0 ? 1 : -1;
    return { mx, my };
  }
  function resetGame() {
    player.x = spawn.tx * TILE; player.y = spawn.ty * TILE;
    player.kx = 0; player.ky = 0;
    setEntityCount(INIT_ENTITIES);
  }
  function startGame() {
    started = true;
    resetGame();
    titleEl.style.display = 'none';
  }
  const playerSprite = new PIXI.Sprite(walkFrames.player ? walkFrames.player[0] : tex.player);
  playerSprite.width = TILE; playerSprite.height = TILE;
  playerSprite.anchor.set(0); // 左上基準で扱う
  entityLayer.addChild(playerSprite);

  // ---- エンティティ(NPC / スライム) ----
  const entRnd = mulberry32(424242);
  const entities = []; // {type:'npc'|'slime', x,y, vx,vy, t, sprite}

  function spawnEntity(type) {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(entRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(entRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(map, tx, ty)) && guard < 50);
    const sprite = new PIXI.Sprite(type === 'npc'
      ? (walkFrames.npc ? walkFrames.npc[0] : tex.npc)
      : (walkFrames.slime ? walkFrames.slime[0] : tex.enemy_slime));
    sprite.width = TILE; sprite.height = TILE;
    entityLayer.addChild(sprite);
    const e = {
      type,
      x: tx * TILE + 2, y: ty * TILE + 2,
      w: 28, h: 28,
      vx: 0, vy: 0,
      t: entRnd() * 3, // 次に方向転換するまでのタイマー
      sprite,
    };
    entities.push(e);
  }
  function removeEntity() {
    const e = entities.pop();
    if (e) { e.sprite.destroy(); }
  }
  function setEntityCount(n) {
    n = Math.max(0, n);
    while (entities.length < n) spawnEntity(entities.length % 2 === 0 ? 'slime' : 'npc');
    while (entities.length > n) removeEntity();
  }
  setEntityCount(INIT_ENTITIES);

  // ---- 入力 ----
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Enter' && !started) startGame();
    if (e.key === '+' || e.key === '=' || (e.key === ';' && e.shiftKey)) {
      setEntityCount(entities.length + 10);
    } else if (e.key === '-' || e.key === '_') {
      setEntityCount(entities.length - 10);
    }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

  // ---- HUD ---- (他エンジンと同じく HTML オーバーレイ #hud。hint は #help に記載)
  const hudEl = document.getElementById('hud');

  // FPS 移動平均
  let fpsAvg = 60;
  let tilesDrawn = 0;

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

  // ---- メインループ ----
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.05); // 秒, スパイク抑制

    // FPS移動平均
    const instFps = 1000 / Math.max(ticker.deltaMS, 0.0001);
    fpsAvg += (instFps - fpsAvg) * 0.08;

    // --- プレイヤー入力 (アトラクト中はデモAI) ---
    let mx = 0, my = 0;
    if (!started) {
      const d = demoInput(dt);
      mx = d.mx; my = d.my;
    } else {
      if (keys['arrowleft'] || keys['a']) mx -= 1;
      if (keys['arrowright'] || keys['d']) mx += 1;
      if (keys['arrowup'] || keys['w']) my -= 1;
      if (keys['arrowdown'] || keys['s']) my += 1;
    }
    const dash = (started && (keys['shift'] || keys['shiftleft'] || keys['shiftright'])) ? DASH_MULT : 1;
    const sp = SPEED * dash * dt;
    const _bx = player.x, _by = player.y;
    moveActor(player, mx * sp, my * sp);
    updateWalkSprite(playerSprite, walkFrames.player, player.x - _bx, player.y - _by, player.x !== _bx || player.y !== _by, dt, tex.player);
    // デモ中: 壁で詰まったら別のウェイポイントへ
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
        const dir = Math.floor(entRnd() * 5); // 0=up, 1=down, 2=left, 3=right, 4=stop
        const s = (e.type === 'slime' ? SLIME_SPEED : SLIME_SPEED * 0.7);
        e.vx = 0; e.vy = 0;
        if (dir === 0) e.vy = -s;
        else if (dir === 1) e.vy = s;
        else if (dir === 2) e.vx = -s;
        else if (dir === 3) e.vx = s;
      }
      if (e.vx !== 0 || e.vy !== 0) {
        const beforeX = e.x, beforeY = e.y;
        moveActor(e, e.vx * dt, e.vy * dt);
        // 壁に当たって動けなければ方向リセット
        if (e.x === beforeX && e.y === beforeY) { e.t = 0; }
        updateWalkSprite(e.sprite, e.type === 'npc' ? walkFrames.npc : walkFrames.slime, e.x - beforeX, e.y - beforeY, e.x !== beforeX || e.y !== beforeY, dt, e.type === 'npc' ? tex.npc : tex.enemy_slime);
      } else {
        updateWalkSprite(e.sprite, e.type === 'npc' ? walkFrames.npc : walkFrames.slime, 0, 0, false, dt, e.type === 'npc' ? tex.npc : tex.enemy_slime);
      }
      // プレイヤー接触でノックバック
      if (e.type === 'slime' && aabb(player, e)) {
        const cx = (player.x + player.w / 2) - (e.x + e.w / 2);
        const cy = (player.y + player.h / 2) - (e.y + e.h / 2);
        const len = Math.hypot(cx, cy) || 1;
        player.kx = 0;
        player.ky = (cy / len) * KNOCKBACK;
      }
    }

    // --- カメラ追従 ---
    const camX = Math.round(player.x + player.w / 2 - VIEW_W / 2);
    const camY = Math.round(player.y + player.h / 2 - VIEW_H / 2);
    const maxCamX = MAP_W * TILE - VIEW_W;
    const maxCamY = MAP_H * TILE - VIEW_H;
    const clX = Math.max(0, Math.min(camX, maxCamX));
    const clY = Math.max(0, Math.min(camY, maxCamY));
    world.x = -clX;
    world.y = -clY;

    // --- タイルカリング描画(可視範囲のみ) ---
    const startTx = Math.floor(clX / TILE);
    const startTy = Math.floor(clY / TILE);
    tilesDrawn = 0;
    let pi = 0;
    let ti = 0; // tree pool index
    for (let row = 0; row < rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        const s = tilePool[pi++];
        if (!s) break;
        s.texture = tileTexByType[type];
        s.width = TILE; s.height = TILE;
        s.x = tx * TILE; s.y = ty * TILE;
        s.visible = true;
        tilesDrawn++;
        // 木は地面(草)の上に重ねて別スプライトで描画
        if (type === T_TREE) {
          const tr = treePool[ti++];
          if (tr) {
            tr.x = tx * TILE;
            tr.y = ty * TILE - 16; // 32x48 を足元合わせ
            tr.zIndex = tr.y + 48;
            tr.visible = true;
          }
        }
      }
    }
    // 余った tile プール非表示
    for (; pi < tilePool.length; pi++) tilePool[pi].visible = false;
    const treesDrawn = ti;
    for (; ti < treePool.length; ti++) treePool[ti].visible = false;

    // --- エンティティ描画 + 深度ソート(y順) ---
    for (const e of entities) {
      e.sprite.x = e.x - 2;
      e.sprite.y = e.y - 2;
      e.sprite.zIndex = e.y + e.h;
    }
    playerSprite.x = player.x - 2;
    playerSprite.y = player.y - 2;
    playerSprite.zIndex = player.y + player.h;
    entityLayer.sortableChildren = true; // v8: zIndexで並べ替え

    // --- HUD ---
    const ptx = Math.floor((player.x + player.w / 2) / TILE);
    const pty = Math.floor((player.y + player.h / 2) / TILE);
    const treeCount = countTrees(); // 木総数(Entities集計用)
    // 表示内容・書式は three.js に統一
    hudEl.textContent =
      `FPS         : ${fpsAvg.toFixed(1)}\n` +
      `Tiles drawn : ${tilesDrawn}  (trees: ${treesDrawn})\n` +
      `Entities    : ${entities.length + treeCount}  (NPC+敵:${entities.length} / 木:${treeCount})\n` +
      `Player tile : (${ptx}, ${pty})  ${dash > 1 ? '[DASH]' : ''}`;

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  // 木の総数(マップ全体)は固定なので一度だけ数える
  let _treeCount = -1;
  function countTrees() {
    if (_treeCount >= 0) return _treeCount;
    let c = 0;
    for (let i = 0; i < map.length; i++) if (map[i] === T_TREE) c++;
    _treeCount = c;
    return c;
  }

  // リサイズ非対応(キャンバス固定960x540)。ウィンドウサイズに合わせ縮小表示。
  function fit() {
    const scale = Math.min(window.innerWidth / VIEW_W, (window.innerHeight - 40) / VIEW_H, 1);
    app.canvas.style.width = (VIEW_W * scale) + 'px';
    app.canvas.style.height = (VIEW_H * scale) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);

  console.log('[PixiJS v8] init ok. renderer =', app.renderer.type);
})();
