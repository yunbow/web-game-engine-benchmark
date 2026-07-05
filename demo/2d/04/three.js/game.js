/* ============================================================================
 * ブロック崩し (マルチボール Breakout) - three.js (r184) 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0) で 1ワールド単位 = 1px、原点左下・Y上向き。
 *   - ゲームロジックは画面座標 (Y 下向き, 他エンジンと同一定数) のまま保持し、
 *     描画同期時のみ worldY = H - gameY に変換する (テクスチャの上下が崩れない)。
 *   - スプライトは THREE.Sprite (常にカメラを向く板) を使い、重ね順は renderOrder。
 *   - ゲームループ/入力/反射/AABB×円判定/配列管理は自前。物理エンジンは不使用。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

// パドル
const PADDLE_W = 96, PADDLE_H = 18, PADDLE_Y = 510, PADDLE_SPEED = 600;
// ボール
const BALL_R = 8, BALL_SPEED = 380, LAUNCH_ANGLE = 60;
// ブロック (グリッド)
const BRICK_COLS = 15, BRICK_ROWS = 9, BRICK_W = 56, BRICK_H = 20, BRICK_GAP = 4, BRICK_TOP = 60;
// 同時ボール数 (負荷)
const INITIAL_BALLS = 3, BALL_STEP = 5, BALL_MIN = 1, BALL_MAX = 500;

const SCORE_PER_BRICK = 10;
const SPARK_LIFE = 220;             // ms

// HP ごとの色 (HP3=赤 / HP2=橙 / HP1=緑)。明色テクスチャに乗算 (tint)。
const HP_COLOR = { 3: 0xff4444, 2: 0xffa23a, 1: 0x55cc66 };

const ASSET_DEFS = {
  paddle:      '../assets/paddle.png',
  ball:        '../assets/ball.png',
  brick:       '../assets/brick.png',
  hit_spark:   '../assets/hit_spark.png',
  bg_breakout: '../assets/bg_breakout.png',
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RO = { bg: 0, brick: 1, ball: 2, fx: 3, paddle: 4 }; // renderOrder

// === シーン/カメラ/レンダラ =================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d1a);
// left=0, right=W, top=H, bottom=0 → x:0..W / y:0..H (Y上向き)
const camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);          // 性能比較のため DPR=1 固定
renderer.setSize(W, H);
document.getElementById('game-container').appendChild(renderer.domElement);

// === テクスチャ (画像 or canvas フォールバック) =============================
const loader = new THREE.TextureLoader();
const tex = {};
const fbCache = {};

// 2D canvas に描いて CanvasTexture 化するヘルパ。
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  fbCache[name] = t;
  return t;
}
// パドル=白角丸 / ボール=白丸 / ブロック=白矩形(HP色で乗算) / spark=黄バースト
function fbPaddle() { return canvasTexture('paddle', PADDLE_W, PADDLE_H, (g, w, h) => { g.fillStyle = '#fff'; roundRect(g, 0, 0, w, h, 9); g.fill(); }); }
function fbBall()   { return canvasTexture('ball', 32, 32, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); }); }
function fbBrick()  { return canvasTexture('brick', 64, 24, (g, w, h) => { g.fillStyle = '#fff'; roundRect(g, 0, 0, w, h, 4); g.fill(); }); }
function fbSpark()  { return canvasTexture('spark', 32, 32, (g) => { g.fillStyle = 'rgba(255,210,58,0.9)'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(16, 16, 7, 0, 7); g.fill(); }); }
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function makeSprite(texture, w, h, renderOrder, color) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  if (color !== undefined) mat.color.setHex(color); // HP 色を乗算 (tint)
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  return s;
}

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      const t = await loader.loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      tex[key] = t;
    } catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  // --- 背景: bg画像があればタイル Plane、無ければスターフィールド(Points) ---
  if (tex.bg_breakout) {
    tex.bg_breakout.wrapS = tex.bg_breakout.wrapT = THREE.RepeatWrapping;
    tex.bg_breakout.repeat.set(W / 512, H / 512);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ map: tex.bg_breakout, depthTest: false }));
    m.position.set(W / 2, H / 2, -10); m.renderOrder = RO.bg;
    scene.add(m);
  } else {
    const STAR_N = 160;
    const starPos = new Float32Array(STAR_N * 3);
    for (let i = 0; i < STAR_N; i++) {
      starPos[i * 3] = rand(0, W); starPos[i * 3 + 1] = rand(0, H); starPos[i * 3 + 2] = -5;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5, depthTest: false }));
    stars.renderOrder = RO.bg;
    scene.add(stars);
  }

  // --- パドル ---
  const paddle = {
    sprite: makeSprite(tex.paddle || fbPaddle(), PADDLE_W, PADDLE_H, RO.paddle),
    x: W / 2, y: PADDLE_Y,
  };
  scene.add(paddle.sprite);

  // --- エンティティ配列 (自前管理) ---
  const balls = [];    // {sprite,x,y,vx,vy}
  const bricks = [];   // {sprite,x,y,hp}  ※x,y はブロック左上
  const effects = [];  // {sprite,life,max}

  // --- ゲーム状態 ---
  let score = 0, lost = 0, ballSetting = INITIAL_BALLS;
  let started = false, blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
  const titleEl = document.getElementById('title');
  function startGame() { started = true; restart(); titleEl.style.display = 'none'; }
  // Enter でデモ→プレイ開始: スコア/盤面/ボールを初期化して操作を有効化
  function restart() {
    score = 0; lost = 0; ballSetting = INITIAL_BALLS;
    paddle.x = W / 2;
    buildBricks();
    syncBallCount();
  }

  // 画面座標(Y下)→ワールド(Y上)変換して sprite 位置を同期 (中心基準)
  const syncCenter = (sprite, cx, cy) => sprite.position.set(cx, H - cy, sprite.renderOrder * 0.01);

  // ボール生成 (パドル上から上方向へ ±60° のランダム角で発射)
  function makeBall() {
    const s = makeSprite(tex.ball || fbBall(), BALL_R * 2, BALL_R * 2, RO.ball);
    scene.add(s);
    const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
    const a = (-90 + deg) * Math.PI / 180;
    const b = { sprite: s, x: paddle.x, y: paddle.y - PADDLE_H, vx: Math.cos(a) * BALL_SPEED, vy: Math.sin(a) * BALL_SPEED };
    syncCenter(s, b.x, b.y);
    balls.push(b);
    return b;
  }
  function syncBallCount() {
    while (balls.length < ballSetting) makeBall();
    while (balls.length > ballSetting) {
      const b = balls.pop();
      scene.remove(b.sprite); b.sprite.material.dispose();
    }
  }

  // ブロック盤面の生成 (15列 × 9行)
  function buildBricks() {
    for (const br of bricks) { scene.remove(br.sprite); br.sprite.material.dispose(); }
    bricks.length = 0;
    const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    const startX = (W - totalW) / 2;
    for (let row = 0; row < BRICK_ROWS; row++) {
      const hp = row < 3 ? 3 : row < 6 ? 2 : 1; // 上3=HP3 / 中3=HP2 / 下3=HP1
      for (let col = 0; col < BRICK_COLS; col++) {
        const x = startX + col * (BRICK_W + BRICK_GAP);
        const y = BRICK_TOP + row * (BRICK_H + BRICK_GAP);
        const s = makeSprite(tex.brick || fbBrick(), BRICK_W, BRICK_H, RO.brick, HP_COLOR[hp]);
        scene.add(s);
        // sprite は中心基準なので左上(x,y)からブロック中心へオフセット
        syncCenter(s, x + BRICK_W / 2, y + BRICK_H / 2);
        bricks.push({ sprite: s, x, y, hp });
      }
    }
  }

  // 破壊エフェクト (hit_spark を一瞬表示)
  function spawnSpark(cx, cy) {
    const s = makeSprite(tex.hit_spark || fbSpark(), 28, 28, RO.fx);
    scene.add(s);
    syncCenter(s, cx, cy);
    effects.push({ sprite: s, x: cx, y: cy, life: SPARK_LIFE, max: SPARK_LIFE, base: 28 });
  }

  function removeAt(arr, i) {
    const o = arr[i]; scene.remove(o.sprite); o.sprite.material.dispose();
    arr[i] = arr[arr.length - 1]; arr.pop();
  }
  function renormSpeed(b) {
    const len = Math.hypot(b.vx, b.vy) || 1;
    b.vx = (b.vx / len) * BALL_SPEED; b.vy = (b.vy / len) * BALL_SPEED;
  }

  // --- 入力 ---
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === 'Enter' && !started) { startGame(); e.preventDefault(); }
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { ballSetting = clamp(ballSetting + BALL_STEP, BALL_MIN, BALL_MAX); syncBallCount(); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { ballSetting = clamp(ballSetting - BALL_STEP, BALL_MIN, BALL_MAX); syncBallCount(); e.preventDefault(); }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // --- 初期化 ---
  buildBricks();
  syncBallCount();

  // --- ループ ---
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05); // 秒。タブ復帰時の暴発を抑制
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
      if (down('ArrowLeft', 'KeyA')) mx -= 1;
      if (down('ArrowRight', 'KeyD')) mx += 1;
    }
    paddle.x = clamp(paddle.x + mx * PADDLE_SPEED * dt, PADDLE_W / 2, W - PADDLE_W / 2);
    syncCenter(paddle.sprite, paddle.x, paddle.y);

    const padL = paddle.x - PADDLE_W / 2, padR = paddle.x + PADDLE_W / 2;
    const padT = paddle.y - PADDLE_H / 2, padB = paddle.y + PADDLE_H / 2;

    // --- ボール更新 (移動 → 壁/天井/パドル反射 → ブロック判定) ---
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
      else if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
      if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

      // パドルで反射 (常に上方向へ。中心からのオフセットで反射角を変える)
      if (b.vy > 0 &&
          b.x + BALL_R > padL && b.x - BALL_R < padR &&
          b.y + BALL_R > padT && b.y - BALL_R < padB) {
        const off = clamp((b.x - paddle.x) / (PADDLE_W / 2), -1, 1);
        const a = (-90 + off * LAUNCH_ANGLE) * Math.PI / 180;
        b.vx = Math.cos(a) * BALL_SPEED;
        b.vy = Math.sin(a) * BALL_SPEED;
        b.y = padT - BALL_R;
      }

      // 下端を抜けたらロスト → パドル上から再発射 (数を維持)
      if (b.y - BALL_R > H) {
        lost++;
        const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
        const a = (-90 + deg) * Math.PI / 180;
        b.x = paddle.x; b.y = paddle.y - PADDLE_H;
        b.vx = Math.cos(a) * BALL_SPEED; b.vy = Math.sin(a) * BALL_SPEED;
      }

      // --- ボール × ブロック (AABB矩形 × 円, 最近点) ---
      for (let j = bricks.length - 1; j >= 0; j--) {
        const br = bricks[j];
        const nx = clamp(b.x, br.x, br.x + BRICK_W);
        const ny = clamp(b.y, br.y, br.y + BRICK_H);
        const dx = b.x - nx, dy = b.y - ny;
        if (dx * dx + dy * dy <= BALL_R * BALL_R) {
          const bcx = br.x + BRICK_W / 2, bcy = br.y + BRICK_H / 2;
          const ox = (BRICK_W / 2 + BALL_R) - Math.abs(b.x - bcx);
          const oy = (BRICK_H / 2 + BALL_R) - Math.abs(b.y - bcy);
          if (ox < oy) b.vx = (b.x < bcx) ? -Math.abs(b.vx) : Math.abs(b.vx);
          else b.vy = (b.y < bcy) ? -Math.abs(b.vy) : Math.abs(b.vy);
          renormSpeed(b);

          br.hp -= 1;
          if (br.hp <= 0) {
            spawnSpark(bcx, bcy);
            removeAt(bricks, j);
            score += SCORE_PER_BRICK;
          } else {
            br.sprite.material.color.setHex(HP_COLOR[br.hp]); // HP 色を更新
          }
          break; // 1フレーム1ブロックまで
        }
      }

      syncCenter(b.sprite, b.x, b.y);
    }

    // --- 全ブロック破壊で盤面を再生成 ---
    if (bricks.length === 0) buildBricks();

    // --- エフェクト更新 (フェードアウト + 膨張) ---
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i]; f.life -= dtMs; const t = f.life / f.max;
      f.sprite.material.opacity = clamp(t, 0, 1);
      const sc = (1 - t) * 0.6 + 1; f.sprite.scale.set(f.base * sc, f.base * sc, 1);
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

    renderer.render(scene, camera);

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('three.js Breakout started. renderer: WebGL');
}
