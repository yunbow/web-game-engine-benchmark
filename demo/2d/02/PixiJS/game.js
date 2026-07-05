/* =========================================================================
 * トップダウン・サバイバー — PixiJS v8 実装
 * 仕様: ../SPEC.md に厳密準拠
 *
 * 設計:
 *  - PixiJS v8 (await app.init(), app.canvas, 新Graphics API)
 *  - ループ/入力/当たり判定/カメラは自前
 *  - 敵・弾・gem はスプライト再利用プールで管理（数百体対応）
 *  - 画像は PIXI.Assets.load で ../assets/ から。欠落時は Graphics 図形フォールバック
 * ========================================================================= */

(async () => {
  'use strict';

  // ---- 定数（SPEC厳守） -------------------------------------------------
  const VIEW_W = 960;
  const VIEW_H = 540;

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

  // ---- Pixi 初期化（v8: await app.init） --------------------------------
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: 0x101018,
    antialias: false,
    autoDensity: false,
    resolution: 1,
  });
  document.getElementById('game-container').appendChild(app.canvas); // v8: app.canvas

  // ---- テクスチャ準備（読込 or フォールバック） -------------------------
  // assetNamesは ../assets/ 配下（SPEC名厳守）。失敗したら Graphics 生成。
  const textures = {};
  const assetSpec = {
    // 静止画(player.png 等)は廃止。walk のみ読込。非walkキーは walk 欠落時の図形フォールバック用。
    player:   { file: null,                fb: () => fbCircle(0xffffff, 24) },
    playerWalk: { file: 'player_walk.png', fb: () => null },
    bat:      { file: null,                fb: () => fbCircle(0x9b59ff, 16) },
    batWalk:  { file: 'enemy_bat_walk.png', fb: () => null },
    zombie:   { file: null,                fb: () => fbCircle(0x47d16a, 20) },
    zombieWalk: { file: 'enemy_zombie_walk.png', fb: () => null },
    proj:     { file: 'projectile.png',    fb: () => fbCircle(0xffe34d, 12) },
    gem:      { file: 'xp_gem.png',        fb: () => fbDiamond(0x4dd6ff, 16) },
    ground:   { file: 'ground_tile.png',   fb: () => fbGround(TILE_SIZE) },
  };

  function fbCircle(color, d) {
    const g = new PIXI.Graphics();
    const r = d / 2;
    g.circle(r, r, r).fill({ color }); // v8 新API
    g.circle(r, r, r).stroke({ color: 0x000000, alpha: 0.35, width: 2 });
    const tex = app.renderer.generateTexture(g);
    g.destroy();
    return tex;
  }
  function fbDiamond(color, d) {
    const g = new PIXI.Graphics();
    const r = d / 2;
    g.poly([r, 0, d, r, r, d, 0, r]).fill({ color });
    g.poly([r, 0, d, r, r, d, 0, r]).stroke({ color: 0xffffff, alpha: 0.5, width: 1.5 });
    const tex = app.renderer.generateTexture(g);
    g.destroy();
    return tex;
  }
  function fbGround(size) {
    const g = new PIXI.Graphics();
    g.rect(0, 0, size, size).fill({ color: 0x1b1b26 });
    g.rect(0, 0, size, size).stroke({ color: 0x262633, width: 2 });
    const tex = app.renderer.generateTexture(g);
    g.destroy();
    return tex;
  }

  // 個別に load を試みる（1枚欠けても他に影響させない）
  await Promise.all(Object.keys(assetSpec).map(async (key) => {
    const spec = assetSpec[key];
    if (!spec.file) { textures[key] = spec.fb(); return; } // file 無し = 図形フォールバックを直接使用
    try {
      const tex = await PIXI.Assets.load(`../assets/${spec.file}`);
      if (tex && tex.source) {
        textures[key] = tex;
        return;
      }
      textures[key] = spec.fb();
    } catch (e) {
      textures[key] = spec.fb();
    }
  }));

  function makeFrames(base, fw, fh) {
    if (!base || !base.source || !PIXI.Rectangle) return null;
    const frames = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        frames.push(new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(col * fw, row * fh, fw, fh) }));
      }
    }
    return frames;
  }
  const animFrames = {
    player: makeFrames(textures.playerWalk, 48, 48),
    bat: makeFrames(textures.batWalk, 32, 32),
    zombie: makeFrames(textures.zombieWalk, 40, 40),
  };

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
  function animTexture(key, moving, t, fallback, x = 0, y = 0) {
    const frames = animFrames[key];
    if (!frames) return fallback;
    const dir = moving ? dirFrame(x, y) : 0;
    const step = moving ? Math.floor(t * 10) % 4 : 0;
    return frames[dir * 4 + step] || fallback;
  }

  // ---- レイヤー構成 -----------------------------------------------------
  // world(カメラ追従) の下に: 地面 / gem / 敵 / 弾 / 自機
  const world = new PIXI.Container();
  app.stage.addChild(world);

  // 地面: TilingSprite で無限スクロール表現
  const ground = new PIXI.TilingSprite({
    texture: textures.ground,
    width: VIEW_W + TILE_SIZE * 2,
    height: VIEW_H + TILE_SIZE * 2,
  });
  // 地面は world ではなく stage 直下に置き、スクロールは tilePosition で表現
  app.stage.addChildAt(ground, 0);
  ground.x = -TILE_SIZE;
  ground.y = -TILE_SIZE;

  // 敵・弾・gem は大量(数百)になる。各レイヤーは Container で、
  // 個々のスプライトを再利用プール(下記 createPool)で使い回し、
  // 毎フレームの生成/破棄を完全に排して GC とドローコールを抑える。
  // (v8 の ParticleContainer は PIXI.Particle 専用で単一テクスチャ前提のため、
  //  bat/zombie/gem/proj と複数テクスチャを扱う本作ではプール方式を採用)
  const enemyLayerBat = new PIXI.Container();
  const enemyLayerZombie = new PIXI.Container();
  const gemLayer = new PIXI.Container();
  const projLayer = new PIXI.Container();
  world.addChild(gemLayer, enemyLayerZombie, enemyLayerBat, projLayer);

  // 自機スプライト
  const playerSprite = new PIXI.Sprite(textures.player);
  playerSprite.anchor.set(0.5);
  world.addChild(playerSprite);

  // ---- HUD --------------------------------------------------------------
  // HUD は他エンジンと同じく HTML オーバーレイ（#hud）。hint は #help に記載。
  const hudEl = document.getElementById('hud');

  // GAME OVER は HUD内に inline 表示（three.js と同様、別演出は持たない）。

  // ---- エンティティ・プール --------------------------------------------
  // 各エンティティはプレーンなオブジェクト + Sprite。非アクティブは alive=false で再利用。
  function createPool(layer) {
    return {
      layer,
      items: [],       // 全プール（再利用）
      free: [],        // 非アクティブな item のスタック（O(1)取得）
      aliveCount: 0,   // 生存数を逐次管理（毎フレームO(n)走査を回避）
      get() {
        let it = this.free.pop();
        if (!it) {
          const sprite = new PIXI.Sprite();
          sprite.anchor.set(0.5);
          this.layer.addChild(sprite);
          it = { sprite, alive: false };
          this.items.push(it);
        }
        it.alive = true;
        it.sprite.visible = true;
        this.aliveCount++;
        return it;
      },
      release(it) {
        if (!it.alive) return;
        it.alive = false;
        it.sprite.visible = false;
        this.free.push(it);
        this.aliveCount--;
      },
      releaseAll() {
        for (const it of this.items) {
          if (it.alive) { it.alive = false; it.sprite.visible = false; this.free.push(it); }
        }
        this.aliveCount = 0;
      },
      countAlive() { return this.aliveCount; },
    };
  }

  const batPool = createPool(enemyLayerBat);
  const zombiePool = createPool(enemyLayerZombie);
  const projPool = createPool(projLayer);
  const gemPool = createPool(gemLayer);

  // ---- タイトル/アトラクト状態（state とは別に保持＝リセットで消えない） ----
  const titleEl = document.getElementById('title');
  let started = false, blinkT = 0, autoT = 0;
  function startGame() {            // Enter でデモ→プレイ開始
    started = true;
    resetState();
    if (titleEl) titleEl.style.display = 'none';
  }

  // ---- ゲーム状態 -------------------------------------------------------
  let state;
  function resetState() {
    // 全プール解放
    [batPool, zombiePool, projPool, gemPool].forEach((p) => p.releaseAll());
    state = {
      player: { x: 0, y: 0, hp: PLAYER_HP_INIT, invuln: 0 },
      input: { up: false, down: false, left: false, right: false },
      fireTimer: 0,
      spawnCap: SPAWN_INIT,
      autoGrowTimer: 0,
      time: 0,
      kills: 0,
      over: false,
      // FPS 移動平均
      fpsSamples: [],
      fpsAvg: 0,
    };
  }
  resetState();

  // ---- 入力 -------------------------------------------------------------
  const keyMap = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
  };
  window.addEventListener('keydown', (e) => {
    if (keyMap[e.code]) { state.input[keyMap[e.code]] = true; e.preventDefault(); }
    // +/-（メインキー・テンキー両対応）
    if (e.key === '+' || e.code === 'NumpadAdd' || e.key === '=') {
      state.spawnCap = Math.min(SPAWN_MAX, state.spawnCap + SPAWN_STEP);
    }
    if (e.key === '-' || e.code === 'NumpadSubtract') {
      state.spawnCap = Math.max(SPAWN_MIN, state.spawnCap - SPAWN_STEP);
    }
    if (e.code === 'Enter' && !started) { startGame(); }
    if ((e.key === 'r' || e.key === 'R') && state.over) {
      resetState();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (keyMap[e.code]) { state.input[keyMap[e.code]] = false; e.preventDefault(); }
  });

  // ---- スポーン ---------------------------------------------------------
  function spawnEnemy() {
    const isZombie = Math.random() < 0.3; // 3割を大型
    const pool = isZombie ? zombiePool : batPool;
    const it = pool.get();
    it.sprite.texture = isZombie ? (animFrames.zombie?.[0] || textures.zombie) : (animFrames.bat?.[0] || textures.bat);

    // 自機周辺の画面外周からスポーン
    const side = Math.floor(Math.random() * 4);
    const px = state.player.x, py = state.player.y;
    const halfW = VIEW_W / 2 + SPAWN_MARGIN;
    const halfH = VIEW_H / 2 + SPAWN_MARGIN;
    let x, y;
    if (side === 0) { x = px - halfW; y = py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 1) { x = px + halfW; y = py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 2) { y = py - halfH; x = px + (Math.random() * 2 - 1) * halfW; }
    else { y = py + halfH; x = px + (Math.random() * 2 - 1) * halfW; }

    it.x = x; it.y = y;
    it.kind = isZombie ? 'zombie' : 'bat';
    it.hp = isZombie ? ZOMBIE_HP : BAT_HP;
    it.r = isZombie ? ZOMBIE_RADIUS : BAT_RADIUS;
    it.speed = ENEMY_SPEED_MIN + Math.random() * (ENEMY_SPEED_MAX - ENEMY_SPEED_MIN);
    it.pool = pool;
    it.sprite.x = x; it.sprite.y = y;
  }

  function dropGem(x, y) {
    const it = gemPool.get();
    it.sprite.texture = textures.gem;
    it.x = x; it.y = y;
    it.sprite.x = x; it.sprite.y = y;
  }

  function fireProjectile() {
    // 最も近い敵を探す
    let best = null, bestD2 = Infinity;
    const px = state.player.x, py = state.player.y;
    const pools = [batPool, zombiePool];
    for (const pool of pools) {
      for (const it of pool.items) {
        if (!it.alive) continue;
        const dx = it.x - px, dy = it.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = it; }
      }
    }
    if (!best) return;
    const dx = best.x - px, dy = best.y - py;
    const d = Math.hypot(dx, dy) || 1;
    const p = projPool.get();
    p.sprite.texture = textures.proj;
    p.x = px; p.y = py;
    p.vx = (dx / d) * PROJ_SPEED;
    p.vy = (dy / d) * PROJ_SPEED;
    p.life = PROJ_LIFETIME;
    p.sprite.x = px; p.sprite.y = py;
  }

  // ---- 更新ループ -------------------------------------------------------
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.05); // クランプ

    // FPS 移動平均（直近60サンプル）
    const fps = ticker.FPS;
    state.fpsSamples.push(fps);
    if (state.fpsSamples.length > 60) state.fpsSamples.shift();
    let s = 0;
    for (const v of state.fpsSamples) s += v;
    state.fpsAvg = s / state.fpsSamples.length;

    if (state.over && !started) resetState();   // アトラクト中の被弾死はデモをループ再開

    if (!state.over) {
      update(dt);
    }
    render();
    updateHUD();

    // アトラクト中はタイトルを点滅
    if (!started && titleEl) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  function update(dt) {
    const pl = state.player;
    const inp = state.input;

    // --- 自機移動（8方向, 正規化） ---
    let mx, my;
    if (!started) {
      // デモAI: 累積時間ベースの sin で緩やかに徘徊（決定的）
      autoT += dt;
      const phase = Math.floor(autoT / 1.25) % 4;
      if (phase === 0) mx = 1;
      else if (phase === 1) my = 1;
      else if (phase === 2) mx = -1;
      else my = -1;
    } else {
      mx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      my = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
    }
    const mv = cardinal(mx, my);
    if (mx !== 0 || my !== 0) {
      pl.x += mv.x * PLAYER_SPEED * dt;
      pl.y += mv.y * PLAYER_SPEED * dt;
    }
    pl.moving = mv.x !== 0 || mv.y !== 0;
    pl.dirX = mv.x; pl.dirY = mv.y;
    if (pl.invuln > 0) pl.invuln -= dt;

    // --- 時間 / 自動増加 ---
    state.time += dt;
    state.autoGrowTimer += dt;
    if (state.autoGrowTimer >= AUTO_GROW_INTERVAL) {
      state.autoGrowTimer -= AUTO_GROW_INTERVAL;
      state.spawnCap = Math.min(SPAWN_MAX, state.spawnCap + AUTO_GROW_AMOUNT);
    }

    // --- スポーン（cap まで補充） ---
    const aliveEnemies = batPool.countAlive() + zombiePool.countAlive();
    let toSpawn = state.spawnCap - aliveEnemies;
    // 1フレームのスポーン上限（爆発的spawnでフレーム落ちしないよう分散）
    toSpawn = Math.min(toSpawn, 40);
    for (let i = 0; i < toSpawn; i++) spawnEnemy();

    // --- 自動攻撃 ---
    state.fireTimer += dt;
    while (state.fireTimer >= FIRE_INTERVAL) {
      state.fireTimer -= FIRE_INTERVAL;
      fireProjectile();
    }

    // --- 敵更新（自機へ直進 + 接触判定） ---
    for (const pool of [batPool, zombiePool]) {
      for (const it of pool.items) {
        if (!it.alive) continue;
        const dx = pl.x - it.x, dy = pl.y - it.y;
        const d = Math.hypot(dx, dy) || 1;
        const ev = cardinal(dx, dy);
        it.x += ev.x * it.speed * dt;
        it.y += ev.y * it.speed * dt;
        it.moving = ev.x !== 0 || ev.y !== 0;
        it.dirX = ev.x; it.dirY = ev.y;

        // 自機接触
        const rr = it.r + PLAYER_RADIUS;
        if (d < rr && pl.invuln <= 0) {
          pl.hp -= 1;
          pl.invuln = PLAYER_INVULN;
          if (pl.hp <= 0) { pl.hp = 0; state.over = true; }
        }
      }
    }

    // --- 弾更新（移動 + 寿命 + 命中判定） ---
    for (const p of projPool.items) {
      if (!p.alive) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) { projPool.release(p); continue; }

      // 命中判定（全敵）
      let hit = false;
      for (const pool of [batPool, zombiePool]) {
        if (hit) break;
        for (const e of pool.items) {
          if (!e.alive) continue;
          const dx = e.x - p.x, dy = e.y - p.y;
          const rr = e.r + PROJ_RADIUS;
          if (dx * dx + dy * dy < rr * rr) {
            e.hp -= 1;
            if (e.hp <= 0) {
              dropGem(e.x, e.y);
              pool.release(e);
            }
            projPool.release(p);
            hit = true;
            break;
          }
        }
      }
    }

    // --- gem 取得判定 ---
    for (const g of gemPool.items) {
      if (!g.alive) continue;
      const dx = g.x - pl.x, dy = g.y - pl.y;
      const rr = GEM_RADIUS + PICKUP_RADIUS;
      if (dx * dx + dy * dy < rr * rr) {
        gemPool.release(g);
        state.kills += 1; // SPEC: gem取得→Killカウント
      }
    }
  }

  function render() {
    const pl = state.player;
    // カメラ: 自機が中央。world を平行移動。
    world.x = VIEW_W / 2 - pl.x;
    world.y = VIEW_H / 2 - pl.y;

    // 地面 TilingSprite のスクロール
    ground.tilePosition.x = -pl.x;
    ground.tilePosition.y = -pl.y;

    // 自機スプライト
    playerSprite.x = pl.x;
    playerSprite.y = pl.y;
    playerSprite.texture = animTexture('player', !!pl.moving, state.time, textures.player, pl.dirX, pl.dirY);
    playerSprite.alpha = (pl.invuln > 0 && Math.floor(state.time * 20) % 2 === 0) ? 0.4 : 1;

    // 全エンティティのスプライト位置同期
    syncPool(batPool);
    syncPool(zombiePool);
    syncPool(projPool);
    syncPool(gemPool);
  }

  function syncPool(pool) {
    for (const it of pool.items) {
      if (!it.alive) continue;
      it.sprite.x = it.x;
      it.sprite.y = it.y;
      it.sprite.texture = animTexture(it.kind, !!it.moving, state.time, it.kind === 'zombie' ? textures.zombie : textures.bat, it.dirX, it.dirY);
    }
  }

  function updateHUD() {
    const enemies = batPool.countAlive() + zombiePool.countAlive();
    const projC = projPool.countAlive();
    const gemC = gemPool.countAlive();
    const objects = enemies + projC + gemC;
    const hp = state.player.hp;
    // 表示内容・書式は three.js に統一
    hudEl.textContent =
      `FPS     : ${state.fpsAvg.toFixed(1)}\n` +
      `Enemies : ${enemies}  (cap ${state.spawnCap})\n` +
      `Objects : ${objects}  (ene ${enemies} / proj ${projC} / gem ${gemC})\n` +
      `Time    : ${state.time.toFixed(1)}s   Kills: ${state.kills}\n` +
      `HP      : ${(state.over && started) ? 'GAME OVER (R to restart)' : '♥'.repeat(hp) + ' (' + hp + ')'}`;
  }
})();
