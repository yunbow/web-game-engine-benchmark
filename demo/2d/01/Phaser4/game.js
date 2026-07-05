/*
 * 弾幕STG（縦スクロールシューティング） - Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠。性能比較用。
 *
 * 画面 960x540 固定 / デルタタイム基準更新。
 * 数値はすべて SPEC.md に一致させてある（弾速・連射・敵速度・スポーン・当たり判定・HP/スコア）。
 */

// ===== 定数（SPEC.md より） =====
const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;

const PLAYER_SPEED = 300;          // 自機移動速度 px/s（8方向移動）
const PLAYER_BULLET_SPEED = 600;   // 自機弾速 px/s（上方向）
const FIRE_INTERVAL = 150;         // 連射間隔 ms
const ENEMY_SPEED_MIN = 80;        // 敵下方向速度 最小 px/s
const ENEMY_SPEED_MAX = 140;       // 敵下方向速度 最大 px/s
const ENEMY_BULLET_SPEED = 200;    // 敵弾速 px/s（自機方向）
const ENEMY_FIRE_INTERVAL_MIN = 900;  // 敵の発射間隔（ばらつき用）ms
const ENEMY_FIRE_INTERVAL_MAX = 1800; // ms

const INITIAL_MAX_ENEMIES = 40;    // 初期同時最大敵数
const ENEMY_STEP = 10;             // +/- の増減量
const MAX_ENEMIES_CAP = 300;       // 上限
const MIN_ENEMIES = 10;            // 下限（操作上の最小）

const INITIAL_HP = 3;
const SCORE_PER_KILL = 10;

// 当たり判定半径（円判定）
const PLAYER_RADIUS = 14;
const PLAYER_BULLET_RADIUS = 6;
const ENEMY_SMALL_RADIUS = 18;
const ENEMY_BIG_RADIUS = 36;
const ENEMY_BULLET_RADIUS = 6;

// アセット定義（SPEC のファイル名に厳密一致）
const ASSET_DEFS = [
  { key: 'player_ship',  file: 'player_ship.png' },
  { key: 'enemy_small',  file: 'enemy_small.png' },
  { key: 'enemy_big',    file: 'enemy_big.png' },
  { key: 'bullet_player',file: 'bullet_player.png' },
  { key: 'bullet_enemy', file: 'bullet_enemy.png' },
  { key: 'explosion',    file: 'explosion.png' },
  { key: 'bg_space',     file: 'bg_space.png' },
];

// ロード失敗したキーの集合（フォールバック生成対象）
const failedAssets = new Set();

// ===== Boot / Preload シーン =====
class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    // 画像が無くても起動する: ロード失敗を記録し、後でフォールバックテクスチャを生成
    this.load.on('loaderror', (fileObj) => {
      failedAssets.add(fileObj.key);
    });

    for (const def of ASSET_DEFS) {
      this.load.image(def.key, '../assets/' + def.file);
    }
  }

  create() {
    // 失敗したアセットを単色図形テクスチャで生成（既存テクスチャは上書きしない）
    this.buildFallbackTextures();
    this.scene.start('GameScene');
  }

  // Graphics から単色図形テクスチャを生成してフォールバック
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      // 正常ロード済みなら何もしない
      if (this.textures.exists(key) && !failedAssets.has(key)) return;
      // 既に同名フォールバックを作っていたら消す
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 自機 = 水色三角（上向き）
    make('player_ship', 64, 64, (g, w, h) => {
      g.fillStyle(0x33ddff, 1);
      g.beginPath();
      g.moveTo(w / 2, 4);
      g.lineTo(w - 6, h - 6);
      g.lineTo(6, h - 6);
      g.closePath();
      g.fillPath();
    });

    // 小型敵 = 赤丸
    make('enemy_small', 48, 48, (g, w, h) => {
      g.fillStyle(0xff4444, 1);
      g.fillCircle(w / 2, h / 2, w / 2 - 2);
    });

    // 大型敵 = 濃い赤丸
    make('enemy_big', 96, 96, (g, w, h) => {
      g.fillStyle(0xcc2222, 1);
      g.fillCircle(w / 2, h / 2, w / 2 - 2);
      g.fillStyle(0xff8888, 1);
      g.fillCircle(w / 2, h / 2, w / 4);
    });

    // 自機弾 = 黄丸/楕円
    make('bullet_player', 16, 24, (g, w, h) => {
      g.fillStyle(0xffff66, 1);
      g.fillEllipse(w / 2, h / 2, w, h);
    });

    // 敵弾 = オレンジ丸
    make('bullet_enemy', 16, 16, (g, w, h) => {
      g.fillStyle(0xff9933, 1);
      g.fillCircle(w / 2, h / 2, w / 2 - 1);
    });

    // 爆発 = 白〜橙の丸
    make('explosion', 64, 64, (g, w, h) => {
      g.fillStyle(0xffaa33, 1);
      g.fillCircle(w / 2, h / 2, w / 2 - 2);
      g.fillStyle(0xffffaa, 1);
      g.fillCircle(w / 2, h / 2, w / 3);
    });

    // 背景 = 暗い宇宙色（星はGameSceneで別途描画）
    make('bg_space', 512, 512, (g, w, h) => {
      g.fillStyle(0x05060f, 1);
      g.fillRect(0, 0, w, h);
    });
  }
}

// ===== ゲーム本体シーン =====
class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  create() {
    // 背景（タイルスプライトで縦スクロール）
    this.bg = this.add.tileSprite(0, 0, GAME_WIDTH, GAME_HEIGHT, 'bg_space')
      .setOrigin(0, 0)
      .setDepth(0);

    // 星のレイヤー（軽い視覚効果。負荷比較の主役ではないので少量）
    this.createStarfield();

    // ===== オブジェクトプール（Group）=====
    // 物理は使わず、自前で位置・円判定を更新（性能比較のためシンプルに保つ）
    this.playerBullets = this.add.group();
    this.enemies = this.add.group();
    this.enemyBullets = this.add.group();
    this.effects = this.add.group();

    // ===== 自機 =====
    this.player = this.add.image(GAME_WIDTH / 2, GAME_HEIGHT - 70, 'player_ship')
      .setDepth(5);
    this.scalePlayerSprite();
    this.playerAlive = true;

    // ===== 状態 =====
    this.hp = INITIAL_HP;
    this.score = 0;
    this.maxEnemies = INITIAL_MAX_ENEMIES;
    this.fireTimer = 0;
    this.invuln = 0; // 被弾後の無敵時間(ms)

    // ===== タイトル/アトラクト状態（false=デモ中・操作無効） =====
    this.started = false;
    this.blinkT = 0;
    this.autoT = 0;
    this.titleEl = document.getElementById('title');
    if (this.titleEl) this.titleEl.style.display = 'grid';

    // ===== 入力 =====
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
    });

    // +/- で最大敵数調整。
    // KeyCodes.PLUS=187('='/'+'キー), MINUS=189('-'キー)。Shift有無に関わらず物理キーで発火する。
    // テンキーの +/- にも対応。
    this.input.keyboard.on('keydown-PLUS', () => this.adjustMaxEnemies(+ENEMY_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustMaxEnemies(-ENEMY_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustMaxEnemies(+ENEMY_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustMaxEnemies(-ENEMY_STEP));

    // Enter でデモ→プレイ開始
    this.enterKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);

    // ===== FPS移動平均 =====
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // ===== HUD（他エンジンと同じく HTML オーバーレイ。hint は #help に記載） =====
    this.hudEl = document.getElementById('hud');

    // 初期スポーン
    this.fillEnemies();
  }

  // 自機スプライトを当たり判定相当の見た目に調整
  scalePlayerSprite() {
    const tex = this.textures.get('player_ship').getSourceImage();
    const target = 48;
    if (tex && tex.width) {
      this.player.setScale(target / tex.width);
    }
  }

  createStarfield() {
    this.stars = [];
    const g = this.add.graphics().setDepth(1);
    this.starGfx = g;
    for (let i = 0; i < 80; i++) {
      this.stars.push({
        x: Math.random() * GAME_WIDTH,
        y: Math.random() * GAME_HEIGHT,
        speed: 30 + Math.random() * 90,
        size: Math.random() < 0.3 ? 2 : 1,
      });
    }
  }

  adjustMaxEnemies(delta) {
    this.maxEnemies = Phaser.Math.Clamp(this.maxEnemies + delta, MIN_ENEMIES, MAX_ENEMIES_CAP);
  }

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true;
    // 状態の初期化
    this.score = 0;
    this.maxEnemies = INITIAL_MAX_ENEMIES;
    this.fireTimer = 0;
    this.invuln = 0;
    // 自機リセット
    this.hp = INITIAL_HP;
    this.playerAlive = true;
    this.player.setVisible(true).setAlpha(1);
    this.player.setPosition(GAME_WIDTH / 2, GAME_HEIGHT - 70);
    // 全ライブオブジェクトをクリア（プールへ戻す）
    for (const b of this.playerBullets.getChildren()) this.killObject(this.playerBullets, b);
    for (const e of this.enemies.getChildren()) this.killObject(this.enemies, e);
    for (const b of this.enemyBullets.getChildren()) this.killObject(this.enemyBullets, b);
    for (const ex of this.effects.getChildren()) this.killObject(this.effects, ex);
    // 初期スポーン
    this.fillEnemies();
    if (this.titleEl) this.titleEl.style.display = 'none';
  }

  // ===== スポーン =====
  fillEnemies() {
    let active = this.countActive(this.enemies);
    while (active < this.maxEnemies) {
      this.spawnEnemy();
      active++;
    }
  }

  spawnEnemy() {
    const isBig = Math.random() < 0.2;
    const key = isBig ? 'enemy_big' : 'enemy_small';
    const radius = isBig ? ENEMY_BIG_RADIUS : ENEMY_SMALL_RADIUS;
    const targetSize = isBig ? 72 : 36;

    const x = Phaser.Math.Between(radius, GAME_WIDTH - radius);
    const y = Phaser.Math.Between(-200, -20);

    let e = this.enemies.getFirstDead(false);
    if (!e) {
      e = this.add.image(x, y, key).setDepth(4);
      this.enemies.add(e);
    } else {
      e.setTexture(key);
      e.setActive(true).setVisible(true);
      e.setPosition(x, y);
    }

    const tex = this.textures.get(key).getSourceImage();
    e.setScale(tex && tex.width ? targetSize / tex.width : 1);

    e.vy = Phaser.Math.Between(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX);
    e.radius = radius;
    e.hp = isBig ? 3 : 1;
    e.fireCooldown = Phaser.Math.Between(ENEMY_FIRE_INTERVAL_MIN, ENEMY_FIRE_INTERVAL_MAX);
  }

  spawnPlayerBullet(x, y) {
    let b = this.playerBullets.getFirstDead(false);
    if (!b) {
      b = this.add.image(x, y, 'bullet_player').setDepth(3);
      this.playerBullets.add(b);
    } else {
      b.setActive(true).setVisible(true);
      b.setPosition(x, y);
    }
    b.radius = PLAYER_BULLET_RADIUS;
    b.vx = 0;
    b.vy = -PLAYER_BULLET_SPEED;
  }

  spawnEnemyBullet(x, y, targetX, targetY) {
    let b = this.enemyBullets.getFirstDead(false);
    if (!b) {
      b = this.add.image(x, y, 'bullet_enemy').setDepth(3);
      this.enemyBullets.add(b);
    } else {
      b.setActive(true).setVisible(true);
      b.setPosition(x, y);
    }
    const ang = Math.atan2(targetY - y, targetX - x);
    b.radius = ENEMY_BULLET_RADIUS;
    b.vx = Math.cos(ang) * ENEMY_BULLET_SPEED;
    b.vy = Math.sin(ang) * ENEMY_BULLET_SPEED;
  }

  spawnExplosion(x, y) {
    let ex = this.effects.getFirstDead(false);
    if (!ex) {
      ex = this.add.image(x, y, 'explosion').setDepth(6);
      this.effects.add(ex);
    } else {
      ex.setActive(true).setVisible(true);
      ex.setPosition(x, y);
    }
    ex.life = 250; // ms 表示
    ex.setScale(0.6);
    ex.setAlpha(1);
  }

  killObject(group, obj) {
    obj.setActive(false).setVisible(false);
  }

  countActive(group) {
    return group.countActive(true);
  }

  // ===== 更新ループ（デルタタイム基準） =====
  update(time, delta) {
    const dt = delta / 1000; // 秒

    // Enter でデモ→プレイ開始
    if (Phaser.Input.Keyboard.JustDown(this.enterKey) && !this.started) {
      this.startGame();
    }

    // FPS移動平均
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0;
    for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    // 背景スクロール
    this.bg.tilePositionY -= 40 * dt;
    this.updateStars(dt);

    // 無敵時間
    if (this.invuln > 0) {
      this.invuln -= delta;
      this.player.setAlpha((Math.floor(time / 60) % 2) ? 0.3 : 1);
    } else if (this.playerAlive) {
      this.player.setAlpha(1);
    }

    if (this.playerAlive) {
      this.updatePlayer(dt);
      this.updateFire(delta);
    }

    this.updatePlayerBullets(dt);
    this.updateEnemies(dt, delta);
    this.updateEnemyBullets(dt);
    this.updateEffects(delta);
    this.handleCollisions();

    // 敵数を維持
    this.fillEnemies();

    this.updateHUD();

    // タイトル点滅（約0.45秒周期）
    if (!this.started && this.titleEl) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  }

  updateStars(dt) {
    const g = this.starGfx;
    g.clear();
    g.fillStyle(0xffffff, 1);
    for (const s of this.stars) {
      s.y += s.speed * dt;
      if (s.y > GAME_HEIGHT) {
        s.y = 0;
        s.x = Math.random() * GAME_WIDTH;
      }
      g.fillRect(s.x, s.y, s.size, s.size);
    }
  }

  updatePlayer(dt) {
    let dx = 0, dy = 0;
    if (!this.started) {
      // デモAI: 累積時間の sin で緩やかに左右＋上下移動（決定的・Math.random不使用）
      this.autoT += dt;
      dx = Math.cos(this.autoT * 0.8);
      dy = 0;
    } else {
      if (this.cursors.left.isDown || this.keys.A.isDown) dx -= 1;
      if (this.cursors.right.isDown || this.keys.D.isDown) dx += 1;
      if (this.cursors.up.isDown || this.keys.W.isDown) dy -= 1;
      if (this.cursors.down.isDown || this.keys.S.isDown) dy += 1;
    }

    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv; dy *= inv;
    }

    this.player.x += dx * PLAYER_SPEED * dt;
    this.player.y += dy * PLAYER_SPEED * dt;

    // 画面内クランプ
    this.player.x = Phaser.Math.Clamp(this.player.x, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
    this.player.y = Phaser.Math.Clamp(this.player.y, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
  }

  updateFire(delta) {
    this.fireTimer += delta;
    while (this.fireTimer >= FIRE_INTERVAL) {
      this.fireTimer -= FIRE_INTERVAL;
      this.spawnPlayerBullet(this.player.x, this.player.y - 20);
    }
  }

  updatePlayerBullets(dt) {
    const list = this.playerBullets.getChildren();
    for (const b of list) {
      if (!b.active) continue;
      b.y += b.vy * dt;
      if (b.y < -30) this.killObject(this.playerBullets, b);
    }
  }

  updateEnemies(dt, delta) {
    const list = this.enemies.getChildren();
    for (const e of list) {
      if (!e.active) continue;
      e.y += e.vy * dt;

      // 発射
      e.fireCooldown -= delta;
      if (e.fireCooldown <= 0 && e.y > 0 && e.y < GAME_HEIGHT * 0.85 && this.playerAlive) {
        this.spawnEnemyBullet(e.x, e.y, this.player.x, this.player.y);
        e.fireCooldown = Phaser.Math.Between(ENEMY_FIRE_INTERVAL_MIN, ENEMY_FIRE_INTERVAL_MAX);
      }

      // 画面下端を抜けたら撃破ではなく消去（再スポーンで補充）
      if (e.y > GAME_HEIGHT + e.radius + 40) {
        this.killObject(this.enemies, e);
      }
    }
  }

  updateEnemyBullets(dt) {
    const list = this.enemyBullets.getChildren();
    for (const b of list) {
      if (!b.active) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -30 || b.x > GAME_WIDTH + 30 || b.y < -30 || b.y > GAME_HEIGHT + 30) {
        this.killObject(this.enemyBullets, b);
      }
    }
  }

  updateEffects(delta) {
    const list = this.effects.getChildren();
    for (const ex of list) {
      if (!ex.active) continue;
      ex.life -= delta;
      ex.setScale(ex.scaleX + 0.004 * delta);
      ex.setAlpha(Math.max(0, ex.life / 250));
      if (ex.life <= 0) this.killObject(this.effects, ex);
    }
  }

  // 円判定ヘルパ
  static circleHit(ax, ay, ar, bx, by, br) {
    const dx = ax - bx;
    const dy = ay - by;
    const rr = ar + br;
    return (dx * dx + dy * dy) <= rr * rr;
  }

  handleCollisions() {
    const pBullets = this.playerBullets.getChildren();
    const enemies = this.enemies.getChildren();
    const eBullets = this.enemyBullets.getChildren();

    // 自機弾 × 敵
    for (const b of pBullets) {
      if (!b.active) continue;
      for (const e of enemies) {
        if (!e.active) continue;
        if (GameScene.circleHit(b.x, b.y, b.radius, e.x, e.y, e.radius)) {
          this.killObject(this.playerBullets, b);
          e.hp -= 1;
          if (e.hp <= 0) {
            this.spawnExplosion(e.x, e.y);
            this.killObject(this.enemies, e);
            this.score += SCORE_PER_KILL;
          }
          break;
        }
      }
    }

    if (!this.playerAlive || this.invuln > 0) return;

    // 敵弾 × 自機
    for (const b of eBullets) {
      if (!b.active) continue;
      if (GameScene.circleHit(b.x, b.y, b.radius, this.player.x, this.player.y, PLAYER_RADIUS)) {
        this.killObject(this.enemyBullets, b);
        this.damagePlayer();
        return;
      }
    }

    // 敵 × 自機
    for (const e of enemies) {
      if (!e.active) continue;
      if (GameScene.circleHit(e.x, e.y, e.radius, this.player.x, this.player.y, PLAYER_RADIUS)) {
        this.spawnExplosion(e.x, e.y);
        this.killObject(this.enemies, e);
        this.damagePlayer();
        return;
      }
    }
  }

  damagePlayer() {
    this.hp -= 1;
    this.spawnExplosion(this.player.x, this.player.y);
    this.invuln = 1500; // 1.5s 無敵
    if (this.hp <= 0) {
      this.hp = 0;
      this.gameOver();
    }
  }

  gameOver() {
    this.playerAlive = false;
    this.player.setVisible(false);

    // アトラクト中の被弾死は GAME OVER を出さずデモをループ再開（タイマで自動復活）
    if (!this.started) {
      this.time.delayedCall(1500, () => {
        if (this.started) return; // 復活前に Enter で開始されたら無視
        this.hp = INITIAL_HP;
        this.playerAlive = true;
        this.player.setVisible(true).setAlpha(1);
        this.player.setPosition(GAME_WIDTH / 2, GAME_HEIGHT - 70);
        this.invuln = 1500;
      });
      return;
    }

    const t = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2,
      'GAME OVER\nクリックでリスタート',
      {
        fontFamily: 'monospace', fontSize: '32px', color: '#ffffff',
        align: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: { x: 16, y: 12 },
      }
    ).setOrigin(0.5).setDepth(200);

    this.input.once('pointerdown', () => {
      t.destroy();
      this.scene.restart();
    });
  }

  updateHUD() {
    const pb = this.countActive(this.playerBullets);
    const eb = this.countActive(this.enemyBullets);
    const en = this.countActive(this.enemies);
    const fx = this.countActive(this.effects);
    const objCount = pb + eb + en + fx;

    // 表示内容は three.js に統一
    this.hudEl.textContent =
      'FPS     : ' + this.fpsAvg.toFixed(1) + '\n' +
      'Objects : ' + objCount + '  (bul ' + (pb + eb) + ' / ene ' + en + ' / fx ' + fx + ')\n' +
      'Score   : ' + this.score + '\n' +
      'HP      : ' + (this.playerAlive ? '♥'.repeat(this.hp) + ' (' + this.hp + ')' : 'GAME OVER') + '\n' +
      'MaxEnemy: ' + this.maxEnemies + '  (+/- to change, cap ' + MAX_ENEMIES_CAP + ')';
  }
}

// ===== Phaser 設定 =====
const config = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-container',
  backgroundColor: '#05060f',
  scene: [BootScene, GameScene],
  render: {
    pixelArt: false,
    antialias: true,
  },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.CENTER_HORIZONTALLY,
  },
};

new Phaser.Game(config);
