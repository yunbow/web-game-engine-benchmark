/* ============================================================================
 * テーマ10 マッチ3パズル（ロジック主体・大量トゥイーン）― KAPLAY 実装
 * 仕様: SPEC.md (960x540, NxN 盤面, 6 種宝石, 状態機械 IDLE/SWAP/CLEAR/FALL)
 * 参照: 10/PixiJS/game.js （定数・マッチ判定・落下/消滅・オートプレイを厳密一致）
 *
 * KAPLAY は「全部入り」の軽量2Dゲームライブラリ。以下はライブラリ機構を使う:
 *   - ゲームループ (onUpdate / dt())
 *   - 入力 (onKeyPress / onClick 相当の canvas pointer)
 *   - スプライト/図形描画 (add([...comps]))
 *   - 座標系は Y 下向き・原点左上 = 画面座標とそのまま一致 (座標変換不要)
 *
 *   ★ 本テーマの比較対象 = 「トゥイーン機構」 ★
 *   KAPLAY には k.tween(from,to,dur,setter,easing) という組込みトゥイーンがある
 *   (Promise を返す)。ただし本テーマは「落下/消滅で同時に数百〜千本のセル単位
 *   トゥイーンが走る」のが負荷の核で、毎フレーム生成/破棄される k.tween を
 *   その本数だけ抱えると Promise/クロージャのオーバーヘッドと "進行中本数の
 *   正確な計測" が難しくなる。そこで他エンジン (Pixi/Babylon/LittleJS) と
 *   条件を揃え、進行中トゥイーンを配列で保持して毎フレーム dt で補間する
 *   小さな自前マネージャ (makeTweenManager) を採用する。HUD の "Active tweens"
 *   はこのマネージャが現在保持している本数。
 *   ※KAPLAY 組込み k.tween は SWAP のような少数演出には自然だが、本実装では
 *     全演出を自前マネージャに統一して計測可能性と他エンジン比較性を優先した。
 * ========================================================================== */

// ---- 定数 (SPEC / PixiJS 参照に一致) ---------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const N_INIT = 12;            // 盤面の初期 N
const N_STEP = 2;             // +/- の増減幅
const N_MIN = 6;
const N_MAX = 40;
const BOARD_SPAN = 520;       // 盤面が収まる正方領域 (px)
const CELL_MAX = 56;          // セル1辺の上限 (px)

const GEM_TYPES = 6;          // 宝石種別 6

// トゥイーン時間 (秒)
const SWAP_TIME = 0.15;
const CLEAR_TIME = 0.2;
const FALL_PER_CELL = 0.2;
const AUTO_INTERVAL = 0.25;

const SCORE_PER_GEM = 10;

// 決定的乱数のシード
const SEED_BOARD = 20250615;
const SEED_REFILL = 99173;
const SEED_SHUFFLE = 51237;

const S_IDLE = 'IDLE', S_SWAP = 'SWAP', S_CLEAR = 'CLEAR', S_FALL = 'FALL';

// 宝石フォールバック色 (種別 0..5 = 赤/青/緑/黄/紫/白)
const GEM_COLORS = [
  [226, 69, 59],   // red
  [59, 130, 226],  // blue
  [73, 196, 99],   // green
  [242, 207, 60],  // yellow
  [166, 87, 226],  // purple
  [232, 237, 245], // white
];
const GEM_KEYS = ['red', 'blue', 'green', 'yellow', 'purple', 'white'];

// 盤面/セル色
const COLOR_BG = [13, 19, 34];      // 濃紺キャンバス
const COLOR_BOARD = [24, 34, 58];   // 盤面の暗い角丸
const COLOR_CELL = [16, 26, 48];    // セルの薄い枠
const COLOR_SELECT = [255, 242, 168];

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

// ---- イージング ------------------------------------------------------------
const easeLinear  = (t) => t;
const easeOutQuad = (t) => t * (2 - t);
const easeInQuad  = (t) => t * t;

// ============================================================================
// 自前トゥイーンマネージャ (★本テーマの比較対象)
//   1 トゥイーン = { target, props:{key:{from,to}}, dur, t, ease, onComplete }
//   update(dt) で全件を進め、完了分を除去 → onComplete をまとめて呼ぶ。
// ============================================================================
function makeTweenManager() {
  const tweens = [];
  const completedThisFrame = [];

  function add(spec) {
    const props = {};
    for (const key in spec.props) {
      props[key] = { from: spec.target[key], to: spec.props[key] };
    }
    const tw = {
      target: spec.target,
      props,
      dur: Math.max(spec.duration, 0.0001),
      t: 0,
      ease: spec.ease || easeLinear,
      onComplete: spec.onComplete || null,
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
      if (done) {
        tweens.splice(i, 1);
        if (tw.onComplete) completedThisFrame.push(tw.onComplete);
      }
    }
    for (let i = 0; i < completedThisFrame.length; i++) completedThisFrame[i]();
  }

  function clear() { tweens.length = 0; }
  const count = () => tweens.length;
  return { add, update, clear, count };
}

// ============================================================================
// KAPLAY 初期化
// ============================================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: COLOR_BG,
  crisp: true,
  global: false,            // 名前空間 k.* を明示利用
});

const ASSET_DEFS = {
  gem_red:    '../assets/gem_red.png',
  gem_blue:   '../assets/gem_blue.png',
  gem_green:  '../assets/gem_green.png',
  gem_yellow: '../assets/gem_yellow.png',
  gem_purple: '../assets/gem_purple.png',
  gem_white:  '../assets/gem_white.png',
  bg_board:   '../assets/bg_board.png',
};

const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { await k.loadSprite(key, url); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

function start() {
  const tweenMgr = makeTweenManager();

  // ====================================================================
  // 盤面状態
  //   grid[r][c] = 宝石種別 (0..5) または -1 (空き)
  //   gem オブジェクト (自前 plain object) = { kind, x, y, size, alpha }
  //   描画は onDraw でまとめて行う (KAPLAY add オブジェクトを1600個持たず軽量化)。
  // ====================================================================
  let N = N_INIT;
  let cell = 0;
  let originX = 0, originY = 0;
  let grid = [];        // [r][c] -> type
  let gems = [];        // [r][c] -> gem object (or null)

  // gem プール (盤面リサイズをまたいで再利用)
  const gemPool = [];
  function getGem() {
    let g = gemPool.pop();
    if (!g) g = { kind: 0, x: 0, y: 0, size: 0, alpha: 1 };
    g.alpha = 1;
    return g;
  }
  function releaseGem(g) { if (g) gemPool.push(g); }

  function computeLayout() {
    cell = Math.floor(Math.min(BOARD_SPAN / N, CELL_MAX));
    const boardPx = cell * N;
    originX = Math.floor((VIEW_W - boardPx) / 2);
    originY = Math.floor((VIEW_H - boardPx) / 2);
  }
  const cellCX = (c) => originX + c * cell + cell / 2;
  const cellCY = (r) => originY + r * cell + cell / 2;
  const gemDrawSize = () => cell * 0.86;

  // ---- マッチ判定 (毎回 O(N^2) 全走査) ----
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
        gems[r][c] = g;
      }
    }
  }

  // ---- ゲーム状態 ----
  let state = S_IDLE;
  let chain = 0;
  let score = 0;
  let moves = 0;
  let auto = true;
  let autoTimer = 0;
  let shuffleCount = 0;
  let sel = null;
  let started = false, blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
  const titleEl = document.getElementById('title');

  // ---- スワップ ----
  let pendingSwap = null;
  function beginSwap(a, b, isRevert) {
    state = S_SWAP;
    pendingSwap = { a, b, revert: !!isRevert };
    const ga = gems[a.r][a.c];
    const gb = gems[b.r][b.c];
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
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (marked[r][c]) { cleared++; toRemove.push({ r, c }); }
      }
    }
    score += cleared * SCORE_PER_GEM * chain;
    let remaining = toRemove.length;
    if (remaining === 0) { state = S_IDLE; return; }
    for (const { r, c } of toRemove) {
      const g = gems[r][c];
      grid[r][c] = -1;
      gems[r][c] = null;
      const done = () => {
        releaseGem(g);
        if (--remaining === 0) startFall();
      };
      tweenMgr.add({
        target: g,
        props: { size: 0, alpha: 0 },
        duration: CLEAR_TIME,
        ease: easeInQuad,
        onComplete: done,
      });
    }
  }

  // ---- FALL (セル単位でトゥイーン) ----
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
            grid[r][c] = -1;
            gems[r][c] = null;
            const dist = writeRow - r;
            fallTweens++;
            tweenMgr.add({
              target: g,
              props: { y: cellCY(writeRow) },
              duration: FALL_PER_CELL * dist,
              ease: easeInQuad,
              onComplete: onOne,
            });
          }
          writeRow--;
        }
      }
      for (let r = writeRow; r >= 0; r--) {
        const type = Math.floor(rnd() * GEM_TYPES);
        grid[r][c] = type;
        const g = getGem();
        g.kind = type;
        g.x = cellCX(c);
        g.size = sz; g.alpha = 1;
        g.y = cellCY(r) - (writeRow + 2) * cell;
        gems[r][c] = g;
        const dist = (cellCY(r) - g.y) / cell;
        fallTweens++;
        tweenMgr.add({
          target: g,
          props: { y: cellCY(r) },
          duration: FALL_PER_CELL * Math.max(dist, 1),
          ease: easeInQuad,
          onComplete: onOne,
        });
      }
    }
    if (fallTweens === 0) afterFall();
  }

  function afterFall() {
    const m = findMatches();
    if (m) { startClear(m); }
    else { chain = 0; state = S_IDLE; }
  }

  // ====================================================================
  // 入力: クリック2回で隣接スワップ
  // ====================================================================
  function pointerToCell(ev) {
    const rect = k.canvas.getBoundingClientRect();
    const sx = VIEW_W / rect.width;
    const sy = VIEW_H / rect.height;
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

  k.canvas.addEventListener('pointerdown', (ev) => {
    if (!started) return;   // アトラクト中はユーザーのスワップ操作を無効化
    if (state !== S_IDLE) return;
    const cellPos = pointerToCell(ev);
    if (!cellPos) return;
    if (!sel) { sel = cellPos; }
    else if (sel.r === cellPos.r && sel.c === cellPos.c) { sel = null; }
    else if (isAdjacent(sel, cellPos)) {
      const a = sel, b = cellPos; sel = null; moves += 1; beginSwap(a, b, false);
    } else { sel = cellPos; }
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
        g.kind = type;
        g.x = cellCX(c); g.y = cellCY(r);
        g.size = sz; g.alpha = 1;
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
  function startGame() { started = true; resetBoard(); titleEl.style.display = 'none'; }

  // ---- 入力 (キーボード) ----
  k.onKeyPress('enter', () => { if (!started) startGame(); });
  k.onKeyPress('space', () => { auto = !auto; autoTimer = 0; });
  k.onKeyPress(['=', 'kpadd'], () => setBoardN(N + N_STEP));
  k.onKeyPress(['minus', 'kpsubtract'], () => setBoardN(N - N_STEP));
  k.onKeyPress('r', () => resetBoard());

  // ---- 初期盤面 ----
  buildBoard();

  // ---- 描画 (onDraw でまとめて矩形/丸を描く) ----
  k.onDraw(() => {
    // 盤面背景
    const pad = Math.max(8, Math.floor(cell * 0.18));
    const boardPx = cell * N;
    if (loaded.bg_board) {
      k.drawSprite({
        sprite: 'bg_board',
        pos: k.vec2(originX - pad, originY - pad),
        width: boardPx + pad * 2, height: boardPx + pad * 2,
      });
    } else {
      k.drawRect({
        pos: k.vec2(originX - pad, originY - pad),
        width: boardPx + pad * 2, height: boardPx + pad * 2,
        radius: 12, color: k.rgb(COLOR_BOARD[0], COLOR_BOARD[1], COLOR_BOARD[2]),
      });
      // 薄いセル枠
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          k.drawRect({
            pos: k.vec2(originX + c * cell + 2, originY + r * cell + 2),
            width: cell - 4, height: cell - 4, radius: Math.min(6, cell * 0.16),
            color: k.rgb(COLOR_CELL[0], COLOR_CELL[1], COLOR_CELL[2]), opacity: 0.6,
          });
        }
      }
    }
    // 宝石 (種別ごとに丸/角丸、画像があればスプライト)
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const g = gems[r][c];
        if (!g || g.size <= 0 || g.alpha <= 0) continue;
        const col = GEM_COLORS[g.kind];
        if (loaded['gem_' + GEM_KEYS[g.kind]]) {
          k.drawSprite({
            sprite: 'gem_' + GEM_KEYS[g.kind],
            pos: k.vec2(g.x, g.y), anchor: 'center',
            width: g.size, height: g.size, opacity: g.alpha,
          });
        } else if (g.kind % 2 === 0) {
          k.drawRect({
            pos: k.vec2(g.x - g.size / 2, g.y - g.size / 2),
            width: g.size, height: g.size, radius: g.size * 0.2,
            color: k.rgb(col[0], col[1], col[2]), opacity: g.alpha,
          });
        } else {
          k.drawCircle({
            pos: k.vec2(g.x, g.y), radius: g.size / 2,
            color: k.rgb(col[0], col[1], col[2]), opacity: g.alpha,
          });
        }
      }
    }
    // 選択ハイライト
    if (sel && state === S_IDLE) {
      k.drawRect({
        pos: k.vec2(originX + sel.c * cell + 2, originY + sel.r * cell + 2),
        width: cell - 4, height: cell - 4, radius: 6, fill: false,
        outline: { width: 3, color: k.rgb(COLOR_SELECT[0], COLOR_SELECT[1], COLOR_SELECT[2]) },
      });
    }
  });

  // ---- メインループ (ロジック更新) ----
  const hudEl = document.getElementById('hud');
  const fpsSamples = [];
  let hudTimer = 0;

  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);
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

    // タイトル点滅（アトラクト中のみ）
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
  });

  console.log('[KAPLAY] theme10 match-3 init ok.');
}
