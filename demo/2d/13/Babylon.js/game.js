"use strict";

/* =========================================================================
 * テーマ13: 大量動的テキスト / UI 描画 ― Babylon.js 版
 *
 * 画面いっぱいに多数のテキストラベルが流れ、各ラベルの数値部分が毎フレーム
 * 更新される「システムログ / データダッシュボード」風デモ。
 *
 * 性能比較の主軸:
 *   (A) 画面上のテキストオブジェクト数 N
 *   (B) 毎フレーム文字列を作り直す(Update=ON)か、固定のまま位置だけ動かす(OFF)か
 *
 * Babylon は3Dエンジンでテキストの「素直な選択肢」が2つあるので、両方を実装し
 * B キーで切り替えて崖を比較できるようにした(詳細は README)。
 *   1) GUI TextBlock 方式 (既定):
 *        BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI() に
 *        TextBlock を N 個プールして配置。.text 代入のたびに ADT が
 *        まるごと再ラスタライズされるのが崖。
 *   2) Canvas DynamicTexture 方式:
 *        960x540 の DynamicTexture を1枚だけ持ち、自前で 2D ctx に
 *        fillText を N 回描いて、正射影の板ポリに貼る。
 *        テクスチャ更新は1回/フレームで済む。
 *
 * 共通: 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下。
 *       決定的擬似乱数 mulberry32 で初期位置・速度・色・サイズ・基準文字列を生成。
 *       Math.random は使わない。
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;
const BG_HEX = "#0b0d16";           // 背景の暗色

const INITIAL_TEXTS = 200;          // テキストアイテム初期数
const TEXT_STEP = 100;              // +/- の増減幅
const MIN_TEXTS = 0;                // 下限
const MAX_TEXTS = 5000;             // 上限 (= プール容量)

const SEED = 0x13ABCD;              // 固定シード (決定的配置)

// アイテム文字サイズ (px) の決定的割当範囲
const FONT_MIN = 11;
const FONT_MAX = 20;

// 速度範囲 (px/s)。スクロール/バウンド混在で動かす。
const SPEED_MIN = 30;
const SPEED_MAX = 140;

const DT_CLAMP = 0.05;              // デルタ上限 (スパイク抑制)

// 描画方式
const MODE_GUI = 0;                 // GUI TextBlock
const MODE_DYN = 1;                 // Canvas DynamicTexture
const MODE_NAMES = ["GUI TextBlock", "Canvas DynamicTexture"];

// アイテム配色パレット (決定的に割当)。視認しやすい明色を中心に。
const PALETTE = [
  "#7fd0ff", "#9effa0", "#ffd86b", "#ff9e9e", "#c8a6ff",
  "#6bffe0", "#ffb066", "#a0c4ff", "#ffa0e0", "#d0ff8a",
];

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じ配置/動きを生成する。
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
 *  テキストアイテムのデータ生成 (描画方式に依存しない純データ)
 *
 *  各アイテム:
 *    x, y      : 中心座標 (px, 左上原点)
 *    vx, vy    : 速度 (px/s)
 *    color     : 色 (パレットから決定的に)
 *    size      : フォント px
 *    label     : 基準ラベル "OBJ#0042" (固定)
 *    val       : ライブ更新される数値 (動的)
 *    text      : 実際に描く文字列 (Update=ON で毎フレーム再生成)
 *  ========================================================================= */
const items = [];           // 全アイテム (最大 MAX_TEXTS 個まで生成済みで保持)
let activeCount = 0;        // 現在アクティブなアイテム数 N

// アイテムは初回に MAX_TEXTS 個まで「決定的に」確保し、N で可視数だけ使う。
// こうすると + でアイテムを増やしても seed 由来の並びが変わらず決定的。
function buildItems() {
  const rnd = mulberry32(SEED);
  items.length = 0;
  for (let i = 0; i < MAX_TEXTS; i++) {
    // 速度の向き: 半々で「下スクロール優勢」「左右バウンド優勢」に振り分け
    const dirMode = rnd();
    let vx, vy;
    if (dirMode < 0.5) {
      // 下方向スクロール優勢 (縦速度が主)
      vx = (rnd() * 2 - 1) * SPEED_MIN;
      vy = SPEED_MIN + rnd() * (SPEED_MAX - SPEED_MIN);
    } else {
      // 左右バウンド優勢 (横速度が主)
      vx = (rnd() < 0.5 ? -1 : 1) * (SPEED_MIN + rnd() * (SPEED_MAX - SPEED_MIN));
      vy = (rnd() * 2 - 1) * SPEED_MIN;
    }
    const size = Math.round(FONT_MIN + rnd() * (FONT_MAX - FONT_MIN));
    const color = PALETTE[(rnd() * PALETTE.length) | 0];
    // 基準ラベルは "OBJ#0042" 形式 (4桁ゼロ詰めの通し番号)
    const label = "OBJ#" + String(i).padStart(4, "0");
    // 初期数値 (各アイテムごとに決定的なオフセット)
    const phase = (rnd() * 1000) | 0;
    items.push({
      x: rnd() * VIEW_W,
      y: rnd() * VIEW_H,
      vx, vy,
      size, color, label,
      phase,
      val: phase,
      text: label + " v=" + phase, // 初期文字列 (8〜20文字程度)
    });
  }
}

// アイテム数 N を増減する (生成済み配列から可視数を変えるだけ → プール再利用)。
function setActiveCount(n) {
  n = Math.max(MIN_TEXTS, Math.min(MAX_TEXTS, n));
  activeCount = n;
  refreshPoolVisibility();
}

/* =========================================================================
 *  決定的な動き + 文字列更新
 *
 *  - 位置を dt で進め、画面外に出たら反対側からラップ (上下/左右)。
 *  - Update=ON のとき、数値部分を時間で再計算し text を作り直す(再レイアウト)。
 *  - Update=OFF のとき、位置だけ動かし text は据え置き(キャッシュが効く)。
 * ========================================================================= */
let simTime = 0;            // ゲーム内累積時間 (s)
let frame = 0;             // フレーム番号
let dynamicUpdate = true;  // Update ON/OFF
let totalChars = 0;        // 直近に作り直した概算総文字数 (HUD 用)

function updateItems(dt) {
  simTime += dt;
  totalChars = 0;
  const margin = 24; // ラップ余白 (はみ出してから回り込む)
  for (let i = 0; i < activeCount; i++) {
    const it = items[i];
    // --- 位置を進める ---
    it.x += it.vx * dt;
    it.y += it.vy * dt;
    // --- 画面外ラップ ---
    if (it.x < -margin) it.x = VIEW_W + margin;
    else if (it.x > VIEW_W + margin) it.x = -margin;
    if (it.y < -margin) it.y = VIEW_H + margin;
    else if (it.y > VIEW_H + margin) it.y = -margin;

    if (dynamicUpdate) {
      // --- 数値部分を毎フレーム再計算して文字列を作り直す (重い経路) ---
      // 各アイテムごとに位相をずらしたノコギリ波で 0..999 を回す。
      const v = (((simTime * 60 + it.phase) | 0) % 1000);
      it.val = v;
      // テンプレリテラルでなく + 連結 (V8 で軽い); 8〜20文字程度の文字列
      it.text = it.label + " v=" + v;
    }
    totalChars += it.text.length;
  }
}

/* =========================================================================
 *  Babylon セットアップ (正射影 2D)
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
const bg = BABYLON.Color3.FromHexString(BG_HEX);
scene.clearColor = new BABYLON.Color4(bg.r, bg.g, bg.b, 1.0);
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) を 1:1 で再現。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;       // orthoTop < orthoBottom で y 下向き
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* =========================================================================
 *  方式1: GUI TextBlock プール
 *
 *  AdvancedDynamicTexture.CreateFullscreenUI() に N 個の TextBlock を
 *  プールしておき、可視数だけ表示/座標更新/.text 代入する。
 *  .text への代入は ADT の markAsDirty を立て、フレーム末に
 *  ADT 全体が1枚のテクスチャへ再ラスタライズされる(これが崖)。
 * ========================================================================= */
let adt = null;                 // AdvancedDynamicTexture (fullscreen)
const guiPool = [];             // TextBlock の配列 (最大 MAX_TEXTS)
let guiBuilt = 0;               // 生成済み TextBlock 数 (遅延生成)

function ensureGui() {
  if (adt) return;
  // foreground=true: 3Dより手前のフルスクリーンUIレイヤー。
  // ideal サイズは指定しない → ADT は描画キャンバス(960x540)に 1:1 で張り付き、
  // left/top の px がそのまま画面 px に一致する。
  adt = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("ui", true, scene);
  adt.useInvalidateRectOptimization = false; // 全面が毎フレーム動くので部分無効化は無効に
}

// GUI TextBlock を遅延生成 (必要数まで)。
function ensureGuiPool(n) {
  ensureGui();
  for (; guiBuilt < n; guiBuilt++) {
    const tb = new BABYLON.GUI.TextBlock("t" + guiBuilt, "");
    tb.fontFamily = "Consolas, monospace";
    tb.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    tb.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    tb.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    tb.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    tb.resizeToFit = false;
    tb.width = "220px";
    tb.height = "24px";
    tb.isPointerBlocker = false;
    tb.notRenderable = false;
    adt.addControl(tb);
    guiPool[guiBuilt] = tb;
  }
}

// GUI 方式の毎フレーム反映。
function renderGui() {
  ensureGuiPool(activeCount);
  for (let i = 0; i < guiBuilt; i++) {
    const tb = guiPool[i];
    if (i < activeCount) {
      const it = items[i];
      if (!tb.isVisible) tb.isVisible = true;
      // HORIZONTAL/VERTICAL_ALIGNMENT_LEFT/TOP のとき left/top は左上隅からの
      // px オフセットそのもの。中心補正は不要 (引くと下半分が画面外に出る)。
      tb.left = (it.x | 0) + "px";
      tb.top = (it.y | 0) + "px";
      tb.fontSize = it.size;
      tb.color = it.color;
      // .text 代入で ADT が dirty に。Update=OFF なら同値代入は内部で無視され軽い。
      if (tb.text !== it.text) tb.text = it.text;
    } else if (tb.isVisible) {
      tb.isVisible = false;
    }
  }
}

function disposeGui() {
  if (!adt) return;
  adt.dispose();
  adt = null;
  guiPool.length = 0;
  guiBuilt = 0;
}

/* =========================================================================
 *  方式2: Canvas DynamicTexture (自前 fillText)
 *
 *  960x540 の DynamicTexture を1枚だけ持ち、毎フレーム 2D ctx に
 *  全アイテムを fillText で描いてから update() で GPU へ1回アップロード。
 *  正射影の板ポリ(960x540)に emissive で貼る。
 *  「テクスチャ更新1回 + ctx.fillText を N 回」というコスト構造になる。
 * ========================================================================= */
let dynTex = null;              // DynamicTexture (1枚)
let dynCtx = null;              // 2D コンテキスト
let dynLayer = null;            // 表示用のフルスクリーン Layer

function ensureDyn() {
  if (dynTex) return;
  // 960x540 のオフスクリーン Canvas を内包する DynamicTexture を1枚だけ作る。
  dynTex = new BABYLON.DynamicTexture("textTex", { width: VIEW_W, height: VIEW_H }, scene, false);
  dynTex.hasAlpha = true;
  dynCtx = dynTex.getContext();
  dynCtx.textBaseline = "middle";
  dynCtx.textAlign = "left";

  // Layer はテクスチャをスクリーン空間にそのまま貼る (カメラ/ジオメトリ非依存)。
  // 第4引数 isBackground=false → 前景レイヤー。3D シーンより手前に重なる。
  // DynamicTexture の canvas 左上原点が画面左上に一致して直立表示される。
  dynLayer = new BABYLON.Layer("textLayer", null, scene, false);
  dynLayer.texture = dynTex;
}

function renderDyn() {
  ensureDyn();
  const ctx = dynCtx;
  // 透明クリア (背景は scene.clearColor が担当)
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  // 同フォントのアイテムをまとめると font 切替が減るが、サイズ/色が多様なので
  // ここは素直に1件ずつ。これが「N 回 fillText」のコスト軸。
  let lastFont = "";
  let lastColor = "";
  for (let i = 0; i < activeCount; i++) {
    const it = items[i];
    const font = it.size + "px Consolas, monospace";
    if (font !== lastFont) { ctx.font = font; lastFont = font; }
    if (it.color !== lastColor) { ctx.fillStyle = it.color; lastColor = it.color; }
    ctx.fillText(it.text, it.x, it.y);
  }
  // 注: GPU アップロード(dynTex.update)は統計パネルを上描きした後に
  // 1回だけ行う(commitDyn)。ここではまだアップロードしない。
}

function disposeDyn() {
  if (!dynTex) return;
  dynLayer.dispose();
  dynTex.dispose();
  dynTex = null; dynCtx = null; dynLayer = null;
}

/* ---------- 方式切替に伴う可視性整理 ---------- */
let renderMode = MODE_GUI;

function refreshPoolVisibility() {
  // N を減らしたとき、GUI プールの余りを隠す (DynamicTexture は毎回クリアするので不要)。
  if (renderMode === MODE_GUI && adt) {
    for (let i = activeCount; i < guiBuilt; i++) {
      if (guiPool[i].isVisible) guiPool[i].isVisible = false;
    }
  }
}

function setRenderMode(m) {
  if (m === renderMode) return;
  // 旧方式の表示物を片付ける (プールは破棄して作り直す: 方式は滅多に切り替えない)
  if (renderMode === MODE_GUI) disposeGui();
  else disposeDyn();
  renderMode = m;
}

/* =========================================================================
 *  入力
 * ========================================================================= */
window.addEventListener("keydown", (ev) => {
  const k = ev.key;
  if (k === "+" || k === "=" || k === "Add") {
    setActiveCount(activeCount + TEXT_STEP);
  } else if (k === "-" || k === "_" || k === "Subtract") {
    setActiveCount(activeCount - TEXT_STEP);
  } else if (k === "u" || k === "U") {
    dynamicUpdate = !dynamicUpdate;
  } else if (k === "b" || k === "B") {
    setRenderMode(renderMode === MODE_GUI ? MODE_DYN : MODE_GUI);
  } else if (k === "r" || k === "R") {
    resetSim();
  }
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(k)) ev.preventDefault();
});
canvas.addEventListener("click", () => canvas.focus());
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

/* ---------- リセット ---------- */
function resetSim() {
  buildItems();
  simTime = 0;
  frame = 0;
  dynamicUpdate = true;
  setActiveCount(INITIAL_TEXTS);
}

/* =========================================================================
 *  統計パネル (画面右上, 常時更新の複数行テキスト)
 *
 *  多行の動的テキスト再レイアウトも踏ませるため、採用中の描画方式と
 *  同じ機構で描く。GUI 方式なら TextBlock 1個 (改行入り)、
 *  DynamicTexture 方式なら ctx.fillText を行ごとに。
 * ========================================================================= */
let statsTb = null; // GUI 用の統計 TextBlock

function statsLines() {
  // 毎フレーム作り直す複数行 (フレーム番号・各種カウンタ)。
  return [
    "== LIVE STATS ==",
    "frame : " + frame,
    "time  : " + simTime.toFixed(2) + "s",
    "texts : " + activeCount + " / " + MAX_TEXTS,
    "chars : " + totalChars,
    "mode  : " + MODE_NAMES[renderMode],
    "update: " + (dynamicUpdate ? "DYNAMIC" : "static"),
  ];
}

function renderStatsGui() {
  ensureGui();
  if (!statsTb) {
    statsTb = new BABYLON.GUI.TextBlock("stats", "");
    statsTb.fontFamily = "Consolas, monospace";
    statsTb.fontSize = 13;
    statsTb.color = "#9effa0";
    statsTb.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    statsTb.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    statsTb.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    statsTb.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
    statsTb.paddingRight = "10px";
    statsTb.paddingTop = "8px";
    statsTb.lineSpacing = "2px";
    statsTb.resizeToFit = true;
    statsTb.isPointerBlocker = false;
    adt.addControl(statsTb);
  }
  if (!statsTb.isVisible) statsTb.isVisible = true;
  statsTb.text = statsLines().join("\n"); // 複数行 → 毎フレーム再レイアウト
}

function renderStatsDyn() {
  // dynCtx に直接描く (renderDyn の clearRect 後・fillText 群と同じテクスチャ)。
  const ctx = dynCtx;
  const lines = statsLines();
  ctx.font = "13px Consolas, monospace";
  ctx.fillStyle = "#9effa0";
  const x = VIEW_W - 180;
  let y = 16;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y);
    y += 18;
  }
}

// DynamicTexture を GPU へ 1 回だけアップロードする (アイテム+統計を描いた後)。
function commitDyn() {
  dynTex.update(false); // false=mipmap不要。これが1回/フレーム。
}

function hideStatsForModeSwitch() {
  // 方式破棄時に統計参照も無効化 (GUI の場合は dispose 済み)。
  if (renderMode !== MODE_GUI) statsTb = null;
}

/* =========================================================================
 *  HUD (HTML オーバーレイ, 約 0.1s 更新, FPS は移動平均)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;
function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>    <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Texts</span>  <span class="hudVal">' + activeCount + ' / ' + MAX_TEXTS + '</span>\n' +
    '<span class="hudLabel">Chars</span>  <span class="hudVal">' + totalChars + '</span>\n' +
    '<span class="hudLabel">Render</span> <span class="hudVal">' + MODE_NAMES[renderMode] + '</span>\n' +
    '<span class="hudLabel">Update</span> <span class="' + (dynamicUpdate ? 'warn' : 'hudVal') + '">' +
      (dynamicUpdate ? 'dynamic' : 'static') + '</span>\n' +
    '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット';
}

/* =========================================================================
 *  起動: 構築 → ループ開始
 * ========================================================================= */
function boot() {
  buildItems();
  setActiveCount(INITIAL_TEXTS);

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > DT_CLAMP) dt = DT_CLAMP; // スパイク抑制
    frame++;

    updateItems(dt);

    // 採用中の方式で「アイテム群 + 統計パネル」を描く。
    if (renderMode === MODE_GUI) {
      renderGui();
      renderStatsGui();
    } else {
      hideStatsForModeSwitch();
      renderDyn();        // clearRect → アイテム群を fillText
      renderStatsDyn();   // 同テクスチャに統計を上描き
      commitDyn();        // ここで初めて GPU へ 1 回アップロード
    }

    updateHud(dt);
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
