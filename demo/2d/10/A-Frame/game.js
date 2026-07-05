/* ============================================================================
 * テーマ10 マッチ3パズル（ロジック主体・大量トゥイーン）― A-Frame (1.7.0) 実装
 * 仕様: SPEC.md (960x540, NxN 盤面, 6 種宝石, 状態機械 IDLE/SWAP/CLEAR/FALL)
 * 参照: 10/three.js/game.js （定数・マッチ判定・落下/消滅・オートプレイを厳密一致）
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `match3-game` コンポーネントが駆動する (A-Frame の renderer / tick ループ /
 * カメラ管理を利用)。内部 three.js は AFRAME.THREE。
 *
 * 設計判断: 盤面は最大 40x40 = 1600 セル。「1セル = 1 <a-entity>」だと DOM /
 * コンポーネント生成コストで FPS が破綻する。そこで宝石は THREE.Sprite を
 * コンポーネント内で直接生成・プールして再利用する (毎フレーム再生成しない)。
 * カメラは 2D 用に OrthographicCamera(0, W, H, 0, -1000, 1000) へ差し替え、
 * tick で sceneEl.camera として維持する (原点左下・Y上向き)。ゲームロジックは
 * 画面座標(Y下向き)で保持し、描画同期時のみ worldY = H - gameY に変換する。
 *
 *   ★ 本テーマの比較対象 = 「トゥイーン機構」 ★
 *   A-Frame / three.js には組込みトゥイーンが無い (A-Frame の animation
 *   コンポーネントは entity 単位で本テーマの大量セル単位トゥイーンには不向き)。
 *   そこで Pixi/Babylon/LittleJS/three.js と同じく、進行中トゥイーンを配列で
 *   保持し毎フレーム dt でイージング補間する自前マネージャ (makeTweenManager)
 *   を実装する。トゥイーンは論理 gem の {x,y,size,alpha} を動かし、毎フレーム
 *   末にそれを THREE.Sprite へ反映する。HUD の "Active tweens" がそのまま負荷
 *   指標 (落下/消滅が同時多発するほど増える)。
 * ========================================================================== */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC / three.js 参照に一致) -------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const N_INIT = 12;
const N_STEP = 2;
const N_MIN = 6;
const N_MAX = 40;
const BOARD_SPAN = 520;
const CELL_MAX = 56;

const GEM_TYPES = 6;

const SWAP_TIME = 0.15;
const CLEAR_TIME = 0.2;
const FALL_PER_CELL = 0.2;
const AUTO_INTERVAL = 0.25;

const SCORE_PER_GEM = 10;

const SEED_BOARD = 20250615;
const SEED_REFILL = 99173;
const SEED_SHUFFLE = 51237;

const S_IDLE = 'IDLE', S_SWAP = 'SWAP', S_CLEAR = 'CLEAR', S_FALL = 'FALL';

const GEM_COLORS = ['#e2453b', '#3b82e2', '#49c463', '#f2cf3c', '#a657e2', '#e8edf5'];
const GEM_KEYS = ['red', 'blue', 'green', 'yellow', 'purple', 'white'];

const COLOR_BG = 0x0d1322;
const COLOR_BOARD = '#18223a';
const COLOR_SELECT = 0xfff2a8;

const RO = { board: 0, sel: 1, gem: 2 }; // renderOrder

// ---- 決定的擬似乱数 (mulberry32) -------------------------------------------
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

const easeLinear  = (t) => t;
const easeOutQuad = (t) => t * (2 - t);
const easeInQuad  = (t) => t * t;

// ============================================================================
// 自前トゥイーンマネージャ (★本テーマの比較対象, three.js 版と同一)
// ============================================================================
function makeTweenManager() {
  const tweens = [];
  const completedThisFrame = [];
  function add(spec) {
    const props = {};
    for (const key in spec.props) props[key] = { from: spec.target[key], to: spec.props[key] };
    const tw = {
      target: spec.target, props,
      dur: Math.max(spec.duration, 0.0001), t: 0,
      ease: spec.ease || easeLinear, onComplete: spec.onComplete || null,
    };
    tweens.push(tw);
    return tw;
  }
  function update(dt) {
    completedThisFrame.length = 0;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      tw.t += dt;
      let k = tw.t / tw.dur;
      let done = false;
      if (k >= 1) { k = 1; done = true; }
      const e = tw.ease(k);
      for (const key in tw.props) {
        const p = tw.props[key];
        tw.target[key] = p.from + (p.to - p.from) * e;
      }
      if (done) { tweens.splice(i, 1); if (tw.onComplete) completedThisFrame.push(tw.onComplete); }
    }
    for (let i = 0; i < completedThisFrame.length; i++) completedThisFrame[i]();
  }
  function clear() { tweens.length = 0; }
  const count = () => tweens.length;
  return { add, update, clear, count };
}

// ============================================================================
// テクスチャ (画像 or canvas フォールバック)
// ============================================================================
const GEM_TEX_PX = 64;
const fbCache = {};
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  fbCache[name] = t;
  return t;
}
function fbGem(i) {
  return canvasTexture('gem' + i, GEM_TEX_PX, GEM_TEX_PX, (g) => {
    const col = GEM_COLORS[i], m = 6, s = GEM_TEX_PX - m * 2;
    if (i % 2 === 0) {
      // 角丸四角タイプ
      roundRect(g, m, m, s, s, 12); g.fillStyle = col; g.fill();
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke();
      roundRect(g, m + 8, m + 8, s * 0.4, s * 0.28, 6); g.fillStyle = 'rgba(255,255,255,0.35)'; g.fill();
    } else {
      // 丸タイプ
      const r = s / 2, cx = GEM_TEX_PX / 2, cy = GEM_TEX_PX / 2;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = col; g.fill();
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke();
      g.beginPath(); g.ellipse(cx - 6, cy - 8, r * 0.42, r * 0.28, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.4)'; g.fill();
    }
  });
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const ASSET_DEFS = {
  gem_red:    '../assets/gem_red.png',
  gem_blue:   '../assets/gem_blue.png',
  gem_green:  '../assets/gem_green.png',
  gem_yellow: '../assets/gem_yellow.png',
  gem_purple: '../assets/gem_purple.png',
  gem_white:  '../assets/gem_white.png',
  bg_board:   '../assets/bg_board.png',
};

// ============================================================================
// match3-game コンポーネント (ゲーム本体)
// ============================================================================
AFRAME.registerComponent('match3-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.sceneEl = sceneEl;
    this.scene3D = this.el.object3D; // 宝石/盤面はこの object3D へ add する
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera を用意 (tick で sceneEl.camera を維持)
    this.cam = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1); // DPR=1 固定
      if (sceneEl.object3D && sceneEl.object3D.background === undefined) {
        sceneEl.object3D.background = new THREE.Color(COLOR_BG);
      }
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    this.ready = false;
    this.tex = {};
    this.tweenMgr = makeTweenManager();

    // FPS / HUD
    this.fpsSamples = [];
    this.hudTimer = 0;

    // 入力ハンドラ登録
    this.bindInput();

    // アセット読み込み → 構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  // ------------------------------------------------------------------
  // 構築
  // ------------------------------------------------------------------
  build() {
    // 宝石テクスチャ (画像 or フォールバック) を種別ごとに確定。
    this.gemTex = GEM_KEYS.map((kk, i) => this.tex['gem_' + kk] || fbGem(i));

    // ---- 状態 ----
    this.N = N_INIT;
    this.cell = 0; this.originX = 0; this.originY = 0;
    this.grid = [];
    this.gems = [];
    this.spritePool = [];

    this.state = S_IDLE;
    this.chain = 0; this.score = 0; this.moves = 0;
    this.auto = true; this.autoTimer = 0; this.shuffleCount = 0;
    this.sel = null;
    this.pendingSwap = null;
    this.started = false; this.blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
    this.titleEl = document.getElementById('title');

    this.boardMesh = null;

    // ---- 選択ハイライト (Line 矩形) ----
    const selGeo = new THREE.BufferGeometry();
    selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3));
    this.selLine = new THREE.Line(selGeo, new THREE.LineBasicMaterial({ color: COLOR_SELECT, depthTest: false }));
    this.selLine.renderOrder = RO.sel;
    this.selLine.visible = false;
    this.scene3D.add(this.selLine);

    this.buildBoard();
    this.ready = true;
  },

  // ------------------------------------------------------------------
  // スプライト / gem プール
  // ------------------------------------------------------------------
  getSprite() {
    let s = this.spritePool.pop();
    if (!s) {
      const mat = new THREE.SpriteMaterial({ map: this.gemTex[0], transparent: true, depthTest: false });
      s = new THREE.Sprite(mat);
      s.renderOrder = RO.gem;
      this.scene3D.add(s);
    }
    s.visible = true;
    s.material.opacity = 1;
    return s;
  },
  releaseSprite(s) { if (s) { s.visible = false; this.spritePool.push(s); } },
  getGem() { return { kind: 0, x: 0, y: 0, size: 0, alpha: 1, sprite: this.getSprite() }; },
  releaseGem(g) { if (g) { this.releaseSprite(g.sprite); g.sprite = null; } },

  ensureBoardMesh() {
    if (this.boardMesh) return;
    const mat = this.tex.bg_board
      ? new THREE.MeshBasicMaterial({ map: this.tex.bg_board, depthTest: false, transparent: true })
      : new THREE.MeshBasicMaterial({ color: new THREE.Color(COLOR_BOARD), depthTest: false });
    this.boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.boardMesh.renderOrder = RO.board;
    this.scene3D.add(this.boardMesh);
  },

  computeLayout() {
    const N = this.N;
    this.cell = Math.floor(Math.min(BOARD_SPAN / N, CELL_MAX));
    const boardPx = this.cell * N;
    this.originX = Math.floor((VIEW_W - boardPx) / 2);
    this.originY = Math.floor((VIEW_H - boardPx) / 2);
    this.ensureBoardMesh();
    const pad = Math.max(8, Math.floor(this.cell * 0.18));
    const w = boardPx + pad * 2, h = boardPx + pad * 2;
    const cx = this.originX - pad + w / 2;
    const cyScreen = this.originY - pad + h / 2;
    this.boardMesh.scale.set(w, h, 1);
    this.boardMesh.position.set(cx, VIEW_H - cyScreen, 0);
  },
  cellCX(c) { return this.originX + c * this.cell + this.cell / 2; },
  cellCY(r) { return this.originY + r * this.cell + this.cell / 2; },
  gemDrawSize() { return this.cell * 0.86; },

  applyGemTexture(g) { g.sprite.material.map = this.gemTex[g.kind]; g.sprite.material.needsUpdate = true; },
  // gem の論理値を THREE.Sprite へ反映 (worldY = H - y)。
  syncGem(g) {
    const s = g.sprite;
    s.position.set(g.x, VIEW_H - g.y, RO.gem * 0.01);
    s.scale.set(g.size, g.size, 1);
    s.material.opacity = g.alpha;
  },

  // ------------------------------------------------------------------
  // マッチ判定 / 盤面生成
  // ------------------------------------------------------------------
  findMatches() {
    const N = this.N, grid = this.grid;
    const marked = [];
    for (let r = 0; r < N; r++) marked[r] = new Array(N).fill(false);
    let any = false;
    for (let r = 0; r < N; r++) {
      let runStart = 0;
      for (let c = 1; c <= N; c++) {
        const same = c < N && grid[r][c] === grid[r][runStart] && grid[r][runStart] >= 0;
        if (!same) {
          const len = c - runStart;
          if (len >= 3) { for (let kk = runStart; kk < c; kk++) { marked[r][kk] = true; any = true; } }
          runStart = c;
        }
      }
    }
    for (let c = 0; c < N; c++) {
      let runStart = 0;
      for (let r = 1; r <= N; r++) {
        const same = r < N && grid[r][c] === grid[runStart][c] && grid[runStart][c] >= 0;
        if (!same) {
          const len = r - runStart;
          if (len >= 3) { for (let kk = runStart; kk < r; kk++) { marked[kk][c] = true; any = true; } }
          runStart = r;
        }
      }
    }
    return any ? marked : null;
  },
  wouldMatchAt(g, r, c, type) {
    if (c >= 2 && g[r][c - 1] === type && g[r][c - 2] === type) return true;
    if (r >= 2 && g[r - 1][c] === type && g[r - 2][c] === type) return true;
    return false;
  },
  generateBoard() {
    const N = this.N;
    const rnd = mulberry32((SEED_BOARD ^ (N * 2654435761)) >>> 0);
    const g = [];
    for (let r = 0; r < N; r++) {
      g[r] = new Array(N);
      for (let c = 0; c < N; c++) {
        let pick = Math.floor(rnd() * GEM_TYPES);
        for (let tries = 0; tries < GEM_TYPES; tries++) {
          const t = (pick + tries) % GEM_TYPES;
          if (!this.wouldMatchAt(g, r, c, t)) { g[r][c] = t; pick = t; break; }
          g[r][c] = t;
        }
      }
    }
    return g;
  },

  buildBoard() {
    const N = this.N;
    if (this.gems.length) {
      for (let r = 0; r < this.gems.length; r++) {
        for (let c = 0; c < this.gems[r].length; c++) this.releaseGem(this.gems[r][c]);
      }
    }
    this.tweenMgr.clear();
    this.computeLayout();
    this.grid = this.generateBoard();
    this.gems = [];
    const sz = this.gemDrawSize();
    for (let r = 0; r < N; r++) {
      this.gems[r] = [];
      for (let c = 0; c < N; c++) {
        const g = this.getGem();
        g.kind = this.grid[r][c];
        g.x = this.cellCX(c); g.y = this.cellCY(r);
        g.size = sz; g.alpha = 1;
        this.applyGemTexture(g); this.syncGem(g);
        this.gems[r][c] = g;
      }
    }
  },

  // ------------------------------------------------------------------
  // スワップ
  // ------------------------------------------------------------------
  beginSwap(a, b, isRevert) {
    this.state = S_SWAP;
    this.pendingSwap = { a, b, revert: !!isRevert };
    const ga = this.gems[a.r][a.c], gb = this.gems[b.r][b.c];
    const ax = this.cellCX(a.c), ay = this.cellCY(a.r);
    const bx = this.cellCX(b.c), by = this.cellCY(b.r);
    let remaining = 2;
    const done = () => { if (--remaining === 0) this.onSwapTweensDone(); };
    this.tweenMgr.add({ target: ga, props: { x: bx, y: by }, duration: SWAP_TIME, ease: easeOutQuad, onComplete: done });
    this.tweenMgr.add({ target: gb, props: { x: ax, y: ay }, duration: SWAP_TIME, ease: easeOutQuad, onComplete: done });
  },
  swapCells(a, b) {
    const tg = this.grid[a.r][a.c]; this.grid[a.r][a.c] = this.grid[b.r][b.c]; this.grid[b.r][b.c] = tg;
    const ts = this.gems[a.r][a.c]; this.gems[a.r][a.c] = this.gems[b.r][b.c]; this.gems[b.r][b.c] = ts;
  },
  onSwapTweensDone() {
    const { a, b, revert } = this.pendingSwap;
    this.swapCells(a, b);
    this.pendingSwap = null;
    if (revert) { this.state = S_IDLE; return; }
    const m = this.findMatches();
    if (m) { this.chain = 0; this.startClear(m); }
    else { this.beginSwap(a, b, true); }
  },

  // ------------------------------------------------------------------
  // CLEAR
  // ------------------------------------------------------------------
  startClear(marked) {
    const N = this.N;
    this.state = S_CLEAR;
    this.chain += 1;
    let cleared = 0;
    const toRemove = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (marked[r][c]) { cleared++; toRemove.push({ r, c }); }
    this.score += cleared * SCORE_PER_GEM * this.chain;
    let remaining = toRemove.length;
    if (remaining === 0) { this.state = S_IDLE; return; }
    for (const { r, c } of toRemove) {
      const g = this.gems[r][c];
      this.grid[r][c] = -1; this.gems[r][c] = null;
      const done = () => { this.releaseGem(g); if (--remaining === 0) this.startFall(); };
      this.tweenMgr.add({ target: g, props: { size: 0, alpha: 0 }, duration: CLEAR_TIME, ease: easeInQuad, onComplete: done });
    }
  },

  // ------------------------------------------------------------------
  // FALL (セル単位)
  // ------------------------------------------------------------------
  startFall() {
    const N = this.N;
    this.state = S_FALL;
    const rnd = mulberry32((SEED_REFILL ^ (N * 40503) ^ (this.moves * 2246822519) ^ (this.chain * 3266489917)) >>> 0);
    const sz = this.gemDrawSize();
    let fallTweens = 0;
    const onOne = () => { if (--fallTweens === 0) this.afterFall(); };
    for (let c = 0; c < N; c++) {
      let writeRow = N - 1;
      for (let r = N - 1; r >= 0; r--) {
        if (this.grid[r][c] >= 0) {
          if (writeRow !== r) {
            this.grid[writeRow][c] = this.grid[r][c];
            const g = this.gems[r][c];
            this.gems[writeRow][c] = g;
            this.grid[r][c] = -1; this.gems[r][c] = null;
            const dist = writeRow - r;
            fallTweens++;
            this.tweenMgr.add({ target: g, props: { y: this.cellCY(writeRow) }, duration: FALL_PER_CELL * dist, ease: easeInQuad, onComplete: onOne });
          }
          writeRow--;
        }
      }
      for (let r = writeRow; r >= 0; r--) {
        const type = Math.floor(rnd() * GEM_TYPES);
        this.grid[r][c] = type;
        const g = this.getGem();
        g.kind = type;
        g.x = this.cellCX(c); g.size = sz; g.alpha = 1;
        g.y = this.cellCY(r) - (writeRow + 2) * this.cell;
        this.applyGemTexture(g);
        this.gems[r][c] = g;
        const dist = (this.cellCY(r) - g.y) / this.cell;
        fallTweens++;
        this.tweenMgr.add({ target: g, props: { y: this.cellCY(r) }, duration: FALL_PER_CELL * Math.max(dist, 1), ease: easeInQuad, onComplete: onOne });
      }
    }
    if (fallTweens === 0) this.afterFall();
  },
  afterFall() {
    const m = this.findMatches();
    if (m) { this.startClear(m); } else { this.chain = 0; this.state = S_IDLE; }
  },

  // ------------------------------------------------------------------
  // 入力: クリック2回で隣接スワップ
  // ------------------------------------------------------------------
  bindInput() {
    const sceneEl = this.sceneEl;
    const getCanvas = () => sceneEl.canvas || (sceneEl.renderer && sceneEl.renderer.domElement);

    const pointerToCell = (ev) => {
      const canvas = getCanvas();
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const sx = VIEW_W / rect.width, sy = VIEW_H / rect.height;
      const px = (ev.clientX - rect.left) * sx;
      const py = (ev.clientY - rect.top) * sy;
      const c = Math.floor((px - this.originX) / this.cell);
      const r = Math.floor((py - this.originY) / this.cell);
      if (r < 0 || r >= this.N || c < 0 || c >= this.N) return null;
      return { r, c };
    };
    const isAdjacent = (a, b) =>
      (Math.abs(a.r - b.r) === 1 && a.c === b.c) ||
      (Math.abs(a.c - b.c) === 1 && a.r === b.r);

    window.addEventListener('pointerdown', (ev) => {
      if (!this.ready || !this.started || this.state !== S_IDLE) return; // アトラクト中は操作無効
      const cellPos = pointerToCell(ev);
      if (!cellPos) return;
      if (!this.sel) { this.sel = cellPos; }
      else if (this.sel.r === cellPos.r && this.sel.c === cellPos.c) { this.sel = null; }
      else if (isAdjacent(this.sel, cellPos)) { const a = this.sel, b = cellPos; this.sel = null; this.moves += 1; this.beginSwap(a, b, false); }
      else { this.sel = cellPos; }
    });

    window.addEventListener('keydown', (e) => {
      if (!this.ready) return;
      if (e.code === 'Enter' && !this.started) { this.startGame(); e.preventDefault(); return; }
      if (e.code === 'Space') { this.auto = !this.auto; this.autoTimer = 0; e.preventDefault(); }
      else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.setBoardN(this.N + N_STEP); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.setBoardN(this.N - N_STEP); e.preventDefault(); }
      else if (e.code === 'KeyR') { this.resetBoard(); e.preventDefault(); }
    });
  },

  // ------------------------------------------------------------------
  // オートプレイ
  // ------------------------------------------------------------------
  swapMakesMatch(r, c, r2, c2) {
    const grid = this.grid;
    const t1 = grid[r][c], t2 = grid[r2][c2];
    grid[r][c] = t2; grid[r2][c2] = t1;
    const m = this.findMatches();
    grid[r][c] = t1; grid[r2][c2] = t2;
    return !!m;
  },
  findFirstValidSwap() {
    const N = this.N;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (c + 1 < N && this.swapMakesMatch(r, c, r, c + 1)) return { a: { r, c }, b: { r, c: c + 1 } };
        if (r + 1 < N && this.swapMakesMatch(r, c, r + 1, c)) return { a: { r, c }, b: { r: r + 1, c } };
      }
    }
    return null;
  },
  deterministicShuffle() {
    const N = this.N;
    this.shuffleCount++;
    const rnd = mulberry32((SEED_SHUFFLE ^ (N * 16807) ^ (this.shuffleCount * 2654435761)) >>> 0);
    const flat = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flat.push(this.grid[r][c]);
    for (let i = flat.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = flat[i]; flat[i] = flat[j]; flat[j] = t;
    }
    let kk = 0;
    const sz = this.gemDrawSize();
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        let type = flat[kk++];
        let guard = 0;
        while (this.wouldMatchAt(this.grid, r, c, type) && guard < GEM_TYPES) { type = (type + 1) % GEM_TYPES; guard++; }
        this.grid[r][c] = type;
        const g = this.gems[r][c];
        g.kind = type; g.x = this.cellCX(c); g.y = this.cellCY(r); g.size = sz; g.alpha = 1;
        this.applyGemTexture(g); this.syncGem(g);
      }
    }
  },
  autoStep() {
    const sw = this.findFirstValidSwap();
    if (sw) { this.moves += 1; this.beginSwap(sw.a, sw.b, false); }
    else { this.deterministicShuffle(); }
  },

  // ------------------------------------------------------------------
  // リサイズ / リセット
  // ------------------------------------------------------------------
  setBoardN(newN) {
    newN = clamp(newN, N_MIN, N_MAX);
    if (newN === this.N && this.gems.length) return;
    this.N = newN; this.state = S_IDLE; this.chain = 0; this.sel = null;
    this.pendingSwap = null; this.autoTimer = 0;
    this.buildBoard();
  },
  resetBoard() {
    this.state = S_IDLE; this.chain = 0; this.score = 0; this.moves = 0; this.sel = null;
    this.pendingSwap = null; this.autoTimer = 0; this.shuffleCount = 0;
    this.buildBoard();
  },
  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() { this.started = true; this.resetBoard(); if (this.titleEl) this.titleEl.style.display = 'none'; },

  // 選択ハイライトの矩形頂点を更新 (画面座標→world)。
  updateSelLine() {
    if (this.sel && this.state === S_IDLE) {
      const x0 = this.originX + this.sel.c * this.cell + 2, y0 = this.originY + this.sel.r * this.cell + 2;
      const x1 = x0 + this.cell - 4, y1 = y0 + this.cell - 4;
      const p = this.selLine.geometry.attributes.position.array;
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      for (let i = 0; i < 5; i++) { p[i * 3] = pts[i][0]; p[i * 3 + 1] = VIEW_H - pts[i][1]; p[i * 3 + 2] = RO.sel * 0.01; }
      this.selLine.geometry.attributes.position.needsUpdate = true;
      this.selLine.visible = true;
    } else {
      this.selLine.visible = false;
    }
  },

  // ------------------------------------------------------------------
  // ループ (A-Frame tick: dtMs は ms 単位)
  // ------------------------------------------------------------------
  tick(time, dtMs) {
    if (!this.ready) return;
    // カメラを 2D 用に維持 (A-Frame が別カメラを差し込んでも上書き)
    if (this.sceneEl.camera !== this.cam) this.sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50); // タブ復帰時の暴発抑制
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    // トゥイーン進行 (★ 状態遷移を駆動)
    this.tweenMgr.update(dt);

    // オートプレイ（アトラクト中は auto トグルに関わらずデモAIを常時駆動）
    if ((this.auto || !this.started) && this.state === S_IDLE) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) { this.autoTimer = AUTO_INTERVAL; this.autoStep(); }
    }

    // 論理 gem → スプライト反映 (盤面全走査)
    const N = this.N;
    for (let r = 0; r < N; r++) {
      const row = this.gems[r];
      if (!row) continue;
      for (let c = 0; c < N; c++) { const g = row[c]; if (g && g.sprite) this.syncGem(g); }
    }
    this.updateSelLine();

    if (!this.started) { this.blinkT += dt; this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }

    this.hudTimer += dt;
    if (this.hudTimer >= 0.12) {
      this.hudTimer = 0;
      const cells = N * N;
      this.hudEl.textContent =
        `FPS           : ${fpsAvg.toFixed(1)}\n` +
        `Board         : ${N} x ${N} = ${cells} cells\n` +
        `Active tweens : ${this.tweenMgr.count()}\n` +
        `State         : ${this.state}   Chain : ${this.chain}\n` +
        `Score         : ${this.score}   Moves : ${this.moves}\n` +
        `Auto          : ${this.auto ? 'ON' : 'OFF'}\n` +
        `クリック2回=スワップ / Space=オート / +/-=盤面(${N_MIN}..${N_MAX}) / R=リセット`;
    }
  },
});

console.log('[A-Frame] theme10 match-3 component registered.');
