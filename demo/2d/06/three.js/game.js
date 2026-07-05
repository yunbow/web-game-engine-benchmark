/* ============================================================================
 * テーマ6 タワーディフェンス（経路探索 × 多数ユニット追従）― three.js (r184) 実装
 * 共通仕様 SPEC.md / 基準実装 PixiJS に厳密準拠。性能比較用。
 *
 * 本テーマの主軸は CPU 側 AI ロジック:
 *   - グリッド A* 経路探索 (4方向 / コスト1 / マンハッタン距離) ← 自前実装
 *   - 多数ユニット (creep) の経路追従更新
 *   - タワー射撃 (射程内の最進行度敵を狙い projectile 発射)
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0, -1000, 1000) で 1ワールド単位=1px・原点左下・Y上向き。
 *   - ゲームロジックは画面座標 (Y 下向き, 他エンジンと同一定数) のまま保持し、
 *     描画同期時のみ worldY = H - gameY に変換する。
 *   - スプライトは THREE.Sprite + renderOrder (depthTest:false)。
 *   - グリッドタイルは「プールした Sprite」で描く (数千 entity を作らない)。
 *   - 経路探索・追従・弾の直進・距離判定はすべて自前 (組み込み経路探索は使わない)。
 * ========================================================================== */

import * as THREE from 'three';

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
// renderOrder レイヤ: タイル < 経路 < base < タワー < creep < 弾 < fx
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

// === シーン / カメラ / レンダラ =============================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14181f);
const camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);   // 性能比較のため DPR=1 固定
renderer.setSize(W, H);
document.getElementById('game-container').appendChild(renderer.domElement);

// === テクスチャ (画像 or canvas フォールバック) =============================
const tex = {};
const fbCache = {};
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  fbCache[name] = t;
  return t;
}
const fb = {
  // 通路 = 濃灰 / 壁 = 灰 / 敵 = 赤丸 / タワー = 青矩形 / 弾 = 黄丸 / ゴール = 緑 / spark = 白丸
  tile_path:  () => canvasTexture('tp', TILE, TILE, (g) => { g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, TILE, TILE); g.strokeStyle = 'rgba(58,65,80,0.7)'; g.strokeRect(0.5, 0.5, TILE - 1, TILE - 1); }),
  tile_wall:  () => canvasTexture('tw', TILE, TILE, (g) => { g.fillStyle = '#6b7280'; g.fillRect(0, 0, TILE, TILE); g.strokeStyle = '#4a505c'; g.lineWidth = 2; g.strokeRect(1, 1, TILE - 2, TILE - 2); }),
  creep:      () => canvasTexture('cr', 24, 24, (g) => { g.fillStyle = '#e2402e'; g.beginPath(); g.arc(12, 12, 10, 0, 7); g.fill(); g.strokeStyle = '#8a1810'; g.lineWidth = 2; g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.arc(8, 9, 2.4, 0, 7); g.fill(); g.beginPath(); g.arc(16, 9, 2.4, 0, 7); g.fill(); }),
  tower:      () => canvasTexture('to', TILE, TILE, (g) => { g.fillStyle = '#3f7fd8'; g.fillRect(4, 4, TILE - 8, TILE - 8); g.strokeStyle = '#1c4e9c'; g.lineWidth = 2; g.strokeRect(4, 4, TILE - 8, TILE - 8); g.fillStyle = '#cfe2ff'; g.beginPath(); g.arc(16, 16, 5, 0, 7); g.fill(); }),
  projectile: () => canvasTexture('pj', 12, 12, (g) => { g.fillStyle = '#f2d33c'; g.beginPath(); g.arc(6, 6, 5, 0, 7); g.fill(); }),
  base:       () => canvasTexture('ba', TILE, TILE, (g) => { g.fillStyle = 'rgba(63,196,99,0.25)'; g.fillRect(0, 0, TILE, TILE); g.fillStyle = '#dfeee0'; g.fillRect(8, 4, 2, 24); g.fillStyle = '#3fc463'; g.beginPath(); g.moveTo(10, 5); g.lineTo(26, 9); g.lineTo(10, 14); g.closePath(); g.fill(); }),
  hit_spark:  () => canvasTexture('hs', 16, 16, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(8, 8, 6, 0, 7); g.fill(); }),
};
function texOf(key) { return tex[key] || fb[key](); }

function makeSprite(key, w, h, renderOrder) {
  const mat = new THREE.SpriteMaterial({ map: texOf(key), transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  return s;
}
// THREE.Sprite は中心アンカー。タイル左上 (tx*TILE,ty*TILE) を中心へ変換。
function setTileSprite(s, tx, ty) {
  s.position.set(tx * TILE + TILE / 2, H - (ty * TILE + TILE / 2), 0);
}

(async function main() {
  const loader = new THREE.TextureLoader();
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      const t = await loader.loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      tex[key] = t;
    } catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  const cellCenterX = (tx) => tx * TILE + TILE / 2;
  const cellCenterY = (ty) => ty * TILE + TILE / 2;

  // ---- 固定タイル群 (プールした Sprite。最大 510 枚を再利用) ----
  const tileSprites = [];
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const s = makeSprite('tile_path', TILE, TILE, RO.tile);
    scene.add(s);
    tileSprites.push(s);
  }
  // ゴール (base)
  const baseSprite = makeSprite('base', TILE, TILE, RO.base);
  setTileSprite(baseSprite, GOAL_TX, GOAL_TY);
  scene.add(baseSprite);

  // ---- 経路ハイライト (薄い矩形 Mesh 群。経路更新時のみ再構築) ----
  // タイル中心を結ぶ線は LineSegments、セル塗りは半透明 Plane を流用。
  const pathGroup = new THREE.Group();
  pathGroup.renderOrder = RO.path;
  scene.add(pathGroup);
  const pathMat = new THREE.MeshBasicMaterial({ color: 0x5fa8ff, transparent: true, opacity: 0.10, depthTest: false });
  let lineObj = null;
  function clearPathGfx() {
    while (pathGroup.children.length) {
      const o = pathGroup.children.pop();
      if (o.geometry) o.geometry.dispose();
    }
    lineObj = null;
  }
  function redrawPath() {
    clearPathGfx();
    if (!currentPath || currentPath.length === 0) return;
    for (const c of currentPath) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(TILE - 8, TILE - 8), pathMat);
      m.position.set(c.tx * TILE + TILE / 2, H - (c.ty * TILE + TILE / 2), 0);
      m.renderOrder = RO.path;
      pathGroup.add(m);
    }
    const pts = [];
    for (const c of currentPath) pts.push(new THREE.Vector3(cellCenterX(c.tx), H - cellCenterY(c.ty), 0));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    lineObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x5fa8ff, transparent: true, opacity: 0.35, depthTest: false }));
    lineObj.renderOrder = RO.path;
    pathGroup.add(lineObj);
  }

  function refreshTiles() {
    for (let ty = 0; ty < GRID_H; ty++) {
      for (let tx = 0; tx < GRID_W; tx++) {
        const s = tileSprites[idx(tx, ty)];
        s.material.map = texOf(map[idx(tx, ty)] === T_WALL ? 'tile_wall' : 'tile_path');
        s.material.needsUpdate = true;
        setTileSprite(s, tx, ty);
      }
    }
  }

  // =====================================================================
  // ゲーム状態
  // =====================================================================
  let map, towers, towerBlocked, creeps, projectiles, sparks;
  let currentPath, pathRecalcs, gold, lives, score, enemyCap, spawnTimer, gameOver;

  // ---- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ----
  let started = false, blinkT = 0;
  const DEMO_TOWERS = [
    [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
    [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
  ];
  let demoIdx = 0, demoTimer = 0;
  const titleEl = document.getElementById('title');
  function startGame() { started = true; reset(); titleEl.style.display = 'none'; }
  function demoTick(dt) {
    demoTimer += dt;
    if (demoTimer >= 0.8 && demoIdx < DEMO_TOWERS.length && gold >= TOWER_COST) {
      demoTimer = 0;
      const [tx, ty] = DEMO_TOWERS[demoIdx++];
      placeTower(tx, ty);
    }
  }

  const creepPool = [], projPool = [], sparkPool = [];
  const towerSprites = []; // {tx,ty,sprite}

  function getCreepSprite() {
    let s = creepPool.pop();
    if (!s) { s = makeSprite('creep', 24, 24, RO.creep); scene.add(s); }
    s.visible = true; s.material.opacity = 1;
    return s;
  }
  function getProjSprite() {
    let s = projPool.pop();
    if (!s) { s = makeSprite('projectile', 12, 12, RO.proj); scene.add(s); }
    s.visible = true;
    return s;
  }
  function getSparkSprite() {
    let s = sparkPool.pop();
    if (!s) { s = makeSprite('hit_spark', 16, 16, RO.fx); scene.add(s); }
    s.visible = true; s.material.opacity = 1; s.scale.set(16, 16, 1);
    return s;
  }
  // creep/proj は中心が x,y。spark も。画面座標 → world に変換して反映。
  const syncXY = (s, x, y) => s.position.set(x, H - y, 0);

  function computePath() { return aStar(map, START_TX, START_TY, GOAL_TX, GOAL_TY, towerBlocked); }

  function repathCreep(c) {
    const ctx = clamp(Math.floor(c.x / TILE), 0, GRID_W - 1);
    const cty = clamp(Math.floor(c.y / TILE), 0, GRID_H - 1);
    const p = aStar(map, ctx, cty, GOAL_TX, GOAL_TY, towerBlocked);
    pathRecalcs++;
    if (p && p.length > 0) { c.path = p; c.wp = p.length > 1 ? 1 : 0; }
  }

  function spawnCreep() {
    if (!currentPath || currentPath.length === 0) return;
    const s = getCreepSprite();
    creeps.push({ x: cellCenterX(START_TX), y: cellCenterY(START_TY), hp: CREEP_HP, maxHp: CREEP_HP,
      path: currentPath, wp: currentPath.length > 1 ? 1 : 0, sprite: s });
  }

  function killCreep(i, byTower) {
    const c = creeps[i];
    c.sprite.visible = false;
    creepPool.push(c.sprite);
    creeps[i] = creeps[creeps.length - 1]; creeps.pop();
    if (byTower) { gold += GOLD_KILL; score += SCORE_KILL; spawnSpark(c.x, c.y); }
  }

  function spawnSpark(x, y) {
    const s = getSparkSprite();
    syncXY(s, x, y);
    sparks.push({ x, y, life: 0.3, max: 0.3, sprite: s });
  }

  function placeTower(tx, ty) {
    if (gameOver) return false;
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
    if (map[idx(tx, ty)] === T_WALL) return false;
    if (towerBlocked.has(idx(tx, ty))) return false;
    if ((tx === START_TX && ty === START_TY) || (tx === GOAL_TX && ty === GOAL_TY)) return false;
    if (gold < TOWER_COST) return false;

    towerBlocked.add(idx(tx, ty));
    const newPath = computePath();
    if (!newPath) { towerBlocked.delete(idx(tx, ty)); return false; }

    gold -= TOWER_COST;
    const s = makeSprite('tower', TILE, TILE, RO.tower);
    setTileSprite(s, tx, ty);
    scene.add(s);
    towers.push({ tx, ty, cd: 0 });
    towerSprites.push({ tx, ty, sprite: s });

    currentPath = newPath;
    pathRecalcs++;
    redrawPath();
    for (const c of creeps) repathCreep(c);
    return true;
  }

  function removeTower(tx, ty) {
    const i = towers.findIndex((t) => t.tx === tx && t.ty === ty);
    if (i < 0) return false;
    towers.splice(i, 1);
    const si = towerSprites.findIndex((t) => t.tx === tx && t.ty === ty);
    if (si >= 0) {
      const o = towerSprites[si];
      scene.remove(o.sprite); o.sprite.material.dispose();
      towerSprites.splice(si, 1);
    }
    towerBlocked.delete(idx(tx, ty));
    currentPath = computePath();
    pathRecalcs++;
    redrawPath();
    for (const c of creeps) repathCreep(c);
    return true;
  }

  // =====================================================================
  // 初期化 / リスタート
  // =====================================================================
  function reset() {
    if (creeps) for (const c of creeps) { c.sprite.visible = false; creepPool.push(c.sprite); }
    if (projectiles) for (const p of projectiles) { p.sprite.visible = false; projPool.push(p.sprite); }
    if (sparks) for (const sp of sparks) { sp.sprite.visible = false; sparkPool.push(sp.sprite); }
    for (const t of towerSprites) { scene.remove(t.sprite); t.sprite.material.dispose(); }
    towerSprites.length = 0;

    map = generateMap();
    refreshTiles();
    towers = []; towerBlocked = new Set(); creeps = []; projectiles = []; sparks = [];
    pathRecalcs = 0; gold = GOLD_INIT; lives = LIVES_INIT; score = 0;
    enemyCap = CAP_INIT; spawnTimer = 0; gameOver = false;
    demoIdx = 0; demoTimer = 0;   // デモAIの自動配置進捗もリセット
    currentPath = computePath();
    pathRecalcs++;
    redrawPath();
  }
  reset();

  // =====================================================================
  // 入力
  // =====================================================================
  const canvas = renderer.domElement;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  function eventToTile(event) {
    const rect = canvas.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    const px = (event.clientX - rect.left) * sx;
    const py = (event.clientY - rect.top) * sy;
    return { tx: Math.floor(px / TILE), ty: Math.floor(py / TILE) };
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (!started) return;   // アトラクト中はプレイヤー操作を無効化
    const { tx, ty } = eventToTile(event);
    if (event.button === 0) placeTower(tx, ty);
    else if (event.button === 2) removeTower(tx, ty);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { enemyCap = clamp(enemyCap + CAP_STEP, CAP_MIN, CAP_MAX); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { enemyCap = clamp(enemyCap - CAP_STEP, CAP_MIN, CAP_MAX); e.preventDefault(); }
    else if (e.code === 'KeyR') reset();
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (!started) startGame(); }
  });

  // =====================================================================
  // メインループ
  // =====================================================================
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const dtMs = dt * 1000;
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
    if (gameOver && !started) reset();
    // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
    if (!started) demoTick(dt);

    if (!gameOver) {
      // 1) スポーン
      spawnTimer += dt;
      while (spawnTimer >= SPAWN_INTERVAL) {
        spawnTimer -= SPAWN_INTERVAL;
        if (creeps.length < enemyCap) spawnCreep();
      }
      // 2) creep 経路追従
      for (let i = creeps.length - 1; i >= 0; i--) {
        const c = creeps[i];
        let remain = CREEP_SPEED * dt;
        while (remain > 0 && c.wp < c.path.length) {
          const wpx = cellCenterX(c.path[c.wp].tx), wpy = cellCenterY(c.path[c.wp].ty);
          const dx = wpx - c.x, dy = wpy - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= remain) { c.x = wpx; c.y = wpy; remain -= dist; c.wp++; }
          else { c.x += (dx / dist) * remain; c.y += (dy / dist) * remain; remain = 0; }
        }
        if (c.wp >= c.path.length) {
          lives -= 1;
          killCreep(i, false);
          if (lives <= 0) { lives = 0; gameOver = true; }
        }
      }
      // 3) タワー射撃
      for (const t of towers) {
        t.cd -= dt;
        if (t.cd > 0) continue;
        const tcx = cellCenterX(t.tx), tcy = cellCenterY(t.ty);
        let best = null, bestProgress = -1;
        for (const c of creeps) {
          const dx = c.x - tcx, dy = c.y - tcy;
          if (dx * dx + dy * dy > TOWER_RANGE * TOWER_RANGE) continue;
          if (c.wp > bestProgress) { bestProgress = c.wp; best = c; }
        }
        if (best) {
          const dx = best.x - tcx, dy = best.y - tcy;
          const d = Math.hypot(dx, dy) || 1;
          const s = getProjSprite();
          syncXY(s, tcx, tcy);
          projectiles.push({ x: tcx, y: tcy, vx: (dx / d) * PROJ_SPEED, vy: (dy / d) * PROJ_SPEED, sprite: s });
          t.cd = TOWER_FIRE_CD;
        }
      }
      // 4) 弾の直進 + 当たり判定
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.x += p.vx * dt; p.y += p.vy * dt;
        let hit = false;
        if (p.x < -20 || p.x > VIEW_W + 20 || p.y < -20 || p.y > GRID_H * TILE + 20) {
          hit = true;
        } else {
          for (let j = 0; j < creeps.length; j++) {
            const c = creeps[j];
            const dx = c.x - p.x, dy = c.y - p.y, rr = CREEP_R + PROJ_R;
            if (dx * dx + dy * dy <= rr * rr) {
              c.hp -= PROJ_DMG; hit = true;
              if (c.hp <= 0) killCreep(j, true);
              break;
            }
          }
        }
        if (hit) {
          p.sprite.visible = false;
          projPool.push(p.sprite);
          projectiles[i] = projectiles[projectiles.length - 1]; projectiles.pop();
        }
      }
    } // !gameOver

    // 5) スプライト位置反映
    for (const c of creeps) syncXY(c.sprite, c.x, c.y);
    for (const p of projectiles) syncXY(p.sprite, p.x, p.y);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.material.opacity = clamp(t, 0, 1);
      const sc = 16 * (1 + (1 - t) * 0.8);
      sp.sprite.scale.set(sc, sc, 1);
      if (sp.life <= 0) {
        sp.sprite.visible = false;
        sparkPool.push(sp.sprite);
        sparks[i] = sparks[sparks.length - 1]; sparks.pop();
      }
    }

    // 6) HUD
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const pathLen = currentPath ? currentPath.length : 0;
      hudEl.textContent =
        `FPS          : ${fpsAvg.toFixed(1)}\n` +
        `Enemies      : ${creeps.length} / ${enemyCap}   (+/- で増減, 上限 ${CAP_MAX})\n` +
        `Towers       : ${towers.length}   Projectiles : ${projectiles.length}\n` +
        `Path recalcs : ${pathRecalcs}   Path len : ${pathLen}\n` +
        `Gold : ${gold}   Lives : ${lives}   Score : ${score}` +
        (gameOver && started ? `\n--- GAME OVER ---  R で再開` : ``);
    }

    // タイトル点滅 (約0.45秒周期)
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }

    renderer.render(scene, camera);
  });

  console.log('[three.js r184] theme6 tower-defense started.');
}
