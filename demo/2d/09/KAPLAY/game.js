/* =========================================================================
 * テーマ9 アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― KAPLAY
 * 仕様: ../SPEC.md / 正準リファレンス: ../PixiJS/game.js
 *   - 960x540 / 64x64 タイルマップ（決定的生成・固定シード mulberry32）
 *   - アイソメ投影 TILE_W=64, TILE_H=32:
 *       screenX = (gx - gy) * 32
 *       screenY = (gx + gy) * 16
 *       depth   = gx + gy        （小さいほど奥＝先に描く）
 *   - 2層方式: 地面（ソート不要・カリングのみ）
 *              ＋ オブジェクト/ユニット（毎フレーム深度ソート）
 *
 * ★ KAPLAY の深度実現方法 = ペインターズアルゴリズム（手動描画順制御）:
 *   KAPLAY の add([...]) は z() コンポーネントで重ね順を持てるが、毎フレーム
 *   数百〜数千スプライトの z を再設定するとシーングラフ走査コストが嵩む。
 *   そこで本実装は PixiJS リファレンスの「手で並べた描画順」を最も忠実に映す
 *   イミディエイトモードを採用する:
 *     onDraw 内で 可視オブジェクト/ユニットを集めた配列を depth=gx+gy で
 *     昇順ソートし、その順に drawSprite / drawPolygon を呼ぶ。
 *   → 後に描いたものが手前に来る KAPLAY の描画規則そのものが z-order になる。
 *   地面は高さ0で重ならないため、ソートせず「地面→オブジェクト/ユニット」の
 *   2パスで描けば十分（SPEC 推奨の 2 層方式）。
 *
 * KAPLAY は座標系が Y 下向き・原点左上 = 画面座標と一致するため変換が素直。
 * ゲームループ/入力/カリング/ユニット徘徊/フォールバック図形はすべて自前。
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const MAP = 64;                 // 64 x 64 タイル
const TILE_W = 64;              // アイソメ菱形の幅
const TILE_H = 32;              // アイソメ菱形の高さ
const HW = TILE_W / 2;          // 32  画面X係数
const HH = TILE_H / 2;          // 16  画面Y係数

const G_GRASS = 0, G_SOIL = 1, G_WATER = 2;
const O_NONE = 0, O_TREE = 1, O_HOUSE = 2;

const UNIT_INIT = 60;
const UNIT_STEP = 20;
const UNIT_MIN = 0;
const UNIT_MAX = 2000;
const UNIT_SPEED = 40 / TILE_W;  // 40px/s をグリッド連続座標へ換算
const UNIT_REACH = 0.25;

const CAM_SPEED = 420;

const COLORS = {
  grass:  [90, 168, 60],  grassE: [63, 125, 43],
  soil:   [169, 116, 63], soilE:  [125, 84, 48],
  water:  [47, 127, 214], waterE: [33, 95, 158],
  trunk:  [110, 74, 38],  leaf:   [47, 122, 53],
  house:  [176, 182, 189],houseE: [125, 131, 137], roof: [192, 80, 58],
  unit:   [255, 138, 60], unitE:  [184, 94, 30],
  grid:   [42, 53, 80],
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

// === KAPLAY 初期化 =========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: [14, 20, 34],
  crisp: true,
  global: false,            // 名前空間 k.* を明示利用
});

// === アセット読み込み（失敗してもフォールバック図形で必ず起動） ============
const ASSET_DEFS = {
  tile_grass: '../assets/tile_grass.png',
  tile_soil:  '../assets/tile_soil.png',
  tile_water: '../assets/tile_water.png',
  tree:       '../assets/tree.png',
  house:      '../assets/house.png',
  villager:   '../assets/villager.png',
};
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      const opts = key === 'villager' ? { sliceX: 4, sliceY: 4 } : undefined;
      await k.loadSprite(key, url, opts);
      loaded[key] = true;
    }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

// ---- フォールバック図形描画（イミディエイトモード） ----------------------
// 各描画関数は「足元（菱形中心）」を基準点 (px,py) として受け取る。
function drawDiamond(px, py, fill, edge) {
  // 菱形 4 頂点（中心 px,py）。上(0,-HH) 右(HW,0) 下(0,HH) 左(-HW,0)
  const pts = [
    k.vec2(px, py - HH), k.vec2(px + HW, py),
    k.vec2(px, py + HH), k.vec2(px - HW, py),
  ];
  k.drawPolygon({ pts, color: k.rgb(fill[0], fill[1], fill[2]) });
  k.drawLines({ pts, color: k.rgb(edge[0], edge[1], edge[2]), width: 1, opacity: 0.6, closed: true });
}
function drawTileFallback(type, px, py) {
  if (type === G_GRASS) drawDiamond(px, py, COLORS.grass, COLORS.grassE);
  else if (type === G_SOIL) {
    drawDiamond(px, py, COLORS.soil, COLORS.soilE);
    k.drawLine({ p1: k.vec2(px - 16, py - 4), p2: k.vec2(px + 16, py + 12), color: k.rgb(COLORS.soilE[0], COLORS.soilE[1], COLORS.soilE[2]), width: 1, opacity: 0.5 });
    k.drawLine({ p1: k.vec2(px - 16, py + 4), p2: k.vec2(px + 16, py - 12), color: k.rgb(COLORS.soilE[0], COLORS.soilE[1], COLORS.soilE[2]), width: 1, opacity: 0.5 });
  } else {
    drawDiamond(px, py, COLORS.water, COLORS.waterE);
  }
}
function drawTreeFallback(px, py) {
  // 幹（足元 px,py 基準で上方向に伸びる）
  k.drawRect({ pos: k.vec2(px - 3, py - 22), width: 6, height: 22, color: k.rgb(COLORS.trunk[0], COLORS.trunk[1], COLORS.trunk[2]) });
  k.drawCircle({ pos: k.vec2(px, py - 32), radius: 16, color: k.rgb(COLORS.leaf[0], COLORS.leaf[1], COLORS.leaf[2]) });
  k.drawCircle({ pos: k.vec2(px - 8, py - 24), radius: 10, color: k.rgb(COLORS.leaf[0], COLORS.leaf[1], COLORS.leaf[2]), opacity: 0.9 });
  k.drawCircle({ pos: k.vec2(px + 8, py - 24), radius: 10, color: k.rgb(COLORS.leaf[0], COLORS.leaf[1], COLORS.leaf[2]), opacity: 0.9 });
}
function drawHouseFallback(px, py) {
  const wall = 22;
  // 側面（右=暗 / 左=明）アイソメ柱
  k.drawPolygon({ pts: [k.vec2(px, py), k.vec2(px + HW, py - HH), k.vec2(px + HW, py - HH - wall), k.vec2(px, py - wall)], color: k.rgb(COLORS.houseE[0], COLORS.houseE[1], COLORS.houseE[2]) });
  k.drawPolygon({ pts: [k.vec2(px, py), k.vec2(px - HW, py - HH), k.vec2(px - HW, py - HH - wall), k.vec2(px, py - wall)], color: k.rgb(COLORS.house[0], COLORS.house[1], COLORS.house[2]) });
  // 屋根（上面菱形）
  const ry = py - HH - wall;
  k.drawPolygon({ pts: [k.vec2(px, ry - 8), k.vec2(px + HW, ry - HH + 2), k.vec2(px, ry - HH * 2 + 12), k.vec2(px - HW, ry - HH + 2)], color: k.rgb(COLORS.roof[0], COLORS.roof[1], COLORS.roof[2]) });
}
function drawUnitFallback(px, py) {
  k.drawEllipse({ pos: k.vec2(px, py), radiusX: 7, radiusY: 3, color: k.rgb(0, 0, 0), opacity: 0.18 });
  k.drawRect({ pos: k.vec2(px - 5, py - 18), width: 10, height: 14, radius: 4, color: k.rgb(COLORS.unit[0], COLORS.unit[1], COLORS.unit[2]) });
  k.drawCircle({ pos: k.vec2(px, py - 23), radius: 6, color: k.rgb(255, 217, 176) });
}

// 画像があればスプライトで足元基準描画。anchor 'bot' で下端中央を (px,py) に。
function drawTileSprite(key, px, py) {
  // 地面菱形は上頂点が isoY 基準なので、px,py（中心）から上に HH 寄せて 'top'
  k.drawSprite({ sprite: key, pos: k.vec2(px, py - HH), anchor: 'top', width: TILE_W, height: TILE_H });
}
function drawObjSprite(key, px, py, w, h, frame) {
  const opts = { sprite: key, pos: k.vec2(px, py), anchor: 'bot', width: w, height: h };
  if (frame != null) opts.frame = frame;
  k.drawSprite(opts);
}

function start() {
  let map = generateMap();

  // ---- 静的オブジェクトのリスト（決定的・固定） ----
  let staticObjs = [];
  function buildStaticObjs() {
    staticObjs = [];
    for (let gy = 0; gy < MAP; gy++) {
      for (let gx = 0; gx < MAP; gx++) {
        const o = map.object[gy * MAP + gx];
        if (o === O_NONE) continue;
        staticObjs.push({ gx, gy, type: o, depth: gx + gy });
      }
    }
  }
  buildStaticObjs();

  // ---- ユニット（決定的徘徊） ----
  const units = [];
  let unitSet = 0;
  function pickLandTarget(rng) {
    for (let kk = 0; kk < 12; kk++) {
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
    units.push({ gx: start0.x, gy: start0.y, tx: tgt.x, ty: tgt.y, rng, face: 0, animT: 0 });
  }
  function setUnitCount(n) {
    n = clamp(n, UNIT_MIN, UNIT_MAX);
    while (units.length < n) spawnUnit();
    while (units.length > n) units.pop();
    unitSet = n;
  }

  function unitFaceFromMove(dx, dy, current = 0) {
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
    const sx = dx - dy;
    const sy = dx + dy;
    if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
    return sy < 0 ? 1 : 0;
  }

  // ---- カメラ（ワールド画面座標オフセット・クランプ） ----
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
    buildStaticObjs();
    setUnitCount(UNIT_INIT);
    cam.x = 0; cam.y = MAP * HH;
    clampCam();
  }
  setUnitCount(UNIT_INIT);

  // ---- 入力 ----
  let showGrid = false;
  k.onKeyPress(['=', 'kpadd'], () => setUnitCount(unitSet + UNIT_STEP));
  k.onKeyPress(['minus', 'kpsubtract'], () => setUnitCount(unitSet - UNIT_STEP));
  k.onKeyPress('g', () => { showGrid = !showGrid; });
  k.onKeyPress('r', () => reset());

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  const fpsSamples = [];
  let hudTimer = 0;
  let tilesDrawn = 0;
  let objectsSorted = 0;

  // worldOffset: ワールド原点(0,0) の画面位置
  let offX = 0, offY = 0;
  // 可視グリッド範囲（更新で算出し onDraw でも使う）
  let vMinGX = 0, vMaxGX = 0, vMinGY = 0, vMaxGY = 0;

  // 逆投影
  const invX = (wx, wy) => (wx / HW + wy / HH) / 2;
  const invY = (wx, wy) => (wy / HH - wx / HW) / 2;

  // ---- 更新（ロジック） ----
  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();

    // 1) カメラスクロール
    let dx = 0, dy = 0;
    if (k.isKeyDown('left') || k.isKeyDown('a')) dx -= 1;
    if (k.isKeyDown('right') || k.isKeyDown('d')) dx += 1;
    if (k.isKeyDown('up') || k.isKeyDown('w')) dy -= 1;
    if (k.isKeyDown('down') || k.isKeyDown('s')) dy += 1;
    cam.x += dx * CAM_SPEED * dt;
    cam.y += dy * CAM_SPEED * dt;
    clampCam();
    offX = Math.round(VIEW_W / 2 - cam.x);
    offY = Math.round(VIEW_H / 2 - cam.y);

    // 2) ユニット更新（決定的徘徊・水回避・40px/s 相当）
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const bx = u.gx, by = u.gy;
      const ddx = u.tx - u.gx, ddy = u.ty - u.gy;
      const dist = Math.hypot(ddx, ddy);
      if (dist < UNIT_REACH) {
        const t = pickLandTarget(u.rng); u.tx = t.x; u.ty = t.y;
      } else {
        const step = UNIT_SPEED * dt;
        const nx = u.gx + (ddx / dist) * step;
        const ny = u.gy + (ddy / dist) * step;
        if (groundAt(map, Math.floor(nx), Math.floor(ny)) === G_WATER) {
          const t = pickLandTarget(u.rng); u.tx = t.x; u.ty = t.y;
        } else { u.gx = nx; u.gy = ny; }
      }
      const mdx = u.gx - bx, mdy = u.gy - by;
      const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
      u.face = unitFaceFromMove(mdx, mdy, u.face);
      u.animT = moving ? (u.animT || 0) + dt : 0;
    }

    // 3) 可視アイソメ範囲（カリング）。ワールドローカル四隅を逆投影。
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
    vMinGX = clamp(Math.floor(minGX) - PAD, 0, MAP - 1);
    vMaxGX = clamp(Math.ceil(maxGX) + PAD, 0, MAP - 1);
    vMinGY = clamp(Math.floor(minGY) - PAD_TOP, 0, MAP - 1);
    vMaxGY = clamp(Math.ceil(maxGY) + PAD, 0, MAP - 1);

    // HUD
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
  });

  // 深度ソート用の再利用バッファ（GC 抑制）
  const drawList = [];

  // ---- 描画（★ ペインターズアルゴリズム = 手動深度ソート） ----
  k.onDraw(() => {
    // ワールド全体をカメラぶん平行移動。pushTransform 内で描画。
    k.pushTransform();
    k.pushTranslate(k.vec2(offX, offY));

    // --- パス1: 地面（ソート不要・カリングのみ・gx+gy 昇順に走査） ---
    tilesDrawn = 0;
    for (let gy = vMinGY; gy <= vMaxGY; gy++) {
      for (let gx = vMinGX; gx <= vMaxGX; gx++) {
        const type = map.ground[gy * MAP + gx];
        const px = isoX(gx, gy), py = isoY(gx, gy);   // py は上頂点
        const cy = py + HH;                            // 菱形中心
        const key = type === G_GRASS ? 'tile_grass' : type === G_SOIL ? 'tile_soil' : 'tile_water';
        if (loaded[key]) drawTileSprite(key, px, cy);
        else drawTileFallback(type, px, cy);
        tilesDrawn++;
      }
    }

    // --- グリッド線（任意・地面の上） ---
    if (showGrid) {
      for (let gx = vMinGX; gx <= vMaxGX; gx++) {
        k.drawLine({ p1: k.vec2(isoX(gx, vMinGY), isoY(gx, vMinGY)), p2: k.vec2(isoX(gx, vMaxGY), isoY(gx, vMaxGY)),
          color: k.rgb(COLORS.grid[0], COLORS.grid[1], COLORS.grid[2]), width: 1, opacity: 0.6 });
      }
      for (let gy = vMinGY; gy <= vMaxGY; gy++) {
        k.drawLine({ p1: k.vec2(isoX(vMinGX, gy), isoY(vMinGX, gy)), p2: k.vec2(isoX(vMaxGX, gy), isoY(vMaxGX, gy)),
          color: k.rgb(COLORS.grid[0], COLORS.grid[1], COLORS.grid[2]), width: 1, opacity: 0.6 });
      }
    }

    // --- パス2: オブジェクト/ユニットを可視ぶん集め、depth=gx+gy で昇順ソート ---
    drawList.length = 0;
    // 静的オブジェクト（木/家）
    for (let i = 0; i < staticObjs.length; i++) {
      const o = staticObjs[i];
      if (o.gx < vMinGX || o.gx > vMaxGX || o.gy < vMinGY || o.gy > vMaxGY) continue;
      drawList.push({ depth: o.gx + o.gy, kind: o.type, gx: o.gx, gy: o.gy });
    }
    // ユニット（連続座標・毎フレーム depth が変化）
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.gx < vMinGX || u.gx > vMaxGX || u.gy < vMinGY || u.gy > vMaxGY) continue;
      drawList.push({ depth: u.gx + u.gy, kind: -1, gx: u.gx, gy: u.gy, face: u.face || 0, animT: u.animT || 0 });
    }
    objectsSorted = drawList.length;

    // ★ 深度ソート（gx+gy 昇順 = 奥→手前）。後に描いたものが手前になる。
    drawList.sort((a, b) => a.depth - b.depth);

    for (let i = 0; i < drawList.length; i++) {
      const d = drawList[i];
      const px = isoX(d.gx, d.gy);
      const py = isoY(d.gx, d.gy) + HH;   // 足元（菱形中心）
      if (d.kind === O_TREE) {
        if (loaded.tree) drawObjSprite('tree', px, py, 48, 64); else drawTreeFallback(px, py);
      } else if (d.kind === O_HOUSE) {
        if (loaded.house) drawObjSprite('house', px, py, 64, 64); else drawHouseFallback(px, py);
      } else {
        if (loaded.villager) drawObjSprite('villager', px, py, 24, 32, (d.face || 0) * 4 + (Math.floor((d.animT || 0) * 8) % 4)); else drawUnitFallback(px, py);
      }
    }

    k.popTransform();
  });

  console.log('[KAPLAY] theme9 isometric init ok.');
}
