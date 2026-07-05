/* =========================================================================
 * テーマ7 物理パズル (投擲物理) ― KAPLAY + Matter.js 実装
 * 仕様: SPEC.md (960x540, 34x34 箱スタック, スリングショット発射, 剛体数スケール)
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリだが、本物の2D剛体物理エンジンは
 * 内蔵しない (area()/body() は簡易な衝突・重力のみ)。テーマ4/5 の "対" として
 * 本物の剛体ソルバ (接触・スタック・反発・摩擦・スリープ) を比較するのが主題なので、
 * 物理は **matter-js (CDN, PixiJS/Babylon/LittleJS と同一 0.19.0)** に完全委譲する。
 *   - 物理: Matter.Engine (World/Bodies/Body, Matter.Engine.update)
 *   - 描画: KAPLAY のゲームオブジェクト (k.sprite / k.rect / k.circle)
 * 毎フレームの流れ:
 *   1) Matter.Engine.update(engine, dtMs) で物理を1ステップ進める
 *   2) 各 Matter ボディの position / angle を対応する KAPLAY obj.pos / obj.angle へ同期
 * KAPLAY の座標系は Y 下向き・原点左上 = Matter の座標 (Y下) とそのまま一致するため、
 * Y 反転は不要 (three.js / A-Frame と異なり最も素直)。angle は rad→deg 変換のみ。
 * 自前 AABB は一切書かない。
 * =========================================================================*/

// ---- Matter.js モジュール取り出し -----------------------------------------
const { Engine, World, Bodies, Body, Composite } = Matter;

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const GROUND_H = 48;                  // 画面下端から上 48px が地面の高さ
const GROUND_TOP_Y = VIEW_H - GROUND_H; // 地面上面の y (= 492)
const WALL_T = 40;                    // 左右/床の壁の厚み (静的)

const BOX = 34;                       // 1箱 34x34 px
const BALL_R = 12;                    // 発射体 (円) 半径

// 物理パラメータ (px 系。PixiJS 参照実装と同一)
const GRAVITY_Y = 1.0;
const GRAVITY_SCALE = 0.001;
const BOX_DENSITY = 0.0018;
const BALL_DENSITY = 0.004;
const BOX_FRICTION = 0.6;
const BOX_RESTITUTION = 0.05;
const BALL_RESTITUTION = 0.25;

// 発射 (スリングショット)
const SLING_X = 90;
const SLING_Y = GROUND_TOP_Y - 70;
const DRAG_TO_VEL = 0.22;
const MAX_LAUNCH_SPEED = 26;
const CLICK_SPEED = 18;
const MAX_SHOTS = 8;
const AUTO_INTERVAL = 0.8;            // s

// 加点 / 崩し判定
const DISPLACE_DIST = 64;
const SCORE_NORMAL = 10;
const SCORE_TARGET = 50;

// 箱数 (負荷)
const BOX_INIT = 60;
const BOX_STEP = 20;
const BOX_MIN = 20;
const BOX_MAX = 600;

// 場外除去のしきい値
const KILL_MARGIN = 200;

const RAD2DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- 決定的擬似乱数 (mulberry32) -----------------------------------------
// Math.random は使わない。固定シードで全エンジン共通の見た目・挙動を狙う。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSET_DEFS = {
  box:        '../assets/box.png',
  box_target: '../assets/box_target.png',
  ball:       '../assets/ball.png',
  ground:     '../assets/ground.png',
  slingshot:  '../assets/slingshot.png',
  bg_sky:     '../assets/bg_sky.png',
};

// =========================================================================
// 構造物レイアウトの決定的算出 (PixiJS 参照実装と同一アルゴリズム)
// =========================================================================
function computeStackLayout(n) {
  const baseCenterX = 690;
  const gap = 1;
  const step = BOX + gap;

  let baseW = 1;
  while (true) {
    let total = 0;
    for (let w = baseW; w >= 1; w--) total += w;
    if (total >= n || baseW >= 26) break;
    baseW++;
  }

  const positions = [];
  let placed = 0;
  let rowW = baseW;
  let row = 0;
  while (placed < n && rowW >= 1) {
    const rowCount = Math.min(rowW, n - placed);
    const rowWidthPx = rowCount * step;
    const left = baseCenterX - rowWidthPx / 2 + step / 2;
    const cy = GROUND_TOP_Y - BOX / 2 - row * step;
    for (let c = 0; c < rowCount; c++) {
      positions.push({ x: left + c * step, y: cy });
      placed++;
    }
    rowW--;
    row++;
    if (rowW < 1 && placed < n) { rowW = baseW; row = 0; }
  }
  return positions;
}

function pickTargets(positions) {
  const rnd = mulberry32(0xA117);
  const targets = new Set();
  if (positions.length === 0) return targets;
  const sorted = positions
    .map((p, i) => ({ i, y: p.y }))
    .sort((a, b) => a.y - b.y);
  const topPool = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.25)));
  const count = clamp(2 + Math.floor(positions.length / 120), 2, 6);
  for (let k = 0; k < count && topPool.length > 0; k++) {
    const idx = Math.floor(rnd() * topPool.length);
    targets.add(topPool[idx].i);
    topPool.splice(idx, 1);
  }
  return targets;
}

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: [126, 192, 255],   // 空色
  crisp: true,
  global: false,
});

// === アセット読み込み (失敗してもフォールバックで起動) ======================
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { await k.loadSprite(key, url); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

function start() {
  // ====================================================================
  // Matter.js エンジン / ワールド (物理を完全委譲)
  // ====================================================================
  const engine = Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = GRAVITY_Y;
  engine.gravity.scale = GRAVITY_SCALE;
  engine.enableSleeping = true;       // Active bodies 比較の核
  const world = engine.world;

  // 静的ボディ: 床 + 左右の壁
  const staticOpts = { isStatic: true, friction: 0.8, restitution: 0.0, label: 'static' };
  const groundBody = Bodies.rectangle(VIEW_W / 2, GROUND_TOP_Y + GROUND_H / 2, VIEW_W, GROUND_H, staticOpts);
  const wallL = Bodies.rectangle(-WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, staticOpts);
  const wallR = Bodies.rectangle(VIEW_W + WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, staticOpts);
  Composite.add(world, [groundBody, wallL, wallR]);

  // ====================================================================
  // 静的な表示 (背景 / 地面 / 発射台) — 物理ボディは床/壁が担う
  // ====================================================================
  if (loaded.bg_sky) {
    const bg = k.add([k.sprite('bg_sky'), k.pos(0, 0), k.anchor('topleft'), k.z(-10)]);
    bg.width = VIEW_W; bg.height = VIEW_H;
  } // 無ければ kaplay の background (空色) が見える

  if (loaded.ground) {
    const g = k.add([k.sprite('ground'), k.pos(0, GROUND_TOP_Y), k.anchor('topleft'), k.z(-5)]);
    g.width = VIEW_W; g.height = GROUND_H;
  } else {
    k.add([k.rect(VIEW_W, GROUND_H), k.pos(0, GROUND_TOP_Y), k.anchor('topleft'),
      k.color(107, 143, 58), k.z(-5)]);
    k.add([k.rect(VIEW_W, 8), k.pos(0, GROUND_TOP_Y), k.anchor('topleft'),
      k.color(143, 191, 82), k.z(-4)]);
  }

  if (loaded.slingshot) {
    const s = k.add([k.sprite('slingshot'), k.pos(SLING_X, GROUND_TOP_Y), k.anchor('bot'), k.z(-3)]);
    s.width = 48; s.height = 64;
  } else {
    k.add([k.rect(8, 40), k.pos(SLING_X, GROUND_TOP_Y - 12), k.anchor('bot'),
      k.color(138, 143, 152), k.z(-3)]);
  }

  // ====================================================================
  // 箱 (剛体スタック) — { body(Matter), obj(KAPLAY), isTarget, scored, x0, y0 }
  // ====================================================================
  const boxes = [];
  let boxSet = 0;

  function makeBoxObj(isTarget) {
    if (loaded[isTarget ? 'box_target' : 'box']) {
      const o = k.add([k.sprite(isTarget ? 'box_target' : 'box'),
        k.pos(0, 0), k.anchor('center'), k.rotate(0), k.opacity(1)]);
      o.width = BOX; o.height = BOX;
      return o;
    }
    const col = isTarget ? k.color(255, 140, 26) : k.color(181, 121, 58);
    return k.add([k.rect(BOX, BOX), k.pos(0, 0), k.anchor('center'),
      k.rotate(0), col, k.opacity(1),
      k.outline(2, isTarget ? k.rgb(194, 94, 0) : k.rgb(122, 78, 33))]);
  }

  function buildStack(n) {
    for (const b of boxes) { Composite.remove(world, b.body); k.destroy(b.obj); }
    boxes.length = 0;

    const positions = computeStackLayout(n);
    const targets = pickTargets(positions);
    const rnd = mulberry32(0x5EED);

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const isTarget = targets.has(i);
      const cx = p.x + (rnd() - 0.5) * 0.6; // ±0.3px の決定的ジッタ
      const cy = p.y;
      const body = Bodies.rectangle(cx, cy, BOX, BOX, {
        density: BOX_DENSITY,
        friction: BOX_FRICTION,
        frictionStatic: 0.8,
        restitution: BOX_RESTITUTION,
        label: isTarget ? 'target' : 'box',
        sleepThreshold: 30,
      });
      Composite.add(world, body);
      const obj = makeBoxObj(isTarget);
      boxes.push({ body, obj, isTarget, scored: false, x0: cx, y0: cy });
    }
    boxSet = n;
  }

  function setBoxCount(n) {
    n = clamp(n, BOX_MIN, BOX_MAX);
    buildStack(n);
  }

  // ====================================================================
  // 発射体 (プール: 最大 MAX_SHOTS。古いものから消す)
  // ====================================================================
  const balls = [];
  let shotsFired = 0;

  function spawnBall(x, y, vx, vy) {
    if (balls.length >= MAX_SHOTS) {
      const old = balls.shift();
      Composite.remove(world, old.body);
      k.destroy(old.obj);
    }
    const body = Bodies.circle(x, y, BALL_R, {
      density: BALL_DENSITY,
      friction: 0.4,
      frictionAir: 0.001,
      restitution: BALL_RESTITUTION,
      label: 'ball',
      sleepThreshold: 30,
    });
    Body.setVelocity(body, { x: vx, y: vy });
    Composite.add(world, body);
    let obj;
    if (loaded.ball) {
      obj = k.add([k.sprite('ball'), k.pos(x, y), k.anchor('center'), k.rotate(0), k.z(2)]);
      obj.width = BALL_R * 2; obj.height = BALL_R * 2;
    } else {
      obj = k.add([k.circle(BALL_R), k.pos(x, y), k.anchor('center'), k.rotate(0),
        k.color(226, 59, 46), k.outline(2, k.rgb(138, 24, 16)), k.z(2)]);
    }
    balls.push({ body, obj });
    shotsFired++;
  }

  function clearBalls() {
    for (const b of balls) { Composite.remove(world, b.body); k.destroy(b.obj); }
    balls.length = 0;
  }

  // ====================================================================
  // スコア / 崩し判定
  // ====================================================================
  let score = 0;
  function resetScore() { score = 0; shotsFired = 0; }

  function scanDisplacement() {
    for (const b of boxes) {
      if (b.scored) continue;
      const dx = b.body.position.x - b.x0;
      const dy = b.body.position.y - b.y0;
      if ((dx * dx + dy * dy) >= DISPLACE_DIST * DISPLACE_DIST) {
        b.scored = true;
        score += b.isTarget ? SCORE_TARGET : SCORE_NORMAL;
      }
    }
  }

  function reapOffWorld() {
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const p = b.body.position;
      const off = p.y > VIEW_H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > VIEW_W + KILL_MARGIN;
      if (off && b.body.isSleeping) {
        Composite.remove(world, b.body); k.destroy(b.obj); boxes.splice(i, 1);
      }
    }
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      const p = b.body.position;
      const off = p.y > VIEW_H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > VIEW_W + KILL_MARGIN;
      if (off) { Composite.remove(world, b.body); k.destroy(b.obj); balls.splice(i, 1); }
    }
  }

  function countActive() {
    const all = Composite.allBodies(world);
    let awake = 0;
    for (const b of all) { if (b.isStatic) continue; if (!b.isSleeping) awake++; }
    return awake;
  }

  // ====================================================================
  // タイトル / アトラクト状態
  // ====================================================================
  // started=false … タイトル/デモ中。ユーザー発射操作は無効、デモAIが自動発射。
  // started=true  … 通常プレイ。発射操作が有効。
  let started = false, blinkT = 0;
  let demoT = 0, demoSeq = 0;          // デモ自動発射の累積時間/発射回数 (決定的)
  const DEMO_INTERVAL = 2.0;           // 約2秒ごとにデモ発射
  const titleEl = document.getElementById('title');
  // Enter でデモ→プレイ開始: 新規リセット (R 相当) して操作を有効化、タイトルを消す。
  function startGame() {
    started = true;
    setBoxCount(boxSet); clearBalls(); resetScore();
    titleEl.style.display = 'none';
  }
  // デモAI: 約2秒ごとに角度・強さを変えながら発射体を撃つ (累積時間ベース・決定的)。
  function demoFire(dt) {
    demoT += dt;
    while (demoT >= DEMO_INTERVAL) {
      demoT -= DEMO_INTERVAL;
      const s = demoSeq++;
      const ang = (-58 + 22 * Math.sin(s * 0.9)) * Math.PI / 180; // 上向き右
      const spd = 19 + 5 * Math.sin(s * 1.7);
      spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
    }
  }

  // ====================================================================
  // 入力 (マウス: ドラッグ&リリース or クリック / キーボード)
  // ====================================================================
  let dragging = false;
  let dragStart = k.vec2(0, 0);
  let dragNow = k.vec2(0, 0);

  k.onMousePress(() => {
    dragging = true;
    dragStart = k.mousePos();
    dragNow = dragStart;
  });
  k.onMouseMove(() => { if (dragging) dragNow = k.mousePos(); });
  k.onMouseRelease(() => {
    if (!dragging) return;
    dragging = false;
    if (!started) return;            // アトラクト中はユーザー発射を無効化 (デモAIのみ)
    const end = k.mousePos();
    const dx = end.x - dragStart.x;
    const dy = end.y - dragStart.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) {
      const ax = end.x - SLING_X;
      const ay = end.y - SLING_Y;
      const a = Math.hypot(ax, ay) || 1;
      spawnBall(SLING_X, SLING_Y, (ax / a) * CLICK_SPEED, (ay / a) * CLICK_SPEED);
    } else {
      let vx = -dx * DRAG_TO_VEL;
      let vy = -dy * DRAG_TO_VEL;
      const sp = Math.hypot(vx, vy);
      if (sp > MAX_LAUNCH_SPEED) { vx = vx / sp * MAX_LAUNCH_SPEED; vy = vy / sp * MAX_LAUNCH_SPEED; }
      spawnBall(SLING_X, SLING_Y, vx, vy);
    }
  });

  // ---- キーボード ----
  let autoShot = false;
  let autoTimer = 0;
  const autoRnd = mulberry32(0xAA70);

  k.onKeyPress('enter', () => { if (!started) startGame(); });
  k.onKeyPress('space', () => { autoShot = !autoShot; autoTimer = AUTO_INTERVAL; });
  k.onKeyPress(['=', 'kpadd'], () => { setBoxCount(boxSet + BOX_STEP); resetScore(); });
  k.onKeyPress(['minus', 'kpsubtract'], () => { setBoxCount(boxSet - BOX_STEP); resetScore(); });
  k.onKeyPress('r', () => { setBoxCount(boxSet); clearBalls(); resetScore(); });

  // ---- 初期構築 ----
  setBoxCount(BOX_INIT);

  // ====================================================================
  // 照準ガイド (ドラッグ中)
  // ====================================================================
  k.onDraw(() => {
    if (dragging) {
      const dx = dragNow.x - dragStart.x;
      const dy = dragNow.y - dragStart.y;
      const tipX = SLING_X - dx;
      const tipY = SLING_Y - dy;
      k.drawLine({ p1: k.vec2(SLING_X, SLING_Y), p2: k.vec2(tipX, tipY),
        width: 3, color: k.rgb(58, 42, 24), opacity: 0.8 });
      k.drawCircle({ pos: k.vec2(tipX, tipY), radius: BALL_R, color: k.rgb(226, 59, 46), opacity: 0.6 });
    }
  });

  // ====================================================================
  // HUD + メインループ
  // ====================================================================
  const hudEl = document.getElementById('hud');
  const fpsSamples = [];
  let hudTimer = 0;

  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);
    const dtMs = dt * 1000;

    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // デモAI: アトラクト中 (!started) は約2秒ごとに自動発射
    if (!started) demoFire(dt);

    // オートショット (0.8s 間隔で決定的角度/初速)
    if (started && autoShot) {
      autoTimer += dt;
      while (autoTimer >= AUTO_INTERVAL) {
        autoTimer -= AUTO_INTERVAL;
        const t = autoRnd();
        const ang = (-55 + t * 40) * Math.PI / 180;
        const spd = 18 + autoRnd() * 6;
        spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
      }
    }

    // 物理1ステップ (Matter に完全委譲)。スパイク時は 32ms にクランプ。
    Engine.update(engine, Math.min(dtMs, 32));

    scanDisplacement();
    reapOffWorld();

    // Matter ボディ → KAPLAY obj 同期 (Y 同方向。angle は rad→deg)
    for (const b of boxes) {
      const p = b.body.position;
      b.obj.pos.x = p.x;
      b.obj.pos.y = p.y;
      b.obj.angle = b.body.angle * RAD2DEG;
      b.obj.opacity = b.scored ? 0.7 : 1.0;
    }
    for (const b of balls) {
      const p = b.body.position;
      b.obj.pos.x = p.x;
      b.obj.pos.y = p.y;
      b.obj.angle = b.body.angle * RAD2DEG;
    }

    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const totalBodies = Composite.allBodies(world).length;
      const active = countActive();
      hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Bodies : ${boxes.length} / ${boxSet}  (total ${totalBodies}, +balls/walls)\n` +
        `Active : ${active}  (awake bodies)\n` +
        `Shots  : ${balls.length} live / ${shotsFired} fired  (max ${MAX_SHOTS})\n` +
        `Score  : ${score}\n` +
        `Engine : Matter (CDN)   Auto: ${autoShot ? 'ON' : 'off'}`;
    }

    // タイトル点滅 (約0.45s 周期)
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('[KAPLAY + Matter.js] theme7 physics puzzle init ok.');
}
