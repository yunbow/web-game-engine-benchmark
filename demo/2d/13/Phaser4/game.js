/* ============================================================
 * テーマ13 大量動的テキスト / UI 描画 ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠。
 *   画面 960x540 固定 / 暗色背景 #0b0d16 / デルタタイム基準。
 *   N 個のテキストアイテムが決定的に流れ（バウンド＋ラップ）、
 *   各アイテムは "OBJ#0042 v=137" 風の短い文字列（8〜20文字）を表示する。
 *   U=ON で毎フレーム全アイテムの文字列を setText で作り直す（重い経路）。
 *
 * 計測軸: 「画面上のテキストオブジェクト数」 ×「毎フレーム文字列更新するか否か」。
 *   Phaser の Text は setText のたびに内部 Canvas を再ラスタライズするため、
 *   Update=ON のコスト＝本テーマの主役（再レイアウト/グリフ再生成）。
 *   テキストオブジェクトはプール（cap 分まで生成し、余剰は非表示）して使い回し、
 *   毎フレームの生成/破棄は一切しない。
 *
 * 任意機構: B キーで Canvas Text ⇄ BitmapText を切替。
 *   外部フォントアセットは使わず、起動時に Canvas へ ASCII グリフを焼いて
 *   ランタイムでビットマップフォントを生成する（BootScene 参照）。
 * ============================================================ */

// ---- 基本定数 (SPEC.md) ----
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = '#0b0d16';

// テキストアイテム数 (負荷)
const INITIAL_TEXTS = 200;
const TEXT_STEP = 100;
const MIN_TEXTS = 0;
const MAX_TEXTS = 5000;   // = プール上限 (cap)

// アイテムの動き (px/s)
const SPEED_MIN = 30;
const SPEED_MAX = 130;

// アイテムごとのフォントサイズ候補 (px)
const SIZE_CHOICES = [11, 12, 13, 14, 16];

// アイテムごとの色候補 (決定的に割当)
const COLOR_CHOICES = [
  '#9fe7ff', '#ffd27f', '#a8ff9f', '#ff9fb0',
  '#c9a8ff', '#ffe27f', '#7fd0ff', '#ff8f6f',
];
// BitmapText 用の同色 (数値 tint)
const COLOR_TINTS = [
  0x9fe7ff, 0xffd27f, 0xa8ff9f, 0xff9fb0,
  0xc9a8ff, 0xffe27f, 0x7fd0ff, 0xff8f6f,
];

// 文字列の基準ラベル幅。"OBJ#0042 v=137" 形式 (= 8〜20文字に収まる)。
const AVG_CHARS = 14;   // Chars 概算に使う 1 アイテム平均文字数

// ---- 決定的疑似乱数 (Mulberry32) ----
// 初期位置・速度・色・サイズ・基準文字列はすべてこの PRNG で決める。Math.random は不使用。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 4桁ゼロ詰め (例: 42 -> "0042")。文字列生成のホットパス用に簡易実装。
function pad4(n) {
  n = n | 0;
  if (n < 10) return '000' + n;
  if (n < 100) return '00' + n;
  if (n < 1000) return '0' + n;
  return '' + n;
}

// ============================================================
// BootScene ― ランタイムでビットマップフォントを焼く (外部アセット不要)
// ============================================================
// 使用 ASCII 文字だけを「等幅セル」グリッドで Canvas に焼き、
// Phaser 標準の RetroFont.Parse でビットマップフォントデータを生成して
// bitmapFont キャッシュへ登録する。これで B キーの
// 「Canvas Text ⇄ BitmapText」比較を外部フォントアセット無しで実現する。
//   グリフは白で焼き、表示時に setTint で色付けする (アイテムごとの色)。
const BMP_FONT_KEY = 'runtimeBmp';
// RetroFont は連続コードを前提とするため、ASCII 32(' ')〜122('z') を等幅セルで全て焼く
// (使わないコードも空セルとして確保し、コード→セル位置の対応を単純化)。
// 表示文字列 "OBJ#0042 v=137" は小文字 v を含むため、小文字まで網羅する。
const BMP_FIRST = 32;    // ' '
const BMP_LAST = 122;    // 'z'  (記号 #=.+-:/ ・数字・英大小文字を全て網羅)
const BMP_CELL_W = 12;
const BMP_CELL_H = 20;
const BMP_FONT_PX = 16;
const BMP_COLS = 16;    // 1 行あたりのセル数 (charsPerRow)

class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  create() {
    this.buildBitmapFont();
    this.scene.start('GameScene');
  }

  buildBitmapFont() {
    if (this.textures.exists(BMP_FONT_KEY)) {
      this.registry.set('bmpFontReady', true);
      return;
    }

    const count = BMP_LAST - BMP_FIRST + 1;
    const rows = Math.ceil(count / BMP_COLS);
    const texW = BMP_COLS * BMP_CELL_W;
    const texH = rows * BMP_CELL_H;

    // RetroFont.Parse が要求する連続文字列 (コード順)。
    let chars = '';
    for (let code = BMP_FIRST; code <= BMP_LAST; code++) chars += String.fromCharCode(code);

    // テクスチャ用 Canvas を確保し、各文字を等幅セルの中央へ白で焼く。
    const canvasTex = this.textures.createCanvas(BMP_FONT_KEY, texW, texH);
    const ctx = canvasTex.getContext();
    ctx.clearRect(0, 0, texW, texH);
    ctx.fillStyle = '#ffffff';
    ctx.font = BMP_FONT_PX + 'px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = 0; i < chars.length; i++) {
      const cx = (i % BMP_COLS) * BMP_CELL_W;
      const cy = Math.floor(i / BMP_COLS) * BMP_CELL_H;
      ctx.fillText(chars[i], cx + BMP_CELL_W / 2, cy + BMP_CELL_H / 2);
    }
    canvasTex.refresh();

    // Phaser 標準の RetroFont (固定グリッド用ビットマップフォント) でパースして登録。
    // Parse の返り値は {data, frame, texture} 形のキャッシュエントリそのものなので、
    // そのまま bitmapFont キャッシュへ add する。
    const RetroFont = Phaser.GameObjects.RetroFont;
    if (RetroFont && RetroFont.Parse) {
      const entry = RetroFont.Parse(this, {
        image: BMP_FONT_KEY,
        width: BMP_CELL_W,
        height: BMP_CELL_H,
        chars: chars,
        charsPerRow: BMP_COLS,
        offset: { x: 0, y: 0 },
        spacing: { x: 0, y: 0 },
        lineSpacing: 0,
      });
      this.cache.bitmapFont.add(BMP_FONT_KEY, entry);
      this.registry.set('bmpFontReady', true);
    } else {
      // RetroFont が無いビルドでは B を無効化 (README に明記)。
      this.registry.set('bmpFontReady', false);
    }
  }
}

// ============================================================
// GameScene ― 本体
// ============================================================
// 描画機構の種別。
const MODE_CANVAS = 0;   // this.add.text (Canvas ベース Text)
const MODE_BITMAP = 1;   // this.add.bitmapText (ランタイム生成フォント)

class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    this.cameras.main.setBackgroundColor(BG_COLOR);

    this.targetCount = INITIAL_TEXTS;   // 表示したいアイテム数 N
    this.updateDynamic = true;          // U: 毎フレーム文字列更新するか
    this.mode = MODE_CANVAS;            // 現在の描画機構
    this.bmpFontReady = !!this.registry.get('bmpFontReady');

    this.frame = 0;     // フレーム番号 (統計パネル)
    this.elapsed = 0;   // 経過秒
    this.setTextCalls = 0; // 直近フレームの setText 呼び出し数 (計測補助)

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // アイテムの論理データ (描画オブジェクトとは分離。プール切替時も保持)。
    // {x, y, vx, vy, sizeIdx, colorIdx, baseId, baseVal, cur} を持つ。
    this.items = [];
    this.buildItems();   // MAX_TEXTS 分の論理データを決定的に生成

    // 描画プール (Canvas Text / BitmapText の 2 系統)。
    // cap (= MAX_TEXTS) まで遅延生成し、余剰は setVisible(false) で隠す。
    this.canvasPool = [];   // Phaser.GameObjects.Text
    this.bitmapPool = [];   // Phaser.GameObjects.BitmapText

    // 統計パネル (複数行・常時更新)。多行テキストの再レイアウトも踏ませる。
    this.statsPanel = this.add.text(VIEW_W - 8, 8, '', {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      align: 'right',
      backgroundColor: 'rgba(8,12,22,0.55)',
      padding: { x: 8, y: 6 },
    }).setOrigin(1, 0).setDepth(2000);

    // HUD (左上) と操作ヒント (画面下)。
    this.buildHUD();

    // 入力。
    this.input.keyboard.on('keydown-PLUS', () => this.adjustCount(+TEXT_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustCount(-TEXT_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustCount(+TEXT_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustCount(-TEXT_STEP));
    this.input.keyboard.on('keydown-U', () => this.toggleDynamic());
    this.input.keyboard.on('keydown-B', () => this.toggleMode());
    this.input.keyboard.on('keydown-R', () => this.reset());

    // 初期同期 (必要数ぶんの描画オブジェクトを可視化)。
    this.syncPool();
  }

  // ============================================================
  // アイテム論理データの決定的生成
  // ============================================================
  buildItems() {
    const rng = mulberry32(0x13ADBEEF); // seed 固定
    this.items.length = 0;
    for (let i = 0; i < MAX_TEXTS; i++) {
      const speed = SPEED_MIN + rng() * (SPEED_MAX - SPEED_MIN);
      const ang = rng() * Math.PI * 2;
      const item = {
        x: rng() * VIEW_W,
        y: rng() * VIEW_H,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        sizeIdx: Math.floor(rng() * SIZE_CHOICES.length),
        colorIdx: Math.floor(rng() * COLOR_CHOICES.length),
        baseId: i,                              // OBJ#xxxx の番号
        baseVal: Math.floor(rng() * 1000),      // v= の初期値
        cur: '',                                // 現在の表示文字列
      };
      // バウンドが極端に水平/垂直に寄らないよう最低速度を確保。
      if (Math.abs(item.vx) < 12) item.vx = item.vx < 0 ? -12 : 12;
      if (Math.abs(item.vy) < 12) item.vy = item.vy < 0 ? -12 : 12;
      item.cur = this.makeString(item, 0);
      this.items.push(item);
    }
  }

  // "OBJ#0042 v=137" 風の文字列を生成 (8〜20文字)。
  // dynamic 値はフレーム/経過で変化する数値部分。
  makeString(item, dynVal) {
    return 'OBJ#' + pad4(item.baseId) + ' v=' + dynVal;
  }

  // アイテム i の現フレームの動的数値 (0〜999 を回す)。
  dynValueFor(item) {
    return (item.baseVal + this.frame) % 1000;
  }

  // ============================================================
  // 描画プール: cap まで遅延生成し、active 数まで可視化、余剰は非表示。
  // 生成/破棄はしない (cap 到達後はオブジェクトを使い回すだけ)。
  // ============================================================
  ensureCanvas(i) {
    let t = this.canvasPool[i];
    if (!t) {
      const item = this.items[i];
      t = this.add.text(0, 0, item.cur, {
        fontFamily: 'Consolas, monospace',
        fontSize: SIZE_CHOICES[item.sizeIdx] + 'px',
        color: COLOR_CHOICES[item.colorIdx],
      }).setOrigin(0.5, 0.5).setDepth(10);
      this.canvasPool[i] = t;
    }
    return t;
  }

  ensureBitmap(i) {
    let t = this.bitmapPool[i];
    if (!t) {
      const item = this.items[i];
      // ランタイムフォントは 16px 基準。アイテムのサイズ候補を反映。
      t = this.add.bitmapText(0, 0, BMP_FONT_KEY, item.cur, SIZE_CHOICES[item.sizeIdx])
        .setOrigin(0.5, 0.5).setDepth(10);
      t.setTint(COLOR_TINTS[item.colorIdx]);
      this.bitmapPool[i] = t;
    }
    return t;
  }

  // 現在のモード/必要数に合わせて可視オブジェクトを揃える。
  // active = [0, targetCount) を可視、それ以外は非表示。反対モードのプールは全非表示。
  syncPool() {
    const useBmp = (this.mode === MODE_BITMAP && this.bmpFontReady);
    const n = this.targetCount;

    if (useBmp) {
      for (let i = 0; i < n; i++) this.ensureBitmap(i).setVisible(true);
      for (let i = n; i < this.bitmapPool.length; i++) this.bitmapPool[i].setVisible(false);
      // Canvas プールは全部隠す。
      for (let i = 0; i < this.canvasPool.length; i++) this.canvasPool[i].setVisible(false);
    } else {
      for (let i = 0; i < n; i++) this.ensureCanvas(i).setVisible(true);
      for (let i = n; i < this.canvasPool.length; i++) this.canvasPool[i].setVisible(false);
      for (let i = 0; i < this.bitmapPool.length; i++) this.bitmapPool[i].setVisible(false);
    }
  }

  // ============================================================
  // 操作
  // ============================================================
  adjustCount(delta) {
    this.targetCount = Phaser.Math.Clamp(this.targetCount + delta, MIN_TEXTS, MAX_TEXTS);
    this.syncPool();
  }

  toggleDynamic() {
    this.updateDynamic = !this.updateDynamic;
    // OFF に切り替えた瞬間、文字列を一度確定させて以後は固定 (位置だけ動く)。
    if (!this.updateDynamic) this.refreshAllStrings();
  }

  toggleMode() {
    if (!this.bmpFontReady) return; // フォント未生成なら no-op (README 明記)
    this.mode = (this.mode === MODE_CANVAS) ? MODE_BITMAP : MODE_CANVAS;
    this.syncPool();
    // 切替直後はモードに合わせて文字列を一度確定。
    this.refreshAllStrings();
  }

  reset() {
    this.targetCount = INITIAL_TEXTS;
    this.updateDynamic = true;
    this.mode = MODE_CANVAS;
    this.frame = 0;
    this.elapsed = 0;
    this.fpsSamples.length = 0;
    this.fpsAvg = 60;
    // 論理データを初期シードから作り直し、文字列とプールを揃える。
    this.buildItems();
    this.refreshAllStrings();
    this.syncPool();
  }

  // 可視中の全アイテムの表示文字列を現フレーム値で一度だけ確定する。
  // (U=OFF への切替時 / モード切替時 / リセット時に呼ぶ)
  refreshAllStrings() {
    const useBmp = (this.mode === MODE_BITMAP && this.bmpFontReady);
    for (let i = 0; i < this.targetCount; i++) {
      const item = this.items[i];
      const s = this.makeString(item, this.dynValueFor(item));
      item.cur = s;
      if (useBmp) { const t = this.bitmapPool[i]; if (t) t.setText(s); }
      else { const t = this.canvasPool[i]; if (t) t.setText(s); }
    }
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    this.hud = this.add.text(8, 6, '', {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(10,16,22,0.6)',
      padding: { x: 8, y: 5 },
    }).setDepth(2000);

  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒 (スパイク抑制)
    this.frame += 1;
    this.elapsed += dt;

    // FPS 移動平均 (30 サンプル)。
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    const useBmp = (this.mode === MODE_BITMAP && this.bmpFontReady);
    const n = this.targetCount;
    this.setTextCalls = 0;

    // --- アイテム更新: 位置 (常時) ＋ 文字列 (Update=ON のみ) ---
    for (let i = 0; i < n; i++) {
      const item = this.items[i];

      // 決定的バウンド + ラップ。端で速度を反転 (バウンド)。
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      if (item.x < 0) { item.x = 0; item.vx = -item.vx; }
      else if (item.x > VIEW_W) { item.x = VIEW_W; item.vx = -item.vx; }
      if (item.y < 0) { item.y = 0; item.vy = -item.vy; }
      else if (item.y > VIEW_H) { item.y = VIEW_H; item.vy = -item.vy; }

      const t = useBmp ? this.bitmapPool[i] : this.canvasPool[i];
      if (!t) continue;
      t.setPosition(item.x | 0, item.y | 0); // 位置移動は常に行う (軽い経路)

      if (this.updateDynamic) {
        // ★ 計測の主役: 毎フレーム文字列を作り直して setText。
        //   Canvas Text はここで内部 Canvas を再ラスタライズする (重い)。
        const s = this.makeString(item, this.dynValueFor(item));
        item.cur = s;
        t.setText(s);
        this.setTextCalls++;
      }
    }

    this.updateStatsPanel();
    this.updateHUD();
  }

  // ============================================================
  // 統計パネル (複数行・毎フレーム setText)。
  // ============================================================
  updateStatsPanel() {
    // ライブ更新カウンタ群。多行テキストの再レイアウトも毎フレーム踏ませる。
    // lead.x は先頭アイテムの x 座標 (位置が動いていることの可視確認用)。
    const leadX = (this.targetCount > 0 ? this.items[0].x : 0);
    this.statsPanel.setText([
      '== LIVE STATS ==',
      'frame  : ' + this.frame,
      'time   : ' + this.elapsed.toFixed(1) + 's',
      'active : ' + this.targetCount,
      'setText: ' + this.setTextCalls + '/f',
      'mode   : ' + (this.mode === MODE_BITMAP ? 'Bitmap' : 'Canvas'),
      'dyn    : ' + (this.updateDynamic ? 'ON' : 'OFF'),
      'lead.x : ' + leadX.toFixed(0),
    ].join('\n'));
  }

  updateHUD() {
    const useBmp = (this.mode === MODE_BITMAP && this.bmpFontReady);
    const renderName = useBmp ? 'BitmapText' : 'Canvas Text';
    // Chars 概算 = アイテム数 × 平均文字数 ＋ 統計パネル/HUD のおおまかな分。
    const charsItems = this.targetCount * AVG_CHARS;
    const charsPanel = 90; // 統計パネルのおおよその文字数
    const chars = charsItems + charsPanel;

    this.hud.setText([
      'FPS    : ' + this.fpsAvg.toFixed(1),
      'Texts  : ' + this.targetCount + ' / ' + MAX_TEXTS,
      'Chars  : ~' + chars,
      'Render : ' + renderName + (useBmp ? '' : (this.mode === MODE_BITMAP ? ' (bmp N/A)' : '')),
      'Update : ' + (this.updateDynamic ? 'dynamic' : 'static'),
      '+/-=テキスト数  U=動的更新  B=機構切替  R=リセット',
    ].join('\n'));
  }
}

// ============================================================
// 起動
// ============================================================
const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: VIEW_W,
  height: VIEW_H,
  backgroundColor: BG_COLOR,
  scene: [BootScene, GameScene],
  render: { antialias: true },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
