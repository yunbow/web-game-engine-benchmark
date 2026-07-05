/* ============================================================================
 * ブロック崩し (マルチボール Breakout) - KAPLAY 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリ。以下はライブラリ機構を使う:
 *   - ゲームループ (onUpdate / dt())
 *   - 入力 (isKeyDown / onKeyPress)
 *   - スプライト/図形描画 (add([...comps]))
 *   - 座標系は Y 下向き・原点左上 = 画面座標とそのまま一致 (座標変換不要)
 * ただし当たり判定は SPEC 準拠の「自前 AABB(矩形) × 円(最近点) 判定」を使う
 * (KAPLAY の area()/onCollide は使わず、他エンジンと条件を揃える)。
 * ※物理エンジンは使わない。すべて自前の数式で処理する。
 * ========================================================================== */

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

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
const SPARK_LIFE = 0.22;           // 破壊エフェクト表示時間 秒 (= 220ms)

// HP ごとの tint 色 (明色テクスチャに乗算): HP3=赤 / HP2=橙 / HP1=緑
const HP_TINT = { 3: [255, 68, 68], 2: [255, 162, 58], 1: [85, 204, 102] };

const ASSET_DEFS = {
  paddle:      '../assets/paddle.png',
  ball:        '../assets/ball.png',
  brick:       '../assets/brick.png',
  hit_spark:   '../assets/hit_spark.png',
  bg_breakout: '../assets/bg_breakout.png',
};

const rand = (a, b) => a + Math.random() * (b - a);
const clampv = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: W, height: H,
  canvas: document.getElementById('game-canvas'),
  background: [10, 13, 26],
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

function start() {
  // --- 背景: bg画像があればタイル、無ければ暗色 + 星 ---
  const stars = [];
  if (loaded.bg_breakout) {
    // タイル背景 (512x512 を敷き詰め)
    for (let ty = 0; ty < H; ty += 512) {
      for (let tx = 0; tx < W; tx += 512) {
        const t = k.add([k.sprite('bg_breakout'), k.pos(tx, ty), k.anchor('topleft')]);
        t.width = 512; t.height = 512;
      }
    }
  } else {
    for (let i = 0; i < 160; i++) {
      stars.push({ x: k.rand(0, W), y: k.rand(0, H), r: k.rand(0.3, 1.8), a: k.rand(0.15, 0.75) });
    }
    k.onDraw(() => {
      for (const s of stars) k.drawCircle({ pos: k.vec2(s.x, s.y), radius: s.r, color: k.rgb(255, 255, 255), opacity: s.a });
    });
  }

  // --- パドル ---
  const paddle = {
    obj: null,
    x: W / 2,          // 中心 x
    y: PADDLE_Y,       // 中心 y (固定)
  };
  if (loaded.paddle) {
    paddle.obj = k.add([k.sprite('paddle'), k.anchor('center'), k.pos(paddle.x, paddle.y)]);
    paddle.obj.width = PADDLE_W; paddle.obj.height = PADDLE_H;
  } else {
    paddle.obj = k.add([k.rect(PADDLE_W, PADDLE_H, { radius: 9 }), k.color(255, 255, 255), k.anchor('center'), k.pos(paddle.x, paddle.y)]);
  }

  // --- エンティティ配列 (自前管理) ---
  const balls = [];    // {obj,x,y,vx,vy}
  const bricks = [];   // {obj,x,y,hp}  ※x,y はブロック左上
  const effects = [];  // {obj,life,max}

  // --- ゲーム状態 ---
  let score = 0;
  let lost = 0;                     // 下端を抜けたボール数 (累計)
  let ballSetting = INITIAL_BALLS;  // 設定上の同時ボール数
  let started = false, blinkT = 0;  // タイトル/アトラクト状態（false=デモ中・操作無効）
  const titleEl = document.getElementById('title');

  // Enter でデモ→プレイ開始: スコア/盤面/ボールを初期化して操作を有効化
  function restart() {
    score = 0; lost = 0; ballSetting = INITIAL_BALLS;
    paddle.x = W / 2; paddle.obj.pos.x = paddle.x;
    buildBricks();
    syncBallCount();
  }
  function startGame() { started = true; restart(); titleEl.style.display = 'none'; }

  // ボール生成 (パドル上から上方向へ ±60° のランダム角で発射)
  function makeBall() {
    let obj;
    if (loaded.ball) {
      obj = k.add([k.sprite('ball'), k.anchor('center'), k.pos(paddle.x, paddle.y - PADDLE_H)]);
      obj.width = BALL_R * 2; obj.height = BALL_R * 2;
    } else {
      obj = k.add([k.circle(BALL_R), k.color(255, 255, 255), k.anchor('center'), k.pos(paddle.x, paddle.y - PADDLE_H)]);
    }
    const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
    const a = (-90 + deg) * Math.PI / 180;
    const b = {
      obj,
      x: paddle.x,
      y: paddle.y - PADDLE_H,            // パドルのすぐ上
      vx: Math.cos(a) * BALL_SPEED,
      vy: Math.sin(a) * BALL_SPEED,
    };
    balls.push(b);
    return b;
  }

  // 設定値に合わせてボール数を増減する。
  function syncBallCount() {
    while (balls.length < ballSetting) makeBall();
    while (balls.length > ballSetting) {
      const b = balls.pop();
      k.destroy(b.obj);
    }
  }

  // ブロックの色付け (HP色)。スプライトは tint、図形は color を更新。
  function tintBrick(br) {
    const c = HP_TINT[br.hp];
    if (loaded.brick) br.obj.color = k.rgb(c[0], c[1], c[2]); // sprite に tint (乗算)
    else br.obj.color = k.rgb(c[0], c[1], c[2]);
  }

  // ブロック盤面の生成 (15列 × 9行)
  function buildBricks() {
    for (const br of bricks) k.destroy(br.obj);
    bricks.length = 0;

    // グリッド全体を水平方向に中央寄せ
    const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    const startX = (W - totalW) / 2;

    for (let row = 0; row < BRICK_ROWS; row++) {
      // 上3行=HP3 / 中3行=HP2 / 下3行=HP1
      const hp = row < 3 ? 3 : row < 6 ? 2 : 1;
      for (let col = 0; col < BRICK_COLS; col++) {
        const x = startX + col * (BRICK_W + BRICK_GAP);
        const y = BRICK_TOP + row * (BRICK_H + BRICK_GAP);
        let obj;
        if (loaded.brick) {
          obj = k.add([k.sprite('brick'), k.anchor('topleft'), k.pos(x, y)]);
          obj.width = BRICK_W; obj.height = BRICK_H;
        } else {
          obj = k.add([k.rect(BRICK_W, BRICK_H, { radius: 4 }), k.color(255, 255, 255), k.anchor('topleft'), k.pos(x, y)]);
        }
        const br = { obj, x, y, hp };
        tintBrick(br);
        bricks.push(br);
      }
    }
  }

  // 破壊エフェクト (hit_spark を一瞬表示)
  function spawnSpark(x, y) {
    let obj;
    if (loaded.hit_spark) {
      obj = k.add([k.sprite('hit_spark'), k.anchor('center'), k.pos(x, y), k.opacity(1)]);
      obj.width = 28; obj.height = 28;
    } else {
      obj = k.add([k.circle(14), k.color(255, 210, 58), k.anchor('center'), k.pos(x, y), k.opacity(1)]);
    }
    effects.push({ obj, life: SPARK_LIFE, max: SPARK_LIFE });
  }

  // 配列から要素を除去し obj を破棄 (末尾スワップで O(1))
  function removeAt(arr, i) {
    k.destroy(arr[i].obj);
    arr[i] = arr[arr.length - 1];
    arr.pop();
  }

  // 速さを BALL_SPEED に正規化 (反射後に速度が変わらないよう一定に保つ)
  function renormSpeed(b) {
    const len = Math.hypot(b.vx, b.vy) || 1;
    b.vx = (b.vx / len) * BALL_SPEED;
    b.vy = (b.vy / len) * BALL_SPEED;
  }

  // --- 入力: 同時ボール数調整 (+/-) ---
  k.onKeyPress(['=', 'kpadd'], () => { ballSetting = clampv(ballSetting + BALL_STEP, BALL_MIN, BALL_MAX); syncBallCount(); });
  k.onKeyPress(['minus', 'kpsubtract'], () => { ballSetting = clampv(ballSetting - BALL_STEP, BALL_MIN, BALL_MAX); syncBallCount(); });
  // --- 入力: Enter でデモ→プレイ開始 ---
  k.onKeyPress('enter', () => { if (!started) startGame(); });

  // --- 初期化 ---
  buildBricks();
  syncBallCount();

  // --- FPS 移動平均 + HUD ---
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;

  k.onUpdate(() => {
    const dt = k.dt();
    const dtMs = dt * 1000;
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // --- パドル移動 (水平のみ + クランプ) ---
    let mx = 0;
    if (!started) {
      // デモAI: 最も下(最大y)のボールの x へパドルを追従させる(速度上限内で)
      let target = paddle.x, lowestY = -Infinity;
      for (let i = 0; i < balls.length; i++) { if (balls[i].y > lowestY) { lowestY = balls[i].y; target = balls[i].x; } }
      const diff = target - paddle.x;
      if (Math.abs(diff) > 1) mx = diff > 0 ? 1 : -1;
    } else {
      if (k.isKeyDown('left') || k.isKeyDown('a')) mx -= 1;
      if (k.isKeyDown('right') || k.isKeyDown('d')) mx += 1;
    }
    paddle.x = clampv(paddle.x + mx * PADDLE_SPEED * dt, PADDLE_W / 2, W - PADDLE_W / 2);
    paddle.obj.pos.x = paddle.x;

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
        const off = clampv((b.x - paddle.x) / (PADDLE_W / 2), -1, 1);
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
        const nx = clampv(b.x, br.x, br.x + BRICK_W);
        const ny = clampv(b.y, br.y, br.y + BRICK_H);
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
            tintBrick(br); // HP に応じて色を更新
          }
          break; // 1フレーム1ブロックまで
        }
      }

      // obj 位置を反映
      b.obj.pos.x = b.x;
      b.obj.pos.y = b.y;
    }

    // --- 全ブロック破壊で盤面を再生成 (ベンチ継続) ---
    if (bricks.length === 0) buildBricks();

    // --- エフェクト更新 (フェードアウト + 膨張) ---
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      f.life -= dt;
      const t = f.life / f.max;
      f.obj.opacity = clampv(t, 0, 1);
      f.obj.scale = k.vec2((1 - t) * 0.6 + 1);
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

  console.log('KAPLAY Breakout started.');
}
