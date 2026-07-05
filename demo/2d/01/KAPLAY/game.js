/* ============================================================================
 * 弾幕STG (縦スクロールSTG) - KAPLAY 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリ。以下はライブラリ機構を使う:
 *   - ゲームループ (onUpdate / dt())
 *   - 入力 (isKeyDown / onKeyPress)
 *   - スプライト/図形描画 (add([...comps]))
 *   - 座標系は Y 下向き・原点左上 = 画面座標とそのまま一致
 * ただし当たり判定は SPEC 準拠の「自前の円判定 (平方距離比較)」を使う
 * (KAPLAY の area() は AABB/多角形なので、他エンジンと条件を揃えるため不使用)。
 * ========================================================================== */

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;
const PLAYER_SPEED = 300;
const PLAYER_BULLET_SPEED = 600;
const FIRE_INTERVAL = 0.150;        // 秒
const ENEMY_SPEED_MIN = 80, ENEMY_SPEED_MAX = 140;
const ENEMY_BULLET_SPEED = 200;
const ENEMY_FIRE_MIN = 0.9, ENEMY_FIRE_MAX = 2.2; // 秒
const INITIAL_MAX_ENEMIES = 40, MAX_ENEMIES_CAP = 300, ENEMY_STEP = 10;
const INITIAL_HP = 3, SCORE_PER_KILL = 10;
const EXPLOSION_LIFE = 0.25;        // 秒

const R_PLAYER = 16, R_PLAYER_BULLET = 6;
const R_ENEMY_SMALL = 18, R_ENEMY_BIG = 40, R_ENEMY_BULLET = 7;

const ASSET_DEFS = {
  player_ship:  '../assets/player_ship.png',
  enemy_small:  '../assets/enemy_small.png',
  enemy_big:    '../assets/enemy_big.png',
  bullet_player:'../assets/bullet_player.png',
  bullet_enemy: '../assets/bullet_enemy.png',
  explosion:    '../assets/explosion.png',
  bg_space:     '../assets/bg_space.png',
};

const clampv = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: W, height: H,
  canvas: document.getElementById('game-canvas'),
  background: [5, 6, 15],
  crisp: true,
  global: false,            // 名前空間 k.* を明示利用 (グローバル汚染を避ける)
});

// === アセット読み込み (失敗してもフォールバックで起動) ======================
// loadSprite は失敗時に reject するので、個別に try/catch して有無を記録。
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { await k.loadSprite(key, url); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

// スプライト or フォールバック図形のコンポーネント配列を返すヘルパ。
function visual(key, px, fallbackComps) {
  if (loaded[key]) return [k.sprite(key), k.anchor('center')];
  return fallbackComps;
}

function start() {
  // --- 背景: 縦スクロールする星 (フォールバックの bg と兼用) ---
  const stars = [];
  for (let i = 0; i < 140; i++) {
    stars.push({ x: k.rand(0, W), y: k.rand(0, H), spd: k.rand(40, 120), r: k.rand(0.5, 1.8) });
  }
  if (loaded.bg_space) {
    // タイル背景 (2枚並べて縦ループ)
    for (let i = 0; i < 2; i++) {
      const t = k.add([k.sprite('bg_space'), k.pos(0, i * -H), k.anchor('topleft'), { i, bgtile: true }]);
      t.width = W; t.height = H;
    }
  }
  k.onDraw(() => {
    for (const s of stars) k.drawCircle({ pos: k.vec2(s.x, s.y), radius: s.r, color: k.rgb(159, 184, 255), opacity: 0.6 });
  });

  // --- 自機 ---
  const player = k.add([
    ...visual('player_ship', 48, [k.polygon([k.vec2(0, -24), k.vec2(24, 24), k.vec2(-24, 24)]), k.color(85, 224, 255), k.anchor('center')]),
    k.pos(W / 2, H - 70),
    { hp: INITIAL_HP, alive: true, invul: 0 },
  ]);
  if (loaded.player_ship) { player.width = 48; player.height = 48; }

  // --- エンティティ配列 (自前管理) ---
  const playerBullets = [], enemies = [], enemyBullets = [], effects = [];
  let score = 0, maxEnemies = INITIAL_MAX_ENEMIES;
  let fireTimer = 0, spawnAcc = 0;
  let started = false, blinkT = 0, autoT = 0;   // タイトル/アトラクト状態 (false=デモ中・操作無効)
  const titleEl = document.getElementById('title');

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    score = 0; maxEnemies = INITIAL_MAX_ENEMIES;
    player.hp = INITIAL_HP; player.alive = true; player.invul = 0;
    player.pos = k.vec2(W / 2, H - 70); player.opacity = 1;
    for (let i = enemies.length - 1; i >= 0; i--) rm(enemies, i);
    for (let i = playerBullets.length - 1; i >= 0; i--) rm(playerBullets, i);
    for (let i = enemyBullets.length - 1; i >= 0; i--) rm(enemyBullets, i);
    for (let i = effects.length - 1; i >= 0; i--) rm(effects, i);
    if (titleEl) titleEl.style.display = 'none';
  }

  // --- 入力: 負荷調整 (+/-) ---
  k.onKeyPress('enter', () => { if (!started) startGame(); });
  k.onKeyPress(['=', 'kpadd'], () => { maxEnemies = Math.min(MAX_ENEMIES_CAP, maxEnemies + ENEMY_STEP); });
  k.onKeyPress(['minus', 'kpsubtract'], () => { maxEnemies = Math.max(0, maxEnemies - ENEMY_STEP); });

  function spawnEnemy() {
    const big = k.rand() < 0.18;
    const r = big ? R_ENEMY_BIG : R_ENEMY_SMALL;
    const key = big ? 'enemy_big' : 'enemy_small';
    const fb = big
      ? [k.circle(40), k.color(255, 48, 112), k.anchor('center')]
      : [k.circle(22), k.color(255, 80, 80), k.anchor('center')];
    const e = k.add([...visual(key, big ? 80 : 40, fb), k.pos(k.rand(40, W - 40), -40),
      { vx: k.rand(-30, 30), vy: k.rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX), big, r,
        hp: big ? 3 : 1, fireTimer: k.rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX) }]);
    if (loaded[key]) { e.width = big ? 80 : 40; e.height = big ? 80 : 40; }
    enemies.push(e);
  }
  function firePlayer() {
    const b = k.add([...visual('bullet_player', 12, [k.rect(8, 22, { radius: 4 }), k.color(255, 226, 77), k.anchor('center')]),
      k.pos(player.pos.x, player.pos.y - 24), { isB: true }]);
    if (loaded.bullet_player) { b.width = 12; b.height = 22; }
    playerBullets.push(b);
  }
  function fireEnemy(e) {
    const dx = player.pos.x - e.pos.x, dy = player.pos.y - e.pos.y;
    const len = Math.hypot(dx, dy) || 1;
    const b = k.add([...visual('bullet_enemy', 14, [k.circle(7), k.color(255, 144, 32), k.anchor('center')]),
      k.pos(e.pos.x, e.pos.y), { vx: dx / len * ENEMY_BULLET_SPEED, vy: dy / len * ENEMY_BULLET_SPEED }]);
    if (loaded.bullet_enemy) { b.width = 14; b.height = 14; }
    enemyBullets.push(b);
  }
  function spawnExplosion(x, y, big) {
    const s = big ? 80 : 48;
    const f = k.add([...visual('explosion', s, [k.circle(big ? 30 : 18), k.color(255, 204, 51), k.anchor('center')]),
      k.pos(x, y), k.opacity(1), { life: EXPLOSION_LIFE, max: EXPLOSION_LIFE }]);
    if (loaded.explosion) { f.width = s; f.height = s; }
    effects.push(f);
  }
  function rm(arr, i) { k.destroy(arr[i]); arr[i] = arr[arr.length - 1]; arr.pop(); }

  function hurtPlayer() {
    player.hp -= 1;
    if (player.hp <= 0) {
      player.hp = 0; player.alive = false; player.opacity = 0.15;
      spawnExplosion(player.pos.x, player.pos.y, true);
      k.wait(1.5, () => {
        player.hp = INITIAL_HP; player.alive = true; player.opacity = 1;
        player.pos = k.vec2(W / 2, H - 70); player.invul = 1.5;
      });
    } else { player.invul = 1.5; }
  }

  // --- FPS 移動平均 + HUD ---
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;

  k.onUpdate(() => {
    const dt = k.dt();
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // 背景タイルスクロール
    if (loaded.bg_space) for (const t of k.get('bgtile')) {
      t.pos.y += 60 * dt; if (t.pos.y >= H) t.pos.y -= H * 2;
    }
    for (const s of stars) { s.y += s.spd * dt; if (s.y > H) { s.y = 0; s.x = k.rand(0, W); } }

    if (player.alive) {
      let mx = 0, my = 0;
      if (!started) {
        // デモAI: 累積時間の sin で緩やかに左右＋上下移動 (決定的)
        autoT += dt;
        mx = Math.cos(autoT * 0.8);
        my = 0;
      } else {
        if (k.isKeyDown('left') || k.isKeyDown('a')) mx -= 1;
        if (k.isKeyDown('right') || k.isKeyDown('d')) mx += 1;
        if (k.isKeyDown('up') || k.isKeyDown('w')) my -= 1;
        if (k.isKeyDown('down') || k.isKeyDown('s')) my += 1;
      }
      if (mx && my) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
      player.pos.x = clampv(player.pos.x + mx * PLAYER_SPEED * dt, 24, W - 24);
      player.pos.y = clampv(player.pos.y + my * PLAYER_SPEED * dt, 24, H - 24);
      if (player.invul > 0) {
        player.invul -= dt;
        player.opacity = (Math.floor(player.invul * 16) % 2 === 0) ? 0.35 : 1;
        if (player.invul <= 0) player.opacity = 1;
      }
      fireTimer -= dt;
      if (fireTimer <= 0) { firePlayer(); fireTimer += FIRE_INTERVAL; if (fireTimer < 0) fireTimer = 0; }
    }

    spawnAcc += dt;
    while (spawnAcc >= 0.08) { spawnAcc -= 0.08; if (enemies.length < maxEnemies) spawnEnemy(); }

    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i]; b.pos.y -= PLAYER_BULLET_SPEED * dt;
      if (b.pos.y < -30) rm(playerBullets, i);
    }
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i]; e.pos.x += e.vx * dt; e.pos.y += e.vy * dt;
      if (e.pos.x < 24 && e.vx < 0) e.vx = -e.vx;
      if (e.pos.x > W - 24 && e.vx > 0) e.vx = -e.vx;
      if (e.pos.y > H + 50) { rm(enemies, i); continue; }
      e.fireTimer -= dt;
      if (e.fireTimer <= 0 && player.alive && e.pos.y > 0) { fireEnemy(e); e.fireTimer = k.rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX); }
    }
    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i]; b.pos.x += b.vx * dt; b.pos.y += b.vy * dt;
      if (b.pos.x < -30 || b.pos.x > W + 30 || b.pos.y < -30 || b.pos.y > H + 30) rm(enemyBullets, i);
    }

    // 当たり判定 (円判定 = 平方距離比較)
    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i]; let hit = false;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j], dx = b.pos.x - e.pos.x, dy = b.pos.y - e.pos.y, rr = R_PLAYER_BULLET + e.r;
        if (dx * dx + dy * dy <= rr * rr) {
          e.hp -= 1; hit = true;
          if (e.hp <= 0) { spawnExplosion(e.pos.x, e.pos.y, e.big); rm(enemies, j); score += SCORE_PER_KILL; }
          break;
        }
      }
      if (hit) rm(playerBullets, i);
    }
    if (player.alive && player.invul <= 0) {
      for (let i = enemyBullets.length - 1; i >= 0; i--) {
        const b = enemyBullets[i], dx = b.pos.x - player.pos.x, dy = b.pos.y - player.pos.y, rr = R_ENEMY_BULLET + R_PLAYER;
        if (dx * dx + dy * dy <= rr * rr) { rm(enemyBullets, i); hurtPlayer(); break; }
      }
    }
    if (player.alive && player.invul <= 0) {
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j], dx = e.pos.x - player.pos.x, dy = e.pos.y - player.pos.y, rr = e.r + R_PLAYER;
        if (dx * dx + dy * dy <= rr * rr) { spawnExplosion(e.pos.x, e.pos.y, e.big); rm(enemies, j); hurtPlayer(); break; }
      }
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i]; f.life -= dt; const t = f.life / f.max;
      f.opacity = clampv(t, 0, 1); f.scale = k.vec2((1 - t) * 0.5 + 1);
      if (f.life <= 0) rm(effects, i);
    }

    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const objects = playerBullets.length + enemyBullets.length + enemies.length + effects.length;
      hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Objects : ${objects}  (bul ${playerBullets.length + enemyBullets.length} / ene ${enemies.length} / fx ${effects.length})\n` +
        `Score   : ${score}\n` +
        `HP      : ${player.alive ? '♥'.repeat(player.hp) + ' (' + player.hp + ')' : 'GAME OVER'}\n` +
        `MaxEnemy: ${maxEnemies}  (+/- to change, cap ${MAX_ENEMIES_CAP})`;
    }

    if (!started && titleEl) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('KAPLAY 弾幕STG started.');
}
