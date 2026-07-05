/* =========================================================================
 * テーマ13 大量動的テキスト / UI 描画（動的テキスト・グリフ描画）― three.js r184
 * 仕様: SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *   - 960x540 / 暗色背景(#0b0d16) / デルタタイム駆動
 *   - N 個のテキストアイテムが決定的に流れる（左右バウンド + 下方向スクロール + ラップ）
 *   - 各アイテムは "OBJ#0042 v=137" 風の 8〜20 文字。数値部が毎フレーム更新される。
 *   - U: 動的更新 ON/OFF（ON=毎フレーム文字列を書き換え / OFF=位置のみ）
 *   - +/-: テキスト数 ±100（下限0 / 上限5000）
 *   - B: CanvasTexture 方式 ⇄ GlyphAtlas 方式 切替
 *   - R: リセット
 *   - 隅に常時更新される複数行の統計パネル
 *
 * ★ テキスト機構（three.js には“ネイティブのテキスト”が無い ＝ ワークアラウンド）★
 *   three.js は 3D 描画ライブラリで、文字列を直接描く API を持たない。
 *   （troika-three-text 等の外部依存は本リファレンスが使っていないため導入しない。）
 *   そこで PIXI.Text の「Canvas でラスタライズ → テクスチャ化」という発想を、
 *   2つの素直な経路で実装し B で切り替えて崖を比較する:
 *
 *     1) CanvasTexture 方式（既定 / B=OFF） ＝ PIXI.Text(Canvas Text) 相当:
 *          960x540 のオフスクリーン 2D canvas を1枚持ち、毎フレーム
 *          ctx.fillText を N 回叩いて全テキストを描き、CanvasTexture として
 *          画面いっぱいの板ポリ（quad）に貼って1回 GPU アップロードする。
 *          「fillText を N 回ラスタライズ + テクスチャ全面再アップロード」が崖。
 *
 *     2) GlyphAtlas 方式（B=ON） ＝ PIXI.BitmapText 相当:
 *          ASCII 可視グリフを1枚のアトラス・テクスチャに事前ベイク（初回1回）。
 *          各文字は drawImage でアトラスの該当矩形を 2D canvas へブリットする
 *          だけ（フォントのラスタライズは初回のみ）。.text 変更コストが桁違いに
 *          小さい（崖を緩和できるかの対比）。
 *
 *   どちらも最終的に CanvasTexture を1枚の正射影 quad に貼る点は共通。
 *   three.js 単体では「テキストは canvas 経由」というワークアラウンドが必須、が肝。
 *
 * 座標系: OrthographicCamera(0, W, H, 0) で 1ワールド=1px。テキストの 2D canvas は
 * 通常の y-down で描き、quad に貼ると上下が正しく出る（板ポリの uv をそのまま使用）。
 * 乱数は決定的 mulberry32 のみ（Math.random は不使用）。
 * ========================================================================= */

import * as THREE from 'three';

// ---- 定数 (SPEC / PixiJS リファレンスと同値) -----------------------------
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = 0x0b0d16;

const N_INIT = 200;
const N_STEP = 100;
const N_MIN = 0;
const N_MAX = 5000;

const SIZE_MIN = 12;
const SIZE_MAX = 22;

const VX_MIN = 30, VX_MAX = 140;
const VY_MIN = 20, VY_MAX = 90;

const AVG_CHARS = 14;

const PALETTE = [
  '#7fd4ff', '#9affc0', '#ffd76b', '#ff9d6b',
  '#ff7fb0', '#c79bff', '#7fffe0', '#e8eef7',
];

// ---- 決定的擬似乱数 (mulberry32) -----------------------------------------
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

function pad4(n) {
  n = n & 0xffff;
  let s = '' + n;
  return s.length >= 4 ? s : '0000'.slice(s.length) + s;
}

// =========================================================================
// シーン / カメラ / レンダラ
// =========================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
const camera = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);          // 性能比較のため DPR=1 固定
renderer.setSize(VIEW_W, VIEW_H);
document.getElementById('game-container').appendChild(renderer.domElement);

// =========================================================================
// テキスト用 2D canvas（全テキストはここに描いて CanvasTexture へ）
//   960x540。透明クリア → fillText/drawImage で書き込み → quad に貼る。
// =========================================================================
const textCanvas = document.createElement('canvas');
textCanvas.width = VIEW_W;
textCanvas.height = VIEW_H;
const tctx = textCanvas.getContext('2d');
tctx.textBaseline = 'top';

const textTex = new THREE.CanvasTexture(textCanvas);
textTex.colorSpace = THREE.SRGBColorSpace;
textTex.magFilter = THREE.NearestFilter;
textTex.minFilter = THREE.NearestFilter;
textTex.generateMipmaps = false;

// 画面いっぱいの quad（左下原点 0,0 〜 W,H）にテクスチャを貼る。
// PlaneGeometry の uv は左下原点なので flipY=false で canvas の上下に合わせる。
textTex.flipY = false;
const quadGeo = new THREE.PlaneGeometry(VIEW_W, VIEW_H);
const quadMat = new THREE.MeshBasicMaterial({ map: textTex, transparent: true, depthTest: false });
const quad = new THREE.Mesh(quadGeo, quadMat);
quad.position.set(VIEW_W / 2, VIEW_H / 2, 0);
scene.add(quad);

// =========================================================================
// GlyphAtlas（B=ON 用）: ASCII 可視グリフを1枚のアトラスにベイク（初回1回）。
//   等幅フォントで cell 幅・高さを固定し、文字コードからセル位置を引く。
//   表示時は白で焼いたグリフを drawImage でブリットし、色は per-item で
//   別 canvas に着色…ではなく、ここでは可読性優先で「色付きアトラス」を
//   パレット数だけ用意し item の色で引く（パレットは8色固定）。
// =========================================================================
const ATLAS_PT = 24;              // アトラスのベースフォント px
const CELL_W = 16;                // セル幅（等幅）
const CELL_H = 28;                // セル高さ
const GLYPH_FIRST = 32;           // ' '
const GLYPH_LAST = 126;           // '~'
const GLYPH_COLS = 16;
const glyphAtlas = {};            // colorHex -> { canvas }

function buildGlyphAtlas(colorHex) {
  if (glyphAtlas[colorHex]) return glyphAtlas[colorHex];
  const nGlyph = GLYPH_LAST - GLYPH_FIRST + 1;
  const rows = Math.ceil(nGlyph / GLYPH_COLS);
  const c = document.createElement('canvas');
  c.width = GLYPH_COLS * CELL_W;
  c.height = rows * CELL_H;
  const g = c.getContext('2d');
  g.font = ATLAS_PT + 'px Consolas, "Courier New", monospace';
  g.textBaseline = 'top';
  g.fillStyle = colorHex;
  for (let i = 0; i < nGlyph; i++) {
    const ch = String.fromCharCode(GLYPH_FIRST + i);
    const cx = (i % GLYPH_COLS) * CELL_W;
    const cy = Math.floor(i / GLYPH_COLS) * CELL_H;
    g.fillText(ch, cx, cy);
  }
  const entry = { canvas: c };
  glyphAtlas[colorHex] = entry;
  return entry;
}
// パレット分のアトラスを事前生成（初回コスト。以後は drawImage のみ）。
for (const hex of PALETTE) buildGlyphAtlas(hex);
buildGlyphAtlas('#bfe0ff'); // 統計パネル用

// item の size に応じてアトラスのセルをスケールしてブリットする。
function drawAtlasText(str, x, y, size, colorHex) {
  const atlas = buildGlyphAtlas(colorHex).canvas;
  const scale = size / ATLAS_PT;
  const dw = CELL_W * scale;
  const dh = CELL_H * scale;
  let dx = x;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= GLYPH_FIRST && code <= GLYPH_LAST) {
      const gi = code - GLYPH_FIRST;
      const sx = (gi % GLYPH_COLS) * CELL_W;
      const sy = Math.floor(gi / GLYPH_COLS) * CELL_H;
      tctx.drawImage(atlas, sx, sy, CELL_W, CELL_H, dx, y, dw, dh);
    }
    dx += dw * 0.62; // 等幅の見た目に合わせた進み幅（24pt monospace ≒ 0.62em）
  }
}

// =========================================================================
// アイテムモデル（決定的に生成）
// =========================================================================
const items = [];
let count = 0;
let useAtlas = false;            // false=CanvasTexture(fillText) / true=GlyphAtlas
let dynamic = true;
let frame = 0;

function initItems() {
  const rnd = mulberry32(20250613);
  items.length = 0;
  for (let i = 0; i < N_MAX; i++) {
    const colorIdx = Math.floor(rnd() * PALETTE.length);
    const colorHex = PALETTE[colorIdx];
    const size = SIZE_MIN + Math.floor(rnd() * (SIZE_MAX - SIZE_MIN + 1));
    items.push({
      x: rnd() * VIEW_W,
      y: rnd() * VIEW_H,
      vx: (VX_MIN + rnd() * (VX_MAX - VX_MIN)) * (rnd() < 0.5 ? -1 : 1),
      vy: VY_MIN + rnd() * (VY_MAX - VY_MIN),
      base: i,
      colorHex,
      size,
      text: '',
    });
  }
}
initItems();

function makeText(it, i) {
  const v = (frame * 7 + i * 13) % 1000;
  return 'OBJ#' + pad4(it.base) + ' v=' + v;
}

function refreshAllText() {
  for (let i = 0; i < count; i++) items[i].text = makeText(items[i], i);
}

function setCount(n) {
  n = clamp(n, N_MIN, N_MAX);
  if (n > count) for (let i = count; i < n; i++) items[i].text = makeText(items[i], i);
  count = n;
}
setCount(N_INIT);

function reset() {
  initItems();
  setCount(N_INIT);
}

// ---- 入力 ----
window.addEventListener('keydown', (e) => {
  if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
    setCount(count + N_STEP); e.preventDefault();
  } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
    setCount(count - N_STEP); e.preventDefault();
  } else if (e.code === 'KeyU') {
    dynamic = !dynamic;
    if (!dynamic) refreshAllText();
    e.preventDefault();
  } else if (e.code === 'KeyB') {
    useAtlas = !useAtlas; e.preventDefault();
  } else if (e.code === 'KeyR') {
    reset(); e.preventDefault();
  }
});

// ---- HUD ----
const hudEl = document.getElementById('hud');
let hudTimer = 0;
const fpsSamples = [];
let fpsAvg = 60;
let lastFont = '';
let lastColor = '';

// 統計パネル（複数行）の文字列。
function statsLines(dtMs) {
  const approxChars = count * AVG_CHARS;
  return [
    'FRAME : ' + frame,
    'N     : ' + count + ' / ' + N_MAX,
    'CHARS : ~' + approxChars,
    'MODE  : ' + (useAtlas ? 'GlyphAtlas' : 'CanvasTexture'),
    'UPD   : ' + (dynamic ? 'dynamic' : 'static'),
    'FPS   : ' + fpsAvg.toFixed(1),
    'TICK  : ' + dtMs.toFixed(1) + ' ms',
  ];
}

// =========================================================================
// メインループ
// =========================================================================
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const dtMs = dt * 1000;
  frame++;

  const inst = 1 / Math.max(dt, 1e-4);
  fpsSamples.push(inst);
  if (fpsSamples.length > 60) fpsSamples.shift();
  fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

  // 1) 論理更新（移動 + 反射/ラップ + 文字列更新）
  for (let i = 0; i < count; i++) {
    const it = items[i];
    it.x += it.vx * dt;
    if (it.x < 0) { it.x = 0; it.vx = -it.vx; }
    else if (it.x > VIEW_W) { it.x = VIEW_W; it.vx = -it.vx; }
    it.y += it.vy * dt;
    if (it.y > VIEW_H) it.y -= (VIEW_H + 24);
    if (dynamic) it.text = makeText(it, i);
  }

  // 2) テキスト canvas を全消去して描き直す（fillText or atlas ブリット）。
  tctx.clearRect(0, 0, VIEW_W, VIEW_H);
  lastFont = ''; lastColor = '';
  if (!useAtlas) {
    // CanvasTexture 方式: ctx.fillText を N 回（= Canvas Text の崖）。
    for (let i = 0; i < count; i++) {
      const it = items[i];
      const font = it.size + 'px Consolas, "Courier New", monospace';
      if (font !== lastFont) { tctx.font = font; lastFont = font; }
      if (it.colorHex !== lastColor) { tctx.fillStyle = it.colorHex; lastColor = it.colorHex; }
      tctx.fillText(it.text, it.x, it.y);
    }
  } else {
    // GlyphAtlas 方式: 事前ベイク済みグリフを drawImage でブリット（= BitmapText 相当）。
    for (let i = 0; i < count; i++) {
      const it = items[i];
      drawAtlasText(it.text, it.x, it.y, it.size, it.colorHex);
    }
  }

  // 3) 統計パネル（右上・複数行・毎フレーム）。同じ canvas に上描き。
  const lines = statsLines(dtMs);
  const sx = VIEW_W - 230;
  let sy = 8;
  if (!useAtlas) {
    tctx.font = '13px Consolas, "Courier New", monospace';
    tctx.fillStyle = '#bfe0ff';
    for (let i = 0; i < lines.length; i++) { tctx.fillText(lines[i], sx, sy); sy += 17; }
  } else {
    for (let i = 0; i < lines.length; i++) { drawAtlasText(lines[i], sx, sy, 13, '#bfe0ff'); sy += 17; }
  }

  // 4) テクスチャを1回だけ GPU へアップロード。
  textTex.needsUpdate = true;

  // 5) HUD（約120msごと）
  hudTimer += dtMs;
  if (hudTimer >= 120) {
    hudTimer = 0;
    const charsTotal = count * AVG_CHARS + 7 * 18;
    hudEl.textContent =
      'FPS    : ' + fpsAvg.toFixed(1) + '\n' +
      'Texts  : ' + count + ' / ' + N_MAX + '\n' +
      'Chars  : ~' + charsTotal + '\n' +
      'Render : ' + (useAtlas ? 'GlyphAtlas (CanvasTexture)' : 'CanvasTexture (fillText)') + '\n' +
      'Update : ' + (dynamic ? 'dynamic' : 'static') + '\n' +
      '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット';
  }

  renderer.render(scene, camera);
});

console.log('[three.js r184] theme13 dynamic-text init ok.');
