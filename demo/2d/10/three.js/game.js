/* ============================================================================
 * テーマ10 マッチ3パズル（ロジック主体・大量トゥイーン）― three.js (r184) 実装
 * 仕様: SPEC.md (960x540, NxN 盤面, 6 種宝石, 状態機械 IDLE/SWAP/CLEAR/FALL)
 * 参照: 10/PixiJS/game.js （定数・マッチ判定・落下/消滅・オートプレイを厳密一致）
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0, -1000, 1000) で 1ワールド単位 = 1px。
 *     原点左下・Y上向き。ゲームロジックは画面座標(Y下向き)で保持し、
 *     描画同期時のみ worldY = H - gameY に変換する。
 *   - 宝石は THREE.Sprite (常にカメラを向く板)。重ね順は renderOrder。
 *     盤面は最大 1600 セル → スプライトはプールして再利用 (毎フレーム再生成しない)。
 *
 *   ★ 本テーマの比較対象 = 「トゥイーン機構」 ★
 *   three.js には組込みトゥイーンが無い。そこで Pixi/Babylon/LittleJS と同じく
 *   進行中トゥイーンを配列で保持し、毎フレーム dt でイージング補間して進める
 *   自前マネージャ (makeTweenManager) を実装する。トゥイーンは論理 gem オブジェクト
 *   の {x,y,size,alpha} を動かし、毎フレーム末にそれを THREE.Sprite へ反映する。
 *   HUD の "Active tweens" がそのまま負荷指標 (落下/消滅が同時多発するほど増える)。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC / PixiJS 参照に一致) ---------------------------------------
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
const COLOR_CELL = '#101a30';
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
// 自前トゥイーンマネージャ (★本テーマの比較対象)
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

// ============================================================================
// シーン / カメラ / レンダラ
// ============================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLOR_BG);
const camera = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(VIEW_W, VIEW_H);
document.getElementById('game-container').appendChild(renderer.domElement);

const tex = {};
const ASSET_DEFS = {
  gem_red:    '../assets/gem_red.png',
  gem_blue:   '../assets/gem_blue.png',
  gem_green:  '../assets/gem_green.png',
  gem_yellow: '../assets/gem_yellow.png',
  gem_purple: '../assets/gem_purple.png',
  gem_white:  '../assets/gem_white.png',
  bg_board:   '../assets/bg_board.png',
};
const loader = new THREE.TextureLoader();

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { const t = await loader.loadAsync(url); t.colorSpace = THREE.SRGBColorSpace; tex[key] = t; }
    catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  const tweenMgr = makeTweenManager();

  // 宝石テクスチャ (画像 or フォールバック) を種別ごとに確定。
  const gemTex = GEM_KEYS.map((kk, i) => tex['gem_' + kk] || fbGem(i));

  // ---- 盤面背景 (Mesh) ----
  let boardMesh = null;
  function ensureBoardMesh() {
    if (boardMesh) return;
    const mat = tex.bg_board
      ? new THREE.MeshBasicMaterial({ map: tex.bg_board, depthTest: false, transparent: true })
      : new THREE.MeshBasicMaterial({ color: new THREE.Color(COLOR_BOARD), depthTest: false });
    boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    boardMesh.renderOrder = RO.board;
    scene.add(boardMesh);
  }

  // ---- 選択ハイライト (LineSegments 矩形) ----
  const selGeo = new THREE.BufferGeometry();
  selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 3), 3));
  const selLine = new THREE.Line(selGeo, new THREE.LineBasicMaterial({ color: COLOR_SELECT, depthTest: false }));
  selLine.renderOrder = RO.sel;
  selLine.visible = false;
  scene.add(selLine);

  // ====================================================================
  // 盤面状態
  //   grid[r][c] = 種別 / -1
  //   gem object = { kind, x, y, size, alpha, sprite }  (x,y は画面座標)
  //   トゥイーンは gem.{x,y,size,alpha} を動かす。毎フレーム末にスプライトへ反映。
  // ====================================================================
  let N = N_INIT;
  let cell = 0, originX = 0, originY = 0;
  let grid = [];
  let gems = [];

  // スプライトプール
  const spritePool = [];
  function getSprite() {
    let s = spritePool.pop();
    if (!s) {
      const mat = new THREE.SpriteMaterial({ map: gemTex[0], transparent: true, depthTest: false });
      s = new THREE.Sprite(mat);
      s.renderOrder = RO.gem;
      scene.add(s);
    }
    s.visible = true;
    s.material.opacity = 1;
    return s;
  }
  function releaseSprite(s) { if (s) { s.visible = false; spritePool.push(s); } }

  function getGem() {
    const g = { kind: 0, x: 0, y: 0, size: 0, alpha: 1, sprite: getSprite() };
    return g;
  }
  function releaseGem(g) { if (g) { releaseSprite(g.sprite); g.sprite = null; } }

  function computeLayout() {
    cell = Math.floor(Math.min(BOARD_SPAN / N, CELL_MAX));
    const boardPx = cell * N;
    originX = Math.floor((VIEW_W - boardPx) / 2);
    originY = Math.floor((VIEW_H - boardPx) / 2);
    ensureBoardMesh();
    const pad = Math.max(8, Math.floor(cell * 0.18));
    const w = boardPx + pad * 2, h = boardPx + pad * 2;
    const cx = originX - pad + w / 2;
    const cyScreen = originY - pad + h / 2;
    boardMesh.scale.set(w, h, 1);
    boardMesh.position.set(cx, VIEW_H - cyScreen, 0);
  }
  const cellCX = (c) => originX + c * cell + cell / 2;
  const cellCY = (r) => originY + r * cell + cell / 2;
  const gemDrawSize = () => cell * 0.86;

  function applyGemTexture(g) { g.sprite.material.map = gemTex[g.kind]; g.sprite.material.needsUpdate = true; }
  // gem の論理値を THREE.Sprite へ反映 (worldY = H - y)。
  function syncGem(g) {
    const s = g.sprite;
    s.position.set(g.x, VIEW_H - g.y, RO.gem * 0.01);
    s.scale.set(g.size, g.size, 1);
    s.material.opacity = g.alpha;
  }

  // ---- マッチ判定 ----
  function findMatches() {
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
  }
  function wouldMatchAt(g, r, c, type) {
    if (c >= 2 && g[r][c - 1] === type && g[r][c - 2] === type) return true;
    if (r >= 2 && g[r - 1][c] === type && g[r - 2][c] === type) return true;
    return false;
  }
  function generateBoard() {
    const rnd = mulberry32((SEED_BOARD ^ (N * 2654435761)) >>> 0);
    const g = [];
    for (let r = 0; r < N; r++) {
      g[r] = new Array(N);
      for (let c = 0; c < N; c++) {
        let pick = Math.floor(rnd() * GEM_TYPES);
        for (let tries = 0; tries < GEM_TYPES; tries++) {
          const t = (pick + tries) % GEM_TYPES;
          if (!wouldMatchAt(g, r, c, t)) { g[r][c] = t; pick = t; break; }
          g[r][c] = t;
        }
      }
    }
    return g;
  }

  function buildBoard() {
    if (gems.length) {
      for (let r = 0; r < gems.length; r++) {
        for (let c = 0; c < gems[r].length; c++) releaseGem(gems[r][c]);
      }
    }
    tweenMgr.clear();
    computeLayout();
    grid = generateBoard();
    gems = [];
    const sz = gemDrawSize();
    for (let r = 0; r < N; r++) {
      gems[r] = [];
      for (let c = 0; c < N; c++) {
        const g = getGem();
        g.kind = grid[r][c];
        g.x = cellCX(c); g.y = cellCY(r);
        g.size = sz; g.alpha = 1;
        applyGemTexture(g); syncGem(g);
        gems[r][c] = g;
      }
    }
  }

  // ---- ゲーム状態 ----
  let state = S_IDLE;
  let chain = 0, score = 0, moves = 0;
  let auto = true, autoTimer = 0, shuffleCount = 0;
  let sel = null;
  let started = false, blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
  const titleEl = document.getElementById('title');

  // ---- スワップ ----
  let pendingSwap = null;
  function beginSwap(a, b, isRevert) {
    state = S_SWAP;
    pendingSwap = { a, b, revert: !!isRevert };
    const ga = gems[a.r][a.c], gb = gems[b.r][b.c];
    const ax = cellCX(a.c), ay = cellCY(a.r);
    const bx = cellCX(b.c), by = cellCY(b.r);
    let remaining = 2;
    const done = () => { if (--remaining === 0) onSwapTweensDone(); };
    tweenMgr.add({ target: ga, props: { x: bx, y: by }, duration: SWAP_TIME, ease: easeOutQuad, onComplete: done });
    tweenMgr.add({ target: gb, props: { x: ax, y: ay }, duration: SWAP_TIME, ease: easeOutQuad, onComplete: done });
  }
  function swapCells(a, b) {
    const tg = grid[a.r][a.c]; grid[a.r][a.c] = grid[b.r][b.c]; grid[b.r][b.c] = tg;
    const ts = gems[a.r][a.c]; gems[a.r][a.c] = gems[b.r][b.c]; gems[b.r][b.c] = ts;
  }
  function onSwapTweensDone() {
    const { a, b, revert } = pendingSwap;
    swapCells(a, b);
    pendingSwap = null;
    if (revert) { state = S_IDLE; return; }
    const m = findMatches();
    if (m) { chain = 0; startClear(m); }
    else { beginSwap(a, b, true); }
  }

  // ---- CLEAR ----
  function startClear(marked) {
    state = S_CLEAR;
    chain += 1;
    let cleared = 0;
    const toRemove = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (marked[r][c]) { cleared++; toRemove.push({ r, c }); }
    score += cleared * SCORE_PER_GEM * chain;
    let remaining = toRemove.length;
    if (remaining === 0) { state = S_IDLE; return; }
    for (const { r, c } of toRemove) {
      const g = gems[r][c];
      grid[r][c] = -1; gems[r][c] = null;
      const done = () => { releaseGem(g); if (--remaining === 0) startFall(); };
      tweenMgr.add({ target: g, props: { size: 0, alpha: 0 }, duration: CLEAR_TIME, ease: easeInQuad, onComplete: done });
    }
  }

  // ---- FALL (セル単位) ----
  function startFall() {
    state = S_FALL;
    const rnd = mulberry32((SEED_REFILL ^ (N * 40503) ^ (moves * 2246822519) ^ (chain * 3266489917)) >>> 0);
    const sz = gemDrawSize();
    let fallTweens = 0;
    const onOne = () => { if (--fallTweens === 0) afterFall(); };
    for (let c = 0; c < N; c++) {
      let writeRow = N - 1;
      for (let r = N - 1; r >= 0; r--) {
        if (grid[r][c] >= 0) {
          if (writeRow !== r) {
            grid[writeRow][c] = grid[r][c];
            const g = gems[r][c];
            gems[writeRow][c] = g;
            grid[r][c] = -1; gems[r][c] = null;
            const dist = writeRow - r;
            fallTweens++;
            tweenMgr.add({ target: g, props: { y: cellCY(writeRow) }, duration: FALL_PER_CELL * dist, ease: easeInQuad, onComplete: onOne });
          }
          writeRow--;
        }
      }
      for (let r = writeRow; r >= 0; r--) {
        const type = Math.floor(rnd() * GEM_TYPES);
        grid[r][c] = type;
        const g = getGem();
        g.kind = type;
        g.x = cellCX(c); g.size = sz; g.alpha = 1;
        g.y = cellCY(r) - (writeRow + 2) * cell;
        applyGemTexture(g);
        gems[r][c] = g;
        const dist = (cellCY(r) - g.y) / cell;
        fallTweens++;
        tweenMgr.add({ target: g, props: { y: cellCY(r) }, duration: FALL_PER_CELL * Math.max(dist, 1), ease: easeInQuad, onComplete: onOne });
      }
    }
    if (fallTweens === 0) afterFall();
  }
  function afterFall() {
    const m = findMatches();
    if (m) { startClear(m); } else { chain = 0; state = S_IDLE; }
  }

  // ====================================================================
  // 入力: クリック2回で隣接スワップ
  // ====================================================================
  function pointerToCell(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const sx = VIEW_W / rect.width, sy = VIEW_H / rect.height;
    const px = (ev.clientX - rect.left) * sx;
    const py = (ev.clientY - rect.top) * sy;
    const c = Math.floor((px - originX) / cell);
    const r = Math.floor((py - originY) / cell);
    if (r < 0 || r >= N || c < 0 || c >= N) return null;
    return { r, c };
  }
  const isAdjacent = (a, b) =>
    (Math.abs(a.r - b.r) === 1 && a.c === b.c) ||
    (Math.abs(a.c - b.c) === 1 && a.r === b.r);
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (!started) return;   // アトラクト中はユーザーのスワップ操作を無効化
    if (state !== S_IDLE) return;
    const cellPos = pointerToCell(ev);
    if (!cellPos) return;
    if (!sel) { sel = cellPos; }
    else if (sel.r === cellPos.r && sel.c === cellPos.c) { sel = null; }
    else if (isAdjacent(sel, cellPos)) { const a = sel, b = cellPos; sel = null; moves += 1; beginSwap(a, b, false); }
    else { sel = cellPos; }
  });

  // ====================================================================
  // オートプレイ
  // ====================================================================
  function swapMakesMatch(r, c, r2, c2) {
    const t1 = grid[r][c], t2 = grid[r2][c2];
    grid[r][c] = t2; grid[r2][c2] = t1;
    const m = findMatches();
    grid[r][c] = t1; grid[r2][c2] = t2;
    return !!m;
  }
  function findFirstValidSwap() {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (c + 1 < N && swapMakesMatch(r, c, r, c + 1)) return { a: { r, c }, b: { r, c: c + 1 } };
        if (r + 1 < N && swapMakesMatch(r, c, r + 1, c)) return { a: { r, c }, b: { r: r + 1, c } };
      }
    }
    return null;
  }
  function deterministicShuffle() {
    shuffleCount++;
    const rnd = mulberry32((SEED_SHUFFLE ^ (N * 16807) ^ (shuffleCount * 2654435761)) >>> 0);
    const flat = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flat.push(grid[r][c]);
    for (let i = flat.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = flat[i]; flat[i] = flat[j]; flat[j] = t;
    }
    let kk = 0;
    const sz = gemDrawSize();
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        let type = flat[kk++];
        let guard = 0;
        while (wouldMatchAt(grid, r, c, type) && guard < GEM_TYPES) { type = (type + 1) % GEM_TYPES; guard++; }
        grid[r][c] = type;
        const g = gems[r][c];
        g.kind = type; g.x = cellCX(c); g.y = cellCY(r); g.size = sz; g.alpha = 1;
        applyGemTexture(g); syncGem(g);
      }
    }
  }
  function autoStep() {
    const sw = findFirstValidSwap();
    if (sw) { moves += 1; beginSwap(sw.a, sw.b, false); }
    else { deterministicShuffle(); }
  }

  // ====================================================================
  // リサイズ / リセット
  // ====================================================================
  function setBoardN(newN) {
    newN = clamp(newN, N_MIN, N_MAX);
    if (newN === N && gems.length) return;
    N = newN; state = S_IDLE; chain = 0; sel = null; pendingSwap = null; autoTimer = 0;
    buildBoard();
  }
  function resetBoard() {
    state = S_IDLE; chain = 0; score = 0; moves = 0; sel = null; pendingSwap = null;
    autoTimer = 0; shuffleCount = 0;
    buildBoard();
  }
  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() { started = true; resetBoard(); titleEl.style.display = 'none'; }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && !started) { startGame(); e.preventDefault(); return; }
    if (e.code === 'Space') { auto = !auto; autoTimer = 0; e.preventDefault(); }
    else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { setBoardN(N + N_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { setBoardN(N - N_STEP); e.preventDefault(); }
    else if (e.code === 'KeyR') { resetBoard(); e.preventDefault(); }
  });

  buildBoard();

  // 選択ハイライトの矩形頂点を更新 (画面座標→world)。
  function updateSelLine() {
    if (sel && state === S_IDLE) {
      const x0 = originX + sel.c * cell + 2, y0 = originY + sel.r * cell + 2;
      const x1 = x0 + cell - 4, y1 = y0 + cell - 4;
      const p = selLine.geometry.attributes.position.array;
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      for (let i = 0; i < 5; i++) { p[i * 3] = pts[i][0]; p[i * 3 + 1] = VIEW_H - pts[i][1]; p[i * 3 + 2] = RO.sel * 0.01; }
      selLine.geometry.attributes.position.needsUpdate = true;
      selLine.visible = true;
    } else {
      selLine.visible = false;
    }
  }

  // ---- ループ ----
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = [];
  let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // トゥイーン進行 (★ 状態遷移を駆動)
    tweenMgr.update(dt);

    // オートプレイ（アトラクト中は auto トグルに関わらずデモAIを常時駆動）
    if ((auto || !started) && state === S_IDLE) {
      autoTimer -= dt;
      if (autoTimer <= 0) { autoTimer = AUTO_INTERVAL; autoStep(); }
    }

    // 論理 gem → スプライト反映 (盤面全走査)
    for (let r = 0; r < N; r++) {
      const row = gems[r];
      for (let c = 0; c < N; c++) { const g = row[c]; if (g && g.sprite) syncGem(g); }
    }
    updateSelLine();

    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }

    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const cells = N * N;
      hudEl.textContent =
        `FPS           : ${fpsAvg.toFixed(1)}\n` +
        `Board         : ${N} x ${N} = ${cells} cells\n` +
        `Active tweens : ${tweenMgr.count()}\n` +
        `State         : ${state}   Chain : ${chain}\n` +
        `Score         : ${score}   Moves : ${moves}\n` +
        `Auto          : ${auto ? 'ON' : 'OFF'}\n` +
        `クリック2回=スワップ / Space=オート / +/-=盤面(${N_MIN}..${N_MAX}) / R=リセット`;
    }

    renderer.render(scene, camera);
  });

  console.log('[three.js] theme10 match-3 init ok. renderer: WebGL');
}
