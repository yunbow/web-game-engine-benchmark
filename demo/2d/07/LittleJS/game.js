'use strict';

/*
  テーマ7 物理パズル (剛体物理エンジン統合 / 投擲物理) ― LittleJS 版
  ------------------------------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定。座標は左上原点・px・画面下が地面。
   - 本物の2D剛体物理エンジンを"使う"ことが主題。LittleJS は描画/入力を担当し、
     剛体(重力・接触・スタック・反発・スリープ)は matter.js に完全委譲する。
   - 静的な床(画面下端から上48px)+左右の壁。決定的に積んだ 34x34 の箱の山。
   - ターゲット箱(+50) / 通常箱は初期位置から 64px 超移動で +10 (箱ごとに1回)。
   - 左ドラッグ&リリースのスリングショット、クリックでクリック地点へ発射。
     発射体は半径12の円。最大同時8発をプール(古いものから消す)。
   - Space: オートショット(0.8s 間隔・決定的角度/初速)。+/-: 箱数(初期60, ±20, 20..600)。R: 再構築。
   - 場外(床より下/壁の外)へ出てスリープした剛体は除去。
   - HUD(HTML overlay): FPS / Bodies / Active / Shots / Score / Engine。

  ★★ 物理エンジンの選択 (最重要・README にも記載) ★★
   - SPEC は LittleJS について「公式 Box2D プラグインを使用。利用不可なら matter.js を
     CDN 併用してよい(README明記)」とする。本実装は **matter.js (CDN) を採用**。
     理由: LittleJS 公式 box2d プラグインは別途 wasm/ESM の取り回しが必要で classic
     global build + 単一 game.js の構成と相性が悪いため。matter.js は単一 min.js を
     <script> 直読みでき、本ベンチの構成に素直に載る。

  ★★ 二重Y軸の取り扱い (最重要) ★★
   - matter.js は「Y軸が下向き」(画面下=Y大)。重力は +Y(下)へ。これは matter の自然な規約。
   - LittleJS のワールドは「Y軸が上向き」(画面下=Y小, 画面上=Y大)。
   - そこで本実装は2つの座標空間を完全に分離する:
       (A) Matter 空間: 左上原点・px・Y下向き。物理は全てここで解く。重力 = +PHYS_GRAVITY。
       (B) LittleJS ワールド空間: cameraScale=1 (1ワールド=1px)・Y上向き。描画はここで行う。
   - 変換は m2l(): LittleJS_y = VIEW_H - matter_y で上下反転するだけ。x はそのまま。
     角度も Y反転に伴い符号が反転する(LittleJS_angle = -matter_angle)。
   - 入力(mousePos)は LittleJS ワールド座標で来るので、Matter へ渡すときは
     matter_y = VIEW_H - littlejs_y で逆変換する(l2mY)。
   - この変換を m2l()/l2mX()/l2mY() の3関数に閉じ込め、他所では混ぜない。
*/

// ---- matter.js モジュール参照 ----
const M = (typeof Matter !== 'undefined') ? Matter : null;

// ---- 画面・物理定数 (SPEC) ----
const VIEW_W = 960, VIEW_H = 540;     // 固定キャンバス px
const GROUND_H = 48;                  // 床の高さ(画面下端から上48px が床上面)
const WALL_TH = 40;                   // 壁の厚み(場外流出防止)
const PHYS_GRAVITY = 1.0;             // matter の重力スケール(下向き)。見た目で約1〜1.5sで落ち着く
const BOX = 34;                       // 箱 1辺 px (34x34)
const BALL_R = 12;                    // 発射体の半径 px
const MAX_SHOTS = 8;                  // 同時発射体プール上限
const AUTO_INTERVAL = 0.8;            // オートショット間隔 s
const DISPLACE_THRESHOLD = 64;        // 通常箱がこの距離超移動で「崩した」加点
const SCORE_NORMAL = 10;              // 通常箱 加点
const SCORE_TARGET = 50;              // ターゲット箱 加点
const SLING_X = 90;                   // スリングショット(発射台)の X 位置 (LittleJS/Matter 共通=左上原点系のx)
const SLING_Y_TOP = 120;             // 発射台のおおよその高さ(画面下端からの px, 後で床上面基準に再計算)

// ---- 箱数(負荷) ----
let boxTarget = 60;
const BOX_STEP = 20, BOX_MIN = 20, BOX_MAX = 600;

// ---- 図形フォールバック色 ----
const COL_BOX     = new Color(0.55, 0.36, 0.18);  // 通常箱=木目茶
const COL_TARGET  = new Color(0.95, 0.50, 0.12);  // ターゲット=橙
const COL_BALL    = new Color(0.90, 0.18, 0.18);  // 発射体=赤
const COL_GROUND  = new Color(0.30, 0.45, 0.22);  // 地面=緑茶
const COL_WALL    = new Color(0.22, 0.25, 0.28);  // 壁=暗灰
const COL_SLING   = new Color(0.45, 0.45, 0.48);  // 発射台=灰
const COL_SKY     = new Color(0.46, 0.73, 0.96);  // 背景=空色

// ---- imageSources (../assets/, SPEC のファイル名/インデックス) ----
const imageSources = [
  '../assets/box.png',         // 0  34x34
  '../assets/box_target.png',  // 1  34x34
  '../assets/ball.png',        // 2  24x24
  '../assets/ground.png',      // 3  64x64
  '../assets/slingshot.png',   // 4  48x64
  '../assets/bg_sky.png',      // 5  512x512
];
const TEX = { box: 0, target: 1, ball: 2, ground: 3, sling: 4, bg: 5 };

// ---- グローバル状態 ----
let engine = null;        // Matter.Engine
let world = null;         // Matter.World
let groundBody = null;    // 静的床
let wallBodies = [];      // 静的壁(左/右)
let boxes = [];           // 動的な箱 {body, isTarget, scored, startX, startY}
let shots = [];           // 発射体プール {body, age}
let score = 0;
let shotsFired = 0;       // 累計発射数
let useSprites = false;
let autoShot = false;     // オートショット ON/OFF
let autoTimer = 0;        // オートショット計時
let autoSeq = 0;          // オートショットの決定的シーケンス番号
let dragging = false;     // スリングショットのドラッグ中
let dragStart = null;     // ドラッグ開始(LittleJS ワールド座標 vec2)
let slingAnchorY = 0;     // 発射台アンカーの Matter-Y

// ---- タイトル/アトラクト状態 ----
// started=false … タイトル/デモ中。ユーザー発射操作は無効、デモAIが自動発射。
// started=true  … 通常プレイ。発射操作が有効。
let started = false;      // タイトル/アトラクト中は false
let blinkT = 0;           // タイトル点滅の累積時間
let demoTimer = 0;        // デモ自動発射の計時(累積秒)
let demoSeq = 0;          // デモ発射回数(決定的に角度/強さを振る)
const DEMO_INTERVAL = 2.0; // 約2秒ごとにデモ発射
const titleEl = () => document.getElementById('title');

// FPS 指数移動平均
let fpsAvg = 60;
const hudEl = () => document.getElementById('hud');

// ---- 決定的疑似乱数 (mulberry32 / Math.random 不使用) ----
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ===================================================================
//  座標変換 (二重Y軸の橋渡し ― ここに閉じ込める)
// ===================================================================
// Matter 空間(左上原点・Y下向き)の点を LittleJS ワールド(Y上向き)の vec2 へ。
function m2l(mx, my) { return vec2(mx, VIEW_H - my); }
// LittleJS ワールド座標 → Matter 座標(x はそのまま, y は反転)
function l2mX(lx) { return lx; }
function l2mY(ly) { return VIEW_H - ly; }
// Matter の角度(Y下向きCW) → LittleJS の角度(Y上向き)。Y反転で符号反転。
function m2lAngle(a) { return -a; }

// ===================================================================
//  テクスチャ読込判定 / フォールバック
// ===================================================================
function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}
function texTile(i) { return tile(0, textureInfos[i].size, i); }

// ===================================================================
//  Matter ワールド構築
// ===================================================================
function buildStatics() {
  const Bodies = M.Bodies;
  // 床: 画面下端から上 GROUND_H px。Matter-Y は下向きなので床の上面 = VIEW_H - GROUND_H。
  // 中心は (VIEW_W/2, VIEW_H - GROUND_H/2)。
  const groundY = VIEW_H - GROUND_H / 2;
  groundBody = Bodies.rectangle(VIEW_W / 2, groundY, VIEW_W, GROUND_H, {
    isStatic: true, friction: 0.9, restitution: 0.05, label: 'ground',
  });
  // 左右の壁(画面外への流出防止)。高さは画面の倍にして飛び越え防止。
  const wallH = VIEW_H * 2;
  const leftWall = Bodies.rectangle(-WALL_TH / 2, VIEW_H / 2, WALL_TH, wallH, {
    isStatic: true, friction: 0.5, label: 'wall',
  });
  const rightWall = Bodies.rectangle(VIEW_W + WALL_TH / 2, VIEW_H / 2, WALL_TH, wallH, {
    isStatic: true, friction: 0.5, label: 'wall',
  });
  wallBodies = [leftWall, rightWall];
  M.Composite.add(world, [groundBody, leftWall, rightWall]);

  // 発射台アンカー: 床上面のすぐ上に置く(Matter-Y)。
  slingAnchorY = (VIEW_H - GROUND_H) - 80;
}

// 箱の山を決定的に構築。boxTarget 個を画面右側へ格子/ピラミッド状に積む。
function buildBoxes() {
  const Bodies = M.Bodies;
  boxes = [];
  const rng = makeRng(70260615); // 固定シード(全エンジン共通の見た目を狙う)

  // 床上面(Matter-Y)。箱はこの上に積む。
  const floorTopM = VIEW_H - GROUND_H;
  // 山の基準: 画面右寄り。列数は箱数に応じて決定的に決める。
  const cols = clamp(Math.round(Math.sqrt(boxTarget) * 1.2), 4, 22);
  const gap = 2;                       // 箱同士の僅かな隙間(初期重なり回避)
  const cell = BOX + gap;
  const stackW = cols * cell;
  // 山の左端 X。右端を画面右壁の少し内側に合わせる。
  const rightEdge = VIEW_W - 40;
  const baseLeftX = rightEdge - stackW;

  // ターゲット箱は山の上方に決定的に数個(箱数に応じて2〜5個)。
  const targetCount = clamp(Math.floor(boxTarget / 20) + 1, 2, 5);
  // どのインデックスをターゲットにするか決定的に選ぶ(上のほうに来やすいよう後半から)。
  const targetIdx = new Set();
  {
    let placed = 0, guard = 0;
    while (placed < targetCount && guard++ < 1000) {
      // 後半(積み上げ順で上に来る)から決定的に選ぶ
      const idx = Math.floor(boxTarget * (0.6 + rng() * 0.4));
      if (idx < boxTarget && !targetIdx.has(idx)) { targetIdx.add(idx); placed++; }
    }
  }

  for (let i = 0; i < boxTarget; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // 格子配置。row が上がるほど Matter-Y は小さく(上へ)。
    const cx = baseLeftX + col * cell + cell / 2;
    // row 0 を床上面に乗せる。中心 = floorTop - (row*cell + cell/2)
    const cy = floorTopM - (row * cell + BOX / 2 + gap);
    const isTarget = targetIdx.has(i);
    const body = Bodies.rectangle(cx, cy, BOX, BOX, {
      friction: 0.6, frictionStatic: 0.8, restitution: 0.08, density: 0.0016,
      label: isTarget ? 'target' : 'box',
    });
    M.Composite.add(world, body);
    boxes.push({
      body, isTarget, scored: false,
      startX: cx, startY: cy, // Matter 座標での初期位置(移動量判定用)
    });
  }
}

// ワールド全体を再構築(R / +/- / init で使用)。
function rebuildWorld(resetScore) {
  if (!M) return;
  // 既存ワールドを破棄して作り直す(確実な決定性のため)。
  engine = M.Engine.create({ enableSleeping: true });
  world = engine.world;
  engine.gravity.y = PHYS_GRAVITY; // 下向き(Matter-Y は下向きが正)
  engine.gravity.x = 0;

  buildStatics();
  buildBoxes();

  shots = [];
  if (resetScore) { score = 0; shotsFired = 0; }
  autoTimer = 0;
  autoSeq = 0;
}

// ===================================================================
//  発射体 (プール最大8発)
// ===================================================================
// fromL/toL は LittleJS ワールド座標。dir = (to - from) を初速に比例させて発射。
function fireProjectile(originLX, originLY, dirX, dirY, power) {
  if (!M) return;
  // プールが満杯なら最古を除去
  if (shots.length >= MAX_SHOTS) {
    const old = shots.shift();
    if (old && old.body) M.Composite.remove(world, old.body);
  }
  const mx = l2mX(originLX), my = l2mY(originLY);
  const body = M.Bodies.circle(mx, my, BALL_R, {
    friction: 0.4, restitution: 0.35, density: 0.004, label: 'ball',
  });
  M.Composite.add(world, body);
  // 速度を設定。LittleJS の方向(Y上向き)→ Matter(Y下向き)へ y 符号反転。
  // power は px/step スケール。matter は per-step velocity を扱う。
  const vmx = dirX * power;
  const vmy = -dirY * power; // LittleJS の上(+Y) は Matter の上(-Y)
  M.Body.setVelocity(body, { x: vmx, y: vmy });
  shots.push({ body, age: 0 });
  shotsFired++;
}

// スリングショット発射: ドラッグ start から release end へ。引っ張った逆方向に飛ぶ。
function fireSlingshot(startL, endL) {
  // 発射台アンカー(LittleJS 座標)
  const anchorL = m2l(SLING_X, slingAnchorY);
  // 引っ張りベクトル = (start - end) … 引いた逆へ飛ばす
  let dx = startL.x - endL.x;
  let dy = startL.y - endL.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 4) return; // 微小ドラッグは無視
  const nx = dx / dist, ny = dy / dist;
  // 初速は引っ張り距離に比例(上限つき)。matter の per-step velocity スケール。
  const power = clamp(dist * 0.12, 1.5, 20);
  fireProjectile(anchorL.x, anchorL.y, nx, ny, power);
}

// クリックのみ発射: 発射台からクリック地点方向へ固定初速。
function fireToward(targetL) {
  const anchorL = m2l(SLING_X, slingAnchorY);
  let dx = targetL.x - anchorL.x;
  let dy = targetL.y - anchorL.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  const nx = dx / dist, ny = dy / dist;
  fireProjectile(anchorL.x, anchorL.y, nx, ny, 16); // 固定初速
}

// オートショット: 決定的な角度/初速で発射台から撃つ。
function fireAuto() {
  const anchorL = m2l(SLING_X, slingAnchorY);
  // 決定的に角度を振る(seq から sin で揺らす)。常に右上〜右方向へ。
  const t = autoSeq;
  const ang = 0.35 + 0.30 * Math.sin(t * 0.7); // ラジアン(上向き寄り)
  const power = 15 + 3 * Math.sin(t * 1.3);
  const nx = Math.cos(ang), ny = Math.sin(ang); // 右(+x)・上(+y in LittleJS)
  fireProjectile(anchorL.x, anchorL.y, nx, ny, power);
  autoSeq++;
}

// デモAI: アトラクト中 (started=false) に約2秒ごとに角度・強さを変えて発射 (累積時間ベース・決定的)。
function demoFire(dt) {
  demoTimer += dt;
  while (demoTimer >= DEMO_INTERVAL) {
    demoTimer -= DEMO_INTERVAL;
    const s = demoSeq++;
    const ang = 0.45 + 0.32 * Math.sin(s * 0.9);  // ラジアン(上向き寄り)で角度を振る
    const power = 17 + 4 * Math.sin(s * 1.7);
    const anchorL = m2l(SLING_X, slingAnchorY);
    const nx = Math.cos(ang), ny = Math.sin(ang); // 右(+x)・上(+y in LittleJS)
    fireProjectile(anchorL.x, anchorL.y, nx, ny, power);
  }
}

// Enter でデモ→プレイ開始: 新規リセット (R 相当) して操作を有効化、タイトルを消す。
function startGame() {
  started = true;
  rebuildWorld(true);
  const el = titleEl();
  if (el) el.style.display = 'none';
}

// ===================================================================
//  スコアリング / 場外除去
// ===================================================================
function updateScoring() {
  for (const b of boxes) {
    if (b.scored) continue;
    const p = b.body.position; // Matter 座標
    const dx = p.x - b.startX, dy = p.y - b.startY;
    if (dx * dx + dy * dy >= DISPLACE_THRESHOLD * DISPLACE_THRESHOLD) {
      b.scored = true;
      score += b.isTarget ? SCORE_TARGET : SCORE_NORMAL;
    }
  }
}

// 場外(床より下/壁の外)へ出てスリープした剛体を除去。剛体数の暴走防止。
function cullOffWorld() {
  // 箱: 画面下端より下 or 左右に大きく外れ、かつスリープ中なら除去
  for (let i = boxes.length - 1; i >= 0; i--) {
    const body = boxes[i].body;
    const p = body.position;
    const off = (p.y > VIEW_H + 80) || (p.x < -120) || (p.x > VIEW_W + 120);
    if (off && body.isSleeping) {
      M.Composite.remove(world, body);
      boxes.splice(i, 1);
    }
  }
  // 発射体: 場外スリープ or 寿命超過で除去
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    const p = s.body.position;
    const off = (p.y > VIEW_H + 80) || (p.x < -120) || (p.x > VIEW_W + 120);
    if ((off && s.body.isSleeping) || s.age > 12) {
      M.Composite.remove(world, s.body);
      shots.splice(i, 1);
    }
  }
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);              // 1ワールド単位 = 1px
  // LittleJS 自身のワールド原点は中央。左上原点(px)で扱うためカメラを画面中心へ。
  setCameraPos(vec2(VIEW_W / 2, VIEW_H / 2));
  setGravity(vec2(0, 0));         // LittleJS 物理は未使用(matter に委譲)

  // テクスチャ読込判定(1枚でも読めれば sprites 使用)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  boxTarget = 60;
  rebuildWorld(true);
  autoShot = false;
}

function gameUpdate() {
  if (!M) return;
  const dt = timeDelta; // 既定 1/60

  // ---- Enter: デモ→プレイ開始 ----
  if (!started && keyWasPressed('Enter')) {
    startGame();
  }

  // ---- 箱数 増減 (+/-) → 再構築 ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    boxTarget = clamp(boxTarget + BOX_STEP, BOX_MIN, BOX_MAX);
    rebuildWorld(false);
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    boxTarget = clamp(boxTarget - BOX_STEP, BOX_MIN, BOX_MAX);
    rebuildWorld(false);
  }

  // ---- R: 再構築(スコアもリセット) ----
  if (keyWasPressed('KeyR')) {
    rebuildWorld(true);
  }

  // ---- Space: オートショット トグル ----
  if (keyWasPressed('Space')) {
    autoShot = !autoShot;
    autoTimer = 0;
  }

  // ---- デモAI: アトラクト中 (!started) は約2秒ごとに自動発射 ----
  if (!started) {
    demoFire(dt);
  } else if (autoShot) {
    autoTimer += dt;
    while (autoTimer >= AUTO_INTERVAL) {
      autoTimer -= AUTO_INTERVAL;
      fireAuto();
    }
  }

  // ---- マウス: スリングショット ドラッグ / クリック (アトラクト中は無効) ----
  // mousePos は LittleJS ワールド座標(Y上向き)。
  if (started && mouseWasPressed(0)) {
    dragging = true;
    dragStart = mousePos.copy ? mousePos.copy() : vec2(mousePos.x, mousePos.y);
  }
  if (dragging && !mouseIsDown(0)) {
    // リリース: ドラッグがあればスリングショット、無ければクリック方向へ。
    dragging = false;
    if (started && dragStart) {
      const endL = vec2(mousePos.x, mousePos.y);
      const moved = Math.hypot(endL.x - dragStart.x, endL.y - dragStart.y);
      if (moved >= 8) fireSlingshot(dragStart, endL);
      else fireToward(endL); // ほぼ動かさないクリックはクリック地点方向へ
    }
    dragStart = null;
  }

  // ---- 物理ステップ(matter に委譲) ----
  // dt(秒) を ms に変換して Engine.update。固定タイムステップ寄りに 1000/60 を使う。
  M.Engine.update(engine, 1000 / 60);

  // 発射体の寿命を加算
  for (const s of shots) s.age += dt;

  // ---- スコアリング / 場外除去 ----
  updateScoring();
  cullOffWorld();
}

function gameUpdatePost() {}

// ===================================================================
//  描画 (LittleJS ワールド空間, Matter→LittleJS 変換)
// ===================================================================
function drawBody(body, w, h, texIndex, fallbackColor) {
  const p = body.position;            // Matter 座標
  const pos = m2l(p.x, p.y);          // LittleJS ワールドへ反転変換
  const ang = m2lAngle(body.angle);   // 角度も反転
  if (spriteReady(texIndex)) {
    drawTile(pos, vec2(w, h), texTile(texIndex), new Color(1, 1, 1), ang);
  } else {
    drawRect(pos, vec2(w, h), fallbackColor, ang);
  }
}

function gameRender() {
  // ---- 背景(空) ----
  const center = vec2(VIEW_W / 2, VIEW_H / 2);
  if (spriteReady(TEX.bg)) {
    drawTile(center, vec2(VIEW_W, VIEW_H), texTile(TEX.bg));
  } else {
    drawRect(center, vec2(VIEW_W, VIEW_H), COL_SKY);
  }

  // ---- 床(静的) ----
  {
    const p = groundBody.position;
    const pos = m2l(p.x, p.y);
    if (spriteReady(TEX.ground)) {
      drawTile(pos, vec2(VIEW_W, GROUND_H), texTile(TEX.ground));
    } else {
      drawRect(pos, vec2(VIEW_W, GROUND_H), COL_GROUND);
    }
  }
  // ---- 壁(静的・図形のみ。画面内に見える内側面だけ薄く描く) ----
  drawRect(vec2(2, VIEW_H / 2), vec2(4, VIEW_H), COL_WALL);
  drawRect(vec2(VIEW_W - 2, VIEW_H / 2), vec2(4, VIEW_H), COL_WALL);

  // ---- 発射台(スリングショット) ----
  {
    const pos = m2l(SLING_X, slingAnchorY + 20);
    if (spriteReady(TEX.sling)) {
      drawTile(pos, vec2(48, 64), texTile(TEX.sling));
    } else {
      drawRect(pos, vec2(14, 64), COL_SLING);
    }
  }

  // ---- ドラッグ中の照準ライン(スリングショットのゴム) ----
  if (dragging && dragStart) {
    const anchorL = m2l(SLING_X, slingAnchorY);
    drawLine(anchorL, vec2(mousePos.x, mousePos.y), 2, new Color(1, 1, 1, 0.7));
    // 予測方向(引いた逆向き)を短く表示
    let dx = dragStart.x - mousePos.x, dy = dragStart.y - mousePos.y;
    const d = Math.hypot(dx, dy) || 1;
    drawLine(anchorL, vec2(anchorL.x + dx / d * 60, anchorL.y + dy / d * 60), 2,
             new Color(1, 0.8, 0.2, 0.8));
  }

  // ---- 箱(動的) ----
  for (const b of boxes) {
    const tex = b.isTarget ? TEX.target : TEX.box;
    const col = b.isTarget ? COL_TARGET : COL_BOX;
    drawBody(b.body, BOX, BOX, tex, col);
  }

  // ---- 発射体 ----
  for (const s of shots) {
    const p = s.body.position;
    const pos = m2l(p.x, p.y);
    if (spriteReady(TEX.ball)) {
      drawTile(pos, vec2(BALL_R * 2, BALL_R * 2), texTile(TEX.ball));
    } else {
      // drawCircle の size は「直径」指定(内部で size/2 が半径)。半径12 → 直径24。
      drawCircle(pos, BALL_R * 2, COL_BALL);
    }
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function countActive() {
  // 覚醒(awake)している剛体数 = 動的剛体のうち isSleeping=false。
  let n = 0;
  for (const b of boxes) if (!b.body.isSleeping) n++;
  for (const s of shots) if (!s.body.isSleeping) n++;
  return n;
}

function gameRenderPost() {
  // FPS 指数移動平均(エンジン内蔵 frameRate を平滑化)
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  // Bodies 総数 = 箱 + 発射体 + 床1 + 壁2
  const staticCount = 1 + wallBodies.length;
  const totalBodies = boxes.length + shots.length + staticCount;
  const active = countActive();

  // タイトル点滅 (約0.45s 周期)。アトラクト中のみ表示。
  if (!started) {
    blinkT += timeDelta;
    const t = titleEl();
    if (t) t.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
  }

  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS     : ' + fpsAvg.toFixed(1) + '\n' +
      'Bodies  : ' + totalBodies + '  (箱 ' + boxes.length + ' / 設定 ' + boxTarget + ')\n' +
      'Active  : ' + active + '  (awake, sleeping は除外)\n' +
      'Shots   : ' + shots.length + ' / ' + MAX_SHOTS + '  (累計 ' + shotsFired + ')\n' +
      'Score   : ' + score + '\n' +
      'Engine  : Matter (CDN)' +
      (useSprites ? '   [sprites]' : '   [shapes fallback]') +
      (autoShot ? '   AUTO:ON' : '   AUTO:OFF');
  }
}

// ===================================================================
//  起動
// ===================================================================
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources);
