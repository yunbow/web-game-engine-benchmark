/* =========================================================================
 * テーマ7 物理パズル (投擲物理) ― PixiJS v8 + Matter.js 実装
 * 仕様: SPEC.md (960x540, 34x34 箱スタック, スリングショット発射, 剛体数スケール)
 *
 * PixiJS は描画専用ライブラリのため、剛体物理は **matter-js (CDN)** に委譲する。
 *   - 物理 (重力・接触・スタック・反発・摩擦・スリープ): Matter.Engine
 *   - 描画: PixiJS v8 の Sprite / Graphics
 * 毎フレームの流れ:
 *   1) Matter.Engine.update(engine, dtMs) で物理を1ステップ進める
 *   2) 各 Matter ボディの position / angle を対応する Pixi 表示物へ同期
 * 自前 AABB は一切書かない (テーマ4/5 の "対" として物理エンジンを積極利用する題材)。
 * =========================================================================*/

// ---- Matter.js モジュール取り出し -----------------------------------------
const { Engine, World, Bodies, Body, Composite, Events, Sleeping } = Matter;

// ---- 定数 (SPEC) ----------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const GROUND_H = 48;                  // 画面下端から上 48px が地面の高さ
const GROUND_TOP_Y = VIEW_H - GROUND_H; // 地面上面の y (= 492)
const WALL_T = 40;                    // 左右/床の壁の厚み (見た目に出ない静的ボディ)

const BOX = 34;                       // 1箱 34x34 px
const BALL_R = 12;                    // 発射体 (円) 半径

// 物理パラメータ (px 系。見た目で「箱が約1〜1.5sで落ち着く」程度に調整)
const GRAVITY_Y = 1.0;                // Matter の重力スケール (engine.gravity.scale と併用)
const GRAVITY_SCALE = 0.001;          // Matter 既定。重力加速度 ≒ 9.8 * (scale*1000) px/ms^2 相当
const BOX_DENSITY = 0.0018;
const BALL_DENSITY = 0.004;           // 発射体は重め (山を崩しやすく)
const BOX_FRICTION = 0.6;
const BOX_RESTITUTION = 0.05;
const BALL_RESTITUTION = 0.25;

// 発射 (スリングショット)
const SLING_X = 90;                   // 発射台の x
const SLING_Y = GROUND_TOP_Y - 70;    // 発射台の弾保持位置 y
const DRAG_TO_VEL = 0.22;             // ドラッグ距離(px) → 初速 への係数
const MAX_LAUNCH_SPEED = 26;          // 初速の上限 (Matter の速度単位 px/step)
const CLICK_SPEED = 18;               // クリックのみ発射の固定初速
const MAX_SHOTS = 8;                  // 同時発射体プール上限
const AUTO_INTERVAL = 0.8;            // オートショット間隔 (s)

// 加点 / 崩し判定
const DISPLACE_DIST = 64;             // 重心が初期位置から 64px 以上動いたら "崩した"
const SCORE_NORMAL = 10;
const SCORE_TARGET = 50;

// 箱数 (負荷)
const BOX_INIT = 60;
const BOX_STEP = 20;
const BOX_MIN = 20;
const BOX_MAX = 600;

// 場外除去のしきい値 (この範囲外でスリープしたら除去)
const KILL_MARGIN = 200;

// フォールバック色
const COLORS = {
  box:      0xb5793a,   // 木目茶
  boxEdge:  0x7a4e21,
  target:   0xff8c1a,   // 橙
  targetEdge: 0xc25e00,
  ball:     0xe23b2e,   // 赤
  ground:   0x6b8f3a,   // 緑茶
  groundEdge: 0x46611f,
  sling:    0x8a8f98,   // 灰
  sky:      0x7ec0ff,   // 空色
  band:     0x3a2a18,   // スリングのゴム
};

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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// =========================================================================
// 構造物レイアウトの決定的算出
//   箱数 n から「列数 cols / 各列の段数」を決定的に決め、画面右側にピラミッド
//   (下広・上狭) 状の格子で積む。配置は固定シードでブレない。
// =========================================================================
function computeStackLayout(n) {
  // ベース x: 画面右寄り。スタックの底辺中心を決める。
  const baseCenterX = 690;
  // 1段あたりの箱間ギャップ (0 = 隙間なく密着)。わずかに空けて安定させる。
  const gap = 1;
  const step = BOX + gap;

  // n 箱を概ねピラミッドに割り当てる。最下段の幅 w を決め、上に行くほど狭める。
  // ピラミッド総数 ≒ w + (w-1) + ... を n に近づける w を探す。
  let baseW = 1;
  while (true) {
    let total = 0;
    for (let w = baseW; w >= 1; w--) total += w;
    if (total >= n || baseW >= 26) break;
    baseW++;
  }

  // 各段の (列数, 中心x, 上端y) を決定的に列挙し、必要数だけ箱位置を返す。
  const positions = []; // {x, y} = 箱中心
  let placed = 0;
  let rowW = baseW;
  let row = 0;
  while (placed < n && rowW >= 1) {
    const rowCount = Math.min(rowW, n - placed);
    const rowWidthPx = rowCount * step;
    const left = baseCenterX - rowWidthPx / 2 + step / 2;
    // 段の中心 y (下から row 段目)。最下段が地面の上に乗る。
    const cy = GROUND_TOP_Y - BOX / 2 - row * step;
    for (let c = 0; c < rowCount; c++) {
      positions.push({ x: left + c * step, y: cy });
      placed++;
    }
    rowW--;     // 上の段は1列狭める (ピラミッド)
    row++;
    // 段が尽きたら (ピラミッドが埋まったら) もう一度底から積み増す
    if (rowW < 1 && placed < n) { rowW = baseW; row = 0; }
  }
  return positions;
}

// ターゲット箱のインデックスを決定的に選ぶ (頂上付近を数個)。
function pickTargets(positions) {
  const rnd = mulberry32(0xA117);
  const targets = new Set();
  if (positions.length === 0) return targets;
  // 上段ほど y が小さい。上位 25% から決定的に数個選ぶ。
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

// ---- フォールバックテクスチャ生成 (Graphics→Texture) ----------------------
// 生成テクスチャはキャッシュして全スプライトで再利用する。v8 の新 Graphics API
// (g.rect(...).fill(color) / .stroke({width,color})) を使用。
function makeFallbackTextures(app) {
  const tex = {};
  const g = (w, h, draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, width: w, height: h, resolution: 1 });
    gr.destroy();
    return t;
  };

  // 通常の箱: 34x34 木目茶
  tex.box = g(BOX, BOX, (gr) => {
    gr.rect(0, 0, BOX, BOX).fill(COLORS.box);
    gr.rect(0, 0, BOX, BOX).stroke({ width: 2, color: COLORS.boxEdge });
    gr.moveTo(0, BOX / 2).lineTo(BOX, BOX / 2).stroke({ width: 1, color: COLORS.boxEdge, alpha: 0.6 });
    gr.moveTo(BOX / 2, 0).lineTo(BOX / 2, BOX).stroke({ width: 1, color: COLORS.boxEdge, alpha: 0.6 });
  });
  // ターゲット箱: 34x34 橙 (星マーク付き)
  tex.box_target = g(BOX, BOX, (gr) => {
    gr.rect(0, 0, BOX, BOX).fill(COLORS.target);
    gr.rect(0, 0, BOX, BOX).stroke({ width: 2, color: COLORS.targetEdge });
    gr.star(BOX / 2, BOX / 2, 5, 11, 5).fill({ color: 0xfff2a8, alpha: 0.95 });
  });
  // 発射体: 24x24 赤丸 (半径 12)
  tex.ball = g(BALL_R * 2, BALL_R * 2, (gr) => {
    gr.circle(BALL_R, BALL_R, BALL_R).fill(COLORS.ball);
    gr.circle(BALL_R, BALL_R, BALL_R).stroke({ width: 2, color: 0x8a1810 });
    gr.circle(BALL_R - 3, BALL_R - 3, 3).fill({ color: 0xffffff, alpha: 0.7 });
  });
  // 地面タイル: 64x64 緑茶 (上面に草)
  tex.ground = g(64, 64, (gr) => {
    gr.rect(0, 0, 64, 64).fill(COLORS.ground);
    gr.rect(0, 0, 64, 8).fill({ color: 0x8fbf52 });
    gr.rect(0, 0, 64, 64).stroke({ width: 1, color: COLORS.groundEdge, alpha: 0.5 });
  });
  // 発射台: 48x64 灰 (Y字フォーク)
  tex.slingshot = g(48, 64, (gr) => {
    gr.rect(20, 24, 8, 40).fill(COLORS.sling);            // 支柱
    gr.moveTo(24, 26).lineTo(8, 2).stroke({ width: 6, color: COLORS.sling });   // 左フォーク
    gr.moveTo(24, 26).lineTo(40, 2).stroke({ width: 6, color: COLORS.sling });  // 右フォーク
  });
  // 背景: 512x512 空色 (雲つき)
  tex.bg_sky = g(512, 512, (gr) => {
    gr.rect(0, 0, 512, 512).fill(COLORS.sky);
    gr.rect(0, 360, 512, 152).fill({ color: 0xa9d8ff, alpha: 0.5 });
    for (let i = 0; i < 6; i++) {
      const cx = 40 + i * 90, cy = 60 + (i % 3) * 70;
      gr.ellipse(cx, cy, 36, 18).fill({ color: 0xffffff, alpha: 0.85 });
      gr.ellipse(cx + 26, cy + 6, 26, 14).fill({ color: 0xffffff, alpha: 0.85 });
    }
  });
  return tex;
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
    box:        '../assets/box.png',
    box_target: '../assets/box_target.png',
    ball:       '../assets/ball.png',
    ground:     '../assets/ground.png',
    slingshot:  '../assets/slingshot.png',
    bg_sky:     '../assets/bg_sky.png',
  };
  const tex = { ...fallback };
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key]; // 読込成功でも中身が無ければ図形
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形フォールバック
    }
  }
  return tex;
}

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須。
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: COLORS.sky,
    antialias: true,
    resolution: 1,
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  const tex = await loadTextures(app);

  // ====================================================================
  // Matter.js エンジン / ワールド
  // ====================================================================
  // 重力は下向き。px 系に合わせ scale を調整 (Matter 既定 0.001)。
  const engine = Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = GRAVITY_Y;
  engine.gravity.scale = GRAVITY_SCALE;
  // スリープ有効化 (Active bodies の比較が本デモの核)。
  engine.enableSleeping = true;
  const world = engine.world;

  // ---- 静的ボディ: 床 + 左右の壁 ----
  // Matter の矩形は中心座標指定。床は地面上面が GROUND_TOP_Y に来るよう配置。
  const staticOpts = { isStatic: true, friction: 0.8, restitution: 0.0, label: 'static' };
  const groundBody = Bodies.rectangle(
    VIEW_W / 2, GROUND_TOP_Y + GROUND_H / 2, VIEW_W, GROUND_H, staticOpts);
  const wallL = Bodies.rectangle(-WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, staticOpts);
  const wallR = Bodies.rectangle(VIEW_W + WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, staticOpts);
  // 天井は無し (上方向は開放)。場外落下は KILL で回収。
  Composite.add(world, [groundBody, wallL, wallR]);

  // ====================================================================
  // 表示レイヤ (Pixi)
  // ====================================================================
  // 背景 (画面固定の TilingSprite)
  const bg = new PIXI.TilingSprite({ texture: tex.bg_sky, width: VIEW_W, height: VIEW_H });
  app.stage.addChild(bg);

  // 地面 (TilingSprite を床の見た目領域に敷く)
  const groundSprite = new PIXI.TilingSprite({
    texture: tex.ground, width: VIEW_W, height: GROUND_H,
  });
  groundSprite.x = 0; groundSprite.y = GROUND_TOP_Y;
  app.stage.addChild(groundSprite);

  // 発射台 (静的な飾り。物理ボディは持たない)
  const slingSprite = new PIXI.Sprite(tex.slingshot);
  slingSprite.anchor.set(0.5, 1);
  slingSprite.x = SLING_X; slingSprite.y = GROUND_TOP_Y;
  app.stage.addChild(slingSprite);

  // 箱 / 発射体のコンテナ
  const boxLayer = new PIXI.Container();
  const ballLayer = new PIXI.Container();
  app.stage.addChild(boxLayer, ballLayer);

  // スリングのゴム + 照準線 (ドラッグ中に描く)
  const aimGfx = new PIXI.Graphics();
  app.stage.addChild(aimGfx);

  // ====================================================================
  // 箱 (剛体スタック)
  // ====================================================================
  // 各箱は { body(Matter), sprite(Pixi), isTarget, scored, x0, y0 } を持つ。
  const boxes = [];
  let boxSet = 0;   // 現在の設定箱数

  function makeBoxSprite(isTarget) {
    const s = new PIXI.Sprite(isTarget ? tex.box_target : tex.box);
    s.anchor.set(0.5);
    s.width = BOX; s.height = BOX;
    boxLayer.addChild(s);
    return s;
  }

  // 構造物を決定的に (再)構築する。
  function buildStack(n) {
    // 既存の箱ボディ/スプライトを破棄
    for (const b of boxes) {
      Composite.remove(world, b.body);
      b.sprite.destroy();
    }
    boxes.length = 0;

    const positions = computeStackLayout(n);
    const targets = pickTargets(positions);

    // わずかな決定的ジッタ (見た目の自然さ。Math.random は使わない)
    const rnd = mulberry32(0x5EED);

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const isTarget = targets.has(i);
      const jx = (rnd() - 0.5) * 0.6; // ±0.3px
      const cx = p.x + jx;
      const cy = p.y;
      const body = Bodies.rectangle(cx, cy, BOX, BOX, {
        density: BOX_DENSITY,
        friction: BOX_FRICTION,
        frictionStatic: 0.8,
        restitution: BOX_RESTITUTION,
        label: isTarget ? 'target' : 'box',
        sleepThreshold: 30, // この静止時間で sleep (既定 60)
      });
      Composite.add(world, body);
      const sprite = makeBoxSprite(isTarget);
      boxes.push({ body, sprite, isTarget, scored: false, x0: cx, y0: cy });
    }
    boxSet = n;
  }

  // 箱数を設定 (決定的再構築)。スコアは buildStack 単体では触らない。
  function setBoxCount(n) {
    n = clamp(n, BOX_MIN, BOX_MAX);
    buildStack(n);
  }

  // ====================================================================
  // 発射体 (プール: 最大 MAX_SHOTS。古いものから消す)
  // ====================================================================
  // 各発射体は { body, sprite, alive }。プールは配列を FIFO 的に使う。
  const balls = []; // 生存中の発射体 (古い順)

  function spawnBall(x, y, vx, vy) {
    // 上限超過なら最古を消す
    if (balls.length >= MAX_SHOTS) {
      const old = balls.shift();
      Composite.remove(world, old.body);
      old.sprite.destroy();
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
    const sprite = new PIXI.Sprite(tex.ball);
    sprite.anchor.set(0.5);
    sprite.width = BALL_R * 2; sprite.height = BALL_R * 2;
    ballLayer.addChild(sprite);
    balls.push({ body, sprite, alive: true });
    shotsFired++;
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
  let dragStart = { x: 0, y: 0 };
  let dragNow = { x: 0, y: 0 };

  // キャンバス内のローカル座標へ変換 (CSS スケールを吸収)。
  function toLocal(ev) {
    const rect = app.canvas.getBoundingClientRect();
    const sx = VIEW_W / rect.width;
    const sy = VIEW_H / rect.height;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }

  app.canvas.addEventListener('pointerdown', (ev) => {
    dragging = true;
    dragStart = toLocal(ev);
    dragNow = { ...dragStart };
  });
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    dragNow = toLocal(ev);
  });
  window.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    aimGfx.clear();
    if (!started) return;            // アトラクト中はユーザー発射を無効化 (デモAIのみ)
    const end = toLocal(ev);
    const dx = end.x - dragStart.x;
    const dy = end.y - dragStart.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) {
      // クリックのみ: 発射台からクリック地点へ向け固定初速で撃つ。
      const ax = end.x - SLING_X;
      const ay = end.y - SLING_Y;
      const a = Math.hypot(ax, ay) || 1;
      spawnBall(SLING_X, SLING_Y, (ax / a) * CLICK_SPEED, (ay / a) * CLICK_SPEED);
    } else {
      // スリングショット: ドラッグの「逆向き」へ距離比例の初速で撃つ。
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
  const autoRnd = mulberry32(0xAA70); // オートショットの決定的角度/初速系列

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && !started) {
      startGame();
      e.preventDefault();
    } else if (e.code === 'Space') {
      autoShot = !autoShot;
      autoTimer = AUTO_INTERVAL; // 押した直後に1発撃つ
      e.preventDefault();
    } else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      setBoxCount(boxSet + BOX_STEP);
      resetScore();
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      setBoxCount(boxSet - BOX_STEP);
      resetScore();
      e.preventDefault();
    } else if (e.code === 'KeyR') {
      setBoxCount(boxSet);  // 同じ箱数で決定的に再構築
      clearBalls();
      resetScore();
      e.preventDefault();
    }
  });

  function clearBalls() {
    for (const b of balls) { Composite.remove(world, b.body); b.sprite.destroy(); }
    balls.length = 0;
  }

  // ====================================================================
  // スコア / 崩し判定
  // ====================================================================
  let score = 0;
  let shotsFired = 0;
  function resetScore() { score = 0; shotsFired = 0; }

  // 重心が初期位置から DISPLACE_DIST 以上動いた箱を "崩した" として1回だけ加点。
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

  // 場外でスリープした剛体 (箱・発射体) を除去 (剛体数の暴走防止)。
  function reapOffWorld() {
    // 箱
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const p = b.body.position;
      const off = p.y > VIEW_H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > VIEW_W + KILL_MARGIN;
      if (off && b.body.isSleeping) {
        Composite.remove(world, b.body);
        b.sprite.destroy();
        boxes.splice(i, 1);
      }
    }
    // 発射体: 場外に出たものだけ除去 (場内でスリープした弾は山に埋まっている
    // 可能性があるので残す。最大数 MAX_SHOTS のプールで古い順に押し出される)。
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      const p = b.body.position;
      const off = p.y > VIEW_H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > VIEW_W + KILL_MARGIN;
      if (off) {
        Composite.remove(world, b.body);
        b.sprite.destroy();
        balls.splice(i, 1);
      }
    }
  }

  // ---- 初期構築 ----
  setBoxCount(BOX_INIT);

  // ====================================================================
  // HUD
  // ====================================================================
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // 覚醒 (awake) ボディ数を数える。body.isSleeping が false のものが覚醒。
  function countActive() {
    const all = Composite.allBodies(world);
    let awake = 0;
    for (const b of all) {
      if (b.isStatic) continue;       // 静的 (床/壁) は除外
      if (!b.isSleeping) awake++;
    }
    return awake;
  }

  // ====================================================================
  // メインループ (Ticker, deltaMS 駆動)
  // ====================================================================
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05);

    // --- FPS 移動平均 (直近60フレーム) ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // --- デモAI: アトラクト中 (!started) は約2秒ごとに自動発射 ---
    if (!started) demoFire(dt);

    // --- オートショット (0.8s 間隔で決定的角度/初速) ---
    if (started && autoShot) {
      autoTimer += dt;
      while (autoTimer >= AUTO_INTERVAL) {
        autoTimer -= AUTO_INTERVAL;
        // 決定的な角度 (-55°〜-15° 上向き右) と初速で発射台から撃つ。
        const t = autoRnd();
        const ang = (-55 + t * 40) * Math.PI / 180; // 上向き右
        const spd = 18 + autoRnd() * 6;             // 18〜24
        spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
      }
    }

    // --- 物理1ステップ (Matter に完全委譲) ---
    // deltaMS をそのまま渡す。スパイク時は 32ms にクランプして破綻を防ぐ。
    Matter.Engine.update(engine, Math.min(dtMs, 32));

    // --- 崩し判定 / 場外除去 ---
    scanDisplacement();
    reapOffWorld();

    // --- Matter ボディ → Pixi 表示物 同期 ---
    // 箱: position(中心) + angle(rad) をそのまま反映 (anchor 0.5 なので中心一致)。
    for (const b of boxes) {
      const p = b.body.position;
      b.sprite.x = p.x;
      b.sprite.y = p.y;
      b.sprite.rotation = b.body.angle;
      // 加点済み箱は少し暗くして "崩した" のを可視化
      b.sprite.alpha = b.scored ? 0.7 : 1.0;
    }
    // 発射体
    for (const b of balls) {
      const p = b.body.position;
      b.sprite.x = p.x;
      b.sprite.y = p.y;
      b.sprite.rotation = b.body.angle;
    }

    // --- 照準ガイド (ドラッグ中) ---
    aimGfx.clear();
    if (dragging) {
      const dx = dragNow.x - dragStart.x;
      const dy = dragNow.y - dragStart.y;
      // 発射方向 (ドラッグの逆向き) を発射台から表示
      const tipX = SLING_X - dx;
      const tipY = SLING_Y - dy;
      aimGfx.moveTo(SLING_X, SLING_Y).lineTo(tipX, tipY)
        .stroke({ width: 3, color: COLORS.band, alpha: 0.8 });
      aimGfx.circle(tipX, tipY, BALL_R).fill({ color: COLORS.ball, alpha: 0.6 });
    }

    // --- HUD (約120msごと更新) ---
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const totalBodies = Composite.allBodies(world).length; // 箱+発射体+床/壁
      const active = countActive();
      hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Bodies : ${boxes.length} / ${boxSet}  (total ${totalBodies}, +balls/walls)\n` +
        `Active : ${active}  (awake bodies)\n` +
        `Shots  : ${balls.length} live / ${shotsFired} fired  (max ${MAX_SHOTS})\n` +
        `Score  : ${score}\n` +
        `Engine : Matter (CDN)   Auto: ${autoShot ? 'ON' : 'off'}\n` +
        `ENTER=start / ドラッグ=発射 / Space=オート / +/-=箱数 / R=再構築`;
    }

    // --- タイトル点滅 (約0.45s 周期) ---
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  // three.js 版に合わせ、キャンバスは 960x540 固定・上端中央配置(ウィンドウ追従の縮小はしない)。
  app.canvas.style.width = VIEW_W + 'px';
  app.canvas.style.height = VIEW_H + 'px';

  console.log('[PixiJS v8 + Matter.js] theme7 physics puzzle init ok. renderer =', app.renderer.type);
})();
