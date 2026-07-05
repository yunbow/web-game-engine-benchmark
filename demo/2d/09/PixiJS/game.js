/* =========================================================================
 * テーマ9 アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― PixiJS v8
 * 仕様: SPEC.md
 *   - 960x540 / 64x64 タイルマップ（決定的生成・固定シード）
 *   - アイソメ投影 TILE_W=64, TILE_H=32:
 *       screenX = (gx - gy) * 32
 *       screenY = (gx + gy) * 16
 *       depth   = gx + gy        （小さいほど奥＝先に描く）
 *   - 2層方式: 地面コンテナ（ソート不要・カリングのみ）
 *              ＋ オブジェクト/ユニットコンテナ（毎フレーム深度ソート）
 *
 * 深度ソートは PixiJS の自動ソートを使う:
 *   objLayer.sortableChildren = true;  sprite.zIndex = gx + gy;
 *   → Pixi が描画前に zIndex 昇順で子を並べ替える（手動 sort 不要）。
 *
 * PixiJS は描画ライブラリのため、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker の deltaMS でデルタタイム駆動)
 *   - キーボード入力 / カメラスクロール（クランプ）
 *   - 可視アイソメ範囲のカリング（地面・オブジェクト・ユニット）
 *   - ユニットの決定的徘徊（mulberry32・水回避・40px/s 相当）
 *   - スプライトのプール再利用
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const MAP = 64;                 // 64 x 64 タイル
const TILE_W = 64;              // アイソメ菱形の幅
const TILE_H = 32;              // アイソメ菱形の高さ
const HW = TILE_W / 2;          // 32  画面X係数
const HH = TILE_H / 2;          // 16  画面Y係数

// 地面種別
const G_GRASS = 0, G_SOIL = 1, G_WATER = 2;

// 静的オブジェクト種別（タイルに乗る）
const O_NONE = 0, O_TREE = 1, O_HOUSE = 2;

// ユニット（負荷の主役）
const UNIT_INIT = 60;
const UNIT_STEP = 20;
const UNIT_MIN = 0;
const UNIT_MAX = 2000;
const UNIT_SPEED = 40 / TILE_W;  // 40 px/s をグリッド連続座標へ換算（screenX 係数 HW=32 基準）
const UNIT_REACH = 0.25;         // 目的地到達判定（グリッド距離）

// カメラスクロール（px/s, ワールド画面座標で移動）
const CAM_SPEED = 420;

// フォールバック色
const COLORS = {
  grass:  0x5aa83c,
  grassE: 0x3f7d2b,
  soil:   0xa9743f,
  soilE:  0x7d5430,
  water:  0x2f7fd6,
  waterE: 0x215f9e,
  trunk:  0x6e4a26,
  leaf:   0x2f7a35,
  house:  0xb0b6bd,
  houseE: 0x7d8389,
  roof:   0xc0503a,
  unit:   0xff8a3c,
  unitE:  0xb85e1e,
  bg:     0x0e1422,
  grid:   0x2a3550,
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

// ---- アイソメ投影 ----------------------------------------------------------
// グリッド (gx, gy) → ワールド画面座標。深度キーは gx + gy。
const isoX = (gx, gy) => (gx - gy) * HW;
const isoY = (gx, gy) => (gx + gy) * HH;

// ---- マップ決定的生成 ------------------------------------------------------
// 固定シードで全エンジン共通の見た目を狙う。
//   地面: 中央に湖（水）/ 川状の帯、畑のパッチ、残りは草。
//   オブジェクト: 草地に木、乾いた地面に家を決定的に散布。水上には置かない。
function generateMap() {
  const rnd = mulberry32(20250609);
  const ground = new Uint8Array(MAP * MAP);  // 既定 0 = grass
  const object = new Uint8Array(MAP * MAP);  // 既定 0 = none
  const idx = (x, y) => y * MAP + x;

  // --- 値ノイズ風の決定的フィールドで水/畑を配置 ---
  // 低解像度の格子に乱数を置き、双線形補間で滑らかな高さ場をつくる。
  const N = 9;                       // ノイズ格子
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
      if (h < 0.32) g = G_WATER;        // 低い土地は水
      else if (h < 0.46) g = G_SOIL;    // 水際は畑/土
      ground[idx(x, y)] = g;
    }
  }

  // --- 静的オブジェクト散布（地面が陸のセルのみ） ---
  const ornd = mulberry32(424242);
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const g = ground[idx(x, y)];
      if (g === G_WATER) continue;
      // 端は空けて、奥行きが見やすいよう散らす
      if (x < 1 || y < 1 || x >= MAP - 1 || y >= MAP - 1) continue;
      const r = ornd();
      if (g === G_GRASS && r < 0.14) object[idx(x, y)] = O_TREE;
      else if (g === G_SOIL && r < 0.10) object[idx(x, y)] = O_HOUSE;
      else if (g === G_GRASS && r < 0.17) object[idx(x, y)] = O_HOUSE; // 草地にも家を少々
    }
  }

  return { ground, object };
}

const groundAt = (m, gx, gy) => {
  if (gx < 0 || gy < 0 || gx >= MAP || gy >= MAP) return G_WATER; // 場外は水扱い（侵入不可）
  return m.ground[gy * MAP + gx];
};

// ---- フォールバックテクスチャ生成 (Graphics→Texture) ----------------------
// アイソメ菱形（4頂点ポリゴン）と背の高いオブジェクトを図形で生成し、
// 全スプライトで再利用する。アンカーは「足元の菱形中心」を基準にする。
function makeFallbackTextures(app) {
  const tex = {};
  // 余白（padding）込みで生成し、anchor を中央下に合わせやすくする。
  const make = (w, h, draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, width: w, height: h, resolution: 1 });
    gr.destroy();
    return t;
  };

  // 地面菱形（64x32）。頂点: 上(32,0) 右(64,16) 下(32,32) 左(0,16)。
  const diamond = (gr, fill, edge) => {
    gr.poly([HW, 0, TILE_W, HH, HW, TILE_H, 0, HH]).fill(fill);
    gr.poly([HW, 0, TILE_W, HH, HW, TILE_H, 0, HH]).stroke({ width: 1, color: edge, alpha: 0.6 });
  };
  tex.tile_grass = make(TILE_W, TILE_H, (gr) => diamond(gr, COLORS.grass, COLORS.grassE));
  tex.tile_soil  = make(TILE_W, TILE_H, (gr) => {
    diamond(gr, COLORS.soil, COLORS.soilE);
    // 畑のうね（2本の溝）
    gr.moveTo(16, 12).lineTo(48, 28).stroke({ width: 1, color: COLORS.soilE, alpha: 0.5 });
    gr.moveTo(16, 20).lineTo(48, 4).stroke({ width: 1, color: COLORS.soilE, alpha: 0.5 });
  });
  tex.tile_water = make(TILE_W, TILE_H, (gr) => {
    diamond(gr, COLORS.water, COLORS.waterE);
    gr.poly([HW, 6, HW + 10, 12, HW, 18, HW - 10, 12]).fill({ color: 0x9fd0ff, alpha: 0.35 });
  });

  // 木: 幅48 x 高64。足元（下端中央）が菱形中心に来るよう描く。
  tex.tree = make(48, 64, (gr) => {
    gr.rect(21, 40, 6, 22).fill(COLORS.trunk);             // 幹
    gr.circle(24, 30, 16).fill(COLORS.leaf);               // 葉
    gr.circle(24, 30, 16).stroke({ width: 1, color: 0x1f5524, alpha: 0.6 });
    gr.circle(16, 38, 10).fill({ color: COLORS.leaf, alpha: 0.9 });
    gr.circle(32, 38, 10).fill({ color: COLORS.leaf, alpha: 0.9 });
  });

  // 家: 64x64。アイソメ柱（菱形の上面＋側面）＋屋根。足元菱形が下端中央。
  tex.house = make(64, 64, (gr) => {
    const cx = 32, baseY = 56;     // 足元菱形の中心
    // 側面（壁の高さ ~22）
    gr.poly([cx, baseY, cx + HW, baseY - HH, cx + HW, baseY - HH - 22, cx, baseY - 22]).fill(COLORS.houseE);
    gr.poly([cx, baseY, cx - HW, baseY - HH, cx - HW, baseY - HH - 22, cx, baseY - 22]).fill(COLORS.house);
    // 屋根（上面菱形を少し持ち上げ）
    const ry = baseY - HH - 22;
    gr.poly([cx, ry - 8, cx + HW, ry - HH + 2, cx, ry - HH * 2 + 12, cx - HW, ry - HH + 2]).fill(COLORS.roof);
    gr.poly([cx, ry - 8, cx + HW, ry - HH + 2, cx, ry - HH * 2 + 12, cx - HW, ry - HH + 2])
      .stroke({ width: 1, color: 0x7a2f22, alpha: 0.7 });
  });

  // ユニット: 24x32。足元中央が基準。橙の体＋頭。
  tex.villager = make(24, 32, (gr) => {
    gr.ellipse(12, 30, 7, 3).fill({ color: 0x000000, alpha: 0.18 });  // 影
    gr.roundRect(7, 14, 10, 14, 4).fill(COLORS.unit);                  // 胴
    gr.roundRect(7, 14, 10, 14, 4).stroke({ width: 1, color: COLORS.unitE });
    gr.circle(12, 9, 6).fill(0xffd9b0);                                // 頭
    gr.circle(12, 9, 6).stroke({ width: 1, color: COLORS.unitE });
  });

  return tex;
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
    tile_grass: '../assets/tile_grass.png',
    tile_soil:  '../assets/tile_soil.png',
    tile_water: '../assets/tile_water.png',
    tree:       '../assets/tree.png',
    house:      '../assets/house.png',
    villager:   '../assets/villager.png',
  };
  const tex = { ...fallback };
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key];
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形フォールバック
    }
  }
  tex.villagerFrames = [];
  if (tex.villager && tex.villager.source && tex.villager.source.width >= 96 && tex.villager.source.height >= 128) {
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        tex.villagerFrames.push(new PIXI.Texture({
          source: tex.villager.source,
          frame: new PIXI.Rectangle(col * 24, row * 32, 24, 32),
        }));
      }
    }
  } else {
    for (let i = 0; i < 16; i++) tex.villagerFrames.push(tex.villager);
  }
  return tex;
}

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須。
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: COLORS.bg,
    antialias: true,
    resolution: 1,
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  let map = generateMap();
  const tex = await loadTextures(app);

  // ---- world: カメラに合わせ平行移動するコンテナ ----
  const world = new PIXI.Container();
  app.stage.addChild(world);

  // 2層方式:
  //   groundLayer ... 地面菱形。高さ0で重ならないためソート不要（カリングのみ）。
  //   objLayer ...... 木/家/ユニット。背が高く前後が入れ替わるため深度ソート対象。
  const groundLayer = new PIXI.Container();
  const objLayer = new PIXI.Container();
  // ★ 深度ソートの核: Pixi の自動ソートを有効化。zIndex 昇順で描画される。
  objLayer.sortableChildren = true;
  // グリッド線（任意・デバッグ）。地面の上・オブジェクトの下に置く。
  const gridGfx = new PIXI.Graphics();
  gridGfx.visible = false;
  world.addChild(groundLayer, gridGfx, objLayer);

  // ---- 地面スプライトプール（可視範囲ぶんを再利用） ----
  // 画面に入りうるアイソメ範囲の最大タイル数を見積もってプール確保。
  // 菱形は縦16px刻みで並ぶため、960x540 に収まる枚数は約 (960/64)*(540/16)*2 程度。
  // 余裕をもって確保し、毎フレーム可視ぶんへテクスチャ・座標を割り当てる。
  const GROUND_POOL = 2200;
  const groundPool = [];
  for (let i = 0; i < GROUND_POOL; i++) {
    const s = new PIXI.Sprite(tex.tile_grass);
    s.anchor.set(0.5, 0);   // 菱形の上頂点基準（isoX,isoY が上頂点に対応）
    s.visible = false;
    groundPool.push(s);
    groundLayer.addChild(s);
  }
  const groundTexByType = {
    [G_GRASS]: tex.tile_grass,
    [G_SOIL]:  tex.tile_soil,
    [G_WATER]: tex.tile_water,
  };

  // ---- オブジェクト/ユニット スプライトプール ----
  // 木/家は静的だが「可視ぶんだけ」objLayer に出して毎フレーム再ソートする。
  // ユニットは連続座標で深度キーが毎フレーム変わるため必ず再ソート対象。
  const objPool = [];   // 静的オブジェクト用（木/家）
  const unitPool = [];  // ユニット用
  function getObjSprite() {
    let s = objPool.pop();
    if (!s) {
      s = new PIXI.Sprite();
      s.anchor.set(0.5, 1);  // 足元（下端中央）基準
      objLayer.addChild(s);
    }
    s.visible = true;
    return s;
  }
  function getUnitSprite() {
    let s = unitPool.pop();
    if (!s) {
      s = new PIXI.Sprite(tex.villager);
      s.anchor.set(0.5, 1);
      objLayer.addChild(s);
    }
    s.visible = true;
    return s;
  }
  // 使い終わったスプライトを退避（破棄しない）。
  const releaseObj = (s) => { s.visible = false; objPool.push(s); };
  const releaseUnit = (s) => { s.visible = false; unitPool.push(s); };

  function unitFaceFromMove(dx, dy, current = 0) {
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
    const sx = dx - dy;
    const sy = dx + dy;
    if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
    return sy < 0 ? 1 : 0;
  }

  // objActive は静的オブジェクトの「現在アクティブなスプライト」配列。
  // 毎フレーム可視ぶんだけ詰め直し、余りは objPool へ退避する。
  const objActive = [];

  // ---- 静的オブジェクトのリスト（決定的・固定） ----
  // {gx, gy, type, depth} を全件保持し、毎フレーム可視判定する。
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
  // 各ユニットは連続グリッド座標 (gx,gy) を持ち、決定的な目的地へ歩く。
  // 着いたら次の目的地を決定的 RNG で選ぶ（水・場外は避ける）。
  const units = [];        // {gx, gy, tx, ty, rng}
  let unitSet = 0;
  const unitRng = mulberry32(0xABCD12);  // ユニット初期配置・目的地のシード源

  // 陸地のランダムな目的地を選ぶ（水・場外を避け、数回リトライ）。
  function pickLandTarget(rng) {
    for (let k = 0; k < 12; k++) {
      const x = 1 + Math.floor(rng() * (MAP - 2));
      const y = 1 + Math.floor(rng() * (MAP - 2));
      if (groundAt(map, x, y) !== G_WATER) return { x: x + 0.5, y: y + 0.5 };
    }
    return { x: MAP / 2, y: MAP / 2 };
  }

  function spawnUnit() {
    // 各ユニットに固有シードの RNG を持たせ、巡回を決定的にする。
    const rng = mulberry32(0x1000 + units.length * 2654435761 >>> 0);
    // 初期位置: 陸地
    const start = pickLandTarget(rng);
    const tgt = pickLandTarget(rng);
    units.push({
      gx: start.x, gy: start.y,
      tx: tgt.x, ty: tgt.y,
      rng,
      face: 0,
      animT: 0,
      sprite: getUnitSprite(),
    });
  }

  function setUnitCount(n) {
    n = clamp(n, UNIT_MIN, UNIT_MAX);
    while (units.length < n) spawnUnit();
    while (units.length > n) {
      const u = units.pop();
      releaseUnit(u.sprite);
    }
    unitSet = n;
  }

  // ---- カメラ（ワールド画面座標のオフセット） ----
  // world.x/y = VIEW中央 - camWorld。camWorld はアイソメ画面座標で保持しクランプ。
  // マップ全体のアイソメ画面 X 範囲: [-(MAP-1)*HW, (MAP-1)*HW], Y: [0, (2*MAP-2)*HH]。
  const camMinX = -(MAP - 1) * HW + VIEW_W / 2;
  const camMaxX =  (MAP - 1) * HW - VIEW_W / 2;
  const camMinY = 0 + VIEW_H / 2;
  const camMaxY = (2 * MAP - 2) * HH - VIEW_H / 2;
  const cam = { x: 0, y: (MAP) * HH };   // ワールド中央あたりから開始

  function clampCam() {
    // 範囲がビューより狭い場合は中央寄せ
    cam.x = (camMinX > camMaxX) ? (camMinX + camMaxX) / 2 : clamp(cam.x, camMinX, camMaxX);
    cam.y = (camMinY > camMaxY) ? (camMinY + camMaxY) / 2 : clamp(cam.y, camMinY, camMaxY);
  }
  clampCam();

  // ---- リセット ----
  function reset() {
    map = generateMap();
    // 地面テクスチャ参照は groundTexByType が map に依存しないので張り直し不要
    buildStaticObjs();
    setUnitCount(UNIT_INIT);
    cam.x = 0; cam.y = MAP * HH;
    clampCam();
  }

  setUnitCount(UNIT_INIT);

  // ---- 入力 ----
  const keys = {};
  let showGrid = false;
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      setUnitCount(unitSet + UNIT_STEP); e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      setUnitCount(unitSet - UNIT_STEP); e.preventDefault();
    } else if (e.code === 'KeyG') {
      showGrid = !showGrid; gridGfx.visible = showGrid;
    } else if (e.code === 'KeyR') {
      reset();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;
  let tilesDrawn = 0;
  let objectsSorted = 0;

  // ---- グリッド線描画（カメラ移動時のみ再構築するのは省略し、トグル時に描く） ----
  // グリッドは world コンテナ内なのでカメラ平行移動に追従する。可視範囲のみ描く。
  function rebuildGrid(minGX, maxGX, minGY, maxGY) {
    gridGfx.clear();
    if (!showGrid) return;
    for (let gx = minGX; gx <= maxGX; gx++) {
      const ax = isoX(gx, minGY), ay = isoY(gx, minGY);
      const bx = isoX(gx, maxGY), by = isoY(gx, maxGY);
      gridGfx.moveTo(ax, ay).lineTo(bx, by);
    }
    for (let gy = minGY; gy <= maxGY; gy++) {
      const ax = isoX(minGX, gy), ay = isoY(minGX, gy);
      const bx = isoX(maxGX, gy), by = isoY(maxGX, gy);
      gridGfx.moveTo(ax, ay).lineTo(bx, by);
    }
    gridGfx.stroke({ width: 1, color: COLORS.grid, alpha: 0.6 });
  }

  // ---- メインループ ----
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05);

    // --- FPS 移動平均 ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // ====================================================================
    // 1) カメラスクロール（矢印 / WASD）＋クランプ
    // ====================================================================
    let dx = 0, dy = 0;
    if (down('ArrowLeft', 'KeyA')) dx -= 1;
    if (down('ArrowRight', 'KeyD')) dx += 1;
    if (down('ArrowUp', 'KeyW')) dy -= 1;
    if (down('ArrowDown', 'KeyS')) dy += 1;
    cam.x += dx * CAM_SPEED * dt;
    cam.y += dy * CAM_SPEED * dt;
    clampCam();
    // world をカメラ分だけ平行移動（画面中央にカメラ点が来る）
    world.x = Math.round(VIEW_W / 2 - cam.x);
    world.y = Math.round(VIEW_H / 2 - cam.y);

    // ====================================================================
    // 2) ユニット更新（決定的徘徊・水回避・40px/s 相当）
    // ====================================================================
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const bx = u.gx, by = u.gy;
      let ddx = u.tx - u.gx;
      let ddy = u.ty - u.gy;
      const dist = Math.hypot(ddx, ddy);
      if (dist < UNIT_REACH) {
        // 目的地到達 → 次の決定的目的地へ
        const t = pickLandTarget(u.rng);
        u.tx = t.x; u.ty = t.y;
      } else {
        const step = UNIT_SPEED * dt;
        const nx = u.gx + (ddx / dist) * step;
        const ny = u.gy + (ddy / dist) * step;
        // 次セルが水なら目的地を選び直す（水回避）
        if (groundAt(map, Math.floor(nx), Math.floor(ny)) === G_WATER) {
          const t = pickLandTarget(u.rng);
          u.tx = t.x; u.ty = t.y;
        } else {
          u.gx = nx; u.gy = ny;
        }
      }
      const mdx = u.gx - bx, mdy = u.gy - by;
      const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
      u.face = unitFaceFromMove(mdx, mdy, u.face);
      u.animT = moving ? (u.animT || 0) + dt : 0;
    }

    // ====================================================================
    // 3) 可視アイソメ範囲を求める（カリング）
    // ====================================================================
    // 画面四隅のワールド座標を gx,gy へ逆投影し、外接するグリッド矩形を取る。
    //   worldX = isoX = (gx-gy)*HW,  worldY = isoY = (gx+gy)*HH
    //   → gx = (worldX/HW + worldY/HH) / 2,  gy = (worldY/HH - worldX/HW) / 2
    const invX = (wx, wy) => (wx / HW + wy / HH) / 2;
    const invY = (wx, wy) => (wy / HH - wx / HW) / 2;
    // ビュー左上(0,0)〜右下(VIEW_W,VIEW_H) を world ローカルへ
    const wl = -world.x, wt = -world.y;
    const wr = wl + VIEW_W, wb = wt + VIEW_H;
    // オブジェクトは背が高い（最大~64px = 4タイル相当 上方向）ので余白を広めに。
    const PAD_TOP = 5, PAD = 2;
    const corners = [
      [invX(wl, wt), invY(wl, wt)],
      [invX(wr, wt), invY(wr, wt)],
      [invX(wl, wb), invY(wl, wb)],
      [invX(wr, wb), invY(wr, wb)],
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

    // ====================================================================
    // 4) 地面カリング描画（ソート不要・プール再利用）
    // ====================================================================
    tilesDrawn = 0;
    let gi = 0;
    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        if (gi >= groundPool.length) break;
        const type = map.ground[gy * MAP + gx];
        const s = groundPool[gi++];
        s.texture = groundTexByType[type];
        s.x = isoX(gx, gy);
        s.y = isoY(gx, gy);
        s.visible = true;
        tilesDrawn++;
      }
    }
    for (let k = gi; k < groundPool.length; k++) groundPool[k].visible = false;

    // ====================================================================
    // 5) オブジェクト/ユニットを可視ぶんだけ objLayer へ割り当て、深度ソート
    // ====================================================================
    // 静的オブジェクト＋ユニットの「可視ぶん」だけスプライトを出し、
    // sprite.zIndex = gx + gy を毎フレーム設定する。
    // objLayer.sortableChildren = true なので Pixi が描画前に zIndex で並べ替える。
    objectsSorted = 0;

    // -- 静的オブジェクト（可視判定） --
    let oi = 0;
    const activeObjSprites = [];
    for (let i = 0; i < staticObjs.length; i++) {
      const o = staticObjs[i];
      if (o.gx < minGX || o.gx > maxGX || o.gy < minGY || o.gy > maxGY) continue;
      let s = objActive[oi];
      if (!s) { s = getObjSprite(); objActive[oi] = s; }
      s.texture = (o.type === O_TREE) ? tex.tree : tex.house;
      s.x = isoX(o.gx, o.gy);
      // 足元（菱形中心）に合わせる: isoY は上頂点なので +HH 下げる
      s.y = isoY(o.gx, o.gy) + HH;
      s.zIndex = o.depth;            // ★ 深度キー = gx + gy
      s.visible = true;
      oi++;
      objectsSorted++;
    }
    // 余ったオブジェクトスプライトを退避
    for (let k = oi; k < objActive.length; k++) { releaseObj(objActive[k]); objActive[k] = null; }
    objActive.length = oi;

    // -- ユニット（連続座標・毎フレーム深度キーが変化） --
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const s = u.sprite;
      const vis = (u.gx >= minGX && u.gx <= maxGX && u.gy >= minGY && u.gy <= maxGY);
      if (!vis) { s.visible = false; continue; }
      s.x = isoX(u.gx, u.gy);
      s.y = isoY(u.gx, u.gy) + HH;   // 足元を菱形中心へ
      s.texture = tex.villagerFrames[(u.face || 0) * 4 + (Math.floor((u.animT || 0) * 8) % 4)];
      // 連続座標の深度キー（毎フレーム変化）。Pixi の sortableChildren が zIndex で並べ替える。
      s.zIndex = u.gx + u.gy;
      s.visible = true;
      objectsSorted++;
    }

    // グリッド（可視範囲）を必要時のみ描く
    if (showGrid) rebuildGrid(minGX, maxGX, minGY, maxGY);

    // ====================================================================
    // 6) HUD（約120msごと更新）
    // ====================================================================
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      // カメラ中心のワールド座標（gx,gy）= ビュー中央の逆投影
      const cgx = invX(cam.x, cam.y);
      const cgy = invY(cam.x, cam.y);
      hudEl.textContent =
        `FPS           : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn   : ${tilesDrawn}\n` +
        `Objects sorted: ${objectsSorted}\n` +
        `Units         : ${units.length} / ${unitSet}\n` +
        `Camera (gx,gy): (${cgx.toFixed(1)}, ${cgy.toFixed(1)})\n` +
        `矢印/WASD=スクロール  +/-=ユニット数  G=グリッド  R=リセット`;
    }
  });

  // three.js 版に合わせ、キャンバスは 960x540 固定（縮小スケールなし）。
  console.log('[PixiJS v8] theme9 isometric init ok. renderer =', app.renderer.type);
})();
