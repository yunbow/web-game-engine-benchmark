/* ============================================================================
 * ブロック崩し (マルチボール Breakout) - PixiJS v8 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * PixiJS は描画ライブラリなので、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker のデルタタイムを利用)
 *   - キーボード入力
 *   - 位置更新 / 壁・天井・パドルでの反射
 *   - AABB(矩形) × 円(最近点) の当たり判定
 *   - ボール / ブロック / エフェクトの配列管理
 *
 * ※物理エンジンは使わない。すべて自前の数式で処理する。
 * ========================================================================== */

// ---- 定数 (SPEC) -----------------------------------------------------------
const W = 960;
const H = 540;

// パドル
const PADDLE_W = 96;               // パドル幅
const PADDLE_H = 18;               // パドル高さ
const PADDLE_Y = 510;              // パドル中心 y (固定)
const PADDLE_SPEED = 600;          // パドル移動速度 px/s

// ボール
const BALL_R = 8;                  // ボール半径
const BALL_SPEED = 380;            // ボール速さ px/s (一定)
const LAUNCH_ANGLE = 60;           // 発射角の左右ばらつき (度, 上方向 ±)

// ブロック (グリッド)
const BRICK_COLS = 15;             // 列
const BRICK_ROWS = 9;              // 行 (上3=HP3 / 中3=HP2 / 下3=HP1)
const BRICK_W = 56;                // ブロック幅
const BRICK_H = 20;                // ブロック高さ
const BRICK_GAP = 4;               // ブロック間の隙間
const BRICK_TOP = 60;              // 上オフセット

// 同時ボール数 (負荷)
const INITIAL_BALLS = 3;           // 初期同時ボール数
const BALL_STEP = 5;               // +/- の増減
const BALL_MIN = 1;                // 下限
const BALL_MAX = 500;              // 上限

const SCORE_PER_BRICK = 10;        // ブロック破壊スコア
const SPARK_LIFE = 220;            // 破壊エフェクト表示時間 ms

// HP ごとの tint 色 (明色テクスチャに乗算)
const HP_TINT = { 3: 0xff4444, 2: 0xffa23a, 1: 0x55cc66 };

// アセット (SPEC のファイル名に厳密一致)。../assets/ から読む。
const ASSET_DEFS = {
  paddle:    '../assets/paddle.png',
  ball:      '../assets/ball.png',
  brick:     '../assets/brick.png',
  hit_spark: '../assets/hit_spark.png',
  bg_breakout: '../assets/bg_breakout.png',
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
    background: '#0a0d1a',
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
  function texPaddle() {
    if (textures.paddle) return textures.paddle;
    // 白い角丸 (tint しないのでそのまま白)
    return makeFallbackTexture('paddle', g => {
      g.roundRect(0, 0, PADDLE_W, PADDLE_H, 9).fill(0xffffff);
    }, PADDLE_W, PADDLE_H);
  }
  function texBall() {
    if (textures.ball) return textures.ball;
    // 白い円
    return makeFallbackTexture('ball', g => {
      g.circle(BALL_R, BALL_R, BALL_R).fill(0xffffff);
    }, BALL_R * 2, BALL_R * 2);
  }
  function texBrick() {
    if (textures.brick) return textures.brick;
    // ほぼ白い矩形 (HP色で tint 乗算するため明色にしておく)
    return makeFallbackTexture('brick', g => {
      g.roundRect(0, 0, BRICK_W, BRICK_H, 4).fill(0xffffff);
    }, BRICK_W, BRICK_H);
  }
  function texSpark() {
    if (textures.hit_spark) return textures.hit_spark;
    // 黄色いバースト (中心ほど明るい)
    return makeFallbackTexture('spark', g => {
      g.circle(16, 16, 15).fill({ color: 0xffd23a, alpha: 0.9 });
      g.circle(16, 16, 7).fill(0xffffff);
    }, 32, 32);
  }

  // === 背景 (タイル or 暗色 + 星) =========================================
  const stage = app.stage;
  if (textures.bg_breakout) {
    const bg = new PIXI.TilingSprite({ texture: textures.bg_breakout, width: W, height: H });
    stage.addChild(bg);
  } else {
    // フォールバック: 星を散らした暗色背景 (一度だけ描画)
    const starG = new PIXI.Graphics();
    for (let i = 0; i < 160; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      const r = Math.random() * 1.5 + 0.3;
      starG.circle(x, y, r).fill({ color: 0xffffff, alpha: Math.random() * 0.6 + 0.15 });
    }
    stage.addChild(starG);
  }

  // 描画コンテナ (重ね順): ブロック → ボール → エフェクト → パドル
  const brickLayer = new PIXI.Container();
  const ballLayer = new PIXI.Container();
  const fxLayer = new PIXI.Container();
  const paddleLayer = new PIXI.Container();
  stage.addChild(brickLayer, ballLayer, fxLayer, paddleLayer);

  // === パドル =============================================================
  const paddle = {
    sprite: new PIXI.Sprite(texPaddle()),
    x: W / 2,          // 中心 x
    y: PADDLE_Y,       // 中心 y (固定)
  };
  paddle.sprite.anchor.set(0.5);
  paddle.sprite.width = PADDLE_W;
  paddle.sprite.height = PADDLE_H;
  paddle.sprite.x = paddle.x;
  paddle.sprite.y = paddle.y;
  paddleLayer.addChild(paddle.sprite);

  // === エンティティ管理 (シンプルな配列 + Sprite) ========================
  const balls = [];    // {sprite,x,y,vx,vy}
  const bricks = [];    // {sprite,x,y,hp}  ※x,y はブロック左上
  const effects = [];   // {sprite,life,max}

  // === ゲーム状態 =========================================================
  let score = 0;
  let lost = 0;                     // 下端を抜けたボール数 (累計)
  let ballSetting = INITIAL_BALLS;  // 設定上の同時ボール数
  let started = false, blinkT = 0;  // タイトル/アトラクト状態（false=デモ中・操作無効）
  const titleEl = document.getElementById('title');

  // Enter でデモ→プレイ開始: スコア/盤面/ボールを初期化して操作を有効化
  function restart() {
    score = 0; lost = 0; ballSetting = INITIAL_BALLS;
    paddle.x = W / 2; paddle.sprite.x = paddle.x;
    buildBricks();
    syncBallCount();
  }
  function startGame() { started = true; restart(); titleEl.style.display = 'none'; }

  // === ボール生成 (パドル上から上方向へ ±60° のランダム角で発射) =========
  function makeBall() {
    const sp = new PIXI.Sprite(texBall());
    sp.anchor.set(0.5);
    sp.width = BALL_R * 2;
    sp.height = BALL_R * 2;
    // 上方向(-90°)を基準に左右 ±LAUNCH_ANGLE 度ずらす
    const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
    const a = (-90 + deg) * Math.PI / 180;
    const b = {
      sprite: sp,
      x: paddle.x,
      y: paddle.y - PADDLE_H,            // パドルのすぐ上
      vx: Math.cos(a) * BALL_SPEED,
      vy: Math.sin(a) * BALL_SPEED,
    };
    sp.x = b.x; sp.y = b.y;
    ballLayer.addChild(sp);
    balls.push(b);
    return b;
  }

  // 設定値に合わせてボール数を増減する。
  function syncBallCount() {
    while (balls.length < ballSetting) makeBall();
    while (balls.length > ballSetting) {
      const b = balls.pop();
      b.sprite.destroy();
    }
  }

  // === ブロック盤面の生成 (15列 × 9行) ===================================
  function buildBricks() {
    // 既存ブロックを破棄
    for (const br of bricks) br.sprite.destroy();
    bricks.length = 0;

    // グリッド全体を水平方向に中央寄せ
    const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    const startX = (W - totalW) / 2;

    for (let row = 0; row < BRICK_ROWS; row++) {
      // 上3行=HP3 / 中3行=HP2 / 下3行=HP1
      const hp = row < 3 ? 3 : row < 6 ? 2 : 1;
      for (let col = 0; col < BRICK_COLS; col++) {
        const sp = new PIXI.Sprite(texBrick());
        sp.width = BRICK_W;
        sp.height = BRICK_H;
        const x = startX + col * (BRICK_W + BRICK_GAP);
        const y = BRICK_TOP + row * (BRICK_H + BRICK_GAP);
        sp.x = x; sp.y = y;
        sp.tint = HP_TINT[hp];          // HP に応じて色付け (明色テクスチャに乗算)
        brickLayer.addChild(sp);
        bricks.push({ sprite: sp, x, y, hp });
      }
    }
  }

  // === 破壊エフェクト (hit_spark を一瞬表示) ==============================
  function spawnSpark(x, y) {
    const sp = new PIXI.Sprite(texSpark());
    sp.anchor.set(0.5);
    sp.width = 28; sp.height = 28;
    sp.x = x; sp.y = y;
    fxLayer.addChild(sp);
    effects.push({ sprite: sp, life: SPARK_LIFE, max: SPARK_LIFE });
  }

  // 配列から要素を除去し sprite を破棄 (末尾スワップで O(1))
  function removeAt(arr, i) {
    const o = arr[i];
    o.sprite.destroy();
    arr[i] = arr[arr.length - 1];
    arr.pop();
  }

  // 速さを BALL_SPEED に正規化 (反射後に速度が変わらないよう一定に保つ)
  function renormSpeed(b) {
    const len = Math.hypot(b.vx, b.vy) || 1;
    b.vx = (b.vx / len) * BALL_SPEED;
    b.vy = (b.vy / len) * BALL_SPEED;
  }

  // === 入力 (自前) ========================================================
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Enter でデモ→プレイ開始
    if (e.key === 'Enter' && !started) { startGame(); e.preventDefault(); }
    // 同時ボール数調整 (+/-) : テンキー含む各種コードに対応
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      ballSetting = clamp(ballSetting + BALL_STEP, BALL_MIN, BALL_MAX);
      syncBallCount();
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      ballSetting = clamp(ballSetting - BALL_STEP, BALL_MIN, BALL_MAX);
      syncBallCount();
      e.preventDefault();
    }
    // スクロール抑制 (矢印)
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...codes) => codes.some(c => keys[c]);

  // === 初期化 =============================================================
  buildBricks();
  syncBallCount();

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

    // --- パドル移動 (水平のみ + クランプ) ---
    let mx = 0;
    if (!started) {
      // デモAI: 最も下(最大y)のボールの x へパドルを追従させる(速度上限内で)
      let target = paddle.x, lowestY = -Infinity;
      for (let i = 0; i < balls.length; i++) { if (balls[i].y > lowestY) { lowestY = balls[i].y; target = balls[i].x; } }
      const diff = target - paddle.x;
      if (Math.abs(diff) > 1) mx = diff > 0 ? 1 : -1;
    } else {
      if (down('ArrowLeft', 'KeyA')) mx -= 1;
      if (down('ArrowRight', 'KeyD')) mx += 1;
    }
    paddle.x = clamp(paddle.x + mx * PADDLE_SPEED * dt, PADDLE_W / 2, W - PADDLE_W / 2);
    paddle.sprite.x = paddle.x;

    // パドルの当たり矩形 (中心基準)
    const padL = paddle.x - PADDLE_W / 2;
    const padR = paddle.x + PADDLE_W / 2;
    const padT = paddle.y - PADDLE_H / 2;
    const padB = paddle.y + PADDLE_H / 2;

    // --- ボール更新 (移動 → 壁/天井/パドル反射 → ブロック判定) ---
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // 左右の壁で反射 (めり込み補正付き)
      if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
      else if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }

      // 天井で反射
      if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

      // パドルで反射 (常に上方向へ。中心からのオフセットで反射角を変える)
      if (b.vy > 0 &&
          b.x + BALL_R > padL && b.x - BALL_R < padR &&
          b.y + BALL_R > padT && b.y - BALL_R < padB) {
        // 中心からの相対位置 -1..+1 (端ほど横へ鋭く)
        const off = clamp((b.x - paddle.x) / (PADDLE_W / 2), -1, 1);
        const a = (-90 + off * LAUNCH_ANGLE) * Math.PI / 180;
        b.vx = Math.cos(a) * BALL_SPEED;
        b.vy = Math.sin(a) * BALL_SPEED;   // 必ず上向き (sin が負)
        b.y = padT - BALL_R;                // パドル上面に押し戻す
      }

      // 下端を抜けたらロスト → パドル上から再発射 (数を維持)
      if (b.y - BALL_R > H) {
        lost++;
        const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
        const a = (-90 + deg) * Math.PI / 180;
        b.x = paddle.x;
        b.y = paddle.y - PADDLE_H;
        b.vx = Math.cos(a) * BALL_SPEED;
        b.vy = Math.sin(a) * BALL_SPEED;
      }

      // --- ボール × ブロック (AABB矩形 × 円, 最近点) ---
      // 1ボール 1フレーム 1ブロックまで (最初の命中で break)。
      for (let j = bricks.length - 1; j >= 0; j--) {
        const br = bricks[j];
        // 矩形内でボール中心に最も近い点
        const nx = clamp(b.x, br.x, br.x + BRICK_W);
        const ny = clamp(b.y, br.y, br.y + BRICK_H);
        const dx = b.x - nx;
        const dy = b.y - ny;
        if (dx * dx + dy * dy <= BALL_R * BALL_R) {
          // 当たった面を判定: 矩形中心からの相対 + ボール半径で
          // どちらの軸の侵入が深いかで vx / vy のどちらを反転するか決める。
          const bcx = br.x + BRICK_W / 2;
          const bcy = br.y + BRICK_H / 2;
          const ox = (BRICK_W / 2 + BALL_R) - Math.abs(b.x - bcx); // x方向の重なり量
          const oy = (BRICK_H / 2 + BALL_R) - Math.abs(b.y - bcy); // y方向の重なり量
          if (ox < oy) {
            // 左右の面に当たった → vx 反転
            b.vx = (b.x < bcx) ? -Math.abs(b.vx) : Math.abs(b.vx);
          } else {
            // 上下の面に当たった → vy 反転
            b.vy = (b.y < bcy) ? -Math.abs(b.vy) : Math.abs(b.vy);
          }
          renormSpeed(b); // 反射で速さがぶれないよう一定に保つ

          // HP-1。0 になったら破壊して加点 + エフェクト
          br.hp -= 1;
          if (br.hp <= 0) {
            spawnSpark(bcx, bcy);
            removeAt(bricks, j);
            score += SCORE_PER_BRICK;
          } else {
            br.sprite.tint = HP_TINT[br.hp]; // HP に応じて色を更新
          }
          break; // 1フレーム1ブロックまで
        }
      }

      // スプライト位置を反映
      b.sprite.x = b.x;
      b.sprite.y = b.y;
    }

    // --- 全ブロック破壊で盤面を再生成 (ベンチ継続) ---
    if (bricks.length === 0) buildBricks();

    // --- エフェクト更新 (フェードアウト + 膨張) ---
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      f.life -= dtMs;
      const t = f.life / f.max;
      f.sprite.alpha = clamp(t, 0, 1);
      f.sprite.scale.set((1 - t) * 0.6 + 1);
      if (f.life <= 0) removeAt(effects, i);
    }

    // --- HUD 更新 (約120msに1回) ---
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const objects = balls.length + bricks.length + effects.length;
      hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Objects : ${objects}  (ball ${balls.length} / brick ${bricks.length} / fx ${effects.length})\n` +
        `Score   : ${score}\n` +
        `Balls   : ${balls.length} / ${ballSetting}  (+/- to change, 1..${BALL_MAX})\n` +
        `Bricks  : ${bricks.length}\n` +
        `Lost    : ${lost}`;
    }

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('PixiJS Breakout started. renderer:',
    app.renderer.type === PIXI.RendererType.WEBGPU ? 'WebGPU' : 'WebGL/Canvas');
})();
