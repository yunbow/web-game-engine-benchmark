/* =========================================================================
 * テーマ12 フォーリングサンド / セルオートマトン（動的テクスチャ書き換え）
 *   ― A-Frame (1.7.0) 実装
 * 仕様: SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *
 * A-Frame は three.js 上の宣言的（entity-component）フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `sand-game` コンポーネントが駆動する（A-Frame の renderer / tick ループ /
 * カメラ管理を利用）。内部 three.js は AFRAME.THREE。
 *
 * A-Frame での“素直な”テクスチャ更新機構（＝これ自体が比較対象）:
 *   - グリッドサイズ COLS×ROWS の THREE.DataTexture（RGBA Uint8）を 1枚用意。
 *   - 毎フレーム tick 内で image.data へ全セルの色を書き込み、
 *     texture.needsUpdate = true で GPU へ再アップロードする（測定対象）。
 *   - magFilter/minFilter = NearestFilter（拡大時もドットがくっきり）。
 *   - 全画面の板（PlaneGeometry）に貼り、2D 用 OrthographicCamera(0,W,H,0)
 *     で 960x540 に合わせてニアレスト拡大表示する。
 *
 * → 機構文字列: "DataTexture + needsUpdate"
 *
 * シミュレーションは flat な Uint8Array グリッド（COLS×ROWS）で保持し、
 * Math.random は不使用（必要な乱択は mulberry32 で決定的に行う）。
 * =========================================================================*/

const THREE = AFRAME.THREE;

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
      for (let k = 0; k < h; k++) this.setCell(x, rows - 1 - k, SAND);
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
    if (below === WATER) { this.swap(x, y, x, y + 1); return 1; }   // 砂が水に沈む
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
// テクスチャ書き換え（A-Frame: DataTexture + needsUpdate / AFRAME.THREE）
// =========================================================================
// COLS×ROWS の DataTexture（RGBA Uint8）を持ち、毎フレーム image.data に
// 全セルの色を書いて needsUpdate=true で GPU 転送する。
// 注意（座標系）: DataTexture は最下行が UV の v=0（下端）に対応するため、
// 書き込み時に行を上下反転して、シムの上端が画面の上端に来るようにする。
class TexUploader {
  constructor() {
    this.cols = 0; this.rows = 0;
    this.buffer = null;
    this.texture = null;
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.buffer = new Uint8Array(cols * rows * 4);
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.DataTexture(this.buffer, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
  }

  // ★ここが本テーマの“測られる”コスト（COLS×ROWS×4 バイトの生成＋GPU転送）。
  upload(sb) {
    const data = this.buffer;
    const grid = sb.grid;
    const tint = sb.tint;
    const cols = this.cols, rows = this.rows;

    for (let y = 0; y < rows; y++) {
      const srcRow = y * cols;
      const dstRow = (rows - 1 - y) * cols;
      for (let x = 0; x < cols; x++) {
        const i = srcRow + x;
        let p = (dstRow + x) * 4;
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
    }

    this.texture.needsUpdate = true; // ← GPU へ再アップロード（測定対象）
  }
}

// === sand-game コンポーネント =============================================
AFRAME.registerComponent('sand-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera を用意（tick で sceneEl.camera を維持）。
    this.cam = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1); // DPR=1 固定
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    // シム + アップローダ
    this.sb = new Sandbox(COLS_INIT);
    this.uploader = new TexUploader();
    this.uploader.resize(this.sb.cols, this.sb.rows);
    this.uploader.upload(this.sb);

    // 全画面の板（COLS×ROWS テクスチャを 960x540 へニアレスト拡大）。
    this.quadMat = new THREE.MeshBasicMaterial({ map: this.uploader.texture, depthTest: false });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(VIEW_W, VIEW_H), this.quadMat);
    this.quad.position.set(VIEW_W / 2, VIEW_H / 2, 0);
    this.group.add(this.quad);

    // ブラシ状態
    this.brushMat = SAND;
    this.BRUSH_RADIUS = 3;
    this.pointerDown = false;
    this.eraseMode = false;
    this.lastCell = null;

    // 入力（ポインタ: 左ドラッグ=描画 / 右ドラッグ=消去）。
    const cvs = sceneEl.canvas || (sceneEl.renderer && sceneEl.renderer.domElement);
    this.canvas = cvs;
    this.bindInput(cvs);

    this.fpsSamples = [];
    this.hudTimer = 0;
  },

  // canvas が tick 開始時にまだ無い場合に備え、見つかり次第バインドする。
  bindInput(cvs) {
    if (!cvs || this._bound) {
      if (!cvs) return;
    }
    this._bound = true;
    cvs.addEventListener('contextmenu', (e) => e.preventDefault());
    cvs.addEventListener('pointerdown', (e) => {
      this.pointerDown = true;
      this.eraseMode = (e.button === 2);
      const c = this.toCell(e);
      this.sb.paint(c.x, c.y, this.BRUSH_RADIUS, this.eraseMode ? EMPTY : this.brushMat);
      this.lastCell = c;
      if (cvs.setPointerCapture) cvs.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    cvs.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) return;
      const c = this.toCell(e);
      this.paintLine(this.lastCell || c, c, this.eraseMode ? EMPTY : this.brushMat);
      this.lastCell = c;
    });
    const endPointer = () => { this.pointerDown = false; this.lastCell = null; };
    cvs.addEventListener('pointerup', endPointer);
    cvs.addEventListener('pointercancel', endPointer);

    window.addEventListener('keydown', (e) => {
      switch (e.key) {
        case '1': this.brushMat = SAND;  break;
        case '2': this.brushMat = WATER; break;
        case '3': this.brushMat = WALL;  break;
        case 'c': case 'C': this.sb.clear(); break;
        case 'r': case 'R': this.sb.reset(); break;
        default: break;
      }
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
        this.rebuildAt(clamp(this.sb.cols + COLS_STEP, COLS_MIN, COLS_MAX));
        e.preventDefault();
      } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
        this.rebuildAt(clamp(this.sb.cols - COLS_STEP, COLS_MIN, COLS_MAX));
        e.preventDefault();
      }
    });
  },

  // 解像度変更: 状態を作り直し、テクスチャを差し替える。
  rebuildAt(cols) {
    this.sb.setSize(cols);
    this.uploader.resize(this.sb.cols, this.sb.rows);
    this.uploader.upload(this.sb);
    this.quadMat.map = this.uploader.texture;
    this.quadMat.needsUpdate = true;
  },

  // 画面座標 → セル座標。canvas は CSS 縮小されうるので比率換算する。
  toCell(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) / rect.width;
    const sy = (ev.clientY - rect.top) / rect.height;
    return {
      x: Math.floor(clamp(sx, 0, 0.9999) * this.sb.cols),
      y: Math.floor(clamp(sy, 0, 0.9999) * this.sb.rows),
    };
  },
  paintLine(a, b, m) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const steps = Math.max(1, Math.floor(Math.hypot(dx, dy)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.sb.paint(Math.round(a.x + dx * t), Math.round(a.y + dy * t), this.BRUSH_RADIUS, m);
    }
  },

  tick(time, dtMs) {
    // カメラを 2D 用に維持（A-Frame が別カメラを差し込んでも上書き）。
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;
    // canvas が遅れて生成された場合の遅延バインド。
    if (!this._bound) {
      const cvs = this.el.sceneEl.canvas || (this.el.sceneEl.renderer && this.el.sceneEl.renderer.domElement);
      if (cvs) { this.canvas = cvs; this.bindInput(cvs); }
    }

    dtMs = Math.min(dtMs || 16.7, 50); // タブ復帰時の暴発抑制
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    // 1) セルオートマトン更新（固定1ステップ）
    this.sb.step();
    // 2) 全面テクスチャ書き換え ＋ アップロード（★ 本テーマの核）
    this.uploader.upload(this.sb);

    // 3) HUD（約120msごと更新）
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      this.sb.recount();
      const cells = this.sb.cols * this.sb.rows;
      const kb = (cells * 4 / 1024).toFixed(0);
      this.hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Grid   : ${this.sb.cols} x ${this.sb.rows} = ${cells} cells\n` +
        `Active : ${this.sb.activeCount}  (moved/frame: ${this.sb.movedCount})\n` +
        `Brush  : ${MAT_NAME[this.brushMat]}\n` +
        `Upload : DataTexture + needsUpdate  (${kb} KB/frame)`;
    }
  },
});

console.log('A-Frame theme12 falling-sand component registered.');
