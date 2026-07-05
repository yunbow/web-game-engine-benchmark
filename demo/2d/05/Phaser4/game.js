/* ============================================================
 * テーマ5 横スクロールアクション ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠 (タイル32x32 / マップ200x17 / カメラ水平追従 /
 *       カリング必須 / 物理エンジン非使用＝重力・AABB・反射を自前実装)。
 *
 * 画面 960x540 固定 / デルタタイム基準更新 / 数値はすべて SPEC.md に一致。
 * 性能比較の核: 広い横長タイルマップ描画(カリング) ＋ 重力/AABB物理 ＋ 多数の敵更新。
 * ============================================================ */

// ---- 基本定数 ----
const TILE = 32;
const MAP_W = 200;             // タイル数 (横)
const MAP_H = 17;              // タイル数 (縦)
const WORLD_W = MAP_W * TILE;  // 6400px
const WORLD_H = MAP_H * TILE;  // 544px
const VIEW_W = 960;
const VIEW_H = 540;

// 物理 (SPEC.md より, px/s 系)
const GRAVITY = 1800;          // 重力 px/s^2
const WALK_SPEED = 180;        // 歩き px/s
const DASH_SPEED = 288;        // ダッシュ px/s (×1.6)
const JUMP_VY = -640;          // ジャンプ初速 px/s
const JUMP_CUT = 0.45;         // 可変ジャンプ: キーを離した時の上昇減衰係数
const PLAYER_BOX_W = 24;       // 自機 当たり判定 幅
const PLAYER_BOX_H = 44;       // 自機 当たり判定 高さ
const PLAYER_DRAW_W = 32;      // 自機 描画 幅
const PLAYER_DRAW_H = 48;      // 自機 描画 高さ

const ENEMY_BOX = 28;          // 敵 当たり判定 28x28
const ENEMY_SPEED = 60;        // 敵 水平歩行 px/s
const STOMP_BOUNCE = -380;     // 踏みつけ後の跳ね返り vy
const INVULN_TIME = 1.0;       // 被弾後の無敵 (秒)
const KNOCKBACK_VX = 220;      // 被弾ノックバック水平速度

const STOMP_SCORE = 100;       // 踏みつけ撃破スコア
const COIN_SCORE = 50;         // コイン取得スコア
const INITIAL_HP = 3;

// 敵数 (負荷)
const INITIAL_ENEMIES = 20;
const ENEMY_STEP = 10;
const MIN_ENEMIES = 0;
const MAX_ENEMIES = 500;

const FALL_MARGIN = 80;        // ワールド下端 + この余白を越えたら穴落下扱い

// タイル種別: 0=空 1=地面 2=ブロック 3=土管
const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = new Set([T_GROUND, T_BRICK, T_PIPE]);

// フォールバック色
const TILE_COLOR = {
  [T_GROUND]: 0x9c5a2b, // 茶
  [T_BRICK]:  0xe08a2e, // 橙
  [T_PIPE]:   0x36a83a, // 緑
};

// ---- 決定的疑似乱数 (Mulberry32) ----
// マップ・コイン・敵配置はすべてこの PRNG で生成し、Math.random は使わない。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- マップ生成 (決定的) ----
// 最下段は地面、所々に穴(gap)、空中にブロック足場、地上に土管、左右端は壁。
// あわせて足場リスト(敵/コインのスポーン候補)とコイン配置も決定的に生成する。
function generateWorld() {
  const rng = mulberry32(0x5A1701); // seed 固定
  const map = new Uint8Array(MAP_W * MAP_H);
  const idx = (x, y) => y * MAP_W + x;

  const GROUND_TOP = MAP_H - 2; // 地面の上端行 (最下段=MAP_H-1 と 2行ぶん地面)
  const platforms = []; // {tx, x0, x1, topY}  敵/コインを乗せられる水平足場

  // --- 最下段の地面 + 穴 ---
  // 穴は決定的に配置。スポーン地点(左端付近)とゴール手前は穴を避ける。
  const gap = new Uint8Array(MAP_W); // 1 ならその列は穴 (地面なし)
  let gx = 12;
  while (gx < MAP_W - 8) {
    if (rng() < 0.5) {
      const w = 1; // 幅 1 (デモが確実に越えられる幅)
      for (let i = 0; i < w && gx + i < MAP_W - 6; i++) gap[gx + i] = 1;
      gx += w + 6 + Math.floor(rng() * 6);
    } else {
      gx += 5 + Math.floor(rng() * 6);
    }
  }
  // 地面 (最下段2行) を gap 以外に敷く
  for (let x = 0; x < MAP_W; x++) {
    if (gap[x]) continue;
    for (let y = GROUND_TOP; y < MAP_H; y++) map[idx(x, y)] = T_GROUND;
  }
  // 連続する地面区間を足場として登録
  {
    let run = -1;
    for (let x = 0; x <= MAP_W; x++) {
      const solidCol = x < MAP_W && !gap[x];
      if (solidCol && run < 0) run = x;
      if (!solidCol && run >= 0) {
        platforms.push({ x0: run, x1: x - 1, topY: GROUND_TOP });
        run = -1;
      }
    }
  }

  // --- 左右端は壁 (柱) ---
  for (let y = 0; y < MAP_H; y++) {
    map[idx(0, y)] = T_GROUND;
    map[idx(MAP_W - 1, y)] = T_GROUND;
  }

  // --- 空中ブロック足場 ---
  // 高さ違いの短い足場を等間隔に散らす。
  for (let bx = 16; bx < MAP_W - 8; bx += 6 + Math.floor(rng() * 5)) {
    if (rng() < 0.55) {
      const len = 2 + Math.floor(rng() * 3);            // 長さ 2〜4
      // ジャンプ頂点より上(行<=9)にのみ置き、穴/土管越えジャンプの天井にしない。
      const yy = 4 + Math.floor(rng() * 6);             // 4..9
      let placed = 0;
      for (let i = 0; i < len && bx + i < MAP_W - 2; i++) {
        map[idx(bx + i, yy)] = T_BRICK;
        placed++;
      }
      if (placed > 0) platforms.push({ x0: bx, x1: bx + placed - 1, topY: yy });
    }
  }

  // --- 地上の土管 ---
  // 地面のある列に高さ2〜3の土管を立てる。穴の近く(±4)には置かない
  // (土管越えジャンプが穴に着地してデモが落下するため)。
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (g < 0 || g >= MAP_W || gap[g]) return false;
    return true;
  };
  for (let px = 10; px < MAP_W - 6; px += 9 + Math.floor(rng() * 7)) {
    if (!noGapNear(px)) continue;
    if (rng() < 0.6) {
      const h = 2 + Math.floor(rng() * 2); // 高さ 2〜3
      const top = GROUND_TOP - h;
      for (let y = top; y < GROUND_TOP; y++) {
        map[idx(px, y)] = T_PIPE;
        map[idx(px + 1, y)] = T_PIPE;
      }
      // 土管の上面も足場
      platforms.push({ x0: px, x1: px + 1, topY: top });
    }
  }

  // --- スポーン地点 (左端から少し入った地面の上) ---
  const spawnTx = 3;
  // 当たり判定下端が地面上端 (GROUND_TOP*TILE) のすぐ上に来るように中心 y を決める
  const spawn = {
    x: spawnTx * TILE + TILE / 2,
    y: GROUND_TOP * TILE - PLAYER_BOX_H / 2 - 1,
  };
  // スポーン周辺は確実に地面・空きを確保
  for (let x = 1; x <= 6; x++) {
    gap[x] = 0;
    for (let y = GROUND_TOP; y < MAP_H; y++) map[idx(x, y)] = T_GROUND;
    for (let y = 0; y < GROUND_TOP; y++) {
      if (map[idx(x, y)] === T_BRICK || map[idx(x, y)] === T_PIPE) map[idx(x, y)] = T_EMPTY;
    }
  }

  // --- コイン配置 (決定的) ---
  // 各足場の上空 1 タイルにコインを散らす。
  const coins = [];
  const coinRng = mulberry32(0xC014); // コイン専用 seed
  for (const p of platforms) {
    for (let x = p.x0; x <= p.x1; x++) {
      if (coinRng() < 0.3) {
        coins.push({
          x: x * TILE + TILE / 2,
          y: (p.topY - 1) * TILE + TILE / 2,
        });
      }
    }
  }

  return { map, idx, spawn, platforms, coins, groundTop: GROUND_TOP };
}

// ============================================================
// BootScene ― アセット読込 + 失敗キャプチャ
// ============================================================
const ASSET_DEFS = [
  { key: 'player',       file: 'player.png' },
  { key: 'player_walk',  file: 'player_walk.png', frameWidth: 32, frameHeight: 48 },
  { key: 'enemy_goomba', file: 'enemy_goomba.png' },
  { key: 'enemy_goomba_walk', file: 'enemy_goomba_walk.png', frameWidth: 32, frameHeight: 32 },
  { key: 'tile_ground',  file: 'tile_ground.png' },
  { key: 'tile_brick',   file: 'tile_brick.png' },
  { key: 'tile_pipe',    file: 'tile_pipe.png' },
  { key: 'coin',         file: 'coin.png' },
  { key: 'bg_sky',       file: 'bg_sky.png' },
];
const failedAssets = new Set();

class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  preload() {
    // 画像が無くても起動する: 読込失敗を記録し、後でフォールバックテクスチャを生成。
    this.load.on('loaderror', (fileObj) => { failedAssets.add(fileObj.key); });
    for (const def of ASSET_DEFS) {
      if (def.frameWidth) this.load.spritesheet(def.key, '../assets/' + def.file, { frameWidth: def.frameWidth, frameHeight: def.frameHeight });
      else this.load.image(def.key, '../assets/' + def.file);
    }
  }

  create() {
    this.buildFallbackTextures();
    this.scene.start('GameScene');
  }

  // Graphics.generateTexture で単色/図形テクスチャを焼いてフォールバック。
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

    // 自機 = 赤矩形 (描画 32x48)
    make('player', PLAYER_DRAW_W, PLAYER_DRAW_H, (g, w, h) => {
      g.fillStyle(0xd83838, 1).fillRoundedRect(2, 2, w - 4, h - 4, 5);
      g.fillStyle(0xffffff, 1).fillRect(6, 12, 6, 6).fillRect(w - 12, 12, 6, 6);
      g.fillStyle(0x222222, 1).fillRect(8, 14, 3, 3).fillRect(w - 10, 14, 3, 3);
    });

    // goomba = 茶丸 (32x32)
    make('enemy_goomba', 32, 32, (g, w, h) => {
      g.fillStyle(0x7a4a1e, 1).fillCircle(w / 2, h / 2 - 2, 13);
      g.fillStyle(0x5a3414, 1).fillEllipse(w / 2, h - 5, 26, 9); // 足元
      g.fillStyle(0xffffff, 1).fillCircle(11, 13, 3).fillCircle(21, 13, 3);
      g.fillStyle(0x000000, 1).fillCircle(11, 13, 1.5).fillCircle(21, 13, 1.5);
    });

    // 地面タイル = 茶
    make('tile_ground', TILE, TILE, (g, w, h) => {
      g.fillStyle(TILE_COLOR[T_GROUND], 1).fillRect(0, 0, w, h);
      g.fillStyle(0x6f3f1d, 1).fillRect(0, 0, w, 4);
      g.lineStyle(1, 0x000000, 0.15).strokeRect(0.5, 0.5, w - 1, h - 1);
    });
    // ブロックタイル = 橙
    make('tile_brick', TILE, TILE, (g, w, h) => {
      g.fillStyle(TILE_COLOR[T_BRICK], 1).fillRect(0, 0, w, h);
      g.lineStyle(2, 0x8a4f15, 0.6);
      g.strokeRect(1, 1, w - 2, h - 2);
      g.lineBetween(0, h / 2, w, h / 2).lineBetween(w / 2, 0, w / 2, h / 2).lineBetween(0, 0, 0, 0);
    });
    // 土管タイル = 緑
    make('tile_pipe', TILE, TILE, (g, w, h) => {
      g.fillStyle(TILE_COLOR[T_PIPE], 1).fillRect(0, 0, w, h);
      g.fillStyle(0x1f7a22, 1).fillRect(0, 0, 5, h).fillRect(w - 5, 0, 5, h);
      g.fillStyle(0x7be07e, 1).fillRect(6, 0, 4, h);
    });

    // コイン = 黄丸 (24x24)
    make('coin', 24, 24, (g, w, h) => {
      g.fillStyle(0xf2c800, 1).fillCircle(w / 2, h / 2, 10);
      g.fillStyle(0xfff099, 1).fillCircle(w / 2, h / 2, 6);
      g.fillStyle(0xc79a00, 1).fillRect(w / 2 - 1, 5, 2, h - 10);
    });

    // 背景 = 空色 (512x512 タイル)
    make('bg_sky', 512, 512, (g, w, h) => {
      g.fillStyle(0x6fb3ff, 1).fillRect(0, 0, w, h);
      g.fillStyle(0xffffff, 0.85);
      g.fillCircle(110, 90, 26).fillCircle(140, 100, 30).fillCircle(170, 92, 24);
      g.fillCircle(360, 180, 30).fillCircle(395, 190, 34).fillCircle(430, 182, 26);
      g.fillStyle(0x4e8a3b, 1); // 遠景の丘
      g.fillCircle(250, 540, 120).fillCircle(430, 545, 140);
    });

    // 撃破スパーク (hit_spark) は画像不要なので常に生成
    if (!this.textures.exists('hit_spark')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1).fillCircle(16, 16, 14);
      g.fillStyle(0xffe066, 1).fillCircle(16, 16, 8);
      g.generateTexture('hit_spark', 32, 32);
      g.destroy();
    }
  }
}

// ============================================================
// GameScene ― 本体
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    const world = generateWorld();
    this.map = world.map;
    this.idxOf = world.idx;
    this.spawn = world.spawn;
    this.platforms = world.platforms;
    this.coinDefs = world.coins;       // 決定的なコイン初期配置
    this.groundTop = world.groundTop;

    // --- 背景 (カメラ非追従の空。視差用に tileSprite) ---
    this.bg = this.add.tileSprite(0, 0, VIEW_W, VIEW_H, 'bg_sky')
      .setOrigin(0, 0).setScrollFactor(0).setDepth(0);

    // --- マップ描画: タイル種別ごとに Blitter を 1 枚ずつ用意し、可視範囲のみ描画 ---
    // (テーマ3と同じ方式。Blitter は単一テクスチャ + 多数 Bob を高速バッチできる)
    this.tileTex = {
      [T_GROUND]: 'tile_ground',
      [T_BRICK]:  'tile_brick',
      [T_PIPE]:   'tile_pipe',
    };
    this.terrainBlitters = {};
    [T_GROUND, T_BRICK, T_PIPE].forEach((t) => {
      const b = this.add.blitter(0, 0, this.tileTex[t]);
      b.setDepth(1);
      this.terrainBlitters[t] = b;
    });
    this.lastCull = { x0: -1, x1: -1, y0: -1, y1: -1 };
    this.tilesDrawn = 0;

    // --- コイン (Blitter でまとめて描画。取得済みは管理配列で除外) ---
    this.coinBlitter = this.add.blitter(0, 0, 'coin').setDepth(3);
    this.coins = this.coinDefs.map((c) => ({ x: c.x, y: c.y, taken: false }));

    // --- 敵 (オブジェクトプール) ---
    this.enemyLayer = this.add.container(0, 0).setDepth(4);
    this.enemyPool = [];   // 全プール (active フラグで管理)
    this.enemyRng = mulberry32(0xE9E33); // 敵スポーン専用 seed
    this.maxEnemies = INITIAL_ENEMIES;

    // --- エフェクト (hit_spark) プール ---
    this.effectLayer = this.add.container(0, 0).setDepth(6);
    this.effectPool = [];

    // --- プレイヤー ---
    this.player = this.add.image(this.spawn.x, this.spawn.y, this.textures.exists('player_walk') ? 'player_walk' : 'player', 0).setDepth(5);
    this.pvx = 0;
    this.pvy = 0;
    this.grounded = false;
    this.facing = 1;
    this.invuln = 0;
    this.hp = INITIAL_HP;
    this.score = 0;
    this.coinsCollected = 0;
    this.jumpHeld = false;

    // --- タイトル/アトラクト状態 (false=デモ中・操作無効) ---
    this.started = false;
    this.blinkT = 0;
    this.titleEl = document.getElementById('title');

    // --- カメラ (水平追従。bounds でクランプ) ---
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.player, true, 0.18, 0.12);
    this.cameras.main.setRoundPixels(true);

    // --- 入力 ---
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
      SHIFT: Phaser.Input.Keyboard.KeyCodes.SHIFT,
    });
    // +/- で敵数調整 (Shift有無に関わらず物理キーで発火 + テンキー対応)
    this.input.keyboard.on('keydown-PLUS', () => this.adjustEnemies(+ENEMY_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustEnemies(-ENEMY_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustEnemies(+ENEMY_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustEnemies(-ENEMY_STEP));
    // Enter でデモ→プレイ開始
    this.input.keyboard.on('keydown-ENTER', () => { if (!this.started) this.startGame(); });

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // 初期敵スポーン
    this.syncEnemies();
  }

  // ============================================================
  // タイル判定ヘルパ
  // ============================================================
  isSolidTile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false; // 場外は空 (落下用)
    return SOLID.has(this.map[this.idxOf(tx, ty)]);
  }

  // AABB (cx,cy = 中心, w,h) が solid タイルに重なるか
  boxHitsSolid(cx, cy, w, h) {
    const left = cx - w / 2, right = cx + w / 2;
    const top = cy - h / 2, bottom = cy + h / 2;
    const tx0 = Math.floor(left / TILE);
    const tx1 = Math.floor((right - 0.001) / TILE);
    const ty0 = Math.floor(top / TILE);
    const ty1 = Math.floor((bottom - 0.001) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (this.isSolidTile(tx, ty)) return true;
      }
    }
    return false;
  }

  // ============================================================
  // 軸分離 AABB 移動 (x→解決, y→解決)。返り値で接地/天井ヒットを通知。
  // body = {x, y} は当たり判定中心。w,h はボックスサイズ。
  // ============================================================
  moveBody(body, dx, dy, w, h) {
    const res = { hitX: false, hitY: false, grounded: false };

    // --- X 軸 ---
    if (dx !== 0) {
      const nx = body.x + dx;
      if (this.boxHitsSolid(nx, body.y, w, h)) {
        // タイル境界へスナップ
        if (dx > 0) {
          const edge = nx + w / 2;
          const tx = Math.floor((edge - 0.001) / TILE);
          body.x = tx * TILE - w / 2 - 0.001;
        } else {
          const edge = nx - w / 2;
          const tx = Math.floor(edge / TILE);
          body.x = (tx + 1) * TILE + w / 2 + 0.001;
        }
        res.hitX = true;
      } else {
        body.x = nx;
      }
    }

    // --- Y 軸 ---
    if (dy !== 0) {
      const ny = body.y + dy;
      if (this.boxHitsSolid(body.x, ny, w, h)) {
        if (dy > 0) {
          const edge = ny + h / 2;
          const ty = Math.floor((edge - 0.001) / TILE);
          body.y = ty * TILE - h / 2 - 0.001;
          res.grounded = true; // 下方向で衝突 = 着地
        } else {
          const edge = ny - h / 2;
          const ty = Math.floor(edge / TILE);
          body.y = (ty + 1) * TILE + h / 2 + 0.001;
        }
        res.hitY = true;
      } else {
        body.y = ny;
      }
    }
    return res;
  }

  // ============================================================
  // 敵プール / スポーン (決定的)
  // ============================================================
  // 足場リストから決定的に n 体ぶんのスポーン位置を生成して同期する。
  syncEnemies() {
    // 必要数まで増やす / 余剰を非アクティブ化
    const want = this.maxEnemies;
    let active = this.enemyPool.filter((e) => e.active).length;

    if (active < want) {
      // 不足ぶんを決定的に追加スポーン
      for (let i = active; i < want; i++) this.spawnEnemyDeterministic(i);
    } else if (active > want) {
      // 末尾から非アクティブ化 (決定的にトリム)
      for (let i = this.enemyPool.length - 1; i >= 0 && active > want; i--) {
        const e = this.enemyPool[i];
        if (e.active) { e.active = false; e.spr.setVisible(false); active--; }
      }
    }
  }

  // index に対応する決定的な足場上の位置に敵を配置。
  spawnEnemyDeterministic(index) {
    // index ごとに安定した位置を得るため index を seed に混ぜた PRNG を使う。
    const r = mulberry32(0xE9E33 ^ (index * 0x9E3779B1));
    const plats = this.platforms;
    if (plats.length === 0) return;
    const p = plats[Math.floor(r() * plats.length)];
    const tx = p.x0 + Math.floor(r() * (p.x1 - p.x0 + 1));
    const cx = tx * TILE + TILE / 2;
    const cy = (p.topY) * TILE - ENEMY_BOX / 2; // 足場上面に乗せる
    const dir = r() < 0.5 ? -1 : 1;

    // プールから空きを探す
    let e = this.enemyPool.find((en) => !en.active);
    if (!e) {
      const spr = this.add.image(cx, cy, this.textures.exists('enemy_goomba_walk') ? 'enemy_goomba_walk' : 'enemy_goomba', 0);
      this.enemyLayer.add(spr);
      e = { spr, x: cx, y: cy, vx: 0, vy: 0, active: true };
      this.enemyPool.push(e);
    }
    e.x = cx; e.y = cy; e.vx = ENEMY_SPEED * dir; e.vy = 0;
    e.active = true;
    e.spr.setVisible(true).setPosition(cx, cy);
  }

  adjustEnemies(delta) {
    this.maxEnemies = Phaser.Math.Clamp(this.maxEnemies + delta, MIN_ENEMIES, MAX_ENEMIES);
    this.syncEnemies();
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
  }

  // ============================================================
  // カリング: カメラの worldView から可視タイル範囲を算出し、可視ぶんのみ Bob 再構築。
  // ============================================================
  cullTiles() {
    const cam = this.cameras.main;
    const margin = 1;
    const x0 = Math.max(0, Math.floor(cam.worldView.x / TILE) - margin);
    const y0 = Math.max(0, Math.floor(cam.worldView.y / TILE) - margin);
    const x1 = Math.min(MAP_W - 1, Math.ceil((cam.worldView.x + cam.worldView.width) / TILE) + margin);
    const y1 = Math.min(MAP_H - 1, Math.ceil((cam.worldView.y + cam.worldView.height) / TILE) + margin);

    // 範囲が前フレームと同一なら再構築不要 (描画タイル数は維持)
    if (x0 === this.lastCull.x0 && y0 === this.lastCull.y0 &&
        x1 === this.lastCull.x1 && y1 === this.lastCull.y1) {
      return;
    }
    this.lastCull = { x0, y0, x1, y1 };

    Object.values(this.terrainBlitters).forEach((b) => b.clear());
    let drawn = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.map[this.idxOf(x, y)];
        if (t === T_EMPTY) continue;
        this.terrainBlitters[t].create(x * TILE, y * TILE);
        drawn++;
      }
    }
    this.tilesDrawn = drawn;
  }

  // コインも可視範囲のみ Blitter に再構築 (タイルとは別カウント)。
  rebuildCoins() {
    const cam = this.cameras.main;
    const vx0 = cam.worldView.x - 32, vx1 = cam.worldView.x + cam.worldView.width + 32;
    this.coinBlitter.clear();
    for (const c of this.coins) {
      if (c.taken) continue;
      if (c.x < vx0 || c.x > vx1) continue;
      this.coinBlitter.create(c.x - 12, c.y - 12); // 24x24 を中心合わせ
    }
  }

  // ============================================================
  // プレイヤー更新 (自前物理)
  // ============================================================
  updatePlayer(dt) {
    const k = this.keys, c = this.cursors;
    let ix = 0, jumpDown = false, speed = WALK_SPEED;
    if (!this.started) {
      // アトラクト中はデモAIで右走行＋障害/穴で自動ジャンプ。キー入力は無視。
      const d = this.demoAI();
      ix = d.move; jumpDown = d.jump;
    } else {
      if (c.left.isDown || k.A.isDown) ix -= 1;
      if (c.right.isDown || k.D.isDown) ix += 1;
      speed = k.SHIFT.isDown ? DASH_SPEED : WALK_SPEED;
      jumpDown = c.up.isDown || k.W.isDown || k.SPACE.isDown;
    }
    if (ix !== 0) this.facing = ix;

    this.pvx = ix * speed;

    // ジャンプ (接地時のみ) + 可変ジャンプ
    if (jumpDown && !this.jumpHeld && this.grounded) {
      this.pvy = JUMP_VY;
      this.grounded = false;
    }
    // 上昇中にジャンプキーを離したら上昇を減衰 (可変ジャンプ)
    if (!jumpDown && this.jumpHeld && this.pvy < 0) {
      this.pvy *= JUMP_CUT;
    }
    this.jumpHeld = jumpDown;

    // 重力
    this.pvy += GRAVITY * dt;
    if (this.pvy > 1400) this.pvy = 1400; // 終端速度

    // ノックバック適用後の水平制御は無敵中も維持 (vx はそのまま)
    // 軸分離移動
    const body = { x: this.player.x, y: this.player.y };
    this.moveBody(body, this.pvx * dt, 0, PLAYER_BOX_W, PLAYER_BOX_H);
    const ry = this.moveBody(body, 0, this.pvy * dt, PLAYER_BOX_W, PLAYER_BOX_H);
    this.player.x = body.x;
    this.player.y = body.y;

    this.grounded = ry.grounded;
    if (ry.grounded && this.pvy > 0) this.pvy = 0;   // 着地
    if (ry.hitY && this.pvy < 0) this.pvy = 0;       // 天井ヒット

    // 穴落下: ワールド下端 + 余白を越えたらダメージ復帰
    if (this.player.y - PLAYER_BOX_H / 2 > WORLD_H + FALL_MARGIN) {
      this.hp -= 1;
      this.respawn();
      return;
    }

    // 無敵タイマ
    if (this.invuln > 0) {
      this.invuln -= dt;
      this.player.setAlpha((Math.floor(this.time.now / 60) % 2) ? 0.35 : 1);
    } else {
      this.player.setAlpha(1);
    }

    // 向き反映 (簡易: flipX)
    if (this.player.texture.key === 'player_walk') {
      const frame = Math.abs(this.pvx) > 5 && this.grounded ? Math.floor(this.time.now / 110) % 4 : 0;
      this.player.setFrame((this.facing < 0 ? 4 : 0) + frame);
      this.player.setFlipX(false);
    } else {
      this.player.setFlipX(this.facing < 0);
    }
  }

  respawn() {
    // スポーン地点へ戻す。HP0 でも復帰 (スコア・敵は保持してベンチ継続)。
    if (this.hp <= 0) this.hp = INITIAL_HP;
    this.player.setPosition(this.spawn.x, this.spawn.y);
    this.pvx = 0; this.pvy = 0;
    this.grounded = false;
    this.invuln = INVULN_TIME;
  }

  // Enter でデモ→プレイ開始: スコア等を新規リセットして操作を有効化、タイトルを消す。
  startGame() {
    this.started = true;
    this.score = 0;
    this.coinsCollected = 0;
    for (const c of this.coins) c.taken = false;       // コインを全復活
    this.maxEnemies = INITIAL_ENEMIES;
    this.syncEnemies();
    this.hp = INITIAL_HP;
    this.respawn();
    this.titleEl.style.display = 'none';
  }

  // ============================================================
  // デモAI (決定的): 右走行 + 接地時に前方の障害/穴で自動ジャンプ。
  // three.js 版 demoAI と同一ロジック。Phaser は中心座標なので左上に換算して判定する。
  // ============================================================
  demoAI() {
    const w = PLAYER_BOX_W, h = PLAYER_BOX_H;
    const x = this.player.x - w / 2;   // 左上 x
    const y = this.player.y - h / 2;   // 左上 y
    const aheadX = x + w + 4;
    const midY = y + h * 0.5;
    const footY = y + h - 2;
    const wallAhead =
      this.isSolidTile(Math.floor(aheadX / TILE), Math.floor(midY / TILE)) ||
      this.isSolidTile(Math.floor(aheadX / TILE), Math.floor(footY / TILE));
    const gapProbeX = x + w + TILE * 1.2;
    const belowTy = Math.floor((y + h + TILE * 0.5) / TILE);
    const gapAhead = this.grounded && !this.isSolidTile(Math.floor(gapProbeX / TILE), belowTy);
    let jump = false;
    if (this.grounded) jump = wallAhead || gapAhead;
    else if (this.pvy < 0) jump = true;   // 上昇中は保持 (可変ジャンプを伸ばす)
    return { move: 1, jump };
  }

  // ============================================================
  // 敵更新 (重力 + 壁/端反転 + プレイヤー相互作用)
  // ============================================================
  updateEnemies(dt) {
    for (const e of this.enemyPool) {
      if (!e.active) continue;
      if (e.spr.texture.key === 'enemy_goomba_walk') e.spr.setFrame((e.vx < 0 ? 4 : 0) + (Math.floor((this.time.now / 140) + e.x * 0.01) % 4));

      // 重力
      e.vy += GRAVITY * dt;
      if (e.vy > 1400) e.vy = 1400;

      const body = { x: e.x, y: e.y };
      const rx = this.moveBody(body, e.vx * dt, 0, ENEMY_BOX, ENEMY_BOX);
      const ry = this.moveBody(body, 0, e.vy * dt, ENEMY_BOX, ENEMY_BOX);
      e.x = body.x; e.y = body.y;

      if (ry.grounded && e.vy > 0) e.vy = 0;
      if (ry.hitY && e.vy < 0) e.vy = 0;

      // 壁衝突で反転
      if (rx.hitX) e.vx = -e.vx;

      // ガケ落下回避: 進行方向の足元が空なら反転 (接地している時のみ)
      if (ry.grounded) {
        const aheadX = e.x + Math.sign(e.vx) * (ENEMY_BOX / 2 + 2);
        const footTy = Math.floor((e.y + ENEMY_BOX / 2 + 2) / TILE);
        const aheadTx = Math.floor(aheadX / TILE);
        if (!this.isSolidTile(aheadTx, footTy)) e.vx = -e.vx;
      }

      e.spr.setPosition(e.x, e.y);

      // 場外へ大きく落ちたら撤去 (穴へ落下) → 非アクティブ化
      if (e.y - ENEMY_BOX / 2 > WORLD_H + FALL_MARGIN) {
        e.active = false; e.spr.setVisible(false);
      }
    }
  }

  // ============================================================
  // 衝突: プレイヤー × 敵 / コイン
  // ============================================================
  handleInteractions() {
    const pL = this.player.x - PLAYER_BOX_W / 2, pR = this.player.x + PLAYER_BOX_W / 2;
    const pT = this.player.y - PLAYER_BOX_H / 2, pB = this.player.y + PLAYER_BOX_H / 2;

    // --- 敵 ---
    for (const e of this.enemyPool) {
      if (!e.active) continue;
      const eL = e.x - ENEMY_BOX / 2, eR = e.x + ENEMY_BOX / 2;
      const eT = e.y - ENEMY_BOX / 2, eB = e.y + ENEMY_BOX / 2;
      if (pR <= eL || pL >= eR || pB <= eT || pT >= eB) continue; // AABB 非重なり

      // 踏みつけ判定: 落下中(vy>0) かつ プレイヤー下端が敵上面付近
      const stomping = this.pvy > 0 && (pB - eT) < (ENEMY_BOX * 0.6);
      if (stomping) {
        e.active = false; e.spr.setVisible(false);
        this.spawnSpark(e.x, e.y);
        this.score += STOMP_SCORE;
        this.pvy = STOMP_BOUNCE; // 跳ねる
        this.grounded = false;
      } else if (this.invuln <= 0) {
        // 横接触 → 被弾
        this.hp -= 1;
        this.invuln = INVULN_TIME;
        // ノックバック (敵と反対方向へ)
        const dir = this.player.x < e.x ? -1 : 1;
        this.pvx = KNOCKBACK_VX * dir;
        this.pvy = -260;
        this.facing = dir;
        if (this.hp <= 0) this.respawn();
      }
    }

    // --- コイン ---
    for (const c of this.coins) {
      if (c.taken) continue;
      // コイン半径 12 と AABB の簡易重なり
      if (c.x + 12 < pL || c.x - 12 > pR || c.y + 12 < pT || c.y - 12 > pB) continue;
      c.taken = true;
      this.coinsCollected += 1;
      this.score += COIN_SCORE;
    }
  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒 (スパイク抑制)

    // FPS 移動平均
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.handleInteractions();
    this.updateEffects(dt);

    // 背景の視差スクロール (カメラ scrollX に比例)
    this.bg.tilePositionX = this.cameras.main.scrollX * 0.3;

    // 描画カリング
    this.cullTiles();
    this.rebuildCoins();

    this.updateHUD();

    // タイトル点滅 (アトラクト中のみ。被弾死/落下は respawn でループ継続)
    if (!this.started) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  }

  updateHUD() {
    const ptx = Math.floor(this.player.x / TILE);
    const pty = Math.floor(this.player.y / TILE);
    const enemyCount = this.enemyPool.filter((e) => e.active).length;
    const coinRemain = this.coins.filter((c) => !c.taken).length;
    const entities = enemyCount + coinRemain; // 敵 + コイン

    this.hud.setText([
      `FPS        : ${this.fpsAvg.toFixed(1)}`,
      `Tiles drawn: ${this.tilesDrawn}   Entities: ${entities} (敵${enemyCount}/コイン${coinRemain})`,
      `Player tile: (${ptx}, ${pty})`,
      `Score: ${this.score}   Coins: ${this.coinsCollected}   HP: ${this.hp}`,
      `Enemies    : ${enemyCount} / ${this.maxEnemies}`,
    ].join('\n'));
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
  backgroundColor: '#6fb3ff',
  scene: [BootScene, GameScene],
  render: { antialias: false, roundPixels: true, pixelArt: true },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
