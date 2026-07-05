/* =========================================================================
 * テーマ13 大量動的テキスト / UI 描画（動的テキスト・グリフ描画）― A-Frame 1.7.0
 * 仕様: SPEC.md / 正準リファレンス: ../PixiJS/game.js ／ ../three.js/game.js
 *   - 960x540 / 暗色背景(#0b0d16) / デルタタイム駆動
 *   - N 個のテキストアイテムが決定的に流れる（左右バウンド + 下方向スクロール + ラップ）
 *   - 各アイテムは "OBJ#0042 v=137" 風の 8〜20 文字。数値部が毎フレーム更新される。
 *   - U: 動的更新 ON/OFF（ON=毎フレーム文字列を書き換え / OFF=位置のみ）
 *   - +/-: テキスト数 ±100（下限0 / 上限5000）
 *   - B: CanvasTexture 方式 ⇄ GlyphAtlas 方式 切替
 *   - R: リセット
 *   - 隅に常時更新される複数行の統計パネル
 *
 * ★ テキスト機構（A-Frame ＝ three.js なので“ネイティブのテキスト”が無い）★
 *   A-Frame は three.js 上の宣言的(entity-component)フレームワーク。標準の
 *   `<a-text>` は SDF フォント1枚を使うが、「1ラベル=1エンティティ」を N=数千個
 *   並べると DOM/コンポーネント/メッシュ生成で破綻する（テーマ1と同じ崖）。
 *   そこで本実装は ../three.js/game.js と全く同じテキスト機構をミラーする:
 *   文字列はすべて 1枚の 2D canvas に描き、AFRAME.THREE.CanvasTexture として
 *   画面いっぱいの板ポリ(quad)に貼り、毎フレーム1回だけ GPU アップロードする。
 *
 *     1) CanvasTexture 方式（既定 / B=OFF） ＝ Canvas Text 相当:
 *          960x540 のオフスクリーン 2D canvas に毎フレーム ctx.fillText を
 *          N 回叩いて全テキストを描き、CanvasTexture を再アップロードする。
 *          「fillText を N 回ラスタライズ + テクスチャ全面再アップロード」が崖。
 *
 *     2) GlyphAtlas 方式（B=ON） ＝ BitmapText 相当:
 *          ASCII 可視グリフを1枚のアトラスへ事前ベイク（初回1回）。各文字は
 *          drawImage でアトラスの該当矩形を 2D canvas へブリットするだけ
 *          （フォントのラスタライズは初回のみ）。.text 変更コストが桁違いに小さい。
 *
 *   どちらも最終的に CanvasTexture を1枚の正射影 quad に貼る点は共通。
 *   ＝ A-Frame でも「テキストは canvas 経由」というワークアラウンドが肝。
 *
 * 座標系: 2D 用に tick で sceneEl.camera を OrthographicCamera(0,W,H,0) に維持
 *   （A-Frame 既定の perspective カメラを上書き）。quad は中央 (W/2,H/2) に置き、
 *   テクスチャは flipY=false で 2D canvas(y-down) の上下を quad uv に合わせる。
 * 乱数は決定的 mulberry32 のみ（Math.random は不使用）。
 * ========================================================================= */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC / three.js リファレンスと同値) --------------------------
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
// GlyphAtlas（B=ON 用）: ASCII 可視グリフを1枚のアトラスにベイク（初回1回）。
//   等幅フォントで cell 幅・高さを固定し、文字コードからセル位置を引く。
//   色は per-item で焼き分ける（パレット8色 + 統計パネル色を事前生成）。
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

// =========================================================================
// A-Frame コンポーネント: シーン全体（テキスト描画・ループ・入力・HUD）を駆動。
// =========================================================================
AFRAME.registerComponent('textui-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera を用意（tick で sceneEl.camera を維持）
    this.cam = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1); // DPR=1 固定
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    // ---- テキスト用 2D canvas（全テキストはここに描いて CanvasTexture へ）----
    const textCanvas = document.createElement('canvas');
    textCanvas.width = VIEW_W;
    textCanvas.height = VIEW_H;
    this.textCanvas = textCanvas;
    this.tctx = textCanvas.getContext('2d');
    this.tctx.textBaseline = 'top';

    const textTex = new THREE.CanvasTexture(textCanvas);
    textTex.colorSpace = THREE.SRGBColorSpace;
    textTex.magFilter = THREE.NearestFilter;
    textTex.minFilter = THREE.NearestFilter;
    textTex.generateMipmaps = false;
    // PlaneGeometry の uv は左下原点。flipY=false で 2D canvas(y-down) に合わせる。
    textTex.flipY = false;
    this.textTex = textTex;

    const quadGeo = new THREE.PlaneGeometry(VIEW_W, VIEW_H);
    const quadMat = new THREE.MeshBasicMaterial({ map: textTex, transparent: true, depthTest: false });
    const quad = new THREE.Mesh(quadGeo, quadMat);
    quad.position.set(VIEW_W / 2, VIEW_H / 2, 0);
    this.group.add(quad);

    // パレット分のアトラスを事前生成（初回コスト。以後は drawImage のみ）。
    for (const hex of PALETTE) buildGlyphAtlas(hex);
    buildGlyphAtlas('#bfe0ff'); // 統計パネル用

    // ---- 状態 ----
    this.items = [];
    this.count = 0;
    this.useAtlas = false;        // false=CanvasTexture(fillText) / true=GlyphAtlas
    this.dynamic = true;
    this.frame = 0;
    this.hudTimer = 0;
    this.fpsSamples = [];
    this.fpsAvg = 60;

    this.initItems();
    this.setCount(N_INIT);

    // ---- 入力 ----
    window.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
        this.setCount(this.count + N_STEP); e.preventDefault();
      } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
        this.setCount(this.count - N_STEP); e.preventDefault();
      } else if (e.code === 'KeyU') {
        this.dynamic = !this.dynamic;
        if (!this.dynamic) this.refreshAllText();
        e.preventDefault();
      } else if (e.code === 'KeyB') {
        this.useAtlas = !this.useAtlas; e.preventDefault();
      } else if (e.code === 'KeyR') {
        this.reset(); e.preventDefault();
      }
    });
  },

  // item の size に応じてアトラスのセルをスケールしてブリットする。
  drawAtlasText(str, x, y, size, colorHex) {
    const tctx = this.tctx;
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
  },

  // アイテムモデルを決定的に初期化（固定シード）。
  initItems() {
    const rnd = mulberry32(20250613);
    this.items.length = 0;
    for (let i = 0; i < N_MAX; i++) {
      const colorIdx = Math.floor(rnd() * PALETTE.length);
      const colorHex = PALETTE[colorIdx];
      const size = SIZE_MIN + Math.floor(rnd() * (SIZE_MAX - SIZE_MIN + 1));
      this.items.push({
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
  },

  makeText(it, i) {
    const v = (this.frame * 7 + i * 13) % 1000;
    return 'OBJ#' + pad4(it.base) + ' v=' + v;
  },

  refreshAllText() {
    for (let i = 0; i < this.count; i++) this.items[i].text = this.makeText(this.items[i], i);
  },

  setCount(n) {
    n = clamp(n, N_MIN, N_MAX);
    if (n > this.count) {
      for (let i = this.count; i < n; i++) this.items[i].text = this.makeText(this.items[i], i);
    }
    this.count = n;
  },

  reset() {
    this.initItems();
    this.setCount(N_INIT);
  },

  // 統計パネル（複数行）の文字列。
  statsLines(dtMs) {
    const approxChars = this.count * AVG_CHARS;
    return [
      'FRAME : ' + this.frame,
      'N     : ' + this.count + ' / ' + N_MAX,
      'CHARS : ~' + approxChars,
      'MODE  : ' + (this.useAtlas ? 'GlyphAtlas' : 'CanvasTexture'),
      'UPD   : ' + (this.dynamic ? 'dynamic' : 'static'),
      'FPS   : ' + this.fpsAvg.toFixed(1),
      'TICK  : ' + dtMs.toFixed(1) + ' ms',
    ];
  },

  tick(time, dtMsRaw) {
    // カメラを 2D 用に維持（A-Frame が別カメラを差し込んでも上書き）
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    const dtMs = Math.min(dtMsRaw || 16.7, 50); // タブ復帰時の暴発抑制
    const dt = dtMs / 1000;
    this.frame++;

    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst);
    if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    this.fpsAvg = this.fpsSamples.reduce((s, v) => s + v, 0) / this.fpsSamples.length;

    const items = this.items;
    const count = this.count;
    const tctx = this.tctx;

    // 1) 論理更新（移動 + 反射/ラップ + 文字列更新）
    for (let i = 0; i < count; i++) {
      const it = items[i];
      it.x += it.vx * dt;
      if (it.x < 0) { it.x = 0; it.vx = -it.vx; }
      else if (it.x > VIEW_W) { it.x = VIEW_W; it.vx = -it.vx; }
      it.y += it.vy * dt;
      if (it.y > VIEW_H) it.y -= (VIEW_H + 24);
      if (this.dynamic) it.text = this.makeText(it, i);
    }

    // 2) テキスト canvas を全消去して描き直す（fillText or atlas ブリット）。
    tctx.clearRect(0, 0, VIEW_W, VIEW_H);
    if (!this.useAtlas) {
      // CanvasTexture 方式: ctx.fillText を N 回（= Canvas Text の崖）。
      let lastFont = '', lastColor = '';
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
        this.drawAtlasText(it.text, it.x, it.y, it.size, it.colorHex);
      }
    }

    // 3) 統計パネル（右上・複数行・毎フレーム）。同じ canvas に上描き。
    const lines = this.statsLines(dtMs);
    const sx = VIEW_W - 230;
    let sy = 8;
    if (!this.useAtlas) {
      tctx.font = '13px Consolas, "Courier New", monospace';
      tctx.fillStyle = '#bfe0ff';
      for (let i = 0; i < lines.length; i++) { tctx.fillText(lines[i], sx, sy); sy += 17; }
    } else {
      for (let i = 0; i < lines.length; i++) { this.drawAtlasText(lines[i], sx, sy, 13, '#bfe0ff'); sy += 17; }
    }

    // 4) テクスチャを1回だけ GPU へアップロード。
    this.textTex.needsUpdate = true;

    // 5) HUD（約120msごと）
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const charsTotal = count * AVG_CHARS + 7 * 18;
      this.hudEl.textContent =
        'FPS    : ' + this.fpsAvg.toFixed(1) + '\n' +
        'Texts  : ' + count + ' / ' + N_MAX + '\n' +
        'Chars  : ~' + charsTotal + '\n' +
        'Render : ' + (this.useAtlas ? 'GlyphAtlas (CanvasTexture)' : 'CanvasTexture (fillText)') + '\n' +
        'Update : ' + (this.dynamic ? 'dynamic' : 'static') + '\n' +
        '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット';
    }
  },
});

console.log('A-Frame 1.7.0 theme13 dynamic-text component registered.');
