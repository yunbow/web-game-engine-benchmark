/* ============================================================
 * テーマ12 フォーリングサンド / セルオートマトン ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠。
 *
 * 性能比較の核 (本テーマの未計測軸):
 *   COLS×ROWS のセル格子を毎フレーム CPU で更新し、全セルの RGBA を
 *   1枚の RGBA バッファ(ImageData)へ書き込み、GPU テクスチャへアップロードする
 *   ＝「毎フレーム全面テクスチャ書き換え + 転送」のスループットを測る。
 *
 * Phaser でのテクスチャ更新機構: CanvasTexture (this.textures.createCanvas)。
 *   ctx.putImageData(imageData, 0, 0) で COLS×ROWS の <canvas> を全面書き換え →
 *   canvasTexture.refresh() で GPU へ再アップロード。
 *   それを 960x540 へニアレストネイバー拡大した Image で表示する。
 *
 * 画面 960x540 固定 / デルタタイム計測だがシミュは固定1ステップ/フレーム。
 * 乱択はすべて決定的PRNG(mulberry32)。Math.random は不使用。
 * ============================================================ */

// ---- 基本定数 ----
const VIEW_W = 960;
const VIEW_H = 540;

// グリッド解像度 (負荷の主軸) ― SPEC.md より
const COLS_INIT = 160;   // 初期列数 (→ ROWS=90, 14400 セル)
const COLS_STEP = 40;    // +/- の増減幅
const COLS_MIN = 80;     // 下限
const COLS_MAX = 640;    // 上限
// ROWS = round(COLS * 540/960) で常に 16:9 を保つ
const rowsFor = (cols) => Math.round(cols * VIEW_H / VIEW_W);

// セル素材: 0=空気 1=砂 2=水 3=壁(不動)
const EMPTY = 0, SAND = 1, WATER = 2, WALL = 3;

// 素材色 (SPEC.md 基準)。砂は決定的な濃淡を持たせるためテーブル化。
// 空気=背景暗色, 水=青, 壁=灰。色は [r,g,b] で保持し ImageData へ展開する。
const COLOR_EMPTY = [0x0b, 0x0d, 0x12]; // #0b0d12
const COLOR_WATER = [0x3a, 0x7b, 0xd5]; // #3a7bd5
const COLOR_WALL  = [0x88, 0x88, 0x88]; // #888
const SAND_BASE   = [0xd9, 0xc0, 0x67]; // #d9c067

// ブラシ
const BRUSH_RADIUS = 3;  // 描画ブラシ半径 (セル単位, SPEC「数セル」)

// ---- 決定的疑似乱数 (Mulberry32) ----
// セルの砂濃淡・エミッタ揺らぎなど、乱択が要る箇所はすべてこれで決定的に。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 砂の色バリエーション: 16段階の濃淡パレットを決定的に事前生成。
// セルごとに格納する 0..15 の「砂シェード」を引いて ImageData に展開する。
function buildSandShades() {
  const rng = mulberry32(0x5A4D01);
  const shades = [];
  for (let i = 0; i < 16; i++) {
    // ±18 程度の決定的な明暗ゆらぎ
    const d = Math.floor((rng() - 0.5) * 36);
    shades.push([
      Phaser.Math.Clamp(SAND_BASE[0] + d, 0, 255),
      Phaser.Math.Clamp(SAND_BASE[1] + d, 0, 255),
      Phaser.Math.Clamp(SAND_BASE[2] + Math.floor(d * 0.6), 0, 255),
    ]);
  }
  return shades;
}
const SAND_SHADES = buildSandShades();

// ============================================================
// BootScene ― 本テーマはアセット不要 (色はコード生成) なので即遷移。
// ============================================================
class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }
  create() { this.scene.start('GameScene'); }
}

// ============================================================
// GameScene ― 本体 (セルオートマトン + 動的テクスチャ書き換え)
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    // ブラシ・状態の初期値
    this.cols = COLS_INIT;
    this.rows = rowsFor(COLS_INIT);
    this.brush = SAND;        // 現在のブラシ素材
    this.frame = 0;           // 走査の左右交互判定・エミッタ揺らぎ用フレームカウンタ

    // ポインタ状態 (左=描画 / 右=消去)
    this.paintLeft = false;
    this.paintRight = false;
    this.pointerCol = -1;
    this.pointerRow = -1;

    // 右ドラッグ消去のためコンテキストメニュー無効化
    this.input.mouse.disableContextMenu();

    // 表示用 Image (CanvasTexture を 960x540 へ拡大表示)
    // テクスチャは buildGrid 内で (再)生成する。
    this.gridImage = this.add.image(0, 0, '__DEFAULT').setOrigin(0, 0).setDepth(0);

    // グリッド状態とテクスチャを構築
    this.buildGrid(this.cols, this.rows);

    // --- 入力 (キーボード) ---
    this.input.keyboard.on('keydown-ONE',   () => { this.brush = SAND; });
    this.input.keyboard.on('keydown-TWO',   () => { this.brush = WATER; });
    this.input.keyboard.on('keydown-THREE', () => { this.brush = WALL; });
    this.input.keyboard.on('keydown-C',     () => this.clearGrid());
    this.input.keyboard.on('keydown-R',     () => this.resetGrid());
    // +/- で解像度 (テンキー含む)
    this.input.keyboard.on('keydown-PLUS',          () => this.adjustCols(+COLS_STEP));
    this.input.keyboard.on('keydown-MINUS',         () => this.adjustCols(-COLS_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD',    () => this.adjustCols(+COLS_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustCols(-COLS_STEP));

    // --- 入力 (ポインタ) ---
    this.input.on('pointerdown', (p) => {
      if (p.rightButtonDown()) this.paintRight = true;
      else this.paintLeft = true;
      this.updatePointerCell(p);
    });
    this.input.on('pointermove', (p) => this.updatePointerCell(p));
    this.input.on('pointerup', (p) => {
      // 離されたボタンに応じて解除 (両方落ちている可能性に配慮)
      if (!p.leftButtonDown()) this.paintLeft = false;
      if (!p.rightButtonDown()) this.paintRight = false;
    });
    this.input.on('pointerout', () => { this.pointerCol = -1; this.pointerRow = -1; });

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均 (30 サンプル)
    this.fpsSamples = [];
    this.fpsAvg = 60;
    this.activeCount = 0; // 空気以外のセル数
  }

  // ============================================================
  // グリッド/テクスチャ構築 (解像度変更・リセットで作り直し)
  // ============================================================
  buildGrid(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cellCount = cols * rows;

    // 格子は flat な Uint8Array (素材 0..3)。砂シェードも flat に保持。
    this.grid = new Uint8Array(this.cellCount);
    this.shade = new Uint8Array(this.cellCount); // 砂セルの濃淡インデックス 0..15

    // 既存テクスチャを破棄して COLS×ROWS の CanvasTexture を作り直す。
    if (this.canvasTex) { this.textures.remove('grid'); this.canvasTex = null; }
    this.canvasTex = this.textures.createCanvas('grid', cols, rows);
    this.texCtx = this.canvasTex.getContext();
    // CPU 側ピクセルバッファ (RGBA)。これを毎フレーム全面書き換えする。
    this.imageData = this.texCtx.createImageData(cols, rows);
    // 不透明アルファを最初に埋めておく (以後 RGB のみ更新)
    const d = this.imageData.data;
    for (let i = 3; i < d.length; i += 4) d[i] = 255;

    // ニアレストネイバー拡大 (ドットをくっきり)。pixelArt:true でも効くが明示する。
    this.canvasTex.setFilter(Phaser.Textures.FilterMode.NEAREST);

    // 表示 Image をこのテクスチャに差し替え、960x540 へ拡大。
    this.gridImage.setTexture('grid');
    this.gridImage.setDisplaySize(VIEW_W, VIEW_H);
    this.gridImage.setOrigin(0, 0).setPosition(0, 0);

    // エミッタを比率で再配置 (グリッド解像度に依らず同じ相対位置)
    this.buildEmitters();

    // 決定的初期状態 (今回は「空 + 床/壁なし」で開始。エミッタが供給する)
    // ※ R(reset) はこの buildGrid を呼び直すだけで決定的に再現できる。
    this.activeCount = 0;
  }

  // エミッタ: 上部に決定的な数個。位置は列比率で、素材は固定。
  // 無入力でも常にセルが動く (ベンチ安定) ようにする。
  buildEmitters() {
    // 相対位置 (0..1) と素材を固定。砂3・水2 の計5個。
    const defs = [
      { fx: 0.18, mat: SAND },
      { fx: 0.34, mat: WATER },
      { fx: 0.50, mat: SAND },
      { fx: 0.66, mat: WATER },
      { fx: 0.82, mat: SAND },
    ];
    this.emitters = defs.map((e) => ({
      col: Phaser.Math.Clamp(Math.round(e.fx * (this.cols - 1)), 0, this.cols - 1),
      mat: e.mat,
    }));
    // エミッタ揺らぎ用の決定的PRNG (フレーム非依存の安定シード)
    this.emitRng = mulberry32(0xE3117);
  }

  idx(c, r) { return r * this.cols + c; }

  // ============================================================
  // ポインタ → セル座標。描画/消去はここで即適用 (ドラッグ追従)。
  // ============================================================
  updatePointerCell(p) {
    // 表示は 960x540 全面なので、画面座標をそのままセル比率に換算。
    const c = Math.floor((p.x / VIEW_W) * this.cols);
    const r = Math.floor((p.y / VIEW_H) * this.rows);
    this.pointerCol = c;
    this.pointerRow = r;
    if (this.paintLeft) this.paintBrush(c, r, this.brush);
    else if (this.paintRight) this.paintBrush(c, r, EMPTY);
  }

  // 半径 BRUSH_RADIUS の円形ブラシで素材を置く (壁/砂/水/空)。
  paintBrush(cc, cr, mat) {
    const R = BRUSH_RADIUS;
    for (let dr = -R; dr <= R; dr++) {
      for (let dc = -R; dc <= R; dc++) {
        if (dc * dc + dr * dr > R * R) continue;
        const c = cc + dc, r = cr + dr;
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const i = this.idx(c, r);
        this.grid[i] = mat;
        if (mat === SAND) this.shade[i] = this.pickShade(c, r);
      }
    }
  }

  // 砂セルの濃淡を決定的に決める (座標ハッシュ → 0..15)。
  pickShade(c, r) {
    let h = (c * 73856093) ^ (r * 19349663);
    h = (h ^ (h >>> 13)) >>> 0;
    return h & 15;
  }

  // ============================================================
  // エミッタ供給: 毎フレーム、各エミッタ列付近に少量の素材を投入。
  // 決定的PRNG で左右に1セルだけ揺らし、詰まり過ぎを避ける。
  // ============================================================
  runEmitters() {
    for (const e of this.emitters) {
      const jitter = Math.floor(this.emitRng() * 3) - 1; // -1,0,1
      const c = Phaser.Math.Clamp(e.col + jitter, 0, this.cols - 1);
      const r = 1; // 上端のすぐ下
      const i = this.idx(c, r);
      // 既存が空/水なら供給 (壁の上には積まない)
      if (this.grid[i] === EMPTY || (e.mat === SAND && this.grid[i] === WATER)) {
        this.grid[i] = e.mat;
        if (e.mat === SAND) this.shade[i] = this.pickShade(c, r);
      }
    }
  }

  // ============================================================
  // セルオートマトン更新 (決定的・下の行から上へ / 各行は左右交互スキャン)
  // ============================================================
  stepSimulation() {
    const cols = this.cols, rows = this.rows;
    const g = this.grid;

    // 下の行から上へ走査。各行はフレームと行で左右交互にして偏りを抑える。
    for (let r = rows - 1; r >= 0; r--) {
      const leftToRight = ((r + this.frame) & 1) === 0;
      if (leftToRight) {
        for (let c = 0; c < cols; c++) this.updateCell(c, r);
      } else {
        for (let c = cols - 1; c >= 0; c--) this.updateCell(c, r);
      }
    }
  }

  // セル外は壁扱い (true = 通過不可)。
  isWallOrOut(c, r) {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return true;
    return this.grid[this.idx(c, r)] === WALL;
  }

  // 1セルの更新。砂/水の落下・流動規則 (SPEC.md)。
  updateCell(c, r) {
    const i = this.idx(c, r);
    const m = this.grid[i];
    if (m === SAND) this.updateSand(c, r, i);
    else if (m === WATER) this.updateWater(c, r, i);
    // EMPTY / WALL は何もしない (壁は不動)
  }

  // 素材を i→j へ移動 (空き先へ)。砂シェードも一緒に運ぶ。
  moveTo(i, j) {
    this.grid[j] = this.grid[i];
    this.shade[j] = this.shade[i];
    this.grid[i] = EMPTY;
  }

  // 砂と水を入れ替える (砂が沈む)。
  swap(i, j) {
    const gm = this.grid[i], gs = this.shade[i];
    this.grid[i] = this.grid[j]; this.shade[i] = this.shade[j];
    this.grid[j] = gm; this.shade[j] = gs;
  }

  // 砂: 真下が空/水なら落下 (水とは入れ替わって沈む)。
  // 塞がれていれば左下・右下へ (決定的に選択)。
  updateSand(c, r, i) {
    // 真下
    const below = r + 1;
    if (below < this.rows) {
      const bi = this.idx(c, below);
      const bm = this.grid[bi];
      if (bm === EMPTY) { this.moveTo(i, bi); return; }
      if (bm === WATER) { this.swap(i, bi); return; } // 砂が水に沈む
    }
    // 左下・右下 (フレーム+列パリティで決定的に優先方向を切替)
    const preferLeft = ((c + this.frame) & 1) === 0;
    const dirs = preferLeft ? [-1, 1] : [1, -1];
    for (const d of dirs) {
      const nc = c + d, nr = r + 1;
      if (nc < 0 || nc >= this.cols || nr >= this.rows) continue;
      const ni = this.idx(nc, nr);
      const nm = this.grid[ni];
      if (nm === EMPTY) { this.moveTo(i, ni); return; }
      if (nm === WATER) { this.swap(i, ni); return; }
    }
  }

  // 水: 真下が空なら落下。塞がれていれば左下・右下、
  // それも塞がれていれば左右へ広がる (決定的順)。
  updateWater(c, r, i) {
    const below = r + 1;
    // 真下
    if (below < this.rows) {
      const bi = this.idx(c, below);
      if (this.grid[bi] === EMPTY) { this.moveTo(i, bi); return; }
    }
    const preferLeft = ((c + this.frame) & 1) === 0;
    const dirs = preferLeft ? [-1, 1] : [1, -1];
    // 左下・右下
    for (const d of dirs) {
      const nc = c + d, nr = r + 1;
      if (nc < 0 || nc >= this.cols || nr >= this.rows) continue;
      const ni = this.idx(nc, nr);
      if (this.grid[ni] === EMPTY) { this.moveTo(i, ni); return; }
    }
    // 左右に広がる
    for (const d of dirs) {
      const nc = c + d;
      if (nc < 0 || nc >= this.cols) continue;
      const ni = this.idx(nc, r);
      if (this.grid[ni] === EMPTY) { this.moveTo(i, ni); return; }
    }
  }

  // ============================================================
  // 全面テクスチャ書き換え (本テーマの計測対象)
  //   全セルの RGBA を ImageData に書き込み → putImageData → refresh で GPU 転送。
  // あわせて Active (空気以外) をカウントする。
  // ============================================================
  uploadTexture() {
    const d = this.imageData.data;
    const g = this.grid;
    const sh = this.shade;
    const n = this.cellCount;
    let active = 0;

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const m = g[i];
      let col;
      if (m === EMPTY) {
        col = COLOR_EMPTY;
      } else if (m === SAND) {
        col = SAND_SHADES[sh[i]];
        active++;
      } else if (m === WATER) {
        col = COLOR_WATER;
        active++;
      } else { // WALL
        col = COLOR_WALL;
        active++;
      }
      d[p]     = col[0];
      d[p + 1] = col[1];
      d[p + 2] = col[2];
      // d[p+3] (alpha) は構築時 255 で固定済み。
    }
    this.activeCount = active;

    // CPU バッファ → <canvas> → GPU テクスチャへアップロード。
    this.texCtx.putImageData(this.imageData, 0, 0);
    this.canvasTex.refresh();
  }

  // ============================================================
  // 操作系
  // ============================================================
  adjustCols(delta) {
    const next = Phaser.Math.Clamp(this.cols + delta, COLS_MIN, COLS_MAX);
    if (next === this.cols) return;
    // 解像度変更 → 状態を決定的に作り直す (SPEC: 作り直し)。
    this.buildGrid(next, rowsFor(next));
  }

  clearGrid() {
    // 全消去 (エミッタは残す)。grid を 0 埋めするだけ。
    this.grid.fill(EMPTY);
    this.shade.fill(0);
    this.activeCount = 0;
  }

  resetGrid() {
    // リセット = 決定的初期状態へ (解像度は初期値に戻す)。
    this.buildGrid(COLS_INIT, rowsFor(COLS_INIT));
    this.brush = SAND;
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    const style = {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(10,16,22,0.55)',
      padding: { x: 8, y: 6 },
    };
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(1000);
  }

  brushName() {
    return this.brush === SAND ? 'sand' : this.brush === WATER ? 'water' : 'wall';
  }

  updateHUD() {
    this.hud.setText([
      `FPS    : ${this.fpsAvg.toFixed(1)}`,
      `Grid   : ${this.cols} x ${this.rows} = ${this.cellCount} cells`,
      `Active : ${this.activeCount}`,
      `Brush  : ${this.brushName()}`,
      `Upload : ImageData -> CanvasTexture (putImageData+refresh, NEAREST)`,
    ].join('\n'));
  }

  // ============================================================
  // メインループ (固定 1 ステップ/フレーム)
  // ============================================================
  update(time, delta) {
    // FPS 移動平均
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    // 1) エミッタ供給 (無入力でも動く)
    this.runEmitters();
    // 2) セルオートマトン更新
    this.stepSimulation();
    // 3) 全面テクスチャ書き換え + GPU アップロード (計測対象)
    this.uploadTexture();

    this.frame++;
    this.updateHUD();
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
  backgroundColor: '#0b0d12',
  scene: [BootScene, GameScene],
  // pixelArt:true でテクスチャ既定フィルタを NEAREST に (ドットくっきり)
  render: { antialias: false, roundPixels: true, pixelArt: true },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
