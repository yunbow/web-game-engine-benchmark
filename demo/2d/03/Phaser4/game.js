/* ============================================================
 * テーマ3 トップダウンRPG探索 ― Phaser 4 実装
 * 仕様: SPEC.md (タイル32x32 / マップ100x100 / カメラ追従 / カリング必須)
 * ============================================================ */

// ---- 基本定数 ----
const TILE = 32;
const MAP_W = 100;            // タイル数 (横)
const MAP_H = 100;            // タイル数 (縦)
const WORLD_W = MAP_W * TILE; // 3200px
const WORLD_H = MAP_H * TILE; // 3200px
const VIEW_W = 960;
const VIEW_H = 540;

const PLAYER_SPEED = 160;     // px/s
const DASH_MULT = 2;
const SLIME_SPEED = 50;       // px/s 徘徊速度
const INITIAL_ENTITIES = 60;  // NPC + 敵 初期合計
const KNOCKBACK = 180;        // ノックバック距離 px/s 相当

// タイル種別: 0=草 1=道 2=水 3=壁 4=木
const T_GRASS = 0, T_PATH = 1, T_WATER = 2, T_WALL = 3, T_TREE = 4;
const BLOCKED = new Set([T_WATER, T_WALL, T_TREE]);

// フォールバック色
const TILE_COLOR = {
  [T_GRASS]: 0x4e8a3b,
  [T_PATH]:  0xa9824f,
  [T_WATER]: 0x2f6fb0,
  [T_WALL]:  0x707070,
  [T_TREE]:  0x2f6f2f,
};

// ---- 決定的疑似乱数 (Mulberry32) ----
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
// 外周は壁。内部は道のネットワーク + 水たまり + 木 + 草。
function generateMap() {
  // 全エンジン共通の決定的生成（three.js と同一: mulberry32(1337)・同手順）。
  const rng = mulberry32(1337);
  const map = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < map.length; i++) map[i] = T_GRASS;
  const idx = (x, y) => y * MAP_W + x;

  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const r = rng();
      if (r < 0.06) map[idx(x, y)] = T_WATER;
      else if (r < 0.14) map[idx(x, y)] = T_TREE;
      else if (r < 0.17) map[idx(x, y)] = T_WALL;
    }
  }
  const lanes = 6;
  for (let i = 0; i < lanes; i++) {
    const ry = 6 + Math.floor(rng() * (MAP_H - 12));
    for (let x = 1; x < MAP_W - 1; x++) map[idx(x, ry)] = T_PATH;
    const rx = 6 + Math.floor(rng() * (MAP_W - 12));
    for (let y = 1; y < MAP_H - 1; y++) map[idx(rx, y)] = T_PATH;
  }
  for (let x = 0; x < MAP_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, MAP_H - 1)] = T_WALL; }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_WALL; map[idx(MAP_W - 1, y)] = T_WALL; }

  // スポーン: マップは改変せず、中央付近の開放タイルを探す
  const sxC = MAP_W >> 1, syC = MAP_H >> 1;
  let spawn = { x: sxC, y: syC };
  outer:
  for (let r = 0; r < Math.max(MAP_W, MAP_H); r++) {
    for (let y = syC - r; y <= syC + r; y++) {
      for (let x = sxC - r; x <= sxC + r; x++) {
        if (x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1 && !BLOCKED.has(map[idx(x, y)])) {
          spawn = { x, y }; break outer;
        }
      }
    }
  }
  return { map, idx, spawn };
}

// ============================================================
// 共有デモシミュレーション（全エンジン共通・three.js と同一）
//   three.js 座標系（左上原点・Y下・28x28 corner px）で走り、デモ中の自機経路を
//   全エンジンで一致させる。spawn=mulberry32(99) / 巡回=mulberry32(20240619) / 160px/s。
// ============================================================
const SIM = { map: null, idx: null, demoRnd: null, player: null, target: null, stuckT: 0 };
function simTileAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return SIM.map[SIM.idx(tx, ty)];
}
function simBlockedTile(t) { return t === T_WATER || t === T_WALL || t === T_TREE; }
function simRectBlocked(px, py, w, h) {
  const x0 = Math.floor(px / TILE), y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE), y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      if (simBlockedTile(simTileAt(tx, ty))) return true;
  return false;
}
function simMoveActor(a, dx, dy) {
  if (dx !== 0) { const nx = a.x + dx; if (!simRectBlocked(nx, a.y, a.w, a.h)) a.x = nx; }
  if (dy !== 0) { const ny = a.y + dy; if (!simRectBlocked(a.x, ny, a.w, a.h)) a.y = ny; }
}
function simPickTarget() {
  let tx, ty, g = 0;
  do {
    tx = 1 + Math.floor(SIM.demoRnd() * (MAP_W - 2));
    ty = 1 + Math.floor(SIM.demoRnd() * (MAP_H - 2));
    g++;
  } while (simBlockedTile(simTileAt(tx, ty)) && g < 100);
  SIM.target = { x: tx * TILE, y: ty * TILE };
}
function simInitDemo(map, idx) {
  SIM.map = map; SIM.idx = idx;
  const rnd = mulberry32(99);
  let sx = 1, sy = 1;
  for (let i = 0; i < 5000; i++) {
    const tx = 1 + Math.floor(rnd() * (MAP_W - 2));
    const ty = 1 + Math.floor(rnd() * (MAP_H - 2));
    if (!simBlockedTile(map[idx(tx, ty)])) { sx = tx; sy = ty; break; }
  }
  SIM.player = { x: sx * TILE, y: sy * TILE, w: 28, h: 28 };
  SIM.demoRnd = mulberry32(20240619);
  SIM.target = null; SIM.stuckT = 0;
  simPickTarget();
}
function simStep(dt) {
  dt = Math.min(dt, 0.05);
  const p = SIM.player;
  if (!SIM.target) simPickTarget();
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const tgx = SIM.target.x + p.w / 2, tgy = SIM.target.y + p.h / 2;
  const dx = tgx - cx, dy = tgy - cy;
  let mx = 0, my = 0;
  if (Math.hypot(dx, dy) < TILE * 0.6) { simPickTarget(); SIM.stuckT = 0; }
  else { if (Math.abs(dx) > Math.abs(dy)) mx = dx > 0 ? 1 : -1; else my = dy > 0 ? 1 : -1; }
  const sp = 160 * dt;
  const bx = p.x, by = p.y;
  simMoveActor(p, mx * sp, my * sp);
  if ((mx !== 0 || my !== 0) && p.x === bx && p.y === by) {
    SIM.stuckT += dt;
    if (SIM.stuckT > 0.4) { simPickTarget(); SIM.stuckT = 0; }
  } else SIM.stuckT = 0;
}
function simPtx() { return Math.floor((SIM.player.x + SIM.player.w / 2) / TILE); }
function simPty() { return Math.floor((SIM.player.y + SIM.player.h / 2) / TILE); }

// ============================================================
// MainScene
// ============================================================
class MainScene extends Phaser.Scene {
  constructor() { super('main'); }

  preload() {
    // アセットは ../assets/ から (Phaser4 フォルダから見て 3/assets/)
    this.assetMissing = {};
    const ASSET = '../assets/';
    const list = [
      ['tile_grass', 'tile_grass.png'],
      ['tile_path',  'tile_path.png'],
      ['tile_water', 'tile_water.png'],
      ['tile_wall',  'tile_wall.png'],
      ['tree',       'tree.png'],
      ['player',     'player.png'],
      ['npc',        'npc.png'],
      ['enemy_slime','enemy_slime.png'],
    ];
    list.forEach(([key, file]) => this.load.image(key, ASSET + file));
    this.load.spritesheet('player_walk', ASSET + 'player_walk.png', { frameWidth: TILE, frameHeight: TILE });
    this.load.spritesheet('npc_walk', ASSET + 'npc_walk.png', { frameWidth: TILE, frameHeight: TILE });
    this.load.spritesheet('enemy_slime_walk', ASSET + 'enemy_slime_walk.png', { frameWidth: TILE, frameHeight: TILE });

    // 読込失敗を記録 (フォールバックへ)
    this.load.on('loaderror', (file) => { this.assetMissing[file.key] = true; });
  }

  create() {
    const gen = generateMap();
    this.map = gen.map;
    this.idxOf = gen.idx;

    // --- フォールバック用テクスチャを生成 (画像欠落キーに対し単色/図形) ---
    this.ensureFallbackTextures();

    // --- マップ描画レイヤ: Blitter でカリング描画 ---
    // タイル種別ごとに texture key を解決
    this.tileTexKey = {
      [T_GRASS]: this.texKey('tile_grass', 'fb_grass'),
      [T_PATH]:  this.texKey('tile_path',  'fb_path'),
      [T_WATER]: this.texKey('tile_water', 'fb_water'),
      [T_WALL]:  this.texKey('tile_wall',  'fb_wall'),
    };
    this.treeTexKey = this.texKey('tree', 'fb_tree');

    // Blitter は単一テクスチャしか持てないため、地形種別ごとに 1 枚ずつ用意。
    // 各 Blitter は可視範囲ぶんの Bob のみを保持する (カリング)。
    this.terrainBlitters = {};
    [T_GRASS, T_PATH, T_WATER, T_WALL].forEach((t) => {
      const b = this.add.blitter(0, 0, this.tileTexKey[t]);
      b.setDepth(0);
      this.terrainBlitters[t] = b;
    });

    // 木は障害物。32x48 なので別 Blitter (足元基準で描画)
    this.treeBlitter = this.add.blitter(0, 0, this.treeTexKey);
    this.treeBlitter.setDepth(5);

    this.lastCull = { x0: -1, y0: -1, x1: -1, y1: -1 };
    this.tilesDrawn = 0;
    this.treesDrawn = 0;
    this.treeCount = this.countTrees();

    // --- エンティティ (NPC + スライム) ---
    this.entities = [];
    this.entityLayer = this.add.container(0, 0);
    this.entityLayer.setDepth(6);
    this.npcTex = this.texKey('npc', 'fb_npc');
    this.slimeTex = this.texKey('enemy_slime', 'fb_slime');
    this.npcWalkTex = this.texKey('npc_walk', this.npcTex);
    this.slimeWalkTex = this.texKey('enemy_slime_walk', this.slimeTex);
    this.rng = mulberry32(0x5EED);
    this.spawnEntities(INITIAL_ENTITIES);

    // --- プレイヤー ---
    this.playerTex = this.texKey('player', 'fb_player');
    this.playerWalkTex = this.texKey('player_walk', this.playerTex);
    const px = gen.spawn.x * TILE + TILE / 2;
    const py = gen.spawn.y * TILE + TILE / 2;
    this.player = this.add.sprite(px, py, this.playerWalkTex, 0);
    this.player.setDepth(7);
    this.playerVel = { x: 0, y: 0 };
    this.knockback = { x: 0, y: 0, t: 0 };
    this.spawnPx = px; this.spawnPy = py;

    // デモ用シミュレーション初期化（全エンジン共通の経路）。デモ開始位置へ自機を置く。
    simInitDemo(this.map, this.idxOf);
    this.player.x = SIM.player.x + SIM.player.w / 2;
    this.player.y = SIM.player.y + SIM.player.h / 2;

    // --- タイトル/アトラクト状態 ---
    this.started = false;
    this.blinkT = 0;
    this.titleEl = document.getElementById('title');
    this.demoRng = mulberry32(0xA77AC7); // デモAI用(決定的)
    this.demoTarget = null;
    this.demoStuckT = 0;
    this.pickDemoTarget();

    // --- カメラ ---
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.player, true, 0.15, 0.15);
    this.cameras.main.setRoundPixels(true);

    // --- 入力 ---
    this.keys = this.input.keyboard.addKeys({
      up: 'W', down: 'S', left: 'A', right: 'D',
      upArrow: 'UP', downArrow: 'DOWN', leftArrow: 'LEFT', rightArrow: 'RIGHT',
      shift: 'SHIFT',
    });
    this.input.keyboard.on('keydown-PLUS', () => this.changeEntities(10));
    this.input.keyboard.on('keydown-ADD', () => this.changeEntities(10));
    this.input.keyboard.on('keydown-MINUS', () => this.changeEntities(-10));
    this.input.keyboard.on('keydown-SUBTRACT', () => this.changeEntities(-10));
    // '=' (Shiftなしの + キー) と '-' のフォールバック
    this.input.keyboard.on('keydown', (ev) => {
      if (ev.key === '+' || ev.key === '=') this.changeEntities(10);
      else if (ev.key === '-' || ev.key === '_') this.changeEntities(-10);
      else if (ev.key === 'Enter' && !this.started) this.startGame();
    });

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均
    this.fpsAvg = 60;
  }

  // テクスチャキー解決: 画像があればそれ、無ければフォールバックキー
  texKey(imageKey, fallbackKey) {
    if (!this.assetMissing[imageKey] && this.textures.exists(imageKey)) {
      return imageKey;
    }
    return fallbackKey;
  }

  ensureFallbackTextures() {
    const mk = (key, w, h, drawFn) => {
      if (this.textures.exists(key)) return;
      const g = this.add.graphics();
      drawFn(g);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    // 地形タイル (単色 + 軽い格子で識別しやすく)
    const tile = (key, color) => mk(key, TILE, TILE, (g) => {
      g.fillStyle(color, 1).fillRect(0, 0, TILE, TILE);
      g.lineStyle(1, 0x000000, 0.12).strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
    });
    tile('fb_grass', TILE_COLOR[T_GRASS]);
    tile('fb_path',  TILE_COLOR[T_PATH]);
    tile('fb_water', TILE_COLOR[T_WATER]);
    tile('fb_wall',  TILE_COLOR[T_WALL]);

    // 木 32x48 (幹 + 葉)
    mk('fb_tree', TILE, 48, (g) => {
      g.fillStyle(0x6b4326, 1).fillRect(13, 30, 6, 18);          // 幹
      g.fillStyle(TILE_COLOR[T_TREE], 1).fillCircle(16, 18, 14); // 葉
      g.fillStyle(0x3f8f3f, 1).fillCircle(11, 14, 8);
    });

    // プレイヤー (白)
    mk('fb_player', TILE, TILE, (g) => {
      g.fillStyle(0xffffff, 1).fillRoundedRect(4, 4, 24, 24, 6);
      g.fillStyle(0x223344, 1).fillCircle(12, 14, 2).fillCircle(20, 14, 2);
    });
    // NPC (黄)
    mk('fb_npc', TILE, TILE, (g) => {
      g.fillStyle(0xf2d33b, 1).fillRoundedRect(4, 4, 24, 24, 6);
      g.fillStyle(0x222222, 1).fillCircle(12, 14, 2).fillCircle(20, 14, 2);
    });
    // スライム (緑丸)
    mk('fb_slime', TILE, TILE, (g) => {
      g.fillStyle(0x4cd964, 1).fillCircle(16, 18, 12);
      g.fillStyle(0x2fae4a, 1).fillEllipse(16, 26, 22, 8);
      g.fillStyle(0x114411, 1).fillCircle(12, 16, 2).fillCircle(20, 16, 2);
    });
  }

  countTrees() {
    let c = 0;
    for (let i = 0; i < this.map.length; i++) if (this.map[i] === T_TREE) c++;
    return c;
  }

  // --- エンティティ生成 ---
  spawnEntities(n) {
    for (let i = 0; i < n; i++) {
      // 歩行可能タイルを探す
      let tx, ty, tries = 0;
      do {
        tx = 1 + Math.floor(this.rng() * (MAP_W - 2));
        ty = 1 + Math.floor(this.rng() * (MAP_H - 2));
        tries++;
      } while (BLOCKED.has(this.map[this.idxOf(tx, ty)]) && tries < 30);

      const isSlime = this.rng() < 0.6; // 6割スライム
      const tex = isSlime ? this.slimeWalkTex : this.npcWalkTex;
      const spr = this.add.sprite(tx * TILE + TILE / 2, ty * TILE + TILE / 2, tex, 0);
      this.entityLayer.add(spr);

      const ang = this.rng() * Math.PI * 2;
      this.entities.push({
        spr, isSlime,
        vx: 0,
        vy: Math.sin(ang) < 0 ? -(isSlime ? SLIME_SPEED : SLIME_SPEED * 0.7) : (isSlime ? SLIME_SPEED : SLIME_SPEED * 0.7),
        wanderT: this.rng() * 2,
      });
    }
  }

  changeEntities(delta) {
    if (delta > 0) {
      this.spawnEntities(delta);
    } else {
      const removeN = Math.min(-delta, this.entities.length);
      for (let i = 0; i < removeN; i++) {
        const e = this.entities.pop();
        e.spr.destroy();
      }
    }
  }

  isBlockedPx(px, py) {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
    return BLOCKED.has(this.map[this.idxOf(tx, ty)]);
  }

  // 軸ごとに衝突解決 (壁ずり)
  tryMove(obj, dx, dy, radius) {
    // X
    if (dx !== 0) {
      const nx = obj.x + dx;
      const edge = nx + Math.sign(dx) * radius;
      if (!this.isBlockedPx(edge, obj.y - radius + 2) &&
          !this.isBlockedPx(edge, obj.y + radius - 2)) {
        obj.x = nx;
      }
    }
    // Y
    if (dy !== 0) {
      const ny = obj.y + dy;
      const edge = ny + Math.sign(dy) * radius;
      if (!this.isBlockedPx(obj.x - radius + 2, edge) &&
          !this.isBlockedPx(obj.x + radius - 2, edge)) {
        obj.y = ny;
      }
    }
  }

  buildHUD() {
    // HUD は他エンジンと同じく HTML オーバーレイ（#hud）。hint は #help に記載。
    this.hudEl = document.getElementById('hud');
  }

  // ============================================================
  // カリング: 可視範囲のタイルのみ Blitter に bob を再構築
  // ============================================================
  cullTiles() {
    const cam = this.cameras.main;
    const margin = 1; // 余白タイル
    const x0 = Math.max(0, Math.floor(cam.worldView.x / TILE) - margin);
    const y0 = Math.max(0, Math.floor(cam.worldView.y / TILE) - margin);
    const x1 = Math.min(MAP_W - 1, Math.ceil((cam.worldView.x + cam.worldView.width) / TILE) + margin);
    const y1 = Math.min(MAP_H - 1, Math.ceil((cam.worldView.y + cam.worldView.height) / TILE) + margin);

    // 範囲が前フレームと同じなら再構築不要 (タイル数だけ維持)
    if (x0 === this.lastCull.x0 && y0 === this.lastCull.y0 &&
        x1 === this.lastCull.x1 && y1 === this.lastCull.y1) {
      return;
    }
    this.lastCull = { x0, y0, x1, y1 };

    // 全 Blitter をクリアして可視タイルのみ追加
    Object.values(this.terrainBlitters).forEach((b) => b.clear());
    this.treeBlitter.clear();

    let drawn = 0, treesDrawn = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.map[this.idxOf(x, y)];
        const wx = x * TILE, wy = y * TILE;
        if (t === T_TREE) {
          // 木の下は草を敷く
          this.terrainBlitters[T_GRASS].create(wx, wy);
          // 木は 32x48: 足元が当該タイル下端に来るよう上方向へ
          this.treeBlitter.create(wx, wy + TILE - 48);
          drawn += 2;
          treesDrawn++;
        } else {
          this.terrainBlitters[t].create(wx, wy);
          drawn++;
        }
      }
    }
    this.tilesDrawn = drawn;
    this.treesDrawn = treesDrawn;
  }

  // デモAI: 決定的にウェイポイント(開通タイル)を選び自機を歩かせる
  pickDemoTarget() {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(this.demoRng() * (MAP_W - 2));
      ty = 1 + Math.floor(this.demoRng() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(this.map[this.idxOf(tx, ty)]) && guard < 100);
    this.demoTarget = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
  }

  demoInput() {
    if (!this.demoTarget) this.pickDemoTarget();
    const dx = this.demoTarget.x - this.player.x;
    const dy = this.demoTarget.y - this.player.y;
    if (Math.hypot(dx, dy) < TILE * 0.6) { this.pickDemoTarget(); this.demoStuckT = 0; return { ix: 0, iy: 0 }; }
    let ix = 0, iy = 0;
    iy = dy > 0 ? 1 : -1;
    return { ix, iy };
  }

  startGame() {
    this.started = true;
    // 新規リセット: 自機位置・ノックバック・エンティティ数を初期化
    this.player.x = this.spawnPx; this.player.y = this.spawnPy;
    this.knockback = { x: 0, y: 0, t: 0 };
    this.changeEntities(INITIAL_ENTITIES - this.entities.length);
    this.titleEl.style.display = 'none';
  }

  walkRow(sprite, dx, dy) {
    if (dx !== 0 || dy !== 0) sprite.faceDir = Math.abs(dx) > Math.abs(dy)
      ? (dx < 0 ? 'left' : 'right')
      : (dy < 0 ? 'up' : 'down');
    return { down: 0, up: 1, left: 2, right: 3 }[sprite.faceDir || 'down'];
  }

  setWalkFrame(sprite, dx, dy, moving, dt) {
    if (!sprite.setFrame) return;
    sprite.animT = moving ? (sprite.animT || 0) + dt : 0;
    const row = this.walkRow(sprite, dx, dy);
    const col = moving ? Math.floor(sprite.animT * 8) % 4 : 0;
    sprite.setFrame(row * 4 + col);
  }

  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒 (スパイク抑制)
    const playerBeforeX = this.player.x;
    const playerBeforeY = this.player.y;

    // --- プレイヤー入力 ---
    const k = this.keys;
    let dashing = false;
    if (!this.started) {
      // デモ中は共有シミュレーションで自機を駆動（全エンジン同一の経路）
      simStep(dt);
      this.player.x = SIM.player.x + SIM.player.w / 2;
      this.player.y = SIM.player.y + SIM.player.h / 2;
    } else {
      let ix = 0, iy = 0;
      if (k.left.isDown || k.leftArrow.isDown) ix -= 1;
      if (k.right.isDown || k.rightArrow.isDown) ix += 1;
      if (k.up.isDown || k.upArrow.isDown) iy -= 1;
      if (k.down.isDown || k.downArrow.isDown) iy += 1;
      // 4方向 (斜め時は正規化)
      if (ix !== 0 && iy !== 0) { const inv = Math.SQRT1_2; ix *= inv; iy *= inv; }
      dashing = k.shift.isDown;
      const speed = PLAYER_SPEED * (dashing ? DASH_MULT : 1);
      let mvx = ix * speed * dt;
      let mvy = iy * speed * dt;
      // ノックバック適用
      if (this.knockback.t > 0) {
        this.knockback.x = 0;
        mvy += this.knockback.y * dt;
        this.knockback.t -= dt;
      }
      this.tryMove(this.player, mvx, 0, 13);
      this.tryMove(this.player, 0, mvy, 13);
    }
    this.setWalkFrame(
      this.player,
      this.player.x - playerBeforeX,
      this.player.y - playerBeforeY,
      this.player.x !== playerBeforeX || this.player.y !== playerBeforeY,
      dt
    );

    // --- エンティティ徘徊 ---
    for (const e of this.entities) {
      e.wanderT -= dt;
      if (e.wanderT <= 0) {
        const ang = Math.random() * Math.PI * 2;
        const speed = e.isSlime ? SLIME_SPEED : SLIME_SPEED * 0.7;
        e.vx = Math.cos(ang) * speed;
        e.vy = Math.sin(ang) * speed;
        e.wanderT = 1 + Math.random() * 2;
      }
      const before = { x: e.spr.x, y: e.spr.y };
      this.tryMove(e.spr, e.vx * dt, 0, 12);
      this.tryMove(e.spr, 0, e.vy * dt, 12);
      // 壁にぶつかったら向き反転
      if (e.spr.x === before.x) e.vx = -e.vx;
      if (e.spr.y === before.y) e.vy = -e.vy;
      this.setWalkFrame(e.spr, e.spr.x - before.x, e.spr.y - before.y, e.spr.x !== before.x || e.spr.y !== before.y, dt);

      // プレイヤー接触でノックバック
      const ddx = this.player.x - e.spr.x;
      const ddy = this.player.y - e.spr.y;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < 24 * 24 && this.knockback.t <= 0) {
        const d = Math.max(1, Math.sqrt(d2));
        this.knockback.x = 0;
        this.knockback.y = (ddy / d) * KNOCKBACK;
        this.knockback.t = 0.18;
      }
    }

    // --- カリング描画 ---
    this.cullTiles();

    // --- HUD 更新 ---
    const instFps = 1000 / Math.max(1, delta);
    this.fpsAvg = this.fpsAvg * 0.92 + instFps * 0.08;
    const ptx = Math.floor(this.player.x / TILE);
    const pty = Math.floor(this.player.y / TILE);

    // 表示内容・書式は three.js に統一
    this.hudEl.textContent =
      `FPS         : ${this.fpsAvg.toFixed(1)}\n` +
      `Tiles drawn : ${this.tilesDrawn}  (trees: ${this.treesDrawn})\n` +
      `Entities    : ${this.entities.length + this.treeCount}  (NPC+敵:${this.entities.length} / 木:${this.treeCount})\n` +
      `Player tile : (${ptx}, ${pty})  ${dashing ? '[DASH]' : ''}`;

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!this.started) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
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
  backgroundColor: '#1a1a1a',
  pixelArt: true,
  render: { antialias: false, roundPixels: true },
  scene: [MainScene],
};

new Phaser.Game(config);
