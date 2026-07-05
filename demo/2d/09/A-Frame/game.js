/* =========================================================================
 * テーマ9 アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― A-Frame 1.7.0
 * 仕様: ../SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *   - 960x540 / 64x64 タイルマップ（決定的生成・固定シード mulberry32）
 *   - アイソメ投影 TILE_W=64, TILE_H=32:
 *       screenX = (gx - gy) * 32 / screenY = (gx + gy) * 16 / depth = gx + gy
 *   - 2層方式: 地面（ソート不要・カリングのみ）＋ オブジェクト/ユニット（深度ソート）
 *
 * ★ A-Frame の深度実現方法 = THREE.Sprite.renderOrder（毎フレーム depth 代入）:
 *   A-Frame は three.js 上の宣言的フレームワーク。three.js 版と同じく
 *   各オブジェクト/ユニットを THREE.Sprite（depthTest:false）で表現し、
 *   登録コンポーネント iso-game の tick 内で sprite.renderOrder = gx+gy を
 *   毎フレーム代入する。A-Frame 内蔵レンダラが renderOrder 昇順で描画する。
 *   地面は renderOrder=0 固定（ソート対象外）。
 *
 * 設計判断: タイル/ユニットは数百〜数千規模になり得る。「1 タイル = 1 <a-entity>」は
 *   DOM/コンポーネント生成コストで破綻するため、動的描画はコンポーネント内で
 *   THREE.Sprite を直接生成・プール管理する（this.el.object3D に add）。
 *   2D 用に sceneEl.camera を OrthographicCamera へ差し替え、tick で維持する。
 * =========================================================================*/

const THREE = AFRAME.THREE;

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

const RO_GROUND = 0;
const RO_OBJ_BASE = 1;

const ASSET_DEFS = {
  tile_grass: '../assets/tile_grass.png',
  tile_soil:  '../assets/tile_soil.png',
  tile_water: '../assets/tile_water.png',
  tree:       '../assets/tree.png',
  house:      '../assets/house.png',
  villager:   '../assets/villager.png',
};

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

const isoX = (gx, gy) => (gx - gy) * HW;
const isoY = (gx, gy) => (gx + gy) * HH;

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

// ---- canvas → CanvasTexture フォールバック --------------------------------
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
function diamondPath(g) { g.beginPath(); g.moveTo(HW, 0); g.lineTo(TILE_W, HH); g.lineTo(HW, TILE_H); g.lineTo(0, HH); g.closePath(); }
const fb = {
  tile_grass: () => canvasTexture('grass', TILE_W, TILE_H, (g) => { diamondPath(g); g.fillStyle = '#5aa83c'; g.fill(); g.strokeStyle = 'rgba(63,125,43,0.6)'; g.stroke(); }),
  tile_soil:  () => canvasTexture('soil', TILE_W, TILE_H, (g) => { diamondPath(g); g.fillStyle = '#a9743f'; g.fill(); g.strokeStyle = 'rgba(125,84,48,0.6)'; g.stroke(); g.strokeStyle = 'rgba(125,84,48,0.5)'; g.beginPath(); g.moveTo(16, 12); g.lineTo(48, 28); g.moveTo(16, 20); g.lineTo(48, 4); g.stroke(); }),
  tile_water: () => canvasTexture('water', TILE_W, TILE_H, (g) => { diamondPath(g); g.fillStyle = '#2f7fd6'; g.fill(); g.strokeStyle = 'rgba(33,95,158,0.6)'; g.stroke(); }),
  tree:       () => canvasTexture('tree', 48, 64, (g) => { g.fillStyle = '#6e4a26'; g.fillRect(21, 40, 6, 22); g.fillStyle = '#2f7a35'; g.beginPath(); g.arc(24, 30, 16, 0, 7); g.fill(); g.beginPath(); g.arc(16, 38, 10, 0, 7); g.fill(); g.beginPath(); g.arc(32, 38, 10, 0, 7); g.fill(); }),
  house:      () => canvasTexture('house', 64, 64, (g) => {
    const cx = 32, baseY = 56, wall = 22;
    g.fillStyle = '#7d8389'; g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx + HW, baseY - HH); g.lineTo(cx + HW, baseY - HH - wall); g.lineTo(cx, baseY - wall); g.closePath(); g.fill();
    g.fillStyle = '#b0b6bd'; g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx - HW, baseY - HH); g.lineTo(cx - HW, baseY - HH - wall); g.lineTo(cx, baseY - wall); g.closePath(); g.fill();
    const ry = baseY - HH - wall; g.fillStyle = '#c0503a';
    g.beginPath(); g.moveTo(cx, ry - 8); g.lineTo(cx + HW, ry - HH + 2); g.lineTo(cx, ry - HH * 2 + 12); g.lineTo(cx - HW, ry - HH + 2); g.closePath(); g.fill();
  }),
  villager:   () => canvasTexture('unit', 24, 32, (g) => {
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.ellipse(12, 30, 7, 3, 0, 0, 7); g.fill();
    g.fillStyle = '#ff8a3c'; g.fillRect(7, 14, 10, 14);
    g.fillStyle = '#ffd9b0'; g.beginPath(); g.arc(12, 9, 6, 0, 7); g.fill();
  }),
};

AFRAME.registerComponent('iso-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera（原点左下・Y上向き）
    this.cam = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1);
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    // 状態
    this.tex = {};
    this.map = generateMap();
    this.staticObjs = [];
    this.units = [];
    this.unitSet = 0;
    this.fpsSamples = [];
    this.hudTimer = 0;
    this.tilesDrawn = 0;
    this.objectsSorted = 0;
    this.offX = 0; this.offY = 0;
    this.showGrid = false;
    this.ready = false;

    // カメラ範囲
    this.camMinX = -(MAP - 1) * HW + VIEW_W / 2;
    this.camMaxX =  (MAP - 1) * HW - VIEW_W / 2;
    this.camMinY = 0 + VIEW_H / 2;
    this.camMaxY = (2 * MAP - 2) * HH - VIEW_H / 2;
    this.camPos = { x: 0, y: MAP * HH };
    this.clampCam();

    // プール
    this.groundPool = [];
    this.objPool = [];
    this.objActive = [];
    this.unitSpritePool = [];

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.setUnitCount(this.unitSet + UNIT_STEP); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.setUnitCount(this.unitSet - UNIT_STEP); e.preventDefault(); }
      else if (e.code === 'KeyG') { this.showGrid = !this.showGrid; if (this.grid) this.grid.visible = this.showGrid; }
      else if (e.code === 'KeyR') { this.reset(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // アセット読込 → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  texOf(key) { return this.tex[key] || fb[key](); },

  clampCam() {
    const c = this.camPos;
    c.x = (this.camMinX > this.camMaxX) ? (this.camMinX + this.camMaxX) / 2 : clamp(c.x, this.camMinX, this.camMaxX);
    c.y = (this.camMinY > this.camMaxY) ? (this.camMinY + this.camMaxY) / 2 : clamp(c.y, this.camMinY, this.camMaxY);
  },

  toWorldX(sx) { return this.offX + sx; },
  toWorldY(sy) { return VIEW_H - (this.offY + sy); },

  // 足元基準（下端中央）スプライト
  makeSprite(texture, w, h, ro, centerY) {
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.center.set(0.5, centerY);
    s.scale.set(w, h, 1);
    s.renderOrder = ro;
    this.group.add(s);
    return s;
  },

  makeUnitTexture() {
    const t = this.unitTex.clone();
    if (this.unitAnimated) t.repeat.set(1 / 4, 1 / 4);
    t.needsUpdate = true;
    return t;
  },

  setUnitFrame(sprite, face, animT) {
    if (!sprite.userData.animated) return;
    const frame = Math.floor((animT || 0) * 8) % 4;
    sprite.material.map.offset.set(frame / 4, (3 - (face || 0)) / 4);
  },

  unitFaceFromMove(dx, dy, current = 0) {
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
    const sx = dx - dy;
    const sy = dx + dy;
    if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
    return sy < 0 ? 1 : 0;
  },

  buildStaticObjs() {
    this.staticObjs = [];
    for (let gy = 0; gy < MAP; gy++) {
      for (let gx = 0; gx < MAP; gx++) {
        const o = this.map.object[gy * MAP + gx];
        if (o === O_NONE) continue;
        this.staticObjs.push({ gx, gy, type: o });
      }
    }
  },

  pickLandTarget(rng) {
    for (let k = 0; k < 12; k++) {
      const x = 1 + Math.floor(rng() * (MAP - 2));
      const y = 1 + Math.floor(rng() * (MAP - 2));
      if (groundAt(this.map, x, y) !== G_WATER) return { x: x + 0.5, y: y + 0.5 };
    }
    return { x: MAP / 2, y: MAP / 2 };
  },
  spawnUnit() {
    const rng = mulberry32(0x1000 + this.units.length * 2654435761 >>> 0);
    const start0 = this.pickLandTarget(rng);
    const tgt = this.pickLandTarget(rng);
    let s = this.unitSpritePool.pop();
    if (!s) {
      s = this.makeSprite(this.makeUnitTexture(), 24, 32, RO_OBJ_BASE, 0);
      s.userData.animated = this.unitAnimated;
    }
    s.visible = true;
    this.units.push({ gx: start0.x, gy: start0.y, tx: tgt.x, ty: tgt.y, rng, face: 0, animT: 0, sprite: s });
  },
  setUnitCount(n) {
    n = clamp(n, UNIT_MIN, UNIT_MAX);
    while (this.units.length < n) this.spawnUnit();
    while (this.units.length > n) { const u = this.units.pop(); u.sprite.visible = false; this.unitSpritePool.push(u.sprite); }
    this.unitSet = n;
  },

  reset() {
    this.map = generateMap();
    this.buildStaticObjs();
    this.setUnitCount(UNIT_INIT);
    this.camPos.x = 0; this.camPos.y = MAP * HH; this.clampCam();
  },

  build() {
    this.tileTex = {
      [G_GRASS]: this.texOf('tile_grass'),
      [G_SOIL]:  this.texOf('tile_soil'),
      [G_WATER]: this.texOf('tile_water'),
    };
    this.treeTex = this.texOf('tree');
    this.houseTex = this.texOf('house');
    this.unitTex = this.texOf('villager');
    this.unitAnimated = !!(this.unitTex.image && this.unitTex.image.width >= 96 && this.unitTex.image.height >= 128);

    // 地面プール（上端中央基準 center=(0.5,1)）
    const GROUND_POOL = 2200;
    for (let i = 0; i < GROUND_POOL; i++) {
      const s = this.makeSprite(this.tileTex[G_GRASS], TILE_W, TILE_H, RO_GROUND, 1);
      s.visible = false;
      this.groundPool.push(s);
    }

    // グリッド
    const gridMat = new THREE.LineBasicMaterial({ color: 0x2a3550, transparent: true, opacity: 0.6, depthTest: false });
    this.gridGeo = new THREE.BufferGeometry();
    this.grid = new THREE.LineSegments(this.gridGeo, gridMat);
    this.grid.renderOrder = RO_GROUND + 0.5;
    this.grid.visible = false;
    this.group.add(this.grid);

    this.buildStaticObjs();
    this.setUnitCount(UNIT_INIT);
    this.ready = true;
  },

  getObjSprite() {
    let s = this.objPool.pop();
    if (!s) { s = this.makeSprite(this.treeTex, 48, 64, RO_OBJ_BASE, 0); }
    s.visible = true; return s;
  },

  rebuildGrid(minGX, maxGX, minGY, maxGY) {
    const verts = [];
    for (let gx = minGX; gx <= maxGX; gx++) {
      verts.push(this.toWorldX(isoX(gx, minGY)), this.toWorldY(isoY(gx, minGY)), 0,
                 this.toWorldX(isoX(gx, maxGY)), this.toWorldY(isoY(gx, maxGY)), 0);
    }
    for (let gy = minGY; gy <= maxGY; gy++) {
      verts.push(this.toWorldX(isoX(minGX, gy)), this.toWorldY(isoY(minGX, gy)), 0,
                 this.toWorldX(isoX(maxGX, gy)), this.toWorldY(isoY(maxGX, gy)), 0);
    }
    this.gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.gridGeo.attributes.position.needsUpdate = true;
  },

  down(...c) { return c.some((k) => this.keys[k]); },

  tick(time, dtMs) {
    if (!this.ready) return;
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50);
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();

    const map = this.map;

    // 1) カメラスクロール
    let dx = 0, dy = 0;
    if (this.down('ArrowLeft', 'KeyA')) dx -= 1;
    if (this.down('ArrowRight', 'KeyD')) dx += 1;
    if (this.down('ArrowUp', 'KeyW')) dy -= 1;
    if (this.down('ArrowDown', 'KeyS')) dy += 1;
    this.camPos.x += dx * CAM_SPEED * dt;
    this.camPos.y += dy * CAM_SPEED * dt;
    this.clampCam();
    this.offX = Math.round(VIEW_W / 2 - this.camPos.x);
    this.offY = Math.round(VIEW_H / 2 - this.camPos.y);

    // 2) ユニット更新
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const bx = u.gx, by = u.gy;
      const ddx = u.tx - u.gx, ddy = u.ty - u.gy;
      const dist = Math.hypot(ddx, ddy);
      if (dist < UNIT_REACH) { const t = this.pickLandTarget(u.rng); u.tx = t.x; u.ty = t.y; }
      else {
        const step = UNIT_SPEED * dt;
        const nx = u.gx + (ddx / dist) * step;
        const ny = u.gy + (ddy / dist) * step;
        if (groundAt(map, Math.floor(nx), Math.floor(ny)) === G_WATER) { const t = this.pickLandTarget(u.rng); u.tx = t.x; u.ty = t.y; }
        else { u.gx = nx; u.gy = ny; }
      }
      const mdx = u.gx - bx, mdy = u.gy - by;
      const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
      u.face = this.unitFaceFromMove(mdx, mdy, u.face);
      u.animT = moving ? (u.animT || 0) + dt : 0;
    }

    // 3) 可視範囲（カリング）
    const invX = (wx, wy) => (wx / HW + wy / HH) / 2;
    const invY = (wx, wy) => (wy / HH - wx / HW) / 2;
    const wl = -this.offX, wt = -this.offY, wr = wl + VIEW_W, wb = wt + VIEW_H;
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

    // 4) 地面（renderOrder=0 固定）
    this.tilesDrawn = 0;
    let gi = 0;
    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        if (gi >= this.groundPool.length) break;
        const type = map.ground[gy * MAP + gx];
        const s = this.groundPool[gi++];
        s.material.map = this.tileTex[type];
        s.position.set(this.toWorldX(isoX(gx, gy)), this.toWorldY(isoY(gx, gy)), 0);
        s.visible = true;
        this.tilesDrawn++;
      }
    }
    for (let k = gi; k < this.groundPool.length; k++) this.groundPool[k].visible = false;

    // 5) オブジェクト/ユニット → ★ renderOrder = 1 + (gx+gy)
    this.objectsSorted = 0;
    let oi = 0;
    for (let i = 0; i < this.staticObjs.length; i++) {
      const o = this.staticObjs[i];
      if (o.gx < minGX || o.gx > maxGX || o.gy < minGY || o.gy > maxGY) continue;
      let s = this.objActive[oi];
      if (!s) { s = this.getObjSprite(); this.objActive[oi] = s; }
      if (o.type === O_TREE) { s.material.map = this.treeTex; s.scale.set(48, 64, 1); }
      else { s.material.map = this.houseTex; s.scale.set(64, 64, 1); }
      s.position.set(this.toWorldX(isoX(o.gx, o.gy)), this.toWorldY(isoY(o.gx, o.gy) + HH), 0);
      s.renderOrder = RO_OBJ_BASE + (o.gx + o.gy);   // ★ 深度キー
      s.visible = true;
      oi++; this.objectsSorted++;
    }
    for (let k = oi; k < this.objActive.length; k++) { this.objActive[k].visible = false; this.objPool.push(this.objActive[k]); this.objActive[k] = null; }
    this.objActive.length = oi;

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const s = u.sprite;
      const vis = (u.gx >= minGX && u.gx <= maxGX && u.gy >= minGY && u.gy <= maxGY);
      if (!vis) { s.visible = false; continue; }
      this.setUnitFrame(s, u.face, u.animT);
      s.scale.set(24, 32, 1);
      s.position.set(this.toWorldX(isoX(u.gx, u.gy)), this.toWorldY(isoY(u.gx, u.gy) + HH), 0);
      s.renderOrder = RO_OBJ_BASE + (u.gx + u.gy);   // ★ 連続座標の深度キー（毎フレーム変化）
      s.visible = true;
      this.objectsSorted++;
    }

    if (this.showGrid) this.rebuildGrid(minGX, maxGX, minGY, maxGY);

    // 6) HUD
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
      const cgx = invX(this.camPos.x, this.camPos.y), cgy = invY(this.camPos.x, this.camPos.y);
      this.hudEl.textContent =
        `FPS           : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn   : ${this.tilesDrawn}\n` +
        `Objects sorted: ${this.objectsSorted}\n` +
        `Units         : ${this.units.length} / ${this.unitSet}\n` +
        `Camera (gx,gy): (${cgx.toFixed(1)}, ${cgy.toFixed(1)})\n` +
        `矢印/WASD=スクロール  +/-=ユニット数  G=グリッド  R=リセット`;
    }
  },
});

console.log('[A-Frame 1.7.0] theme9 iso-game component registered. renderOrder=gx+gy depth sort.');
