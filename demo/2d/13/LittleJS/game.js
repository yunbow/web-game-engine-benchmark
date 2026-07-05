'use strict';

/*
  テーマ13 大量動的テキスト / UI 描画 ― LittleJS 版
  --------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / 背景は暗色(#0b0d16)
   - N 個のテキストアイテムが画面内を決定的に流れる(スクロール+バウンド, 画面外でラップ)
   - 各アイテムは 8〜20 文字の "OBJ#0042 v=137" 風ラベル(数値部が毎フレーム更新)
   - 固定シードで初期位置・速度・色・サイズを決定(Math.random 不使用)
   - U: 動的更新 ON/OFF(毎フレーム文字列を作り直す vs キャッシュ文字列を再利用)
   - +/-: テキスト数 ±100(初期200, 下限0, 上限5000)
   - R: リセット / 画面隅に毎フレーム更新される複数行の統計パネル
   - HUD(HTML #hud overlay): FPS / Texts / Chars / Render / Update + 操作ヒント

  ★ テキスト機構 / Immediate-mode メモ (最重要) ★
   - LittleJS のテキストは "保持(retained)オブジェクト" が存在しない。
     drawTextScreen(text, posScreen, size, color, ...) を毎フレーム呼ぶ即時(immediate)描画で、
     内部的には overlay canvas の 2D context.fillText を毎回叩く。
   - したがって PixiJS の PIXI.Text のような「テキストオブジェクトのテクスチャをキャッシュし、
     文字列が変わらなければ再ラスタライズしない」最適化は効かない。
     → fillText のラスタライズコストは Update ON/OFF に関わらず "常に" 毎フレーム支払う。
     → Update ON/OFF が変えるのは「文字列を毎フレーム組み立て直すか(文字列ビルドコスト)」だけ。
   - そのため本エンジンでは:
       Update ON  = 毎フレーム数値を再計算して文字列を String 連結で作る (build + fillText)
       Update OFF = アイテムごとにキャッシュした固定文字列を使う      (fillText のみ)
     どちらも fillText は全アイテム分走るので、Canvas テキストの「描画オブジェクト数」の
     崖は両モードで観測でき、Update ON ではさらに文字列ビルド分が上乗せされる。

  ★ 座標系 / Y軸メモ ★
   - LittleJS のワールドは Y軸"上向き"だが、drawTextScreen は "スクリーン座標" を取り、
     スクリーン座標は通常の 2D と同じく Y軸"下向き"(左上原点, 下=Y大)。
   - テキストの位置・速度はすべてこのスクリーン空間(px, y-down)で保持し、
     ワールド↔スクリーンの y 反転を一切挟まない。これが本テーマの罠回避の肝。
     (drawText のワールド版を使うと y-up になり、移動・ラップ・統計パネルの座標が
      上下逆転して混乱するので、本テーマはスクリーン空間に統一する。)
*/

// ---- 画面定数 (SPEC) ----
const VIEW_W = 960, VIEW_H = 540;        // 固定キャンバス(スクリーン座標)
const BG_COLOR = new Color(0.043, 0.051, 0.086, 1); // #0b0d16 相当

// ---- テキスト数(負荷) ----
let textTarget = 200;                    // 設定値(初期200)
const TEXT_STEP = 100, TEXT_MIN = 0, TEXT_MAX = 5000;

// ---- フォントサイズ範囲 (px, スクリーン) ----
const SIZE_MIN = 11, SIZE_MAX = 22;

// ---- 文字列ラベルの語彙(8〜20文字に収まるよう調整) ----
const LABELS = ['OBJ', 'SYS', 'NET', 'CPU', 'GPU', 'MEM', 'LOG', 'IO', 'EVT', 'PKT'];

// ---- グローバル状態 ----
let items = [];            // フラットなプール配列(オブジェクトを使い回す)
let dynamicUpdate = true;  // U トグル: true=毎フレーム文字列再構築 / false=キャッシュ再利用
let frameNo = 0;           // 統計パネル用フレーム番号
let rebuildsThisFrame = 0; // そのフレームで文字列を作り直した回数(統計)

// FPS 指数移動平均
let fpsAvg = 60;

const hudEl = () => document.getElementById('hud');

// ---- 決定的疑似乱数 (mulberry32) ― Math.random は不使用 ----
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

// ---- テキストアイテムのファクトリ(決定的) ----
// index ごとにシードを派生させ、+/- で再生成しても同じ並びを保つ。
const BASE_SEED = 1300013;
function makeItem(i) {
  const rng = makeRng(BASE_SEED + i * 2654435761);
  // 初期位置(スクリーン空間 px, y-down)
  const x = rng() * VIEW_W;
  const y = rng() * VIEW_H;
  // 速度: 下方向スクロール成分 + 左右バウンド成分(px/s)
  const vx = (rng() * 2 - 1) * 60;          // -60..60
  const vy = 20 + rng() * 90;               // 20..110 (下方向=+Y)
  // 色(明るめ・読みやすい範囲)
  const col = new Color(0.5 + rng() * 0.5, 0.5 + rng() * 0.5, 0.5 + rng() * 0.5, 1);
  // サイズ
  const size = SIZE_MIN + Math.floor(rng() * (SIZE_MAX - SIZE_MIN + 1));
  // ラベル種別 と 4桁ID
  const label = LABELS[Math.floor(rng() * LABELS.length)];
  const id = Math.floor(rng() * 10000);
  // 数値部の初期値・進む速さ(整数カウンタ)
  const valBase = Math.floor(rng() * 1000);
  return {
    x, y, vx, vy, col, size, label, id, valBase,
    val: valBase,        // 毎フレーム更新される数値
    str: '',             // キャッシュ文字列(Update OFF / 初期表示で使う)
  };
}

// 文字列ビルド: "OBJ#0042 v=137" 風 (8〜20文字)。新しい String を生成する経路。
function buildString(it) {
  // id は4桁ゼロ詰め, val は可変桁。連結で毎回新規文字列を作る = 動的更新の主コスト。
  const idStr = ('000' + it.id).slice(-4);
  return it.label + '#' + idStr + ' v=' + it.val;
}

// プールを textTarget 個へ調整(増えた分だけ決定的に生成し、余剰は切る)。
function syncItemCount() {
  if (items.length < textTarget) {
    for (let i = items.length; i < textTarget; i++) {
      const it = makeItem(i);
      it.str = buildString(it);   // 初期キャッシュ
      items.push(it);
    }
  } else if (items.length > textTarget) {
    items.length = textTarget;    // 末尾を切る(残りはそのまま使い回し)
  }
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);
  // 暗色背景。LittleJS のキャンバスクリア色を直接設定(canvas 全面が #0b0d16 相当)。
  // drawRectScreen は存在しないため、背景塗りは clear color で行う(描画コスト 0)。
  if (typeof setCanvasClearColor !== 'undefined') setCanvasClearColor(BG_COLOR);
  if (typeof setShowSplashScreen !== 'undefined') setShowSplashScreen(false);

  resetSim();
}

function resetSim() {
  items = [];
  textTarget = 200;
  dynamicUpdate = true;
  frameNo = 0;
  syncItemCount();
}

function gameUpdate() {
  const dt = timeDelta; // デルタタイム基準

  // ---- テキスト数 増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    textTarget = clamp(textTarget + TEXT_STEP, TEXT_MIN, TEXT_MAX);
    syncItemCount();
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    textTarget = clamp(textTarget - TEXT_STEP, TEXT_MIN, TEXT_MAX);
    syncItemCount();
  }

  // ---- U: 動的更新トグル ----
  if (keyWasPressed('KeyU')) dynamicUpdate = !dynamicUpdate;

  // ---- R: リセット ----
  if (keyWasPressed('KeyR')) { resetSim(); return; }

  // ---- B: 機構切替(LittleJS は単一の immediate-mode テキストのみ → 無効) ----
  // SPEC 上 任意。本エンジンは drawTextScreen の一機構なので何もしない(README に明記)。

  frameNo++;
  rebuildsThisFrame = 0;

  // ---- アイテム更新: 移動(スクリーン空間 y-down) + ラップ + 数値/文字列更新 ----
  for (let i = 0; i < items.length; i++) {
    const it = items[i];

    // 位置更新(px, y-down)。下方向スクロール + 左右バウンド。
    it.x += it.vx * dt;
    it.y += it.vy * dt;

    // 左右はバウンド(画面端で反転)。
    if (it.x < 0) { it.x = 0; it.vx = -it.vx; }
    else if (it.x > VIEW_W) { it.x = VIEW_W; it.vx = -it.vx; }

    // 縦は下端を抜けたら上端へラップ(下方向スクロールの巻き戻し)。
    if (it.y > VIEW_H + it.size) it.y = -it.size;
    else if (it.y < -it.size) it.y = VIEW_H + it.size;

    // 数値部の更新(決定的: フレーム番号とインデックスから算出)。
    // 0..999 を巡回させ、ラベルが刻々変わる「ライブ更新」感を出す。
    it.val = (it.valBase + frameNo + i * 7) % 1000;

    // 動的更新 ON のときだけ文字列を作り直す(= 文字列ビルドコストを毎フレーム支払う)。
    // OFF のときは it.str(キャッシュ)をそのまま使うので val 変化は表示に出ない。
    if (dynamicUpdate) {
      it.str = buildString(it);
      rebuildsThisFrame++;
    }
  }
}

function gameUpdatePost() {}

// ===================================================================
//  描画 ― drawTextScreen による immediate-mode テキスト
// ===================================================================
function gameRender() {
  // 背景は setCanvasClearColor(BG_COLOR) 済みのため、ここでの背景塗りは不要。
  // テキスト本体は gameRenderPost(overlay canvas 上)で描く。
}

function gameRenderPost() {
  // ---- 主役: 全アイテムを drawTextScreen で immediate 描画 ----
  // 文字列が ON/OFF どちらでも、ここで毎フレーム fillText のラスタライズが走る。
  let charCount = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // posScreen はスクリーン座標(左上原点, y-down)。そのまま渡す。
    // drawTextScreen(text, posScreen, size, color, lineWidth, lineColor, align)
    drawTextScreen(it.str, vec2(it.x, it.y), it.size, it.col, 0, BLACK, 'left');
    charCount += it.str.length;
  }

  // ---- 画面隅の統計パネル(複数行・毎フレーム更新 → 多行の動的テキスト) ----
  drawStatsPanel(charCount);

  // ---- HUD(HTML overlay)更新 ----
  updateHud(charCount);
}

// 右上に固定の複数行ライブ統計パネル(毎フレーム文字列を作り直す)。
function drawStatsPanel(charCount) {
  const lines = [
    'LIVE STATS',
    'frame  : ' + frameNo,
    'items  : ' + items.length,
    'rebuild: ' + rebuildsThisFrame + (dynamicUpdate ? ' (dyn)' : ' (static)'),
    'glyphs : ' + charCount,
    'avglen : ' + (items.length ? (charCount / items.length).toFixed(1) : '0.0'),
    'mode   : ' + (dynamicUpdate ? 'DYNAMIC' : 'STATIC'),
  ];
  const px = VIEW_W - 8;       // 右寄せ基準
  let py = 14;
  const lh = 16;
  const panelCol = new Color(0.7, 0.95, 1, 1);
  for (let i = 0; i < lines.length; i++) {
    drawTextScreen(lines[i], vec2(px, py), 13, panelCol, 0, BLACK, 'right');
    py += lh;
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function updateHud(charCount) {
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS    : ' + fpsAvg.toFixed(1) + '\n' +
      'Texts  : ' + items.length + ' / ' + TEXT_MAX + '\n' +
      'Chars  : ' + charCount + '\n' +
      'Render : drawTextScreen (canvas)\n' +
      'Update : ' + (dynamicUpdate ? 'dynamic' : 'static') + '\n' +
      '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット';
  }
}

// ===================================================================
//  起動
// ===================================================================
// 第7引数 rootElement に #game-container を渡し、canvas をそこへ生成させる
// (three.js 版と同じ 960x540・上端中央配置。CSS の !important でサイズ固定)。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, [],
  document.getElementById('game-container'));
