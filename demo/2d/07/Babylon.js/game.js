"use strict";

/* =========================================================================
 * テーマ7: 物理パズル (剛体物理 / 投擲物理) ― Babylon.js + Matter.js 版
 *
 * 本テーマは「本物の2D剛体物理エンジンを使った時の統合相性と剛体数スケール」を測る。
 *  - Babylon.js は3Dエンジンで、内蔵物理(Havok/Ammo)は3D前提。本テーマは純2Dなので
 *    剛体シミュレーションは matter-js (CDN) に委譲し、Babylon は「描画専用」に徹する。
 *  - 毎フレーム Matter.Engine.update() を回し、各 Matter ボディの x/y/angle を
 *    Babylon のスプライト/プレーンへ転写する (物理 px → 正射影ワールド px は 1:1)。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を再現。
 *    Matter も「左上原点・+y 下向き」なので Y 軸反転は不要で 1:1 同期できる。
 *  - テクスチャがあれば Sprite、無ければ単色 Plane/Disc にフォールバックして必ず起動する。
 *  - 構造物・発射体角度は決定的擬似乱数 (mulberry32) で生成 (Math.random 不使用)。
 * ========================================================================= */

(function () {

/* ---------- Matter エイリアス ---------- */
const M = window.Matter;
const Engine = M.Engine, World = M.World, Bodies = M.Bodies,
      Body = M.Body, Composite = M.Composite, Events = M.Events,
      Sleeping = M.Sleeping, Vector = M.Vector;

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;

const GROUND_H = 48;                 // 床の見た目高さ (px)
const GROUND_TOP = VIEW_H - GROUND_H; // 床の上面 y (= 492)。箱はこの上に積む
const WALL_T = 40;                   // 壁の厚み (px, 大半は画面外)

// 重力: px 系。見た目で「箱が約1〜1.5sで落ち着く」程度 (~1000 px/s² 相当)。
// Matter の gravity.scale は既定 0.001、y=1 で約 1000 px/s² 相当になる。
const GRAVITY_Y = 1.0;

const BOX = 34;                      // 1箱 34x34 px
const BALL_R = 12;                   // 発射体の半径

// 構造物: 箱数 (負荷)
const INITIAL_BOXES = 60;
const BOX_STEP = 20;
const MIN_BOXES = 20;
const MAX_BOXES = 600;

// スコア / 崩し判定
const SCORE_TARGET = 50;             // ターゲット箱を崩す
const SCORE_NORMAL = 10;             // 通常箱を崩す
const DISPLACE_DIST = 64;            // 初期位置から 64px 移動で「崩した」とみなす

// 発射体
const MAX_SHOTS = 8;                 // 同時最大 (プール, 古いものから消す)
const BALL_SPEED_CLICK = 18;         // クリック発射の初速 (px/step 相当)
const SLING_POWER = 0.16;            // ドラッグ距離 → 初速のスケール
const SLING_MAX = 24;                // 初速の上限

// オートショット
const AUTO_INTERVAL = 0.8;           // s

// 発射台 (スリングショット)
const SLING_X = 90;
const SLING_Y = GROUND_TOP - 40;     // 発射原点 (床の少し上)

// 場外スリープ body 除去のしきい
const OUT_MARGIN = 200;

/* ---------- アセット定義 ---------- */
const ASSET_DIR = "../assets/";
const ASSETS = {
  box:    { file: "box.png",        w: BOX, h: BOX,     fallback: "#8a5a2b", shape: "rect" },
  target: { file: "box_target.png", w: BOX, h: BOX,     fallback: "#ff8c2b", shape: "rect" },
  ball:   { file: "ball.png",       w: BALL_R * 2, h: BALL_R * 2, fallback: "#e23b3b", shape: "circle" },
  ground: { file: "ground.png",     w: 64, h: 64,       fallback: "#5a7a3a", shape: "rect" },
  sling:  { file: "slingshot.png",  w: 48, h: 64,       fallback: "#888888", shape: "rect" },
  bg:     { file: "bg_sky.png",     w: 512, h: 512,     fallback: "#6bb7ff", shape: null },
};

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じ構造物/発射角度を生成する。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
 *  Babylon セットアップ (描画専用)
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.42, 0.72, 1.0, 1.0); // 空色 (背景フォールバック)
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) ---
// orthoTop < orthoBottom にして y 下向きにすると Matter の座標系と 1:1 で一致する。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

// sprite/plane が見えるよう環境光 (マテリアルは unlit だが念のため)
const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* ---------- テクスチャ存在チェック ---------- */
// SpriteManager は読込失敗時に黒テクスチャになるので、事前に Image で存在確認する。
function checkImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

const managers = {}; // key -> SpriteManager or null
const SPRITE_CAPACITY = 1024;

function makeManager(key, capacity) {
  const a = ASSETS[key];
  const sm = new BABYLON.SpriteManager(
    "sm_" + key, ASSET_DIR + a.file, capacity || SPRITE_CAPACITY,
    { width: a.w, height: a.h }, scene
  );
  sm.isPickable = false;
  return sm;
}

// フォールバック用 単色マテリアル (共有)
const fallbackMats = {};
function fallbackMat(key) {
  if (fallbackMats[key]) return fallbackMats[key];
  const a = ASSETS[key];
  const m = new BABYLON.StandardMaterial("fm_" + key, scene);
  const c = BABYLON.Color3.FromHexString(a.fallback || "#888888");
  m.emissiveColor = c;
  m.diffuseColor = c;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.backFaceCulling = false;
  fallbackMats[key] = m;
  return m;
}

// テンプレ mesh (矩形 or 円)。インスタンス毎に clone する。
const fallbackTemplates = {};
function fallbackTemplate(key) {
  if (fallbackTemplates[key]) return fallbackTemplates[key];
  const a = ASSETS[key];
  let mesh;
  if (a.shape === "circle") {
    mesh = BABYLON.MeshBuilder.CreateDisc("ft_" + key, { radius: 0.5, tessellation: 18 }, scene);
  } else {
    // 1x1 の Plane を基準にし、scaling で実サイズへ
    mesh = BABYLON.MeshBuilder.CreatePlane("ft_" + key, { width: 1, height: 1 }, scene);
  }
  mesh.material = fallbackMat(key);
  mesh.isPickable = false;
  mesh.setEnabled(false);
  fallbackTemplates[key] = mesh;
  return mesh;
}

/* ---------- 統一スプライトラッパ ----------
 * { setPos(x,y,z), setVisible(b), setSize(w,h), setAngle(rad), dispose() }
 * 座標は画面/ワールド px をそのまま渡す (ortho が px 等倍なので変換不要)。
 * Matter の angle (rad, 時計回り) を回転として反映できるようにする。
 */
function createEntitySprite(key) {
  const a = ASSETS[key];
  if (managers[key]) {
    const sp = new BABYLON.Sprite("s_" + key, managers[key]);
    sp.width = a.w;
    sp.height = a.h;
    return {
      kind: "sprite", obj: sp,
      setPos(x, y, z) { sp.position.x = x; sp.position.y = y; sp.position.z = (z == null ? 0 : z); },
      setVisible(b) { sp.isVisible = b; },
      setSize(w, h) { sp.width = w; sp.height = h; },
      // Babylon Sprite の angle は反時計回り。Matter は y 下向きで時計回りなので符号反転で一致。
      setAngle(rad) { sp.angle = -rad; },
      dispose() { sp.dispose(); },
    };
  } else {
    const mesh = fallbackTemplate(key).clone("c_" + key);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    return {
      kind: "mesh", obj: mesh,
      setPos(x, y, z) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = (z == null ? 0 : z); },
      setVisible(b) { mesh.setEnabled(b); },
      setSize(w, h) { mesh.scaling.x = w; mesh.scaling.y = h; },
      // mesh は z 軸まわりに回転。ortho は y 下向きなので Matter angle をそのまま使える。
      setAngle(rad) { mesh.rotation.z = rad; },
      dispose() { mesh.dispose(); },
    };
  }
}

/* =========================================================================
 *  背景 (空) ― 画面全体を覆う 1 枚
 * ========================================================================= */
let bgSprite = null;
function setupBackground() {
  bgSprite = createEntitySprite("bg");
  bgSprite.setSize(VIEW_W, VIEW_H);
  bgSprite.setPos(VIEW_W / 2, VIEW_H / 2, 60); // 一番奥
}

/* =========================================================================
 *  Matter 物理ワールド
 * ========================================================================= */
const physics = Engine.create();
physics.gravity.y = GRAVITY_Y;
physics.gravity.scale = 0.001; // 既定値 (明示)。y=1 で約 1000 px/s²

// 物理を安定させるためのソルバ反復 (大量スタックでもめり込みにくく)
physics.positionIterations = 8;
physics.velocityIterations = 6;

// 静的構造 (床・壁) は再構築しても作り直さず使い回す。
let staticBodies = [];
function buildStatics() {
  for (const b of staticBodies) Composite.remove(physics.world, b);
  staticBodies = [];
  const opt = { isStatic: true, friction: 0.9, restitution: 0.1, label: "static" };

  // 床: 上面が GROUND_TOP になるよう中心 y を置く
  const ground = Bodies.rectangle(
    VIEW_W / 2, GROUND_TOP + GROUND_H / 2, VIEW_W, GROUND_H, opt
  );
  // 左右の壁 (画面のすぐ外側に立て、場外流出を防ぐ)
  const wallL = Bodies.rectangle(-WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, opt);
  const wallR = Bodies.rectangle(VIEW_W + WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, opt);
  // 天井 (高速発射体が上に抜けるのを防ぐ)
  const ceil = Bodies.rectangle(VIEW_W / 2, -WALL_T / 2, VIEW_W, WALL_T, opt);

  staticBodies = [ground, wallL, wallR, ceil];
  Composite.add(physics.world, staticBodies);
}

/* ---------- 床 / 発射台の見た目 ---------- */
let groundTiles = [];
let slingSprite = null;
function setupDecor() {
  // 床: ground.png をタイル状に並べる (64px 単位)
  const a = ASSETS.ground;
  const cols = Math.ceil(VIEW_W / a.w) + 1;
  for (let i = 0; i < cols; i++) {
    const t = createEntitySprite("ground");
    t.setSize(a.w, GROUND_H);
    t.setPos(i * a.w + a.w / 2, GROUND_TOP + GROUND_H / 2, 1);
    groundTiles.push(t);
  }
  // 発射台
  slingSprite = createEntitySprite("sling");
  slingSprite.setSize(ASSETS.sling.w, ASSETS.sling.h);
  slingSprite.setPos(SLING_X, GROUND_TOP - ASSETS.sling.h / 2, 0);
}

/* =========================================================================
 *  ゲーム状態
 * ========================================================================= */
const Game = {
  boxes: [],        // {body, spr, key, initX, initY, scored, isTarget}
  shots: [],        // {body, spr, born} ― 発射体プール (FIFO)
  boxSetting: INITIAL_BOXES,
  score: 0,
  shotsFired: 0,
  autoShot: false,
  autoTimer: 0,
  // タイトル/アトラクト状態: started=false … デモ中(操作無効・デモAIが自動発射)
  started: false,
  blinkT: 0,
  demoTimer: 0,   // デモ自動発射の計時 (累積)
  demoSeq: 0,     // デモ発射回数 (決定的に角度/強さを振る)
};

const DEMO_INTERVAL = 2.0;            // 約2秒ごとにデモ発射
const titleEl = document.getElementById("title");

/* =========================================================================
 *  構造物 (箱スタック) ― 決定的に生成
 * ========================================================================= */
// 箱数 n に応じて「列数・段数」を決定的に決め、右側にピラミッド/格子状に積む。
// 頂上付近の数個をターゲット箱にする。
function buildStack(n) {
  // 既存の箱を破棄
  for (const b of Game.boxes) { Composite.remove(physics.world, b.body); b.spr.dispose(); }
  Game.boxes.length = 0;

  const rnd = mulberry32(0x7B0C); // 固定シード

  // 格子の基準: 右側の地面の上。列幅は箱サイズ + わずかな隙間。
  const cell = BOX + 1;
  // n 個を概ね正方形に近い格子へ。列数 cols = round(sqrt(n*1.4)) 程度。
  let cols = Math.max(3, Math.round(Math.sqrt(n * 1.4)));
  const baseRightX = VIEW_W - 70;        // 一番右の列の中心 x
  const stackLeftLimit = 360;            // これより左には積まない (発射スペース確保)
  // 列数が広すぎる場合は左限界で頭打ち
  const maxCols = Math.floor((baseRightX - stackLeftLimit) / cell);
  if (cols > maxCols) cols = Math.max(3, maxCols);

  // ターゲット数 (頂上付近) ― 決定的に 2〜4 個
  const targetCount = 2 + (n % 3); // n により 2..4

  // 列ごとの高さを決め、低い列から積んでピラミッドっぽくする。
  // まず各箱の (col,row) を割り当て: 下段優先で円錐状に。
  const placed = []; // {col,row}
  // 列ごとの現在の段数
  const colRows = new Array(cols).fill(0);
  // ピラミッド傾向: 中央寄りの列ほど高く積めるよう重み付けした順で埋める。
  const centerCol = (cols - 1) / 2;
  for (let i = 0; i < n; i++) {
    // 一番低く、かつ中央に近い列を選ぶ (決定的)
    let best = 0, bestScore = Infinity;
    for (let c = 0; c < cols; c++) {
      // スコア = 段数 * 2 + 中央からの距離 + 微小ノイズ(決定的)
      const sc = colRows[c] * 2 + Math.abs(c - centerCol) * 0.6 + rnd() * 0.2;
      if (sc < bestScore) { bestScore = sc; best = c; }
    }
    placed.push({ col: best, row: colRows[best] });
    colRows[best]++;
  }

  // ターゲットにする箱: 各列の最上段のうち、中央寄り targetCount 個
  // 列の最上段 row = colRows[col]-1。最上段箱を集めて中央距離でソート。
  const topByCol = new Map(); // col -> 最大 row の placed index
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const cur = topByCol.get(p.col);
    if (cur == null || placed[cur].row < p.row) topByCol.set(p.col, i);
  }
  const tops = [...topByCol.values()].sort((ia, ib) => {
    const da = Math.abs(placed[ia].col - centerCol);
    const db = Math.abs(placed[ib].col - centerCol);
    return da - db;
  });
  const targetIdx = new Set(tops.slice(0, targetCount));

  // 実体化: col → x, row → y (下から上へ)
  const leftColX = baseRightX - (cols - 1) * cell;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const x = leftColX + p.col * cell;
    const y = GROUND_TOP - BOX / 2 - p.row * cell; // 段ごとに上へ
    const isTarget = targetIdx.has(i);

    const body = Bodies.rectangle(x, y, BOX, BOX, {
      friction: 0.6,
      frictionStatic: 0.8,
      restitution: 0.05,
      density: 0.002,
      label: isTarget ? "target" : "box",
      sleepThreshold: 30, // 早めに眠らせて負荷を抑える
    });
    Composite.add(physics.world, body);

    const key = isTarget ? "target" : "box";
    const spr = createEntitySprite(key);
    spr.setSize(BOX, BOX);
    spr.setPos(x, y, isTarget ? -1 : 0);

    Game.boxes.push({ body, spr, key, initX: x, initY: y, scored: false, isTarget });
  }
}

/* =========================================================================
 *  発射体 (projectile) ― 最大 8 発プール (FIFO)
 * ========================================================================= */
function disposeShot(s) {
  Composite.remove(physics.world, s.body);
  s.spr.dispose();
}

function fireBall(vx, vy) {
  // 古いものから消す: 上限に達していたら先頭を破棄
  while (Game.shots.length >= MAX_SHOTS) {
    const old = Game.shots.shift();
    disposeShot(old);
  }
  const body = Bodies.circle(SLING_X, SLING_Y, BALL_R, {
    friction: 0.4,
    restitution: 0.4,
    density: 0.01,        // 箱より重く → 当たると崩れる
    label: "ball",
    sleepThreshold: 60,
  });
  Composite.add(physics.world, body);
  Body.setVelocity(body, { x: vx, y: vy });

  const spr = createEntitySprite("ball");
  spr.setSize(BALL_R * 2, BALL_R * 2);
  spr.setPos(SLING_X, SLING_Y, -2);

  Game.shots.push({ body, spr, born: performance.now() });
  Game.shotsFired++;
}

// クリック発射: 発射台から (tx,ty) 方向へ固定初速。
function fireToward(tx, ty) {
  let dx = tx - SLING_X, dy = ty - SLING_Y;
  const len = Math.hypot(dx, dy) || 1;
  fireBall((dx / len) * BALL_SPEED_CLICK, (dy / len) * BALL_SPEED_CLICK);
}

// スリングショット: ドラッグ始点→終点ベクトルと逆向き(引いた方向の反対)へ発射。
function fireSling(dragDx, dragDy) {
  // 引いた距離に比例した初速。引いた向きの反対へ飛ばす。
  let vx = -dragDx * SLING_POWER;
  let vy = -dragDy * SLING_POWER;
  const sp = Math.hypot(vx, vy);
  if (sp > SLING_MAX) { vx = vx / sp * SLING_MAX; vy = vy / sp * SLING_MAX; }
  fireBall(vx, vy);
}

// オートショット: 0.8s ごとに決定的な角度/初速で発射 (マウス不要のベンチ用)。
const autoRnd = mulberry32(0xA570);
function fireAuto() {
  // 角度 -20°〜-55° (右上方向), 初速 16〜22 を決定的に振る
  const ang = -(20 + autoRnd() * 35) * Math.PI / 180;
  const spd = 16 + autoRnd() * 6;
  fireBall(Math.cos(ang) * spd, Math.sin(ang) * spd);
}

// デモAI: アトラクト中 (started=false) は約2秒ごとに角度・強さを変えて発射 (累積時間ベース・決定的)。
function demoFire(dt) {
  Game.demoTimer += dt;
  while (Game.demoTimer >= DEMO_INTERVAL) {
    Game.demoTimer -= DEMO_INTERVAL;
    const s = Game.demoSeq++;
    const ang = -(38 - 22 * Math.sin(s * 0.9)) * Math.PI / 180; // 右上方向で角度を振る
    const spd = 19 + 5 * Math.sin(s * 1.7);
    fireBall(Math.cos(ang) * spd, Math.sin(ang) * spd);
  }
}

// Enter でデモ→プレイ開始: 新規リセット (R 相当) して操作を有効化、タイトルを消す。
function startGame() {
  Game.started = true;
  rebuild();
  titleEl.style.display = "none";
}

/* =========================================================================
 *  入力
 * ========================================================================= */
let dragging = false;
let dragStart = null; // {x,y} ワールド px

// canvas 上のピクセル座標をワールド px (ortho 等倍なのでそのまま) へ。
function pointerToWorld(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (VIEW_W / rect.width);
  const y = (ev.clientY - rect.top) * (VIEW_H / rect.height);
  return { x, y };
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.focus();
  const p = pointerToWorld(ev);
  dragging = true;
  dragStart = p;
});
canvas.addEventListener("pointerup", (ev) => {
  if (!dragging) return;
  dragging = false;
  if (!Game.started) { dragStart = null; return; } // アトラクト中はユーザー発射を無効化
  const p = pointerToWorld(ev);
  const dx = p.x - dragStart.x;
  const dy = p.y - dragStart.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) {
    // ほぼ動いていない → クリック発射 (クリック地点へ向けて)
    fireToward(p.x, p.y);
  } else {
    // ドラッグ&リリース → スリングショット
    fireSling(dx, dy);
  }
  dragStart = null;
});

const keys = Object.create(null);
window.addEventListener("keydown", (ev) => {
  const k = ev.key.toLowerCase();
  keys[k] = true;
  if (k === "enter") {
    if (!Game.started) startGame();
    ev.preventDefault();
  } else if (ev.key === "+" || ev.key === "=" || ev.key === "Add") {
    setBoxCount(Game.boxSetting + BOX_STEP);
  } else if (ev.key === "-" || ev.key === "_" || ev.key === "Subtract") {
    setBoxCount(Game.boxSetting - BOX_STEP);
  } else if (k === "r") {
    rebuild();
  } else if (k === " ") {
    Game.autoShot = !Game.autoShot;
    Game.autoTimer = 0;
    ev.preventDefault();
  }
});
window.addEventListener("keyup", (ev) => { keys[ev.key.toLowerCase()] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

/* ---------- 箱数変更 / 再構築 ---------- */
function setBoxCount(n) {
  n = Math.max(MIN_BOXES, Math.min(MAX_BOXES, n));
  Game.boxSetting = n;
  rebuild();
}

function rebuild() {
  // 発射体を全消し
  for (const s of Game.shots) disposeShot(s);
  Game.shots.length = 0;
  // 構造物を作り直し (決定的)
  buildStack(Game.boxSetting);
  Game.score = 0;
  Game.shotsFired = 0;
}

/* =========================================================================
 *  毎フレーム更新: Matter を進めて Babylon へ同期
 * ========================================================================= */
function updatePhysics(dt) {
  // Matter は ms 単位の固定/可変ステップ。dt(s)→ms。スパイク抑制でクランプ。
  const ms = Math.min(dt, 0.033) * 1000;
  Engine.update(physics, ms);
}

// 箱の崩し判定 (初期位置から DISPLACE_DIST 以上移動で1回加点)。
function checkScoring() {
  for (const b of Game.boxes) {
    if (b.scored) continue;
    const dx = b.body.position.x - b.initX;
    const dy = b.body.position.y - b.initY;
    if (dx * dx + dy * dy >= DISPLACE_DIST * DISPLACE_DIST) {
      b.scored = true;
      Game.score += b.isTarget ? SCORE_TARGET : SCORE_NORMAL;
    }
  }
}

// 場外に出てスリープした剛体を除去 (剛体数の暴走防止)。
function reapOutOfWorld() {
  // 発射体: 場外 or 寿命超過 (画面外で眠ったもの)
  for (let i = Game.shots.length - 1; i >= 0; i--) {
    const s = Game.shots[i];
    const p = s.body.position;
    const off = p.x < -OUT_MARGIN || p.x > VIEW_W + OUT_MARGIN || p.y > VIEW_H + OUT_MARGIN;
    if (off && s.body.isSleeping) {
      disposeShot(s);
      Game.shots.splice(i, 1);
    } else if (off && p.y > VIEW_H + OUT_MARGIN * 2) {
      // 完全に下方へ抜けたら眠り待たず除去
      disposeShot(s);
      Game.shots.splice(i, 1);
    }
  }
  // 箱: 床より下/壁の外へ出てスリープしたら除去 (加点済みフラグは保持)
  for (let i = Game.boxes.length - 1; i >= 0; i--) {
    const b = Game.boxes[i];
    const p = b.body.position;
    const off = p.x < -OUT_MARGIN || p.x > VIEW_W + OUT_MARGIN || p.y > VIEW_H + OUT_MARGIN;
    if (off && b.body.isSleeping) {
      Composite.remove(physics.world, b.body);
      b.spr.dispose();
      Game.boxes.splice(i, 1);
    }
  }
}

// Matter ボディ → Babylon スプライト (位置 + 回転) を転写。
function syncSprites() {
  for (const b of Game.boxes) {
    const p = b.body.position;
    b.spr.setPos(p.x, p.y, b.isTarget ? -1 : 0);
    b.spr.setAngle(b.body.angle);
  }
  for (const s of Game.shots) {
    const p = s.body.position;
    s.spr.setPos(p.x, p.y, -2);
    s.spr.setAngle(s.body.angle);
  }
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;

// 覚醒している剛体数 (動的 body のうち !isSleeping)。
function countActive() {
  let n = 0;
  for (const b of Game.boxes) if (!b.body.isSleeping) n++;
  for (const s of Game.shots) if (!s.body.isSleeping) n++;
  return n;
}

function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const active = countActive();
  const renderMode = managers.box ? "Sprite(tex)" : "Plane(fallback)";

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>     <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Bodies</span>  <span class="hudVal">' + Game.boxes.length + ' / ' + Game.boxSetting + '</span>\n' +
    '<span class="hudLabel">Active</span>  <span class="hudVal">' + active + '</span>\n' +
    '<span class="hudLabel">Shots</span>   <span class="hudVal">' + Game.shots.length + ' (累計 ' + Game.shotsFired + ')</span>\n' +
    '<span class="hudLabel">Score</span>   <span class="hudVal">' + Game.score + '</span>\n' +
    '<span class="hudLabel">Engine</span>  <span class="hudVal">Matter (2D)</span>' +
      (Game.autoShot ? '  <span class="warn">[AUTO]</span>' : '') +
      (assetsAllOk ? '' : '\n<span style="color:#888">(一部/全アセット欠落→図形描画)</span>');
}

/* =========================================================================
 *  起動: アセット確認 → 構築 → ループ開始
 * ========================================================================= */
let assetsAllOk = true;

async function boot() {
  const keysToCheck = ["box", "target", "ball", "ground", "sling", "bg"];
  const results = await Promise.all(
    keysToCheck.map((k) => checkImage(ASSET_DIR + ASSETS[k].file))
  );
  keysToCheck.forEach((k, idx) => {
    if (results[idx]) {
      try { managers[k] = makeManager(k); }
      catch (e) { managers[k] = null; assetsAllOk = false; }
    } else {
      managers[k] = null;
      assetsAllOk = false;
    }
  });

  setupBackground();
  buildStatics();
  setupDecor();
  buildStack(Game.boxSetting);

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制 (SPEC: clamp 0.05)

    // デモAI: アトラクト中 (!started) は約2秒ごとに自動発射
    if (!Game.started) demoFire(dt);

    // オートショット
    if (Game.started && Game.autoShot) {
      Game.autoTimer -= dt;
      if (Game.autoTimer <= 0) { fireAuto(); Game.autoTimer = AUTO_INTERVAL; }
    }

    updatePhysics(dt);
    checkScoring();
    reapOutOfWorld();
    syncSprites();
    updateHud(dt);
    scene.render();

    // タイトル点滅 (約0.45s 周期)
    if (!Game.started) {
      Game.blinkT += dt;
      titleEl.style.visibility = (Math.floor(Game.blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
    }
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
