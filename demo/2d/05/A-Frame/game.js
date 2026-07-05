/* ============================================================================
 * テーマ5 横スクロールアクション ― A-Frame (1.7.0) 実装
 * 共通仕様 SPEC.md / 正準実装 PixiJS に厳密準拠。性能比較用。
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。シーンは
 * index.html に <a-scene> として宣言し、ゲーム本体は登録した `platformer-game`
 * コンポーネントが駆動する (A-Frame の renderer / tick ループ / カメラ管理を利用)。
 *
 * 設計判断: タイル(可視〜510)・敵(最大500)・コインは大量になり得るため、
 * 「1オブジェクト = 1 <a-entity>」だと DOM/コンポーネント生成コストで FPS が破綻する。
 * そこで動的オブジェクトはコンポーネント内で THREE.Sprite を直接生成・管理する
 * (AFRAME.THREE を使用)。カメラは 2D 用 OrthographicCamera へ差し替え、tick で維持。
 *
 * 広い横長マップ (200x17 = 6400x544px) の水平スクロールは、ワールド全体を載せた
 * THREE.Group を -camX, +camY 平行移動して表現 (= カメラ追従)。タイルは可視範囲ぶんの
 * Sprite プールで真のカリング。物理 (重力 + 可変ジャンプ + AABB 軸分離) は自前実装。
 * ========================================================================== */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const TILE = 32;
const MAP_W = 200;
const MAP_H = 17;
const VIEW_W = 960;
const VIEW_H = 540;
const WORLD_W = MAP_W * TILE;     // 6400
const WORLD_H = MAP_H * TILE;     // 544

const GRAVITY = 1800;
const WALK_SPEED = 180;
const DASH_SPEED = 288;
const JUMP_VY = -640;
const JUMP_CUT = 0.45;
const FALL_MARGIN = 80;

const P_W = 24, P_H = 44;
const P_DRAW_W = 32, P_DRAW_H = 48;
const P_HP = 3;
const INVULN = 1.0;
const KNOCKBACK_X = 220;
const KNOCKBACK_Y = -260;

const E_W = 28, E_H = 28;
const E_SPEED = 60;
const STOMP_BOUNCE = -380;
const SCORE_STOMP = 100;
const SCORE_COIN = 50;

const ENEMY_INIT = 20;
const ENEMY_STEP = 10;
const ENEMY_MIN = 0;
const ENEMY_MAX = 500;

const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = new Set([T_GROUND, T_BRICK, T_PIPE]);

const ASSET_DEFS = {
  player:      '../assets/player.png',
  player_walk: '../assets/player_walk.png',
  goomba:      '../assets/enemy_goomba.png',
  goomba_walk: '../assets/enemy_goomba_walk.png',
  tile_ground: '../assets/tile_ground.png',
  tile_brick:  '../assets/tile_brick.png',
  tile_pipe:   '../assets/tile_pipe.png',
  coin:        '../assets/coin.png',
  bg_sky:      '../assets/bg_sky.png',
};

// renderOrder: bg < tile < coin < enemy < player < fx
const RO = { bg: 0, tile: 1, coin: 2, enemy: 3, player: 4, fx: 5 };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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

// ---- マップ決定的生成 (PixiJS と同一) -------------------------------------
function generateMap() {
  const rnd = mulberry32(20250614);
  const map = new Uint8Array(MAP_W * MAP_H);
  const idx = (x, y) => y * MAP_W + x;
  const GROUND_TOP = MAP_H - 2;

  let x = 0;
  while (x < MAP_W) {
    // 地面の連続区間を敷く
    const run = 5 + Math.floor(rnd() * 6);
    for (let i = 0; i < run && x < MAP_W; i++, x++) {
      map[idx(x, GROUND_TOP)] = T_GROUND;
      map[idx(x, MAP_H - 1)] = T_GROUND;
    }
    // その後に幅1の穴を1つだけ（連続穴を防ぎ、デモが必ず越えられる幅にする）
    if (x > 8 && x < MAP_W - 8 && rnd() < 0.30) x += 1;
  }
  // 浮遊ブロックはジャンプ頂点(約3.5タイル)より上(py<=9)にのみ置く（走路に天井を作らない）。
  for (let i = 0; i < 70; i++) {
    const px = 6 + Math.floor(rnd() * (MAP_W - 12));
    const py = 4 + Math.floor(rnd() * 6); // 4..9
    const len = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < len && px + k < MAP_W - 2; k++) {
      if (map[idx(px + k, py)] === T_EMPTY) map[idx(px + k, py)] = T_BRICK;
    }
  }
  // 土管は穴の近く(±4)に置かない（土管越えジャンプが穴に着地してデモが落下するため）。
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (tileAt(map, g, GROUND_TOP) !== T_GROUND) return false;
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const px = 12 + Math.floor(rnd() * (MAP_W - 24));
    if (map[idx(px, GROUND_TOP)] === T_GROUND && map[idx(px + 1, GROUND_TOP)] === T_GROUND && noGapNear(px)) {
      const h = 1 + Math.floor(rnd() * 2);
      for (let k = 1; k <= h; k++) {
        map[idx(px, GROUND_TOP - k)] = T_PIPE;
        map[idx(px + 1, GROUND_TOP - k)] = T_PIPE;
      }
    }
  }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_GROUND; map[idx(MAP_W - 1, y)] = T_GROUND; }
  return map;
}
function tileAt(map, tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return T_EMPTY;
  return map[ty * MAP_W + tx];
}
function rectHitsSolid(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE), y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE), y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (SOLID.has(tileAt(map, tx, ty))) return true;
  }
  return false;
}

// worldY = WORLD_H - gameY 変換
function H2(gameY) { return WORLD_H - gameY; }

// ---- canvas フォールバックテクスチャ (SPEC 既定色) -------------------------
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
  player:      () => canvasTexture('player', 32, 48, (g) => { g.fillStyle = '#e23b2e'; g.fillRect(2, 2, 28, 44); g.fillStyle = '#ffe0c0'; g.fillRect(4, 4, 24, 10); g.fillStyle = '#222'; g.beginPath(); g.arc(11, 9, 2, 0, 7); g.arc(21, 9, 2, 0, 7); g.fill(); }),
  goomba:      () => canvasTexture('goomba', 32, 32, (g) => { g.fillStyle = '#8a5a2b'; g.beginPath(); g.ellipse(16, 14, 13, 11, 0, 0, 7); g.fill(); g.fillStyle = '#3a2410'; g.fillRect(8, 24, 16, 6); g.fillStyle = '#fff'; g.beginPath(); g.arc(11, 13, 2.5, 0, 7); g.arc(21, 13, 2.5, 0, 7); g.fill(); }),
  tile_ground: () => canvasTexture('tg', 32, 32, (g) => { g.fillStyle = '#9b6b3a'; g.fillRect(0, 0, 32, 32); g.fillStyle = '#6e9b3a'; g.fillRect(0, 0, 32, 4); }),
  tile_brick:  () => canvasTexture('tb', 32, 32, (g) => { g.fillStyle = '#d08030'; g.fillRect(0, 0, 32, 32); g.strokeStyle = '#8a5418'; g.lineWidth = 2; g.strokeRect(1, 1, 30, 30); g.beginPath(); g.moveTo(0, 16); g.lineTo(32, 16); g.stroke(); }),
  tile_pipe:   () => canvasTexture('tp', 32, 32, (g) => { g.fillStyle = '#3aa64a'; g.fillRect(0, 0, 32, 32); g.strokeStyle = '#216b2a'; g.lineWidth = 2; g.strokeRect(2, 0, 28, 32); g.fillStyle = 'rgba(139,227,154,0.5)'; g.fillRect(5, 3, 5, 26); }),
  coin:        () => canvasTexture('coin', 24, 24, (g) => { g.fillStyle = '#f2d33c'; g.beginPath(); g.arc(12, 12, 10, 0, 7); g.fill(); g.strokeStyle = '#c9a51e'; g.lineWidth = 2; g.stroke(); }),
  spark:       () => canvasTexture('spark', 16, 16, (g) => { g.fillStyle = '#fff2a8'; g.beginPath(); g.arc(8, 8, 7, 0, 7); g.fill(); }),
};

AFRAME.registerComponent('platformer-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.hudEl = document.getElementById('hud');

    // ワールド Group (カメラ追従で平行移動)。シーンルート object3D に載せる。
    this.world = new THREE.Group();
    this.el.object3D.add(this.world);

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
    this.score = 0; this.coinsCollected = 0; this.tilesDrawn = 0;
    this.enemySet = 0;
    this.fpsSamples = []; this.hudTimer = 0;
    this.ready = false;
    // タイトル/アトラクト状態 (false=デモ中・操作無効)
    this.started = false; this.blinkT = 0;
    this.titleEl = document.getElementById('title');

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Enter' && !this.started) { this.startGame(); e.preventDefault(); }
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.setEnemyCount(this.enemySet + ENEMY_STEP); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.setEnemyCount(this.enemySet - ENEMY_STEP); e.preventDefault(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // アセット読み込み → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  texOf(key) {
    return this.tex[key] || (FB[key] && FB[key]()) || this.tex[key.replace('_walk', '')] || FB[key.replace('_walk', '')]();
  },

  makeSprite(key, w, h, renderOrder, frames = 1, rows = 1) {
    let map = this.texOf(key);
    if (frames > 1 || rows > 1) {
      map = map.clone();
      map.repeat.set(1 / frames, 1 / rows);
      map.needsUpdate = true;
    }
    const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.center.set(0, 0);
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    s.userData.frames = frames;
    s.userData.rows = rows;
    s.userData.frame = -1;
    s.userData.row = -1;
    this.world.add(s); return s;
  },

  setSpriteFrame(s, frame, row = 0) {
    const frames = s.userData.frames || 1;
    const rows = s.userData.rows || 1;
    frame = ((frame % frames) + frames) % frames;
    row = Math.max(0, Math.min(rows - 1, row));
    if (frames <= 1 && rows <= 1) return;
    if (s.userData.frame === frame && s.userData.row === row) return;
    s.material.map.offset.x = frame / frames;
    s.material.map.offset.y = (rows - 1 - row) / rows;
    s.userData.frame = frame;
    s.userData.row = row;
  },

  down(...c) { return c.some((k) => this.keys[k]); },

  aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; },
  moveAndCollide(a, dx, dy) {
    const map = this.map;
    let hitX = false;
    if (dx !== 0) {
      let nx = a.x + dx;
      if (rectHitsSolid(map, nx, a.y, a.w, a.h)) {
        if (dx > 0) nx = Math.floor((nx + a.w) / TILE) * TILE - a.w - 0.001;
        else nx = Math.floor(nx / TILE + 1) * TILE + 0.001;
        a.vx = 0; hitX = true;
      }
      a.x = nx;
    }
    a.onGround = false;
    if (dy !== 0) {
      let ny = a.y + dy;
      if (rectHitsSolid(map, a.x, ny, a.w, a.h)) {
        if (dy > 0) { ny = Math.floor((ny + a.h) / TILE) * TILE - a.h - 0.001; a.onGround = true; }
        else ny = Math.floor(ny / TILE + 1) * TILE + 0.001;
        a.vy = 0;
      }
      a.y = ny;
    }
    return { hitX };
  },

  getEnemySprite() {
    let s = this.enemyPool.pop();
    if (!s) s = this.makeSprite('goomba_walk', 32, 32, RO.enemy, 4, 2);
    s.visible = true;
    return s;
  },
  setEnemyCount(n) {
    if (!this.ready) { this.enemySet = clamp(n, ENEMY_MIN, ENEMY_MAX); return; }
    n = clamp(n, ENEMY_MIN, ENEMY_MAX);
    while (this.enemies.length < n) {
      const i = this.enemies.length;
      const slot = this.spawnSlots[i % this.spawnSlots.length];
      const dir = (i % 2 === 0) ? 1 : -1;
      this.enemies.push({
        x: slot.tx * TILE + (TILE - E_W) / 2, y: slot.ty * TILE + (TILE - E_H),
        w: E_W, h: E_H, vx: dir * E_SPEED, vy: 0, onGround: false, alive: true, sprite: this.getEnemySprite(),
      });
    }
    while (this.enemies.length > n) { const e = this.enemies.pop(); e.sprite.visible = false; this.enemyPool.push(e.sprite); }
    this.enemySet = n;
  },

  spawnSpark(x, y) {
    let s = this.sparkPool.pop();
    if (!s) { s = this.makeSprite('spark', 16, 16, RO.fx); s.center.set(0.5, 0.5); }
    s.visible = true; s.material.opacity = 1;
    this.sparks.push({ x, y, life: 0.35, max: 0.35, sprite: s });
  },

  respawnPlayer() {
    const p = this.player;
    p.x = this.spawn.x; p.y = this.spawn.y; p.vx = 0; p.vy = 0; p.hp = P_HP; p.invuln = INVULN; p.onGround = false;
  },
  hurtPlayer(fromX) {
    const p = this.player;
    if (p.invuln > 0) return;
    p.hp -= 1; p.invuln = INVULN;
    const dir = (p.x + p.w / 2) < fromX ? -1 : 1;
    p.vx = KNOCKBACK_X * dir; p.vy = KNOCKBACK_Y; p.onGround = false;
    if (p.hp <= 0) this.respawnPlayer();
  },

  // Enter でデモ→プレイ開始: スコア等を新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true;
    this.score = 0; this.coinsCollected = 0;
    for (let i = 0; i < this.coins.length; i++) { const c = this.coins[i]; if (c.taken) { c.taken = false; c.sprite.visible = true; } }
    this.setEnemyCount(ENEMY_INIT);
    this.respawnPlayer();
    this.titleEl.style.display = 'none';
  },

  // ---- デモAI (決定的): 右走行 + 接地時に前方の障害/穴で自動ジャンプ ----
  demoAI(p) {
    const map = this.map;
    const aheadX = p.x + p.w + 4;
    const midY = p.y + p.h * 0.5;
    const footY = p.y + p.h - 2;
    const wallAhead =
      SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(midY / TILE))) ||
      SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(footY / TILE)));
    const gapProbeX = p.x + p.w + TILE * 1.2;
    const belowTy = Math.floor((p.y + p.h + TILE * 0.5) / TILE);
    const gapAhead = p.onGround && !SOLID.has(tileAt(map, Math.floor(gapProbeX / TILE), belowTy));
    let jump = false;
    if (p.onGround) jump = wallAhead || gapAhead;
    else if (p.vy < 0) jump = true;   // 上昇中は保持 (可変ジャンプを伸ばす)
    return { move: 1, jump };
  },

  build() {
    const map = generateMap();
    this.map = map;

    // 背景 (画面固定): bg_sky 画像があれば repeat Plane を scene 直下に
    if (this.tex.bg_sky) {
      this.tex.bg_sky.wrapS = this.tex.bg_sky.wrapT = THREE.RepeatWrapping;
      this.tex.bg_sky.repeat.set(VIEW_W / 512, VIEW_H / 512);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(VIEW_W, VIEW_H),
        new THREE.MeshBasicMaterial({ map: this.tex.bg_sky, depthTest: false }));
      m.position.set(VIEW_W / 2, VIEW_H / 2, -10); m.renderOrder = RO.bg;
      this.el.object3D.add(m); // world ではなく固定
    }

    // タイルプール (可視範囲のみ / Sprite 再利用カリング)
    this.colsVis = Math.ceil(VIEW_W / TILE) + 2;
    this.rowsVis = Math.ceil(VIEW_H / TILE) + 2;
    this.tileTexByType = { [T_GROUND]: this.texOf('tile_ground'), [T_BRICK]: this.texOf('tile_brick'), [T_PIPE]: this.texOf('tile_pipe') };
    this.tilePool = [];
    for (let i = 0; i < this.colsVis * this.rowsVis; i++) {
      const s = this.makeSprite('tile_ground', TILE, TILE, RO.tile);
      s.visible = false; this.tilePool.push(s);
    }

    // コイン (決定的配置)
    this.coins = [];
    {
      const rnd = mulberry32(777);
      for (let tx = 2; tx < MAP_W - 2; tx++) for (let ty = 2; ty < MAP_H - 1; ty++) {
        if (tileAt(map, tx, ty) !== T_EMPTY) continue;
        if (!SOLID.has(tileAt(map, tx, ty + 1))) continue;
        if (rnd() < 0.10) {
          const s = this.makeSprite('coin', 24, 24, RO.coin);
          const x = tx * TILE + (TILE - 24) / 2, y = ty * TILE + (TILE - 24) / 2;
          s.position.set(x, H2(y) - 24, 0);
          this.coins.push({ x, y, w: 24, h: 24, taken: false, sprite: s });
        }
      }
    }

    // スポーン地点
    const GROUND_TOP_Y = (MAP_H - 2) * TILE;
    this.spawn = { x: 3 * TILE, y: GROUND_TOP_Y - P_H };

    // プレイヤー
    this.player = { x: this.spawn.x, y: this.spawn.y, w: P_W, h: P_H, vx: 0, vy: 0, onGround: false, hp: P_HP, invuln: 0, facing: 1 };
    this.playerSprite = this.makeSprite('player_walk', P_DRAW_W, P_DRAW_H, RO.player, 4, 2);

    // 敵スポーン候補 (決定的列挙 + シャッフル)
    this.spawnSlots = [];
    for (let tx = 5; tx < MAP_W - 5; tx++) for (let ty = 2; ty < MAP_H - 1; ty++) {
      if (tileAt(map, tx, ty) !== T_EMPTY) continue;
      if (SOLID.has(tileAt(map, tx, ty + 1))) this.spawnSlots.push({ tx, ty });
    }
    {
      const rnd = mulberry32(31337);
      for (let i = this.spawnSlots.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = this.spawnSlots[i]; this.spawnSlots[i] = this.spawnSlots[j]; this.spawnSlots[j] = t;
      }
    }

    this.enemies = []; this.enemyPool = [];
    this.sparks = []; this.sparkPool = [];

    this.ready = true;
    this.setEnemyCount(this.enemySet || ENEMY_INIT);
  },

  tick(time, dtMs) {
    if (!this.ready) return;
    const sceneEl = this.el.sceneEl;
    if (sceneEl.camera !== this.cam) sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50);
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();

    const map = this.map, p = this.player, enemies = this.enemies, coins = this.coins;

    // 1) 入力 + 物理
    // !started (アトラクト) 中はデモAIで右走行＋障害/穴で自動ジャンプ。キー入力は無視。
    let move = 0, jumpHeld = false, speed = WALK_SPEED;
    if (!this.started) {
      const demo = this.demoAI(p);
      move = demo.move; jumpHeld = demo.jump;
    } else {
      const dash = this.down('ShiftLeft', 'ShiftRight');
      speed = dash ? DASH_SPEED : WALK_SPEED;
      if (this.down('ArrowLeft', 'KeyA')) move -= 1;
      if (this.down('ArrowRight', 'KeyD')) move += 1;
      jumpHeld = this.down('Space', 'ArrowUp', 'KeyW');
    }

    const knockbackActive = Math.abs(p.vx) > speed + 1 && p.invuln > 0;
    if (knockbackActive) { p.vx *= 0.9; if (Math.abs(p.vx) < speed) p.vx = move * speed; }
    else p.vx = move * speed;
    if (move !== 0) p.facing = move;

    if (jumpHeld && p.onGround) { p.vy = JUMP_VY; p.onGround = false; }
    if (!jumpHeld && p.vy < 0) p.vy *= JUMP_CUT;

    p.vy += GRAVITY * dt;
    if (p.vy > 1200) p.vy = 1200;
    this.moveAndCollide(p, p.vx * dt, p.vy * dt);

    if (p.invuln > 0) { p.invuln -= dt; if (p.invuln < 0) p.invuln = 0; }

    if (p.y > WORLD_H + FALL_MARGIN) {
      p.hp -= 1;
      if (p.hp <= 0) this.respawnPlayer();
      else { p.x = this.spawn.x; p.y = this.spawn.y; p.vx = 0; p.vy = 0; p.invuln = INVULN; }
    }

    // 2) 敵更新
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      e.vy += GRAVITY * dt; if (e.vy > 1200) e.vy = 1200;
      const dir = Math.sign(e.vx) || 1;
      const beforeX = e.x;
      const res = this.moveAndCollide(e, e.vx * dt, e.vy * dt);
      if (res.hitX || Math.abs(e.x - beforeX) < 0.01) e.vx = -dir * E_SPEED;
      else e.vx = dir * E_SPEED;
    }

    // 3) 自機 × 敵
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!this.aabb(p, e)) continue;
      const stomp = p.vy > 0 && ((p.y + p.h) - e.y) < (e.h * 0.6 + Math.abs(p.vy * dt) + 1);
      if (stomp) {
        e.sprite.visible = false; this.enemyPool.push(e.sprite);
        enemies[i] = enemies[enemies.length - 1]; enemies.pop(); i--;
        this.score += SCORE_STOMP; this.spawnSpark(e.x + e.w / 2, e.y + e.h / 2); p.vy = STOMP_BOUNCE;
      } else this.hurtPlayer(e.x + e.w / 2);
    }

    // 4) コイン
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c.taken) continue;
      if (this.aabb(p, c)) { c.taken = true; c.sprite.visible = false; this.coinsCollected += 1; this.score += SCORE_COIN; }
    }

    // 5) カメラ (水平追従 + クランプ) → world 平行移動
    const camX = clamp(Math.round(p.x + p.w / 2 - VIEW_W / 2), 0, WORLD_W - VIEW_W);
    const camY = clamp(Math.round(p.y + p.h / 2 - VIEW_H / 2), 0, Math.max(0, WORLD_H - VIEW_H));
    this.world.position.set(-camX, -(WORLD_H - VIEW_H - camY), 0);

    // 6) タイルカリング
    const startTx = Math.floor(camX / TILE);
    const startTy = Math.floor(camY / TILE);
    let pi = 0;
    for (let row = 0; row < this.rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < this.colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        if (type === T_EMPTY) continue;
        const s = this.tilePool[pi++];
        if (!s) break;
        if (s.material.map !== this.tileTexByType[type]) { s.material.map = this.tileTexByType[type]; s.material.needsUpdate = true; }
        s.position.set(tx * TILE, H2(ty * TILE) - TILE, 0);
        s.visible = true;
      }
    }
    this.tilesDrawn = pi;
    for (; pi < this.tilePool.length; pi++) this.tilePool[pi].visible = false;

    // 7) スプライト位置反映
    const dirRow = p.facing < 0 ? 1 : 0;
    const playerFrame = Math.abs(p.vx) > 5 && p.onGround ? Math.floor(performance.now() / 110) % 4 : 0;
    this.setSpriteFrame(this.playerSprite, playerFrame, dirRow);
    this.playerSprite.center.set(0, 0);
    this.playerSprite.scale.set(P_DRAW_W, P_DRAW_H, 1);
    const pdx = p.x - (P_DRAW_W - P_W) / 2;
    const pdy = p.y - (P_DRAW_H - P_H);
    this.playerSprite.position.set(pdx, H2(pdy) - P_DRAW_H, 0);
    this.playerSprite.material.opacity = (p.invuln > 0 && Math.floor(p.invuln * 20) % 2 === 0) ? 0.35 : 1;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dx = e.x - (32 - E_W) / 2, dy = e.y - (32 - E_H);
      this.setSpriteFrame(e.sprite, Math.floor((performance.now() / 140) + i) % 4, e.vx < 0 ? 1 : 0);
      e.sprite.position.set(dx, H2(dy) - 32, 0);
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i]; sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.material.opacity = clamp(t, 0, 1);
      const sc = 16 * (1 + (1 - t) * 0.8);
      sp.sprite.scale.set(sc, sc, 1);
      sp.sprite.position.set(sp.x, H2(sp.y), 0);
      if (sp.life <= 0) { sp.sprite.visible = false; this.sparkPool.push(sp.sprite); this.sparks[i] = this.sparks[this.sparks.length - 1]; this.sparks.pop(); }
    }

    // 8) HUD
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
      const ptx = Math.floor((p.x + p.w / 2) / TILE);
      const pty = Math.floor((p.y + p.h / 2) / TILE);
      const entities = enemies.length + coins.filter((c) => !c.taken).length;
      this.hudEl.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${this.tilesDrawn}  /  Entities : ${entities}\n` +
        `Player tile : (${ptx}, ${pty})\n` +
        `Score : ${this.score}   Coins : ${this.coinsCollected}   HP : ${p.hp}\n` +
        `Enemies : ${enemies.length} / ${this.enemySet}   (+/- で増減, 上限 ${ENEMY_MAX})`;
    }

    // タイトル点滅 (アトラクト中のみ)
    if (!this.started) { this.blinkT += dt; this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  },
});

console.log('A-Frame theme5 platformer component registered.');
