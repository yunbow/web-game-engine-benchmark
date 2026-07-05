/* ============================================================
 * テーマ6 タワーディフェンス (経路探索 × 多数ユニット追従) ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠 (キャンバス 960x540 / グリッド 30x17 / タイル 32px /
 *       A* 4方向 マンハッタン距離 / 物理エンジン非使用＝経路追従・弾直進・距離判定は自前)。
 *
 * 性能比較の核: グリッド A* 経路探索 ＋ 多数ユニット(creep)の経路追従更新 ＋ タワー射撃。
 * タワー設置/撤去のたびに経路を再計算し、生存中の全 creep が現在地から追従し直す。
 * 数値はすべて SPEC.md に一致。決定的疑似乱数 (mulberry32) を使い Math.random は不使用。
 * ============================================================ */

// ---- 基本定数 ----
const TILE = 32;
const GRID_W = 30;              // タイル数 (横)
const GRID_H = 17;              // タイル数 (縦)
const VIEW_W = 960;
const VIEW_H = 540;             // 30x17 = 960x544 だが描画キャンバスは 540 固定

// グリッド種別: 0=通路(path/buildable) 1=壁(wall, 配置・通行不可)
const T_PATH = 0;
const T_WALL = 1;

// creep (敵) ― SPEC.md より
const CREEP_RADIUS = 10;        // 当たり判定半径 (描画直径 ~24)
const CREEP_SPEED = 70;         // px/s
const CREEP_HP = 30;            // HP
const SPAWN_INTERVAL = 0.5;     // スポーン間隔 秒
const GOLD_PER_KILL = 5;        // 撃破ゴールド
const SCORE_PER_KILL = 10;      // 撃破スコア

// タワー ― SPEC.md より
const TOWER_COST = 25;          // 設置コスト Gold
const TOWER_RANGE = 96;         // 射程 px
const TOWER_FIRE_INTERVAL = 0.6;// 連射間隔 秒
const TOWER_DAMAGE = 10;        // 弾ダメージ

// 弾 (projectile) ― SPEC.md より
const PROJ_SPEED = 320;         // 弾速 px/s
const PROJ_RADIUS = 6;          // 弾半径 (当たり: 距離 < 敵半径 + 弾半径)

// 敵数 (負荷)
const INITIAL_CAP = 30;
const CAP_STEP = 10;
const MIN_CAP = 10;
const MAX_CAP = 500;

// 資源
const INITIAL_GOLD = 120;
const INITIAL_LIVES = 20;

// ---- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ----
// scene.restart() を跨いで保持する必要があるためモジュールスコープに置く。
let started = false;
let blinkT = 0;
// デモAI: 決定的な固定座標へ数基自動配置して防衛デモにする (Math.random 不使用)
const DEMO_TOWERS = [
  [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
  [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
];

// フォールバック色 (SPEC.md: 敵=赤丸 / タワー=青矩形 / 弾=黄丸 / 通路=濃灰 / 壁=灰 / ゴール=緑 / spark=白丸)
const COL_PATH = 0x2a2f36;
const COL_WALL = 0x70767e;
const COL_BASE = 0x36c451;

// ---- 決定的疑似乱数 (Mulberry32) ----
// マップ生成はこの PRNG で行い、Math.random は使わない。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- マップ生成 (決定的・固定シード) ----
// 外周を壁で囲み、スタート(左端中央)/ゴール(右端中央)の開口部のみ空ける。
// 内部に決定的な障害物 (壁ブロック) を散らす。スタート→ゴールの経路が必ず残ることを
// A* で検証し、塞いでしまったブロックは取り除く (決定的に再現可能)。
function generateMap() {
  const rng = mulberry32(0x70D6); // seed 固定
  const map = new Uint8Array(GRID_W * GRID_H);
  const idx = (x, y) => y * GRID_W + x;

  // 全面通路で初期化
  map.fill(T_PATH);

  // 外周を壁で囲む
  for (let x = 0; x < GRID_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, GRID_H - 1)] = T_WALL; }
  for (let y = 0; y < GRID_H; y++) { map[idx(0, y)] = T_WALL; map[idx(GRID_W - 1, y)] = T_WALL; }

  const midY = (GRID_H >> 1);          // 8
  const start = { x: 1, y: midY };     // 左端中央 (開口部の内側)
  const goal = { x: GRID_W - 2, y: midY }; // 右端中央

  // 外周の開口部 (スタート/ゴール) を空ける
  map[idx(0, midY)] = T_PATH;
  map[idx(GRID_W - 1, midY)] = T_PATH;

  // 内部に決定的な壁ブロックを散らす (短い縦/横の壁列)。
  // スタート/ゴール周辺は確実に空けておく。
  const protect = (x, y) =>
    (Math.abs(x - start.x) <= 1 && Math.abs(y - start.y) <= 1) ||
    (Math.abs(x - goal.x) <= 1 && Math.abs(y - goal.y) <= 1);

  for (let bx = 4; bx < GRID_W - 4; bx += 2 + Math.floor(rng() * 2)) {
    if (rng() < 0.55) {
      const len = 2 + Math.floor(rng() * 5);          // 壁列の長さ 2〜6
      const vertical = rng() < 0.6;                    // 縦壁が多め
      // 上から伸ばすか下から伸ばすかを決定的に選ぶ
      const fromTop = rng() < 0.5;
      const by = fromTop ? 1 + Math.floor(rng() * 3)
                         : GRID_H - 2 - Math.floor(rng() * 3);
      for (let i = 0; i < len; i++) {
        const x = vertical ? bx : bx + i;
        const y = vertical ? (fromTop ? by + i : by - i) : by;
        if (x <= 1 || x >= GRID_W - 1 || y <= 0 || y >= GRID_H - 1) continue;
        if (protect(x, y)) continue;
        map[idx(x, y)] = T_WALL;
      }
    }
  }

  // 経路が残ることを保証: A* で start→goal を解き、解けなければ壁を間引いて再試行。
  // (決定的: 同じマップに対し同じ順序で間引くため再現性あり)
  const ensure = () => {
    let guard = 0;
    while (!astar(map, idx, start, goal) && guard < 2000) {
      // 経路がないので内部壁を中央寄りから 1 つ通路に戻す (決定的な走査順)
      let removed = false;
      for (let y = 1; y < GRID_H - 1 && !removed; y++) {
        for (let x = 2; x < GRID_W - 2 && !removed; x++) {
          if (map[idx(x, y)] === T_WALL) { map[idx(x, y)] = T_PATH; removed = true; }
        }
      }
      if (!removed) break;
      guard++;
    }
  };
  ensure();

  return { map, idx, start, goal, midY };
}

// ============================================================
// A* 経路探索 (4方向 / コスト1 / マンハッタン距離ヒューリスティック)
// blocked(x,y) が true のセルは通行不可。grid 上の {x,y} 列を返す (start..goal)。
// 解なしなら null。
// ============================================================
function astar(map, idx, start, goal, isBlocked) {
  // isBlocked 省略時は「壁のみ通行不可」
  const blocked = isBlocked || ((x, y) => map[idx(x, y)] === T_WALL);
  if (blocked(goal.x, goal.y) || blocked(start.x, start.y)) {
    // start/goal 自体が塞がれている場合は探索不可
    if (blocked(goal.x, goal.y)) return null;
  }

  const N = GRID_W * GRID_H;
  const gScore = new Float64Array(N).fill(Infinity);
  const fScore = new Float64Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const inOpen = new Uint8Array(N);
  const closed = new Uint8Array(N);

  const h = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const sId = idx(start.x, start.y);
  gScore[sId] = 0;
  fScore[sId] = h(start.x, start.y);

  // バイナリヒープ (最小 fScore) ― 多数の再計算に耐えるよう配列ヒープで実装。
  const heap = [];        // 格納するのはセル id
  const heapPush = (id) => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fScore[heap[p]] <= fScore[heap[i]]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const n = heap.length;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let s = i;
        if (l < n && fScore[heap[l]] < fScore[heap[s]]) s = l;
        if (r < n && fScore[heap[r]] < fScore[heap[s]]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };

  heapPush(sId); inOpen[sId] = 1;
  const gId = idx(goal.x, goal.y);

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  while (heap.length > 0) {
    const cur = heapPop();
    inOpen[cur] = 0;
    if (cur === gId) {
      // 経路を復元
      const path = [];
      let c = cur;
      while (c !== -1) {
        path.push({ x: c % GRID_W, y: (c / GRID_W) | 0 });
        c = cameFrom[c];
      }
      path.reverse();
      return path;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % GRID_W, cy = (cur / GRID_W) | 0;

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      if (blocked(nx, ny)) continue;
      const nId = idx(nx, ny);
      if (closed[nId]) continue;
      const tentative = gScore[cur] + 1;
      if (tentative < gScore[nId]) {
        cameFrom[nId] = cur;
        gScore[nId] = tentative;
        fScore[nId] = tentative + h(nx, ny);
        if (!inOpen[nId]) { heapPush(nId); inOpen[nId] = 1; }
        else heapPush(nId); // fScore 更新ぶんを再投入 (closed で重複排除)
      }
    }
  }
  return null;
}

// ============================================================
// BootScene ― アセット読込 + 失敗キャプチャ
// ============================================================
const ASSET_DEFS = [
  { key: 'creep',      file: 'creep.png' },
  { key: 'tower',      file: 'tower.png' },
  { key: 'projectile', file: 'projectile.png' },
  { key: 'tile_path',  file: 'tile_path.png' },
  { key: 'tile_wall',  file: 'tile_wall.png' },
  { key: 'base',       file: 'base.png' },
  { key: 'hit_spark',  file: 'hit_spark.png' },
];
const failedAssets = new Set();

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

  // Graphics.generateTexture で単色/図形テクスチャを焼いてフォールバック。
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      if (this.textures.exists(key) && !failedAssets.has(key)) return; // 正常ロード済み
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 敵 = 赤丸 (24x24)
    make('creep', 24, 24, (g, w, h) => {
      g.fillStyle(0xe23b3b, 1).fillCircle(w / 2, h / 2, 11);
      g.fillStyle(0xff8a8a, 1).fillCircle(w / 2 - 3, h / 2 - 3, 4);
    });

    // タワー = 青矩形 (32x32)
    make('tower', TILE, TILE, (g, w, h) => {
      g.fillStyle(0x2f6fe0, 1).fillRoundedRect(3, 3, w - 6, h - 6, 4);
      g.fillStyle(0x9ec3ff, 1).fillCircle(w / 2, h / 2, 6);
      g.lineStyle(2, 0x16356f, 1).strokeRoundedRect(3, 3, w - 6, h - 6, 4);
    });

    // 弾 = 黄丸 (12x12)
    make('projectile', 12, 12, (g, w, h) => {
      g.fillStyle(0xffd23b, 1).fillCircle(w / 2, h / 2, 5);
      g.fillStyle(0xfff4c0, 1).fillCircle(w / 2 - 1, h / 2 - 1, 2);
    });

    // 通路タイル = 濃灰 (32x32)
    make('tile_path', TILE, TILE, (g, w, h) => {
      g.fillStyle(COL_PATH, 1).fillRect(0, 0, w, h);
      g.lineStyle(1, 0x000000, 0.18).strokeRect(0.5, 0.5, w - 1, h - 1);
    });

    // 壁タイル = 灰 (32x32)
    make('tile_wall', TILE, TILE, (g, w, h) => {
      g.fillStyle(COL_WALL, 1).fillRect(0, 0, w, h);
      g.fillStyle(0x565b62, 1).fillRect(0, 0, w, 4).fillRect(0, h - 4, w, 4);
      g.lineStyle(1, 0x000000, 0.25).strokeRect(0.5, 0.5, w - 1, h - 1);
    });

    // ゴール (自陣) = 緑旗 (32x32)
    make('base', TILE, TILE, (g, w, h) => {
      g.fillStyle(COL_BASE, 1).fillRect(2, 2, w - 4, h - 4);
      g.fillStyle(0x0f5e25, 1).fillRect(w / 2 - 2, 4, 3, h - 8);
      g.fillStyle(0xfff2a0, 1).fillTriangle(w / 2 + 1, 5, w / 2 + 12, 9, w / 2 + 1, 13);
    });

    // 撃破スパーク (hit_spark) = 白丸 (32x32)
    make('hit_spark', TILE, TILE, (g, w, h) => {
      g.fillStyle(0xffffff, 1).fillCircle(w / 2, h / 2, 13);
      g.fillStyle(0xffe066, 1).fillCircle(w / 2, h / 2, 7);
    });
  }
}

// ============================================================
// GameScene ― 本体
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    this.initState();

    // --- マップ静的描画: 通路/壁/ゴール の Blitter を 1 枚ずつ ---
    // (Blitter は単一テクスチャ + 多数 Bob を高速バッチできるためタイルに好適)
    this.tileLayer = this.add.container(0, 0).setDepth(0);
    this.pathTileBlitter = this.add.blitter(0, 0, 'tile_path').setDepth(0);
    this.wallTileBlitter = this.add.blitter(0, 0, 'tile_wall').setDepth(1);
    this.drawStaticMap();

    // ゴール (自陣) スプライト
    this.baseSprite = this.add.image(
      this.goal.x * TILE + TILE / 2, this.goal.y * TILE + TILE / 2, 'base'
    ).setDepth(2);

    // --- 経路ハイライト用 Graphics オーバーレイ (画像不要) ---
    this.pathGfx = this.add.graphics().setDepth(3);

    // --- 射程プレビュー (マウスホバー中のタイルに薄い円) ---
    this.rangeGfx = this.add.graphics().setDepth(4);

    // --- タワー (Map はパス計算前に initState で初期化済み) ---
    this.towerLayer = this.add.container(0, 0).setDepth(5);

    // --- creep (オブジェクトプール) ---
    this.creepLayer = this.add.container(0, 0).setDepth(6);
    this.creepPool = [];

    // --- 弾 (オブジェクトプール) ---
    this.projLayer = this.add.container(0, 0).setDepth(7);
    this.projPool = [];

    // --- エフェクト (hit_spark プール) ---
    this.effectLayer = this.add.container(0, 0).setDepth(8);
    this.effectPool = [];

    // --- 入力 ---
    this.input.mouse.disableContextMenu(); // 右クリックメニュー抑止
    this.input.on('pointerdown', (pointer) => this.onPointerDown(pointer));
    this.input.on('pointermove', (pointer) => { this.hoverPx = pointer.x; this.hoverPy = pointer.y; });
    this.hoverPx = -1; this.hoverPy = -1;

    this.input.keyboard.on('keydown-PLUS', () => this.adjustCap(+CAP_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustCap(-CAP_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustCap(+CAP_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustCap(-CAP_STEP));
    this.input.keyboard.on('keydown-R', () => this.scene.restart());
    this.input.keyboard.on('keydown-ENTER', () => { if (!started) this.startGame(); });

    // タイトル/アトラクト オーバーレイ (HTML)
    this.titleEl = document.getElementById('title');
    if (this.titleEl) this.titleEl.style.display = started ? 'none' : 'grid';

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;
  }

  // ゲーム状態の初期化 (restart でも呼ばれる)
  initState() {
    const world = generateMap();
    this.map = world.map;
    this.idxOf = world.idx;
    this.start = world.start;
    this.goal = world.goal;

    this.gold = INITIAL_GOLD;
    this.lives = INITIAL_LIVES;
    this.score = 0;
    this.cap = INITIAL_CAP;
    this.gameOver = false;

    this.pathRecalcs = 0;
    this.spawnTimer = 0;

    // デモAIの自動配置進捗 (この run 内で進める)
    this.demoIdx = 0;
    this.demoTimer = 0;

    // タワー Map はパス計算より前に初期化する
    // (computePath → blocked() が this.towers.has を参照するため、ここで先に用意する)
    this.towers = new Map();

    // start→goal の基準経路 (タワーを壁として扱う) を計算
    this.currentPath = this.computePath(this.start, this.goal);
    if (this.currentPath) this.pathRecalcs++;
  }

  // Enter でデモ→プレイ開始: started を立て、新規リセット (scene.restart) で操作を有効化。
  startGame() {
    started = true;
    blinkT = 0;
    if (this.titleEl) this.titleEl.style.display = 'none';
    this.scene.restart();
  }

  // デモAI: 一定間隔で次の候補タイルへタワーを試行設置 (placeTower が不正配置を弾く)
  demoTick(dt) {
    this.demoTimer += dt;
    if (this.demoTimer >= 0.8 && this.demoIdx < DEMO_TOWERS.length && this.gold >= TOWER_COST) {
      this.demoTimer = 0;
      const cell = DEMO_TOWERS[this.demoIdx++];
      this.placeTower(cell[0], cell[1], this.idxOf(cell[0], cell[1]));
    }
  }

  // ============================================================
  // 経路探索ラッパ: 壁 OR タワーが置かれたセルを通行不可として A* を解く。
  // ============================================================
  computePath(from, to) {
    const blocked = (x, y) =>
      this.map[this.idxOf(x, y)] === T_WALL || this.towers.has(this.idxOf(x, y));
    return astar(this.map, this.idxOf, from, to, blocked);
  }

  // ============================================================
  // マップ静的描画 (Blitter)
  // ============================================================
  drawStaticMap() {
    this.pathTileBlitter.clear();
    this.wallTileBlitter.clear();
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = this.map[this.idxOf(x, y)];
        if (t === T_WALL) this.wallTileBlitter.create(x * TILE, y * TILE);
        else this.pathTileBlitter.create(x * TILE, y * TILE);
      }
    }
  }

  // 現在経路を薄く重ねて可視化 (タイル中心を線でつなぐ + 各セルに半透明矩形)
  drawPathOverlay() {
    const g = this.pathGfx;
    g.clear();
    if (!this.currentPath || this.currentPath.length < 1) return;
    // セル塗り
    g.fillStyle(0x3aa0ff, 0.12);
    for (const c of this.currentPath) {
      g.fillRect(c.x * TILE + 2, c.y * TILE + 2, TILE - 4, TILE - 4);
    }
    // 中心線
    g.lineStyle(3, 0x66c0ff, 0.45);
    g.beginPath();
    for (let i = 0; i < this.currentPath.length; i++) {
      const c = this.currentPath[i];
      const px = c.x * TILE + TILE / 2, py = c.y * TILE + TILE / 2;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokePath();
  }

  // ============================================================
  // ポインタ操作: 左=設置 / 右=撤去
  // ============================================================
  onPointerDown(pointer) {
    if (!started) return;   // アトラクト中はプレイヤー操作を無効化
    const tx = Math.floor(pointer.x / TILE);
    const ty = Math.floor(pointer.y / TILE);
    if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return;
    const id = this.idxOf(tx, ty);

    if (pointer.rightButtonDown()) {
      // --- 撤去 (返金なし・経路再計算) ---
      this.removeTower(tx, ty, id);
      return;
    }

    // --- 設置 ---
    this.placeTower(tx, ty, id);
  }

  placeTower(tx, ty, id) {
    if (this.gameOver) return;
    // 通路タイルのみ・既設なし・スタート/ゴール上は不可
    if (this.map[id] === T_WALL) return;
    if (this.towers.has(id)) return;
    if ((tx === this.start.x && ty === this.start.y) ||
        (tx === this.goal.x && ty === this.goal.y)) return;
    if (this.gold < TOWER_COST) return;

    // 仮設置して経路が残るか検証 (ゴールへ到達不能になる配置は禁止)
    this.towers.set(id, null); // 一時マーカ
    const testPath = this.computePath(this.start, this.goal);
    if (!testPath) {
      this.towers.delete(id); // 経路を塞ぐので設置失敗
      return;
    }
    // 正式に設置
    const spr = this.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, 'tower');
    this.towerLayer.add(spr);
    this.towers.set(id, { spr, fireTimer: 0, tx, ty,
      cx: tx * TILE + TILE / 2, cy: ty * TILE + TILE / 2 });
    this.gold -= TOWER_COST;

    // 経路を確定して全 creep を追従し直させる
    this.currentPath = testPath;
    this.pathRecalcs++;
    this.repathAllCreeps();
  }

  removeTower(tx, ty, id) {
    const t = this.towers.get(id);
    if (!t) return;
    t.spr.destroy();
    this.towers.delete(id);
    // 経路再計算 (短くなる方向)
    this.currentPath = this.computePath(this.start, this.goal);
    this.pathRecalcs++;
    this.repathAllCreeps();
  }

  // ============================================================
  // creep: スポーン / 経路追従 / 撃破
  // ============================================================
  // 生存数が上限未満なら start から 1 体スポーン。
  spawnCreep() {
    if (this.gameOver) return;
    const alive = this.aliveCreepCount();
    if (alive >= this.cap) return;

    // start からの経路 (タワー含む現在経路)。なければスポーンしない。
    const path = this.currentPath;
    if (!path || path.length === 0) return;

    const sx = this.start.x * TILE + TILE / 2;
    const sy = this.start.y * TILE + TILE / 2;

    let c = this.creepPool.find((e) => !e.active);
    if (!c) {
      const spr = this.add.image(sx, sy, 'creep');
      this.creepLayer.add(spr);
      c = { spr, active: true };
      this.creepPool.push(c);
    }
    c.active = true;
    c.x = sx; c.y = sy;
    c.hp = CREEP_HP;
    // 経路 (タイル中心列) を保持し、現在向かう wp index を持つ
    c.path = path.map((p) => ({ x: p.x * TILE + TILE / 2, y: p.y * TILE + TILE / 2 }));
    c.wp = 1; // path[0] は start 自身なので次から
    c.spr.setVisible(true).setPosition(sx, sy);
  }

  aliveCreepCount() {
    let n = 0;
    for (const c of this.creepPool) if (c.active) n++;
    return n;
  }

  // タワー設置/撤去で経路が変わったとき、各 creep を現在セルから再計算した経路に追従し直させる。
  repathAllCreeps() {
    for (const c of this.creepPool) {
      if (!c.active) continue;
      const cell = { x: Math.floor(c.x / TILE), y: Math.floor(c.y / TILE) };
      // 現在セルがタワー/壁になっている場合は最寄りの通行可能セルへ寄せる
      let from = cell;
      if (this.map[this.idxOf(cell.x, cell.y)] === T_WALL ||
          this.towers.has(this.idxOf(cell.x, cell.y))) {
        from = this.nearestOpenCell(cell);
      }
      const p = this.computePath(from, this.goal);
      this.pathRecalcs++;
      if (p && p.length > 0) {
        c.path = p.map((q) => ({ x: q.x * TILE + TILE / 2, y: q.y * TILE + TILE / 2 }));
        c.wp = 0; // 現在地から先頭ウェイポイントへ向かう
      }
      // 経路が取れない場合は従来経路を維持 (設置側で全閉塞は禁止済み)
    }
  }

  // 4近傍から通行可能セルを 1 つ探す (簡易フォールバック)
  nearestOpenCell(cell) {
    const DIRS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of DIRS) {
      const x = cell.x + dx, y = cell.y + dy;
      if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
      if (this.map[this.idxOf(x, y)] !== T_WALL && !this.towers.has(this.idxOf(x, y)))
        return { x, y };
    }
    return cell;
  }

  updateCreeps(dt) {
    for (const c of this.creepPool) {
      if (!c.active) continue;
      // 経路に沿って線形に進む
      let move = CREEP_SPEED * dt;
      while (move > 0 && c.wp < c.path.length) {
        const wp = c.path[c.wp];
        const dx = wp.x - c.x, dy = wp.y - c.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= move) {
          c.x = wp.x; c.y = wp.y;
          move -= dist;
          c.wp++;
        } else {
          c.x += (dx / dist) * move;
          c.y += (dy / dist) * move;
          move = 0;
        }
      }
      c.spr.setPosition(c.x, c.y);

      // ゴール到達判定 (経路を消化しきった = 末尾ウェイポイント到達)
      if (c.wp >= c.path.length) {
        c.active = false; c.spr.setVisible(false);
        this.lives -= 1;
        if (this.lives <= 0) { this.lives = 0; this.gameOver = true; }
      }
    }
  }

  killCreep(c) {
    c.active = false;
    c.spr.setVisible(false);
    this.gold += GOLD_PER_KILL;
    this.score += SCORE_PER_KILL;
    this.spawnSpark(c.x, c.y);
  }

  // ============================================================
  // タワー射撃 + 弾
  // ============================================================
  updateTowers(dt) {
    for (const t of this.towers.values()) {
      if (!t) continue;
      t.fireTimer -= dt;
      if (t.fireTimer > 0) continue;

      // 射程内で最も進行度が高い (ゴールに近い = wp が大きい) 敵を狙う
      let target = null;
      let bestProgress = -1;
      const r2 = TOWER_RANGE * TOWER_RANGE;
      for (const c of this.creepPool) {
        if (!c.active) continue;
        const dx = c.x - t.cx, dy = c.y - t.cy;
        if (dx * dx + dy * dy > r2) continue;
        // 進行度: ゴールまでの残りウェイポイント数が少ないほど「進んでいる」とみなす。
        // (creep ごとに経路長が異なるため残り wp で比較し、最もゴールに近い敵を狙う)
        const prog = -(c.path.length - c.wp);
        if (prog > bestProgress) { bestProgress = prog; target = c; }
      }
      if (target) {
        this.fireProjectile(t.cx, t.cy, target);
        t.fireTimer = TOWER_FIRE_INTERVAL;
      }
    }
  }

  fireProjectile(x, y, target) {
    let p = this.projPool.find((e) => !e.active);
    if (!p) {
      const spr = this.add.image(x, y, 'projectile');
      this.projLayer.add(spr);
      p = { spr, active: true };
      this.projPool.push(p);
    }
    p.active = true;
    p.x = x; p.y = y;
    p.target = target; // 追尾 (発射時の敵を狙う)
    p.spr.setVisible(true).setPosition(x, y);
  }

  updateProjectiles(dt) {
    const hitDist = CREEP_RADIUS + PROJ_RADIUS;
    for (const p of this.projPool) {
      if (!p.active) continue;
      const tgt = p.target;
      // 標的が消滅していたら弾も消す
      if (!tgt || !tgt.active) { p.active = false; p.spr.setVisible(false); continue; }

      const dx = tgt.x - p.x, dy = tgt.y - p.y;
      const dist = Math.hypot(dx, dy);
      const step = PROJ_SPEED * dt;
      if (dist <= step || dist <= hitDist) {
        // 命中: ダメージ
        p.x = tgt.x; p.y = tgt.y;
        p.active = false; p.spr.setVisible(false);
        tgt.hp -= TOWER_DAMAGE;
        if (tgt.hp <= 0) this.killCreep(tgt);
      } else {
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        p.spr.setPosition(p.x, p.y);
      }
    }
  }

  // ============================================================
  // エフェクト (hit_spark) プール
  // ============================================================
  spawnSpark(x, y) {
    let ex = this.effectPool.find((e) => !e.active);
    if (!ex) {
      const spr = this.add.image(x, y, 'hit_spark');
      this.effectLayer.add(spr);
      ex = { spr, active: true, life: 0 };
      this.effectPool.push(ex);
    }
    ex.active = true; ex.life = 0.25;
    ex.spr.setVisible(true).setPosition(x, y).setScale(0.5).setAlpha(1);
  }

  updateEffects(dt) {
    for (const ex of this.effectPool) {
      if (!ex.active) continue;
      ex.life -= dt;
      ex.spr.setScale(ex.spr.scaleX + dt * 2);
      ex.spr.setAlpha(Math.max(0, ex.life / 0.25));
      if (ex.life <= 0) { ex.active = false; ex.spr.setVisible(false); }
    }
  }

  // ============================================================
  // 敵数上限 (負荷) 調整
  // ============================================================
  adjustCap(delta) {
    this.cap = Phaser.Math.Clamp(this.cap + delta, MIN_CAP, MAX_CAP);
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    const style = {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(10,16,22,0.55)',
      padding: { x: 8, y: 6 },
    };
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(1000);

    // GAME OVER 表示 (中央)
    this.overText = this.add.text(VIEW_W / 2, VIEW_H / 2, '', {
      fontFamily: 'Consolas, monospace', fontSize: '40px', color: '#ff6464',
      backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 20, y: 12 }, align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1001).setVisible(false);
  }

  updateHUD() {
    const alive = this.aliveCreepCount();
    let towerCount = this.towers.size;
    let projCount = 0;
    for (const p of this.projPool) if (p.active) projCount++;
    const pathLen = this.currentPath ? this.currentPath.length : 0;

    this.hud.setText([
      `FPS         : ${this.fpsAvg.toFixed(1)}`,
      `Enemies     : ${alive} / ${this.cap}`,
      `Towers      : ${towerCount}`,
      `Projectiles : ${projCount}`,
      `Path recalcs: ${this.pathRecalcs}`,
      `Path len    : ${pathLen}`,
      `Gold        : ${this.gold}`,
      `Lives       : ${this.lives}`,
      `Score       : ${this.score}`,
    ].join('\n'));

    if (this.gameOver && started) {
      this.overText.setText(`GAME OVER\nScore ${this.score}\nR で再開`).setVisible(true);
    } else {
      this.overText.setVisible(false);
    }
  }

  // タワー射程プレビュー (ホバー中の通路タイルに薄い円)
  drawRangePreview() {
    const g = this.rangeGfx;
    g.clear();
    if (this.hoverPx < 0) return;
    const tx = Math.floor(this.hoverPx / TILE);
    const ty = Math.floor(this.hoverPy / TILE);
    if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return;
    if (this.map[this.idxOf(tx, ty)] === T_WALL) return;
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    const occupied = this.towers.has(this.idxOf(tx, ty));
    g.lineStyle(1, occupied ? 0xff7a7a : 0x7affb0, 0.5);
    g.fillStyle(occupied ? 0xff7a7a : 0x7affb0, 0.07);
    g.fillCircle(cx, cy, TOWER_RANGE);
    g.strokeCircle(cx, cy, TOWER_RANGE);
    g.lineStyle(1, occupied ? 0xff7a7a : 0x7affb0, 0.8);
    g.strokeRect(tx * TILE + 1, ty * TILE + 1, TILE - 2, TILE - 2);
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

    // タイトル点滅 (約0.45秒周期)
    if (!started) {
      blinkT += dt;
      if (this.titleEl) this.titleEl.style.visibility =
        (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }

    // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
    if (this.gameOver && !started) { this.scene.restart(); return; }
    // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
    if (!started) this.demoTick(dt);

    // スポーン (生存数 < 上限のときのみ供給。GAME OVER 中は停止)
    if (!this.gameOver) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnCreep();
        this.spawnTimer += SPAWN_INTERVAL;
        if (this.spawnTimer < 0) this.spawnTimer = SPAWN_INTERVAL;
      }
    }

    this.updateCreeps(dt);
    this.updateTowers(dt);
    this.updateProjectiles(dt);
    this.updateEffects(dt);

    this.drawPathOverlay();
    this.drawRangePreview();
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
  backgroundColor: '#101418',
  scene: [BootScene, GameScene],
  render: { antialias: false, roundPixels: true, pixelArt: true },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
