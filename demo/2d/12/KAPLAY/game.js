/* =========================================================================
 * テーマ12 フォーリングサンド / セルオートマトン（動的テクスチャ書き換え）
 *   ― KAPLAY 3001.0.19 実装
 * 仕様: SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *
 * 本テーマのベンチ軸は「グリッドセルのシミュレーション更新 ＋ 毎フレームの
 * 全面テクスチャ書き換え（CPUピクセルバッファ → GPUアップロード）」。
 *
 * KAPLAY での“素直な”テクスチャ更新機構（＝これ自体が比較対象）:
 *   - オフスクリーン <canvas>（COLS×ROWS）を 1枚用意し、その 2D コンテキストの
 *     ImageData(=RGBA Uint8ClampedArray) に毎フレーム全セルの色を書き込む。
 *   - ctx.putImageData(imageData, 0, 0) で canvas へ反映。
 *   - その canvas を k.loadSprite() でスプライト化（初回のみ）。KAPLAY 内部の
 *     Texture(GL テクスチャ) を取得し、毎フレーム tex.update(0,0,canvas) で
 *     GPU へ再アップロードする（loadSprite を毎フレーム呼ばず、テクスチャだけ更新）。
 *   - スプライトを 960x540 へ拡大して全画面表示。拡大補間は KAPLAY 全体設定
 *     texFilter:"nearest"（crisp 相当）でドットをくっきり。
 *
 * → 機構文字列: "ImageData→canvas, Texture.update() (KAPLAY GL tex)"
 *
 * シミュレーションは flat な Uint8Array グリッド（COLS×ROWS）で保持し、
 * Math.random は不使用（必要な乱択は mulberry32 で決定的に行う）。
 * =========================================================================*/

// ---- 画面・グリッド定数 (SPEC) -------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const COLS_INIT = 160;       // 初期解像度（→ ROWS=90, 14400 セル）
const COLS_STEP = 40;        // +/- の増減幅
const COLS_MIN = 80;
const COLS_MAX = 640;

// セル素材
const EMPTY = 0, SAND = 1, WATER = 2, WALL = 3;
const MAT_NAME = { [SAND]: 'sand', [WATER]: 'water', [WALL]: 'wall' };

// 物理パラメータ（決定的）
const SIM_SEED = 20250615;   // シミュレーション用 PRNG シード（左右選択などに使用）
const BUILD_SEED = 12345;    // 初期状態の構築用シード

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

// ---- 素材色（SPEC 基準） --------------------------------------------------
const COL_EMPTY = [0x0b, 0x0d, 0x12];
const COL_SAND  = [0xd9, 0xc0, 0x67];
const COL_WATER = [0x3a, 0x7b, 0xd5];
const COL_WALL  = [0x88, 0x88, 0x88];

// =========================================================================
// セルオートマトン本体（PixiJS リファレンスと同一規則・決定的）
// =========================================================================
class Sandbox {
  constructor(cols) { this.setSize(cols); }

  setSize(cols) {
    this.cols = cols;
    this.rows = Math.round(cols * VIEW_H / VIEW_W); // 16:9 を維持
    const n = this.cols * this.rows;
    this.grid = new Uint8Array(n);
    this.tint = new Int8Array(n);
    this.rnd = mulberry32(SIM_SEED);
    this.scanFlip = false;
    this.activeCount = 0;
    this.movedCount = 0;

    this.emitters = [
      { fx: 0.18, w: 3, mat: SAND },
      { fx: 0.38, w: 3, mat: WATER },
      { fx: 0.62, w: 3, mat: SAND },
      { fx: 0.82, w: 3, mat: WATER },
    ];

    this.reset();
  }

  idx(x, y) { return y * this.cols + x; }
  inBounds(x, y) { return x >= 0 && x < this.cols && y >= 0 && y < this.rows; }

  get(x, y) {
    if (!this.inBounds(x, y)) return WALL; // 場外は壁扱い
    return this.grid[this.idx(x, y)];
  }

  setCell(x, y, mat) {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    this.grid[i] = mat;
    if (mat === SAND || mat === WATER) {
      this.tint[i] = (this.rnd() * 48 - 24) | 0;
    } else {
      this.tint[i] = 0;
    }
  }

  reset() {
    const rnd = mulberry32(BUILD_SEED);
    const { cols, rows } = this;
    this.grid.fill(EMPTY);
    this.tint.fill(0);
    this.rnd = mulberry32(SIM_SEED);

    for (let x = 0; x < cols; x++) {
      const h = Math.floor((rows * 0.12) * (0.5 + rnd()));
      for (let k2 = 0; k2 < h; k2++) this.setCell(x, rows - 1 - k2, SAND);
    }

    const wallX = Math.floor(cols * 0.5);
    const wallTop = Math.floor(rows * 0.45);
    const wallBot = rows - 1 - Math.floor(rows * 0.18);
    for (let y = wallTop; y <= wallBot; y++) {
      this.setCell(wallX, y, WALL);
      this.setCell(wallX + 1, y, WALL);
    }

    const pondX0 = Math.floor(cols * 0.08);
    const pondX1 = Math.floor(cols * 0.30);
    const pondTop = rows - 1 - Math.floor(rows * 0.22);
    for (let y = pondTop; y < rows - 1 - Math.floor(rows * 0.12); y++) {
      for (let x = pondX0; x < pondX1; x++) {
        if (this.get(x, y) === EMPTY) this.setCell(x, y, WATER);
      }
    }

    this.scanFlip = false;
    this.recount();
  }

  clear() {
    this.grid.fill(EMPTY);
    this.tint.fill(0);
    this.recount();
  }

  recount() {
    let a = 0;
    const g = this.grid;
    for (let i = 0; i < g.length; i++) if (g[i] !== EMPTY) a++;
    this.activeCount = a;
  }

  emit() {
    const y = 1;
    for (const em of this.emitters) {
      const cx = Math.floor(em.fx * this.cols);
      for (let dx = 0; dx < em.w; dx++) {
        const x = cx + dx;
        if (this.get(x, y) === EMPTY) this.setCell(x, y, em.mat);
      }
    }
  }

  step() {
    this.emit();
    const { cols, rows } = this;
    let moved = 0;
    for (let y = rows - 1; y >= 0; y--) {
      const leftToRight = ((y & 1) === 0) !== this.scanFlip;
      if (leftToRight) {
        for (let x = 0; x < cols; x++) moved += this.updateCell(x, y);
      } else {
        for (let x = cols - 1; x >= 0; x--) moved += this.updateCell(x, y);
      }
    }
    this.scanFlip = !this.scanFlip;
    this.movedCount = moved;
  }

  updateCell(x, y) {
    const mat = this.grid[this.idx(x, y)];
    if (mat === SAND) return this.updateSand(x, y);
    if (mat === WATER) return this.updateWater(x, y);
    return 0;
  }

  moveTo(x, y, nx, ny) {
    const i = this.idx(x, y);
    const j = this.idx(nx, ny);
    this.grid[j] = this.grid[i]; this.tint[j] = this.tint[i];
    this.grid[i] = EMPTY;        this.tint[i] = 0;
  }

  swap(x, y, nx, ny) {
    const i = this.idx(x, y);
    const j = this.idx(nx, ny);
    const gm = this.grid[i], tm = this.tint[i];
    this.grid[i] = this.grid[j]; this.tint[i] = this.tint[j];
    this.grid[j] = gm;           this.tint[j] = tm;
  }

  updateSand(x, y) {
    const below = this.get(x, y + 1);
    if (below === EMPTY) { this.moveTo(x, y, x, y + 1); return 1; }
    if (below === WATER) { this.swap(x, y, x, y + 1); return 1; }
    const first = this.rnd() < 0.5 ? -1 : 1;
    for (const d of [first, -first]) {
      const dn = this.get(x + d, y + 1);
      if (dn === EMPTY) { this.moveTo(x, y, x + d, y + 1); return 1; }
      if (dn === WATER) { this.swap(x, y, x + d, y + 1); return 1; }
    }
    return 0;
  }

  updateWater(x, y) {
    if (this.get(x, y + 1) === EMPTY) { this.moveTo(x, y, x, y + 1); return 1; }
    const first = this.rnd() < 0.5 ? -1 : 1;
    for (const d of [first, -first]) {
      if (this.get(x + d, y + 1) === EMPTY) { this.moveTo(x, y, x + d, y + 1); return 1; }
    }
    for (const d of [first, -first]) {
      if (this.get(x + d, y) === EMPTY) { this.moveTo(x, y, x + d, y); return 1; }
    }
    return 0;
  }

  paint(cx, cy, radius, mat) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx, y = cy + dy;
        if (!this.inBounds(x, y)) continue;
        this.setCell(x, y, mat);
      }
    }
  }
}

// =========================================================================
// テクスチャ書き換え（KAPLAY: ImageData→canvas, Texture.update()）
// =========================================================================
// オフスクリーン canvas に毎フレーム ImageData を書き、KAPLAY 内部の GL
// テクスチャを update() で更新する。loadSprite は初回のみ（テクスチャ再生成は
// 解像度変更時だけ）。
class TexUploader {
  constructor(k) {
    this.k = k;
    this.cols = 0; this.rows = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.imageData = null;
    this.tex = null;     // KAPLAY 内部 Texture (GL テクスチャ)
    this.spriteName = '_sand_tex';
    this.seq = 0;
  }

  // グリッドサイズに合わせて canvas / ImageData / KAPLAY スプライト(テクスチャ)を作り直す。
  async resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.imageData = this.ctx.createImageData(cols, rows);
    // まず空白で埋めてから loadSprite（0除算/空テクスチャを避ける）
    this.ctx.putImageData(this.imageData, 0, 0);

    // 毎リサイズで別名のスプライトとして読み込む（KAPLAY の loadSprite は
    // 同名上書きの保証が曖昧なため、解像度変更ごとに一意名を採用）。
    const name = this.spriteName + (this.seq++);
    this.curName = name;
    const data = await this.k.loadSprite(name, this.canvas);
    // KAPLAY SpriteData -> 内部の Texture を取得（tex.update が GL アップロード）。
    this.tex = (data && data.tex) ? data.tex
             : (data && data.frames ? null : null);
    // 一部バージョンでは SpriteData.tex が直接 Texture。無ければ getSprite から拾う。
    if (!this.tex) {
      const sd = this.k.getSprite ? this.k.getSprite(name) : null;
      const d = sd && sd.data ? sd.data : sd;
      if (d && d.tex) this.tex = d.tex;
    }
    return name;
  }

  // グリッド全セルの色を ImageData に書き、canvas へ putImageData → tex.update()。
  // ★ここが本テーマの“測られる”コスト（COLS×ROWS×4 バイトの生成＋GPU転送）。
  upload(sb) {
    const data = this.imageData.data;
    const grid = sb.grid;
    const tint = sb.tint;
    const n = grid.length;

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const m = grid[i];
      let r, g, b;
      if (m === EMPTY) {
        r = COL_EMPTY[0]; g = COL_EMPTY[1]; b = COL_EMPTY[2];
      } else if (m === SAND) {
        const t = tint[i];
        r = COL_SAND[0] + t; g = COL_SAND[1] + t; b = COL_SAND[2] + (t >> 1);
      } else if (m === WATER) {
        const t = tint[i];
        r = COL_WATER[0] + (t >> 1); g = COL_WATER[1] + (t >> 1); b = COL_WATER[2] + t;
      } else { // WALL
        r = COL_WALL[0]; g = COL_WALL[1]; b = COL_WALL[2];
      }
      data[p]     = r < 0 ? 0 : r > 255 ? 255 : r;
      data[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      data[p + 3] = 255;
    }

    this.ctx.putImageData(this.imageData, 0, 0);
    // ★ GPU へ再アップロード（測定対象）。KAPLAY 内部 GL テクスチャを直接更新。
    if (this.tex && typeof this.tex.update === 'function') {
      this.tex.update(this.canvas, 0, 0);
    }
  }
}

// === KAPLAY 初期化 ==========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: [0x0b, 0x0d, 0x12],
  texFilter: 'nearest',      // 拡大時にドットがくっきり（ニアレスト）
  crisp: true,
  global: false,             // 名前空間 k.* を明示利用
});

(async function main() {
  let sb = new Sandbox(COLS_INIT);
  const uploader = new TexUploader(k);
  let spriteName = await uploader.resize(sb.cols, sb.rows);
  uploader.upload(sb);

  // 表示スプライト（テクスチャを 960x540 へニアレスト拡大）。
  let view = k.add([
    k.sprite(spriteName),
    k.pos(0, 0),
    k.anchor('topleft'),
  ]);
  view.width = VIEW_W; view.height = VIEW_H;

  // 解像度変更時: 状態を作り直し、テクスチャ/スプライトを差し替える。
  async function rebuildAt(cols) {
    sb.setSize(cols);
    spriteName = await uploader.resize(sb.cols, sb.rows);
    uploader.upload(sb);
    k.destroy(view);
    view = k.add([k.sprite(spriteName), k.pos(0, 0), k.anchor('topleft')]);
    view.width = VIEW_W; view.height = VIEW_H;
  }

  // ---- ブラシ ----
  let brushMat = SAND;
  const BRUSH_RADIUS = 3;

  // 画面座標 → セル座標。KAPLAY のマウス座標は画面座標とそのまま一致。
  function toCell(mp) {
    const sx = clamp(mp.x / VIEW_W, 0, 0.9999);
    const sy = clamp(mp.y / VIEW_H, 0, 0.9999);
    return { x: Math.floor(sx * sb.cols), y: Math.floor(sy * sb.rows) };
  }
  function paintLine(a, b, mat) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const steps = Math.max(1, Math.floor(Math.hypot(dx, dy)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      sb.paint(Math.round(a.x + dx * t), Math.round(a.y + dy * t), BRUSH_RADIUS, mat);
    }
  }

  // 右クリックメニュー抑止（消去ドラッグ用）。
  const cvs = document.getElementById('game-canvas');
  cvs.addEventListener('contextmenu', (e) => e.preventDefault());

  let lastCell = null;
  k.onMousePress((btn) => {
    const c = toCell(k.mousePos());
    const erase = (btn === 'right');
    sb.paint(c.x, c.y, BRUSH_RADIUS, erase ? EMPTY : brushMat);
    lastCell = c;
  });
  k.onMouseMove(() => {
    if (!(k.isMouseDown('left') || k.isMouseDown('right'))) { lastCell = null; return; }
    const erase = k.isMouseDown('right');
    const c = toCell(k.mousePos());
    paintLine(lastCell || c, c, erase ? EMPTY : brushMat);
    lastCell = c;
  });
  k.onMouseRelease(() => { lastCell = null; });

  // ---- キーボード入力 ----
  k.onKeyPress('1', () => { brushMat = SAND; });
  k.onKeyPress('2', () => { brushMat = WATER; });
  k.onKeyPress('3', () => { brushMat = WALL; });
  k.onKeyPress('c', () => { sb.clear(); });
  k.onKeyPress('r', () => { sb.reset(); });
  k.onKeyPress(['=', 'kpadd'], () => { rebuildAt(clamp(sb.cols + COLS_STEP, COLS_MIN, COLS_MAX)); });
  k.onKeyPress(['minus', 'kpsubtract'], () => { rebuildAt(clamp(sb.cols - COLS_STEP, COLS_MIN, COLS_MAX)); });

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  const fpsSamples = [];
  let hudTimer = 0;

  k.onUpdate(() => {
    const dt = k.dt();
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // 1) セルオートマトン更新（固定1ステップ）
    sb.step();
    // 2) 全面テクスチャ書き換え ＋ アップロード（★ 本テーマの核）
    uploader.upload(sb);

    // 3) HUD（約120msごと更新）
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      sb.recount();
      const cells = sb.cols * sb.rows;
      const kb = (cells * 4 / 1024).toFixed(0);
      hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Grid   : ${sb.cols} x ${sb.rows} = ${cells} cells\n` +
        `Active : ${sb.activeCount}  (moved/frame: ${sb.movedCount})\n` +
        `Brush  : ${MAT_NAME[brushMat]}\n` +
        `Upload : ImageData->canvas, Texture.update() (${kb} KB/frame)`;
    }
  });

  console.log('[KAPLAY 3001] theme12 falling-sand init ok.');
})();
