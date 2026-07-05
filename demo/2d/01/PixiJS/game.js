/* ============================================================================
 * 弾幕STG (縦スクロールSTG) - PixiJS v8 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * PixiJS は描画ライブラリなので、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker のデルタタイムを利用)
 *   - キーボード入力
 *   - 円判定の当たり判定
 *   - スポーン / プール管理
 * ========================================================================== */

// ---- 定数 (SPEC) -----------------------------------------------------------
const W = 960;
const H = 540;

const PLAYER_SPEED = 300;          // 自機移動速度 px/s (8方向)
const PLAYER_BULLET_SPEED = 600;   // 自機弾速 px/s (上方向)
const FIRE_INTERVAL = 150;         // 連射間隔 ms
const ENEMY_SPEED_MIN = 80;        // 敵落下 px/s
const ENEMY_SPEED_MAX = 140;
const ENEMY_BULLET_SPEED = 200;    // 敵弾速 px/s
const ENEMY_FIRE_MIN = 900;        // 敵発射間隔 ms (個体ごとランダム)
const ENEMY_FIRE_MAX = 2200;
const INITIAL_MAX_ENEMIES = 40;    // 初期最大同時敵数
const MAX_ENEMIES_CAP = 300;       // 上限
const ENEMY_STEP = 10;             // +/- の増減
const INITIAL_HP = 3;
const SCORE_PER_KILL = 10;
const EXPLOSION_LIFE = 250;        // 爆発エフェクト表示時間 ms

// 当たり判定半径 (円判定)
const R_PLAYER = 16;
const R_PLAYER_BULLET = 6;
const R_ENEMY_SMALL = 18;
const R_ENEMY_BIG = 40;
const R_ENEMY_BULLET = 7;

// アセット (SPEC のファイル名に厳密一致)。../assets/ から読む。
const ASSET_DEFS = {
  player_ship:  '../assets/player_ship.png',
  enemy_small:  '../assets/enemy_small.png',
  enemy_big:    '../assets/enemy_big.png',
  bullet_player:'../assets/bullet_player.png',
  bullet_enemy: '../assets/bullet_enemy.png',
  explosion:    '../assets/explosion.png',
  bg_space:     '../assets/bg_space.png',
};

// ---- ユーティリティ --------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

(async function main() {
  // === Pixi v8 初期化 (新API: new Application() してから await app.init()) ===
  const app = new PIXI.Application();
  await app.init({
    width: W,
    height: H,
    background: '#05060f',
    antialias: true,
    // 性能比較用途のため自動DPRスケールは抑制 (1固定)
    resolution: 1,
    autoDensity: false,
  });
  document.getElementById('game-container').appendChild(app.canvas);

  // === アセット読み込み (失敗してもフォールバックで起動) ===================
  // 個別に try/catch して、無いものだけフォールバックにする。
  const textures = {};
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      textures[key] = await PIXI.Assets.load(url);
    } catch (e) {
      textures[key] = null; // フォールバック対象
      console.warn(`[asset] load failed: ${url} -> Graphics fallback`);
    }
  }));

  // フォールバック用 Graphics をテクスチャ化するヘルパ。
  // 同色図形を一度だけ生成して再利用 (Sprite 化で大量描画に耐える)。
  const fallbackCache = {};
  function makeFallbackTexture(name, drawFn, w, h) {
    if (fallbackCache[name]) return fallbackCache[name];
    const g = new PIXI.Graphics();
    drawFn(g);
    const tex = app.renderer.generateTexture({ target: g, width: w, height: h });
    g.destroy();
    fallbackCache[name] = tex;
    return tex;
  }

  // 各エンティティのテクスチャを決定 (画像 or フォールバック単色図形)。
  function texPlayer() {
    if (textures.player_ship) return textures.player_ship;
    // 水色三角 (上向き)
    return makeFallbackTexture('player', g => {
      g.moveTo(32, 2).lineTo(60, 60).lineTo(4, 60).closePath().fill(0x55e0ff);
    }, 64, 64);
  }
  function texEnemySmall() {
    if (textures.enemy_small) return textures.enemy_small;
    return makeFallbackTexture('enemy_small', g => {
      g.circle(24, 24, 22).fill(0xff5050);
    }, 48, 48);
  }
  function texEnemyBig() {
    if (textures.enemy_big) return textures.enemy_big;
    return makeFallbackTexture('enemy_big', g => {
      g.circle(48, 48, 44).fill(0xff3070).circle(48, 48, 22).fill(0xaa0030);
    }, 96, 96);
  }
  function texPlayerBullet() {
    if (textures.bullet_player) return textures.bullet_player;
    return makeFallbackTexture('pbullet', g => {
      g.roundRect(2, 0, 12, 24, 6).fill(0xffe24d);
    }, 16, 24);
  }
  function texEnemyBullet() {
    if (textures.bullet_enemy) return textures.bullet_enemy;
    return makeFallbackTexture('ebullet', g => {
      g.circle(8, 8, 7).fill(0xff9020);
    }, 16, 16);
  }
  function texExplosion() {
    if (textures.explosion) return textures.explosion;
    return makeFallbackTexture('explosion', g => {
      g.circle(32, 32, 30).fill(0xffcc33).circle(32, 32, 16).fill(0xffffff);
    }, 64, 64);
  }

  // === 背景 (縦タイル or 単色) ============================================
  const stage = app.stage;
  let bg;
  if (textures.bg_space) {
    bg = new PIXI.TilingSprite({ texture: textures.bg_space, width: W, height: H });
    stage.addChild(bg);
  } else {
    // フォールバック: 星を散らした暗色背景
    const starG = new PIXI.Graphics();
    for (let i = 0; i < 160; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      const r = Math.random() * 1.5 + 0.3;
      starG.circle(x, y, r).fill({ color: 0xffffff, alpha: Math.random() * 0.7 + 0.2 });
    }
    stage.addChild(starG);
    bg = null; // スクロールは別途 starfield で扱う
  }
  // 背景スクロール用の追加スターレイヤ (フォールバック時も雰囲気を出す)
  const starLayer = new PIXI.Graphics();
  const stars = [];
  for (let i = 0; i < 120; i++) {
    stars.push({ x: Math.random() * W, y: Math.random() * H, spd: rand(40, 120), r: rand(0.5, 1.8) });
  }
  stage.addChild(starLayer);

  // 描画コンテナ (重ね順)
  const enemyLayer = new PIXI.Container();
  const bulletLayer = new PIXI.Container();
  const fxLayer = new PIXI.Container();
  const playerLayer = new PIXI.Container();
  stage.addChild(enemyLayer, bulletLayer, fxLayer, playerLayer);

  // === エンティティ管理 (シンプルな配列 + Sprite) ========================
  // 弾・敵は大量になるため、各要素は { sprite, ...state } を持つ。

  // 自機
  const player = {
    sprite: new PIXI.Sprite(texPlayer()),
    x: W / 2, y: H - 70,
    hp: INITIAL_HP,
    alive: true,
    invul: 0, // 無敵時間 ms (被弾後の点滅)
  };
  player.sprite.anchor.set(0.5);
  player.sprite.width = 48;
  player.sprite.height = 48;
  playerLayer.addChild(player.sprite);

  const playerBullets = []; // {sprite,x,y}
  const enemies = [];       // {sprite,x,y,vx,vy,big,r,hp,fireTimer}
  const enemyBullets = [];  // {sprite,x,y,vx,vy}
  const effects = [];       // {sprite,life}

  // === タイトル/アトラクト状態 ============================================
  // started=false … デモ/アトラクト中。プレイヤー操作無効、デモAIが自機を動かす。
  // started=true  … 通常プレイ。Enter で開始。
  let started = false, blinkT = 0, autoT = 0;
  const titleEl = document.getElementById('title');

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    score = 0; maxEnemies = INITIAL_MAX_ENEMIES;
    player.hp = INITIAL_HP; player.alive = true; player.invul = 0;
    player.x = W / 2; player.y = H - 70;
    player.sprite.x = player.x; player.sprite.y = player.y;
    player.sprite.alpha = 1;
    for (let i = enemies.length - 1; i >= 0; i--) removeAt(enemies, i);
    for (let i = playerBullets.length - 1; i >= 0; i--) removeAt(playerBullets, i);
    for (let i = enemyBullets.length - 1; i >= 0; i--) removeAt(enemyBullets, i);
    for (let i = effects.length - 1; i >= 0; i--) removeAt(effects, i);
    if (titleEl) titleEl.style.display = 'none';
  }

  // === 入力 (自前) ========================================================
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Enter でデモ→プレイ開始
    if (e.key === 'Enter' && !started) startGame();
    // 最大敵数調整 (+/-) : テンキー含む各種コードに対応
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      maxEnemies = Math.min(MAX_ENEMIES_CAP, maxEnemies + ENEMY_STEP);
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      maxEnemies = Math.max(0, maxEnemies - ENEMY_STEP);
      e.preventDefault();
    }
    // スクロール抑制 (矢印/スペース)
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...codes) => codes.some(c => keys[c]);

  // === ゲーム状態 =========================================================
  let score = 0;
  let maxEnemies = INITIAL_MAX_ENEMIES;
  let fireTimer = 0;       // 自機連射タイマ ms
  let spawnAccumulator = 0;

  // === スポーン ===========================================================
  function spawnEnemy() {
    const big = Math.random() < 0.18; // 一部を大型に
    const tex = big ? texEnemyBig() : texEnemySmall();
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.width = big ? 80 : 40;
    sp.height = big ? 80 : 40;
    const e = {
      sprite: sp,
      x: rand(40, W - 40),
      y: -40,
      vx: rand(-30, 30),
      vy: rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX),
      big,
      r: big ? R_ENEMY_BIG : R_ENEMY_SMALL,
      hp: big ? 3 : 1,
      fireTimer: rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX),
    };
    sp.x = e.x; sp.y = e.y;
    enemyLayer.addChild(sp);
    enemies.push(e);
  }

  function firePlayer() {
    const sp = new PIXI.Sprite(texPlayerBullet());
    sp.anchor.set(0.5);
    sp.width = 12; sp.height = 22;
    sp.x = player.x; sp.y = player.y - 24;
    bulletLayer.addChild(sp);
    playerBullets.push({ sprite: sp, x: player.x, y: player.y - 24 });
  }

  function fireEnemy(e) {
    // 自機方向へ
    const dx = player.x - e.x, dy = player.y - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const sp = new PIXI.Sprite(texEnemyBullet());
    sp.anchor.set(0.5);
    sp.width = 14; sp.height = 14;
    sp.x = e.x; sp.y = e.y;
    bulletLayer.addChild(sp);
    enemyBullets.push({
      sprite: sp, x: e.x, y: e.y,
      vx: (dx / len) * ENEMY_BULLET_SPEED,
      vy: (dy / len) * ENEMY_BULLET_SPEED,
    });
  }

  function spawnExplosion(x, y, big) {
    const sp = new PIXI.Sprite(texExplosion());
    sp.anchor.set(0.5);
    const s = big ? 80 : 48;
    sp.width = s; sp.height = s;
    sp.x = x; sp.y = y;
    fxLayer.addChild(sp);
    effects.push({ sprite: sp, life: EXPLOSION_LIFE, max: EXPLOSION_LIFE });
  }

  // 配列から要素を除去し sprite を破棄
  function removeAt(arr, i) {
    const o = arr[i];
    o.sprite.destroy();
    arr[i] = arr[arr.length - 1];
    arr.pop();
  }

  // === FPS 移動平均 =======================================================
  const fpsSamples = [];
  let fpsAvg = 0;
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;

  // === メインループ (デルタタイム基準) ===================================
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;       // 経過 ms
    const dt = dtMs / 1000;            // 秒

    // --- FPS 移動平均 (直近60フレーム) ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // --- 背景スクロール ---
    if (bg) bg.tilePosition.y += 60 * dt;
    starLayer.clear();
    for (const s of stars) {
      s.y += s.spd * dt;
      if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
      starLayer.circle(s.x, s.y, s.r).fill({ color: 0x9fb8ff, alpha: 0.6 });
    }

    // --- 自機移動 (8方向 + クランプ) ---
    if (player.alive) {
      let mx = 0, my = 0;
      if (!started) {
        // デモAI: 累積時間の sin で緩やかに左右＋上下移動 (決定的・Math.random不使用)
        autoT += dt;
        mx = Math.cos(autoT * 0.8);
        my = 0;
      } else {
        if (down('ArrowLeft', 'KeyA')) mx -= 1;
        if (down('ArrowRight', 'KeyD')) mx += 1;
        if (down('ArrowUp', 'KeyW')) my -= 1;
        if (down('ArrowDown', 'KeyS')) my += 1;
      }
      if (mx !== 0 && my !== 0) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
      player.x = clamp(player.x + mx * PLAYER_SPEED * dt, 24, W - 24);
      player.y = clamp(player.y + my * PLAYER_SPEED * dt, 24, H - 24);
      player.sprite.x = player.x;
      player.sprite.y = player.y;

      // 無敵点滅
      if (player.invul > 0) {
        player.invul -= dtMs;
        player.sprite.alpha = (Math.floor(player.invul / 60) % 2 === 0) ? 0.35 : 1;
        if (player.invul <= 0) player.sprite.alpha = 1;
      }

      // --- 自機オート連射 ---
      fireTimer -= dtMs;
      if (fireTimer <= 0) {
        firePlayer();
        fireTimer += FIRE_INTERVAL;
        if (fireTimer < 0) fireTimer = 0;
      }
    }

    // --- 敵スポーン (最大数まで補充) ---
    spawnAccumulator += dtMs;
    // 一定リズム (約 80ms ごとに1体判定) で最大数へ向けて補充
    while (spawnAccumulator >= 80) {
      spawnAccumulator -= 80;
      if (enemies.length < maxEnemies) spawnEnemy();
    }

    // --- 自機弾更新 ---
    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i];
      b.y -= PLAYER_BULLET_SPEED * dt;
      b.sprite.y = b.y;
      if (b.y < -30) removeAt(playerBullets, i);
    }

    // --- 敵更新 + 敵弾発射 ---
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      // 左右の壁で反射気味に
      if (e.x < 24 && e.vx < 0) e.vx = -e.vx;
      if (e.x > W - 24 && e.vx > 0) e.vx = -e.vx;
      e.sprite.x = e.x;
      e.sprite.y = e.y;
      if (e.y > H + 50) { removeAt(enemies, i); continue; }
      // 発射
      e.fireTimer -= dtMs;
      if (e.fireTimer <= 0 && player.alive && e.y > 0) {
        fireEnemy(e);
        e.fireTimer = rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX);
      }
    }

    // --- 敵弾更新 ---
    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.sprite.x = b.x;
      b.sprite.y = b.y;
      if (b.x < -30 || b.x > W + 30 || b.y < -30 || b.y > H + 30) removeAt(enemyBullets, i);
    }

    // --- 当たり判定 (円判定) ---
    // 自機弾 × 敵
    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i];
      let hit = false;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        const dx = b.x - e.x, dy = b.y - e.y;
        const rr = (R_PLAYER_BULLET + e.r);
        if (dx * dx + dy * dy <= rr * rr) {
          e.hp -= 1;
          hit = true;
          if (e.hp <= 0) {
            spawnExplosion(e.x, e.y, e.big);
            removeAt(enemies, j);
            score += SCORE_PER_KILL;
          }
          break;
        }
      }
      if (hit) removeAt(playerBullets, i);
    }

    // 敵弾 × 自機
    if (player.alive && player.invul <= 0) {
      for (let i = enemyBullets.length - 1; i >= 0; i--) {
        const b = enemyBullets[i];
        const dx = b.x - player.x, dy = b.y - player.y;
        const rr = (R_ENEMY_BULLET + R_PLAYER);
        if (dx * dx + dy * dy <= rr * rr) {
          removeAt(enemyBullets, i);
          hurtPlayer();
          break;
        }
      }
    }

    // 敵 × 自機
    if (player.alive && player.invul <= 0) {
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j];
        const dx = e.x - player.x, dy = e.y - player.y;
        const rr = (e.r + R_PLAYER);
        if (dx * dx + dy * dy <= rr * rr) {
          spawnExplosion(e.x, e.y, e.big);
          removeAt(enemies, j);
          hurtPlayer();
          break;
        }
      }
    }

    // --- エフェクト更新 ---
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      f.life -= dtMs;
      const t = f.life / f.max;
      f.sprite.alpha = clamp(t, 0, 1);
      f.sprite.scale.set((1 - t) * 0.5 + 1); // 少し膨らむ
      if (f.life <= 0) removeAt(effects, i);
    }

    // --- HUD 更新 (4フレームに1回程度) ---
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const objects = playerBullets.length + enemyBullets.length + enemies.length + effects.length;
      hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Objects : ${objects}  (bul ${playerBullets.length + enemyBullets.length} / ene ${enemies.length} / fx ${effects.length})\n` +
        `Score   : ${score}\n` +
        `HP      : ${player.alive ? '♥'.repeat(player.hp) + ' (' + player.hp + ')' : 'GAME OVER'}\n` +
        `MaxEnemy: ${maxEnemies}  (+/- to change, cap ${MAX_ENEMIES_CAP})`;
    }

    // --- タイトル点滅 (約0.45秒周期) ---
    if (!started && titleEl) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  function hurtPlayer() {
    player.hp -= 1;
    if (player.hp <= 0) {
      player.hp = 0;
      player.alive = false;
      player.sprite.alpha = 0.15;
      spawnExplosion(player.x, player.y, true);
      // 一定後に復活 (性能比較を継続できるよう自動リスポーン)
      setTimeout(() => {
        player.hp = INITIAL_HP;
        player.alive = true;
        player.x = W / 2; player.y = H - 70;
        player.sprite.x = player.x; player.sprite.y = player.y;
        player.invul = 1500;
      }, 1500);
    } else {
      player.invul = 1500; // 被弾後の無敵
    }
  }

  console.log('PixiJS 弾幕STG started. renderer:', app.renderer.type === PIXI.RendererType.WEBGPU ? 'WebGPU' : 'WebGL/Canvas');
})();
