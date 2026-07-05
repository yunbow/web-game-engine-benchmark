/* ============================================================================
 * テーマ5 横スクロールアクション ― KAPLAY 実装
 * 共通仕様 SPEC.md / 正準実装 PixiJS に厳密準拠。性能比較用。
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリ。座標系は Y 下向き・原点左上 =
 * 画面座標と一致するため PixiJS と同じ画面座標でゲームロジックを書ける。ただし:
 *   - 物理 (重力 + 可変ジャンプ + AABB 軸分離タイル当たり) は SPEC 準拠の自前実装。
 *     KAPLAY の body()/area() は使わず、他エンジンと同条件にする。
 *   - 広い横長マップ (200x17 = 6400x544px) のため「ワールド→画面」の水平スクロール
 *     オフセット (camX,camY) を持ち、毎フレーム描画時に -camX,-camY 平行移動する。
 *   - 描画は onDraw 内の即時描画 (drawSprite/drawRect) で、可視範囲のタイルのみ
 *     描く真のカリングを行う (PixiJS のプール再利用カリングと同じ可視範囲)。
 * ========================================================================== */

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const TILE = 32;
const MAP_W = 200;
const MAP_H = 17;
const VIEW_W = 960;
const VIEW_H = 540;
const WORLD_W = MAP_W * TILE;     // 6400
const WORLD_H = MAP_H * TILE;     // 544

// 物理 (デルタタイム基準, px/s, px/s^2)
const GRAVITY = 1800;
const WALK_SPEED = 180;
const DASH_SPEED = 288;           // ×1.6
const JUMP_VY = -640;
const JUMP_CUT = 0.45;            // 可変ジャンプ: 上昇中にキーを離した際の減衰係数
const FALL_MARGIN = 80;           // マップ下端 + 余白を越えたら落下死

// 自機 (当たり判定 24x44 / 描画 32x48)
const P_W = 24, P_H = 44;
const P_DRAW_W = 32, P_DRAW_H = 48;
const P_HP = 3;
const INVULN = 1.0;              // 被弾後の無敵 (s)
const KNOCKBACK_X = 220;
const KNOCKBACK_Y = -260;

// 敵 (goomba: 当たり判定 28x28)
const E_W = 28, E_H = 28;
const E_SPEED = 60;
const STOMP_BOUNCE = -380;
const SCORE_STOMP = 100;
const SCORE_COIN = 50;

// 敵数 (負荷)
const ENEMY_INIT = 20;
const ENEMY_STEP = 10;
const ENEMY_MIN = 0;
const ENEMY_MAX = 500;

// タイル種別: 0=空, 1=地面, 2=ブロック, 3=土管
const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = new Set([T_GROUND, T_BRICK, T_PIPE]);

// フォールバック色 (RGB)
const COLORS = {
  player: [226, 59, 46],   // 赤
  goomba: [138, 90, 43],   // 茶
  ground: [155, 107, 58],  // 茶
  brick:  [208, 128, 48],  // 橙
  pipe:   [58, 166, 74],   // 緑
  coin:   [242, 211, 60],  // 黄
  sky:    [106, 180, 255], // 空色
};

const ASSET_DEFS = {
  player:      '../assets/player.png',
  player_walk: '../assets/player_walk.png',
  goomba:      '../assets/enemy_goomba.png',
  goomba_walk: '../assets/enemy_goomba_walk.png',
  tile_ground: '../assets/tile_ground.png',
  tile_brick:  '../assets/tile_brick.png',
  tile_pipe:   '../assets/tile_pipe.png',
  coin:        '../assets/coin.png',
  bg_sky:      '../assets/bg_sky.png',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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

// ---- マップ決定的生成 (PixiJS と同一アルゴリズム / 同一シード) -------------
function generateMap() {
  const rnd = mulberry32(20250614);
  const map = new Uint8Array(MAP_W * MAP_H); // 既定 0 = 空
  const idx = (x, y) => y * MAP_W + x;

  const GROUND_TOP = MAP_H - 2;

  // --- 最下2段を地面に。所々を穴(gap)として抜く ---
  let x = 0;
  while (x < MAP_W) {
    // 地面の連続区間を敷く
    const run = 5 + Math.floor(rnd() * 6);
    for (let i = 0; i < run && x < MAP_W; i++, x++) {
      map[idx(x, GROUND_TOP)] = T_GROUND;
      map[idx(x, MAP_H - 1)] = T_GROUND;
    }
    // その後に幅1の穴を1つだけ（連続穴を防ぎ、デモが必ず越えられる幅にする）
    if (x > 8 && x < MAP_W - 8 && rnd() < 0.30) x += 1;
  }

  // --- 空中のブロック足場: ジャンプ頂点より上(py<=9)に置き、走路に天井を作らない ---
  for (let i = 0; i < 70; i++) {
    const px = 6 + Math.floor(rnd() * (MAP_W - 12));
    const py = 4 + Math.floor(rnd() * 6); // 4..9
    const len = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < len && px + k < MAP_W - 2; k++) {
      if (map[idx(px + k, py)] === T_EMPTY) map[idx(px + k, py)] = T_BRICK;
    }
  }

  // --- 地上の土管 (地面の上に2段)。穴の近く(±4)には置かない(越えジャンプが穴に着地するため) ---
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (map[idx(g, GROUND_TOP)] !== T_GROUND) return false;
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const px = 12 + Math.floor(rnd() * (MAP_W - 24));
    if (map[idx(px, GROUND_TOP)] === T_GROUND && map[idx(px + 1, GROUND_TOP)] === T_GROUND && noGapNear(px)) {
      const h = 1 + Math.floor(rnd() * 2);
      for (let k = 1; k <= h; k++) {
        map[idx(px, GROUND_TOP - k)] = T_PIPE;
        map[idx(px + 1, GROUND_TOP - k)] = T_PIPE;
      }
    }
  }

  // --- 左右端は壁 (全高) ---
  for (let y = 0; y < MAP_H; y++) {
    map[idx(0, y)] = T_GROUND;
    map[idx(MAP_W - 1, y)] = T_GROUND;
  }

  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return T_EMPTY;
  return map[ty * MAP_W + tx];
}

// 矩形(px)が solid タイルに重なるか
function rectHitsSolid(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE);
  const y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE);
  const y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (SOLID.has(tileAt(map, tx, ty))) return true;
    }
  }
  return false;
}

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: COLORS.sky,
  crisp: true,
  global: false,            // 名前空間 k.* を明示利用
});

// === アセット読み込み (失敗してもフォールバック図形で起動) ==================
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      const opts = key.endsWith('_walk') ? { sliceX: 4, sliceY: 2 } : undefined;
      await k.loadSprite(key, url, opts);
      loaded[key] = true;
    }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

function start() {
  const map = generateMap();

  const tileKeyByType = { [T_GROUND]: 'tile_ground', [T_BRICK]: 'tile_brick', [T_PIPE]: 'tile_pipe' };
  const tileColorByType = { [T_GROUND]: COLORS.ground, [T_BRICK]: COLORS.brick, [T_PIPE]: COLORS.pipe };

  // ---- コイン (決定的配置: PixiJS と同一) ----
  const coins = []; // {x,y,w,h, taken}
  (function buildCoins() {
    const rnd = mulberry32(777);
    for (let tx = 2; tx < MAP_W - 2; tx++) {
      for (let ty = 2; ty < MAP_H - 1; ty++) {
        if (tileAt(map, tx, ty) !== T_EMPTY) continue;
        const below = tileAt(map, tx, ty + 1);
        if (!SOLID.has(below)) continue;
        if (rnd() < 0.10) {
          coins.push({ x: tx * TILE + (TILE - 24) / 2, y: ty * TILE + (TILE - 24) / 2, w: 24, h: 24, taken: false });
        }
      }
    }
  })();

  // ---- スポーン地点 (左端付近の地表上) ----
  const SPAWN_TX = 3;
  const GROUND_TOP_Y = (MAP_H - 2) * TILE;
  const spawn = { x: SPAWN_TX * TILE, y: GROUND_TOP_Y - P_H };

  // ---- プレイヤー ----
  const player = {
    x: spawn.x, y: spawn.y, w: P_W, h: P_H,
    vx: 0, vy: 0, onGround: false, hp: P_HP, invuln: 0, facing: 1,
  };

  // ---- 敵スポーン候補 (決定的列挙 + 固定シードシャッフル) ----
  const spawnSlots = [];
  (function buildSpawnSlots() {
    for (let tx = 5; tx < MAP_W - 5; tx++) {
      for (let ty = 2; ty < MAP_H - 1; ty++) {
        if (tileAt(map, tx, ty) !== T_EMPTY) continue;
        if (SOLID.has(tileAt(map, tx, ty + 1))) spawnSlots.push({ tx, ty });
      }
    }
    const rnd = mulberry32(31337);
    for (let i = spawnSlots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = spawnSlots[i]; spawnSlots[i] = spawnSlots[j]; spawnSlots[j] = t;
    }
  })();

  const enemies = []; // {x,y,w,h,vx,vy,onGround,alive}
  let enemySet = 0;
  function setEnemyCount(n) {
    n = clamp(n, ENEMY_MIN, ENEMY_MAX);
    while (enemies.length < n) {
      const i = enemies.length;
      const slot = spawnSlots[i % spawnSlots.length];
      const dir = (i % 2 === 0) ? 1 : -1;
      enemies.push({
        x: slot.tx * TILE + (TILE - E_W) / 2,
        y: slot.ty * TILE + (TILE - E_H),
        w: E_W, h: E_H, vx: dir * E_SPEED, vy: 0, onGround: false, alive: true,
      });
    }
    while (enemies.length > n) enemies.pop();
    enemySet = n;
  }
  setEnemyCount(ENEMY_INIT);

  // ---- 火花エフェクト (撃破時) ----
  const sparks = []; // {x,y,life,max}

  // ---- タイトル/アトラクト状態 (false=デモ中・操作無効) ----
  let started = false, blinkT = 0;
  const titleEl = document.getElementById('title');

  // ---- 入力 (KAPLAY のキー名で +/-、移動はループ内 isKeyDown) ----
  k.onKeyPress(['=', 'kpadd'], () => setEnemyCount(enemySet + ENEMY_STEP));
  k.onKeyPress(['minus', 'kpsubtract'], () => setEnemyCount(enemySet - ENEMY_STEP));
  k.onKeyPress('enter', () => { if (!started) startGame(); });

  // ---- 当たり判定 (AABB) ----
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  // 軸分離移動: X→解決 → Y→解決。接地フラグを更新。
  function moveAndCollide(a, dx, dy) {
    let hitX = false, hitY = false;
    if (dx !== 0) {
      let nx = a.x + dx;
      if (rectHitsSolid(map, nx, a.y, a.w, a.h)) {
        if (dx > 0) nx = Math.floor((nx + a.w) / TILE) * TILE - a.w - 0.001;
        else nx = Math.floor(nx / TILE + 1) * TILE + 0.001;
        a.vx = 0; hitX = true;
      }
      a.x = nx;
    }
    a.onGround = false;
    if (dy !== 0) {
      let ny = a.y + dy;
      if (rectHitsSolid(map, a.x, ny, a.w, a.h)) {
        if (dy > 0) { ny = Math.floor((ny + a.h) / TILE) * TILE - a.h - 0.001; a.onGround = true; }
        else ny = Math.floor(ny / TILE + 1) * TILE + 0.001;
        a.vy = 0; hitY = true;
      }
      a.y = ny;
    }
    return { hitX, hitY };
  }

  // ---- ゲーム状態 ----
  let score = 0, coinsCollected = 0, tilesDrawn = 0;
  let camX = 0, camY = 0;

  function respawnPlayer() {
    player.x = spawn.x; player.y = spawn.y;
    player.vx = 0; player.vy = 0; player.hp = P_HP; player.invuln = INVULN; player.onGround = false;
  }
  function hurtPlayer(fromX) {
    if (player.invuln > 0) return;
    player.hp -= 1; player.invuln = INVULN;
    const dir = (player.x + player.w / 2) < fromX ? -1 : 1;
    player.vx = KNOCKBACK_X * dir; player.vy = KNOCKBACK_Y; player.onGround = false;
    if (player.hp <= 0) respawnPlayer();
  }

  // Enter でデモ→プレイ開始: スコア等を新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    score = 0; coinsCollected = 0;
    for (let i = 0; i < coins.length; i++) coins[i].taken = false;
    setEnemyCount(ENEMY_INIT);
    respawnPlayer();
    titleEl.style.display = 'none';
  }

  // ---- デモAI (決定的): 右走行 + 接地時に前方の障害/穴で自動ジャンプ ----
  // 上昇中はジャンプ保持を続けて十分な高さを確保 (可変ジャンプと整合)。
  function demoAI(p) {
    const aheadX = p.x + p.w + 4;
    const midY = p.y + p.h * 0.5;
    const footY = p.y + p.h - 2;
    const wallAhead =
      SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(midY / TILE))) ||
      SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(footY / TILE)));
    const gapProbeX = p.x + p.w + TILE * 1.2;
    const belowTy = Math.floor((p.y + p.h + TILE * 0.5) / TILE);
    const gapAhead = p.onGround && !SOLID.has(tileAt(map, Math.floor(gapProbeX / TILE), belowTy));
    let jump = false;
    if (p.onGround) jump = wallAhead || gapAhead;
    else if (p.vy < 0) jump = true;   // 上昇中は保持 (可変ジャンプを伸ばす)
    return { move: 1, jump };
  }

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;

  // ====================================================================
  // 更新ループ
  // ====================================================================
  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();

    // 1) プレイヤー入力 + 物理
    // !started (アトラクト) 中はデモAIで右走行＋障害/穴で自動ジャンプ。キー入力は無視。
    let move = 0, jumpHeld = false, speed = WALK_SPEED;
    if (!started) {
      const demo = demoAI(player);
      move = demo.move; jumpHeld = demo.jump;
    } else {
      const dash = k.isKeyDown('shift');
      speed = dash ? DASH_SPEED : WALK_SPEED;
      if (k.isKeyDown('left') || k.isKeyDown('a')) move -= 1;
      if (k.isKeyDown('right') || k.isKeyDown('d')) move += 1;
      jumpHeld = k.isKeyDown('space') || k.isKeyDown('up') || k.isKeyDown('w');
    }

    const knockbackActive = Math.abs(player.vx) > speed + 1 && player.invuln > 0;
    if (knockbackActive) {
      player.vx *= 0.9;
      if (Math.abs(player.vx) < speed) player.vx = move * speed;
    } else {
      player.vx = move * speed;
    }
    if (move !== 0) player.facing = move;
    if (jumpHeld && player.onGround) { player.vy = JUMP_VY; player.onGround = false; }
    if (!jumpHeld && player.vy < 0) player.vy *= JUMP_CUT;

    player.vy += GRAVITY * dt;
    if (player.vy > 1200) player.vy = 1200;

    moveAndCollide(player, player.vx * dt, player.vy * dt);

    if (player.invuln > 0) { player.invuln -= dt; if (player.invuln < 0) player.invuln = 0; }

    if (player.y > WORLD_H + FALL_MARGIN) {
      player.hp -= 1;
      if (player.hp <= 0) respawnPlayer();
      else { player.x = spawn.x; player.y = spawn.y; player.vx = 0; player.vy = 0; player.invuln = INVULN; }
    }

    // 2) 敵更新 (重力 + 壁で反転)
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      e.vy += GRAVITY * dt;
      if (e.vy > 1200) e.vy = 1200;
      const dir = Math.sign(e.vx) || 1;
      const beforeX = e.x;
      const res = moveAndCollide(e, e.vx * dt, e.vy * dt);
      if (res.hitX || Math.abs(e.x - beforeX) < 0.01) e.vx = -dir * E_SPEED;
      else e.vx = dir * E_SPEED;
    }

    // 3) 当たり判定: 自機 × 敵 (踏みつけ / 横接触)
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      if (!aabb(player, e)) continue;
      const playerFalling = player.vy > 0;
      const playerBottom = player.y + player.h;
      const stomp = playerFalling && (playerBottom - e.y) < (e.h * 0.6 + Math.abs(player.vy * dt) + 1);
      if (stomp) {
        e.alive = false;
        enemies[i] = enemies[enemies.length - 1]; enemies.pop(); i--;
        score += SCORE_STOMP;
        sparks.push({ x: e.x + e.w / 2, y: e.y + e.h / 2, life: 0.35, max: 0.35 });
        player.vy = STOMP_BOUNCE;
      } else {
        hurtPlayer(e.x + e.w / 2);
      }
    }

    // 4) コイン取得
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c.taken) continue;
      if (aabb(player, c)) { c.taken = true; coinsCollected += 1; score += SCORE_COIN; }
    }

    // 5) カメラ (水平追従 + クランプ)
    camX = clamp(Math.round(player.x + player.w / 2 - VIEW_W / 2), 0, WORLD_W - VIEW_W);
    camY = clamp(Math.round(player.y + player.h / 2 - VIEW_H / 2), 0, Math.max(0, WORLD_H - VIEW_H));

    // 火花
    for (let i = sparks.length - 1; i >= 0; i--) {
      sparks[i].life -= dt;
      if (sparks[i].life <= 0) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); }
    }

    // HUD (約120msごと)
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
      const ptx = Math.floor((player.x + player.w / 2) / TILE);
      const pty = Math.floor((player.y + player.h / 2) / TILE);
      const entities = enemies.length + coins.filter((c) => !c.taken).length;
      hudEl.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${tilesDrawn}  /  Entities : ${entities}\n` +
        `Player tile : (${ptx}, ${pty})\n` +
        `Score : ${score}   Coins : ${coinsCollected}   HP : ${player.hp}\n` +
        `Enemies : ${enemies.length} / ${enemySet}   (+/- で増減, 上限 ${ENEMY_MAX})`;
    }

    // タイトル点滅 (アトラクト中のみ)。被弾死は respawnPlayer が自動でループ再開する。
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  // ====================================================================
  // 描画ループ (即時描画 + 水平スクロールオフセット + タイルカリング)
  // ====================================================================
  k.onDraw(() => {
    // 背景 (画面固定 / 軽い視差。空色ベタ + 画像があればタイル並べ)
    if (loaded.bg_sky) {
      const par = -(camX * 0.4) % 512;
      for (let bx = par - 512; bx < VIEW_W; bx += 512) {
        for (let by = 0; by < VIEW_H; by += 512) {
          k.drawSprite({ sprite: 'bg_sky', pos: k.vec2(bx, by), width: 512, height: 512 });
        }
      }
    }

    // ワールド: -camX,-camY 平行移動して以降をワールド座標で描く
    k.pushTransform();
    k.pushTranslate(-camX, -camY);

    // タイルカリング (可視範囲のみ即時描画)
    const colsVis = Math.ceil(VIEW_W / TILE) + 2;
    const rowsVis = Math.ceil(VIEW_H / TILE) + 2;
    const startTx = Math.floor(camX / TILE);
    const startTy = Math.floor(camY / TILE);
    let drawn = 0;
    for (let row = 0; row < rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        if (type === T_EMPTY) continue;
        const px = tx * TILE, py = ty * TILE;
        if (loaded[tileKeyByType[type]]) {
          k.drawSprite({ sprite: tileKeyByType[type], pos: k.vec2(px, py), width: TILE, height: TILE });
        } else {
          const c = tileColorByType[type];
          k.drawRect({ pos: k.vec2(px, py), width: TILE, height: TILE, color: k.rgb(c[0], c[1], c[2]) });
        }
        drawn++;
      }
    }
    tilesDrawn = drawn;

    // コイン
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c.taken) continue;
      if (c.x + c.w < camX || c.x > camX + VIEW_W) continue;
      if (loaded.coin) k.drawSprite({ sprite: 'coin', pos: k.vec2(c.x, c.y), width: 24, height: 24 });
      else k.drawCircle({ pos: k.vec2(c.x + 12, c.y + 12), radius: 10, color: k.rgb(COLORS.coin[0], COLORS.coin[1], COLORS.coin[2]) });
    }

    // 敵 (28x28 当たり判定を 32x32 描画の中央下に)
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.x + 32 < camX || e.x > camX + VIEW_W) continue;
      const dx = e.x - (32 - E_W) / 2, dy = e.y - (32 - E_H);
      if (loaded.goomba_walk) {
        const row = e.vx < 0 ? 1 : 0;
        k.drawSprite({ sprite: 'goomba_walk', frame: row * 4 + (Math.floor((performance.now() / 140) + i) % 4), pos: k.vec2(dx, dy), width: 32, height: 32 });
      }
      else if (loaded.goomba) k.drawSprite({ sprite: 'goomba', pos: k.vec2(dx, dy), width: 32, height: 32 });
      else k.drawCircle({ pos: k.vec2(dx + 16, dy + 14), radius: 13, color: k.rgb(COLORS.goomba[0], COLORS.goomba[1], COLORS.goomba[2]) });
    }

    // 自機 (描画 32x48 を当たり判定 24x44 の中央下に / 左右反転 / 無敵点滅)
    const dirRow = player.facing < 0 ? 1 : 0;
    const pdx = player.x - (P_DRAW_W - P_W) / 2;
    const pdy = player.y - (P_DRAW_H - P_H);
    const pop = (player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0) ? 0.35 : 1;
    if (loaded.player_walk) {
      const playerFrame = Math.abs(player.vx) > 5 && player.onGround ? Math.floor(performance.now() / 110) % 4 : 0;
      k.drawSprite({ sprite: 'player_walk', frame: dirRow * 4 + playerFrame, pos: k.vec2(pdx, pdy), width: P_DRAW_W, height: P_DRAW_H, opacity: pop });
    } else if (loaded.player) {
      k.drawSprite({ sprite: 'player', pos: k.vec2(pdx, pdy), width: P_DRAW_W, height: P_DRAW_H, flipX: player.facing < 0, opacity: pop });
    } else {
      k.drawRect({ pos: k.vec2(pdx, pdy), width: P_DRAW_W, height: P_DRAW_H, radius: 5, opacity: pop,
        color: k.rgb(COLORS.player[0], COLORS.player[1], COLORS.player[2]) });
    }

    // 火花
    for (let i = 0; i < sparks.length; i++) {
      const sp = sparks[i];
      const t = sp.life / sp.max;
      k.drawCircle({ pos: k.vec2(sp.x, sp.y), radius: 7 * (1 + (1 - t) * 0.8), opacity: clamp(t, 0, 1), color: k.rgb(255, 242, 168) });
    }

    k.popTransform();
  });

  console.log('KAPLAY theme5 platformer started.');
}
