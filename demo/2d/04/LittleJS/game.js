'use strict';

/*
  ブロック崩し (マルチボール Breakout) - LittleJS 実装
  仕様書: ../SPEC.md に厳密準拠。

  座標系メモ (重要):
    LittleJS のワールドは Y が上向き。
    cameraScale = 1 (1 ワールド単位 = 1px), camera 中心 = (480, 270)。
    よって可視範囲は x:[0,960], y:[0,540]。ただし Y は上向きなので
    ワールド Y=0 が画面下端、ワールド Y=540 が画面上端になる。

    本実装はゲームロジックを「画面座標 (左上原点・y 下向き)」の内部モデルで
    持ち、描画する瞬間だけ Y を反転する:
        worldY = SCREEN_H - screenY
    変換は toWorld(sx, sy) に集約 (drawTile/drawRect/drawCircle/drawLine へ渡す座標は
    すべてこれを通す)。当たり判定・反射・速度はすべて画面座標 (y 下向き) で計算する。
      - パドルは下部 (screenY=510)
      - ブロックは上部 (screenY=60〜) に配置
      - ボールが下端 (screenY > 540 + r) を抜けたらロスト
*/

// ---- 画面・定数 (SPEC) ----
const SCREEN_W = 960;
const SCREEN_H = 540;

// パドル
const PADDLE_W = 96;               // 幅
const PADDLE_H = 18;               // 高さ
const PADDLE_Y = 510;              // 中心 y (画面座標) 固定
const PADDLE_SPEED = 600;          // 移動速度 px/s

// ボール
const BALL_R = 8;                  // 半径
const BALL_SPEED = 380;            // 速さ px/s (一定)
const LAUNCH_ANGLE = 60;           // 発射時の左右最大角 (度, 上方向基準 ±)

// ブロック (グリッド)
const BRICK_COLS = 15;
const BRICK_ROWS = 9;
const BRICK_W = 56;
const BRICK_H = 20;
const BRICK_GAP = 4;
const BRICK_TOP = 60;              // 上オフセット (画面座標)

const SCORE_PER_BRICK = 10;        // 破壊スコア

// 同時ボール数 (負荷)
const BALL_INIT = 3;               // 初期
const BALL_STEP = 5;               // ±増減
const BALL_MIN = 1;
const BALL_MAX = 500;

let ballSetting = BALL_INIT;       // 設定値 (維持したい同時ボール数)

// ---- 状態 ----
let paddle;                        // { x, y } 画面座標の中心
let balls = [];                    // { x, y, vx, vy } 画面座標
let bricks = [];                   // { x, y, hp, alive } 中心(画面座標)
let sparks = [];                   // { x, y, t, life } 破壊エフェクト

let score = 0;
let lost = 0;                      // ロスト数 (下端を抜けたボール)

// タイトル/アトラクト状態（false=デモ中・操作無効）
let started = false;
let blinkT = 0;
const titleEl = () => document.getElementById('title');

// アセット有無フラグ (imageSources の読み込み結果で判定)
let useSprites = false;

// HUD 用 FPS 移動平均
let fpsAvg = 60;
const hudEl = () => document.getElementById('hud');

// ---- アセット ----
// SPEC のファイル名に厳密一致。../assets/ から読み込む。
// 画像が無くても起動するよう、tile index を後で安全に参照する。
const imageSources = [
  '../assets/paddle.png',       // 0
  '../assets/ball.png',         // 1
  '../assets/brick.png',        // 2
  '../assets/hit_spark.png',    // 3
  '../assets/bg_breakout.png',  // 4
];
const TEX = {
  paddle: 0, ball: 1, brick: 2, spark: 3, bg: 4,
};

// ---- HP 色 (SPEC: HP3=赤 / HP2=橙 / HP1=緑) ----
function hpColor(hp) {
  if (hp >= 3) return new Color(0.90, 0.20, 0.20);
  if (hp === 2) return new Color(1.00, 0.60, 0.15);
  return new Color(0.30, 0.85, 0.30);
}

// ---- ヘルパ ----
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function rand(a, b) { return a + Math.random() * (b - a); }

// 画面座標(左上原点, y下向き) → ワールド座標(y上向き) へ変換
function toWorld(sx, sy) { return vec2(sx, SCREEN_H - sy); }

// テクスチャが実際に読み込めたか (幅>1) を判定。失敗時は矩形/円フォールバック。
function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}

// ---- エンティティ生成 ----

// ボールをパドル上から上方向 (左右 ±60°) に発射
function spawnBall() {
  // 上方向 = 画面座標で y が減る方向。角度 0 を真上とし ±LAUNCH_ANGLE 度散らす。
  const a = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE) * Math.PI / 180;
  const vx = Math.sin(a) * BALL_SPEED;
  const vy = -Math.cos(a) * BALL_SPEED;   // 上方向 (y 減少)
  balls.push({ x: paddle.x, y: PADDLE_Y - PADDLE_H / 2 - BALL_R - 1, vx, vy });
}

// 同時ボール数を設定値に合わせて補充
function refillBalls() {
  while (balls.length < ballSetting) spawnBall();
  // 設定を下げた直後など過剰分は末尾から間引く
  while (balls.length > ballSetting) balls.pop();
}

// ブロック盤面を生成 (15列 × 9行, 上3行=HP3 / 中3行=HP2 / 下3行=HP1)
function buildBricks() {
  bricks = [];
  // グリッド全体幅を中央寄せ
  const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
  const startX = (SCREEN_W - totalW) / 2;
  for (let r = 0; r < BRICK_ROWS; r++) {
    // 行ごとの HP (上3=3 / 中3=2 / 下3=1)
    const hp = r < 3 ? 3 : (r < 6 ? 2 : 1);
    for (let c = 0; c < BRICK_COLS; c++) {
      const x = startX + c * (BRICK_W + BRICK_GAP) + BRICK_W / 2;
      const y = BRICK_TOP + r * (BRICK_H + BRICK_GAP) + BRICK_H / 2;
      bricks.push({ x, y, hp, alive: true });
    }
  }
}

function addSpark(x, y) {
  sparks.push({ x, y, t: 0, life: 0.18 });
}

// スコア/盤面/ボール/パドルを初期状態へ
function resetGame() {
  paddle = { x: SCREEN_W / 2, y: PADDLE_Y };
  balls = []; sparks = [];
  score = 0; lost = 0;
  ballSetting = BALL_INIT;
  buildBricks();
  refillBalls();
}

// Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
function startGame() {
  started = true;
  resetGame();
  const el = titleEl();
  if (el) el.style.display = 'none';
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  // 固定キャンバス 960x540（既定の全画面拡大を抑止して他エンジンと揃える）
  setCanvasMaxSize(vec2(SCREEN_W, SCREEN_H));
  setCanvasFixedSize(vec2(SCREEN_W, SCREEN_H));
  setCameraScale(1);
  setCameraPos(vec2(SCREEN_W / 2, SCREEN_H / 2));
  setGravity(vec2(0, 0));

  // どれか1つでもテクスチャが正常に読めていればスプライトを使う
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  resetGame();
}

function gameUpdate() {
  const dt = timeDelta;             // デルタタイム基準

  // --- Enter でデモ→プレイ開始 ---
  if (!started && keyWasPressed('Enter')) startGame();

  // --- 同時ボール数 (負荷) 調整 ---
  handleBallCountKeys();

  // --- パドル移動 (水平のみ + 画面内クランプ) ---
  let mx = 0;
  if (!started) {
    // デモAI: 最も下(最大y, 画面座標)のボールの x へパドルを追従させる(速度上限内で)
    let target = paddle.x, lowestY = -Infinity;
    for (let i = 0; i < balls.length; i++) { if (balls[i].y > lowestY) { lowestY = balls[i].y; target = balls[i].x; } }
    const diff = target - paddle.x;
    if (Math.abs(diff) > 1) mx = diff > 0 ? 1 : -1;
  } else {
    if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) mx -= 1;
    if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) mx += 1;
  }
  paddle.x = clamp(paddle.x + mx * PADDLE_SPEED * dt, PADDLE_W / 2, SCREEN_W - PADDLE_W / 2);

  const halfPW = PADDLE_W / 2;
  const halfPH = PADDLE_H / 2;
  const paddleTop = PADDLE_Y - halfPH;   // パドル上面 (画面座標)

  // --- ボール更新 ---
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // 左右の壁で反射
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    else if (b.x > SCREEN_W - BALL_R) { b.x = SCREEN_W - BALL_R; b.vx = -Math.abs(b.vx); }

    // 天井 (画面座標 y=0) で反射
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

    // パドルで反射 (下向きに進んでいて、パドル矩形に重なるとき)
    if (b.vy > 0 &&
        b.y + BALL_R >= paddleTop && b.y - BALL_R <= PADDLE_Y + halfPH &&
        b.x >= paddle.x - halfPW - BALL_R && b.x <= paddle.x + halfPW + BALL_R) {
      // 当たった位置のパドル中心からのオフセット (-1..1) で反射角を決める
      const off = clamp((b.x - paddle.x) / halfPW, -1, 1);
      const a = off * (LAUNCH_ANGLE * Math.PI / 180);  // 端ほど横に鋭く
      b.vx = Math.sin(a) * BALL_SPEED;
      b.vy = -Math.cos(a) * BALL_SPEED;                // 常に上方向
      b.y = paddleTop - BALL_R - 0.5;                  // めり込み解消
    }

    // 下端を抜けたらロスト → 同時数維持のため再発射
    if (b.y - BALL_R > SCREEN_H) {
      lost++;
      // パドル上から再発射 (count は維持するので、この場で位置/速度をリセット)
      const ang = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE) * Math.PI / 180;
      b.x = paddle.x;
      b.y = PADDLE_Y - halfPH - BALL_R - 1;
      b.vx = Math.sin(ang) * BALL_SPEED;
      b.vy = -Math.cos(ang) * BALL_SPEED;
    }
  }

  // --- ボール × ブロック (AABB×円, 最近点) ---
  // 1ボールにつき1フレーム1ブロックまで (最初の命中で break)
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    for (let j = 0; j < bricks.length; j++) {
      const k = bricks[j];
      if (!k.alive) continue;
      const hw = BRICK_W / 2, hh = BRICK_H / 2;
      // 矩形内の最近点
      const nx = clamp(b.x, k.x - hw, k.x + hw);
      const ny = clamp(b.y, k.y - hh, k.y + hh);
      const dx = b.x - nx, dy = b.y - ny;
      if (dx * dx + dy * dy > BALL_R * BALL_R) continue;  // 非接触

      // 当たった面で反転: ブロック中心からの相対位置で左右/上下を判定
      const px = (b.x - k.x) / hw;   // 正規化した横ずれ
      const py = (b.y - k.y) / hh;   // 正規化した縦ずれ
      if (Math.abs(px) > Math.abs(py)) {
        // 左右面 → vx 反転
        b.vx = (px > 0 ? Math.abs(b.vx) : -Math.abs(b.vx));
      } else {
        // 上下面 → vy 反転
        b.vy = (py > 0 ? Math.abs(b.vy) : -Math.abs(b.vy));
      }

      // HP-1, 0 で破壊
      k.hp -= 1;
      if (k.hp <= 0) {
        k.alive = false;
        score += SCORE_PER_BRICK;
        addSpark(k.x, k.y);
      }
      break;  // このボールは今フレームここまで
    }
  }

  // --- 全ブロック破壊で盤面再生成 (ベンチ継続) ---
  let anyAlive = false;
  for (let j = 0; j < bricks.length; j++) { if (bricks[j].alive) { anyAlive = true; break; } }
  if (!anyAlive) buildBricks();

  // --- エフェクト更新 ---
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.t += dt;
    if (s.t >= s.life) sparks.splice(i, 1);
  }

  // --- 同時ボール数の維持 ---
  refillBalls();
}

function handleBallCountKeys() {
  // '+' は通常 Shift+'=' なので Equal / NumpadAdd 両対応
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    ballSetting = clamp(ballSetting + BALL_STEP, BALL_MIN, BALL_MAX);
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    ballSetting = clamp(ballSetting - BALL_STEP, BALL_MIN, BALL_MAX);
  }
}

function gameUpdatePost() {}

// ===================================================================
//  描画 (ワールド空間 / Y は toWorld で反転)
// ===================================================================
function gameRender() {
  // 背景: bg_breakout.png があればタイル、無ければ暗色矩形
  if (spriteReady(TEX.bg)) {
    drawTile(toWorld(SCREEN_W / 2, SCREEN_H / 2), vec2(SCREEN_W, SCREEN_H), tile(0, 512, TEX.bg));
  } else {
    drawRect(toWorld(SCREEN_W / 2, SCREEN_H / 2), vec2(SCREEN_W, SCREEN_H), new Color(0.05, 0.06, 0.10));
  }

  // ブロック (HP 色で tint)
  for (let j = 0; j < bricks.length; j++) {
    const k = bricks[j];
    if (!k.alive) continue;
    const col = hpColor(k.hp);
    if (spriteReady(TEX.brick)) {
      // 明色テクスチャを HP 色で乗算 tint
      drawTile(toWorld(k.x, k.y), vec2(BRICK_W, BRICK_H), tile(0, 64, TEX.brick), col);
    } else {
      drawRect(toWorld(k.x, k.y), vec2(BRICK_W, BRICK_H), col);
      // 縁取りで視認性アップ (内側を一回り暗い色で重ねる簡易表現)
      drawRect(toWorld(k.x, k.y), vec2(BRICK_W - 3, BRICK_H - 3),
        new Color(col.r * 0.7, col.g * 0.7, col.b * 0.7));
    }
  }

  // パドル
  if (spriteReady(TEX.paddle)) {
    drawTile(toWorld(paddle.x, paddle.y), vec2(PADDLE_W, PADDLE_H), tile(0, vec2(96, 24), TEX.paddle));
  } else {
    drawRect(toWorld(paddle.x, paddle.y), vec2(PADDLE_W, PADDLE_H), new Color(0.95, 0.95, 1.0));
  }

  // ボール
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (spriteReady(TEX.ball)) {
      drawTile(toWorld(b.x, b.y), vec2(BALL_R * 2, BALL_R * 2), tile(0, 16, TEX.ball));
    } else {
      drawCircle(toWorld(b.x, b.y), BALL_R, new Color(1, 1, 1));
    }
  }

  // 破壊スパーク (一瞬)
  for (let i = 0; i < sparks.length; i++) {
    const s = sparks[i];
    const kf = s.t / s.life;          // 0..1
    if (spriteReady(TEX.spark)) {
      const c = new Color(1, 1, 1, 1 - kf);
      drawTile(toWorld(s.x, s.y), vec2(32, 32), tile(0, 32, TEX.spark), c);
    } else {
      // 黄バースト: 放射状の線
      const c = new Color(1, 0.95, 0.3, 1 - kf);
      const rr = 6 + kf * 14;
      const center = toWorld(s.x, s.y);
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4;
        const tip = vec2(center.x + Math.cos(ang) * rr, center.y + Math.sin(ang) * rr);
        drawLine(center, tip, 2, c);
      }
    }
  }
}

function gameRenderPost() {
  // FPS 移動平均 (指数移動平均)
  const inst = frameRate || (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  // 残ブロック数
  let bricksAlive = 0;
  for (let j = 0; j < bricks.length; j++) if (bricks[j].alive) bricksAlive++;

  // Objects = ボール + 残ブロック + エフェクト
  const objCount = balls.length + bricksAlive + sparks.length;

  const el = hudEl();
  if (el) {
    // 表示内容・書式は three.js に統一
    el.textContent =
      `FPS     : ${fpsAvg.toFixed(1)}\n` +
      `Objects : ${objCount}  (ball ${balls.length} / brick ${bricksAlive} / fx ${sparks.length})\n` +
      `Score   : ${score}\n` +
      `Balls   : ${balls.length} / ${ballSetting}  (+/- to change, 1..${BALL_MAX})\n` +
      `Bricks  : ${bricksAlive}\n` +
      `Lost    : ${lost}`;
  }

  // --- タイトル点滅 (アトラクト中のみ) ---
  const tEl = titleEl();
  if (tEl) {
    if (!started) {
      blinkT += timeDelta;
      tEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  }
}

// ===================================================================
//  起動: engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)
// ===================================================================
// 第7引数に #game-container を渡し、960x540 の固定枠内に canvas を生成して
// 他エンジンと表示サイズ・位置・HUD配置を揃える。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
