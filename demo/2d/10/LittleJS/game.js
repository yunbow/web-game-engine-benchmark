'use strict';

/*
  テーマ10 マッチ3パズル(ロジック主体・軽描画 × 大量トゥイーン) ― LittleJS 版
  ----------------------------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / 盤面 N×N (N初期12) を中央に正方形配置
   - セル1辺 = floor(min(520/N, 56)) px / 宝石6種 / 初期盤面は決定的・既存マッチ無し
   - 状態機械 IDLE/SWAP/CLEAR/FALL:
       SWAP 0.15s(マッチ無ければ元に戻す無効手)
       CLEAR 0.2s 縮小+フェード, Score += 消えた数 × 10 × 連鎖係数
       FALL 落下距離比例(基準0.2s/セル) + 上端から決定的補充
       落下後にマッチがあれば CLEAR へ戻り連鎖(chain++)
   - マッチ判定: 横/縦 同種3連以上を全消し, 毎回 O(N²) 全走査
   - 操作: クリック2回で隣接スワップ / Space=オートトグル(初期ON) /
           +/- で N(±2, 6..40) / R リセット
   - HUD(HTML overlay): FPS / Board / Active tweens / State / Chain / Score / Moves / Auto

  ★ トゥイーン機構(本テーマの比較対象) ★
   - LittleJS には Phaser Tweens / Godot Tween のような高レベルなトゥイーン機構が無い。
     そこで「小さな手動トゥイーンマネージャ」を自前実装する。これがエンジン比較の核。
   - 各トゥイーンは {obj, props:{key:{from,to}}, t, dur, ease, onDone} のレコード。
     gameUpdate ごとに timeDelta(実時間秒)で t を進め、ease(t/dur) で obj[key] を補間。
     完了したものは配列から除去し onDone を呼ぶ。HUD の "Active tweens" はこの配列長。
   - 落下は「1列まとめて」ではなく **セル単位** でトゥイーンを張り、同時進行数を稼ぐ
     (SPEC: 同時トゥイーン数が負荷の核)。N=40 落下多発で数百〜千本に達する。

  ★ 座標系 / Y軸メモ (最重要) ★
   - LittleJS のワールドは Y軸"上向き"。本実装は cameraScale=1 (1ワールド=1px) とし、
     盤面ロジックは「行 row=0 が一番上」という素直なグリッド添字で保持する。
   - グリッド(col, row) → ワールド中心座標へは boardToWorld() に Y反転を閉じ込める。
     row が増える(下の行)ほど worldY が小さくなる: worldY = boardTop - row*cell - cell/2。
     画面中心が (0,0) になるよう cameraPos=(0,0) のままにし、盤面を原点中心に配置する。
   - 宝石の論理座標も「row が下ほど下」で一貫させ、描画時のみ boardToWorld で変換。
     落下トゥイーンは worldY を直接動かす(gem.dx/gem.dy = 中心からの描画オフセット)。
   - マウス入力は mousePos(ワールド座標, y-up)で来るので worldToBoard() で同じ式系で逆変換。
   - 画像が無くても起動するため textureInfos[i].size で読込判定し、未読込なら
     drawRect(角丸風の矩形)＋drawCircle のフォールバックで宝石を描く。
*/

// ---- 画面・盤面定数 (SPEC) ----
const VIEW_W = 960, VIEW_H = 540;     // 固定キャンバス
const BOARD_PX = 520;                 // 盤面が収まる基準サイズ(px)
const CELL_MAX = 56;                  // セル最大px
const GEM_TYPES = 6;                  // 宝石種別数

// ---- 盤面サイズ(負荷値) ----
let N = 12;                           // 1辺セル数(初期12)
const N_STEP = 2, N_MIN = 6, N_MAX = 40;

// ---- トゥイーン時間(秒, SPEC) ----
const SWAP_DUR = 0.15;                // スワップ
const CLEAR_DUR = 0.20;               // 消滅(縮小+フェード)
const FALL_PER_CELL = 0.20;           // 落下: 1セルあたりの基準時間
const AUTO_INTERVAL = 0.25;           // オートプレイの手番間隔(秒)

// ---- 状態機械 ----
const S_IDLE = 'IDLE', S_SWAP = 'SWAP', S_CLEAR = 'CLEAR', S_FALL = 'FALL';
let state = S_IDLE;

// ---- 宝石色(図形フォールバック, 種別 0..5 = 赤/青/緑/黄/紫/白) ----
const GEM_COLORS = [
  new Color(0.93, 0.26, 0.26),  // 0 赤
  new Color(0.26, 0.52, 0.95),  // 1 青
  new Color(0.30, 0.78, 0.36),  // 2 緑
  new Color(0.96, 0.82, 0.24),  // 3 黄
  new Color(0.69, 0.40, 0.90),  // 4 紫
  new Color(0.92, 0.92, 0.95),  // 5 白
];

// ---- imageSources (../assets/, SPEC のファイル名/インデックスに厳密一致) ----
const imageSources = [
  '../assets/gem_red.png',     // 0
  '../assets/gem_blue.png',    // 1
  '../assets/gem_green.png',   // 2
  '../assets/gem_yellow.png',  // 3
  '../assets/gem_purple.png',  // 4
  '../assets/gem_white.png',   // 5
  '../assets/bg_board.png',    // 6 (512x512)
];
const TEX_BG = 6;

// ---- グローバル状態 ----
let board = [];          // board[row][col] = gem オブジェクト or null
let cell = 56;           // 動的に決まるセル1辺(px)
let boardLeft = 0;       // 盤面左端ワールドX(中心原点基準)
let boardTop = 0;        // 盤面上端ワールドY(y-up: 一番上=大Y)
let score = 0;
let moves = 0;           // 実行した手数
let chain = 0;           // 現在の連鎖段数
let autoPlay = true;     // オートプレイ(初期ON)
let autoTimer = 0;       // オート手番タイマ
let useSprites = false;
let fpsAvg = 60;

// ---- タイトル/アトラクト状態 (false=デモ中・操作無効, Enter で開始) ----
let started = false;
let blinkT = 0;
const titleEl = () => document.getElementById('title');

// クリック選択(手動スワップ)
let selected = null;     // {col,row} or null

// 決定的乱数: 盤面/補充それぞれ独立のシード状態を進める
let boardSeed = 0;       // 盤面生成・シャッフル用の進行シード
let refillSeed = 0;      // 補充宝石用の進行シード

const hudEl = () => document.getElementById('hud');

// ---- 決定的疑似乱数 (mulberry32) ----
// 状態を引数で渡し、次状態と値を返す純関数版。グローバル seed 変数を進めて使う。
function mulberry32(a) {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// boardSeed を1歩進めて [0,1) を返す
function rndBoard() { boardSeed = (boardSeed + 0x9E3779B9) | 0; return mulberry32(boardSeed); }
// refillSeed を1歩進めて [0,1) を返す
function rndRefill() { refillSeed = (refillSeed + 0x9E3779B9) | 0; return mulberry32(refillSeed); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ===================================================================
//  手動トゥイーンマネージャ(本テーマの比較対象)
// ===================================================================
// レコード: { obj, props:{key:[from,to]}, t, dur, ease, onDone, dead }
let tweens = [];

// イージング(easeOutQuad / easeInQuad 等)。引数 k=0..1。
function easeOutQuad(k) { return 1 - (1 - k) * (1 - k); }
function easeInQuad(k) { return k * k; }
function easeInOutQuad(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }

// トゥイーンを1本追加。props は {key: [from, to]} の形。
function addTween(obj, props, dur, ease, onDone) {
  tweens.push({ obj, props, t: 0, dur, ease: ease || easeInOutQuad, onDone: onDone || null, dead: false });
}

// 全トゥイーンを timeDelta(実時間秒)で進める。完了分は除去し onDone を呼ぶ。
// 戻り値: このフレームに1本以上完了したか(状態遷移の判定に使う)。
function updateTweens(dt) {
  let finished = false;
  for (let i = 0; i < tweens.length; i++) {
    const tw = tweens[i];
    tw.t += dt;
    let k = tw.dur > 0 ? tw.t / tw.dur : 1;
    if (k >= 1) k = 1;
    const e = tw.ease(k);
    for (const key in tw.props) {
      const fromTo = tw.props[key];
      tw.obj[key] = fromTo[0] + (fromTo[1] - fromTo[0]) * e;
    }
    if (k >= 1) {
      tw.dead = true;
      finished = true;
      if (tw.onDone) tw.onDone();
    }
  }
  // 完了トゥイーンを除去(逆順)
  if (finished) {
    for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].dead) tweens.splice(i, 1);
  }
  return finished;
}

// 進行中トゥイーンが残っているか
function tweensActive() { return tweens.length > 0; }

// ===================================================================
//  座標変換 (グリッド <-> ワールド, Y反転を閉じ込め)
// ===================================================================
// セルサイズ・盤面配置を N から再計算(中央配置, 原点中心)。
function computeLayout() {
  cell = Math.floor(Math.min(BOARD_PX / N, CELL_MAX));
  const span = cell * N;          // 盤面1辺の総px
  boardLeft = -span / 2;          // 原点中心配置の左端X
  boardTop = span / 2;            // y-up: 上端は +span/2
}
// グリッド(col,row) → セル中心のワールド座標(y-up)。row=0 が画面上。
function boardToWorld(col, row) {
  return vec2(boardLeft + col * cell + cell / 2,
              boardTop - row * cell - cell / 2);
}
// ワールド座標(y-up) → グリッド(col,row)。範囲外は null。
function worldToBoard(wx, wy) {
  const col = Math.floor((wx - boardLeft) / cell);
  const row = Math.floor((boardTop - wy) / cell);
  if (col < 0 || col >= N || row < 0 || row >= N) return null;
  return { col, row };
}

// ===================================================================
//  宝石オブジェクト / 盤面生成
// ===================================================================
// gem: { type, dx, dy, scale, alpha } …dx/dy は描画上のオフセット(落下/スワップ補間用)
function makeGem(type) { return { type, dx: 0, dy: 0, scale: 1, alpha: 1 }; }

// 盤面を決定的に生成。生成直後に既存マッチが出ないよう、各セルで
// 「直前2つと同じ型」を決定的に避けて埋める(横/縦とも3連を作らない)。
function generateBoard() {
  board = [];
  for (let row = 0; row < N; row++) {
    board[row] = [];
    for (let col = 0; col < N; col++) {
      // 候補からマッチを作らない型を決定的に選ぶ
      let type = Math.floor(rndBoard() * GEM_TYPES) % GEM_TYPES;
      // 横3連回避: 左2つが同型なら別型へずらす
      if (col >= 2 && board[row][col - 1].type === type && board[row][col - 2].type === type)
        type = (type + 1) % GEM_TYPES;
      // 縦3連回避: 上2つが同型なら別型へずらす
      if (row >= 2 && board[row - 1][col].type === type && board[row - 2][col].type === type)
        type = (type + 1) % GEM_TYPES;
      // ずらした結果また衝突するケースを再回避(最大数回, 決定的)
      let guard = 0;
      while (guard++ < GEM_TYPES) {
        const hConf = col >= 2 && board[row][col - 1].type === type && board[row][col - 2].type === type;
        const vConf = row >= 2 && board[row - 1][col].type === type && board[row - 2][col].type === type;
        if (!hConf && !vConf) break;
        type = (type + 1) % GEM_TYPES;
      }
      board[row][col] = makeGem(type);
    }
  }
}

// ===================================================================
//  マッチ判定 (O(N²) 全走査)
// ===================================================================
// 横/縦に同種3連以上を検出し、消すセルの集合(boolean 2D)を返す。
function findMatches() {
  const mark = [];
  for (let r = 0; r < N; r++) { mark[r] = new Array(N).fill(false); }
  let any = false;

  // 横走査: 各行で連続同型ランを数える
  for (let r = 0; r < N; r++) {
    let runStart = 0;
    for (let c = 1; c <= N; c++) {
      const same = c < N && board[r][c] && board[r][runStart] &&
                   board[r][c].type === board[r][runStart].type;
      if (!same) {
        const len = c - runStart;
        if (len >= 3) { for (let k = runStart; k < c; k++) { mark[r][k] = true; any = true; } }
        runStart = c;
      }
    }
  }
  // 縦走査: 各列で連続同型ランを数える
  for (let c = 0; c < N; c++) {
    let runStart = 0;
    for (let r = 1; r <= N; r++) {
      const same = r < N && board[r][c] && board[runStart][c] &&
                   board[r][c].type === board[runStart][c].type;
      if (!same) {
        const len = r - runStart;
        if (len >= 3) { for (let k = runStart; k < r; k++) { mark[k][c] = true; any = true; } }
        runStart = r;
      }
    }
  }
  return any ? mark : null;
}

// ===================================================================
//  状態機械: SWAP / CLEAR / FALL
// ===================================================================
let pendingSwap = null;  // {a:{col,row}, b:{col,row}, revert:bool} スワップ中の記憶

// 2セルを論理的に入れ替え(配列の中身を交換)
function swapCells(a, b) {
  const tmp = board[a.row][a.col];
  board[a.row][a.col] = board[b.row][b.col];
  board[b.row][b.col] = tmp;
}

// スワップ開始: 2セルの宝石に dx/dy トゥイーンを張り、入れ替わって見せる。
// LittleJS には可逆トゥイーンが無いので、論理交換は先に行い、描画オフセットを
// 「相手の位置から元位置へ戻る」方向に補間して見た目のスワップにする。
function startSwap(a, b, isRevert) {
  state = S_SWAP;
  pendingSwap = { a, b, revert: isRevert };
  swapCells(a, b);  // 論理は先に交換
  const ga = board[a.row][a.col]; // 今 a にいる宝石(元 b の宝石)
  const gb = board[b.row][b.col]; // 今 b にいる宝石(元 a の宝石)
  // 描画オフセット: 交換直後は相手のセルにいたので、そこからゼロへ補間
  const dcol = (b.col - a.col) * cell, drow = (a.row - b.row) * cell; // y-up: row増=下
  ga.dx = dcol; ga.dy = drow; gb.dx = -dcol; gb.dy = -drow;
  let done = 0;
  const onDone = () => {
    if (++done < 2) return;
    onSwapComplete();
  };
  addTween(ga, { dx: [ga.dx, 0], dy: [ga.dy, 0] }, SWAP_DUR, easeInOutQuad, onDone);
  addTween(gb, { dx: [gb.dx, 0], dy: [gb.dy, 0] }, SWAP_DUR, easeInOutQuad, onDone);
}

// スワップ完了: マッチがあれば CLEAR へ。無ければ(無効手)元に戻す。
function onSwapComplete() {
  const m = findMatches();
  if (m) {
    chain = 0;          // 新しい手番の連鎖を開始
    if (!pendingSwap.revert) moves++;  // 有効手のみ手数加算
    pendingSwap = null;
    startClear(m);
  } else if (!pendingSwap.revert) {
    // マッチ無し → 元に戻すスワップ(revert=true)
    const a = pendingSwap.a, b = pendingSwap.b;
    pendingSwap = null;
    startSwap(a, b, true);
  } else {
    // 戻し完了 → IDLE
    pendingSwap = null;
    state = S_IDLE;
  }
}

// CLEAR: マッチセルを縮小+フェードのトゥイーンで消し、完了後 FALL へ。
function startClear(mark) {
  state = S_CLEAR;
  chain++;                       // 連鎖段数(1段目=1)
  let cleared = 0;
  const clearedCells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (mark[r][c] && board[r][c]) { clearedCells.push({ r, c, gem: board[r][c] }); cleared++; }
  }
  // スコア: 消えた数 × 10 × 連鎖係数
  score += cleared * 10 * chain;

  let done = 0;
  const onDone = () => {
    if (++done < clearedCells.length) return;
    // 消滅完了 → 論理的に null 化して落下へ
    for (const cc of clearedCells) if (board[cc.r][cc.c] === cc.gem) board[cc.r][cc.c] = null;
    startFall();
  };
  for (const cc of clearedCells) {
    addTween(cc.gem, { scale: [1, 0], alpha: [1, 0] }, CLEAR_DUR, easeInQuad, onDone);
  }
}

// FALL: 各列で空きを詰め、上端から決定的補充。落下は **セル単位** でトゥイーン。
function startFall() {
  state = S_FALL;
  let tweenCount = 0;
  let pending = 0;
  const onCellLanded = () => { if (--pending === 0) onFallComplete(); };

  for (let c = 0; c < N; c++) {
    // 下から上へ走査し、空きの数だけ上の宝石を落とす(列内コンパクション)
    let writeRow = N - 1;  // 次に詰める行(下から)
    for (let r = N - 1; r >= 0; r--) {
      if (board[r][c]) {
        if (r !== writeRow) {
          const gem = board[r][c];
          board[writeRow][c] = gem;
          board[r][c] = null;
          // 落下距離(セル数)。dy は描画オフセット: 上から落ちる=今は上にいたので +(row差)*cell から 0 へ
          const dist = writeRow - r;
          gem.dy = dist * cell;  // y-up: 上にいた分だけ +Y オフセット
          const dur = FALL_PER_CELL * Math.max(1, dist);
          pending++; tweenCount++;
          addTween(gem, { dy: [gem.dy, 0] }, dur, easeInQuad, onCellLanded);
        }
        writeRow--;
      }
    }
    // 上端の空き writeRow..0 を新規宝石で決定的補充。これも落下トゥイーン。
    const emptyTop = writeRow + 1; // 0..writeRow が空き
    for (let r = writeRow; r >= 0; r--) {
      const type = Math.floor(rndRefill() * GEM_TYPES) % GEM_TYPES;
      const gem = makeGem(type);
      board[r][c] = gem;
      // 盤面上端より上(emptyTop 段ぶん上)から落ちてくる。
      // dist = この宝石が降りる段数。dy は最終位置(0)からの上向きオフセット。
      const dist = emptyTop - r;
      gem.dy = dist * cell; // y-up: 真上 dist セル分から 0 へ落下
      const dur = FALL_PER_CELL * Math.max(1, dist);
      pending++; tweenCount++;
      addTween(gem, { dy: [gem.dy, 0] }, dur, easeInQuad, onCellLanded);
    }
  }
  // 落下トゥイーンが1本も無い(動きが無かった)場合は即完了判定
  if (pending === 0) onFallComplete();
}

// FALL 完了: 新たなマッチがあれば連鎖(CLEAR へ)、無ければ IDLE。
function onFallComplete() {
  const m = findMatches();
  if (m) {
    startClear(m);   // 連鎖(chain は startClear 内で ++)
  } else {
    chain = 0;
    state = S_IDLE;
  }
}

// ===================================================================
//  オートプレイ / 手動スワップ
// ===================================================================
// 隣接2セルを試しに交換してマッチが出るか(決定的探索)。出れば {a,b} を返す。
function findFirstValidMove() {
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      // 右隣と交換して判定
      if (c + 1 < N) {
        swapCells({ col: c, row: r }, { col: c + 1, row: r });
        const ok = findMatches();
        swapCells({ col: c, row: r }, { col: c + 1, row: r }); // 戻す
        if (ok) return { a: { col: c, row: r }, b: { col: c + 1, row: r } };
      }
      // 下隣と交換して判定
      if (r + 1 < N) {
        swapCells({ col: c, row: r }, { col: c, row: r + 1 });
        const ok = findMatches();
        swapCells({ col: c, row: r }, { col: c, row: r + 1 }); // 戻す
        if (ok) return { a: { col: c, row: r }, b: { col: c, row: r + 1 } };
      }
    }
  }
  return null;
}

// 有効手が無い(詰み)場合: 盤面を決定的にシャッフルして既存マッチを潰す。
function deterministicShuffle() {
  // 既存の型集合を保ったままフィッシャー-イェーツ(boardSeed 駆動)で並べ替え、
  // その後マッチが残るセルは型をずらして既存マッチ無しにする。
  const flat = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flat.push(board[r][c].type);
  for (let i = flat.length - 1; i > 0; i--) {
    const j = Math.floor(rndBoard() * (i + 1));
    const t = flat[i]; flat[i] = flat[j]; flat[j] = t;
  }
  let idx = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) board[r][c] = makeGem(flat[idx++]);
  // 既存マッチを決定的に解消
  let safety = 0;
  while (findMatches() && safety++ < 8) {
    const m = findMatches();
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (m[r][c]) board[r][c].type = (board[r][c].type + 1) % GEM_TYPES;
    }
  }
}

// オートプレイ1手: 有効手があれば実行、無ければシャッフル。
function autoStep() {
  const mv = findFirstValidMove();
  if (mv) {
    startSwap(mv.a, mv.b, false);
  } else {
    deterministicShuffle();
    // シャッフル直後にマッチがあれば連鎖開始(通常は無し)
    const m = findMatches();
    if (m) { chain = 0; startClear(m); }
  }
}

// 手動クリック: 1回目で選択、2回目で隣接なら実行・非隣接なら選択し直し。
function handleClickSelect(cellPos) {
  if (!selected) { selected = cellPos; return; }
  if (selected.col === cellPos.col && selected.row === cellPos.row) { selected = null; return; }
  const adj = (Math.abs(selected.col - cellPos.col) + Math.abs(selected.row - cellPos.row)) === 1;
  if (adj) {
    const a = selected; selected = null;
    startSwap(a, cellPos, false);
  } else {
    selected = cellPos; // 非隣接は選択し直し
  }
}

// ===================================================================
//  リセット / N 変更
// ===================================================================
function resetGame(keepScore) {
  tweens = [];
  state = S_IDLE;
  pendingSwap = null;
  selected = null;
  chain = 0;
  autoTimer = 0;
  boardSeed = 0x1234567 ^ (N * 0x9E3779B9); // N ごとに決定的・再現可能なシード
  refillSeed = 0x0BADF00D ^ (N * 0x85EBCA6B);
  computeLayout();
  generateBoard();
  if (!keepScore) { score = 0; moves = 0; }
}

// Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
function startGame() {
  started = true;
  resetGame(false);
  const el = titleEl();
  if (el) el.style.display = 'none';
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);           // 1ワールド単位 = 1px
  setCameraPos(vec2(0, 0));    // 原点中心(盤面を原点中心に配置)
  setGravity(vec2(0, 0));      // エンジン物理は使わない

  // テクスチャ読込判定(1枚でも読めれば sprites 使用)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  N = 12;
  autoPlay = true;
  resetGame(false);
}

function gameUpdate() {
  const dt = timeDelta; // デルタタイム基準(実時間秒)

  // ---- Enter: アトラクト→プレイ開始 ----
  if (!started && keyWasPressed('Enter')) startGame();

  // ---- 盤面サイズ増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    N = clamp(N + N_STEP, N_MIN, N_MAX); resetGame(true);
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    N = clamp(N - N_STEP, N_MIN, N_MAX); resetGame(true);
  }
  // ---- リセット (R) ----
  if (keyWasPressed('KeyR')) resetGame(false);
  // ---- オートプレイトグル (Space) ----
  if (keyWasPressed('Space')) autoPlay = !autoPlay;

  // ---- トゥイーン前進(全状態共通) ----
  updateTweens(dt);

  // ---- 手動クリック入力(IDLE 時のみ受理。アトラクト中は無効) ----
  if (started && state === S_IDLE && mouseWasPressed(0)) {
    const mp = mousePos; // ワールド座標(y-up)
    const cp = worldToBoard(mp.x, mp.y);
    if (cp) handleClickSelect(cp);
  }

  // ---- オートプレイ: IDLE かつ ON の間 0.25s 間隔で1手(アトラクト中はトグル問わず常時駆動) ----
  if ((autoPlay || !started) && state === S_IDLE) {
    autoTimer += dt;
    if (autoTimer >= AUTO_INTERVAL) {
      autoTimer = 0;
      autoStep();
    }
  } else if (state !== S_IDLE) {
    autoTimer = 0;
  }
}

function gameUpdatePost() {
  // ---- タイトル点滅(アトラクト中のみ) ----
  if (!started) {
    blinkT += timeDelta;
    const el = titleEl();
    if (el) el.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
  }
}

// ===================================================================
//  描画 (ワールド空間, 中央配置盤面)
// ===================================================================
function gameRender() {
  const span = cell * N;

  // ---- 盤面背景 ----
  if (spriteReady(TEX_BG)) {
    drawTile(vec2(0, 0), vec2(span + cell * 0.5, span + cell * 0.5),
             tile(0, textureInfos[TEX_BG].size, TEX_BG));
  } else {
    drawRect(vec2(0, 0), vec2(VIEW_W, VIEW_H), new Color(0.06, 0.08, 0.14));     // 濃紺
    drawRect(vec2(0, 0), vec2(span + 8, span + 8), new Color(0.12, 0.14, 0.20)); // 盤面枠
  }

  // ---- セル下地(暗い角丸風) + 宝石 ----
  const gemSize = cell * 0.82;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const w = boardToWorld(c, r);
      // セル下地
      drawRect(w, vec2(cell - 2, cell - 2), new Color(0.16, 0.18, 0.24));
      const gem = board[r][c];
      if (!gem) continue;
      // 描画位置 = セル中心 + 補間オフセット(dx,dy)。落下/スワップはここに乗る。
      const pos = vec2(w.x + gem.dx, w.y + gem.dy);
      const sz = gemSize * gem.scale;
      const a = gem.alpha;
      if (spriteReady(gem.type)) {
        const col = new Color(1, 1, 1, a);
        drawTile(pos, vec2(sz, sz), tile(0, textureInfos[gem.type].size, gem.type), col);
      } else {
        // フォールバック: 角丸風に 矩形+中央円 を重ねて宝石らしく
        const base = GEM_COLORS[gem.type];
        const bc = new Color(base.r, base.g, base.b, a);
        drawRect(pos, vec2(sz, sz), bc);
        drawCircle(pos, sz * 0.30, new Color(1, 1, 1, 0.35 * a)); // ハイライト
      }
    }
  }

  // ---- 選択中セルの強調枠 ----
  if (selected) {
    const w = boardToWorld(selected.col, selected.row);
    drawRect(w, vec2(cell, cell), new Color(1, 1, 1, 0.18));
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function gameRenderPost() {
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const cells = N * N;
  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS           : ' + fpsAvg.toFixed(1) + '\n' +
      'Board         : ' + N + 'x' + N + ' = ' + cells + ' cells\n' +
      'Active tweens : ' + tweens.length + '\n' +
      'State         : ' + state + '\n' +
      'Chain         : ' + chain + '\n' +
      'Score         : ' + score + '\n' +
      'Moves         : ' + moves + '\n' +
      'Auto          : ' + (autoPlay ? 'ON' : 'OFF') +
      (useSprites ? '   [sprites]' : '   [shapes fallback]');
  }
}

// ===================================================================
//  テクスチャ読込判定
// ===================================================================
function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}

// ===================================================================
//  起動
// ===================================================================
// 第7引数 rootElement に #game-container を渡し、canvas をそこへ生成させる
// (three.js 版と同じ 960x540・上端中央配置。CSS の !important でサイズ固定)。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
