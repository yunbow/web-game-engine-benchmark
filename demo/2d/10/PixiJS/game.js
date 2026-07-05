/* =========================================================================
 * テーマ10 マッチ3パズル（ロジック主体・大量トゥイーン）― PixiJS v8 実装
 * 仕様: SPEC.md (960x540, NxN 盤面, 6 種宝石, 状態機械 IDLE/SWAP/CLEAR/FALL)
 *
 * PixiJS は描画ライブラリのため、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker の deltaMS でデルタタイム駆動)
 *   - 状態機械 (IDLE / SWAP / CLEAR / FALL) と連鎖処理
 *   - マッチ判定 (横/縦 同種3連以上, 毎フレーム O(N^2) 全走査)
 *   - 決定的盤面生成 / 補充 / シャッフル (mulberry32, Math.random 不使用)
 *   - 宝石スプライトのプール再利用 (盤面リサイズをまたいで使い回す)
 *
 *   ★ 本テーマの比較対象 = 「手書きトゥイーンマネージャ」 ★
 *   PixiJS には Phaser の Tweens のような組込みトゥイーン機構が無い。
 *   そこで本実装では、進行中トゥイーンを配列で保持し、毎 Ticker フレーム
 *   deltaMS でイージング補間して進める小さなマネージャを自作している
 *   (関数 makeTweenManager)。HUD の "Active tweens" はこのマネージャが
 *   現在保持している本数で、落下/消滅が同時多発するほど増えるのが負荷の核。
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
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
const SWAP_TIME = 0.15;       // スワップ
const CLEAR_TIME = 0.2;       // 消滅 (縮小+フェード)
const FALL_PER_CELL = 0.2;    // 落下 1 セルあたりの基準時間
const AUTO_INTERVAL = 0.25;   // オートプレイの手の間隔 (秒)

// スコア
const SCORE_PER_GEM = 10;     // 消去数 × 10 × 連鎖係数

// 決定的乱数のシード
const SEED_BOARD = 20250615;  // 盤面生成 (リセット/リサイズで使い回す基底)
const SEED_REFILL = 99173;    // 落下補充の基底シード
const SEED_SHUFFLE = 51237;   // シャッフルの基底シード

// 状態
const S_IDLE = 'IDLE', S_SWAP = 'SWAP', S_CLEAR = 'CLEAR', S_FALL = 'FALL';

// 宝石フォールバック色 (種別 0..5 = 赤/青/緑/黄/紫/白)
const GEM_COLORS = [
  0xe2453b, // red
  0x3b82e2, // blue
  0x49c463, // green
  0xf2cf3c, // yellow
  0xa657e2, // purple
  0xe8edf5, // white
];
const GEM_KEYS = ['red', 'blue', 'green', 'yellow', 'purple', 'white'];

// 盤面背景 (暗い角丸) / キャンバス背景 (濃紺)
const COLOR_BG = 0x0d1322;       // 濃紺キャンバス
const COLOR_BOARD = 0x18223a;    // 盤面の暗い角丸
const COLOR_CELL = 0x101a30;     // セルの薄い枠
const COLOR_SELECT = 0xfff2a8;   // 選択ハイライト

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

// ---- イージング ------------------------------------------------------------
// 落下に少し加速感を与えるため easeOutQuad / easeInQuad を用意。
const easeLinear  = (t) => t;
const easeOutQuad = (t) => t * (2 - t);
const easeInQuad  = (t) => t * t;

// =========================================================================
// 手書きトゥイーンマネージャ (★本テーマの比較対象)
//   PixiJS には組込みトゥイーンが無いので、進行中のトゥイーンを配列で保持し、
//   毎フレーム deltaMS で進める最小実装を自作する。
//   1 トゥイーン = { obj, props:{key:{from,to}}, dur, t, ease, onUpdate, onComplete }
//   update(dt) で全件を進め、完了したものを除去 → onComplete を呼ぶ。
//   "同時進行トゥイーン数" がそのまま負荷指標 (HUD: Active tweens)。
// =========================================================================
function makeTweenManager() {
  const tweens = []; // 進行中トゥイーン
  let completedThisFrame = []; // dt 中に完了したトゥイーンの onComplete を後でまとめて呼ぶ

  function add(spec) {
    // spec: { target, props, duration, ease, onComplete }
    //   props 例: { x: 120, alpha: 0 } → 現在値を from として補間
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
      alive: true,
    };
    tweens.push(tw);
    return tw;
  }

  function update(dt) {
    completedThisFrame.length = 0;
    // 後ろから走査して splice を安全に行う。
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      tw.t += dt;
      let k = tw.t / tw.dur;
      let done = false;
      if (k >= 1) { k = 1; done = true; }
      const e = tw.ease(k);
      // 各プロパティを from→to で補間して target に書き戻す。
      for (const key in tw.props) {
        const p = tw.props[key];
        tw.target[key] = p.from + (p.to - p.from) * e;
      }
      if (done) {
        tweens.splice(i, 1);
        if (tw.onComplete) completedThisFrame.push(tw.onComplete);
      }
    }
    // onComplete は補間更新が全部済んでから呼ぶ (途中で配列を触っても安全)。
    for (let i = 0; i < completedThisFrame.length; i++) completedThisFrame[i]();
  }

  function clear() { tweens.length = 0; }
  const count = () => tweens.length;

  return { add, update, clear, count };
}

// ---- フォールバックテクスチャ生成 (Graphics→Texture) ----------------------
// 宝石は種別ごとに 64x64 の角丸矩形/丸を生成してキャッシュ。
// 実際の描画はセルサイズに合わせて Sprite を拡縮する (texture は固定 64px)。
const GEM_TEX_PX = 64;
function makeFallbackTextures(app) {
  const tex = {};
  const gen = (w, h, draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, width: w, height: h, resolution: 1 });
    gr.destroy();
    return t;
  };

  // 種別ごとに形を少し変えて色覚に頼らず識別しやすくする。
  //  0 赤=角丸四角 / 1 青=丸 / 2 緑=角丸四角 / 3 黄=丸 / 4 紫=角丸四角 / 5 白=丸
  for (let i = 0; i < GEM_TYPES; i++) {
    const col = GEM_COLORS[i];
    tex['gem_' + GEM_KEYS[i]] = gen(GEM_TEX_PX, GEM_TEX_PX, (gr) => {
      const m = 6, s = GEM_TEX_PX - m * 2;
      if (i % 2 === 0) {
        // 角丸四角タイプ
        gr.roundRect(m, m, s, s, 12).fill(col);
        gr.roundRect(m, m, s, s, 12).stroke({ width: 3, color: 0x000000, alpha: 0.35 });
        gr.roundRect(m + 8, m + 8, s * 0.4, s * 0.28, 6).fill({ color: 0xffffff, alpha: 0.35 });
      } else {
        // 丸タイプ
        const r = s / 2;
        gr.circle(GEM_TEX_PX / 2, GEM_TEX_PX / 2, r).fill(col);
        gr.circle(GEM_TEX_PX / 2, GEM_TEX_PX / 2, r).stroke({ width: 3, color: 0x000000, alpha: 0.35 });
        gr.ellipse(GEM_TEX_PX / 2 - 6, GEM_TEX_PX / 2 - 8, r * 0.42, r * 0.28).fill({ color: 0xffffff, alpha: 0.4 });
      }
    });
  }

  // 盤面背景タイル (暗い角丸セル風). 512x512 を盤面全体に伸ばして敷く。
  tex.bg_board = gen(512, 512, (gr) => {
    gr.rect(0, 0, 512, 512).fill(COLOR_BOARD);
    // 薄いグリッド感のあるノイズ風ドット
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        gr.roundRect(x * 64 + 6, y * 64 + 6, 52, 52, 8)
          .fill({ color: COLOR_CELL, alpha: 0.6 });
      }
    }
  });

  return tex;
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
    gem_red:    '../assets/gem_red.png',
    gem_blue:   '../assets/gem_blue.png',
    gem_green:  '../assets/gem_green.png',
    gem_yellow: '../assets/gem_yellow.png',
    gem_purple: '../assets/gem_purple.png',
    gem_white:  '../assets/gem_white.png',
    bg_board:   '../assets/bg_board.png',
  };
  const tex = { ...fallback };
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key];
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形フォールバック
    }
  }
  return tex;
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
    background: COLOR_BG,
    antialias: true,
    resolution: 1,
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  const tex = await loadTextures(app);
  const gemTex = GEM_KEYS.map((k) => tex['gem_' + k]);

  // ---- 表示レイヤ ----
  const boardBg = new PIXI.Sprite(tex.bg_board); // 盤面背景 (位置/サイズは layout で更新)
  app.stage.addChild(boardBg);

  const gemLayer = new PIXI.Container(); // 宝石スプライト
  app.stage.addChild(gemLayer);

  const selLayer = new PIXI.Graphics();  // 選択ハイライト枠
  app.stage.addChild(selLayer);

  // ---- トゥイーンマネージャ (★) ----
  const tweenMgr = makeTweenManager();

  // ====================================================================
  // 盤面状態
  //   grid[r][c] = 宝石種別 (0..5) または -1 (空き)
  //   各セルに対応する表示スプライトは sprites[r][c] (プールから割当)
  //   宝石の論理座標 (r,c) と描画座標 (x,y) は分離。トゥイーンは描画座標を動かす。
  // ====================================================================
  let N = N_INIT;
  let cell = 0;          // セル1辺 px
  let originX = 0, originY = 0; // 盤面左上の描画原点
  let grid = [];         // [r][c] -> type
  let sprites = [];      // [r][c] -> Sprite (or null)

  // 宝石スプライトのプール (盤面リサイズをまたいで再利用)。
  const spritePool = [];
  function getSprite() {
    let s = spritePool.pop();
    if (!s) {
      s = new PIXI.Sprite(gemTex[0]);
      s.anchor.set(0.5);
      gemLayer.addChild(s);
    }
    s.visible = true;
    s.alpha = 1;
    return s;
  }
  function releaseSprite(s) {
    if (!s) return;
    s.visible = false;
    spritePool.push(s);
  }

  // ---- レイアウト計算 (セルサイズ・原点) ----
  function computeLayout() {
    cell = Math.floor(Math.min(BOARD_SPAN / N, CELL_MAX));
    const boardPx = cell * N;
    originX = Math.floor((VIEW_W - boardPx) / 2);
    originY = Math.floor((VIEW_H - boardPx) / 2);
    // 盤面背景を盤面領域に少し余白をつけて敷く。
    const pad = Math.max(8, Math.floor(cell * 0.18));
    boardBg.x = originX - pad;
    boardBg.y = originY - pad;
    boardBg.width = boardPx + pad * 2;
    boardBg.height = boardPx + pad * 2;
  }

  // 論理セル (r,c) の中心描画座標。
  const cellCX = (c) => originX + c * cell + cell / 2;
  const cellCY = (r) => originY + r * cell + cell / 2;
  const gemDrawSize = () => cell * 0.86; // セルに対する宝石描画サイズ

  // スプライトの見た目をセルサイズへ反映。
  function applySpriteSize(s) {
    const sz = gemDrawSize();
    s.width = sz; s.height = sz;
  }

  // ---- マッチ判定 (毎回 O(N^2) 全走査) ----
  // 横/縦に同種3連以上の連続を検出し、消すべきセルの集合を返す。
  function findMatches() {
    const marked = []; // [r][c] bool
    for (let r = 0; r < N; r++) { marked[r] = new Array(N).fill(false); }
    let any = false;

    // --- 横 (各行) ---
    for (let r = 0; r < N; r++) {
      let runStart = 0;
      for (let c = 1; c <= N; c++) {
        const same = c < N && grid[r][c] === grid[r][runStart] && grid[r][runStart] >= 0;
        if (!same) {
          const len = c - runStart;
          if (len >= 3) { for (let k = runStart; k < c; k++) { marked[r][k] = true; any = true; } }
          runStart = c;
        }
      }
    }
    // --- 縦 (各列) ---
    for (let c = 0; c < N; c++) {
      let runStart = 0;
      for (let r = 1; r <= N; r++) {
        const same = r < N && grid[r][c] === grid[runStart][c] && grid[runStart][c] >= 0;
        if (!same) {
          const len = r - runStart;
          if (len >= 3) { for (let k = runStart; k < r; k++) { marked[k][c] = true; any = true; } }
          runStart = r;
        }
      }
    }
    return any ? marked : null;
  }

  // 指定セルへ宝石を置いたとき、横/縦に既存マッチが生じるかを判定 (生成時の重複回避用)。
  // grid を直接読むので、generateBoard では「左と上 2 つ前まで同種か」を見る軽量版。
  function wouldMatchAt(g, r, c, type) {
    // 横: c-1, c-2 が同種
    if (c >= 2 && g[r][c - 1] === type && g[r][c - 2] === type) return true;
    // 縦: r-1, r-2 が同種
    if (r >= 2 && g[r - 1][c] === type && g[r - 2][c] === type) return true;
    return false;
  }

  // ---- 盤面の決定的生成 (初期マッチ無し) ----
  // 左上から順に、その時点でマッチを作らない種別を決定的に選んで埋める。
  function generateBoard() {
    const rnd = mulberry32((SEED_BOARD ^ (N * 2654435761)) >>> 0);
    const g = [];
    for (let r = 0; r < N; r++) {
      g[r] = new Array(N);
      for (let c = 0; c < N; c++) {
        // 候補種別をシード順に試し、マッチしない最初のものを採用。
        let pick = Math.floor(rnd() * GEM_TYPES);
        for (let tries = 0; tries < GEM_TYPES; tries++) {
          const t = (pick + tries) % GEM_TYPES;
          if (!wouldMatchAt(g, r, c, t)) { g[r][c] = t; pick = t; break; }
          g[r][c] = t; // 全部マッチする事は無いが保険で最後の候補を入れておく
        }
      }
    }
    return g;
  }

  // ---- 盤面構築 (grid を作り、スプライトをプールから割当て初期配置) ----
  function buildBoard() {
    // 既存スプライトをプールへ返却。
    if (sprites.length) {
      for (let r = 0; r < sprites.length; r++) {
        for (let c = 0; c < sprites[r].length; c++) releaseSprite(sprites[r][c]);
      }
    }
    tweenMgr.clear();
    computeLayout();
    grid = generateBoard();
    sprites = [];
    for (let r = 0; r < N; r++) {
      sprites[r] = [];
      for (let c = 0; c < N; c++) {
        const s = getSprite();
        s.texture = gemTex[grid[r][c]];
        applySpriteSize(s);
        s.x = cellCX(c);
        s.y = cellCY(r);
        sprites[r][c] = s;
      }
    }
  }

  // ---- ゲーム状態 ----
  let state = S_IDLE;
  let chain = 0;        // 現在の連鎖段数
  let score = 0;
  let moves = 0;        // 実行した手数 (有効/無効問わず確定したスワップ)
  let auto = true;      // オートプレイ (初期 ON)
  let autoTimer = 0;    // 次の自動手までの残り時間
  let shuffleCount = 0; // シャッフル回数 (シード変化用)

  // タイトル/アトラクト状態 (false=デモ中・ユーザー操作無効)
  let started = false, blinkT = 0;
  const titleEl = document.getElementById('title');

  // 選択中セル (手動スワップ)
  let sel = null; // {r,c}

  // ---- 状態遷移ヘルパ ------------------------------------------------------

  // スワップ開始 (a,b は隣接セル {r,c})。pendingSwap に元の手を覚えておき
  // マッチが無ければ revert する。
  let pendingSwap = null; // {a, b, revert:bool}
  function beginSwap(a, b, isRevert) {
    state = S_SWAP;
    pendingSwap = { a, b, revert: !!isRevert };
    const sa = sprites[a.r][a.c];
    const sb = sprites[b.r][b.c];
    const ax = cellCX(a.c), ay = cellCY(a.r);
    const bx = cellCX(b.c), by = cellCY(b.r);
    let remaining = 2;
    const done = () => { if (--remaining === 0) onSwapTweensDone(); };
    tweenMgr.add({ target: sa, props: { x: bx, y: by }, duration: SWAP_TIME, ease: easeOutQuad, onComplete: done });
    tweenMgr.add({ target: sb, props: { x: ax, y: ay }, duration: SWAP_TIME, ease: easeOutQuad, onComplete: done });
  }

  // grid と sprites を 2 セル分入れ替える (論理スワップ)。
  function swapCells(a, b) {
    const tg = grid[a.r][a.c]; grid[a.r][a.c] = grid[b.r][b.c]; grid[b.r][b.c] = tg;
    const ts = sprites[a.r][a.c]; sprites[a.r][a.c] = sprites[b.r][b.c]; sprites[b.r][b.c] = ts;
  }

  function onSwapTweensDone() {
    const { a, b, revert } = pendingSwap;
    // トゥイーン完了時点で論理スワップを確定。
    swapCells(a, b);
    pendingSwap = null;
    if (revert) {
      // revert スワップが終わったら IDLE へ。
      state = S_IDLE;
      return;
    }
    // 通常スワップ: マッチがあれば連鎖開始、無ければ元へ戻す (無効手)。
    const m = findMatches();
    if (m) {
      chain = 0;
      startClear(m);
    } else {
      beginSwap(a, b, true); // 戻す
    }
  }

  // ---- CLEAR: マッチセルを縮小+フェードして消す ----
  function startClear(marked) {
    state = S_CLEAR;
    chain += 1;
    let cleared = 0;
    let remaining = 0;
    const toRemove = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (marked[r][c]) { cleared++; toRemove.push({ r, c }); }
      }
    }
    // スコア = 消去数 × 10 × 連鎖係数
    score += cleared * SCORE_PER_GEM * chain;

    remaining = toRemove.length;
    if (remaining === 0) { state = S_IDLE; return; }
    for (const { r, c } of toRemove) {
      const s = sprites[r][c];
      grid[r][c] = -1;       // 論理的に空ける
      sprites[r][c] = null;
      // 消滅トゥイーン: scale を 0 に, alpha を 0 に縮小フェード。
      const done = () => {
        releaseSprite(s);
        if (--remaining === 0) startFall();
      };
      tweenMgr.add({
        target: s,
        props: { width: 0, height: 0, alpha: 0 },
        duration: CLEAR_TIME,
        ease: easeInQuad,
        onComplete: done,
      });
    }
  }

  // ---- FALL: 空きへ上の宝石を落とし、上端から決定的補充。セル単位でトゥイーン。 ----
  function startFall() {
    state = S_FALL;
    // 補充は (盤面シード, 連鎖, 列) から決定的に種別を生成。
    const rnd = mulberry32((SEED_REFILL ^ (N * 40503) ^ (moves * 2246822519) ^ (chain * 3266489917)) >>> 0);

    let fallTweens = 0;
    const onOne = () => { if (--fallTweens === 0) afterFall(); };

    // 各列ごとに: 下から詰める。空きを数えながら、上の宝石を下へ移す。
    for (let c = 0; c < N; c++) {
      let writeRow = N - 1; // 詰める先 (下から)
      for (let r = N - 1; r >= 0; r--) {
        if (grid[r][c] >= 0) {
          if (writeRow !== r) {
            // 宝石を (r,c) → (writeRow,c) へ移動 (論理 + 表示トゥイーン)。
            grid[writeRow][c] = grid[r][c];
            const s = sprites[r][c];
            sprites[writeRow][c] = s;
            grid[r][c] = -1;
            sprites[r][c] = null;
            const dist = writeRow - r;
            fallTweens++;
            tweenMgr.add({
              target: s,
              props: { y: cellCY(writeRow) },
              duration: FALL_PER_CELL * dist, // 落下距離に比例
              ease: easeInQuad,               // 加速付き
              onComplete: onOne,
            });
          }
          writeRow--;
        }
      }
      // writeRow から上 (0 まで) は空き → 上端から新規宝石を補充。
      // 落下開始位置を盤面上端の外側に置き、所定セルへ落とす。
      for (let r = writeRow; r >= 0; r--) {
        const type = Math.floor(rnd() * GEM_TYPES);
        grid[r][c] = type;
        const s = getSprite();
        s.texture = gemTex[type];
        applySpriteSize(s);
        s.x = cellCX(c);
        // 画面外上方から登場 (補充ごとに段差をつけて自然に)。
        s.y = cellCY(r) - (writeRow + 2) * cell;
        sprites[r][c] = s;
        const dist = (cellCY(r) - s.y) / cell;
        fallTweens++;
        tweenMgr.add({
          target: s,
          props: { y: cellCY(r) },
          duration: FALL_PER_CELL * Math.max(dist, 1),
          ease: easeInQuad,
          onComplete: onOne,
        });
      }
    }

    if (fallTweens === 0) afterFall(); // 落ちるものが無い (理論上起きにくいが保険)
  }

  // 落下完了後: 新たなマッチがあれば CLEAR へ戻り連鎖, 無ければ IDLE。
  function afterFall() {
    const m = findMatches();
    if (m) {
      startClear(m); // 連鎖 (chain は startClear 内で++)
    } else {
      chain = 0;
      state = S_IDLE;
    }
  }

  // ====================================================================
  // 入力: クリック2回で隣接スワップ (app.canvas の pointer イベント)
  // ====================================================================
  function pointerToCell(ev) {
    // app.canvas は CSS で縮小表示されることがあるため、論理座標へ換算する。
    const rect = app.canvas.getBoundingClientRect();
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

  app.canvas.addEventListener('pointerdown', (ev) => {
    if (!started) return;         // アトラクト中はユーザーのスワップ操作を無効化
    if (state !== S_IDLE) return; // 演出中は無視
    const cellPos = pointerToCell(ev);
    if (!cellPos) return;
    if (!sel) {
      sel = cellPos;
    } else if (sel.r === cellPos.r && sel.c === cellPos.c) {
      sel = null; // 同じセルを再クリックで選択解除
    } else if (isAdjacent(sel, cellPos)) {
      const a = sel, b = cellPos;
      sel = null;
      moves += 1;
      beginSwap(a, b, false);
    } else {
      sel = cellPos; // 隣接でなければ選択し直し
    }
  });

  // ====================================================================
  // オートプレイ: 0.25s 間隔で「マッチを生む隣接スワップ」を左上から探索。
  //   有効手が無ければ決定的にシャッフル。
  // ====================================================================

  // (r,c) と (r2,c2) を入れ替えたらマッチが生じるか? grid を一時入替して判定。
  function swapMakesMatch(r, c, r2, c2) {
    const t1 = grid[r][c], t2 = grid[r2][c2];
    grid[r][c] = t2; grid[r2][c2] = t1;
    const m = findMatches();
    grid[r][c] = t1; grid[r2][c2] = t2; // 元に戻す
    return !!m;
  }

  // 左上から走査し、最初に見つかった有効な隣接スワップを返す (決定的)。
  function findFirstValidSwap() {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        // 右隣
        if (c + 1 < N && swapMakesMatch(r, c, r, c + 1)) return { a: { r, c }, b: { r, c: c + 1 } };
        // 下隣
        if (r + 1 < N && swapMakesMatch(r, c, r + 1, c)) return { a: { r, c }, b: { r: r + 1, c } };
      }
    }
    return null;
  }

  // 決定的シャッフル: 全セルの種別を mulberry32 で並べ替え、マッチが残らないよう微調整。
  function deterministicShuffle() {
    shuffleCount++;
    const rnd = mulberry32((SEED_SHUFFLE ^ (N * 16807) ^ (shuffleCount * 2654435761)) >>> 0);
    // 種別配列を集めて Fisher-Yates (決定的) で並べ替え。
    const flat = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flat.push(grid[r][c]);
    for (let i = flat.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = flat[i]; flat[i] = flat[j]; flat[j] = t;
    }
    let k = 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        let type = flat[k++];
        // 並べた結果が即マッチにならないよう、必要なら種別をずらす (決定的)。
        let guard = 0;
        while (wouldMatchAt(grid, r, c, type) && guard < GEM_TYPES) { type = (type + 1) % GEM_TYPES; guard++; }
        grid[r][c] = type;
        const s = sprites[r][c];
        s.texture = gemTex[type];
        s.x = cellCX(c); s.y = cellCY(r);
        applySpriteSize(s);
      }
    }
  }

  function autoStep() {
    const sw = findFirstValidSwap();
    if (sw) {
      moves += 1;
      beginSwap(sw.a, sw.b, false);
    } else {
      deterministicShuffle(); // 詰み → 決定的シャッフル
    }
  }

  // ====================================================================
  // 盤面リサイズ / リセット
  // ====================================================================
  function setBoardN(newN) {
    newN = clamp(newN, N_MIN, N_MAX);
    if (newN === N && sprites.length) return;
    N = newN;
    state = S_IDLE;
    chain = 0;
    sel = null;
    pendingSwap = null;
    autoTimer = 0;
    buildBoard();
  }

  function resetBoard() {
    state = S_IDLE;
    chain = 0;
    score = 0;
    moves = 0;
    sel = null;
    pendingSwap = null;
    autoTimer = 0;
    shuffleCount = 0;
    buildBoard();
  }

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す。
  function startGame() {
    started = true;
    resetBoard();
    titleEl.style.display = 'none';
  }

  // ---- 入力 (キーボード) ----
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && !started) {
      startGame();
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      auto = !auto;
      autoTimer = 0;
      e.preventDefault();
    } else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      setBoardN(N + N_STEP);
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      setBoardN(N - N_STEP);
      e.preventDefault();
    } else if (e.code === 'KeyR') {
      resetBoard();
      e.preventDefault();
    }
  });

  // ---- 初期盤面 ----
  buildBoard();

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // ---- メインループ ----
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05); // スパイク抑制

    // --- FPS 移動平均 (直近60フレーム) ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // --- トゥイーン進行 (★ 本テーマの核) ---
    // この update が完了コールバックを通じて状態遷移を駆動する
    // (SWAP→CLEAR→FALL→CLEAR... の連鎖)。
    tweenMgr.update(dt);

    // --- オートプレイ (IDLE のときだけ手を打つ。アトラクト中は auto トグルに関わらずデモAIを常時駆動) ---
    if ((auto || !started) && state === S_IDLE) {
      autoTimer -= dt;
      if (autoTimer <= 0) {
        autoTimer = AUTO_INTERVAL;
        autoStep();
      }
    }

    // --- 選択ハイライト描画 ---
    selLayer.clear();
    if (sel && state === S_IDLE) {
      const x = originX + sel.c * cell;
      const y = originY + sel.r * cell;
      selLayer.roundRect(x + 2, y + 2, cell - 4, cell - 4, 6)
        .stroke({ width: 3, color: COLOR_SELECT, alpha: 0.95 });
    }

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }

    // --- HUD (約120msごと更新) ---
    hudTimer += dtMs;
    if (hudTimer >= 120) {
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

  // three.js 版に合わせ、キャンバスは 960x540 固定（縮小スケールなし）。
  console.log('[PixiJS v8] theme10 match-3 init ok. renderer =', app.renderer.type);
})();
