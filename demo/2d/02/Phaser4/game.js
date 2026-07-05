/* =========================================================================
 * トップダウン・サバイバー — Phaser 4 実装
 * 仕様(SPEC.md)厳密準拠 + 大量エンティティ向けオブジェクトプール化
 * =========================================================================
 *
 * 主要数値（SPEC準拠）:
 *   画面            : 960 x 540 固定 / カメラ自機追従
 *   自機移動         : 180 px/s (8方向)
 *   オート攻撃       : 400ms ごと最近接敵へ発射 / 弾速 350 px/s / 命中で敵HP-1
 *   敵速度          : 60〜90 px/s
 *   敵HP            : 1(小=bat) / 3(大=zombie)
 *   接触ダメージ     : 自機HP-1 / 無敵 0.5s
 *   自機HP          : 初期5 / 0でGAME OVER(Rでリスタート)
 *   同時敵数         : 初期150 / +/- で±50 / 上限1000 / 10秒ごと自動+25
 *   ドロップ         : 撃破でxp_gem / 接触取得でKill+1
 *
 * フォールバック: 画像欠落時は単色図形テクスチャを動的生成して必ず起動。
 *   player=白丸 / bat=紫丸 / zombie=緑丸 / 弾=黄丸 / gem=水色菱形 / ground=暗色タイル
 * ========================================================================= */

(function () {
  "use strict";

  // ----------------------------- 定数 ------------------------------------
  const GAME_W = 960;
  const GAME_H = 540;

  const PLAYER_SPEED = 180;
  const PLAYER_HP_MAX = 5;
  const PLAYER_INVULN = 0.5;          // 無敵秒数
  const PLAYER_RADIUS = 18;           // 当たり判定半径(円)

  const FIRE_INTERVAL = 400;          // ms
  const PROJECTILE_SPEED = 350;
  const PROJECTILE_RADIUS = 8;
  const PROJECTILE_LIFETIME = 2.5;    // s (画面外保険)
  const TARGET_RANGE = 600;           // 索敵半径(px) 範囲外なら撃たない

  const ENEMY_SPEED_MIN = 60;
  const ENEMY_SPEED_MAX = 90;
  const ENEMY_CONTACT_RADIUS = 16;

  const BAT_HP = 1;
  const BAT_RADIUS = 12;
  const ZOMBIE_HP = 3;
  const ZOMBIE_RADIUS = 16;

  const GEM_RADIUS = 12;              // 取得判定はやや甘め
  const GEM_LIFETIME = 30;           // s

  const SPAWN_INITIAL = 150;
  const SPAWN_STEP = 50;             // +/- 調整単位
  const SPAWN_MAX = 1000;            // 上限
  const SPAWN_MIN = 0;
  const SPAWN_AUTO_INTERVAL = 10;    // s
  const SPAWN_AUTO_AMOUNT = 25;
  const SPAWN_MARGIN = 60;           // 画面外周からの距離

  const SPAWN_PER_FRAME = 6;         // 1フレームの最大スポーン数(スパイク抑制)

  // プール上限(安全側)。同時敵上限1000 + 余裕。
  const ENEMY_POOL = 1100;
  const PROJ_POOL = 256;
  const GEM_POOL = 1200;

  // ----------------------- テクスチャ・フォールバック ---------------------
  // 画像ファイル名はSPECに厳密一致。../assets/ から読込。
  const ASSET_DIR = "../assets/";
  // 静止画(player.png 等)は廃止。表示は walk スプライトシートのみ使用。
  const ASSETS = {
    projectile: "projectile.png",
    xp_gem: "xp_gem.png",
    ground_tile: "ground_tile.png",
  };

  // フォールバック用に「読み込めたか」を記録
  const loaded = {};

  // タイトル/アトラクト状態（scene.restart をまたいで保持するためモジュールスコープ）
  let started = false;
  const titleEl = document.getElementById("title");

  // ============================ Boot Scene ===============================
  // 画像を試行読込し、失敗(欠落)を検知してフォールバックテクスチャを生成。
  class BootScene extends Phaser.Scene {
    constructor() { super("Boot"); }

    preload() {
      // 読込失敗イベントを捕捉(欠落キーを記録)
      this.load.on("loaderror", (file) => {
        loaded[file.key] = false;
      });
      this.load.on("filecomplete", (key) => {
        loaded[key] = true;
      });

      for (const key in ASSETS) {
        this.load.image(key, ASSET_DIR + ASSETS[key]);
      }
      this.load.spritesheet("player_walk", ASSET_DIR + "player_walk.png", { frameWidth: 48, frameHeight: 48 });
      this.load.spritesheet("enemy_bat_walk", ASSET_DIR + "enemy_bat_walk.png", { frameWidth: 32, frameHeight: 32 });
      this.load.spritesheet("enemy_zombie_walk", ASSET_DIR + "enemy_zombie_walk.png", { frameWidth: 40, frameHeight: 40 });
    }

    create() {
      // 欠落キーに対し単色図形テクスチャを生成
      this.makeFallbacks();
      this.scene.start("Game");
    }

    makeFallbacks() {
      const ensure = (key, drawFn, w, h) => {
        if (this.textures.exists(key) && loaded[key]) return; // 実画像あり
        if (this.textures.exists(key)) this.textures.remove(key);
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        drawFn(g);
        g.generateTexture(key, w, h);
        g.destroy();
      };

      // 自機/敵は walk スプライトシートのみ使用するため、非walkの図形フォールバックは不要。
      // 弾=黄丸 24x24
      ensure("projectile", (g) => {
        g.fillStyle(0xffe048, 1).fillCircle(12, 12, 7);
        g.lineStyle(2, 0xffffff, 0.8).strokeCircle(12, 12, 7);
      }, 24, 24);

      // gem=水色菱形 16x16
      ensure("xp_gem", (g) => {
        g.fillStyle(0x40e0ff, 1);
        g.beginPath();
        g.moveTo(8, 0); g.lineTo(16, 8); g.lineTo(8, 16); g.lineTo(0, 8);
        g.closePath(); g.fillPath();
      }, 16, 16);

      // ground=暗色タイル 64x64
      ensure("ground_tile", (g) => {
        g.fillStyle(0x1c1c28, 1).fillRect(0, 0, 64, 64);
        g.lineStyle(1, 0x2a2a3a, 1).strokeRect(0, 0, 64, 64);
        g.fillStyle(0x242436, 1).fillRect(2, 2, 6, 6);
      }, 64, 64);
    }
  }

  // ============================ Game Scene ===============================
  class GameScene extends Phaser.Scene {
    constructor() { super("Game"); }

    create() {
      this.gameOver = false;

      // --- 背景(地面タイル) : 無限スクロール扱い ---
      // TileSpriteを画面サイズ分だけ作り、スクロール量を tilePosition で擬似無限化
      this.ground = this.add.tileSprite(0, 0, GAME_W, GAME_H, "ground_tile")
        .setOrigin(0, 0)
        .setScrollFactor(0)   // 画面固定。tilePositionでスクロール表現
        .setDepth(-100);

      // --- 自機 ---
      this.player = this.add.sprite(0, 0, "player_walk", 0).setDepth(50);
      this.playerHP = PLAYER_HP_MAX;
      this.playerInvuln = 0;

      // --- カメラ自機追従 ---
      this.cameras.main.setSize(GAME_W, GAME_H);
      this.cameras.main.startFollow(this.player, true, 0.15, 0.15);

      // --- 入力 ---
      this.keys = this.input.keyboard.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.W,
        down: Phaser.Input.Keyboard.KeyCodes.S,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        right: Phaser.Input.Keyboard.KeyCodes.D,
        upA: Phaser.Input.Keyboard.KeyCodes.UP,
        downA: Phaser.Input.Keyboard.KeyCodes.DOWN,
        leftA: Phaser.Input.Keyboard.KeyCodes.LEFT,
        rightA: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      });
      // +/- スポーン上限調整 (キーボード配列差を吸収するため key文字で判定)
      this.input.keyboard.on("keydown", (ev) => {
        const ke = ev && ev.key;
        if (ke === "+" || ke === "=") this.adjustCap(+SPAWN_STEP);       // '+'(Shift+=)や'='
        else if (ke === "-" || ke === "_") this.adjustCap(-SPAWN_STEP);  // '-'
      });
      // R リスタート
      this.input.keyboard.on("keydown-R", () => {
        if (this.gameOver) this.scene.restart();
      });
      // Enter でデモ→プレイ開始
      this.input.keyboard.on("keydown-ENTER", () => {
        if (!started) {
          started = true;
          if (titleEl) titleEl.style.display = "none";
          this.scene.restart();  // 新規リセットして操作有効化
        }
      });

      // --- オブジェクトプール初期化 ---
      this.initPools();

      // --- ゲーム状態 ---
      this.spawnCap = SPAWN_INITIAL;     // 同時敵数の目標(上限)
      this.aliveEnemies = 0;
      this.aliveProjectiles = 0;
      this.aliveGems = 0;
      this.kills = 0;
      this.survivalTime = 0;             // s
      this.fireTimer = 0;                // ms
      this.autoSpawnTimer = 0;           // s

      // --- FPS移動平均 ---
      this.fpsSamples = [];
      this.fpsAvg = 60;

      // --- タイトル/アトラクト ---
      this.blinkT = 0;     // 点滅タイマ（秒）
      this.autoT = 0;      // デモAI 累積時間
      if (titleEl) titleEl.style.display = started ? "none" : "grid";

      // --- HUD (DOMオーバーレイではなくTextをカメラ固定) ---
      this.buildHUD();

      // 開始時に目標数まで一気に充填(初期150を即時投入)
      this.fillSpawn(SPAWN_INITIAL);
    }

    // ------------------------- プール構築 -------------------------------
    initPools() {
      // 敵: 構造体配列 + 表示Imageを再利用
      this.enemies = new Array(ENEMY_POOL);
      this.enemyImgs = new Array(ENEMY_POOL);
      for (let i = 0; i < ENEMY_POOL; i++) {
        const img = this.add.sprite(0, 0, "enemy_bat_walk", 0).setActive(false).setVisible(false).setDepth(20);
        this.enemyImgs[i] = img;
        this.enemies[i] = {
          active: false, x: 0, y: 0, vx: 0, vy: 0,
          hp: 0, radius: BAT_RADIUS, big: false,
        };
      }

      // 弾
      this.projectiles = new Array(PROJ_POOL);
      this.projImgs = new Array(PROJ_POOL);
      for (let i = 0; i < PROJ_POOL; i++) {
        const img = this.add.image(0, 0, "projectile").setActive(false).setVisible(false).setDepth(40);
        this.projImgs[i] = img;
        this.projectiles[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0 };
      }

      // gem
      this.gems = new Array(GEM_POOL);
      this.gemImgs = new Array(GEM_POOL);
      for (let i = 0; i < GEM_POOL; i++) {
        const img = this.add.image(0, 0, "xp_gem").setActive(false).setVisible(false).setDepth(10);
        this.gemImgs[i] = img;
        this.gems[i] = { active: false, x: 0, y: 0, life: 0 };
      }
    }

    // フリースロット取得(線形走査; プール上限内で軽量)
    acquire(pool) {
      for (let i = 0; i < pool.length; i++) {
        if (!pool[i].active) return i;
      }
      return -1;
    }

    // ------------------------- スポーン ---------------------------------
    // 目標 spawnCap に満たない分を、画面外周から自機方向へ投入
    fillSpawn(maxThisCall) {
      let budget = maxThisCall;
      while (this.aliveEnemies < this.spawnCap && budget > 0) {
        const idx = this.acquire(this.enemies);
        if (idx < 0) break; // プール枯渇(上限1000<プール1100なので通常起きない)
        this.spawnEnemyAt(idx);
        budget--;
      }
    }

    spawnEnemyAt(idx) {
      const e = this.enemies[idx];
      const cam = this.cameras.main;
      const cx = this.player.x;
      const cy = this.player.y;

      // 画面外周(可視範囲の外)からスポーン
      const halfW = GAME_W / 2 + SPAWN_MARGIN;
      const halfH = GAME_H / 2 + SPAWN_MARGIN;
      const side = Phaser.Math.Between(0, 3);
      let x, y;
      if (side === 0) { x = cx + Phaser.Math.Between(-halfW, halfW); y = cy - halfH; }
      else if (side === 1) { x = cx + Phaser.Math.Between(-halfW, halfW); y = cy + halfH; }
      else if (side === 2) { x = cx - halfW; y = cy + Phaser.Math.Between(-halfH, halfH); }
      else { x = cx + halfW; y = cy + Phaser.Math.Between(-halfH, halfH); }

      // 種別: 70% bat(小/速/HP1), 30% zombie(大/遅/HP3)
      const big = Math.random() < 0.3;
      e.active = true;
      e.x = x; e.y = y;
      e.big = big;
      e.hp = big ? ZOMBIE_HP : BAT_HP;
      e.radius = big ? ZOMBIE_RADIUS : BAT_RADIUS;

      // 速度: 60〜90 px/s。大型はやや遅め寄り、小型は速め寄り
      const sp = big
        ? Phaser.Math.Between(ENEMY_SPEED_MIN, ENEMY_SPEED_MIN + 15)
        : Phaser.Math.Between(ENEMY_SPEED_MAX - 15, ENEMY_SPEED_MAX);
      e._spd = sp;
      e.vx = 0; e.vy = 0;

      const img = this.enemyImgs[idx];
      img.setTexture(big ? "enemy_zombie_walk" : "enemy_bat_walk", 0);
      img.setPosition(x, y).setActive(true).setVisible(true).setTint(0xffffff);
      this.aliveEnemies++;
    }

    killEnemy(idx, dropGem) {
      const e = this.enemies[idx];
      if (!e.active) return;
      e.active = false;
      const img = this.enemyImgs[idx];
      img.stop();
      img.setActive(false).setVisible(false);
      this.aliveEnemies--;
      if (dropGem) this.spawnGem(e.x, e.y);
    }

    spawnGem(x, y) {
      const idx = this.acquire(this.gems);
      if (idx < 0) return;
      const g = this.gems[idx];
      g.active = true; g.x = x; g.y = y; g.life = GEM_LIFETIME;
      this.gemImgs[idx].setPosition(x, y).setActive(true).setVisible(true);
      this.aliveGems++;
    }

    removeGem(idx) {
      const g = this.gems[idx];
      g.active = false;
      this.gemImgs[idx].setActive(false).setVisible(false);
      this.aliveGems--;
    }

    fireProjectile(tx, ty) {
      const idx = this.acquire(this.projectiles);
      if (idx < 0) return;
      const px = this.player.x, py = this.player.y;
      let dx = tx - px, dy = ty - py;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const p = this.projectiles[idx];
      p.active = true;
      p.x = px; p.y = py;
      p.vx = dx * PROJECTILE_SPEED;
      p.vy = dy * PROJECTILE_SPEED;
      p.life = PROJECTILE_LIFETIME;
      const img = this.projImgs[idx];
      img.setPosition(px, py).setRotation(Math.atan2(dy, dx)).setActive(true).setVisible(true);
      this.aliveProjectiles++;
    }

    removeProjectile(idx) {
      const p = this.projectiles[idx];
      p.active = false;
      this.projImgs[idx].setActive(false).setVisible(false);
      this.aliveProjectiles--;
    }

    // ------------------------- スポーン上限調整 -------------------------
    adjustCap(delta) {
      if (this.gameOver) return;
      this.spawnCap = Phaser.Math.Clamp(this.spawnCap + delta, SPAWN_MIN, SPAWN_MAX);
    }

    // ------------------------- メインループ -----------------------------
    update(time, delta) {
      const dt = delta / 1000; // s

      // アトラクト中はタイトルを点滅
      if (!started && titleEl) {
        this.blinkT += dt;
        titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
      }

      if (this.gameOver) {
        // アトラクト中の被弾死はデモをループ再開
        if (!started) { this.scene.restart(); return; }
        this.updateHUD();
        return;
      }

      this.survivalTime += dt;

      // FPS移動平均(直近60サンプル)
      const inst = delta > 0 ? 1000 / delta : 60;
      this.fpsSamples.push(inst);
      if (this.fpsSamples.length > 60) this.fpsSamples.shift();
      let sum = 0;
      for (let i = 0; i < this.fpsSamples.length; i++) sum += this.fpsSamples[i];
      this.fpsAvg = sum / this.fpsSamples.length;

      // 自動増加: 10秒ごと +25 (上限1000)
      this.autoSpawnTimer += dt;
      if (this.autoSpawnTimer >= SPAWN_AUTO_INTERVAL) {
        this.autoSpawnTimer -= SPAWN_AUTO_INTERVAL;
        this.spawnCap = Math.min(SPAWN_MAX, this.spawnCap + SPAWN_AUTO_AMOUNT);
      }

      this.updatePlayer(dt);
      this.scrollGround();
      this.fillSpawn(SPAWN_PER_FRAME); // フレーム毎少しずつ補充(スパイク抑制)
      this.updateEnemies(dt);
      this.updateAutoFire(delta);
      this.updateProjectiles(dt);
      this.updateGems(dt);
      this.updateHUD();
    }

    updatePlayer(dt) {
      const k = this.keys;
      let dx = 0, dy = 0;
      if (!started) {
        // デモAI: 累積時間ベースの sin で緩やかに徘徊（決定的）
        this.autoT += dt;
        const phase = Math.floor(this.autoT / 1.25) % 4;
        if (phase === 0) dx = 1;
        else if (phase === 1) dy = 1;
        else if (phase === 2) dx = -1;
        else dy = -1;
      } else {
        if (k.left.isDown || k.leftA.isDown) dx -= 1;
        if (k.right.isDown || k.rightA.isDown) dx += 1;
        if (k.up.isDown || k.upA.isDown) dy -= 1;
        if (k.down.isDown || k.downA.isDown) dy += 1;
      }
      const mv = this.cardinal(dx, dy);
      if (dx !== 0 || dy !== 0) {
        this.player.x += mv.x * PLAYER_SPEED * dt;
        this.player.y += mv.y * PLAYER_SPEED * dt;
      }
      this.player.setFrame(this.walkFrame(mv.x, mv.y, mv.x !== 0 || mv.y !== 0));

      // 無敵時間処理 + 点滅
      if (this.playerInvuln > 0) {
        this.playerInvuln -= dt;
        this.player.setAlpha((Math.floor(this.playerInvuln * 20) % 2) ? 0.35 : 1);
        if (this.playerInvuln <= 0) this.player.setAlpha(1);
      }
    }

    scrollGround() {
      // 自機ワールド座標に合わせ地面タイルをスクロール(無限風)
      this.ground.tilePositionX = this.player.x;
      this.ground.tilePositionY = this.player.y;
    }

    updateEnemies(dt) {
      const px = this.player.x, py = this.player.y;
      const enemies = this.enemies;
      const imgs = this.enemyImgs;
      let contact = false;
      const pr2 = (PLAYER_RADIUS + ENEMY_CONTACT_RADIUS);
      const pr2sq = pr2 * pr2;

      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e.active) continue;
        // 自機へ直進
        let dx = px - e.x, dy = py - e.y;
        const len = Math.hypot(dx, dy) || 1;
        const step = e._spd * dt;
        const ev = this.cardinal(dx, dy);
        e.x += ev.x * step;
        e.y += ev.y * step;
        const img = imgs[i];
        img.x = e.x; img.y = e.y;
        img.setFrame(this.walkFrame(ev.x, ev.y, ev.x !== 0 || ev.y !== 0));

        // 自機接触判定(円)
        if (this.playerInvuln <= 0) {
          const ddx = px - e.x, ddy = py - e.y;
          if (ddx * ddx + ddy * ddy <= pr2sq) {
            contact = true;
          }
        }
      }

      if (contact && this.playerInvuln <= 0) {
        this.damagePlayer();
      }
    }

    cardinal(x, y) {
      if (x === 0 && y === 0) return { x: 0, y: 0 };
      if (Math.abs(x) >= Math.abs(y)) return { x: Math.sign(x), y: 0 };
      return { x: 0, y: Math.sign(y) };
    }

    walkFrame(x, y, moving) {
      let dir = 0;
      if (y < 0) dir = 1;
      else if (x < 0) dir = 2;
      else if (x > 0) dir = 3;
      const step = moving ? Math.floor(this.survivalTime * 10) % 4 : 0;
      return dir * 4 + step;
    }

    damagePlayer() {
      this.playerHP -= 1;
      this.playerInvuln = PLAYER_INVULN;
      this.cameras.main.shake(120, 0.006);
      if (this.playerHP <= 0) {
        this.playerHP = 0;
        this.triggerGameOver();
      }
    }

    updateAutoFire(delta) {
      this.fireTimer += delta;
      if (this.fireTimer < FIRE_INTERVAL) return;

      // 最近接敵を探索(索敵範囲内)
      const px = this.player.x, py = this.player.y;
      let best = -1, bestD = TARGET_RANGE * TARGET_RANGE;
      const enemies = this.enemies;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e.active) continue;
        const dx = e.x - px, dy = e.y - py;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        this.fireTimer -= FIRE_INTERVAL; // 攻撃成立時のみ消費(間隔厳守)
        const t = enemies[best];
        this.fireProjectile(t.x, t.y);
      } else {
        // 敵不在なら溜め過ぎ防止
        this.fireTimer = FIRE_INTERVAL;
      }
    }

    updateProjectiles(dt) {
      const projs = this.projectiles;
      const imgs = this.projImgs;
      const enemies = this.enemies;
      for (let i = 0; i < projs.length; i++) {
        const p = projs[i];
        if (!p.active) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
        const img = imgs[i];
        img.x = p.x; img.y = p.y;

        if (p.life <= 0) { this.removeProjectile(i); continue; }

        // 敵との当たり判定(円) — 命中で敵HP-1
        let hit = false;
        for (let j = 0; j < enemies.length; j++) {
          const e = enemies[j];
          if (!e.active) continue;
          const dx = e.x - p.x, dy = e.y - p.y;
          const r = e.radius + PROJECTILE_RADIUS;
          if (dx * dx + dy * dy <= r * r) {
            e.hp -= 1;
            if (e.hp <= 0) {
              this.killEnemy(j, true);
            } else {
              // ダメージ点滅(再利用Imageのtintのみ)
              this.enemyImgs[j].setTint(0xff8080);
            }
            hit = true;
            break;
          }
        }
        if (hit) this.removeProjectile(i);
      }
    }

    updateGems(dt) {
      const gems = this.gems;
      const imgs = this.gemImgs;
      const px = this.player.x, py = this.player.y;
      const pickR = PLAYER_RADIUS + GEM_RADIUS;
      const pickSq = pickR * pickR;
      for (let i = 0; i < gems.length; i++) {
        const g = gems[i];
        if (!g.active) continue;
        g.life -= dt;
        if (g.life <= 0) { this.removeGem(i); continue; }
        const dx = px - g.x, dy = py - g.y;
        if (dx * dx + dy * dy <= pickSq) {
          this.removeGem(i);
          this.kills += 1; // 取得でKillカウント(SPEC: 撃破ドロップ→取得でKill)
        }
      }
    }

    // --------------------------- HUD ------------------------------------
    buildHUD() {
      // HUD は他エンジンと同じく HTML オーバーレイ（#hud）。hint は #help に記載。
      // GAME OVER は HUD内に inline 表示（three.js と同様、別演出は持たない）。
      this.hudEl = document.getElementById("hud");
    }

    updateHUD() {
      const objects = this.aliveEnemies + this.aliveProjectiles + this.aliveGems;
      // 表示内容・書式は three.js に統一
      this.hudEl.textContent =
        `FPS     : ${this.fpsAvg.toFixed(1)}\n` +
        `Enemies : ${this.aliveEnemies}  (cap ${this.spawnCap})\n` +
        `Objects : ${objects}  (ene ${this.aliveEnemies} / proj ${this.aliveProjectiles} / gem ${this.aliveGems})\n` +
        `Time    : ${this.survivalTime.toFixed(1)}s   Kills: ${this.kills}\n` +
        `HP      : ${(this.gameOver && started) ? 'GAME OVER (R to restart)' : '♥'.repeat(this.playerHP) + ' (' + this.playerHP + ')'}`;
    }

    triggerGameOver() {
      this.gameOver = true;
      // GAME OVER は HUD内に inline 表示（three.js と同様、別演出は持たない）。
    }
  }

  // ============================ 起動 =====================================
  const config = {
    type: Phaser.AUTO,
    parent: "game-container",
    width: GAME_W,
    height: GAME_H,
    backgroundColor: "#15151c",
    pixelArt: false,
    fps: { target: 60 },
    scene: [BootScene, GameScene],
  };

  new Phaser.Game(config);
})();
