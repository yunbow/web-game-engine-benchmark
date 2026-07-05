"use strict";

/* =========================================================================
 * テーマ12: フォーリングサンド / セルオートマトン（動的テクスチャ書き換え）
 *           ― Babylon.js 版
 *
 * 3Dエンジン Babylon.js で 2D ピクセルシミュレーションを実装する。
 *  - COLS×ROWS のセル格子を持ち、砂/水/壁の決定的セルオートマトンで毎フレーム更新する。
 *  - 各フレーム、全セルの RGBA を 1 本の Uint8Array に書き込み、これを
 *    BABYLON.RawTexture へ `update(data)` で丸ごとアップロードする（＝本テーマの計測対象）。
 *  - そのテクスチャを「画面いっぱいの正射影 Plane」に unlit マテリアルとして貼り、
 *    ニアレストネイバー拡大で 960x540 に提示する（Babylon は 2D ピクセルの提示係）。
 *  - 解像度(COLS)を変えると RawTexture はサイズ固定なので作り直す（recreate-on-resize）。
 *
 * ベンチの主軸 = グリッド解像度（セル数）= 1フレームのセル更新数 ＋ テクスチャ転送量。
 *  毎フレームの「全面バイト書き込み + RawTexture.update」がそのまま計測されるコスト。
 * ========================================================================= */

(function () {

/* ---------- 画面・グリッド定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;

const COLS_INIT = 160;            // 初期列数 (→ ROWS=90, 14400 セル)
const COLS_STEP = 40;             // +/- の増減幅
const COLS_MIN = 80;
const COLS_MAX = 640;

// ROWS = round(COLS * 540 / 960)
function rowsForCols(cols) { return Math.round(cols * VIEW_H / VIEW_W); }

/* ---------- セル素材 ---------- */
const EMPTY = 0, SAND = 1, WATER = 2, WALL = 3;

// ブラシ半径 (セル)
const BRUSH_RADIUS = 3;

/* ---------- 色 (SPEC 基準) ----------
 * 空気 = 背景暗色 #0b0d12 / 砂 = 砂色 #d9c067 系の濃淡 / 水 = 青 #3a7bd5 系 / 壁 = 灰 #888
 * RawTexture は RGBA なので各色を [r,g,b,a] で持つ。砂/水はセル毎に決定的な濃淡を付ける。
 */
const COL_EMPTY = [0x0b, 0x0d, 0x12, 0xff];
const COL_WALL  = [0x88, 0x88, 0x88, 0xff];
// 砂・水のベース色と濃淡の振れ幅
const SAND_BASE  = [0xd9, 0xc0, 0x67];
const WATER_BASE = [0x3a, 0x7b, 0xd5];

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じ初期状態・濃淡・エミッタ供給を生成する。
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
 *  Babylon セットアップ
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, false, {
  preserveDrawingBuffer: false, stencil: false,
}, false);

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.043, 0.051, 0.071, 1.0); // 背景暗色 #0b0d12
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) を px 等倍で再現 ---
// orthoTop < orthoBottom で y 下向きの 2D 画面に一致させる。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

// unlit マテリアルだが念のため環境光を置く
const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* ---------- 全画面 Plane (テクスチャ提示面) ----------
 * 1x1 Plane を 960x540 に scaling し、画面中央へ。マテリアルは unlit。
 * Plane の UV は (0,0)=左下〜(1,1)=右上 なので、テクスチャ側を上下反転して書けば
 * 「セル(0,0)=画面左上」に一致する（後述 writePixels で row を反転して格納）。
 */
const plane = BABYLON.MeshBuilder.CreatePlane("screen", { width: 1, height: 1 }, scene);
plane.scaling.x = VIEW_W;
plane.scaling.y = VIEW_H;
plane.position.x = VIEW_W / 2;
plane.position.y = VIEW_H / 2;
plane.position.z = 0;
plane.isPickable = false;

const planeMat = new BABYLON.StandardMaterial("screenMat", scene);
planeMat.disableLighting = true;            // unlit (照明の影響を受けない)
planeMat.backFaceCulling = false;
planeMat.specularColor = new BABYLON.Color3(0, 0, 0);
planeMat.emissiveColor = new BABYLON.Color3(1, 1, 1); // emissive にテクスチャを載せて自発光表示
plane.material = planeMat;

/* =========================================================================
 *  シミュレーション状態
 * ========================================================================= */
const Sim = {
  cols: 0,
  rows: 0,
  cells: null,       // Uint8Array(cols*rows) : セル素材
  shade: null,       // Uint8Array(cols*rows) : 砂/水の決定的濃淡 (0..255)
  pixels: null,      // Uint8Array(cols*rows*4) : RGBA アップロードバッファ (flat)
  tex: null,         // BABYLON.RawTexture
  brush: SAND,       // 現在のブラシ素材
  active: 0,         // 空気以外のセル数 (HUD)
  emitters: [],      // 上部エミッタ {col, mat}
};

/* ---------- セルアクセス ----------
 * 場外は壁扱い（落下が下端で止まる）。
 */
function idx(c, r) { return r * Sim.cols + c; }
function getCell(c, r) {
  if (c < 0 || c >= Sim.cols || r < 0 || r >= Sim.rows) return WALL; // 場外=壁
  return Sim.cells[r * Sim.cols + c];
}

/* ---------- エミッタ配置 (決定的・比率で再配置) ----------
 * 上部に数個のエミッタを比率位置で置き、毎フレーム少量供給する。
 * マウス無しでも常にセルが動くのでベンチが安定する。
 */
function buildEmitters() {
  // 比率位置 (col の割合) と素材を固定で持つ → 解像度が変わっても比率で再配置。
  const defs = [
    { ratio: 0.18, mat: SAND },
    { ratio: 0.38, mat: WATER },
    { ratio: 0.55, mat: SAND },
    { ratio: 0.72, mat: WATER },
    { ratio: 0.86, mat: SAND },
  ];
  Sim.emitters = defs.map((d) => ({
    col: Math.max(1, Math.min(Sim.cols - 2, Math.round(d.ratio * Sim.cols))),
    mat: d.mat,
  }));
}

/* ---------- 濃淡テーブルの生成 (決定的) ----------
 * 砂/水はセル毎に固定シードで濃淡を割り当て、堆積した見た目に質感を出す。
 */
function fillShade() {
  const rnd = mulberry32(0x5A4D ^ (Sim.cols * 131));
  for (let i = 0; i < Sim.shade.length; i++) {
    Sim.shade[i] = (rnd() * 256) | 0;
  }
}

/* =========================================================================
 *  グリッド構築 / RawTexture 生成 (recreate-on-resize)
 * ========================================================================= */
function buildGrid(cols) {
  cols = Math.max(COLS_MIN, Math.min(COLS_MAX, cols));
  const rows = rowsForCols(cols);
  Sim.cols = cols;
  Sim.rows = rows;
  const n = cols * rows;
  Sim.cells = new Uint8Array(n);
  Sim.shade = new Uint8Array(n);
  Sim.pixels = new Uint8Array(n * 4);
  fillShade();
  buildEmitters();

  // --- RawTexture を (再)生成 ---
  // RawTexture はサイズ固定なので、解像度(COLS/ROWS)が変わるたびに dispose して作り直す。
  if (Sim.tex) { Sim.tex.dispose(); Sim.tex = null; }
  Sim.tex = new BABYLON.RawTexture(
    Sim.pixels,                                   // RGBA バイト列 (flat Uint8Array)
    cols, rows,
    BABYLON.Engine.TEXTUREFORMAT_RGBA,
    scene,
    false,                                        // generateMipMaps = false
    false,                                        // invertY = false (UV 反転は書き込み側で対応)
    BABYLON.Texture.NEAREST_SAMPLINGMODE          // ニアレスト = ドットくっきり
  );
  planeMat.emissiveTexture = Sim.tex;
}

/* ---------- 決定的初期状態 (リセット) ----------
 * 下部に薄い砂の床、中央寄りに壁の塊を決定的に置く。エミッタは buildEmitters で別管理。
 */
function resetState() {
  const cells = Sim.cells;
  cells.fill(EMPTY);
  const cols = Sim.cols, rows = Sim.rows;
  const rnd = mulberry32(0xF00D ^ cols);

  // 底に砂の堆積 (高さ ~ rows の 8%)
  const floorH = Math.max(2, Math.round(rows * 0.08));
  for (let r = rows - floorH; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rnd() < 0.92) cells[idx(c, r)] = SAND;
    }
  }
  // 中央に壁の段 (水/砂を受け止める棚)
  const wallR = Math.round(rows * 0.55);
  const wx0 = Math.round(cols * 0.30), wx1 = Math.round(cols * 0.70);
  for (let c = wx0; c < wx1; c++) {
    cells[idx(c, wallR)] = WALL;
  }
  // 左右の縦壁の一部 (流れを作る)
  const vh = Math.round(rows * 0.25);
  for (let r = wallR; r < wallR + vh && r < rows; r++) {
    cells[idx(wx0, r)] = WALL;
    cells[idx(wx1 - 1, r)] = WALL;
  }
}

/* =========================================================================
 *  セルオートマトン更新 (決定的)
 *
 *  走査順は決定的: 下の行から上へ。各行は「行ごとに左右交互スキャン」で偏りを抑える。
 *  Math.random 不使用。左右の決定が要る箇所は (行+列+フレーム) パリティで決定的に選ぶ。
 * ========================================================================= */
let frameParity = 0;

function step() {
  const cols = Sim.cols, rows = Sim.rows;
  const cells = Sim.cells;

  // --- エミッタ供給 (上部から少量) ---
  for (const e of Sim.emitters) {
    // 上端付近 row=0 に毎フレーム1セル供給 (既存が空のときのみ)
    if (getCell(e.col, 0) === EMPTY) cells[idx(e.col, 0)] = e.mat;
  }

  // --- 本体: 下の行から上へ ---
  for (let r = rows - 1; r >= 0; r--) {
    // 行ごとに左右交互 (frameParity と行で向きを決める → 決定的)
    const leftToRight = ((r + frameParity) & 1) === 0;
    if (leftToRight) {
      for (let c = 0; c < cols; c++) stepCell(c, r);
    } else {
      for (let c = cols - 1; c >= 0; c--) stepCell(c, r);
    }
  }
  frameParity ^= 1;
}

// 1セルの規則を適用 (cells を直接書き換える)。
function stepCell(c, r) {
  const cells = Sim.cells;
  const m = cells[r * Sim.cols + c];
  if (m === SAND) {
    stepSand(c, r);
  } else if (m === WATER) {
    stepWater(c, r);
  }
  // WALL / EMPTY は不動
}

// セル入れ替え (濃淡も一緒に動かす)
function swapCells(c0, r0, c1, r1) {
  const a = c0 + r0 * Sim.cols;
  const b = c1 + r1 * Sim.cols;
  const tm = Sim.cells[a]; Sim.cells[a] = Sim.cells[b]; Sim.cells[b] = tm;
  const ts = Sim.shade[a]; Sim.shade[a] = Sim.shade[b]; Sim.shade[b] = ts;
}

// 砂: 真下が空/水なら落下。塞がれていれば左下・右下。水とは入れ替わる(砂が沈む)。
function stepSand(c, r) {
  const below = getCell(c, r + 1);
  if (below === EMPTY || below === WATER) {
    swapCells(c, r, c, r + 1);  // 空なら落下 / 水なら入れ替え(砂が沈む)
    return;
  }
  // 真下が塞がれている → 左下/右下 (決定的に選択)
  const dl = getCell(c - 1, r + 1);
  const dr = getCell(c + 1, r + 1);
  const lOk = (dl === EMPTY || dl === WATER);
  const rOk = (dr === EMPTY || dr === WATER);
  if (lOk && rOk) {
    // 両方可 → (c+r+frameParity) パリティで決定的に選ぶ
    if (((c + r + frameParity) & 1) === 0) swapCells(c, r, c - 1, r + 1);
    else swapCells(c, r, c + 1, r + 1);
  } else if (lOk) {
    swapCells(c, r, c - 1, r + 1);
  } else if (rOk) {
    swapCells(c, r, c + 1, r + 1);
  }
}

// 水: 真下が空なら落下。塞がれていれば左下・右下、それも塞がれていれば左右へ広がる(決定的順)。
function stepWater(c, r) {
  if (getCell(c, r + 1) === EMPTY) {
    swapCells(c, r, c, r + 1);
    return;
  }
  const dl = getCell(c - 1, r + 1) === EMPTY;
  const dr = getCell(c + 1, r + 1) === EMPTY;
  if (dl && dr) {
    if (((c + r + frameParity) & 1) === 0) swapCells(c, r, c - 1, r + 1);
    else swapCells(c, r, c + 1, r + 1);
    return;
  } else if (dl) { swapCells(c, r, c - 1, r + 1); return; }
  else if (dr) { swapCells(c, r, c + 1, r + 1); return; }
  // 下が全部塞がれている → 左右へ広がる
  const l = getCell(c - 1, r) === EMPTY;
  const ri = getCell(c + 1, r) === EMPTY;
  if (l && ri) {
    if (((c + r + frameParity) & 1) === 0) swapCells(c, r, c - 1, r);
    else swapCells(c, r, c + 1, r);
  } else if (l) { swapCells(c, r, c - 1, r); }
  else if (ri) { swapCells(c, r, c + 1, r); }
}

/* =========================================================================
 *  全面ピクセル書き込み + RawTexture.update  (★ 本テーマの計測対象 ★)
 *
 *  全セルの RGBA を flat な Uint8Array(Sim.pixels) に書き、tex.update() で丸ごと転送する。
 *  Plane の UV は下が 0 なので、テクスチャ row を上下反転して格納し「セル(0,0)=画面左上」にする。
 * ========================================================================= */
function writePixelsAndUpload() {
  const cols = Sim.cols, rows = Sim.rows;
  const cells = Sim.cells;
  const shade = Sim.shade;
  const px = Sim.pixels;
  let active = 0;

  for (let r = 0; r < rows; r++) {
    // 画面上=row0 を、UV下原点のテクスチャでは末尾行へ書く (上下反転)
    const texRow = rows - 1 - r;
    let o = (texRow * cols) * 4;
    const src = r * cols;
    for (let c = 0; c < cols; c++) {
      const m = cells[src + c];
      let cr, cg, cb;
      if (m === EMPTY) {
        cr = COL_EMPTY[0]; cg = COL_EMPTY[1]; cb = COL_EMPTY[2];
      } else if (m === WALL) {
        cr = COL_WALL[0]; cg = COL_WALL[1]; cb = COL_WALL[2];
        active++;
      } else if (m === SAND) {
        // 砂色 #d9c067 に濃淡 (-32..+0 程度の暗化)
        const d = (shade[src + c] >> 3) - 16; // -16..+15
        cr = clamp8(SAND_BASE[0] + d);
        cg = clamp8(SAND_BASE[1] + d);
        cb = clamp8(SAND_BASE[2] + d);
        active++;
      } else { // WATER
        const d = (shade[src + c] >> 3) - 16;
        cr = clamp8(WATER_BASE[0] + d);
        cg = clamp8(WATER_BASE[1] + d);
        cb = clamp8(WATER_BASE[2] + (d >> 1) + 24); // 青を少し明るく
        active++;
      }
      px[o] = cr; px[o + 1] = cg; px[o + 2] = cb; px[o + 3] = 255;
      o += 4;
    }
  }
  Sim.active = active;

  // ★ ここがアップロード本体: 全面バイトを GPU テクスチャへ転送 ★
  Sim.tex.update(px);
}

function clamp8(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

/* =========================================================================
 *  入力: ポインタ (左ドラッグ=描画 / 右ドラッグ=消去) + キーボード
 * ========================================================================= */
const pointer = { down: false, button: 0, col: -1, row: -1 };

// 画面 px → セル座標 (ortho が px 等倍なので canvas のローカル座標を比率変換)
function eventToCell(ev) {
  const rect = canvas.getBoundingClientRect();
  const sx = (ev.clientX - rect.left) / rect.width;   // 0..1
  const sy = (ev.clientY - rect.top) / rect.height;   // 0..1 (上=0)
  const col = Math.floor(sx * Sim.cols);
  const row = Math.floor(sy * Sim.rows);
  return { col, row };
}

// ブラシで素材を置く (半径内を塗る)。mat=EMPTY で消去。壁の上書きも許可(消去のため)。
function paint(col, row, mat) {
  const rad = BRUSH_RADIUS;
  for (let dr = -rad; dr <= rad; dr++) {
    for (let dc = -rad; dc <= rad; dc++) {
      if (dc * dc + dr * dr > rad * rad) continue;
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= Sim.cols || r < 0 || r >= Sim.rows) continue;
      Sim.cells[idx(c, r)] = mat;
    }
  }
}

canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.button = ev.button; // 0=左, 2=右
  const { col, row } = eventToCell(ev);
  pointer.col = col; pointer.row = row;
  paint(col, row, pointer.button === 2 ? EMPTY : Sim.brush);
  ev.preventDefault();
});
canvas.addEventListener("pointermove", (ev) => {
  if (!pointer.down) return;
  const { col, row } = eventToCell(ev);
  pointer.col = col; pointer.row = row;
  paint(col, row, pointer.button === 2 ? EMPTY : Sim.brush);
});
function endPointer() { pointer.down = false; }
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
window.addEventListener("blur", endPointer);

window.addEventListener("keydown", (ev) => {
  const k = ev.key;
  if (k === "1") Sim.brush = SAND;
  else if (k === "2") Sim.brush = WATER;
  else if (k === "3") Sim.brush = WALL;
  else if (k === "+" || k === "=" || k === "Add") changeRes(+COLS_STEP);
  else if (k === "-" || k === "_" || k === "Subtract") changeRes(-COLS_STEP);
  else if (k === "c" || k === "C") clearGrid();
  else if (k === "r" || k === "R") resetState();
});

// 解像度変更: グリッド/RawTexture を作り直し → 決定的初期状態へ (recreate-on-resize)
function changeRes(delta) {
  const next = Math.max(COLS_MIN, Math.min(COLS_MAX, Sim.cols + delta));
  if (next === Sim.cols) return;
  buildGrid(next);
  resetState();
}

// C: 全消去 (エミッタは残る = 次フレームから再供給される)
function clearGrid() {
  Sim.cells.fill(EMPTY);
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;
const BRUSH_NAME = { [SAND]: "sand", [WATER]: "water", [WALL]: "wall" };

function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const cells = Sim.cols * Sim.rows;
  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>    <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Grid</span>   <span class="hudVal">' + Sim.cols + ' x ' + Sim.rows +
      ' = ' + cells + ' cells</span>\n' +
    '<span class="hudLabel">Active</span> <span class="hudVal">' + Sim.active + '</span>\n' +
    '<span class="hudLabel">Brush</span>  <span class="hudVal">' + BRUSH_NAME[Sim.brush] + '</span>\n' +
    '<span class="warn">Upload</span> <span class="hudVal">RawTexture.update (' +
      Sim.cols + 'x' + Sim.rows + 'x4 = ' + (cells * 4) + ' bytes/frame)</span>';
}

/* =========================================================================
 *  起動 → ループ
 * ========================================================================= */
function boot() {
  buildGrid(COLS_INIT);
  resetState();

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制

    step();                   // セルオートマトン更新 (固定1ステップ/フレーム)
    writePixelsAndUpload();   // 全面 RGBA 書き込み + RawTexture.update (計測対象)
    updateHud(dt);
    scene.render();           // Plane に貼ったテクスチャを 960x540 へ NEAREST 拡大表示
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
