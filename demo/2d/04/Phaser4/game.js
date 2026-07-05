/*
 * ブロック崩し（マルチボール / Breakout） - Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠。性能比較用。
 *
 * 画面 960x540 固定 / デルタタイム基準更新。
 * 物理エンジンは未使用。位置更新・壁/パドル/ブロック反射・AABB(矩形)×円判定を自前実装。
 * 数値はすべて SPEC.md に一致させてある（パドル・ボール速・反射・ブロックHP/スコア・同時ボール数）。
 */

// ===== 定数（SPEC.md より） =====
const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;

// パドル
const PADDLE_WIDTH = 96;     // 幅 px
const PADDLE_HEIGHT = 18;    // 高さ px
const PADDLE_Y = 510;        // 中心 y 固定
const PADDLE_SPEED = 600;    // 移動速度 px/s（左右、画面内クランプ）

// ボール
const BALL_RADIUS = 8;       // 半径 px
const BALL_SPEED = 380;      // 速さ px/s（一定）
const LAUNCH_ANGLE_DEG = 60; // 発射時の上方向ランダム角の左右最大（±60°）

// 同時ボール数（負荷）
const INITIAL_BALLS = 3;     // 初期同時ボール数
const BALL_STEP = 5;         // +/- の増減量
const MIN_BALLS = 1;         // 下限
const MAX_BALLS = 500;       // 上限

// ブロック（グリッド）
const BRICK_COLS = 15;       // 列
const BRICK_ROWS = 9;        // 行（135個）
const BRICK_W = 56;          // ブロック幅 px
const BRICK_H = 20;          // ブロック高さ px
const BRICK_GAP = 4;         // 間隔 px
const BRICK_TOP = 60;        // 上オフセット px

const SCORE_PER_BRICK = 10;  // ブロック破壊スコア

// HP ごとの tint 色（HP3=赤 / HP2=橙 / HP1=緑）
const HP_TINT = {
  3: 0xff4444,
  2: 0xffa23a,
  1: 0x55cc66,
};

// アセット定義（SPEC のファイル名に厳密一致）
const ASSET_DEFS = [
  { key: 'paddle',       file: 'paddle.png' },
  { key: 'ball',         file: 'ball.png' },
  { key: 'brick',        file: 'brick.png' },
  { key: 'hit_spark',    file: 'hit_spark.png' },
  { key: 'bg_breakout',  file: 'bg_breakout.png' },
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

    // パドル = 白角丸（後で見た目調整）
    make('paddle', 96, 24, (g, w, h) => {
      g.fillStyle(0xffffff, 1);
      g.fillRoundedRect(0, 0, w, h, 8);
    });

    // ボール = 白丸
    make('ball', 16, 16, (g, w, h) => {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(w / 2, h / 2, w / 2 - 1);
    });

    // ブロック = ほぼ白（HP色で tint 乗算するので near-white が必須）
    make('brick', 64, 24, (g, w, h) => {
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, w, h);
      // 縁取りを少し暗く（tint しても立体感が出る）
      g.lineStyle(2, 0xdddddd, 1);
      g.strokeRect(1, 1, w - 2, h - 2);
    });

    // 破壊エフェクト = 黄バースト
    make('hit_spark', 32, 32, (g, w, h) => {
      g.fillStyle(0xffff66, 1);
      g.fillCircle(w / 2, h / 2, w / 2 - 2);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(w / 2, h / 2, w / 4);
    });

    // 背景 = 暗色
    make('bg_breakout', 512, 512, (g, w, h) => {
      g.fillStyle(0x0a0e1a, 1);
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
    // 背景（タイルスプライト。負荷比較の主役ではないので静止）
    this.bg = this.add.tileSprite(0, 0, GAME_WIDTH, GAME_HEIGHT, 'bg_breakout')
      .setOrigin(0, 0)
      .setDepth(0);

    // ===== オブジェクトプール（Group）=====
    // 物理は使わず、自前で位置・反射・AABB×円判定を更新（性能比較のためシンプルに保つ）
    this.balls = this.add.group();
    this.bricks = this.add.group();
    this.effects = this.add.group();

    // ===== パドル =====
    this.paddle = this.add.image(GAME_WIDTH / 2, PADDLE_Y, 'paddle').setDepth(5);
    this.scaleToSize(this.paddle, PADDLE_WIDTH, PADDLE_HEIGHT);

    // ===== 状態 =====
    this.score = 0;
    this.lost = 0;                 // ロスト（下端を抜けて再発射した）回数
    this.ballSetting = INITIAL_BALLS; // 同時ボール数の設定値（負荷の主軸）

    // タイトル/アトラクト状態（false=デモ中・操作無効）
    this.started = false;
    this.blinkT = 0;
    this.titleEl = document.getElementById('title');

    // ブロック1枚の確保サイズ（スケール算出に使う元テクスチャ寸法）
    const brickTex = this.textures.get('brick').getSourceImage();
    this.brickTexW = brickTex && brickTex.width ? brickTex.width : BRICK_W;
    this.brickTexH = brickTex && brickTex.height ? brickTex.height : BRICK_H;

    // ===== 入力 =====
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      A: Phaser.Input.Keyboard.KeyCodes.A,
      D: Phaser.Input.Keyboard.KeyCodes.D,
    });

    // +/- で同時ボール数調整。
    // KeyCodes.PLUS=187('='/'+'キー), MINUS=189('-'キー)。Shift有無に関わらず物理キーで発火する。
    // テンキーの +/- にも対応。keydown-PLUS 等のみに統一して二重発火を回避。
    this.input.keyboard.on('keydown-PLUS', () => this.adjustBallSetting(+BALL_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustBallSetting(-BALL_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustBallSetting(+BALL_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustBallSetting(-BALL_STEP));

    // Enter でデモ→プレイ開始
    this.input.keyboard.on('keydown-ENTER', () => { if (!this.started) this.startGame(); });

    // ===== FPS移動平均 =====
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // ===== HUD =====
    // HUD は他エンジンと同じく HTML オーバーレイ（#hud）。hint は #help に記載。
    this.hudEl = document.getElementById('hud');

    // 初期盤面・初期ボール
    this.buildBrickField();
    this.fillBalls();
  }

  // 画像を指定の表示サイズ（px）に合わせてスケール
  scaleToSize(img, w, h) {
    const tex = this.textures.get(img.texture.key).getSourceImage();
    const tw = tex && tex.width ? tex.width : w;
    const th = tex && tex.height ? tex.height : h;
    img.setScale(w / tw, h / th);
  }

  adjustBallSetting(delta) {
    this.ballSetting = Phaser.Math.Clamp(this.ballSetting + delta, MIN_BALLS, MAX_BALLS);
  }

  // Enter でデモ→プレイ開始: スコア/盤面/ボールを初期化して操作を有効化
  restart() {
    this.score = 0;
    this.lost = 0;
    this.ballSetting = INITIAL_BALLS;
    this.paddle.x = GAME_WIDTH / 2;
    // 全ボールを片付けてから盤面・ボールを作り直す
    for (const b of this.balls.getChildren()) this.killObject(b);
    this.buildBrickField();
    this.fillBalls();
  }

  startGame() {
    this.started = true;
    this.restart();
    if (this.titleEl) this.titleEl.style.display = 'none';
  }

  // ===== ブロック盤面の生成（15列 × 9行）=====
  buildBrickField() {
    // 既存ブロックをすべて非アクティブ化（プールごと作り直さず再利用）
    for (const b of this.bricks.getChildren()) {
      this.killObject(b);
    }

    // グリッド全幅から左右マージンを算出して中央寄せ
    const gridW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    const startX = (GAME_WIDTH - gridW) / 2;

    for (let row = 0; row < BRICK_ROWS; row++) {
      // 行帯で HP を決定（上3行=3 / 中3行=2 / 下3行=1）
      const hp = row < 3 ? 3 : (row < 6 ? 2 : 1);
      const cy = BRICK_TOP + row * (BRICK_H + BRICK_GAP) + BRICK_H / 2;

      for (let col = 0; col < BRICK_COLS; col++) {
        const cx = startX + col * (BRICK_W + BRICK_GAP) + BRICK_W / 2;
        this.spawnBrick(cx, cy, hp);
      }
    }
  }

  spawnBrick(cx, cy, hp) {
    let br = this.bricks.getFirstDead(false);
    if (!br) {
      br = this.add.image(cx, cy, 'brick').setDepth(3);
      this.bricks.add(br);
    } else {
      br.setActive(true).setVisible(true);
      br.setPosition(cx, cy);
    }
    // 56x20 の見た目に合わせる（near-white テクスチャを tint）
    br.setScale(BRICK_W / this.brickTexW, BRICK_H / this.brickTexH);
    br.hp = hp;
    br.setTint(HP_TINT[hp]);
    // AABB 判定用に矩形半幅/半高を保持
    br.halfW = BRICK_W / 2;
    br.halfH = BRICK_H / 2;
    return br;
  }

  // ===== ボールの補充（同時ボール数を設定値に維持）=====
  fillBalls() {
    let active = this.balls.countActive(true);
    while (active < this.ballSetting) {
      this.spawnBall();
      active++;
    }
  }

  // パドル上から上方向ランダム角で発射
  spawnBall() {
    const x = this.paddle.x;
    const y = PADDLE_Y - PADDLE_HEIGHT / 2 - BALL_RADIUS - 1;

    let b = this.balls.getFirstDead(false);
    if (!b) {
      b = this.add.image(x, y, 'ball').setDepth(4);
      this.balls.add(b);
    } else {
      b.setActive(true).setVisible(true);
      b.setPosition(x, y);
    }
    // 16x16 テクスチャを半径8(=直径16)相当に
    this.scaleToSize(b, BALL_RADIUS * 2, BALL_RADIUS * 2);
    b.radius = BALL_RADIUS;

    // 上方向に ±60° のランダム角（-90° が真上）
    const angDeg = -90 + Phaser.Math.Between(-LAUNCH_ANGLE_DEG, LAUNCH_ANGLE_DEG);
    const ang = Phaser.Math.DegToRad(angDeg);
    b.vx = Math.cos(ang) * BALL_SPEED;
    b.vy = Math.sin(ang) * BALL_SPEED;
    return b;
  }

  spawnSpark(x, y) {
    let s = this.effects.getFirstDead(false);
    if (!s) {
      s = this.add.image(x, y, 'hit_spark').setDepth(6);
      this.effects.add(s);
    } else {
      s.setActive(true).setVisible(true);
      s.setPosition(x, y);
    }
    s.life = 200; // ms 表示
    s.setScale(0.6);
    s.setAlpha(1);
    return s;
  }

  killObject(obj) {
    obj.setActive(false).setVisible(false);
  }

  // ===== 更新ループ（デルタタイム基準） =====
  update(time, delta) {
    const dt = delta / 1000; // 秒

    // FPS移動平均（直近30フレーム）
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0;
    for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    this.updatePaddle(dt);
    this.updateBalls(dt);
    this.updateEffects(delta);

    // 同時ボール数を設定値に維持
    this.fillBalls();

    this.updateHUD();

    // タイトル点滅 (アトラクト中のみ)
    if (!this.started && this.titleEl) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  }

  updatePaddle(dt) {
    let dx = 0;
    if (!this.started) {
      // デモAI: 最も下(最大y)のアクティブなボールの x へパドルを追従させる(速度上限内で)
      let target = this.paddle.x, lowestY = -Infinity;
      for (const b of this.balls.getChildren()) {
        if (!b.active) continue;
        if (b.y > lowestY) { lowestY = b.y; target = b.x; }
      }
      const diff = target - this.paddle.x;
      if (Math.abs(diff) > 1) dx = diff > 0 ? 1 : -1;
    } else {
      if (this.cursors.left.isDown || this.keys.A.isDown) dx -= 1;
      if (this.cursors.right.isDown || this.keys.D.isDown) dx += 1;
    }

    this.paddle.x += dx * PADDLE_SPEED * dt;

    // 画面内クランプ（パドル左右端が画面外に出ないように）
    const half = PADDLE_WIDTH / 2;
    this.paddle.x = Phaser.Math.Clamp(this.paddle.x, half, GAME_WIDTH - half);
  }

  // ボールの移動・壁/天井/パドル反射・ブロック衝突をまとめて処理
  updateBalls(dt) {
    const paddleHalfW = PADDLE_WIDTH / 2;
    const paddleHalfH = PADDLE_HEIGHT / 2;
    const paddleTop = PADDLE_Y - paddleHalfH;

    const list = this.balls.getChildren();
    for (const b of list) {
      if (!b.active) continue;

      // 位置更新（デルタタイム基準）
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const r = b.radius;

      // 左右の壁で反射
      if (b.x < r) {
        b.x = r;
        b.vx = Math.abs(b.vx);
      } else if (b.x > GAME_WIDTH - r) {
        b.x = GAME_WIDTH - r;
        b.vx = -Math.abs(b.vx);
      }

      // 天井で反射
      if (b.y < r) {
        b.y = r;
        b.vy = Math.abs(b.vy);
      }

      // パドルで反射（常に上方向。中心からのオフセットで角度を変える）
      if (b.vy > 0 &&
          b.y + r >= paddleTop &&
          b.y - r <= PADDLE_Y + paddleHalfH &&
          b.x >= this.paddle.x - paddleHalfW - r &&
          b.x <= this.paddle.x + paddleHalfW + r) {
        this.reflectPaddle(b, paddleTop);
      }

      // 下端を抜けたらロスト → パドル上から再発射（同時ボール数を維持）
      if (b.y - r > GAME_HEIGHT) {
        this.lost++;
        this.killObject(b);
        // fillBalls() が次フレームで補充するが、即時に揃えても良い。
        // ここでは即時に1個再発射して負荷を一定に保つ。
        this.respawnFromPaddle(b);
        continue;
      }

      // ブロックとの衝突（1ボールにつき1フレーム1ブロックまで）
      this.collideBallBricks(b);
    }
  }

  // パドル反射: 当たり位置のオフセットで反射角を決め、速さ380に再正規化して上方向へ
  reflectPaddle(b, paddleTop) {
    // ボールをパドル上面に押し戻す
    b.y = paddleTop - b.radius;
    // 中心からのオフセット [-1, 1]
    const offset = Phaser.Math.Clamp((b.x - this.paddle.x) / (PADDLE_WIDTH / 2), -1, 1);
    // 端ほど横に鋭く（最大75°）。常に上方向。
    const maxDeg = 75;
    const angDeg = -90 + offset * maxDeg;
    const ang = Phaser.Math.DegToRad(angDeg);
    b.vx = Math.cos(ang) * BALL_SPEED;
    b.vy = Math.sin(ang) * BALL_SPEED;
  }

  // 下端ロスト時のパドル上からの再発射（同じオブジェクトを再利用）
  respawnFromPaddle(b) {
    b.setActive(true).setVisible(true);
    b.setPosition(this.paddle.x, PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius - 1);
    const angDeg = -90 + Phaser.Math.Between(-LAUNCH_ANGLE_DEG, LAUNCH_ANGLE_DEG);
    const ang = Phaser.Math.DegToRad(angDeg);
    b.vx = Math.cos(ang) * BALL_SPEED;
    b.vy = Math.sin(ang) * BALL_SPEED;
  }

  // ===== AABB(矩形)×円（最近点）判定によるブロック衝突 =====
  collideBallBricks(b) {
    const r = b.radius;
    const bricks = this.bricks.getChildren();

    for (const br of bricks) {
      if (!br.active) continue;

      // 矩形の範囲（中心 + 半幅/半高）
      const left = br.x - br.halfW;
      const right = br.x + br.halfW;
      const top = br.y - br.halfH;
      const bottom = br.y + br.halfH;

      // 円中心から矩形への最近点
      const nx = Phaser.Math.Clamp(b.x, left, right);
      const ny = Phaser.Math.Clamp(b.y, top, bottom);
      const dx = b.x - nx;
      const dy = b.y - ny;

      // 最近点までの距離が半径以下なら衝突
      if (dx * dx + dy * dy > r * r) continue;

      // 当たった面を判定して速度を反転。
      // 矩形内部にめり込んだ（dx=dy=0）場合は貫入量の小さい軸で押し戻す。
      if (dx === 0 && dy === 0) {
        const overlapX = br.halfW + r - Math.abs(b.x - br.x);
        const overlapY = br.halfH + r - Math.abs(b.y - br.y);
        if (overlapX < overlapY) {
          b.vx = (b.x < br.x ? -Math.abs(b.vx) : Math.abs(b.vx));
        } else {
          b.vy = (b.y < br.y ? -Math.abs(b.vy) : Math.abs(b.vy));
        }
      } else if (Math.abs(dx) > Math.abs(dy)) {
        // 左右面 = vx 反転
        b.vx = (dx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx));
      } else {
        // 上下面 = vy 反転
        b.vy = (dy > 0 ? Math.abs(b.vy) : -Math.abs(b.vy));
      }

      // ブロックの HP を減らし、0 で破壊
      br.hp -= 1;
      if (br.hp <= 0) {
        this.spawnSpark(br.x, br.y);
        this.killObject(br);
        this.score += SCORE_PER_BRICK;
        // 全ブロック破壊で盤面を再生成（ベンチ継続）
        if (this.bricks.countActive(true) === 0) {
          this.buildBrickField();
        }
      } else {
        // HP に応じて色を更新
        br.setTint(HP_TINT[br.hp]);
      }

      // 1ボールにつき1フレーム1ブロックまで
      break;
    }
  }

  updateEffects(delta) {
    const list = this.effects.getChildren();
    for (const s of list) {
      if (!s.active) continue;
      s.life -= delta;
      s.setScale(s.scaleX + 0.004 * delta);
      s.setAlpha(Math.max(0, s.life / 200));
      if (s.life <= 0) this.killObject(s);
    }
  }

  updateHUD() {
    const ballCount = this.balls.countActive(true);
    const brickCount = this.bricks.countActive(true);
    const effectCount = this.effects.countActive(true);
    // Objects = ボール + 残ブロック + エフェクト
    const objCount = ballCount + brickCount + effectCount;

    // 表示内容・書式は three.js に統一
    this.hudEl.textContent =
      `FPS     : ${this.fpsAvg.toFixed(1)}\n` +
      `Objects : ${objCount}  (ball ${ballCount} / brick ${brickCount} / fx ${effectCount})\n` +
      `Score   : ${this.score}\n` +
      `Balls   : ${ballCount} / ${this.ballSetting}  (+/- to change, 1..${MAX_BALLS})\n` +
      `Bricks  : ${brickCount}\n` +
      `Lost    : ${this.lost}`;
  }
}

// ===== Phaser 設定 =====
const config = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-container',
  backgroundColor: '#0a0e1a',
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
