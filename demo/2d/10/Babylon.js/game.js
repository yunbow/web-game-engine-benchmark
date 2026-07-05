"use strict";

/* =========================================================================
 * テーマ10: マッチ3パズル (ロジック主体・軽描画 × 大量トゥイーン) ― Babylon.js 版
 *
 * 3Dエンジン Babylon.js で 2D マッチ3パズル (Bejeweled/ツムツム風) を実装する。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を px 等倍で再現。
 *  - 宝石は種別ごとの SpriteManager + スプライトプールで描画 (テクスチャ無→Disc/Plane)。
 *  - 状態機械 IDLE / SWAP / CLEAR / FALL を回し、消去→落下→補充→連鎖を処理する。
 *  - トゥイーンは Babylon.Animation ではなく「自前の軽量トゥイーンマネージャ」を採用。
 *    落下/消滅で数百の短命トゥイーンが同時多発するため、dt 駆動の配列管理が最も
 *    計測しやすく軽い (README 参照: Babylon.Animation を使う idiomatic 版との対比)。
 *  - マッチ判定は毎フレームではなく状態遷移時に O(N²) で盤面全走査する。
 *  - 乱数は mulberry32 の固定シードのみ (Math.random 不使用) → 盤面/補充/手が決定的。
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;

const GEM_TYPES = 6;                 // 宝石種別数
const N_INIT = 12;                   // 盤面サイズ初期値
const N_STEP = 2;                    // +/- 増減
const N_MIN = 6;
const N_MAX = 40;
const BOARD_MAX_PX = 520;            // 盤面が収まる正方形領域
const CELL_MAX = 56;                 // セル1辺の上限 px

// トゥイーン時間 (秒)
const T_SWAP = 0.15;                 // スワップ
const T_CLEAR = 0.20;                // 消滅 (縮小+フェード)
const T_FALL_PER_CELL = 0.20;        // 落下: 1セルあたりの基準時間

const AUTO_INTERVAL = 0.25;          // オートプレイ間隔 (秒)
const SCORE_PER_GEM = 10;            // 消去1個あたりのスコア (× 連鎖係数)

// 状態
const S_IDLE = "IDLE", S_SWAP = "SWAP", S_CLEAR = "CLEAR", S_FALL = "FALL";

/* ---------- アセット定義 ---------- */
// 種別 index 0..5 = red/blue/green/yellow/purple/white
const ASSET_DIR = "../assets/";
const GEM_DEFS = [
  { key: "red",    file: "gem_red.png",    fallback: "#e8403a", shape: "circle" },
  { key: "blue",   file: "gem_blue.png",   fallback: "#3a78e8", shape: "circle" },
  { key: "green",  file: "gem_green.png",  fallback: "#3ac85a", shape: "circle" },
  { key: "yellow", file: "gem_yellow.png", fallback: "#f0c030", shape: "circle" },
  { key: "purple", file: "gem_purple.png", fallback: "#b048d8", shape: "circle" },
  { key: "white",  file: "gem_white.png",  fallback: "#e8e8f0", shape: "circle" },
];
const GEM_TEX_PX = 64;               // 推奨アセット px (Sprite manager のセルサイズ)
const BG_DEF = { file: "bg_board.png", fallback: "#0a0a1e" };

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じ盤面/補充/手を生成する。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
 *  Babylon セットアップ
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const titleEl = document.getElementById("title");

// タイトル/アトラクト状態 (false=デモ中・ユーザー操作無効・デモAI常時駆動)
let started = false, blinkT = 0;
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = BABYLON.Color4.FromHexString(BG_DEF.fallback + "ff"); // 濃紺 (背景フォールバック)
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: x:0..960 右へ / y:0..540 下へ (orthoTop<orthoBottom で y 下向き) ---
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* ---------- テクスチャ存在チェック ---------- */
// SpriteManager は読込失敗時に黒テクスチャになるので、事前に Image で存在確認する。
function checkImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/* ---------- 宝石スプライト/メッシュ プール ----------
 * 宝石は種別ごとに SpriteManager を1つ持ち、その下にスプライトプールを置く。
 * テクスチャが無い場合は種別色の Disc(円) をテンプレートから clone してプールする。
 * いずれも統一ラッパ { setPos, setSize, setAlpha, setVisible } で扱う。
 */
const gemManagers = [];     // type -> SpriteManager or null
let texturesOk = false;     // 6種すべて読めたか

const fallbackMats = [];    // type -> StandardMaterial
const fallbackTemplates = []; // type -> Disc mesh template

function buildFallbackTemplate(type) {
  if (fallbackTemplates[type]) return fallbackTemplates[type];
  const def = GEM_DEFS[type];
  const m = new BABYLON.StandardMaterial("gm_" + def.key, scene);
  const c = BABYLON.Color3.FromHexString(def.fallback);
  m.emissiveColor = c;
  m.diffuseColor = c;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.backFaceCulling = false;
  // フェード用に α を扱えるよう alpha モードを有効化
  m.alpha = 1.0;
  fallbackMats[type] = m;

  let mesh;
  if (def.shape === "circle") {
    mesh = BABYLON.MeshBuilder.CreateDisc("gt_" + def.key, { radius: 0.5, tessellation: 20 }, scene);
  } else {
    mesh = BABYLON.MeshBuilder.CreatePlane("gt_" + def.key, { width: 1, height: 1 }, scene);
  }
  mesh.material = m;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  fallbackTemplates[type] = mesh;
  return mesh;
}

// 1つの宝石ビジュアル (Sprite または clone した Disc) を作る統一ラッパ。
function createGemVisual(type) {
  if (texturesOk && gemManagers[type]) {
    const sp = new BABYLON.Sprite("gem", gemManagers[type]);
    sp.isPickable = false;
    return {
      kind: "sprite", obj: sp, type,
      setPos(x, y, z) { sp.position.x = x; sp.position.y = y; sp.position.z = (z == null ? 0 : z); },
      setSize(w, h) { sp.width = w; sp.height = h; },
      setAlpha(a) { sp.color.a = a; },
      setVisible(b) { sp.isVisible = b; },
    };
  } else {
    // フォールバック: clone した Disc。α は per-instance に visibility を使う
    // (Disc はマテリアル共有なので、material.alpha でなく mesh.visibility でフェードする)。
    const mesh = buildFallbackTemplate(type).clone("gc_" + type);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    return {
      kind: "mesh", obj: mesh, type,
      setPos(x, y, z) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = (z == null ? 0 : z); },
      setSize(w, h) { mesh.scaling.x = w; mesh.scaling.y = h; },
      setAlpha(a) { mesh.visibility = a; },
      setVisible(b) { mesh.setEnabled(b); },
    };
  }
}

/* ---------- 盤面背景 (暗い角丸風の矩形) ---------- */
let boardBgMesh = null;
function buildBoardBg() {
  const m = new BABYLON.StandardMaterial("boardbg", scene);
  m.emissiveColor = BABYLON.Color3.FromHexString("#181830");
  m.diffuseColor = m.emissiveColor;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  const mesh = BABYLON.MeshBuilder.CreatePlane("boardBg", { width: 1, height: 1 }, scene);
  mesh.material = m;
  mesh.isPickable = false;
  boardBgMesh = mesh;
}

// 選択中セルのハイライト枠 (1枚を使い回す)
let selMesh = null;
function buildSelHighlight() {
  const m = new BABYLON.StandardMaterial("selmat", scene);
  m.emissiveColor = BABYLON.Color3.FromHexString("#ffffff");
  m.diffuseColor = m.emissiveColor;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.alpha = 0.35;
  const mesh = BABYLON.MeshBuilder.CreatePlane("sel", { width: 1, height: 1 }, scene);
  mesh.material = m;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  selMesh = mesh;
}

/* =========================================================================
 *  軽量トゥイーンマネージャ
 *  - 各トゥイーンは { obj, props:[{key, from, to}], t, dur, ease, onDone }。
 *  - update(dt) で全件を進め、完了分を除去。アクティブ件数を HUD に出す。
 *  - obj は宝石セル (Cell)。props は "x"/"y"/"scale"/"alpha" 等を直接書き換える。
 *  - Babylon.Animation を使わない理由は README に記載 (大量短命トゥイーンの計測簡便性)。
 * ========================================================================= */
function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
function easeInQuad(t) { return t * t; }

const tweens = [];
function addTween(obj, props, dur, ease, onDone) {
  tweens.push({ obj, props, t: 0, dur, ease: ease || easeOutQuad, onDone, dead: false });
}
function updateTweens(dt) {
  if (tweens.length === 0) return;
  // このフレーム開始時点の件数だけを進める。onDone コールバック内で次状態の
  // トゥイーンが addTween されても (連鎖の CLEAR→FALL など)、それは末尾に積まれ
  // 次フレームから進む。これで同フレーム二重進行を防ぐ。
  const count = tweens.length;
  let write = 0;
  for (let i = 0; i < count; i++) {
    const tw = tweens[i];
    tw.t += dt;
    let k = tw.dur > 0 ? tw.t / tw.dur : 1;
    if (k >= 1) k = 1;
    const e = tw.ease(k);
    const o = tw.obj;
    for (let j = 0; j < tw.props.length; j++) {
      const p = tw.props[j];
      o[p.key] = p.from + (p.to - p.from) * e;
    }
    if (k >= 1) {
      if (tw.onDone) tw.onDone();
      // 除去 (write を進めない)
    } else {
      tweens[write++] = tw;
    }
  }
  // count 以降に onDone 中で積まれた新規トゥイーンを前へ詰める
  for (let i = count; i < tweens.length; i++) tweens[write++] = tweens[i];
  tweens.length = write;
}
function activeTweenCount() { return tweens.length; }

/* =========================================================================
 *  ゲーム状態
 * ========================================================================= */
const Game = {
  N: N_INIT,
  cell: 0,        // セル1辺 px
  originX: 0,     // 盤面左上 x (px)
  originY: 0,     // 盤面左上 y (px)
  board: null,    // type[] 長さ N*N (-1 = 空)
  cells: null,    // Cell[] 長さ N*N (描画用ビジュアル, board と添字対応)
  state: S_IDLE,
  chain: 0,
  score: 0,
  moves: 0,
  auto: true,     // オートプレイ (初期 ON)
  autoTimer: 0,
  // 入力 (手動スワップ)
  selR: -1, selC: -1,
  // SWAP 中の情報
  swap: null,     // {a:{r,c}, b:{r,c}, revert:bool}
  // PRNG (補充/シャッフル用。盤面再生成のたびに作り直す)
  rndRefill: null,
};

// セルビジュアル: トゥイーン対象。x,y は中心 px / scale 1=セル全体 / alpha
function makeCell(type) {
  const v = createGemVisual(type);
  return { type, vis: v, x: 0, y: 0, scale: 1, alpha: 1 };
}

const idx = (r, c) => r * Game.N + c;

/* ---------- 盤面レイアウト (中央配置) ---------- */
function computeLayout() {
  Game.cell = Math.floor(Math.min(BOARD_MAX_PX / Game.N, CELL_MAX));
  const boardPx = Game.cell * Game.N;
  Game.originX = Math.floor((VIEW_W - boardPx) / 2);
  Game.originY = Math.floor((VIEW_H - boardPx) / 2);
}
function cellCenterX(c) { return Game.originX + c * Game.cell + Game.cell / 2; }
function cellCenterY(r) { return Game.originY + r * Game.cell + Game.cell / 2; }

/* =========================================================================
 *  マッチ判定 (O(N²) 全走査)
 *  - 横/縦に同種3つ以上連続を検出し、消去対象セルの bool マスクを返す。
 *  - 連続検出は各行/各列を1パスで走る素直な実装。
 * ========================================================================= */
function findMatches(board, N) {
  const mark = new Uint8Array(N * N); // 1 = 消去対象
  let any = false;

  // --- 横方向 ---
  for (let r = 0; r < N; r++) {
    let runStart = 0;
    for (let c = 1; c <= N; c++) {
      const prev = board[r * N + (c - 1)];
      const cur = (c < N) ? board[r * N + c] : -2; // 末尾で必ず切れる
      if (cur !== prev || prev < 0) {
        const len = c - runStart;
        if (prev >= 0 && len >= 3) {
          for (let k = runStart; k < c; k++) { mark[r * N + k] = 1; any = true; }
        }
        runStart = c;
      }
    }
  }
  // --- 縦方向 ---
  for (let c = 0; c < N; c++) {
    let runStart = 0;
    for (let r = 1; r <= N; r++) {
      const prev = board[(r - 1) * N + c];
      const cur = (r < N) ? board[r * N + c] : -2;
      if (cur !== prev || prev < 0) {
        const len = r - runStart;
        if (prev >= 0 && len >= 3) {
          for (let k = runStart; k < r; k++) { mark[k * N + c] = 1; any = true; }
        }
        runStart = r;
      }
    }
  }
  return any ? mark : null;
}

// 指定盤面が「位置(r,c)に type を置いたとき横/縦3連を作るか」を判定 (初期生成の禁止用)。
function wouldMatchAt(board, N, r, c, type) {
  // 横: 左2つ
  if (c >= 2 && board[r * N + c - 1] === type && board[r * N + c - 2] === type) return true;
  // 縦: 上2つ
  if (r >= 2 && board[(r - 1) * N + c] === type && board[(r - 2) * N + c] === type) return true;
  return false;
}

/* =========================================================================
 *  盤面生成 (初期マッチ無し) / セルビジュアル再構築
 * ========================================================================= */
function disposeAllCells() {
  if (!Game.cells) return;
  for (const cell of Game.cells) {
    if (cell && cell.vis) {
      if (cell.vis.kind === "sprite") cell.vis.obj.dispose();
      else cell.vis.obj.dispose();
    }
  }
}

function buildBoard() {
  const N = Game.N;
  computeLayout();
  // 盤面 PRNG (シードは N に依存させて N ごとに決定的)
  const genRnd = mulberry32(0x5EED ^ (N * 2654435761 >>> 0));
  Game.rndRefill = mulberry32(0xFA11 ^ (N * 40503 >>> 0));

  const board = new Int16Array(N * N);
  // 既存マッチが出ないように、各セルで禁止種を避けて決定的に置く。
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      let type = Math.floor(genRnd() * GEM_TYPES);
      // 禁止種に当たったら次の種へずらす (有限回で必ず収束: 種6 / 禁止は最大2)
      let guard = 0;
      while (wouldMatchAt(board, N, r, c, type) && guard < GEM_TYPES) {
        type = (type + 1) % GEM_TYPES;
        guard++;
      }
      board[r * N + c] = type;
    }
  }
  Game.board = board;

  // ビジュアル構築
  disposeAllCells();
  Game.cells = new Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const cell = makeCell(board[r * N + c]);
      cell.x = cellCenterX(c);
      cell.y = cellCenterY(r);
      cell.scale = 1;
      cell.alpha = 1;
      Game.cells[r * N + c] = cell;
    }
  }

  // 背景パネルを盤面サイズに合わせる
  const boardPx = Game.cell * N;
  if (boardBgMesh) {
    boardBgMesh.scaling.x = boardPx + Game.cell * 0.3;
    boardBgMesh.scaling.y = boardPx + Game.cell * 0.3;
    boardBgMesh.position.x = Game.originX + boardPx / 2;
    boardBgMesh.position.y = Game.originY + boardPx / 2;
    boardBgMesh.position.z = 5; // 奥
  }

  Game.state = S_IDLE;
  Game.chain = 0;
  Game.selR = -1; Game.selC = -1;
  Game.swap = null;
  if (selMesh) selMesh.setEnabled(false);
}

// 全セルビジュアルの位置/サイズ/αを board と Cell から描画へ反映する。
function syncCellVisual(cell) {
  const sz = Game.cell * cell.scale * 0.92; // セルより少し小さく (隙間)
  cell.vis.setSize(sz, sz);
  cell.vis.setPos(cell.x, cell.y, 0);
  cell.vis.setAlpha(cell.alpha);
  cell.vis.setVisible(cell.alpha > 0.01 && cell.type >= 0);
}

/* =========================================================================
 *  状態機械: SWAP / CLEAR / FALL
 * ========================================================================= */

// 2セルが隣接 (上下左右) か
function isAdjacent(r1, c1, r2, c2) {
  return (Math.abs(r1 - r2) + Math.abs(c1 - c2)) === 1;
}

// スワップ開始: 2セルの位置をトゥイーンで入れ替える。
function startSwap(r1, c1, r2, c2, revertCheck) {
  const N = Game.N;
  const a = Game.cells[r1 * N + c1];
  const b = Game.cells[r2 * N + c2];
  Game.state = S_SWAP;
  Game.swap = { a: { r: r1, c: c1 }, b: { r: r2, c: c2 }, revert: false, revertCheck };
  let remaining = 2;
  const done = () => { if (--remaining === 0) onSwapTweenDone(); };
  addTween(a, [
    { key: "x", from: a.x, to: cellCenterX(c2) },
    { key: "y", from: a.y, to: cellCenterY(r2) },
  ], T_SWAP, easeOutQuad, done);
  addTween(b, [
    { key: "x", from: b.x, to: cellCenterX(c1) },
    { key: "y", from: b.y, to: cellCenterY(r1) },
  ], T_SWAP, easeOutQuad, done);
}

function onSwapTweenDone() {
  const N = Game.N;
  const { a, b } = Game.swap;
  // 盤面配列上で型を入れ替え、cells 配列の参照も入れ替える。
  const ia = a.r * N + a.c, ib = b.r * N + b.c;
  const ta = Game.board[ia], tb = Game.board[ib];
  Game.board[ia] = tb; Game.board[ib] = ta;
  const ca = Game.cells[ia]; Game.cells[ia] = Game.cells[ib]; Game.cells[ib] = ca;

  // マッチ判定。無ければ revert (無効手)。
  if (Game.swap.revertCheck) {
    const mark = findMatches(Game.board, N);
    if (!mark) {
      // 元に戻す (revertCheck=false で再スワップ → 戻ったら IDLE)
      Game.swap = null;
      startSwap(a.r, a.c, b.r, b.c, false);
      return;
    }
    // マッチあり → 手として確定し CLEAR へ
    Game.moves++;
    Game.chain = 0;
    Game.swap = null;
    enterClear(mark);
  } else {
    // revert 後 (無効手の戻し完了) → IDLE
    Game.swap = null;
    Game.state = S_IDLE;
  }
}

// CLEAR: mark のセルを縮小+フェードで消す。完了後 FALL へ。
function enterClear(mark) {
  const N = Game.N;
  Game.state = S_CLEAR;
  Game.chain++;
  let cleared = 0;
  let remaining = 0;
  for (let i = 0; i < N * N; i++) {
    if (mark[i]) {
      cleared++;
      const cell = Game.cells[i];
      remaining++;
      addTween(cell, [
        { key: "scale", from: cell.scale, to: 0.05 },
        { key: "alpha", from: cell.alpha, to: 0.0 },
      ], T_CLEAR, easeInQuad, () => {
        // 盤面から除去 (空 = -1)
        Game.board[i] = -1;
        cell.type = -1;
        cell.vis.setVisible(false);
        if (--remaining === 0) afterClear();
      });
    }
  }
  // スコア加算: 消去数 × 10 × 連鎖係数
  Game.score += cleared * SCORE_PER_GEM * Game.chain;
  if (remaining === 0) afterClear(); // 念のため
}

function afterClear() {
  enterFall();
}

/* FALL: 各列で空きを詰め、上から決定的補充。落下は「セル単位」でトゥイーンを張る。 */
function enterFall() {
  const N = Game.N;
  Game.state = S_FALL;
  let remaining = 0;

  for (let c = 0; c < N; c++) {
    // 下から詰める: 生存セルを下端から積み上げ、空いた上部を補充する。
    let writeRow = N - 1;
    for (let r = N - 1; r >= 0; r--) {
      const i = r * N + c;
      if (Game.board[i] >= 0) {
        const dst = writeRow * N + c;
        if (dst !== i) {
          // セル(型+ビジュアル)を dst へ移動。落下距離に比例した時間でトゥイーン。
          const cell = Game.cells[i];
          Game.board[dst] = Game.board[i];
          Game.board[i] = -1;
          Game.cells[dst] = cell;
          Game.cells[i] = null;
          const fromY = cell.y;
          const toY = cellCenterY(writeRow);
          const dist = Math.abs(writeRow - r);
          const dur = T_FALL_PER_CELL * Math.max(1, dist);
          remaining++;
          addTween(cell, [{ key: "y", from: fromY, to: toY }], dur, easeInQuad,
            () => { if (--remaining === 0) afterFall(); });
        }
        writeRow--;
      }
    }
    // writeRow から上は空 → 決定的補充 (上から降ってくる)
    let spawnCount = writeRow + 1; // 0..writeRow が空
    for (let r = writeRow; r >= 0; r--) {
      const dst = r * N + c;
      const type = Math.floor(Game.rndRefill() * GEM_TYPES);
      Game.board[dst] = type;
      const cell = makeCell(type);
      cell.scale = 1; cell.alpha = 1;
      cell.x = cellCenterX(c);
      // 盤面上端より上 (画面外側) から落下させる
      const startRow = -(spawnCount) + r;
      cell.y = cellCenterY(startRow);
      const toY = cellCenterY(r);
      const dist = r - startRow;
      const dur = T_FALL_PER_CELL * Math.max(1, dist);
      Game.cells[dst] = cell;
      remaining++;
      addTween(cell, [{ key: "y", from: cell.y, to: toY }], dur, easeInQuad,
        () => { if (--remaining === 0) afterFall(); });
    }
  }

  if (remaining === 0) afterFall();
}

function afterFall() {
  const N = Game.N;
  // 落下後のマッチ → CLEAR へ戻り連鎖。無ければ IDLE。
  const mark = findMatches(Game.board, N);
  if (mark) {
    enterClear(mark);
  } else {
    Game.state = S_IDLE;
    Game.chain = 0;
  }
}

/* =========================================================================
 *  オートソルバ (決定的)
 *  - 盤面を左上から走査し、隣接スワップでマッチが生まれる最初の手を打つ。
 *  - 有効手が無ければ盤面を決定的にシャッフルする。
 * ========================================================================= */
function swapWouldMatch(board, N, r1, c1, r2, c2) {
  const i1 = r1 * N + c1, i2 = r2 * N + c2;
  const t = board[i1]; board[i1] = board[i2]; board[i2] = t;
  const m = findMatches(board, N);
  // 戻す
  const t2 = board[i1]; board[i1] = board[i2]; board[i2] = t2;
  return !!m;
}

// 左上から走査し最初の有効手を返す。無ければ null。
function findFirstMove() {
  const N = Game.N, b = Game.board;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      // 右隣
      if (c + 1 < N && swapWouldMatch(b, N, r, c, r, c + 1)) {
        return { r1: r, c1: c, r2: r, c2: c + 1 };
      }
      // 下隣
      if (r + 1 < N && swapWouldMatch(b, N, r, c, r + 1, c)) {
        return { r1: r, c1: c, r2: r + 1, c2: c };
      }
    }
  }
  return null;
}

// 詰み時: 決定的シャッフル (Fisher-Yates を rndRefill で。マッチが出ても次フレームで解消)。
function deterministicShuffle() {
  const N = Game.N, b = Game.board;
  for (let i = N * N - 1; i > 0; i--) {
    const j = Math.floor(Game.rndRefill() * (i + 1));
    const t = b[i]; b[i] = b[j]; b[j] = t;
  }
  // ビジュアルを盤面に合わせて再構築 (型だけ振り直す。落下演出はせず即時反映)。
  for (let i = 0; i < N * N; i++) {
    const r = (i / N) | 0, c = i % N;
    let cell = Game.cells[i];
    if (!cell) { cell = makeCell(b[i]); Game.cells[i] = cell; }
    cell.type = b[i];
    cell.x = cellCenterX(c);
    cell.y = cellCenterY(r);
    cell.scale = 1; cell.alpha = 1;
    // 種別が変わるとフォールバック色/テクスチャが変わるためビジュアルを作り直す
    if (cell.vis.type !== b[i]) {
      if (cell.vis.kind === "sprite") cell.vis.obj.dispose(); else cell.vis.obj.dispose();
      cell.vis = createGemVisual(b[i]);
    }
  }
  // シャッフル後にマッチがあれば連鎖処理へ、無ければ IDLE
  const mark = findMatches(b, N);
  if (mark) { Game.chain = 0; enterClear(mark); }
  else Game.state = S_IDLE;
}

function autoStep() {
  const mv = findFirstMove();
  if (mv) {
    startSwap(mv.r1, mv.c1, mv.r2, mv.c2, true);
  } else {
    Game.state = S_SWAP; // シャッフル中は IDLE 以外にして二重発火を防ぐ
    deterministicShuffle();
  }
}

/* =========================================================================
 *  入力
 * ========================================================================= */
// Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
function startGame() {
  started = true;
  resetBoard();
  titleEl.style.display = "none";
}

window.addEventListener("keydown", (ev) => {
  if (ev.code === "Enter" && !started) {
    startGame();
    ev.preventDefault();
    return;
  }
  if (ev.key === " " || ev.code === "Space") {
    Game.auto = !Game.auto;
    Game.autoTimer = 0;
    ev.preventDefault();
    return;
  }
  if (ev.key === "+" || ev.key === "=" || ev.key === "Add") {
    changeN(Game.N + N_STEP);
  } else if (ev.key === "-" || ev.key === "_" || ev.key === "Subtract") {
    changeN(Game.N - N_STEP);
  } else if (ev.key === "r" || ev.key === "R") {
    resetBoard();
  }
});

function changeN(n) {
  n = Math.max(N_MIN, Math.min(N_MAX, n));
  if (n === Game.N) return;
  Game.N = n;
  tweens.length = 0; // 進行中トゥイーンを破棄
  buildBoard();
}
function resetBoard() {
  tweens.length = 0;
  buildBoard();
}

// クリック2回で隣接スワップ。canvas pointer → cell へ変換。
canvas.addEventListener("pointerdown", (ev) => {
  if (!started) return; // アトラクト中はユーザーのスワップ操作を無効化
  if (Game.state !== S_IDLE) return; // 演出中は無視
  const rect = canvas.getBoundingClientRect();
  // canvas 表示は 960x540 固定なのでスケール込みで px へ変換
  const px = (ev.clientX - rect.left) * (VIEW_W / rect.width);
  const py = (ev.clientY - rect.top) * (VIEW_H / rect.height);
  const c = Math.floor((px - Game.originX) / Game.cell);
  const r = Math.floor((py - Game.originY) / Game.cell);
  if (r < 0 || r >= Game.N || c < 0 || c >= Game.N) return;

  if (Game.selR < 0) {
    // 1セル目選択
    Game.selR = r; Game.selC = c;
  } else {
    if (Game.selR === r && Game.selC === c) {
      // 同セル → 選択解除
      Game.selR = -1; Game.selC = -1;
    } else if (isAdjacent(Game.selR, Game.selC, r, c)) {
      // 隣接 → スワップ実行 (手動も revertCheck=true)
      const sr = Game.selR, sc = Game.selC;
      Game.selR = -1; Game.selC = -1;
      Game.auto = false; // 手動操作したらオートは切る
      startSwap(sr, sc, r, c, true);
    } else {
      // 非隣接 → 新規選択へ切替
      Game.selR = r; Game.selC = c;
    }
  }
});
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

/* =========================================================================
 *  更新ループ
 * ========================================================================= */
function update(dt) {
  // トゥイーンを進める (状態遷移コールバックはこの中で発火する)
  updateTweens(dt);

  // オートプレイ: IDLE のときだけ一定間隔で手を打つ
  // (アトラクト中は auto トグルに関わらずデモAIを常時駆動)
  if ((Game.auto || !started) && Game.state === S_IDLE) {
    Game.autoTimer -= dt;
    if (Game.autoTimer <= 0) {
      Game.autoTimer = AUTO_INTERVAL;
      autoStep();
    }
  }
}

/* ---------- 描画反映 ---------- */
function render() {
  const N = Game.N;
  const cells = Game.cells;
  for (let i = 0; i < N * N; i++) {
    const cell = cells[i];
    if (cell) syncCellVisual(cell);
  }
  // 選択ハイライト
  if (selMesh) {
    if (Game.selR >= 0) {
      selMesh.setEnabled(true);
      selMesh.scaling.x = Game.cell * 0.96;
      selMesh.scaling.y = Game.cell * 0.96;
      selMesh.position.x = cellCenterX(Game.selC);
      selMesh.position.y = cellCenterY(Game.selR);
      selMesh.position.z = -2; // 手前
    } else {
      selMesh.setEnabled(false);
    }
  }
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;
function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08;
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const N = Game.N;
  const renderMode = texturesOk ? "Sprite(tex)" : "Disc(fallback)";
  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>           <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Board</span>         <span class="hudVal">' + N + 'x' + N + ' = ' + (N * N) + '</span>\n' +
    '<span class="hudLabel">Active tweens</span> <span class="hudVal">' + activeTweenCount() + '</span>\n' +
    '<span class="hudLabel">State</span>         <span class="hudVal">' + Game.state + '</span>' +
      '  <span class="hudLabel">Chain</span> <span class="hudVal">' + Game.chain + '</span>\n' +
    '<span class="hudLabel">Score</span>         <span class="hudVal">' + Game.score + '</span>' +
      '  <span class="hudLabel">Moves</span> <span class="hudVal">' + Game.moves + '</span>\n' +
    '<span class="hudLabel">Auto</span>          <span class="hudVal">' + (Game.auto ? "ON" : "OFF") + '</span>' +
      '  <span class="warn">' + renderMode + '</span>' +
      (texturesOk ? '' : '  <span style="color:#888">(アセット欠落→図形描画)</span>');
}

/* =========================================================================
 *  起動: アセット確認 → 構築 → ループ開始
 * ========================================================================= */
async function boot() {
  // 6種すべて読めたときだけ Sprite モード (一部欠落は全フォールバックで統一)
  const results = await Promise.all(
    GEM_DEFS.map((d) => checkImage(ASSET_DIR + d.file))
  );
  texturesOk = results.every((ok) => ok);
  if (texturesOk) {
    try {
      for (let t = 0; t < GEM_TYPES; t++) {
        const sm = new BABYLON.SpriteManager(
          "sm_" + GEM_DEFS[t].key, ASSET_DIR + GEM_DEFS[t].file,
          N_MAX * N_MAX, { width: GEM_TEX_PX, height: GEM_TEX_PX }, scene
        );
        sm.isPickable = false;
        gemManagers[t] = sm;
      }
    } catch (e) {
      texturesOk = false;
    }
  }

  buildBoardBg();
  buildSelHighlight();
  buildBoard();

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制
    update(dt);
    render();
    updateHud(dt);
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
