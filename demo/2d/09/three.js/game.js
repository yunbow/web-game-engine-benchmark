/* =========================================================================
 * テーマ9 アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― three.js r184
 * 仕様: ../SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *   - 960x540 / 64x64 タイルマップ（決定的生成・固定シード mulberry32）
 *   - アイソメ投影 TILE_W=64, TILE_H=32:
 *       screenX = (gx - gy) * 32
 *       screenY = (gx + gy) * 16
 *       depth   = gx + gy
 *   - 2層方式: 地面（ソート不要・カリングのみ）＋ オブジェクト/ユニット（深度ソート）
 *
 * ★ three.js の深度実現方法 = THREE.Sprite.renderOrder（毎フレーム depth 代入）:
 *   各オブジェクト/ユニットのマテリアルは depthTest:false。深度バッファに依らず
 *   sprite.renderOrder の昇順で描画される。リファレンスの depth=gx+gy を
 *   毎フレーム renderOrder へ代入することで、three.js のレンダラ内部ソートが
 *   そのまま「奥→手前」のアイソメ深度ソートになる（手動 sort は不要）。
 *   地面は高さ0で重ならないため renderOrder=0 固定（ソート対象外）。
 *
 * three.js は 3D 描画ライブラリ。2D 化:
 *   OrthographicCamera(0, W, H, 0, -1000, 1000)（1ワールド単位=1px・原点左下・Y上向き）。
 *   ゲームは画面座標（Y 下向き）で保持し、描画同期時に worldY = H - screenY。
 * ループ/入力/カリング/ユニット徘徊/プールはすべて自前。
 * =========================================================================*/

import * as THREE from 'three';

// ---- 定数 (SPEC) ----------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const MAP = 64;
const TILE_W = 64;
const TILE_H = 32;
const HW = TILE_W / 2;   // 32
const HH = TILE_H / 2;   // 16

const G_GRASS = 0, G_SOIL = 1, G_WATER = 2;
const O_NONE = 0, O_TREE = 1, O_HOUSE = 2;

const UNIT_INIT = 60;
const UNIT_STEP = 20;
const UNIT_MIN = 0;
const UNIT_MAX = 2000;
const UNIT_SPEED = 40 / TILE_W;
const UNIT_REACH = 0.25;

const CAM_SPEED = 420;

// renderOrder のベース帯。地面=0、オブジェクト/ユニットは depth(0..126) を載せる。
const RO_GROUND = 0;
const RO_OBJ_BASE = 1;   // 1 + (gx+gy)

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
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- アイソメ投影 ---------------------------------------------------------
const isoX = (gx, gy) => (gx - gy) * HW;
const isoY = (gx, gy) => (gx + gy) * HH;

// ---- マップ決定的生成（PixiJS リファレンスと同一シード/手順） -------------
function generateMap() {
  const rnd = mulberry32(20250609);
  const ground = new Uint8Array(MAP * MAP);
  const object = new Uint8Array(MAP * MAP);
  const idx = (x, y) => y * MAP + x;

  const N = 9;
  const noise = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) noise[i] = rnd();
  const sample = (fx, fy) => {
    const gx = fx / (MAP - 1) * (N - 1);
    const gy = fy / (MAP - 1) * (N - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, N - 1), y1 = Math.min(y0 + 1, N - 1);
    const tx = gx - x0, ty = gy - y0;
    const a = noise[y0 * N + x0], b = noise[y0 * N + x1];
    const c = noise[y1 * N + x0], d = noise[y1 * N + x1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };

  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const h = sample(x, y);
      let g = G_GRASS;
      if (h < 0.32) g = G_WATER;
      else if (h < 0.46) g = G_SOIL;
      ground[idx(x, y)] = g;
    }
  }

  const ornd = mulberry32(424242);
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const g = ground[idx(x, y)];
      if (g === G_WATER) continue;
      if (x < 1 || y < 1 || x >= MAP - 1 || y >= MAP - 1) continue;
      const r = ornd();
      if (g === G_GRASS && r < 0.14) object[idx(x, y)] = O_TREE;
      else if (g === G_SOIL && r < 0.10) object[idx(x, y)] = O_HOUSE;
      else if (g === G_GRASS && r < 0.17) object[idx(x, y)] = O_HOUSE;
    }
  }
  return { ground, object };
}

const groundAt = (m, gx, gy) => {
  if (gx < 0 || gy < 0 || gx >= MAP || gy >= MAP) return G_WATER;
  return m.ground[gy * MAP + gx];
};

// === シーン/カメラ/レンダラ ================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1422);
const camera = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);   // 性能比較のため DPR=1 固定
renderer.setSize(VIEW_W, VIEW_H);
document.getElementById('game-container').appendChild(renderer.domElement);

// === テクスチャ（画像 or canvas フォールバック菱形タイル等） ===============
const ASSET_DEFS = {
  tile_grass: '../assets/tile_grass.png',
  tile_soil:  '../assets/tile_soil.png',
  tile_water: '../assets/tile_water.png',
  tree:       '../assets/tree.png',
  house:      '../assets/house.png',
  villager:   '../assets/villager.png',
};
const loader = new THREE.TextureLoader();
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
// 菱形タイル（64x32）: 上(32,0) 右(64,16) 下(32,32) 左(0,16)
function diamondPath(g) { g.beginPath(); g.moveTo(HW, 0); g.lineTo(TILE_W, HH); g.lineTo(HW, TILE_H); g.lineTo(0, HH); g.closePath(); }
function fbGrass() { return canvasTexture('grass', TILE_W, TILE_H, (g) => { diamondPath(g); g.fillStyle = '#5aa83c'; g.fill(); g.strokeStyle = 'rgba(63,125,43,0.6)'; g.stroke(); }); }
function fbSoil()  { return canvasTexture('soil', TILE_W, TILE_H, (g) => { diamondPath(g); g.fillStyle = '#a9743f'; g.fill(); g.strokeStyle = 'rgba(125,84,48,0.6)'; g.stroke(); g.strokeStyle = 'rgba(125,84,48,0.5)'; g.beginPath(); g.moveTo(16, 12); g.lineTo(48, 28); g.moveTo(16, 20); g.lineTo(48, 4); g.stroke(); }); }
function fbWater() { return canvasTexture('water', TILE_W, TILE_H, (g) => { diamondPath(g); g.fillStyle = '#2f7fd6'; g.fill(); g.strokeStyle = 'rgba(33,95,158,0.6)'; g.stroke(); }); }
// 木 48x64（足元=下端中央）
function fbTree()  { return canvasTexture('tree', 48, 64, (g) => { g.fillStyle = '#6e4a26'; g.fillRect(21, 40, 6, 22); g.fillStyle = '#2f7a35'; g.beginPath(); g.arc(24, 30, 16, 0, 7); g.fill(); g.beginPath(); g.arc(16, 38, 10, 0, 7); g.fill(); g.beginPath(); g.arc(32, 38, 10, 0, 7); g.fill(); }); }
// 家 64x64（足元菱形中心 baseY=56）
function fbHouse() { return canvasTexture('house', 64, 64, (g) => {
  const cx = 32, baseY = 56, wall = 22;
  g.fillStyle = '#7d8389'; g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx + HW, baseY - HH); g.lineTo(cx + HW, baseY - HH - wall); g.lineTo(cx, baseY - wall); g.closePath(); g.fill();
  g.fillStyle = '#b0b6bd'; g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx - HW, baseY - HH); g.lineTo(cx - HW, baseY - HH - wall); g.lineTo(cx, baseY - wall); g.closePath(); g.fill();
  const ry = baseY - HH - wall; g.fillStyle = '#c0503a';
  g.beginPath(); g.moveTo(cx, ry - 8); g.lineTo(cx + HW, ry - HH + 2); g.lineTo(cx, ry - HH * 2 + 12); g.lineTo(cx - HW, ry - HH + 2); g.closePath(); g.fill();
}); }
// ユニット 24x32（足元下端中央）
function fbUnit()  { return canvasTexture('unit', 24, 32, (g) => {
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.ellipse(12, 30, 7, 3, 0, 0, 7); g.fill();
  g.fillStyle = '#ff8a3c'; g.fillRect(7, 14, 10, 14);
  g.fillStyle = '#ffd9b0'; g.beginPath(); g.arc(12, 9, 6, 0, 7); g.fill();
}); }

// スプライト生成（足元基準 = 下端中央へアンカー）。center=(0.5, 0) で下端基準。
function makeSprite(texture, w, h, ro) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.center.set(0.5, 0);    // 下端中央を position に合わせる（足元基準）
  s.scale.set(w, h, 1);
  s.renderOrder = ro;
  return s;
}

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { const t = await loader.loadAsync(url); t.colorSpace = THREE.SRGBColorSpace; tex[key] = t; }
    catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  let map = generateMap();

  const tileTex = {
    [G_GRASS]: tex.tile_grass || fbGrass(),
    [G_SOIL]:  tex.tile_soil  || fbSoil(),
    [G_WATER]: tex.tile_water || fbWater(),
  };
  const treeTex = tex.tree || fbTree();
  const houseTex = tex.house || fbHouse();
  const unitTex = tex.villager || fbUnit();
  const unitAnimated = !!(unitTex.image && unitTex.image.width >= 96 && unitTex.image.height >= 128);

  function makeUnitTexture() {
    const t = unitTex.clone();
    if (unitAnimated) t.repeat.set(1 / 4, 1 / 4);
    t.needsUpdate = true;
    return t;
  }

  function setUnitFrame(sprite, face, animT) {
    if (!sprite.userData.animated) return;
    const frame = Math.floor((animT || 0) * 8) % 4;
    sprite.material.map.offset.set(frame / 4, (3 - (face || 0)) / 4);
  }

  // ---- 地面スプライトプール ----
  const GROUND_POOL = 2200;
  const groundPool = [];
  for (let i = 0; i < GROUND_POOL; i++) {
    // 地面は上頂点基準。center=(0.5,1) で上端中央へ。
    const mat = new THREE.SpriteMaterial({ map: tileTex[G_GRASS], transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.center.set(0.5, 1);
    s.scale.set(TILE_W, TILE_H, 1);
    s.renderOrder = RO_GROUND;
    s.visible = false;
    groundPool.push(s);
    scene.add(s);
  }

  // ---- オブジェクト/ユニット スプライトプール ----
  // 木/家は texture を張り替えて再利用。ユニットは専用プール。
  const objPool = [];
  const unitSpritePool = [];
  function getObjSprite() {
    let s = objPool.pop();
    if (!s) { s = makeSprite(treeTex, 48, 64, RO_OBJ_BASE); scene.add(s); }
    s.visible = true; return s;
  }
  function getUnitSprite() {
    let s = unitSpritePool.pop();
    if (!s) {
      s = makeSprite(makeUnitTexture(), 24, 32, RO_OBJ_BASE);
      s.userData.animated = unitAnimated;
      scene.add(s);
    }
    s.visible = true; return s;
  }
  const releaseObj = (s) => { s.visible = false; objPool.push(s); };

  const objActive = [];

  function unitFaceFromMove(dx, dy, current = 0) {
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
    const sx = dx - dy;
    const sy = dx + dy;
    if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
    return sy < 0 ? 1 : 0;
  }

  // ---- 静的オブジェクト ----
  let staticObjs = [];
  function buildStaticObjs() {
    staticObjs = [];
    for (let gy = 0; gy < MAP; gy++) {
      for (let gx = 0; gx < MAP; gx++) {
        const o = map.object[gy * MAP + gx];
        if (o === O_NONE) continue;
        staticObjs.push({ gx, gy, type: o });
      }
    }
  }
  buildStaticObjs();

  // ---- ユニット ----
  const units = [];
  let unitSet = 0;
  function pickLandTarget(rng) {
    for (let k = 0; k < 12; k++) {
      const x = 1 + Math.floor(rng() * (MAP - 2));
      const y = 1 + Math.floor(rng() * (MAP - 2));
      if (groundAt(map, x, y) !== G_WATER) return { x: x + 0.5, y: y + 0.5 };
    }
    return { x: MAP / 2, y: MAP / 2 };
  }
  function spawnUnit() {
    const rng = mulberry32(0x1000 + units.length * 2654435761 >>> 0);
    const start0 = pickLandTarget(rng);
    const tgt = pickLandTarget(rng);
    units.push({ gx: start0.x, gy: start0.y, tx: tgt.x, ty: tgt.y, rng, face: 0, animT: 0, sprite: getUnitSprite() });
  }
  function setUnitCount(n) {
    n = clamp(n, UNIT_MIN, UNIT_MAX);
    while (units.length < n) spawnUnit();
    while (units.length > n) {
      const u = units.pop();
      u.sprite.visible = false; unitSpritePool.push(u.sprite);
    }
    unitSet = n;
  }

  // ---- カメラ（ワールド画面座標オフセット） ----
  const camMinX = -(MAP - 1) * HW + VIEW_W / 2;
  const camMaxX =  (MAP - 1) * HW - VIEW_W / 2;
  const camMinY = 0 + VIEW_H / 2;
  const camMaxY = (2 * MAP - 2) * HH - VIEW_H / 2;
  const cam = { x: 0, y: MAP * HH };
  function clampCam() {
    cam.x = (camMinX > camMaxX) ? (camMinX + camMaxX) / 2 : clamp(cam.x, camMinX, camMaxX);
    cam.y = (camMinY > camMaxY) ? (camMinY + camMaxY) / 2 : clamp(cam.y, camMinY, camMaxY);
  }
  clampCam();

  function reset() {
    map = generateMap();
    tileTex[G_GRASS] = tex.tile_grass || fbGrass();
    tileTex[G_SOIL] = tex.tile_soil || fbSoil();
    tileTex[G_WATER] = tex.tile_water || fbWater();
    buildStaticObjs();
    setUnitCount(UNIT_INIT);
    cam.x = 0; cam.y = MAP * HH; clampCam();
  }
  setUnitCount(UNIT_INIT);

  // ---- グリッド（任意） ----
  const gridMat = new THREE.LineBasicMaterial({ color: 0x2a3550, transparent: true, opacity: 0.6, depthTest: false });
  const gridGeo = new THREE.BufferGeometry();
  const grid = new THREE.LineSegments(gridGeo, gridMat);
  grid.renderOrder = RO_GROUND + 0.5;
  grid.visible = false;
  scene.add(grid);

  // ---- 入力 ----
  const keys = {};
  let showGrid = false;
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { setUnitCount(unitSet + UNIT_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { setUnitCount(unitSet - UNIT_STEP); e.preventDefault(); }
    else if (e.code === 'KeyG') { showGrid = !showGrid; grid.visible = showGrid; }
    else if (e.code === 'KeyR') { reset(); }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = [];
  let hudTimer = 0;
  let tilesDrawn = 0, objectsSorted = 0;

  // 逆投影
  const invX = (wx, wy) => (wx / HW + wy / HH) / 2;
  const invY = (wx, wy) => (wy / HH - wx / HW) / 2;

  // ワールド→画面（three.js: worldY = H - screenY で上下反転）
  // offX/offY はワールド原点(0,0) の画面位置
  let offX = 0, offY = 0;
  const toWorldX = (sx) => offX + sx;
  const toWorldY = (sy) => VIEW_H - (offY + sy);

  function rebuildGrid(minGX, maxGX, minGY, maxGY) {
    const verts = [];
    for (let gx = minGX; gx <= maxGX; gx++) {
      verts.push(toWorldX(isoX(gx, minGY)), toWorldY(isoY(gx, minGY)), 0,
                 toWorldX(isoX(gx, maxGY)), toWorldY(isoY(gx, maxGY)), 0);
    }
    for (let gy = minGY; gy <= maxGY; gy++) {
      verts.push(toWorldX(isoX(minGX, gy)), toWorldY(isoY(minGX, gy)), 0,
                 toWorldX(isoX(maxGX, gy)), toWorldY(isoY(maxGX, gy)), 0);
    }
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    gridGeo.attributes.position.needsUpdate = true;
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();

    // 1) カメラスクロール
    let dx = 0, dy = 0;
    if (down('ArrowLeft', 'KeyA')) dx -= 1;
    if (down('ArrowRight', 'KeyD')) dx += 1;
    if (down('ArrowUp', 'KeyW')) dy -= 1;
    if (down('ArrowDown', 'KeyS')) dy += 1;
    cam.x += dx * CAM_SPEED * dt;
    cam.y += dy * CAM_SPEED * dt;
    clampCam();
    offX = Math.round(VIEW_W / 2 - cam.x);
    offY = Math.round(VIEW_H / 2 - cam.y);

    // 2) ユニット更新
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const bx = u.gx, by = u.gy;
      const ddx = u.tx - u.gx, ddy = u.ty - u.gy;
      const dist = Math.hypot(ddx, ddy);
      if (dist < UNIT_REACH) { const t = pickLandTarget(u.rng); u.tx = t.x; u.ty = t.y; }
      else {
        const step = UNIT_SPEED * dt;
        const nx = u.gx + (ddx / dist) * step;
        const ny = u.gy + (ddy / dist) * step;
        if (groundAt(map, Math.floor(nx), Math.floor(ny)) === G_WATER) { const t = pickLandTarget(u.rng); u.tx = t.x; u.ty = t.y; }
        else { u.gx = nx; u.gy = ny; }
      }
      const mdx = u.gx - bx, mdy = u.gy - by;
      const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
      u.face = unitFaceFromMove(mdx, mdy, u.face);
      u.animT = moving ? (u.animT || 0) + dt : 0;
    }

    // 3) 可視範囲（カリング）
    const wl = -offX, wt = -offY, wr = wl + VIEW_W, wb = wt + VIEW_H;
    const PAD_TOP = 5, PAD = 2;
    const corners = [
      [invX(wl, wt), invY(wl, wt)], [invX(wr, wt), invY(wr, wt)],
      [invX(wl, wb), invY(wl, wb)], [invX(wr, wb), invY(wr, wb)],
    ];
    let minGX = Infinity, maxGX = -Infinity, minGY = Infinity, maxGY = -Infinity;
    for (const [cx, cy] of corners) {
      if (cx < minGX) minGX = cx; if (cx > maxGX) maxGX = cx;
      if (cy < minGY) minGY = cy; if (cy > maxGY) maxGY = cy;
    }
    minGX = clamp(Math.floor(minGX) - PAD, 0, MAP - 1);
    maxGX = clamp(Math.ceil(maxGX) + PAD, 0, MAP - 1);
    minGY = clamp(Math.floor(minGY) - PAD_TOP, 0, MAP - 1);
    maxGY = clamp(Math.ceil(maxGY) + PAD, 0, MAP - 1);

    // 4) 地面カリング描画（renderOrder=0 固定・ソート不要）
    tilesDrawn = 0;
    let gi = 0;
    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        if (gi >= groundPool.length) break;
        const type = map.ground[gy * MAP + gx];
        const s = groundPool[gi++];
        s.material.map = tileTex[type];
        s.position.set(toWorldX(isoX(gx, gy)), toWorldY(isoY(gx, gy)), 0);
        s.visible = true;
        tilesDrawn++;
      }
    }
    for (let k = gi; k < groundPool.length; k++) groundPool[k].visible = false;

    // 5) オブジェクト/ユニット → 可視ぶんへ割当 + ★ renderOrder = 1 + (gx+gy)
    objectsSorted = 0;
    let oi = 0;
    for (let i = 0; i < staticObjs.length; i++) {
      const o = staticObjs[i];
      if (o.gx < minGX || o.gx > maxGX || o.gy < minGY || o.gy > maxGY) continue;
      let s = objActive[oi];
      if (!s) { s = getObjSprite(); objActive[oi] = s; }
      if (o.type === O_TREE) { s.material.map = treeTex; s.scale.set(48, 64, 1); }
      else { s.material.map = houseTex; s.scale.set(64, 64, 1); }
      // 足元（菱形中心）に置く: isoY は上頂点なので画面で +HH（worldY では -HH）
      s.position.set(toWorldX(isoX(o.gx, o.gy)), toWorldY(isoY(o.gx, o.gy) + HH), 0);
      // ★ 深度キー = gx + gy を renderOrder へ。depthTest:false なので描画順を支配。
      s.renderOrder = RO_OBJ_BASE + (o.gx + o.gy);
      s.visible = true;
      oi++; objectsSorted++;
    }
    for (let k = oi; k < objActive.length; k++) { releaseObj(objActive[k]); objActive[k] = null; }
    objActive.length = oi;

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const s = u.sprite;
      const vis = (u.gx >= minGX && u.gx <= maxGX && u.gy >= minGY && u.gy <= maxGY);
      if (!vis) { s.visible = false; continue; }
      setUnitFrame(s, u.face, u.animT);
      s.scale.set(24, 32, 1);
      s.position.set(toWorldX(isoX(u.gx, u.gy)), toWorldY(isoY(u.gx, u.gy) + HH), 0);
      // ★ 連続座標の深度キー（毎フレーム変化）を renderOrder へ。
      s.renderOrder = RO_OBJ_BASE + (u.gx + u.gy);
      s.visible = true;
      objectsSorted++;
    }

    if (showGrid) rebuildGrid(minGX, maxGX, minGY, maxGY);

    // 6) HUD
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
      const cgx = invX(cam.x, cam.y), cgy = invY(cam.x, cam.y);
      hudEl.textContent =
        `FPS           : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn   : ${tilesDrawn}\n` +
        `Objects sorted: ${objectsSorted}\n` +
        `Units         : ${units.length} / ${unitSet}\n` +
        `Camera (gx,gy): (${cgx.toFixed(1)}, ${cgy.toFixed(1)})\n` +
        `矢印/WASD=スクロール  +/-=ユニット数  G=グリッド  R=リセット`;
    }

    renderer.render(scene, camera);
  });

  console.log('[three.js r184] theme9 isometric init ok. renderOrder=gx+gy depth sort.');
}
