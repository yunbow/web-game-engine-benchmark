/* =========================================================================
 * テーマ12 フォーリングサンド / セルオートマトン（動的テクスチャ書き換え）
 *   ― PixiJS v8 実装
 * 仕様: SPEC.md
 *
 * 本テーマのベンチ軸は「グリッドセルのシミュレーション更新 ＋ 毎フレームの
 * 全面テクスチャ書き換え（CPUピクセルバッファ → GPUアップロード）」。
 *
 * PixiJS v8 での“素直な”テクスチャ更新機構（＝これ自体が比較対象）:
 *   - オフスクリーン <canvas>（COLS×ROWS）を 1枚用意し、その 2D コンテキストの
 *     ImageData(=RGBA Uint8ClampedArray) に毎フレーム全セルの色を書き込む。
 *   - ctx.putImageData(imageData, 0, 0) で canvas へ反映。
 *   - その canvas を PIXI.Texture.from(canvas) でテクスチャ化し、
 *     texture.source.scaleMode = 'nearest'（ドットがくっきり拡大される）。
 *   - 毎フレーム texture.source.update() で GPU へ再アップロード。
 *   - Sprite を 960x540 へ拡大（setSize）して全画面表示。
 *
 * → 機構文字列: "ImageData→canvas Texture, source.update()"
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
//   砂   = 砂色 #d9c067 系（決定的な濃淡）
//   水   = 青   #3a7bd5 系
//   壁   = 灰   #888
//   空気 = 背景暗色 #0b0d12
// 砂・水はセルごとに濃淡を持たせて堆積が見やすくする。濃淡はセルの初期化時に
// 決定的に焼き込む（後述の tintGrid）。基準色は以下。
const COL_EMPTY = [0x0b, 0x0d, 0x12];
const COL_SAND  = [0xd9, 0xc0, 0x67];
const COL_WATER = [0x3a, 0x7b, 0xd5];
const COL_WALL  = [0x88, 0x88, 0x88];

// =========================================================================
// セルオートマトン本体
//   grid[]  : Uint8Array  各セルの素材（EMPTY/SAND/WATER/WALL）
//   tint[]  : Int8Array   各セルの濃淡オフセット（-面白み用, 決定的）
// =========================================================================
class Sandbox {
  constructor(cols) {
    this.setSize(cols);
  }

  // グリッドサイズを設定（COLS から ROWS を算出）し、バッファを確保する。
  setSize(cols) {
    this.cols = cols;
    this.rows = Math.round(cols * VIEW_H / VIEW_W); // 16:9 を維持
    const n = this.cols * this.rows;
    this.grid = new Uint8Array(n);
    this.tint = new Int8Array(n);     // 濃淡（描画用の決定的ノイズ）
    this.rnd = mulberry32(SIM_SEED);  // シミュレーション用 PRNG
    this.scanFlip = false;            // 行ごとに左右交互スキャンする位相
    this.activeCount = 0;             // 直近フレームの「空気以外」セル数
    this.movedCount = 0;              // 直近フレームで移動したセル数

    // エミッタ（上部・決定的）。比率で配置して解像度変更でも相対位置を維持。
    //   x は COLS に対する比率、material と幅をもつ。
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

  // 場外は壁扱い（落下が下端・側端で止まる）。
  get(x, y) {
    if (!this.inBounds(x, y)) return WALL;
    return this.grid[this.idx(x, y)];
  }

  // セルへ素材を置く（濃淡を決定的に焼き込む）。
  setCell(x, y, mat) {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    this.grid[i] = mat;
    // 濃淡: 砂/水のときのみ -24..+24 程度のオフセットを決定的に付与。
    if (mat === SAND || mat === WATER) {
      this.tint[i] = (this.rnd() * 48 - 24) | 0;
    } else {
      this.tint[i] = 0;
    }
  }

  // ---- 初期状態（決定的） -------------------------------------------------
  // SPEC: グリッドを変えたら状態は決定的に作り直す。
  //   底に砂をやや堆積、中央に壁の仕切り、左右に水だまりを置く決定的レイアウト。
  reset() {
    const rnd = mulberry32(BUILD_SEED);
    const { cols, rows } = this;
    this.grid.fill(EMPTY);
    this.tint.fill(0);
    this.rnd = mulberry32(SIM_SEED);

    // 底付近に砂の堆積（高さは列ごとに決定的に変動）
    for (let x = 0; x < cols; x++) {
      const h = Math.floor((rows * 0.12) * (0.5 + rnd()));
      for (let k = 0; k < h; k++) {
        this.setCell(x, rows - 1 - k, SAND);
      }
    }

    // 中央付近に壁の柱（落下物を左右に振り分ける仕切り）
    const wallX = Math.floor(cols * 0.5);
    const wallTop = Math.floor(rows * 0.45);
    const wallBot = rows - 1 - Math.floor(rows * 0.18);
    for (let y = wallTop; y <= wallBot; y++) {
      this.setCell(wallX, y, WALL);
      this.setCell(wallX + 1, y, WALL);
    }

    // 床際に水だまり（左寄り）
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

  // 全消去（エミッタは残す＝構造だけ消す）。
  clear() {
    this.grid.fill(EMPTY);
    this.tint.fill(0);
    this.recount();
  }

  // 「空気以外」セル数を数え直す（HUD 用）。
  recount() {
    let a = 0;
    const g = this.grid;
    for (let i = 0; i < g.length; i++) if (g[i] !== EMPTY) a++;
    this.activeCount = a;
  }

  // ---- エミッタ供給（無入力でもベンチが回る） ----------------------------
  // 上部の決定的位置から毎フレーム少量を供給する。降り口が埋まっていれば供給しない。
  emit() {
    const y = 1; // 最上段の少し下から供給
    for (const em of this.emitters) {
      const cx = Math.floor(em.fx * this.cols);
      for (let dx = 0; dx < em.w; dx++) {
        const x = cx + dx;
        if (this.get(x, y) === EMPTY) this.setCell(x, y, em.mat);
      }
    }
  }

  // ---- 1 ステップ更新（決定的） ------------------------------------------
  // 走査順: 下の行から上へ。各行は左右交互スキャン（行ごと＋フレームごとに位相反転）
  // にして偏りを抑える。Math.random 不使用。
  step() {
    this.emit();
    const { cols, rows } = this;
    let moved = 0;

    for (let y = rows - 1; y >= 0; y--) {
      // 行ごとに左右方向を交互に。さらにフレーム位相 scanFlip でも反転。
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

  // 1 セルの更新。戻り値 1=移動した / 0=動かず。
  updateCell(x, y) {
    const mat = this.grid[this.idx(x, y)];
    if (mat === SAND) return this.updateSand(x, y);
    if (mat === WATER) return this.updateWater(x, y);
    return 0; // EMPTY / WALL は不動
  }

  // セル (x,y) の素材を (nx,ny) へ移動。tint も一緒に運ぶ。
  moveTo(x, y, nx, ny) {
    const i = this.idx(x, y);
    const j = this.idx(nx, ny);
    this.grid[j] = this.grid[i]; this.tint[j] = this.tint[i];
    this.grid[i] = EMPTY;        this.tint[i] = 0;
  }

  // セル (x,y) と (nx,ny) を入れ替える（砂が水に沈むとき用）。
  swap(x, y, nx, ny) {
    const i = this.idx(x, y);
    const j = this.idx(nx, ny);
    const gm = this.grid[i], tm = this.tint[i];
    this.grid[i] = this.grid[j]; this.tint[i] = this.tint[j];
    this.grid[j] = gm;           this.tint[j] = tm;
  }

  // 砂: 真下が空/水なら落下。塞がれていれば左下・右下（決定的選択）。水とは入れ替わる。
  updateSand(x, y) {
    const below = this.get(x, y + 1);
    if (below === EMPTY) { this.moveTo(x, y, x, y + 1); return 1; }
    if (below === WATER) { this.swap(x, y, x, y + 1); return 1; }   // 砂が水に沈む

    // 左右どちらを先に試すか決定的に選ぶ（PRNG）。
    const first = this.rnd() < 0.5 ? -1 : 1;
    for (const d of [first, -first]) {
      const dn = this.get(x + d, y + 1);
      if (dn === EMPTY) { this.moveTo(x, y, x + d, y + 1); return 1; }
      if (dn === WATER) { this.swap(x, y, x + d, y + 1); return 1; }
    }
    return 0;
  }

  // 水: 真下が空なら落下。塞がれていれば左下・右下、それも塞がれていれば左右へ広がる。
  updateWater(x, y) {
    if (this.get(x, y + 1) === EMPTY) { this.moveTo(x, y, x, y + 1); return 1; }

    const first = this.rnd() < 0.5 ? -1 : 1;
    // 斜め下
    for (const d of [first, -first]) {
      if (this.get(x + d, y + 1) === EMPTY) { this.moveTo(x, y, x + d, y + 1); return 1; }
    }
    // 横へ広がる
    for (const d of [first, -first]) {
      if (this.get(x + d, y) === EMPTY) { this.moveTo(x, y, x + d, y); return 1; }
    }
    return 0;
  }

  // ---- ブラシ描画（円形） -------------------------------------------------
  paint(cx, cy, radius, mat) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx, y = cy + dy;
        if (!this.inBounds(x, y)) continue;
        // 壁は上書き可。消去(EMPTY)は無条件。
        this.setCell(x, y, mat);
      }
    }
  }
}

// =========================================================================
// テクスチャ書き換え（PixiJS v8: ImageData→canvas Texture, source.update()）
// =========================================================================
class TexUploader {
  constructor() {
    this.cols = 0; this.rows = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.imageData = null;
    this.texture = null;
  }

  // グリッドサイズに合わせて canvas / ImageData / Texture を作り直す。
  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.imageData = this.ctx.createImageData(cols, rows);

    // 旧テクスチャを破棄して張り替え。
    if (this.texture) this.texture.destroy(true);
    // v8: canvas をソースにテクスチャ化。拡大時のドット感のため nearest。
    this.texture = PIXI.Texture.from(this.canvas);
    this.texture.source.scaleMode = 'nearest';
    // canvas 由来ソースはオートアップロードしないので毎フレーム手動 update。
    this.texture.source.autoGenerateMipmaps = false;
  }

  // グリッド全セルの色を ImageData に書き、canvas へ putImageData → source.update()。
  // ★ここが本テーマの“測られる”コスト（COLS×ROWS×4 バイトの生成＋GPU転送）。
  upload(sb) {
    const data = this.imageData.data; // Uint8ClampedArray (RGBA)
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
      data[p + 3] = 255; // 不透明（水も拡大表示上は不透明色で）
    }

    this.ctx.putImageData(this.imageData, 0, 0);
    this.texture.source.update(); // ← GPU へ再アップロード（測定対象）
  }
}

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須。
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: 0x0b0d12,
    antialias: false,
    resolution: 1,        // 性能比較用途のため 1 固定
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  // ---- シミュレーション + アップローダ ----
  let sb = new Sandbox(COLS_INIT);
  const uploader = new TexUploader();
  uploader.resize(sb.cols, sb.rows);

  // ---- 表示スプライト（テクスチャを 960x540 へ拡大） ----
  const sprite = new PIXI.Sprite(uploader.texture);
  sprite.setSize(VIEW_W, VIEW_H); // COLS×ROWS テクスチャを全画面へニアレスト拡大
  app.stage.addChild(sprite);

  // 解像度変更時にスプライトのテクスチャを差し替える。
  function rebuildAt(cols) {
    sb.setSize(cols);                  // 状態を決定的に作り直す
    uploader.resize(sb.cols, sb.rows); // canvas/ImageData/Texture を作り直す
    sprite.texture = uploader.texture;
    sprite.setSize(VIEW_W, VIEW_H);
  }

  // ---- ブラシ ----
  let brushMat = SAND;          // 既定ブラシ素材
  const BRUSH_RADIUS = 3;       // ブラシ半径（セル）

  // ---- ポインタ入力（app.canvas 上の pointer events） ----
  // 左ドラッグ=描画 / 右ドラッグ=消去。contextmenu は抑止。
  let pointerDown = false;
  let eraseMode = false;        // 右ボタン時 true
  let lastCell = null;          // 直近のセル座標（ドラッグ補間用）

  // 画面座標 → セル座標。canvas は CSS で縮小表示されうるので比率換算する。
  function toCell(ev) {
    const rect = app.canvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) / rect.width;
    const sy = (ev.clientY - rect.top) / rect.height;
    const x = Math.floor(clamp(sx, 0, 0.9999) * sb.cols);
    const y = Math.floor(clamp(sy, 0, 0.9999) * sb.rows);
    return { x, y };
  }

  // ブラシを (a→b) 間で補間しながら塗る（速いドラッグでも線が途切れない）。
  function paintLine(a, b, mat) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const steps = Math.max(1, Math.floor(Math.hypot(dx, dy)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      sb.paint(Math.round(a.x + dx * t), Math.round(a.y + dy * t), BRUSH_RADIUS, mat);
    }
  }

  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  app.canvas.addEventListener('pointerdown', (e) => {
    pointerDown = true;
    eraseMode = (e.button === 2); // 右ボタン=消去
    const c = toCell(e);
    sb.paint(c.x, c.y, BRUSH_RADIUS, eraseMode ? EMPTY : brushMat);
    lastCell = c;
    app.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  app.canvas.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    const c = toCell(e);
    paintLine(lastCell || c, c, eraseMode ? EMPTY : brushMat);
    lastCell = c;
  });
  const endPointer = () => { pointerDown = false; lastCell = null; };
  app.canvas.addEventListener('pointerup', endPointer);
  app.canvas.addEventListener('pointercancel', endPointer);

  // ---- キーボード入力 ----
  window.addEventListener('keydown', (e) => {
    switch (e.key) {
      case '1': brushMat = SAND;  break;
      case '2': brushMat = WATER; break;
      case '3': brushMat = WALL;  break;
      case 'c': case 'C': sb.clear(); break;
      case 'r': case 'R': sb.reset(); break;
      default: break;
    }
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      rebuildAt(clamp(sb.cols + COLS_STEP, COLS_MIN, COLS_MAX));
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      rebuildAt(clamp(sb.cols - COLS_STEP, COLS_MIN, COLS_MAX));
      e.preventDefault();
    }
  });

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // ---- メインループ ----
  // デルタタイム基準だが、シミュレーションは固定タイムステップ（毎フレーム1ステップ）。
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;

    // FPS 移動平均（直近60フレーム）
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // 1) セルオートマトン更新（固定1ステップ）
    sb.step();
    // step 内で活性セル数は厳密には数えないため、HUD 更新時に概算。
    // （movedCount は step が返す正確な移動数）

    // 2) 全面テクスチャ書き換え ＋ アップロード（★ 本テーマの核）
    uploader.upload(sb);

    // 3) HUD（約120msごと更新）
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      sb.recount(); // 「空気以外」セル数を再計算（HUD 表示用）
      const cells = sb.cols * sb.rows;
      const bytes = cells * 4;
      const kb = (bytes / 1024).toFixed(0);
      hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Grid   : ${sb.cols} x ${sb.rows} = ${cells} cells\n` +
        `Active : ${sb.activeCount}  (moved/frame: ${sb.movedCount})\n` +
        `Brush  : ${MAT_NAME[brushMat]}\n` +
        `Upload : ImageData→canvas Texture, source.update()  (${kb} KB/frame)`;
    }
  });

  // three.js 版に合わせ、キャンバスは 960x540 固定（縮小スケールなし）。
  console.log('[PixiJS v8] theme12 falling-sand init ok. renderer =', app.renderer.type);
})();
