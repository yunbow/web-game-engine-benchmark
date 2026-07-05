/* ============================================================================
 * トップダウン・サバイバー - KAPLAY 実装
 * 共通仕様 ../SPEC.md に厳密準拠。性能比較用。
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリ。以下はライブラリ機構を使う:
 *   - ゲームループ (onUpdate / dt())
 *   - 入力 (isKeyDown / onKeyPress)
 *   - スプライト/図形描画 (add([...comps]))
 *   - 座標系は Y 下向き・原点左上 = 画面座標とそのまま一致
 * 当たり判定は SPEC 準拠の「自前の円判定 (平方距離比較)」を使う
 * (KAPLAY の area() は AABB/多角形なので、他エンジンと条件を揃えるため不使用)。
 *
 * カメラ追従: 自機を概ね中央に置くため k.camPos(player) を毎フレーム設定。
 * 地面タイルは onDraw で自機周辺をモジュロでループ描画 (無限スクロール表現)。
 * 敵・弾・gem は数百規模になり得るため、生成/破棄を抑える自前配列 + rm() で管理。
 * ========================================================================== */

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

const PLAYER_SPEED = 180;          // px/s
const PLAYER_RADIUS = 18;          // 当たり半径(48px相当)
const PLAYER_HP_INIT = 5;
const PLAYER_INVULN = 0.5;         // s

const FIRE_INTERVAL = 0.4;         // 400ms
const PROJ_SPEED = 350;            // px/s
const PROJ_RADIUS = 8;
const PROJ_LIFETIME = 2.0;         // 一定時間で回収

const ENEMY_SPEED_MIN = 60;        // px/s
const ENEMY_SPEED_MAX = 90;        // px/s
const BAT_RADIUS = 12;             // 32px
const ZOMBIE_RADIUS = 16;          // 40px
const BAT_HP = 1;
const ZOMBIE_HP = 3;

const GEM_RADIUS = 8;
const PICKUP_RADIUS = 22;

const SPAWN_INIT = 150;            // 初期同時敵数
const SPAWN_STEP = 50;             // +/- 増減
const SPAWN_MAX = 1000;
const SPAWN_MIN = 0;
const AUTO_GROW_INTERVAL = 10;     // 10秒ごと
const AUTO_GROW_AMOUNT = 25;       // +25
const SPAWN_MARGIN = 60;           // 画面外周からのスポーン距離

const TILE_SIZE = 64;
const SPAWN_PER_FRAME = 40;        // 1フレームのスポーン上限(分散)

const ASSET_DEFS = {
  // 静止画は廃止。walk のみ使用し、欠落時は visual2() が図形フォールバックに落ちる。
  playerWalk: { url: '../assets/player_walk.png', opts: { sliceX: 4, sliceY: 4 } },
  batWalk: { url: '../assets/enemy_bat_walk.png', opts: { sliceX: 4, sliceY: 4 } },
  zombieWalk: { url: '../assets/enemy_zombie_walk.png', opts: { sliceX: 4, sliceY: 4 } },
  proj:   { url: '../assets/projectile.png' },
  gem:    { url: '../assets/xp_gem.png' },
  ground: { url: '../assets/ground_tile.png' },
};

const clampv = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: W, height: H,
  canvas: document.getElementById('game-canvas'),
  background: [16, 16, 24],
  crisp: true,
  global: false,            // 名前空間 k.* を明示利用 (グローバル汚染を避ける)
});

// === アセット読み込み (失敗してもフォールバックで起動) ======================
// loadSprite は失敗時に reject するので、個別に try/catch して有無を記録。
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, def]) => {
    try { await k.loadSprite(key, def.url, def.opts || {}); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${def.url} -> shape fallback`); }
  }));
  start();
})();

// スプライト or フォールバック図形のコンポーネント配列を返すヘルパ。
function visual(key, fallbackComps) {
  if (loaded[key]) return [k.sprite(key), k.anchor('center')];
  return fallbackComps;
}
function visual2(primary, secondary, fallbackComps) {
  if (loaded[primary]) return [k.sprite(primary, { frame: 0 }), k.anchor('center'), { animKey: primary, animT: 0 }];
  if (loaded[secondary]) return [k.sprite(secondary), k.anchor('center')];
  return fallbackComps;
}
function cardinal(mx, my) {
  if (mx === 0 && my === 0) return { x: 0, y: 0 };
  if (Math.abs(mx) >= Math.abs(my)) return { x: Math.sign(mx), y: 0 };
  return { x: 0, y: Math.sign(my) };
}
function dirFrame(x, y) {
  if (y < 0) return 1;
  if (x < 0) return 2;
  if (x > 0) return 3;
  return 0;
}
function stepAnim(obj, moving, dt, x = 0, y = 0) {
  if (!obj.animKey) return;
  obj.animT = moving ? obj.animT + dt : 0;
  obj.frame = (moving ? dirFrame(x, y) : 0) * 4 + (moving ? Math.floor(obj.animT * 10) % 4 : 0);
}

function start() {
  // --- 地面: フォールバック用タイルテクスチャ (画像が無い場合) ---
  // 自機追従でカメラが動くため、onDraw で自機周辺を覆うタイルをループ描画する。
  const groundColorA = k.rgb(27, 27, 38);
  const groundColorB = k.rgb(38, 38, 51);

  // --- 自機 ---
  const player = k.add([
    ...visual2('playerWalk', 'player', [k.circle(PLAYER_RADIUS), k.color(255, 255, 255), k.anchor('center')]),
    k.pos(0, 0),
    k.z(100),
    { hp: PLAYER_HP_INIT, invuln: 0 },
  ]);
  if (loaded.player) { player.width = 48; player.height = 48; }

  // --- エンティティ配列 (自前管理) ---
  const enemies = [], projectiles = [], gems = [];
  let kills = 0, spawnCap = SPAWN_INIT;
  let fireTimer = 0, autoGrowTimer = 0, time = 0;
  let over = false;
  let started = false, blinkT = 0, autoT = 0;   // タイトル/アトラクト状態
  const titleEl = document.getElementById('title');

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() { started = true; resetGame(); if (titleEl) titleEl.style.display = 'none'; }

  // --- 入力: 負荷調整 (+/-) / リスタート / 開始 ---
  k.onKeyPress(['=', 'kpadd'], () => { spawnCap = Math.min(SPAWN_MAX, spawnCap + SPAWN_STEP); });
  k.onKeyPress(['minus', 'kpsubtract'], () => { spawnCap = Math.max(SPAWN_MIN, spawnCap - SPAWN_STEP); });
  k.onKeyPress('enter', () => { if (!started) startGame(); });
  k.onKeyPress('r', () => { if (over) resetGame(); });

  function resetGame() {
    for (const e of enemies) k.destroy(e);
    for (const p of projectiles) k.destroy(p);
    for (const g of gems) k.destroy(g);
    enemies.length = 0; projectiles.length = 0; gems.length = 0;
    player.pos = k.vec2(0, 0);
    player.hp = PLAYER_HP_INIT; player.invuln = 0; player.opacity = 1;
    kills = 0; spawnCap = SPAWN_INIT;
    fireTimer = 0; autoGrowTimer = 0; time = 0;
    over = false;
  }

  function spawnEnemy() {
    const isZombie = k.rand() < 0.3; // 3割を大型
    const r = isZombie ? ZOMBIE_RADIUS : BAT_RADIUS;
    const key = isZombie ? 'zombie' : 'bat';
    const walkKey = isZombie ? 'zombieWalk' : 'batWalk';
    const fb = isZombie
      ? [k.circle(r), k.color(71, 209, 106), k.anchor('center')]
      : [k.circle(r), k.color(155, 89, 255), k.anchor('center')];

    // 自機周辺の画面外周からスポーン
    const side = Math.floor(k.rand() * 4);
    const px = player.pos.x, py = player.pos.y;
    const halfW = W / 2 + SPAWN_MARGIN;
    const halfH = H / 2 + SPAWN_MARGIN;
    let x, y;
    if (side === 0) { x = px - halfW; y = py + (k.rand() * 2 - 1) * halfH; }
    else if (side === 1) { x = px + halfW; y = py + (k.rand() * 2 - 1) * halfH; }
    else if (side === 2) { y = py - halfH; x = px + (k.rand() * 2 - 1) * halfW; }
    else { y = py + halfH; x = px + (k.rand() * 2 - 1) * halfW; }

    const e = k.add([...visual2(walkKey, key, fb), k.pos(x, y), k.z(20),
      { kind: key, hp: isZombie ? ZOMBIE_HP : BAT_HP, r,
        speed: ENEMY_SPEED_MIN + k.rand() * (ENEMY_SPEED_MAX - ENEMY_SPEED_MIN) }]);
    if (loaded[key]) { const s = isZombie ? 40 : 32; e.width = s; e.height = s; }
    enemies.push(e);
  }

  function dropGem(x, y) {
    const g = k.add([...visual('gem', [k.circle(GEM_RADIUS), k.color(77, 214, 255), k.anchor('center')]),
      k.pos(x, y), k.z(10), {}]);
    if (loaded.gem) { g.width = 16; g.height = 16; }
    gems.push(g);
  }

  function fireProjectile() {
    // 最も近い敵を探す
    let best = null, bestD2 = Infinity;
    const px = player.pos.x, py = player.pos.y;
    for (const e of enemies) {
      const dx = e.pos.x - px, dy = e.pos.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    if (!best) return;
    const dx = best.pos.x - px, dy = best.pos.y - py;
    const d = Math.hypot(dx, dy) || 1;
    const p = k.add([...visual('proj', [k.circle(PROJ_RADIUS), k.color(255, 227, 77), k.anchor('center')]),
      k.pos(px, py), k.z(50),
      { vx: (dx / d) * PROJ_SPEED, vy: (dy / d) * PROJ_SPEED, life: PROJ_LIFETIME }]);
    if (loaded.proj) { p.width = 24; p.height = 24; }
    projectiles.push(p);
  }

  function rm(arr, i) { k.destroy(arr[i]); arr[i] = arr[arr.length - 1]; arr.pop(); }

  // --- 地面タイル描画 (カメラ追従の無限スクロール) ---
  k.onDraw(() => {
    const px = player.pos.x, py = player.pos.y;
    // 画面が覆う範囲をタイル境界に拡張して市松/グリッド描画
    const left = px - W / 2 - TILE_SIZE, right = px + W / 2 + TILE_SIZE;
    const topY = py - H / 2 - TILE_SIZE, botY = py + H / 2 + TILE_SIZE;
    const startTX = Math.floor(left / TILE_SIZE), endTX = Math.ceil(right / TILE_SIZE);
    const startTY = Math.floor(topY / TILE_SIZE), endTY = Math.ceil(botY / TILE_SIZE);
    for (let tx = startTX; tx <= endTX; tx++) {
      for (let ty = startTY; ty <= endTY; ty++) {
        const wx = tx * TILE_SIZE, wy = ty * TILE_SIZE;
        if (loaded.ground) {
          k.drawSprite({ sprite: 'ground', pos: k.vec2(wx, wy), width: TILE_SIZE, height: TILE_SIZE, anchor: 'topleft' });
        } else {
          const col = ((tx + ty) & 1) === 0 ? groundColorA : groundColorB;
          k.drawRect({ pos: k.vec2(wx, wy), width: TILE_SIZE, height: TILE_SIZE, color: col });
        }
      }
    }
  });

  // --- FPS 移動平均 + HUD ---
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;

  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05); // クランプ
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // カメラ追従 (自機が中央)
    k.camPos(player.pos);

    if (over && !started) resetGame();   // アトラクト中の被弾死はデモをループ再開

    if (!over) {
      // --- 自機移動 (8方向, 正規化) ---
      let mx = 0, my = 0;
      if (!started) {
        // デモAI: 累積時間ベースの sin で緩やかに徘徊（決定的）
        autoT += dt;
        const phase = Math.floor(autoT / 1.25) % 4;
        if (phase === 0) mx = 1;
        else if (phase === 1) my = 1;
        else if (phase === 2) mx = -1;
        else my = -1;
      } else {
        if (k.isKeyDown('left') || k.isKeyDown('a')) mx -= 1;
        if (k.isKeyDown('right') || k.isKeyDown('d')) mx += 1;
        if (k.isKeyDown('up') || k.isKeyDown('w')) my -= 1;
        if (k.isKeyDown('down') || k.isKeyDown('s')) my += 1;
      }
      const mv = cardinal(mx, my);
      if (mx !== 0 || my !== 0) {
        player.pos.x += mv.x * PLAYER_SPEED * dt;
        player.pos.y += mv.y * PLAYER_SPEED * dt;
      }
      stepAnim(player, mv.x !== 0 || mv.y !== 0, dt, mv.x, mv.y);
      if (player.invuln > 0) {
        player.invuln -= dt;
        player.opacity = (Math.floor(time * 20) % 2 === 0) ? 0.4 : 1;
        if (player.invuln <= 0) player.opacity = 1;
      }

      // --- 時間 / 自動増加 ---
      time += dt;
      autoGrowTimer += dt;
      if (autoGrowTimer >= AUTO_GROW_INTERVAL) {
        autoGrowTimer -= AUTO_GROW_INTERVAL;
        spawnCap = Math.min(SPAWN_MAX, spawnCap + AUTO_GROW_AMOUNT);
      }

      // --- スポーン (cap まで補充, 1フレーム上限で分散) ---
      let toSpawn = Math.min(spawnCap - enemies.length, SPAWN_PER_FRAME);
      for (let i = 0; i < toSpawn; i++) spawnEnemy();

      // --- 自動攻撃 ---
      fireTimer += dt;
      while (fireTimer >= FIRE_INTERVAL) {
        fireTimer -= FIRE_INTERVAL;
        fireProjectile();
      }

      // --- 敵更新 (自機へ直進 + 接触判定) ---
      const px = player.pos.x, py = player.pos.y;
      for (const e of enemies) {
        const dx = px - e.pos.x, dy = py - e.pos.y;
        const d = Math.hypot(dx, dy) || 1;
        const ev = cardinal(dx, dy);
        e.pos.x += ev.x * e.speed * dt;
        e.pos.y += ev.y * e.speed * dt;
        stepAnim(e, ev.x !== 0 || ev.y !== 0, dt, ev.x, ev.y);
        const rr = e.r + PLAYER_RADIUS;
        if (d < rr && player.invuln <= 0) {
          player.hp -= 1;
          player.invuln = PLAYER_INVULN;
          if (player.hp <= 0) { player.hp = 0; over = true; }
        }
      }

      // --- 弾更新 (移動 + 寿命 + 命中判定) ---
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.pos.x += p.vx * dt; p.pos.y += p.vy * dt;
        p.life -= dt;
        if (p.life <= 0) { rm(projectiles, i); continue; }
        let hit = false;
        for (let j = enemies.length - 1; j >= 0; j--) {
          const e = enemies[j];
          const dx = e.pos.x - p.pos.x, dy = e.pos.y - p.pos.y;
          const rr = e.r + PROJ_RADIUS;
          if (dx * dx + dy * dy < rr * rr) {
            e.hp -= 1;
            if (e.hp <= 0) { dropGem(e.pos.x, e.pos.y); rm(enemies, j); }
            hit = true; break;
          }
        }
        if (hit) rm(projectiles, i);
      }

      // --- gem 取得判定 ---
      for (let i = gems.length - 1; i >= 0; i--) {
        const g = gems[i];
        const dx = g.pos.x - px, dy = g.pos.y - py;
        const rr = GEM_RADIUS + PICKUP_RADIUS;
        if (dx * dx + dy * dy < rr * rr) {
          rm(gems, i);
          kills += 1; // SPEC: gem取得→Killカウント
        }
      }
    }

    // --- HUD ---
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const objects = enemies.length + projectiles.length + gems.length;
      hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Enemies : ${enemies.length}  (cap ${spawnCap})\n` +
        `Objects : ${objects}  (ene ${enemies.length} / proj ${projectiles.length} / gem ${gems.length})\n` +
        `Time    : ${time.toFixed(1)}s   Kills: ${kills}\n` +
        `HP      : ${(over && started) ? 'GAME OVER (R to restart)' : '♥'.repeat(player.hp) + ' (' + player.hp + ')'}`;
    }

    // アトラクト中はタイトルを点滅
    if (!started && titleEl) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  console.log('KAPLAY トップダウン・サバイバー started.');
}
