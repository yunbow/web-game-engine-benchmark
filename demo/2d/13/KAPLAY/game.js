/* =========================================================================
 * テーマ13 大量動的テキスト / UI 描画（動的テキスト・グリフ描画）― KAPLAY 3001
 * 仕様: SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *   - 960x540 / 暗色背景(#0b0d16) / デルタタイム駆動
 *   - N 個のテキストアイテムが決定的に流れる（左右バウンド + 下方向スクロール + ラップ）
 *   - 各アイテムは "OBJ#0042 v=137" 風の 8〜20 文字。数値部が毎フレーム更新される。
 *   - U: 動的更新 ON/OFF（ON=毎フレーム文字列を書き換え / OFF=位置のみ）
 *   - +/-: テキスト数 ±100（下限0 / 上限5000）
 *   - B: 保持(retained) text() オブジェクト ⇄ 即時(immediate) drawText() 切替
 *   - R: リセット
 *   - 隅に常時更新される複数行の統計パネル（1つの text オブジェクト）
 *
 * ★ テキスト機構（KAPLAY ＝ 比較対象そのもの）★
 *   KAPLAY の「素直なテキスト機構」は2系統あり、両方とも内部で同じ
 *   ビットマップフォント・アトラス（既定フォント "happy" のグリフを焼いた
 *   テクスチャ）からグリフ矩形を引いて描く。文字を1文字=1quad で並べるため、
 *   PIXI.Text のような「文字列が変わるたびテクスチャを丸ごと再ラスタライズ」する
 *   コストは無い（PIXI.BitmapText 側に近い特性）。
 *     1) 保持オブジェクト方式（既定 / B=OFF）:
 *          add([ k.text(...) ]) で text コンポーネントを N 個プールし、
 *          .text 代入で再フォーマット（文字quadの再生成）が走る。
 *          オブジェクト管理（onDraw 走査・行レイアウト）コストを持つ。
 *     2) 即時方式（B=ON）:
 *          onDraw 内で k.drawText(...) を N 回呼ぶ。保持オブジェクトを持たず、
 *          毎フレーム formatText→グリフquad生成を必ず行う即時描画。
 *   どちらが崩れ始めるか・崖の位置は README に記載。
 *
 * 乱数は決定的 mulberry32 のみ（Math.random は不使用）。座標は KAPLAY ネイティブ
 * のスクリーン座標（原点左上・Y 下向き = 画面座標と一致）でそのまま扱う。
 * ========================================================================= */

// ---- 定数 (SPEC / PixiJS リファレンスと同値) -----------------------------
const VIEW_W = 960;
const VIEW_H = 540;

// テキスト数（負荷）
const N_INIT = 200;
const N_STEP = 100;
const N_MIN = 0;
const N_MAX = 5000;            // プール上限（= 確保する text オブジェクトの上限）

// アイテムの基準フォントサイズ範囲（決定的に割当）
const SIZE_MIN = 12;
const SIZE_MAX = 22;

// 速度範囲（px/s）。水平バウンド + 緩やかな下方向スクロールを与える。
const VX_MIN = 30, VX_MAX = 140;
const VY_MIN = 20, VY_MAX = 90;

// アイテム文字列の概算平均文字数（Chars 概算用）。"OBJ#0042 v=137" ≒ 14 文字。
const AVG_CHARS = 14;

// 色パレット（決定的に割当）。暗背景で映える明色。
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

// 4桁ゼロ埋め（"0042"）。文字列生成のホットパスなので軽量に。
function pad4(n) {
  n = n & 0xffff;
  let s = '' + n;
  return s.length >= 4 ? s : '0000'.slice(s.length) + s;
}

// '#rrggbb' → k.rgb(r,g,b)
function hexToRgb(k, hex) {
  const n = parseInt(hex.slice(1), 16);
  return k.rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

// === KAPLAY 初期化 =========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: [11, 13, 22],     // #0b0d16
  crisp: true,
  global: false,                // 名前空間 k.* を明示利用
  pixelDensity: 1,              // 性能比較のため解像度は 1 固定
});

// =========================================================================
// アイテムモデル（決定的に生成）
//   論理状態 {x,y,vx,vy,base,colorHex,colorRgb,size,text} を items に持つ。
//   保持方式の表示は textObjs プール（最大 N_MAX, 遅延生成）に反映する。
// =========================================================================
const items = [];                 // 論理状態（最大 N_MAX 個ぶん確保）
const textObjs = new Array(N_MAX).fill(null); // k.text() 保持オブジェクトのプール

let count = 0;                    // 現在のアイテム数 N
let immediate = false;           // false=保持 text() / true=即時 drawText()
let dynamic = true;              // Update ON=true（毎フレーム文字列更新）
let frame = 0;                    // フレーム番号（統計パネル / 数値部に使用）

// 論理状態を決定的に初期化（固定シード）。i ごとに pos/vel/color/size を割当。
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
      vy: VY_MIN + rnd() * (VY_MAX - VY_MIN),   // 下方向スクロール
      base: i,                                  // ラベルの固定番号（OBJ#xxxx）
      colorHex,
      colorRgb: hexToRgb(k, colorHex),
      size,
      text: '',                                 // 現在の表示文字列（キャッシュ）
    });
  }
}
initItems();

// 文字列生成（ホットパス）。"OBJ#0042 v=137" 風（8〜20 文字）。
//   数値 v は frame と i から決定的に算出 → 毎フレーム変わる。
function makeText(it, i) {
  const v = (frame * 7 + i * 13) % 1000;
  return 'OBJ#' + pad4(it.base) + ' v=' + v;
}

// ---- 保持 text() プール（遅延生成） ----
// k.text(str, { size }) コンポーネント + k.pos + k.color + k.anchor('topleft')。
function getTextObj(i) {
  let o = textObjs[i];
  if (!o) {
    const it = items[i];
    o = k.add([
      k.text('', { size: it.size, font: 'monospace' }),
      k.pos(it.x, it.y),
      k.color(it.colorRgb),
      k.anchor('topleft'),
    ]);
    textObjs[i] = o;
  }
  return o;
}

// テキスト数を設定（プール再利用。生成は遅延、超過分は hidden）。
function setCount(n) {
  n = clamp(n, N_MIN, N_MAX);
  if (!immediate) {
    if (n > count) {
      for (let i = count; i < n; i++) {
        const o = getTextObj(i);
        o.hidden = false;
        o.text = makeText(items[i], i);
        items[i].text = o.text;
      }
    } else {
      for (let i = n; i < count; i++) {
        if (textObjs[i]) textObjs[i].hidden = true;
      }
    }
  } else {
    // 即時方式は保持オブジェクトを持たないので、文字列キャッシュだけ整える。
    for (let i = count; i < n; i++) items[i].text = makeText(items[i], i);
  }
  count = n;
}

// 全アクティブアイテムの文字列を現在値で更新（初期化・静的固定・切替時に使用）。
function refreshAllText() {
  for (let i = 0; i < count; i++) {
    const s = makeText(items[i], i);
    items[i].text = s;
    if (!immediate && textObjs[i]) textObjs[i].text = s;
  }
}

// 機構切替時の可視状態整理。保持オブジェクトは即時方式の間は全部隠す。
function applyVisibility() {
  for (let i = 0; i < N_MAX; i++) {
    if (textObjs[i]) textObjs[i].hidden = immediate || i >= count;
  }
  if (!immediate) {
    for (let i = 0; i < count; i++) getTextObj(i).hidden = false;
  }
  refreshAllText();
}

// ---- 初期表示 ----
setCount(N_INIT);

// ---- リセット ----
function reset() {
  initItems();
  applyVisibility();
}

// ---- 入力 ----
k.onKeyPress(['=', 'kpadd'], () => { setCount(count + N_STEP); });
k.onKeyPress(['-', 'kpsubtract'], () => { setCount(count - N_STEP); });
k.onKeyPress('u', () => {
  dynamic = !dynamic;
  if (!dynamic) refreshAllText();   // 動的→静的で現在値に固定
});
k.onKeyPress('b', () => {
  immediate = !immediate;
  applyVisibility();
});
k.onKeyPress('r', () => { reset(); });

// ---- HUD ----
const hudEl = document.getElementById('hud');
let hudTimer = 0;
const fpsSamples = [];
let fpsAvg = 60;

// 統計パネル用の文字列（複数行）。即時方式では drawText、保持方式では text obj へ。
let statsObj = null;
function getStatsObj() {
  if (!statsObj) {
    statsObj = k.add([
      k.text('', { size: 13, font: 'monospace', lineSpacing: 4 }),
      k.pos(VIEW_W - 230, 8),
      k.color(hexToRgb(k, '#bfe0ff')),
      k.anchor('topleft'),
    ]);
  }
  return statsObj;
}

function statsString(dtMs) {
  const approxChars = count * AVG_CHARS;
  return (
    'FRAME : ' + frame + '\n' +
    'N     : ' + count + ' / ' + N_MAX + '\n' +
    'CHARS : ~' + approxChars + '\n' +
    'MODE  : ' + (immediate ? 'drawText (immediate)' : 'text() (retained)') + '\n' +
    'UPD   : ' + (dynamic ? 'dynamic' : 'static') + '\n' +
    'FPS   : ' + fpsAvg.toFixed(1) + '\n' +
    'TICK  : ' + dtMs.toFixed(1) + ' ms'
  );
}

// ---- メインループ（更新） ----
k.onUpdate(() => {
  const dt = Math.min(k.dt(), 0.05); // スパイク抑制
  const dtMs = dt * 1000;
  frame++;

  // FPS 移動平均（直近60フレーム）
  const inst = 1 / Math.max(dt, 1e-4);
  fpsSamples.push(inst);
  if (fpsSamples.length > 60) fpsSamples.shift();
  fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

  // 1) アイテム更新（決定的移動 + 反射/ラップ + 文字列更新）
  for (let i = 0; i < count; i++) {
    const it = items[i];

    // 水平バウンド
    it.x += it.vx * dt;
    if (it.x < 0) { it.x = 0; it.vx = -it.vx; }
    else if (it.x > VIEW_W) { it.x = VIEW_W; it.vx = -it.vx; }

    // 垂直スクロール + ラップ（下端を越えたら上へ）
    it.y += it.vy * dt;
    if (it.y > VIEW_H) it.y -= (VIEW_H + 24);

    // 動的更新（ON のときのみ文字列を作り直す = 再フォーマット誘発）
    if (dynamic) it.text = makeText(it, i);

    // 保持方式は表示オブジェクトに反映（位置・必要なら文字列）
    if (!immediate) {
      const o = getTextObj(i);
      o.pos.x = it.x;
      o.pos.y = it.y;
      if (dynamic) o.text = it.text;
    }
  }

  // 2) 統計パネル（保持方式のみ毎フレーム .text 更新。即時方式は onDraw で描く）
  if (!immediate) {
    getStatsObj().hidden = false;
    getStatsObj().text = statsString(dtMs);
  } else if (statsObj) {
    statsObj.hidden = true;
  }

  // 3) HUD（約120msごと更新）
  hudTimer += dtMs;
  if (hudTimer >= 120) {
    hudTimer = 0;
    const charsTotal = count * AVG_CHARS + 7 * 18;
    hudEl.textContent =
      'FPS    : ' + fpsAvg.toFixed(1) + '\n' +
      'Texts  : ' + count + ' / ' + N_MAX + '\n' +
      'Chars  : ~' + charsTotal + '\n' +
      'Render : ' + (immediate ? 'drawText (immediate)' : 'text() (retained)') + '\n' +
      'Update : ' + (dynamic ? 'dynamic' : 'static') + '\n' +
      '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット';
  }
});

// ---- 即時描画（B=ON のときだけ実体描画） ----
// 保持オブジェクトを持たず、毎フレーム drawText を N 回 + 統計パネルを描く。
k.onDraw(() => {
  if (!immediate) return;
  for (let i = 0; i < count; i++) {
    const it = items[i];
    k.drawText({
      text: it.text,
      pos: k.vec2(it.x, it.y),
      size: it.size,
      font: 'monospace',
      color: it.colorRgb,
      anchor: 'topleft',
    });
  }
  // 統計パネル（複数行）
  k.drawText({
    text: statsString(Math.min(k.dt(), 0.05) * 1000),
    pos: k.vec2(VIEW_W - 230, 8),
    size: 13,
    font: 'monospace',
    lineSpacing: 4,
    color: hexToRgb(k, '#bfe0ff'),
    anchor: 'topleft',
  });
});

console.log('[KAPLAY 3001] theme13 dynamic-text init ok.');
