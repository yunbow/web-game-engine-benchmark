/* ============================================================================
 * テーマ6 タワーディフェンス（経路探索 × 多数ユニット追従）― A-Frame (1.7.0) 実装
 * 共通仕様 SPEC.md / 基準実装 PixiJS に厳密準拠。性能比較用。
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `td-game` コンポーネントが駆動する (A-Frame の renderer / tick ループ /
 * カメラ管理を利用)。
 *
 * 設計判断:
 *   - タイル(510)・creep(数百)・弾は「1 = 1 <a-entity>」だと破綻するため、
 *     動的オブジェクトはコンポーネント内で THREE.Sprite を直接生成・管理する。
 *   - 2D 用 OrthographicCamera(0,W,H,0) へ差し替え、tick で sceneEl.camera を維持。
 *   - A* 経路探索・追従・弾・距離判定はすべて自前 (組み込み経路探索は使わない)。
 *   - 座標は画面座標(Y下)保持 → worldY = H - y 変換。
 * ========================================================================== */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC) — 全エンジン共通値 ----------------------------------------
const TILE = 32;
const GRID_W = 30, GRID_H = 17;
const VIEW_W = 960, VIEW_H = 540;
const W = VIEW_W, H = VIEW_H;

const START_TX = 0, START_TY = 8;
const GOAL_TX = GRID_W - 1, GOAL_TY = 8;
const T_PATH = 0, T_WALL = 1;

const CREEP_R = 10, CREEP_SPEED = 70, CREEP_HP = 30, SPAWN_INTERVAL = 0.5;
const TOWER_COST = 25, TOWER_RANGE = 96, TOWER_FIRE_CD = 0.6;
const PROJ_DMG = 10, PROJ_SPEED = 320, PROJ_R = 6;
const CAP_INIT = 30, CAP_STEP = 10, CAP_MIN = 10, CAP_MAX = 500;
const GOLD_INIT = 120, LIVES_INIT = 20, GOLD_KILL = 5, SCORE_KILL = 10;

const ASSET_DEFS = {
  creep:      '../assets/creep.png',
  tower:      '../assets/tower.png',
  projectile: '../assets/projectile.png',
  tile_path:  '../assets/tile_path.png',
  tile_wall:  '../assets/tile_wall.png',
  base:       '../assets/base.png',
  hit_spark:  '../assets/hit_spark.png',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const idx = (tx, ty) => ty * GRID_W + tx;
const RO = { tile: 0, path: 1, base: 2, tower: 3, creep: 4, proj: 5, fx: 6 };

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

// ---- A* 経路探索 (4方向 / コスト1 / マンハッタン) — 自前実装 ----------------
function aStar(map, sx, sy, gx, gy, towerBlocked) {
  if (map[idx(gx, gy)] === T_WALL) return null;
  const N = GRID_W * GRID_H;
  const came = new Int32Array(N).fill(-1);
  const gScore = new Float32Array(N).fill(Infinity);
  const fScore = new Float32Array(N).fill(Infinity);
  const inOpen = new Uint8Array(N);
  const closed = new Uint8Array(N);
  const startId = idx(sx, sy), goalId = idx(gx, gy);
  const h = (tx, ty) => Math.abs(tx - gx) + Math.abs(ty - gy);
  gScore[startId] = 0; fScore[startId] = h(sx, sy);
  const open = [startId]; inOpen[startId] = 1;
  const isBlocked = (tx, ty) => {
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return true;
    if (map[idx(tx, ty)] === T_WALL) return true;
    if (towerBlocked && towerBlocked.has(idx(tx, ty))) return true;
    return false;
  };
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  while (open.length > 0) {
    let bestI = 0;
    for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bestI]]) bestI = i;
    const current = open[bestI];
    open[bestI] = open[open.length - 1]; open.pop(); inOpen[current] = 0;
    if (current === goalId) {
      const path = [];
      let c = current;
      while (c !== -1) { path.push({ tx: c % GRID_W, ty: Math.floor(c / GRID_W) }); c = came[c]; }
      path.reverse();
      return path;
    }
    closed[current] = 1;
    const cx = current % GRID_W, cy = Math.floor(current / GRID_W);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (isBlocked(nx, ny)) continue;
      const nId = idx(nx, ny);
      if (closed[nId]) continue;
      const tentative = gScore[current] + 1;
      if (tentative < gScore[nId]) {
        came[nId] = current; gScore[nId] = tentative; fScore[nId] = tentative + h(nx, ny);
        if (!inOpen[nId]) { open.push(nId); inOpen[nId] = 1; }
      }
    }
  }
  return null;
}

// ---- マップ決定的生成 (PixiJS 基準と同一手順・同一シード) -------------------
function generateMap() {
  const rnd = mulberry32(20250615);
  const map = new Uint8Array(GRID_W * GRID_H);
  for (let x = 0; x < GRID_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, GRID_H - 1)] = T_WALL; }
  for (let y = 0; y < GRID_H; y++) { map[idx(0, y)] = T_WALL; map[idx(GRID_W - 1, y)] = T_WALL; }
  map[idx(START_TX, START_TY)] = T_PATH;
  map[idx(GOAL_TX, GOAL_TY)] = T_PATH;
  const blocks = 26;
  for (let i = 0; i < blocks; i++) {
    const bx = 2 + Math.floor(rnd() * (GRID_W - 4));
    const by = 2 + Math.floor(rnd() * (GRID_H - 4));
    const vertical = rnd() < 0.5;
    const len = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < len; k++) {
      const wx = vertical ? bx : bx + k;
      const wy = vertical ? by + k : by;
      if (wx <= 1 || wx >= GRID_W - 2 || wy <= 1 || wy >= GRID_H - 2) continue;
      if (wy === START_TY && (wx <= 2 || wx >= GRID_W - 3)) continue;
      map[idx(wx, wy)] = T_WALL;
    }
  }
  let guard = 0;
  while (!aStar(map, START_TX, START_TY, GOAL_TX, GOAL_TY) && guard < 4000) {
    guard++;
    let removed = false;
    for (let x = 1; x < GRID_W - 1 && !removed; x++) {
      if (map[idx(x, START_TY)] === T_WALL) { map[idx(x, START_TY)] = T_PATH; removed = true; }
    }
    if (!removed) break;
  }
  return map;
}

// ---- 2D canvas → CanvasTexture フォールバック ------------------------------
const fbCache = {};
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
  fbCache[name] = t; return t;
}
const fb = {
  tile_path:  () => canvasTexture('tp', TILE, TILE, (g) => { g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, TILE, TILE); g.strokeStyle = 'rgba(58,65,80,0.7)'; g.strokeRect(0.5, 0.5, TILE - 1, TILE - 1); }),
  tile_wall:  () => canvasTexture('tw', TILE, TILE, (g) => { g.fillStyle = '#6b7280'; g.fillRect(0, 0, TILE, TILE); g.strokeStyle = '#4a505c'; g.lineWidth = 2; g.strokeRect(1, 1, TILE - 2, TILE - 2); }),
  creep:      () => canvasTexture('cr', 24, 24, (g) => { g.fillStyle = '#e2402e'; g.beginPath(); g.arc(12, 12, 10, 0, 7); g.fill(); g.strokeStyle = '#8a1810'; g.lineWidth = 2; g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.arc(8, 9, 2.4, 0, 7); g.fill(); g.beginPath(); g.arc(16, 9, 2.4, 0, 7); g.fill(); }),
  tower:      () => canvasTexture('to', TILE, TILE, (g) => { g.fillStyle = '#3f7fd8'; g.fillRect(4, 4, TILE - 8, TILE - 8); g.strokeStyle = '#1c4e9c'; g.lineWidth = 2; g.strokeRect(4, 4, TILE - 8, TILE - 8); g.fillStyle = '#cfe2ff'; g.beginPath(); g.arc(16, 16, 5, 0, 7); g.fill(); }),
  projectile: () => canvasTexture('pj', 12, 12, (g) => { g.fillStyle = '#f2d33c'; g.beginPath(); g.arc(6, 6, 5, 0, 7); g.fill(); }),
  base:       () => canvasTexture('ba', TILE, TILE, (g) => { g.fillStyle = 'rgba(63,196,99,0.25)'; g.fillRect(0, 0, TILE, TILE); g.fillStyle = '#dfeee0'; g.fillRect(8, 4, 2, 24); g.fillStyle = '#3fc463'; g.beginPath(); g.moveTo(10, 5); g.lineTo(26, 9); g.lineTo(10, 14); g.closePath(); g.fill(); }),
  hit_spark:  () => canvasTexture('hs', 16, 16, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(8, 8, 6, 0, 7); g.fill(); }),
};

AFRAME.registerComponent('td-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');
    this.titleEl = document.getElementById('title');

    // ---- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ----
    this.started = false; this.blinkT = 0;
    this.DEMO_TOWERS = [
      [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
      [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
    ];
    this.demoIdx = 0; this.demoTimer = 0;

    // 2D 用 OrthographicCamera (tick で sceneEl.camera を維持)
    this.cam = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1); // DPR=1 固定
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    // テクスチャ
    this.tex = {};
    this.ready = false;

    // プール / 配列
    this.creepPool = []; this.projPool = []; this.sparkPool = [];
    this.tileSprites = []; this.towerSprites = [];
    this.fpsSamples = []; this.hudTimer = 0;

    // 入力 (キーボード)
    window.addEventListener('keydown', (e) => {
      if (!this.ready) return;
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.enemyCap = clamp(this.enemyCap + CAP_STEP, CAP_MIN, CAP_MAX); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.enemyCap = clamp(this.enemyCap - CAP_STEP, CAP_MIN, CAP_MAX); e.preventDefault(); }
      else if (e.code === 'KeyR') this.reset();
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (!this.started) this.startGame(); }
    });

    // マウス (キャンバスへ。canvas は loaded 後に取得)
    const bindMouse = () => {
      this.canvas = sceneEl.canvas || sceneEl.renderer.domElement;
      this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
      this.canvas.addEventListener('pointerdown', (ev) => {
        if (!this.ready) return;
        if (!this.started) return;   // アトラクト中はプレイヤー操作を無効化
        const { tx, ty } = this.eventToTile(ev);
        if (ev.button === 0) this.placeTower(tx, ty);
        else if (ev.button === 2) this.removeTower(tx, ty);
      });
    };
    if (sceneEl.hasLoaded) bindMouse(); else sceneEl.addEventListener('loaded', bindMouse);

    // アセット読み込み → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  texOf(key) { return this.tex[key] || fb[key](); },

  makeSprite(key, w, h, renderOrder) {
    const mat = new THREE.SpriteMaterial({ map: this.texOf(key), transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    this.group.add(s);
    return s;
  },
  setTileSprite(s, tx, ty) { s.position.set(tx * TILE + TILE / 2, H - (ty * TILE + TILE / 2), 0); },
  syncXY(s, x, y) { s.position.set(x, H - y, 0); },

  cellCenterX(tx) { return tx * TILE + TILE / 2; },
  cellCenterY(ty) { return ty * TILE + TILE / 2; },

  eventToTile(event) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    const px = (event.clientX - rect.left) * sx;
    const py = (event.clientY - rect.top) * sy;
    return { tx: Math.floor(px / TILE), ty: Math.floor(py / TILE) };
  },

  build() {
    // 固定タイル群 (プールした Sprite)
    for (let i = 0; i < GRID_W * GRID_H; i++) {
      const s = this.makeSprite('tile_path', TILE, TILE, RO.tile);
      this.tileSprites.push(s);
    }
    this.baseSprite = this.makeSprite('base', TILE, TILE, RO.base);
    this.setTileSprite(this.baseSprite, GOAL_TX, GOAL_TY);

    // 経路ハイライト用グループ
    this.pathGroup = new THREE.Group();
    this.group.add(this.pathGroup);
    this.pathMat = new THREE.MeshBasicMaterial({ color: 0x5fa8ff, transparent: true, opacity: 0.10, depthTest: false });

    this.reset();
    this.ready = true;
  },

  clearPathGfx() {
    while (this.pathGroup.children.length) {
      const o = this.pathGroup.children.pop();
      if (o.geometry) o.geometry.dispose();
    }
  },
  redrawPath() {
    this.clearPathGfx();
    if (!this.currentPath || this.currentPath.length === 0) return;
    for (const c of this.currentPath) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(TILE - 8, TILE - 8), this.pathMat);
      m.position.set(c.tx * TILE + TILE / 2, H - (c.ty * TILE + TILE / 2), 0);
      m.renderOrder = RO.path;
      this.pathGroup.add(m);
    }
    const pts = [];
    for (const c of this.currentPath) pts.push(new THREE.Vector3(this.cellCenterX(c.tx), H - this.cellCenterY(c.ty), 0));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x5fa8ff, transparent: true, opacity: 0.35, depthTest: false }));
    line.renderOrder = RO.path;
    this.pathGroup.add(line);
  },

  refreshTiles() {
    for (let ty = 0; ty < GRID_H; ty++) {
      for (let tx = 0; tx < GRID_W; tx++) {
        const s = this.tileSprites[idx(tx, ty)];
        s.material.map = this.texOf(this.map[idx(tx, ty)] === T_WALL ? 'tile_wall' : 'tile_path');
        s.material.needsUpdate = true;
        this.setTileSprite(s, tx, ty);
      }
    }
  },

  getCreepSprite() {
    let s = this.creepPool.pop();
    if (!s) s = this.makeSprite('creep', 24, 24, RO.creep);
    s.visible = true; s.material.opacity = 1;
    return s;
  },
  getProjSprite() {
    let s = this.projPool.pop();
    if (!s) s = this.makeSprite('projectile', 12, 12, RO.proj);
    s.visible = true;
    return s;
  },
  getSparkSprite() {
    let s = this.sparkPool.pop();
    if (!s) s = this.makeSprite('hit_spark', 16, 16, RO.fx);
    s.visible = true; s.material.opacity = 1; s.scale.set(16, 16, 1);
    return s;
  },

  computePath() { return aStar(this.map, START_TX, START_TY, GOAL_TX, GOAL_TY, this.towerBlocked); },

  repathCreep(c) {
    const ctx = clamp(Math.floor(c.x / TILE), 0, GRID_W - 1);
    const cty = clamp(Math.floor(c.y / TILE), 0, GRID_H - 1);
    const p = aStar(this.map, ctx, cty, GOAL_TX, GOAL_TY, this.towerBlocked);
    this.pathRecalcs++;
    if (p && p.length > 0) { c.path = p; c.wp = p.length > 1 ? 1 : 0; }
  },

  spawnCreep() {
    if (!this.currentPath || this.currentPath.length === 0) return;
    const s = this.getCreepSprite();
    this.creeps.push({ x: this.cellCenterX(START_TX), y: this.cellCenterY(START_TY), hp: CREEP_HP, maxHp: CREEP_HP,
      path: this.currentPath, wp: this.currentPath.length > 1 ? 1 : 0, sprite: s });
  },

  killCreep(i, byTower) {
    const c = this.creeps[i];
    c.sprite.visible = false;
    this.creepPool.push(c.sprite);
    this.creeps[i] = this.creeps[this.creeps.length - 1]; this.creeps.pop();
    if (byTower) { this.gold += GOLD_KILL; this.score += SCORE_KILL; this.spawnSpark(c.x, c.y); }
  },

  spawnSpark(x, y) {
    const s = this.getSparkSprite();
    this.syncXY(s, x, y);
    this.sparks.push({ x, y, life: 0.3, max: 0.3, sprite: s });
  },

  placeTower(tx, ty) {
    if (this.gameOver) return false;
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
    if (this.map[idx(tx, ty)] === T_WALL) return false;
    if (this.towerBlocked.has(idx(tx, ty))) return false;
    if ((tx === START_TX && ty === START_TY) || (tx === GOAL_TX && ty === GOAL_TY)) return false;
    if (this.gold < TOWER_COST) return false;

    this.towerBlocked.add(idx(tx, ty));
    const newPath = this.computePath();
    if (!newPath) { this.towerBlocked.delete(idx(tx, ty)); return false; }

    this.gold -= TOWER_COST;
    const s = this.makeSprite('tower', TILE, TILE, RO.tower);
    this.setTileSprite(s, tx, ty);
    this.towers.push({ tx, ty, cd: 0 });
    this.towerSprites.push({ tx, ty, sprite: s });

    this.currentPath = newPath;
    this.pathRecalcs++;
    this.redrawPath();
    for (const c of this.creeps) this.repathCreep(c);
    return true;
  },

  removeTower(tx, ty) {
    const i = this.towers.findIndex((t) => t.tx === tx && t.ty === ty);
    if (i < 0) return false;
    this.towers.splice(i, 1);
    const si = this.towerSprites.findIndex((t) => t.tx === tx && t.ty === ty);
    if (si >= 0) {
      const o = this.towerSprites[si];
      this.group.remove(o.sprite); o.sprite.material.dispose();
      this.towerSprites.splice(si, 1);
    }
    this.towerBlocked.delete(idx(tx, ty));
    this.currentPath = this.computePath();
    this.pathRecalcs++;
    this.redrawPath();
    for (const c of this.creeps) this.repathCreep(c);
    return true;
  },

  reset() {
    if (this.creeps) for (const c of this.creeps) { c.sprite.visible = false; this.creepPool.push(c.sprite); }
    if (this.projectiles) for (const p of this.projectiles) { p.sprite.visible = false; this.projPool.push(p.sprite); }
    if (this.sparks) for (const sp of this.sparks) { sp.sprite.visible = false; this.sparkPool.push(sp.sprite); }
    for (const t of this.towerSprites) { this.group.remove(t.sprite); t.sprite.material.dispose(); }
    this.towerSprites.length = 0;

    this.map = generateMap();
    this.refreshTiles();
    this.towers = []; this.towerBlocked = new Set(); this.creeps = []; this.projectiles = []; this.sparks = [];
    this.pathRecalcs = 0; this.gold = GOLD_INIT; this.lives = LIVES_INIT; this.score = 0;
    this.enemyCap = CAP_INIT; this.spawnTimer = 0; this.gameOver = false;
    this.demoIdx = 0; this.demoTimer = 0;   // デモAIの自動配置進捗もリセット
    this.currentPath = this.computePath();
    this.pathRecalcs++;
    this.redrawPath();
  },

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true; this.reset();
    if (this.titleEl) this.titleEl.style.display = 'none';
  },

  // デモAI: 決定的な固定座標へ数基自動配置して防衛デモにする (Math.random 不使用)
  demoTick(dt) {
    this.demoTimer += dt;
    if (this.demoTimer >= 0.8 && this.demoIdx < this.DEMO_TOWERS.length && this.gold >= TOWER_COST) {
      this.demoTimer = 0;
      const cell = this.DEMO_TOWERS[this.demoIdx++];
      this.placeTower(cell[0], cell[1]);
    }
  },

  tick(time, dtMs) {
    if (!this.ready) return;
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50);
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
    if (this.gameOver && !this.started) this.reset();
    // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
    if (!this.started) this.demoTick(dt);

    if (!this.gameOver) {
      // 1) スポーン
      this.spawnTimer += dt;
      while (this.spawnTimer >= SPAWN_INTERVAL) {
        this.spawnTimer -= SPAWN_INTERVAL;
        if (this.creeps.length < this.enemyCap) this.spawnCreep();
      }
      // 2) creep 経路追従
      for (let i = this.creeps.length - 1; i >= 0; i--) {
        const c = this.creeps[i];
        let remain = CREEP_SPEED * dt;
        while (remain > 0 && c.wp < c.path.length) {
          const wpx = this.cellCenterX(c.path[c.wp].tx), wpy = this.cellCenterY(c.path[c.wp].ty);
          const dx = wpx - c.x, dy = wpy - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= remain) { c.x = wpx; c.y = wpy; remain -= dist; c.wp++; }
          else { c.x += (dx / dist) * remain; c.y += (dy / dist) * remain; remain = 0; }
        }
        if (c.wp >= c.path.length) {
          this.lives -= 1;
          this.killCreep(i, false);
          if (this.lives <= 0) { this.lives = 0; this.gameOver = true; }
        }
      }
      // 3) タワー射撃
      for (const t of this.towers) {
        t.cd -= dt;
        if (t.cd > 0) continue;
        const tcx = this.cellCenterX(t.tx), tcy = this.cellCenterY(t.ty);
        let best = null, bestProgress = -1;
        for (const c of this.creeps) {
          const dx = c.x - tcx, dy = c.y - tcy;
          if (dx * dx + dy * dy > TOWER_RANGE * TOWER_RANGE) continue;
          if (c.wp > bestProgress) { bestProgress = c.wp; best = c; }
        }
        if (best) {
          const dx = best.x - tcx, dy = best.y - tcy;
          const d = Math.hypot(dx, dy) || 1;
          const s = this.getProjSprite();
          this.syncXY(s, tcx, tcy);
          this.projectiles.push({ x: tcx, y: tcy, vx: (dx / d) * PROJ_SPEED, vy: (dy / d) * PROJ_SPEED, sprite: s });
          t.cd = TOWER_FIRE_CD;
        }
      }
      // 4) 弾の直進 + 当たり判定
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const p = this.projectiles[i];
        p.x += p.vx * dt; p.y += p.vy * dt;
        let hit = false;
        if (p.x < -20 || p.x > VIEW_W + 20 || p.y < -20 || p.y > GRID_H * TILE + 20) {
          hit = true;
        } else {
          for (let j = 0; j < this.creeps.length; j++) {
            const c = this.creeps[j];
            const dx = c.x - p.x, dy = c.y - p.y, rr = CREEP_R + PROJ_R;
            if (dx * dx + dy * dy <= rr * rr) {
              c.hp -= PROJ_DMG; hit = true;
              if (c.hp <= 0) this.killCreep(j, true);
              break;
            }
          }
        }
        if (hit) {
          p.sprite.visible = false;
          this.projPool.push(p.sprite);
          this.projectiles[i] = this.projectiles[this.projectiles.length - 1]; this.projectiles.pop();
        }
      }
    } // !gameOver

    // 5) スプライト位置反映
    for (const c of this.creeps) this.syncXY(c.sprite, c.x, c.y);
    for (const p of this.projectiles) this.syncXY(p.sprite, p.x, p.y);
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const sp = this.sparks[i];
      sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.material.opacity = clamp(t, 0, 1);
      const sc = 16 * (1 + (1 - t) * 0.8);
      sp.sprite.scale.set(sc, sc, 1);
      if (sp.life <= 0) {
        sp.sprite.visible = false;
        this.sparkPool.push(sp.sprite);
        this.sparks[i] = this.sparks[this.sparks.length - 1]; this.sparks.pop();
      }
    }

    // 6) HUD
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const pathLen = this.currentPath ? this.currentPath.length : 0;
      this.hudEl.textContent =
        `FPS          : ${fpsAvg.toFixed(1)}\n` +
        `Enemies      : ${this.creeps.length} / ${this.enemyCap}   (+/- で増減, 上限 ${CAP_MAX})\n` +
        `Towers       : ${this.towers.length}   Projectiles : ${this.projectiles.length}\n` +
        `Path recalcs : ${this.pathRecalcs}   Path len : ${pathLen}\n` +
        `Gold : ${this.gold}   Lives : ${this.lives}   Score : ${this.score}` +
        (this.gameOver && this.started ? `\n--- GAME OVER ---  R で再開` : ``);
    }

    // タイトル点滅 (約0.45秒周期)
    if (!this.started && this.titleEl) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  },
});

console.log('[A-Frame 1.7.0] theme6 tower-defense component registered.');
