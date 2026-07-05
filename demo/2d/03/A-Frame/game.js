/* ============================================================================
 * テーマ3 トップダウンRPG探索 (マップ歩行) - A-Frame (1.7.0) 実装
 * 共通仕様 SPEC.md / 正準実装 PixiJS に厳密準拠。性能比較用。
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `rpg-game` コンポーネントが駆動する (A-Frame の renderer / tick / カメラ管理を利用)。
 *
 * 設計判断: 広大マップ(100x100=1万タイル)＋エンティティを「1タイル = 1 <a-entity>」で
 * 作ると DOM/コンポーネント生成で破綻する。そこで動的オブジェクトはコンポーネント内で
 * THREE.Sprite を直接生成・管理し、可視範囲ぶんのプールを再利用してカリングする
 * (PixiJS 正準実装と同じ戦略)。カメラは 2D 用 OrthographicCamera へ差し替える。
 * 座標は画面座標(Y下)保持→worldY=H-y 変換。
 * ========================================================================== */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC / PixiJS と同一値) -----------------------------------------
const TILE = 32;
const MAP_W = 100;
const MAP_H = 100;
const VIEW_W = 960;
const VIEW_H = 540;
const SPEED = 160;          // px/s
const DASH_MULT = 2;
const INIT_ENTITIES = 60;
const SLIME_SPEED = 50;     // px/s
const KNOCKBACK = 90;       // px

const T_GRASS = 0, T_PATH = 1, T_WATER = 2, T_WALL = 3, T_TREE = 4;
const BLOCKED = new Set([T_WATER, T_WALL, T_TREE]);

const COL = {
  grass: '#4a7c3a', path: '#9b6b3a', water: '#2f6fb0',
  wall: '#6b6b6b', tree: '#2f5d2a', treeTrunk: '#5a3a1a',
  player: '#ffffff', npc: '#f2d33c', slime: '#6fd06f',
};

const ASSET_DEFS = {
  tile_grass:  '../assets/tile_grass.png',
  tile_path:   '../assets/tile_path.png',
  tile_water:  '../assets/tile_water.png',
  tile_wall:   '../assets/tile_wall.png',
  tree:        '../assets/tree.png',
  player:      '../assets/player.png',
  player_walk: '../assets/player_walk.png',
  npc:         '../assets/npc.png',
  npc_walk:    '../assets/npc_walk.png',
  enemy_slime: '../assets/enemy_slime.png',
  enemy_slime_walk: '../assets/enemy_slime_walk.png',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RO_TILE = 0, RO_ENT = 10;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generateMap() {
  const rnd = mulberry32(1337);
  const map = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < map.length; i++) map[i] = T_GRASS;
  const idx = (x, y) => y * MAP_W + x;
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const r = rnd();
      if (r < 0.06) map[idx(x, y)] = T_WATER;
      else if (r < 0.14) map[idx(x, y)] = T_TREE;
      else if (r < 0.17) map[idx(x, y)] = T_WALL;
    }
  }
  const lanes = 6;
  for (let i = 0; i < lanes; i++) {
    const ry = 6 + Math.floor(rnd() * (MAP_H - 12));
    for (let x = 1; x < MAP_W - 1; x++) map[idx(x, ry)] = T_PATH;
    const rx = 6 + Math.floor(rnd() * (MAP_W - 12));
    for (let y = 1; y < MAP_H - 1; y++) map[idx(rx, y)] = T_PATH;
  }
  for (let x = 0; x < MAP_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, MAP_H - 1)] = T_WALL; }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_WALL; map[idx(MAP_W - 1, y)] = T_WALL; }
  return map;
}
function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return map[ty * MAP_W + tx];
}
function rectBlocked(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE), y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE), y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      if (BLOCKED.has(tileAt(map, tx, ty))) return true;
  return false;
}

// 2D canvas → CanvasTexture フォールバック
const fbCache = {};
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
  fbCache[name] = t; return t;
}
const FB = {
  tile_grass:  () => canvasTexture('tg', TILE, TILE, (g) => { g.fillStyle = COL.grass; g.fillRect(0, 0, TILE, TILE); }),
  tile_path:   () => canvasTexture('tp', TILE, TILE, (g) => { g.fillStyle = COL.path; g.fillRect(0, 0, TILE, TILE); }),
  tile_water:  () => canvasTexture('tw', TILE, TILE, (g) => { g.fillStyle = COL.water; g.fillRect(0, 0, TILE, TILE); g.fillStyle = 'rgba(111,168,224,0.6)'; g.fillRect(4, 8, 10, 3); g.fillRect(16, 20, 10, 3); }),
  tile_wall:   () => canvasTexture('twl', TILE, TILE, (g) => { g.fillStyle = COL.wall; g.fillRect(0, 0, TILE, TILE); g.strokeStyle = '#444'; g.lineWidth = 2; g.strokeRect(1, 1, TILE - 2, TILE - 2); }),
  tree:        () => canvasTexture('tr', 32, 48, (g) => { g.fillStyle = COL.treeTrunk; g.fillRect(13, 32, 6, 16); g.fillStyle = COL.tree; g.beginPath(); g.arc(16, 18, 15, 0, 7); g.fill(); }),
  player:      () => canvasTexture('pl', TILE, TILE, (g) => { g.fillStyle = COL.player; g.fillRect(2, 2, TILE - 4, TILE - 4); g.fillStyle = '#222'; g.beginPath(); g.arc(11, 13, 2.5, 0, 7); g.fill(); g.beginPath(); g.arc(21, 13, 2.5, 0, 7); g.fill(); }),
  npc:         () => canvasTexture('np', TILE, TILE, (g) => { g.fillStyle = COL.npc; g.fillRect(3, 3, TILE - 6, TILE - 6); }),
  enemy_slime: () => canvasTexture('sl', TILE, TILE, (g) => { g.fillStyle = COL.slime; g.beginPath(); g.arc(16, 18, 12, 0, 7); g.fill(); g.fillStyle = '#143a14'; g.beginPath(); g.arc(11, 15, 2, 0, 7); g.fill(); g.beginPath(); g.arc(21, 15, 2, 0, 7); g.fill(); }),
};

AFRAME.registerComponent('rpg-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera (tick で sceneEl.camera を維持)
    this.cam = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1); // DPR=1 固定
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    // 状態
    this.tex = {};
    this.map = generateMap();
    this.entities = [];
    this.tilesDrawn = 0; this.treesDrawn = 0;
    this.dashOn = false;
    this.fpsSamples = []; this.hudTimer = 0;
    this.ready = false;
    this._treeCount = -1;

    // タイトル/アトラクト状態
    this.started = false; this.blinkT = 0; this.demoStuckT = 0;
    this.titleEl = document.getElementById('title');
    this.demoRnd = mulberry32(20240619); // デモAI(決定的)
    this.demoTarget = null;

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Enter' && !this.started) this.startGame();
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.setEntityCount(this.entities.length + 10); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.setEntityCount(this.entities.length - 10); e.preventDefault(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // アセット読み込み → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  texOf(key) { return this.tex[key] || FB[key](); },

  makeSprite(texture, w, h, renderOrder) {
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.center.set(0, 1); // 左上アンカー
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    this.group.add(s); return s;
  },
  makeActorSprite(kind) {
    const walkKey = kind === 'slime' ? 'enemy_slime_walk' : `${kind}_walk`;
    const baseKey = kind === 'slime' ? 'enemy_slime' : kind;
    const walkTex = this.tex[walkKey];
    const map = (walkTex || this.texOf(baseKey)).clone();
    map.needsUpdate = true;
    map.magFilter = THREE.NearestFilter;
    const s = this.makeSprite(map, TILE, TILE, RO_ENT);
    s.userData.walk = !!walkTex;
    s.userData.animT = 0;
    s.userData.faceDir = 'down';
    if (walkTex) map.repeat.set(1 / 4, 1 / 4);
    return s;
  },
  walkRow(sprite, dx, dy) {
    if (dx !== 0 || dy !== 0) sprite.userData.faceDir = Math.abs(dx) > Math.abs(dy)
      ? (dx < 0 ? 'left' : 'right')
      : (dy < 0 ? 'up' : 'down');
    return { down: 0, up: 1, left: 2, right: 3 }[sprite.userData.faceDir || 'down'];
  },
  updateActorFrame(sprite, dx, dy, moving, dt) {
    if (!sprite.userData.walk) return;
    sprite.userData.animT = moving ? sprite.userData.animT + dt : 0;
    const row = this.walkRow(sprite, dx, dy);
    const col = moving ? Math.floor(sprite.userData.animT * 8) % 4 : 0;
    sprite.material.map.offset.set(col / 4, (3 - row) / 4);
  },
  // 画面座標(gx,gy 左上)→ worldY=H-gameY。
  place(s, gx, gy) { s.position.set(gx, VIEW_H - gy, s.renderOrder * 0.001); },
  down(...c) { return c.some((k) => this.keys[k]); },

  countTrees() {
    if (this._treeCount >= 0) return this._treeCount;
    let c = 0;
    for (let i = 0; i < this.map.length; i++) if (this.map[i] === T_TREE) c++;
    this._treeCount = c; return c;
  },

  build() {
    const map = this.map;

    this.tileTexByType = {
      [T_GRASS]: this.texOf('tile_grass'), [T_PATH]: this.texOf('tile_path'),
      [T_WATER]: this.texOf('tile_water'), [T_WALL]: this.texOf('tile_wall'),
      [T_TREE]: this.texOf('tile_grass'),
    };

    // 可視範囲タイル/木プール
    this.colsVis = Math.ceil(VIEW_W / TILE) + 2;
    this.rowsVis = Math.ceil(VIEW_H / TILE) + 2;
    const POOL = this.colsVis * this.rowsVis;

    this.tilePool = [];
    for (let i = 0; i < POOL; i++) {
      const s = this.makeSprite(this.tileTexByType[T_GRASS], TILE, TILE, RO_TILE);
      s.visible = false; this.tilePool.push(s);
    }
    const treeTex = this.texOf('tree');
    this.treePool = [];
    for (let i = 0; i < POOL; i++) {
      const s = this.makeSprite(treeTex, 32, 48, RO_ENT);
      s.visible = false; this.treePool.push(s);
    }

    // プレイヤー
    const spawn = this.findOpenTile();
    this.spawnTx = spawn.tx; this.spawnTy = spawn.ty;
    this.player = {
      x: spawn.tx * TILE, y: spawn.ty * TILE, w: 28, h: 28, kx: 0, ky: 0,
      sprite: this.makeActorSprite('player'),
    };

    this.entRnd = mulberry32(424242);
    this.setEntityCount(INIT_ENTITIES);
    this.pickDemoTarget();

    this.ready = true;
  },

  // デモAI: 決定的にウェイポイント(開通タイル)を選び自機を歩かせる
  pickDemoTarget() {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(this.demoRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(this.demoRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(this.map, tx, ty)) && guard < 100);
    this.demoTarget = { x: tx * TILE, y: ty * TILE };
  },
  demoInput() {
    if (!this.demoTarget) this.pickDemoTarget();
    const p = this.player;
    const dx = (this.demoTarget.x + p.w / 2) - (p.x + p.w / 2);
    const dy = (this.demoTarget.y + p.h / 2) - (p.y + p.h / 2);
    if (Math.hypot(dx, dy) < TILE * 0.6) { this.pickDemoTarget(); this.demoStuckT = 0; return { mx: 0, my: 0 }; }
    // 距離の大きい軸を選んで進む（上下左右の4方向）
    return Math.abs(dx) > Math.abs(dy)
      ? { mx: dx > 0 ? 1 : -1, my: 0 }
      : { mx: 0, my: dy > 0 ? 1 : -1 };
  },
  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true;
    const p = this.player;
    p.x = this.spawnTx * TILE; p.y = this.spawnTy * TILE; p.kx = 0; p.ky = 0;
    this.setEntityCount(INIT_ENTITIES);
    if (this.titleEl) this.titleEl.style.display = 'none';
  },

  findOpenTile() {
    const rnd = mulberry32(99);
    for (let tries = 0; tries < 5000; tries++) {
      const tx = 1 + Math.floor(rnd() * (MAP_W - 2));
      const ty = 1 + Math.floor(rnd() * (MAP_H - 2));
      if (!BLOCKED.has(tileAt(this.map, tx, ty))) return { tx, ty };
    }
    return { tx: 1, ty: 1 };
  },
  spawnEntity(type) {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(this.entRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(this.entRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(this.map, tx, ty)) && guard < 50);
    const s = this.makeActorSprite(type);
    this.entities.push({ type, x: tx * TILE + 2, y: ty * TILE + 2, w: 28, h: 28, vx: 0, vy: 0, t: this.entRnd() * 3, sprite: s });
  },
  removeEntity() {
    const e = this.entities.pop();
    if (e) { this.group.remove(e.sprite); e.sprite.material.dispose(); }
  },
  setEntityCount(n) {
    if (!this.entRnd) return;
    n = Math.max(0, n);
    while (this.entities.length < n) this.spawnEntity(this.entities.length % 2 === 0 ? 'slime' : 'npc');
    while (this.entities.length > n) this.removeEntity();
  },

  moveActor(actor, dx, dy) {
    if (dx !== 0) { const nx = actor.x + dx; if (!rectBlocked(this.map, nx, actor.y, actor.w, actor.h)) actor.x = nx; }
    if (dy !== 0) { const ny = actor.y + dy; if (!rectBlocked(this.map, actor.x, ny, actor.w, actor.h)) actor.y = ny; }
  },
  aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; },

  tick(time, dtMs) {
    if (!this.ready) return;
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50);
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    const map = this.map;
    const p = this.player;

    // --- プレイヤー入力 (アトラクト中はデモAI) ---
    let mx = 0, my = 0;
    if (!this.started) {
      const d = this.demoInput();
      mx = d.mx; my = d.my;
      this.dashOn = false;
    } else {
      if (this.down('ArrowLeft', 'KeyA')) mx -= 1;
      if (this.down('ArrowRight', 'KeyD')) mx += 1;
      if (this.down('ArrowUp', 'KeyW')) my -= 1;
      if (this.down('ArrowDown', 'KeyS')) my += 1;
      this.dashOn = this.down('ShiftLeft', 'ShiftRight');
    }
    const sp = SPEED * (this.dashOn ? DASH_MULT : 1) * dt;
    const _bx = p.x, _by = p.y;
    this.moveActor(p, mx * sp, my * sp);
    this.updateActorFrame(p.sprite, p.x - _bx, p.y - _by, p.x !== _bx || p.y !== _by, dt);
    if (!this.started) {
      if ((mx !== 0 || my !== 0) && p.x === _bx && p.y === _by) {
        this.demoStuckT += dt;
        if (this.demoStuckT > 0.4) { this.pickDemoTarget(); this.demoStuckT = 0; }
      } else this.demoStuckT = 0;
    }

    if (p.kx !== 0 || p.ky !== 0) {
      this.moveActor(p, p.kx * dt, p.ky * dt);
      p.kx = 0; p.ky *= 0.85;
      if (Math.abs(p.kx) < 1) p.kx = 0;
      if (Math.abs(p.ky) < 1) p.ky = 0;
    }

    // --- エンティティ更新 ---
    for (const e of this.entities) {
      e.t -= dt;
      if (e.t <= 0) {
        e.t = 0.6 + this.entRnd() * 2.0;
        const dir = Math.floor(this.entRnd() * 5);
        const s = (e.type === 'slime' ? SLIME_SPEED : SLIME_SPEED * 0.7);
        e.vx = 0; e.vy = 0;
        if (dir === 0) e.vy = -s;
        else if (dir === 1) e.vy = s;
        else if (dir === 2) e.vx = -s;
        else if (dir === 3) e.vx = s;
      }
      if (e.vx !== 0 || e.vy !== 0) {
        const bx = e.x, by = e.y;
        this.moveActor(e, e.vx * dt, e.vy * dt);
        if (e.x === bx && e.y === by) e.t = 0;
        this.updateActorFrame(e.sprite, e.x - bx, e.y - by, e.x !== bx || e.y !== by, dt);
      } else {
        this.updateActorFrame(e.sprite, 0, 0, false, dt);
      }
      if (e.type === 'slime' && this.aabb(p, e)) {
        const cx = (p.x + p.w / 2) - (e.x + e.w / 2);
        const cy = (p.y + p.h / 2) - (e.y + e.h / 2);
        const len = Math.hypot(cx, cy) || 1;
        p.kx = 0;
        p.ky = (cy / len) * KNOCKBACK;
      }
    }

    // --- カメラ追従 ---
    const camX = Math.round(p.x + p.w / 2 - VIEW_W / 2);
    const camY = Math.round(p.y + p.h / 2 - VIEW_H / 2);
    const clX = clamp(camX, 0, MAP_W * TILE - VIEW_W);
    const clY = clamp(camY, 0, MAP_H * TILE - VIEW_H);

    // --- タイルカリング描画 (可視範囲のみ / プール再利用) ---
    const startTx = Math.floor(clX / TILE);
    const startTy = Math.floor(clY / TILE);
    this.tilesDrawn = 0;
    let pi = 0, ti = 0;
    for (let row = 0; row < this.rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < this.colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        const s = this.tilePool[pi++];
        if (!s) break;
        s.material.map = this.tileTexByType[type];
        this.place(s, tx * TILE - clX, ty * TILE - clY);
        s.visible = true;
        this.tilesDrawn++;
        if (type === T_TREE) {
          const tr = this.treePool[ti++];
          if (tr) {
            this.place(tr, tx * TILE - clX, ty * TILE - 16 - clY);
            tr.renderOrder = RO_ENT + (ty * TILE + 48) * 0.0001;
            tr.visible = true;
          }
        }
      }
    }
    for (; pi < this.tilePool.length; pi++) this.tilePool[pi].visible = false;
    this.treesDrawn = ti;
    for (; ti < this.treePool.length; ti++) this.treePool[ti].visible = false;

    // --- エンティティ描画 + 深度ソート ---
    for (const e of this.entities) {
      this.place(e.sprite, e.x - 2 - clX, e.y - 2 - clY);
      e.sprite.renderOrder = RO_ENT + (e.y + e.h) * 0.0001;
    }
    this.place(p.sprite, p.x - 2 - clX, p.y - 2 - clY);
    p.sprite.renderOrder = RO_ENT + (p.y + p.h) * 0.0001;

    // --- HUD ---
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const ptx = Math.floor((p.x + p.w / 2) / TILE);
      const pty = Math.floor((p.y + p.h / 2) / TILE);
      const treeCount = this.countTrees();
      this.hudEl.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${this.tilesDrawn}  (trees: ${this.treesDrawn})\n` +
        `Entities    : ${this.entities.length + treeCount}  (NPC+敵:${this.entities.length} / 木:${treeCount})\n` +
        `Player tile : (${ptx}, ${pty})  ${this.dashOn ? '[DASH]' : ''}`;
    }

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!this.started) {
      this.blinkT += dt;
      if (this.titleEl) this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  },
});

console.log('A-Frame トップダウンRPG探索 component registered.');
