'use strict';

/*
  テーマ12 フォーリングサンド / セルオートマトン（動的テクスチャ書き換え）― LittleJS 版
  ---------------------------------------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / グリッド COLS x ROWS (ROWS = round(COLS*540/960))
   - セル素材: 0=空気(empty) 1=砂(sand) 2=水(water) 3=壁(wall, 不動)
   - 走査は決定的(下の行から上へ。各行は左右交互スキャンで偏り抑制)。Math.random 不使用。
   - 砂: 真下が空/水なら落下、塞がれば左下/右下(決定的)、水とは入れ替わる(砂が沈む)。
   - 水: 真下が空なら落下、塞がれば左下/右下、それも塞がれば左右へ広がる(決定的順)。
   - 壁: 不動。場外=壁扱い。
   - 上部に決定的エミッタ(マウス無しでも常時セルが動く=ベンチ安定)。
   - 左ドラッグ=ブラシ描画 / 右ドラッグ=消去 / 1,2,3=砂/水/壁 / +,-=解像度 / C=クリア / R=リセット
   - COLS 初期 160(ROWS=90), +/- で ±40, 下限 80・上限 640。解像度変更時は決定的に作り直す。

  ★★ ベンチの計測軸 = 毎フレームの「全面テクスチャ書き換え + GPU アップロード」★★
   - COLS×ROWS の全セルの RGBA を毎フレーム ImageData に書き込み、
     オフスクリーン <canvas>(サイズ COLS×ROWS) へ putImageData、
     それを LittleJS の mainContext へ drawImage で 960x540 に拡大 blit する。
   - 拡大補間は imageSmoothingEnabled=false(ニアレストネイバー)でドットをくっきり。
   - 機構ラベル: "ImageData→offscreen canvas→drawImage(mainContext, nearest)"。
   - LittleJS の tile テクスチャ機構は使わず、素直に 2D context へ直 blit する(これが LittleJS の素直な選択)。

  ★★ 座標系 / Y軸メモ (最重要) ★★
   - LittleJS のワールドは Y軸"上向き"だが、本シムは「スクリーン空間ピクセル(左上原点, y下向き)」で
     完結させて y-up の混乱を避ける。グリッド row 0 = 画面上端, row 増 = 下方向。重力は row 増方向。
   - 描画も mainContext へ直接 blit するため world 座標を一切経由しない(canvas ピクセル左上原点)。
   - 唯一 world 座標に触れるのが「マウス位置」。LittleJS の mousePos は world(y-up)なので、
     mousePosScreen(canvas ピクセル, 左上原点, y下向き)を使ってセル添字へ変換する(後述 main gotcha)。
     mousePosScreen が無い古い版に備え、mousePos(world,y-up)→screen への手動変換もフォールバックで用意。
*/

// ---- 画面・グリッド定数 (SPEC) ----
const VIEW_W = 960, VIEW_H = 540;       // 固定キャンバス(表示)
const COLS_INIT = 160;                  // 初期 COLS (→ ROWS=90, 14400 セル)
const COLS_STEP = 40;                   // +/- の刻み
const COLS_MIN = 80, COLS_MAX = 640;    // 下限・上限

// ---- セル素材 ----
const EMPTY = 0, SAND = 1, WATER = 2, WALL = 3;
const BRUSH_NAME = { 1: 'sand', 2: 'water', 3: 'wall', 0: 'empty' };

// ---- ブラシ ----
const BRUSH_RADIUS = 3;                 // ブラシ半径(セル)
let brushMat = SAND;                    // 現在のブラシ素材(初期=砂)

// ---- グリッド状態 ----
let COLS = COLS_INIT, ROWS = rowsFor(COLS_INIT);
let grid;                               // Uint8Array(COLS*ROWS) フラット格子。idx = r*COLS + c
let moved;                              // Uint8Array 同サイズ。当該フレームで処理済み(二重移動防止)フラグ
let activeCount = 0;                    // 空気以外のセル数
let movedCount = 0;                     // 当該フレームで移動したセル数
let scanLeftToRight = true;             // 行ごと左右交互スキャンのトグル

// ---- テクスチャ(動的)関連 ----
let offCanvas = null;                   // オフスクリーン <canvas>(サイズ COLS×ROWS)
let offCtx = null;                      // その 2D context
let imgData = null;                     // ImageData(COLS×ROWS)。毎フレーム全画素を書く
let pix = null;                         // imgData.data (Uint8ClampedArray)

// ---- エミッタ(決定的) ----
let emitters = [];                      // {c, r, mat, rate} 上部固定エミッタ群

// ---- 色テーブル(SPEC基準・砂は濃淡を決定的に変える) ----
// 砂: #d9c067 系の濃淡, 水: #3a7bd5 系, 壁: #888, 空気: #0b0d12
const COL_AIR = [0x0b, 0x0d, 0x12];
const COL_WALL = [0x88, 0x88, 0x88];
// 砂セルごとの濃淡を決めるため、セルに「色ノイズ」を別バッファで持つ。
let tint;                               // Uint8Array(COLS*ROWS) 0..255 砂/水の濃淡シード

// ---- FPS 指数移動平均 ----
let fpsAvg = 60;

const hudEl = () => document.getElementById('hud');

// ---- 決定的疑似乱数 (mulberry32) ----
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
function rowsFor(cols) { return Math.round(cols * VIEW_H / VIEW_W); }

// ===================================================================
//  グリッド構築 / 決定的初期化
// ===================================================================
// COLS から ROWS・各バッファ・オフスクリーン canvas・ImageData を作り直す。
// 解像度を変えても見た目が決定的になるよう固定シードで濃淡と初期配置を作る。
function rebuildGrid(cols) {
  COLS = clamp(cols, COLS_MIN, COLS_MAX);
  ROWS = rowsFor(COLS);
  const n = COLS * ROWS;
  grid = new Uint8Array(n);
  moved = new Uint8Array(n);
  tint = new Uint8Array(n);

  // 砂/水の濃淡シードを決定的に敷き詰める(セル位置から再現可能な値)。
  const rng = makeRng(0x12ABCD ^ COLS);
  for (let i = 0; i < n; i++) tint[i] = (rng() * 256) | 0;

  // オフスクリーン canvas(=テクスチャ実体)を COLS×ROWS で作り直す。
  offCanvas = document.createElement('canvas');
  offCanvas.width = COLS;
  offCanvas.height = ROWS;
  offCtx = offCanvas.getContext('2d');
  imgData = offCtx.createImageData(COLS, ROWS);
  pix = imgData.data;
  // alpha は常に不透明。初期化しておく(以後 RGB のみ書く)。
  for (let i = 3; i < pix.length; i += 4) pix[i] = 255;

  buildEmitters();
  resetState();
}

// 上部の決定的エミッタを比率配置(解像度変更で再配置)。
function buildEmitters() {
  emitters = [];
  // 列比率で固定配置。砂と水を交互に。row は上から数セル下。
  const spots = [0.18, 0.34, 0.50, 0.66, 0.82];
  for (let i = 0; i < spots.length; i++) {
    const c = clamp((spots[i] * COLS) | 0, 1, COLS - 2);
    emitters.push({
      c: c,
      r: 2,
      mat: (i % 2 === 0) ? SAND : WATER,
      half: Math.max(1, (COLS / 80) | 0),   // 吐き出し半幅(解像度に比例)
    });
  }
}

// 決定的初期状態: 周囲に薄い壁の床/壁を置き、空気で満たす(エミッタは残る)。
function resetState() {
  grid.fill(EMPTY);
  // 底に1行・左右端に1列の壁を置いて、落下物が場外へ抜けないようにする
  // (場外も wall 扱いだが、見た目の「器」として明示的に置く)。
  for (let c = 0; c < COLS; c++) setCell(c, ROWS - 1, WALL);
  for (let r = 0; r < ROWS; r++) { setCell(0, r, WALL); setCell(COLS - 1, r, WALL); }
  // 中段に決定的な小さな壁の棚(流れが分岐して見栄えする)。
  const rng = makeRng(0x5EED ^ COLS);
  const shelves = 3;
  for (let s = 0; s < shelves; s++) {
    const cy = (ROWS * (0.35 + 0.18 * s)) | 0;
    const cx = (COLS * (0.25 + 0.25 * (rng()))) | 0;
    const w = Math.max(4, (COLS * 0.12) | 0);
    for (let i = -((w / 2) | 0); i <= (w / 2) | 0; i++) {
      const c = cx + i;
      if (c > 1 && c < COLS - 2) setCell(c, cy, WALL);
    }
  }
  scanLeftToRight = true;
}

// ---- セル添字ヘルパ ----
function idx(c, r) { return r * COLS + c; }
function inBounds(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
// 場外は wall 扱い(SPEC: 落下が下端で止まる)。
function getCell(c, r) { return inBounds(c, r) ? grid[idx(c, r)] : WALL; }
function setCell(c, r, m) { if (inBounds(c, r)) grid[idx(c, r)] = m; }

// ===================================================================
//  シミュレーション(決定的・下から上、行ごと左右交互)
// ===================================================================
function stepSim() {
  moved.fill(0);
  movedCount = 0;

  // 下の行から上へ。各行は前フレームと逆向きにスキャン(左右交互)して偏りを抑える。
  for (let r = ROWS - 1; r >= 0; r--) {
    const ltr = (scanLeftToRight === ((r & 1) === 0)); // 行ごと+フレームごとに向き反転
    if (ltr) {
      for (let c = 0; c < COLS; c++) stepCell(c, r);
    } else {
      for (let c = COLS - 1; c >= 0; c--) stepCell(c, r);
    }
  }
  scanLeftToRight = !scanLeftToRight;
}

// 1セルの規則適用。moved[] で当該フレームの二重処理を防ぐ。
function stepCell(c, r) {
  const i = idx(c, r);
  if (moved[i]) return;
  const m = grid[i];
  if (m === EMPTY || m === WALL) return;

  if (m === SAND) {
    // 真下が 空 か 水 なら落下(水とは入れ替わる=砂が沈む)
    const below = getCell(c, r + 1);
    if (below === EMPTY) { swap(c, r, c, r + 1); return; }
    if (below === WATER) { swap(c, r, c, r + 1); return; }
    // 塞がれていれば左下・右下(決定的: 行スキャン向きに合わせて優先側を選ぶ)
    const preferLeft = ((c + r) & 1) === 0;
    if (trySandDiagonal(c, r, preferLeft)) return;
    return;
  }

  if (m === WATER) {
    // 真下が空なら落下
    if (getCell(c, r + 1) === EMPTY) { swap(c, r, c, r + 1); return; }
    // 左下・右下
    const preferLeft = ((c + r) & 1) === 0;
    if (tryWaterDiagonal(c, r, preferLeft)) return;
    // それも塞がれていれば左右へ広がる(決定的順)
    if (tryWaterSpread(c, r, preferLeft)) return;
    return;
  }
}

// 砂の斜め落下(空 or 水へ)。preferLeft で左右優先を決定的に。
function trySandDiagonal(c, r, preferLeft) {
  const order = preferLeft ? [-1, 1] : [1, -1];
  for (let k = 0; k < 2; k++) {
    const dc = order[k];
    const t = getCell(c + dc, r + 1);
    if (t === EMPTY || t === WATER) { swap(c, r, c + dc, r + 1); return true; }
  }
  return false;
}

// 水の斜め落下(空へ)。
function tryWaterDiagonal(c, r, preferLeft) {
  const order = preferLeft ? [-1, 1] : [1, -1];
  for (let k = 0; k < 2; k++) {
    const dc = order[k];
    if (getCell(c + dc, r + 1) === EMPTY) { swap(c, r, c + dc, r + 1); return true; }
  }
  return false;
}

// 水の左右拡散(空へ)。
function tryWaterSpread(c, r, preferLeft) {
  const order = preferLeft ? [-1, 1] : [1, -1];
  for (let k = 0; k < 2; k++) {
    const dc = order[k];
    if (getCell(c + dc, r) === EMPTY) { swap(c, r, c + dc, r); return true; }
  }
  return false;
}

// 2セルの素材と濃淡を交換し、両方を moved 済みにする。
function swap(c1, r1, c2, r2) {
  if (!inBounds(c2, r2)) return;
  const i1 = idx(c1, r1), i2 = idx(c2, r2);
  const tm = grid[i1]; grid[i1] = grid[i2]; grid[i2] = tm;
  const tt = tint[i1]; tint[i1] = tint[i2]; tint[i2] = tt;
  moved[i1] = 1; moved[i2] = 1;
  movedCount++;
}

// ===================================================================
//  エミッタ供給(無入力でもベンチが回る)
// ===================================================================
function runEmitters() {
  for (const e of emitters) {
    for (let dc = -e.half; dc <= e.half; dc++) {
      const c = e.c + dc, r = e.r;
      if (getCell(c, r) === EMPTY) setCell(c, r, e.mat);
    }
  }
}

// ===================================================================
//  ブラシ(マウス) ― world(y-up) → screen → cell の変換が main gotcha
// ===================================================================
// LittleJS の mousePos は "world 座標(y-up)" のため、そのまま row 添字に使うと
// 上下が反転する。canvas ピクセル左上原点(y-down)の mousePosScreen を優先して使い、
// それを表示倍率(VIEW/COLS, VIEW/ROWS)で割ってセル添字へ落とす。
function mouseCell() {
  let sx, sy;
  if (typeof mousePosScreen !== 'undefined' && mousePosScreen && mousePosScreen.x !== undefined) {
    // mousePosScreen: canvas ピクセル左上原点・y 下向き(本シムと同じ系)
    sx = mousePosScreen.x;
    sy = mousePosScreen.y;
  } else {
    // フォールバック: world(y-up, 原点中央想定) → screen(左上原点, y-down)
    // overlayCanvas/mainCanvas のサイズと cameraPos/Scale から逆算する素朴版。
    const cs = (typeof cameraScale !== 'undefined') ? cameraScale : 1;
    const cam = (typeof cameraPos !== 'undefined') ? cameraPos : { x: 0, y: 0 };
    sx = (mousePos.x - cam.x) * cs + VIEW_W / 2;
    sy = VIEW_H / 2 - (mousePos.y - cam.y) * cs;  // y 反転(world y-up → screen y-down)
  }
  // 表示(960x540)→グリッド(COLS×ROWS)へ
  const c = Math.floor(sx / (VIEW_W / COLS));
  const r = Math.floor(sy / (VIEW_H / ROWS));
  return { c, r, ok: c >= 0 && c < COLS && r >= 0 && r < ROWS };
}

// ブラシ円内を mat で塗る(wall は上書き、empty で消去)。
function paintBrush(cc, cr, mat) {
  const rad = BRUSH_RADIUS;
  for (let dr = -rad; dr <= rad; dr++) {
    for (let dc = -rad; dc <= rad; dc++) {
      if (dc * dc + dr * dr > rad * rad) continue;
      const c = cc + dc, r = cr + dr;
      if (!inBounds(c, r)) continue;
      if (c === 0 || c === COLS - 1 || r === ROWS - 1) continue; // 器の壁は保護
      grid[idx(c, r)] = mat;
    }
  }
}

// ===================================================================
//  テクスチャ書き換え(全画素)＋ HUD 用 active 集計
// ===================================================================
// 毎フレーム COLS×ROWS の全画素を ImageData に書き込む(=計測対象の主コスト)。
function writeTexture() {
  activeCount = 0;
  const n = COLS * ROWS;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const m = grid[i];
    let R, G, B;
    if (m === EMPTY) {
      R = COL_AIR[0]; G = COL_AIR[1]; B = COL_AIR[2];
    } else if (m === WALL) {
      R = COL_WALL[0]; G = COL_WALL[1]; B = COL_WALL[2];
      activeCount++;
    } else if (m === SAND) {
      // 砂 #d9c067 系の濃淡(tint で ±)。
      const d = (tint[i] - 128) >> 2;   // -32..31 程度
      R = clamp(0xd9 + d, 0, 255);
      G = clamp(0xc0 + d, 0, 255);
      B = clamp(0x67 + (d >> 1), 0, 255);
      activeCount++;
    } else { // WATER
      // 水 #3a7bd5 系の濃淡。
      const d = (tint[i] - 128) >> 3;   // 控えめ
      R = clamp(0x3a + d, 0, 255);
      G = clamp(0x7b + d, 0, 255);
      B = clamp(0xd5 + d, 0, 255);
      activeCount++;
    }
    pix[p] = R; pix[p + 1] = G; pix[p + 2] = B; // alpha は 255 固定済み
  }
  // ImageData → オフスクリーン canvas(COLS×ROWS)へ転送。
  offCtx.putImageData(imgData, 0, 0);
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  if (typeof setCameraScale === 'function') setCameraScale(1);
  if (typeof setGravity === 'function') setGravity(vec2(0, 0)); // エンジン物理は不使用
  // 右クリックメニューを潰す(右ドラッグ消去のため)。
  if (typeof mainCanvas !== 'undefined' && mainCanvas) {
    mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  rebuildGrid(COLS_INIT);
  brushMat = SAND;
}

function gameUpdate() {
  // ---- 解像度 増減 (+/-) → 決定的に作り直す ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    rebuildGrid(clamp(COLS + COLS_STEP, COLS_MIN, COLS_MAX));
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    rebuildGrid(clamp(COLS - COLS_STEP, COLS_MIN, COLS_MAX));
  }

  // ---- ブラシ素材切替 (1/2/3) ----
  if (keyWasPressed('Digit1') || keyWasPressed('Numpad1')) brushMat = SAND;
  if (keyWasPressed('Digit2') || keyWasPressed('Numpad2')) brushMat = WATER;
  if (keyWasPressed('Digit3') || keyWasPressed('Numpad3')) brushMat = WALL;

  // ---- クリア / リセット ----
  if (keyWasPressed('KeyC')) {
    // 全消去(器の壁・エミッタは残す): 内側(棚含む)を empty に。
    for (let r = 0; r < ROWS - 1; r++)
      for (let c = 1; c < COLS - 1; c++)
        grid[idx(c, r)] = EMPTY;
    // 器の壁を貼り直し(底1行・左右1列)
    for (let r = 0; r < ROWS; r++) { setCell(0, r, WALL); setCell(COLS - 1, r, WALL); }
    for (let c = 0; c < COLS; c++) setCell(c, ROWS - 1, WALL);
  }
  if (keyWasPressed('KeyR')) {
    resetState();
  }

  // ---- マウス描画 / 消去 ----
  // mouseIsDown(0)=左, mouseIsDown(2)=右。world(y-up)→screen→cell に変換(gotcha)。
  const drawing = (typeof mouseIsDown === 'function') && mouseIsDown(0);
  const erasing = (typeof mouseIsDown === 'function') && mouseIsDown(2);
  if (drawing || erasing) {
    const mc = mouseCell();
    if (mc.ok) paintBrush(mc.c, mc.r, erasing ? EMPTY : brushMat);
  }

  // ---- エミッタ供給 → シム1ステップ(固定タイムステップ) ----
  runEmitters();
  stepSim();
}

function gameUpdatePost() {}

function gameRender() {
  // ワールド空間の描画は使わない(全面テクスチャを gameRenderPost で blit する)。
}

// ===================================================================
//  全面テクスチャ書き換え + mainContext への拡大 blit(=計測の核)
// ===================================================================
function gameRenderPost() {
  // 1) 全画素を ImageData に書き、オフスクリーン canvas(COLS×ROWS)へ putImageData。
  writeTexture();

  // 2) オフスクリーン canvas を mainContext へ 960x540 に拡大 blit(ニアレスト)。
  //    mainContext は LittleJS の 2D 描画コンテキスト。world 座標を経由せず canvas ピクセル直描き。
  const ctx = (typeof mainContext !== 'undefined' && mainContext)
    ? mainContext
    : (typeof overlayContext !== 'undefined' ? overlayContext : null);
  if (ctx && offCanvas) {
    ctx.imageSmoothingEnabled = false;     // ニアレストネイバー(ドットくっきり)
    ctx.drawImage(offCanvas, 0, 0, COLS, ROWS, 0, 0, VIEW_W, VIEW_H);
  }

  // ---- FPS 指数移動平均 ----
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  // ---- HUD (HTML #hud overlay) ----
  const cells = COLS * ROWS;
  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS    : ' + fpsAvg.toFixed(1) + '\n' +
      'Grid   : ' + COLS + ' x ' + ROWS + ' = ' + cells + ' cells\n' +
      'Active : ' + activeCount + '  (moved ' + movedCount + ')\n' +
      'Brush  : ' + BRUSH_NAME[brushMat] + '\n' +
      'Upload : ImageData→offscreen canvas→drawImage(mainContext, nearest)';
  }
}

// ===================================================================
//  起動: engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost)
//  本テーマはアセット不要(色はコード生成)のため imageSources は空配列。
// ===================================================================
// 第7引数 rootElement に #game-container を渡し、canvas をそこへ生成させる
// (three.js 版と同じ 960x540・上端中央配置。CSS の !important でサイズ固定)。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [],
  document.getElementById('game-container'));
