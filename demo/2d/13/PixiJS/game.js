/* =========================================================================
 * テーマ13 大量動的テキスト / UI 描画（動的テキスト・グリフ描画）― PixiJS v8
 * 仕様: SPEC.md
 *   - 960x540 / 暗色背景 / デルタタイム駆動
 *   - N 個のテキストアイテムが決定的に流れる（左右バウンド + 上下スクロール + ラップ）
 *   - 各アイテムは "OBJ#0042 v=137" 風の 8〜20 文字。数値部が毎フレーム更新される。
 *   - U: 動的更新 ON/OFF（ON=毎フレーム .text を書き換え / OFF=位置のみ）
 *   - +/-: テキスト数 ±100（下限0 / 上限5000）
 *   - B: Canvas Text ⇄ BitmapText（ランタイム生成ビットマップフォント）切替
 *   - R: リセット
 *   - 隅に常時更新される複数行の統計パネル（1つの Text）
 *
 * 計測の核（SPEC §30）:
 *   PIXI.Text は Canvas/HTML 背面でグリフをラスタライズしてテクスチャ化する。
 *   `.text` を書き換えるとそのテクスチャが**再生成**されるため、Update=ON では
 *   毎フレーム N 個ぶんのラスタライズが走る（重い経路。これが測定軸）。
 *   PIXI.BitmapText はグリフを事前生成したアトラスから引くだけなので、
 *   .text 書き換えのコストが桁違いに小さい（崖を回避できるかの対比）。
 *
 * 性能比較のため Pixi の auto-cull/性能系は素直設定。乱数は決定的 mulberry32 のみ
 * （Math.random は不使用）。
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = 0x0b0d16;     // 暗色背景

// テキスト数（負荷）
const N_INIT = 200;
const N_STEP = 100;
const N_MIN = 0;
const N_MAX = 5000;            // プール上限（= 確保する Text オブジェクト数の上限）

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

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須。app.view → app.canvas。
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: BG_COLOR,
    antialias: false,
    // 性能比較用途のため解像度は 1 固定。
    resolution: 1,
    autoDensity: false,
  });
  document.getElementById('game').appendChild(app.canvas);

  // ---- レイヤ ----
  // text レイヤにアイテムを全て載せる。statsText は最前面に別途。
  const textLayer = new PIXI.Container();
  app.stage.addChild(textLayer);

  // ---- ランタイム生成ビットマップフォント（外部アセット不要） ----
  // B 切替時に BitmapText が引くフォントアトラス。install で内蔵フォントから
  // グリフテクスチャを焼く。これ自体は初回1回だけのコスト。
  const BITMAP_FONT = 'theme13bmp';
  PIXI.BitmapFont.install({
    name: BITMAP_FONT,
    style: {
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 24,           // ベースサイズ。表示は item ごとに scale で調整。
      fill: '#ffffff',        // 白で焼いて、表示時に tint で色付けする。
    },
    // 焼くグリフ集合。ASCII 可視範囲全部（"OBJ#0042 v=137" / 統計パネルの全文字を網羅）。
    // 外部アセットは使わず、内蔵フォントからアトラスを動的生成する（初回1回のコスト）。
    chars: ' !"#$%&\'()*+,-./0123456789:;<=>?@'
         + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`'
         + 'abcdefghijklmnopqrstuvwxyz{|}~',
  });

  // 16進カラー文字列 → 数値（BitmapText の tint 用）。
  function hexToInt(hex) {
    return parseInt(hex.slice(1), 16) >>> 0;
  }

  // =======================================================================
  // アイテムモデル（決定的に生成）
  //   論理状態 {x,y,vx,vy,base,colorStr,colorInt,size} を items に持ち、
  //   表示は canvasObjs / bitmapObjs の対応する Text/BitmapText に反映する。
  //   表示オブジェクトはプール（最大 N_MAX）。N 超過分は visible=false。
  // =======================================================================
  const items = [];                 // 論理状態（最大 N_MAX 個ぶん確保）
  const canvasObjs = new Array(N_MAX).fill(null);  // PIXI.Text プール（遅延生成）
  const bitmapObjs = new Array(N_MAX).fill(null);  // PIXI.BitmapText プール（遅延生成）

  let count = 0;                    // 現在のアイテム数 N
  let useBitmap = false;            // false=Canvas Text / true=BitmapText
  let dynamic = true;              // Update ON=true（毎フレーム .text 更新）
  let frame = 0;                    // フレーム番号（統計パネル / 数値部に使用）

  // 論理状態を決定的に初期化（固定シード）。i ごとに pos/vel/color/size を割当。
  function initItems() {
    const rnd = mulberry32(20250613);
    items.length = 0;
    for (let i = 0; i < N_MAX; i++) {
      const colorIdx = Math.floor(rnd() * PALETTE.length);
      const colorStr = PALETTE[colorIdx];
      const size = SIZE_MIN + Math.floor(rnd() * (SIZE_MAX - SIZE_MIN + 1));
      items.push({
        x: rnd() * VIEW_W,
        y: rnd() * VIEW_H,
        vx: (VX_MIN + rnd() * (VX_MAX - VX_MIN)) * (rnd() < 0.5 ? -1 : 1),
        vy: VY_MIN + rnd() * (VY_MAX - VY_MIN),   // 下方向スクロール
        base: i,                                  // ラベルの固定番号（OBJ#xxxx）
        colorStr,
        colorInt: hexToInt(colorStr),
        size,
      });
    }
  }
  initItems();

  // 文字列生成（ホットパス）。"OBJ#0042 v=137" 風（8〜20 文字）。
  //   数値 v は frame と i から決定的に算出 → 毎フレーム変わる（再ラスタライズ対象）。
  function makeText(it, i) {
    // v は 0〜999 をぐるぐる。frame に依存させて毎フレーム変化させる。
    const v = (frame * 7 + i * 13) % 1000;
    return 'OBJ#' + pad4(it.base) + ' v=' + v;
  }

  // ---- Canvas Text プール（PIXI.Text, 遅延生成） ----
  // v8: new PIXI.Text({ text, style })。style.fontSize/fill を item ごとに変える。
  function getCanvasObj(i) {
    let t = canvasObjs[i];
    if (!t) {
      const it = items[i];
      t = new PIXI.Text({
        text: '',
        style: new PIXI.TextStyle({
          fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: it.size,
          fill: it.colorStr,
        }),
      });
      t.roundPixels = true;
      canvasObjs[i] = t;
      textLayer.addChild(t);
    }
    return t;
  }

  // ---- BitmapText プール（PIXI.BitmapText, 遅延生成） ----
  // ベースフォント 24px を item サイズへ scale。色は tint。
  function getBitmapObj(i) {
    let t = bitmapObjs[i];
    if (!t) {
      const it = items[i];
      t = new PIXI.BitmapText({
        text: '',
        style: { fontFamily: BITMAP_FONT, fontSize: 24 },
      });
      t.scale.set(it.size / 24);
      t.tint = it.colorInt;
      bitmapObjs[i] = t;
      textLayer.addChild(t);
    }
    return t;
  }

  // アクティブな表示オブジェクト（現在の機構に応じて）を返す。
  function activeObj(i) {
    return useBitmap ? getBitmapObj(i) : getCanvasObj(i);
  }

  // 現在の機構で i 番の表示を可視化し、初期文字列/位置を入れる。
  function showObj(i) {
    const o = activeObj(i);
    o.visible = true;
    return o;
  }

  // 機構を切り替える際、両プールの可視状態を整える。
  //   切替前の機構のオブジェクトは全て visible=false、新機構は count 個だけ可視。
  function applyVisibility() {
    // 非アクティブ側を全部隠す。
    const inactive = useBitmap ? canvasObjs : bitmapObjs;
    for (let i = 0; i < N_MAX; i++) {
      if (inactive[i]) inactive[i].visible = false;
    }
    // アクティブ側は 0..count-1 を可視、それ以降は隠す。
    for (let i = 0; i < count; i++) {
      showObj(i);
    }
    const active = useBitmap ? bitmapObjs : canvasObjs;
    for (let i = count; i < N_MAX; i++) {
      if (active[i]) active[i].visible = false;
    }
    // 静的（Update=OFF）の場合でも、機構切替直後は一度 .text を入れておく。
    refreshAllText();
  }

  // 全アクティブアイテムの .text を現在値で更新（初期化・静的固定・切替時に使用）。
  function refreshAllText() {
    for (let i = 0; i < count; i++) {
      const o = activeObj(i);
      o.text = makeText(items[i], i);
    }
  }

  // テキスト数を設定（プール再利用。生成は遅延、超過分は visible=false）。
  function setCount(n) {
    n = clamp(n, N_MIN, N_MAX);
    const active = useBitmap ? bitmapObjs : canvasObjs;
    if (n > count) {
      // 増加分を可視化し、文字列を初期化（プールから取り出すだけ。破棄なし）。
      for (let i = count; i < n; i++) {
        const o = showObj(i);
        o.text = makeText(items[i], i);
      }
    } else {
      // 減少分は破棄せず visible=false で退避。
      for (let i = n; i < count; i++) {
        if (active[i]) active[i].visible = false;
      }
    }
    count = n;
  }

  // ---- 統計パネル（複数行・1つの PIXI.Text。常時更新で多行再レイアウトも踏む） ----
  // SPEC §28: 画面隅に複数行の動的テキストを1つ置く。
  const statsText = new PIXI.Text({
    text: '',
    style: new PIXI.TextStyle({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      fill: '#bfe0ff',
      lineHeight: 17,
      align: 'left',
    }),
  });
  statsText.x = VIEW_W - 230;
  statsText.y = 8;
  app.stage.addChild(statsText);  // 最前面（textLayer の後に追加）

  // ---- 初期表示 ----
  setCount(N_INIT);

  // ---- リセット ----
  function reset() {
    initItems();
    // 機構・更新状態は維持（=操作で変えた状態をリセットでクリアしたくないなら
    //  initItems の再シードのみで十分。位置・速度は初期決定値に戻る）。
    applyVisibility();
  }

  // ---- 入力 ----
  window.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      setCount(count + N_STEP);
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      setCount(count - N_STEP);
      e.preventDefault();
    } else if (e.code === 'KeyU') {
      dynamic = !dynamic;
      // 動的→静的に切替えた瞬間は、現在値で一度固定する。
      if (!dynamic) refreshAllText();
      e.preventDefault();
    } else if (e.code === 'KeyB') {
      useBitmap = !useBitmap;
      applyVisibility();
      e.preventDefault();
    } else if (e.code === 'KeyR') {
      reset();
      e.preventDefault();
    }
  });

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // ---- メインループ ----
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05); // スパイク抑制
    frame++;

    // --- FPS 移動平均（直近60フレーム） ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // ====================================================================
    // 1) アイテム更新（決定的移動 + 反射/ラップ + 表示反映）
    //    - 水平: 端でバウンド（vx 反転）
    //    - 垂直: 下方向スクロールし、画面下を越えたら上端へラップ
    //    - Update=ON のときだけ .text を書き換える（= 再ラスタライズの主軸）
    // ====================================================================
    for (let i = 0; i < count; i++) {
      const it = items[i];

      // 水平バウンド
      it.x += it.vx * dt;
      if (it.x < 0) { it.x = 0; it.vx = -it.vx; }
      else if (it.x > VIEW_W) { it.x = VIEW_W; it.vx = -it.vx; }

      // 垂直スクロール + ラップ（下端を越えたら上へ）
      it.y += it.vy * dt;
      if (it.y > VIEW_H) it.y -= (VIEW_H + 24);

      const o = activeObj(i);
      o.x = it.x;
      o.y = it.y;

      // 動的更新（ON のときのみ）。setting .text が再レイアウト/再ラスタライズを誘発。
      if (dynamic) {
        o.text = makeText(it, i);
      }
    }

    // ====================================================================
    // 2) 統計パネル（毎フレーム更新。複数行のため多行再レイアウトを踏む）
    // ====================================================================
    const approxChars = count * AVG_CHARS;
    statsText.text =
      'FRAME : ' + frame + '\n' +
      'N     : ' + count + ' / ' + N_MAX + '\n' +
      'CHARS : ~' + approxChars + '\n' +
      'MODE  : ' + (useBitmap ? 'BitmapText' : 'Canvas Text') + '\n' +
      'UPD   : ' + (dynamic ? 'dynamic' : 'static') + '\n' +
      'FPS   : ' + fpsAvg.toFixed(1) + '\n' +
      'TICK  : ' + dtMs.toFixed(1) + ' ms';

    // ====================================================================
    // 3) HUD（約120msごと更新。SPEC §51 の必須項目を厳守）
    // ====================================================================
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      // Chars 概算: アイテム分 + 統計パネル分（おおよそ 7 行 × 18 文字）。
      const charsTotal = count * AVG_CHARS + 7 * 18;
      hudEl.textContent =
        'FPS    : ' + fpsAvg.toFixed(1) + '\n' +
        'Texts  : ' + count + ' / ' + N_MAX + '\n' +
        'Chars  : ~' + charsTotal + '\n' +
        'Render : ' + (useBitmap ? 'BitmapText' : 'Canvas Text') + '\n' +
        'Update : ' + (dynamic ? 'dynamic' : 'static') + '\n' +
        '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット';
    }
  });

  // three.js 版に合わせ、キャンバスは 960x540 固定（縮小スケールなし）。
  console.log('[PixiJS v8] theme13 dynamic-text init ok. renderer =', app.renderer.type);
})();
