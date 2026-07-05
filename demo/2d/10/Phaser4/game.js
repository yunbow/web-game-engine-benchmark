/* ============================================================
 * テーマ10 マッチ3パズル ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠 (NxN グリッド / 宝石6種 / 状態機械
 *       IDLE/SWAP/CLEAR/FALL / 横縦3連以上消し / 連鎖 / 決定的補充 / オートプレイ)。
 *
 * 画面 960x540 固定 / デルタタイム基準 / 数値はすべて SPEC.md に一致。
 * 性能比較の核: ロジック (O(N^2) マッチ走査) ＋ 大量同時トゥイーン
 *   (落下/消滅を「セル単位」で張り、同時進行トゥイーン数を稼ぐ)。
 * このエンジンの比較対象機構 = **Phaser Tweens** (this.tweens.add)。
 * ============================================================ */

// ---- 基本定数 ----
const VIEW_W = 960;
const VIEW_H = 540;

const GEM_TYPES = 6;          // 宝石種別数
const BOARD_PX = 520;         // 盤面の最大1辺 (px)。セル = floor(min(520/N, 56))
const MAX_CELL = 56;          // セル1辺の最大px

const N_INIT = 12;            // 盤面サイズ N 初期値
const N_STEP = 2;             // +/- の増減幅
const N_MIN = 6;              // 下限
const N_MAX = 40;             // 上限

// トゥイーン時間 (SPEC.md, 秒) — Phaser は ms 指定なので *1000
const SWAP_SEC = 0.15;        // スワップ
const CLEAR_SEC = 0.20;       // 消滅 (縮小+フェード)
const FALL_PER_CELL = 0.20;   // 落下: 距離1セルあたりの基準秒 (線形)

const AUTO_INTERVAL = 0.25;   // オート探索間隔 (秒)

const SCORE_PER_GEM = 10;     // 消去1個あたり基礎スコア (×連鎖係数)

// 状態
const ST_IDLE = 'IDLE', ST_SWAP = 'SWAP', ST_CLEAR = 'CLEAR', ST_FALL = 'FALL';

// 宝石6種の色 (フォールバック描画 / 種別→色)
//  赤 / 青 / 緑 / 黄 / 紫 / 白
const GEM_COLOR = [0xe44b4b, 0x4b7fe4, 0x4bd06a, 0xf2c83a, 0xb05fe0, 0xf0f0f0];
const GEM_KEYS = ['gem_red', 'gem_blue', 'gem_green', 'gem_yellow', 'gem_purple', 'gem_white'];

// 盤面背景 (暗い角丸 / 濃紺)
const BOARD_BG_COLOR = 0x182238;

// ---- 決定的疑似乱数 (Mulberry32) ----
// 盤面初期化・補充・シャッフルはすべてこの PRNG で生成し、Math.random は使わない。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// BootScene ― アセット読込 + 失敗キャプチャ
// ============================================================
const ASSET_DEFS = [
  { key: 'gem_red',    file: 'gem_red.png' },
  { key: 'gem_blue',   file: 'gem_blue.png' },
  { key: 'gem_green',  file: 'gem_green.png' },
  { key: 'gem_yellow', file: 'gem_yellow.png' },
  { key: 'gem_purple', file: 'gem_purple.png' },
  { key: 'gem_white',  file: 'gem_white.png' },
  { key: 'bg_board',   file: 'bg_board.png' },
];
const failedAssets = new Set();

// フォールバックテクスチャは固定サイズ(64px)で焼き、表示時にセルサイズへ拡縮する。
const TEX_BASE = 64; // フォールバック宝石テクスチャの基準px

class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  preload() {
    // 画像が無くても起動する: 読込失敗を記録し、後でフォールバックテクスチャを生成。
    this.load.on('loaderror', (fileObj) => { failedAssets.add(fileObj.key); });
    for (const def of ASSET_DEFS) {
      this.load.image(def.key, '../assets/' + def.file);
    }
  }

  create() {
    this.buildFallbackTextures();
    this.scene.start('GameScene');
  }

  // Graphics.generateTexture で単色図形テクスチャを焼いてフォールバック。
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      // 正常ロード済みなら何もしない
      if (this.textures.exists(key) && !failedAssets.has(key)) return;
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 宝石6種: 種別ごとに色付き角丸矩形 + ハイライトの丸。
    for (let t = 0; t < GEM_TYPES; t++) {
      const col = GEM_COLOR[t];
      make(GEM_KEYS[t], TEX_BASE, TEX_BASE, (g, w, h) => {
        const pad = 5;
        // 影 (やや暗い角丸)
        g.fillStyle(Phaser.Display.Color.ValueToColor(col).darken(40).color, 1);
        g.fillRoundedRect(pad + 2, pad + 3, w - pad * 2, h - pad * 2, 12);
        // 本体
        g.fillStyle(col, 1);
        g.fillRoundedRect(pad, pad, w - pad * 2, h - pad * 2, 12);
        // 上部ハイライト
        g.fillStyle(0xffffff, 0.35);
        g.fillCircle(w * 0.36, h * 0.34, w * 0.12);
        // 縁取り (種別の視認性向上)
        g.lineStyle(2, Phaser.Display.Color.ValueToColor(col).darken(25).color, 0.9);
        g.strokeRoundedRect(pad, pad, w - pad * 2, h - pad * 2, 12);
      });
    }

    // 盤面背景タイル = 濃紺 (512x512)
    make('bg_board', 512, 512, (g, w, h) => {
      g.fillStyle(0x0e1626, 1).fillRect(0, 0, w, h);
      g.lineStyle(1, 0x223150, 0.5);
      for (let i = 0; i <= w; i += 64) { g.lineBetween(i, 0, i, h); g.lineBetween(0, i, w, i); }
    });
  }
}

// ============================================================
// GameScene ― 本体
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    // --- 盤面状態 ---
    this.N = N_INIT;
    this.state = ST_IDLE;
    this.score = 0;
    this.moves = 0;
    this.chain = 0;          // 現在の連鎖段数 (CLEAR/FALL ループ中のみ >0)
    this.auto = true;        // オートプレイ (初期 ON)
    this.autoTimer = 0;      // オート探索の蓄積時間
    this.resetCounter = 0;   // R リセット回数 (シードに混ぜて毎回違う盤面に)

    this.selected = null;    // 手動スワップ: 選択中セル {r,c} or null
    this.activeTweenCount = 0; // 自前トゥイーンカウンタ (HUD 用; getTweens と併記)

    // タイトル/アトラクト状態 (false=デモ中・ユーザー操作無効。デモAIは常時駆動)
    this.started = false;
    this.blinkT = 0;
    this.titleEl = document.getElementById('title');

    // grid[r][c] = 宝石種別 (0..5)。スプライトは sprites[r][c]。
    this.grid = [];
    this.sprites = [];

    // --- 背景 (盤面の外周) ---
    this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x0a0e16).setOrigin(0, 0).setDepth(-10);

    // 盤面コンテナ (中央寄せ。レイアウトは layoutBoard で更新)
    this.boardBg = this.add.rectangle(0, 0, 10, 10, BOARD_BG_COLOR).setOrigin(0, 0).setDepth(0);
    this.boardBg.setStrokeStyle(2, 0x2a3b5c, 1);
    this.gemLayer = this.add.container(0, 0).setDepth(1);

    // --- 入力 ---
    this.input.on('pointerdown', (p) => this.onPointerDown(p));
    this.input.keyboard.on('keydown-ENTER', () => { if (!this.started) this.startGame(); });
    this.input.keyboard.on('keydown-SPACE', () => { this.auto = !this.auto; this.autoTimer = 0; });
    this.input.keyboard.on('keydown-R', () => this.resetBoard());
    this.input.keyboard.on('keydown-PLUS', () => this.adjustN(+N_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustN(-N_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustN(+N_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustN(-N_STEP));

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // 盤面生成
    this.resetBoard();
  }

  // ============================================================
  // レイアウト計算: N に応じたセルサイズ・盤面原点 (中央寄せ)
  // ============================================================
  computeLayout() {
    this.cell = Math.floor(Math.min(BOARD_PX / this.N, MAX_CELL));
    const boardSize = this.cell * this.N;
    this.boardX = Math.floor((VIEW_W - boardSize) / 2);
    // 縦は HUD ぶんを考慮しつつ中央寄せ (下端ヒント行を避けて少し上)
    this.boardY = Math.floor((VIEW_H - boardSize) / 2) + 6;
    this.boardSizePx = boardSize;
  }

  // セル (r,c) の中心座標 (gemLayer はワールド原点なので絶対座標)
  cellCX(c) { return this.boardX + c * this.cell + this.cell / 2; }
  cellCY(r) { return this.boardY + r * this.cell + this.cell / 2; }

  // 宝石テクスチャを現在のセルサイズに合わせるスケール (テクスチャは可変サイズ)
  gemScale(key) {
    const src = this.textures.get(key).getSourceImage();
    const target = this.cell * 0.92; // セルにわずかな余白
    return target / Math.max(src.width, src.height);
  }

  // ============================================================
  // 盤面生成 (決定的・初期マッチ無し)
  // ============================================================
  resetBoard() {
    // 進行中トゥイーンを全停止 (N 変更/リセット時に取り残しを防ぐ)
    this.tweens.killAll();
    this.activeTweenCount = 0;
    this.state = ST_IDLE;
    this.chain = 0;
    this.selected = null;
    this.clearSelectionMark();

    this.computeLayout();

    // 既存スプライト破棄
    this.gemLayer.removeAll(true);

    // 盤面背景配置
    this.boardBg.setPosition(this.boardX - 4, this.boardY - 4);
    this.boardBg.setSize(this.boardSizePx + 8, this.boardSizePx + 8);

    // 決定的 PRNG (リセット回数 + N をシードに混ぜる)
    const rng = mulberry32((0xB3E70 ^ (this.resetCounter * 0x9E3779B1) ^ (this.N * 2654435761)) >>> 0);

    // 初期マッチが出ないよう、各セルで「左2連・上2連と同種を避ける」貪欲生成。
    // それでも詰むケースに備え、生成後に全走査して残マッチがあれば振り直す。
    this.grid = [];
    for (let r = 0; r < this.N; r++) this.grid.push(new Array(this.N).fill(0));

    let attempt = 0;
    do {
      for (let r = 0; r < this.N; r++) {
        for (let c = 0; c < this.N; c++) {
          let t;
          let guard = 0;
          do {
            t = Math.floor(rng() * GEM_TYPES);
            guard++;
            // 横: 左2つが同種 / 縦: 上2つが同種 を避ける
            const hBad = c >= 2 && this.grid[r][c - 1] === t && this.grid[r][c - 2] === t;
            const vBad = r >= 2 && this.grid[r - 1][c] === t && this.grid[r - 2][c] === t;
            if (!hBad && !vBad) break;
          } while (guard < 20);
          this.grid[r][c] = t;
        }
      }
      attempt++;
      // 念のため: 残マッチがあれば再生成 (貪欲で通常 0、保険)
    } while (this.findMatches().size > 0 && attempt < 8);

    // スプライト構築
    this.sprites = [];
    for (let r = 0; r < this.N; r++) {
      const row = [];
      for (let c = 0; c < this.N; c++) {
        row.push(this.makeGemSprite(r, c, this.grid[r][c]));
      }
      this.sprites.push(row);
    }
  }

  // 1 宝石スプライトを生成して gemLayer に追加
  makeGemSprite(r, c, type) {
    const key = GEM_KEYS[type];
    const spr = this.add.image(this.cellCX(c), this.cellCY(r), key);
    spr.setScale(this.gemScale(key));
    spr.gemType = type;
    this.gemLayer.add(spr);
    return spr;
  }

  // ============================================================
  // マッチ判定 ― 横/縦に同種3連以上を全走査 (O(N^2))
  //   返り値: 消去対象セルの集合 (Set of "r,c")
  // ============================================================
  findMatches() {
    const N = this.N, g = this.grid;
    const hits = new Set();

    // 横方向ラン
    for (let r = 0; r < N; r++) {
      let run = 1;
      for (let c = 1; c <= N; c++) {
        const same = c < N && g[r][c] === g[r][c - 1];
        if (same) { run++; }
        else {
          if (run >= 3) for (let k = c - run; k < c; k++) hits.add(r + ',' + k);
          run = 1;
        }
      }
    }
    // 縦方向ラン
    for (let c = 0; c < N; c++) {
      let run = 1;
      for (let r = 1; r <= N; r++) {
        const same = r < N && g[r][c] === g[r - 1][c];
        if (same) { run++; }
        else {
          if (run >= 3) for (let k = r - run; k < r; k++) hits.add(k + ',' + c);
          run = 1;
        }
      }
    }
    return hits;
  }

  // (r,c) を入れ替えたら横/縦どこかで3連が出来るか (盤面は変更しない軽量判定)
  swapWouldMatch(r1, c1, r2, c2) {
    const g = this.grid;
    const tmp = g[r1][c1]; g[r1][c1] = g[r2][c2]; g[r2][c2] = tmp;
    const ok = this.localMatchAt(r1, c1) || this.localMatchAt(r2, c2);
    const tmp2 = g[r1][c1]; g[r1][c1] = g[r2][c2]; g[r2][c2] = tmp2; // 戻す
    return ok;
  }

  // セル (r,c) を中心に横/縦3連以上があるか (局所判定)
  localMatchAt(r, c) {
    const N = this.N, g = this.grid, t = g[r][c];
    // 横
    let cnt = 1;
    for (let k = c - 1; k >= 0 && g[r][k] === t; k--) cnt++;
    for (let k = c + 1; k < N && g[r][k] === t; k++) cnt++;
    if (cnt >= 3) return true;
    // 縦
    cnt = 1;
    for (let k = r - 1; k >= 0 && g[k][c] === t; k--) cnt++;
    for (let k = r + 1; k < N && g[k][c] === t; k++) cnt++;
    return cnt >= 3;
  }

  // ============================================================
  // 状態機械: スワップ → (マッチ判定) → CLEAR → FALL → 連鎖 …
  // ============================================================

  // 手動/オート共通のスワップ開始。隣接前提。
  beginSwap(r1, c1, r2, c2, isAuto) {
    if (this.state !== ST_IDLE) return;
    this.state = ST_SWAP;
    this.moves++;
    this.clearSelectionMark();

    const s1 = this.sprites[r1][c1], s2 = this.sprites[r2][c2];
    const willMatch = this.swapWouldMatch(r1, c1, r2, c2);

    // グリッド上は即入れ替え (見た目はトゥイーンで追従)
    this.swapGrid(r1, c1, r2, c2);

    let done = 0;
    const onHalf = () => {
      done++;
      if (done < 2) return;
      if (willMatch) {
        // 有効手: 連鎖開始
        this.chain = 0;
        this.resolveBoard();
      } else {
        // 無効手: 元に戻すスワップ
        this.swapGrid(r1, c1, r2, c2);
        this.state = ST_SWAP;
        this.tweenSwap(this.sprites[r1][c1], this.sprites[r2][c2], () => { this.state = ST_IDLE; });
      }
    };
    // スワップ後の sprites は入れ替え済みなので新しい位置の2スプライトを動かす
    this.tweenSwap(this.sprites[r1][c1], this.sprites[r2][c2], onHalf, true);
  }

  // グリッドとスプライト配列を同時に入れ替える (論理状態の交換)
  swapGrid(r1, c1, r2, c2) {
    const tg = this.grid[r1][c1]; this.grid[r1][c1] = this.grid[r2][c2]; this.grid[r2][c2] = tg;
    const ts = this.sprites[r1][c1]; this.sprites[r1][c1] = this.sprites[r2][c2]; this.sprites[r2][c2] = ts;
  }

  // 2スプライトを互いの目標セルへトゥイーン (Phaser Tweens)。
  //  split=true のとき onComplete を「2本ぶん」呼ぶ前提で各々に渡す。
  tweenSwap(spA, spB, onComplete, split) {
    // spA / spB は既に入れ替え後の sprites 配列上の位置にある。
    // 目標座標 = 現在配列インデックスから逆算するのではなく、相手の現在座標を使う。
    const ax = spA.x, ay = spA.y, bx = spB.x, by = spB.y;
    const mk = (sp, tx, ty) => {
      this.activeTweenCount++;
      this.tweens.add({
        targets: sp, x: tx, y: ty,
        duration: SWAP_SEC * 1000, ease: 'Quad.easeInOut',
        onComplete: () => { this.activeTweenCount--; onComplete && onComplete(); },
      });
    };
    mk(spA, bx, by);
    mk(spB, ax, ay);
  }

  // 盤面を「全マッチ消去 → 落下/補充 → 再マッチ」で連鎖が尽きるまで解決する。
  // 1段階ぶんを進め、トゥイーン完了コールバックで次段へ進む。
  resolveBoard() {
    const matches = this.findMatches();
    if (matches.size === 0) {
      // 連鎖終了
      this.chain = 0;
      this.state = ST_IDLE;
      // スプライト座標を正規化 (浮動小数の累積ずれ防止)
      this.snapSprites();
      return;
    }
    this.chain++;
    this.state = ST_CLEAR;

    // スコア: 消去数 × 10 × 連鎖係数(=連鎖段数)
    this.score += matches.size * SCORE_PER_GEM * this.chain;

    // CLEAR トゥイーン: 各セルを縮小+フェード (セル単位でトゥイーンを張る)
    let remain = matches.size;
    const afterClear = () => {
      remain--;
      if (remain > 0) return;
      this.applyFall(); // 全消滅完了後に落下処理へ
    };
    for (const key of matches) {
      const [r, c] = key.split(',').map(Number);
      const spr = this.sprites[r][c];
      this.sprites[r][c] = null;
      this.grid[r][c] = -1; // 空き
      this.activeTweenCount++;
      this.tweens.add({
        targets: spr, scale: 0, alpha: 0,
        duration: CLEAR_SEC * 1000, ease: 'Back.easeIn',
        onComplete: () => {
          this.activeTweenCount--;
          spr.destroy();
          afterClear();
        },
      });
    }
  }

  // 落下 + 補充。空き (-1) を詰め、上端から決定的に補充。
  //  落下/出現はすべて「セル単位」のトゥイーンで張り、同時トゥイーン数を最大化する。
  applyFall() {
    this.state = ST_FALL;
    const N = this.N;
    // 補充用 PRNG (リセット回数 + 手数 + 連鎖をシードに混ぜ、決定的だが進行で変化)
    const rng = mulberry32((0xFA11 ^ (this.resetCounter * 2654435761) ^ (this.moves * 0x9E3779B1) ^ (this.chain * 40503)) >>> 0);

    let tweenJobs = 0; // 張った落下トゥイーン本数

    // 列ごとに下から詰める
    for (let c = 0; c < N; c++) {
      let writeR = N - 1; // 次に埋める行 (下から)
      // 既存宝石を下へ落とす
      for (let r = N - 1; r >= 0; r--) {
        if (this.grid[r][c] !== -1) {
          if (writeR !== r) {
            // r → writeR へ落下
            this.grid[writeR][c] = this.grid[r][c];
            const spr = this.sprites[r][c];
            this.sprites[writeR][c] = spr;
            this.grid[r][c] = -1;
            this.sprites[r][c] = null;
            tweenJobs += this.tweenFall(spr, writeR, c);
          }
          writeR--;
        }
      }
      // 残った上部の空きを新規宝石で補充 (writeR..0)
      for (let r = writeR; r >= 0; r--) {
        const type = Math.floor(rng() * GEM_TYPES);
        this.grid[r][c] = type;
        // 盤面上端のさらに上から登場させて落下
        const spawnRow = r - (writeR + 1); // 負値 (画面外上)
        const spr = this.makeGemSprite(r, c, type);
        spr.y = this.cellCY(spawnRow);
        this.sprites[r][c] = spr;
        tweenJobs += this.tweenFall(spr, r, c);
      }
    }

    if (tweenJobs === 0) {
      // 落下が一切無い (理論上は起きないが保険) → 即再判定
      this.resolveAfterFall();
    }
    // 各落下トゥイーン完了で残数を数え、全完了で再判定する。
    this._fallRemain = tweenJobs;
  }

  // 1宝石を目標セル (r,c) へ落下トゥイーン。距離に比例した時間 (線形 + わずかな加速感)。
  tweenFall(spr, r, c) {
    const targetY = this.cellCY(r);
    const dist = Math.max(1, Math.abs(targetY - spr.y) / this.cell); // セル距離
    const dur = FALL_PER_CELL * dist * 1000;
    this.activeTweenCount++;
    this.tweens.add({
      targets: spr, y: targetY,
      duration: dur, ease: 'Quad.easeIn', // 加速付き
      onComplete: () => {
        this.activeTweenCount--;
        this._fallRemain--;
        if (this._fallRemain <= 0) this.resolveAfterFall();
      },
    });
    return 1;
  }

  // 落下完了後: 新たなマッチがあれば連鎖継続 (CLEAR へ)、無ければ IDLE。
  resolveAfterFall() {
    this.resolveBoard();
  }

  // 全スプライトを格子座標へスナップ (連鎖終了時の整列)
  snapSprites() {
    for (let r = 0; r < this.N; r++) {
      for (let c = 0; c < this.N; c++) {
        const spr = this.sprites[r][c];
        if (spr) { spr.x = this.cellCX(c); spr.y = this.cellCY(r); spr.setScale(this.gemScale(GEM_KEYS[spr.gemType])); }
      }
    }
  }

  // ============================================================
  // オートプレイ (決定的ソルバ)
  // ============================================================
  // 盤面を左上から走査し、最初に見つかった「マッチを生む隣接スワップ」を打つ。
  // 有効手が無ければ決定的シャッフル。
  autoStep() {
    const N = this.N;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        // 右隣
        if (c + 1 < N && this.swapWouldMatch(r, c, r, c + 1)) {
          this.beginSwap(r, c, r, c + 1, true);
          return;
        }
        // 下隣
        if (r + 1 < N && this.swapWouldMatch(r, c, r + 1, c)) {
          this.beginSwap(r, c, r + 1, c, true);
          return;
        }
      }
    }
    // 有効手なし → 決定的シャッフル
    this.deterministicShuffle();
  }

  // 決定的シャッフル: 盤面全体を PRNG で再配置 (Fisher-Yates) し、初期マッチを潰す。
  deterministicShuffle() {
    const N = this.N;
    const rng = mulberry32((0x5417F ^ (this.resetCounter * 0x9E3779B1) ^ (this.moves * 2654435761)) >>> 0);
    // 種別だけを集めてシャッフル → 再配置
    const flat = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flat.push(this.grid[r][c]);
    for (let i = flat.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = flat[i]; flat[i] = flat[j]; flat[j] = t;
    }
    let i = 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const type = flat[i++];
        this.grid[r][c] = type;
        const spr = this.sprites[r][c];
        spr.gemType = type;
        spr.setTexture(GEM_KEYS[type]);
        spr.setScale(this.gemScale(GEM_KEYS[type]));
      }
    }
    // シャッフル直後に既存マッチがあれば、それを連鎖として解決する (自然な動作)
    if (this.findMatches().size > 0) { this.chain = 0; this.resolveBoard(); }
  }

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true;
    this.resetBoard();
    if (this.titleEl) this.titleEl.style.display = 'none';
  }

  // ============================================================
  // 入力ハンドラ
  // ============================================================
  onPointerDown(p) {
    if (!this.started) return;   // アトラクト中はユーザーのスワップ操作を無効化
    if (this.state !== ST_IDLE) return;
    // ポインタ座標 → セル
    const c = Math.floor((p.worldX - this.boardX) / this.cell);
    const r = Math.floor((p.worldY - this.boardY) / this.cell);
    if (r < 0 || c < 0 || r >= this.N || c >= this.N) { this.clearSelection(); return; }

    if (!this.selected) {
      this.selected = { r, c };
      this.markSelection(r, c);
      return;
    }
    // 2回目: 同セルなら解除
    if (this.selected.r === r && this.selected.c === c) { this.clearSelection(); return; }
    // 隣接判定
    const dr = Math.abs(this.selected.r - r), dc = Math.abs(this.selected.c - c);
    if (dr + dc === 1) {
      const s = this.selected;
      this.clearSelection();
      this.beginSwap(s.r, s.c, r, c, false);
    } else {
      // 非隣接 → 選択を移し替え
      this.clearSelectionMark();
      this.selected = { r, c };
      this.markSelection(r, c);
    }
  }

  markSelection(r, c) {
    this.clearSelectionMark();
    this.selMark = this.add.rectangle(this.cellCX(c), this.cellCY(r), this.cell, this.cell)
      .setStrokeStyle(3, 0xffffff, 0.9).setDepth(2);
  }
  clearSelectionMark() { if (this.selMark) { this.selMark.destroy(); this.selMark = null; } }
  clearSelection() { this.selected = null; this.clearSelectionMark(); }

  // ============================================================
  // 盤面サイズ変更
  // ============================================================
  adjustN(delta) {
    const next = Phaser.Math.Clamp(this.N + delta, N_MIN, N_MAX);
    if (next === this.N) return;
    this.N = next;
    this.resetBoard(); // サイズ変更は決定的に再生成
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    const style = {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(10,16,22,0.6)',
      padding: { x: 8, y: 6 },
    };
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(1000);
  }

  updateHUD() {
    // 進行中トゥイーン数: Phaser 管理の実数 (getTweens) を表示。
    const liveTweens = this.tweens.getTweens().length;
    this.hud.setText([
      `FPS          : ${this.fpsAvg.toFixed(1)}`,
      `Board        : ${this.N} x ${this.N} = ${this.N * this.N} cells`,
      `Active tweens: ${liveTweens}`,
      `State        : ${this.state}`,
      `Chain        : ${this.chain}`,
      `Score        : ${this.score}`,
      `Moves        : ${this.moves}`,
      `Auto         : ${this.auto ? 'ON' : 'OFF'}`,
    ].join('\n'));
  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒 (スパイク抑制)

    // FPS 移動平均 (30 サンプル)
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    // オートプレイ: IDLE のときだけ一定間隔で1手打つ
    // (アトラクト中は auto トグルに関わらずデモAIを常時駆動)
    if ((this.auto || !this.started) && this.state === ST_IDLE) {
      this.autoTimer += dt;
      if (this.autoTimer >= AUTO_INTERVAL) {
        this.autoTimer = 0;
        this.autoStep();
      }
    }

    // タイトル点滅 (デモ中のみ)
    if (!this.started) {
      this.blinkT += dt;
      if (this.titleEl) this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }

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
  backgroundColor: '#0a0e16',
  scene: [BootScene, GameScene],
  render: { antialias: true, roundPixels: false },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
