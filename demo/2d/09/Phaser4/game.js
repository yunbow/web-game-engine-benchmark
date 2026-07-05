/* ============================================================
 * テーマ9 アイソメトリック都市/農場（深度ソート × タイル奥行き描画）― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠。
 *   - アイソメ投影 (TILE_W=64, TILE_H=32):
 *       screenX = (gx - gy) * (TILE_W/2) = (gx - gy) * 32
 *       screenY = (gx + gy) * (TILE_H/2) = (gx + gy) * 16
 *   - 深度キー = gx + gy（小さいほど奥＝先に描く / 大きいほど手前＝後に描く）。
 *     Phaser の `depth`（setDepth）で z-order を実現する。
 *   - 2層方式: 地面タイル（高さ0・重ならないのでソート不要、可視カリングのみ）
 *     → 高さのあるオブジェクト（木/家）＋ユニットを gx+gy で毎フレーム再ソート。
 *
 * 画面 960x540 固定 / マップ 64x64（決定的生成・固定シード）/ デルタタイム基準更新。
 * 性能比較の核: 斜め投影＋毎フレームの可視オブジェクト＋ユニットの前後ソートコスト。
 * ============================================================ */

// ---- 基本定数 ----
const VIEW_W = 960;
const VIEW_H = 540;

const TILE_W = 64;             // アイソメ菱形の幅
const TILE_H = 32;             // アイソメ菱形の高さ
const HALF_W = TILE_W / 2;     // 32
const HALF_H = TILE_H / 2;     // 16

const MAP_N = 64;              // マップ 64x64 タイル

// 地面種別: 0=草(grass) 1=土/畑(soil) 2=水(water)
const T_GRASS = 0, T_SOIL = 1, T_WATER = 2;

// ユニット (負荷)
const INITIAL_UNITS = 60;
const UNIT_STEP = 20;
const MIN_UNITS = 0;
const MAX_UNITS = 2000;
const UNIT_SPEED = 40;         // 40 px/s 相当（グリッド連続座標で移動）

// フォールバック色
const C_GRASS = 0x5a9e3a;
const C_SOIL  = 0x9c6b3a;
const C_WATER = 0x3a6bbf;

// ---- アイソメ投影ヘルパ ----
// グリッド座標(gx,gy) → 画面ローカル座標（カメラオフセット未適用のワールド座標）。
// screenY は SPEC の通り菱形の「上頂点」基準ではなく中心基準で扱い、原点ずらしは描画側で吸収。
function isoX(gx, gy) { return (gx - gy) * HALF_W; }
function isoY(gx, gy) { return (gx + gy) * HALF_H; }

// ---- 決定的疑似乱数 (Mulberry32) ----
// マップ・オブジェクト散布・ユニット初期配置/巡回はすべてこの PRNG で生成し Math.random 不使用。
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
// 地面種別配列と静的オブジェクト（木/家）の散布を固定シードで生成する。
function generateMap() {
  const rng = mulberry32(0x9C17A); // seed 固定
  const ground = new Uint8Array(MAP_N * MAP_N);
  const idx = (gx, gy) => gy * MAP_N + gx;

  // --- 地面: 値ノイズ風の決定的フィールドで草/土/水を割り当て ---
  // 単純な格子点の決定的ハッシュを双線形補間してなだらかな分布を作る。
  const GRID = 8;                 // ノイズ格子の粗さ
  const gc = MAP_N / GRID + 2;    // 制御点数
  const ctrl = new Float32Array(gc * gc);
  for (let j = 0; j < gc; j++) {
    for (let i = 0; i < gc; i++) ctrl[j * gc + i] = rng();
  }
  const sample = (gx, gy) => {
    const fx = gx / GRID, fy = gy / GRID;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const a = ctrl[iy * gc + ix],     b = ctrl[iy * gc + ix + 1];
    const c = ctrl[(iy + 1) * gc + ix], d = ctrl[(iy + 1) * gc + ix + 1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };
  for (let gy = 0; gy < MAP_N; gy++) {
    for (let gx = 0; gx < MAP_N; gx++) {
      const v = sample(gx, gy);
      let t;
      if (v < 0.34) t = T_WATER;        // 低い所＝水（池/川）
      else if (v < 0.55) t = T_SOIL;    // 中間＝畑/土
      else t = T_GRASS;                 // 高い所＝草地
      ground[idx(gx, gy)] = t;
    }
  }

  // --- 静的オブジェクト（木/家）の散布 ---
  // 水タイルには置かない。家は草/土どちらでも、木は主に草地に。1タイル1オブジェクト。
  // kind: 0=木(tree) 1=家(house)
  const objects = [];
  const occupied = new Uint8Array(MAP_N * MAP_N);
  const orng = mulberry32(0x70B1EC75); // オブジェクト散布専用 seed
  for (let gy = 1; gy < MAP_N - 1; gy++) {
    for (let gx = 1; gx < MAP_N - 1; gx++) {
      const t = ground[idx(gx, gy)];
      if (t === T_WATER) continue;
      const r = orng();
      if (t === T_GRASS && r < 0.10) {
        objects.push({ gx, gy, kind: 0 }); // 木
        occupied[idx(gx, gy)] = 1;
      } else if (r > 0.985) {
        objects.push({ gx, gy, kind: 1 }); // 家（やや稀に）
        occupied[idx(gx, gy)] = 1;
      }
    }
  }

  return { ground, idx, objects, occupied };
}

// ============================================================
// BootScene ― アセット読込 + 失敗キャプチャ
// ============================================================
const ASSET_DEFS = [
  { key: 'tile_grass', file: 'tile_grass.png' },
  { key: 'tile_soil',  file: 'tile_soil.png' },
  { key: 'tile_water', file: 'tile_water.png' },
  { key: 'tree',       file: 'tree.png' },
  { key: 'house',      file: 'house.png' },
  { key: 'villager',   file: 'villager.png', frameWidth: 24, frameHeight: 32 },
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

  // Graphics.generateTexture で図形テクスチャを焼いてフォールバック。
  // 地面はアイソメ菱形（4頂点ポリゴン）、木=茶幹+緑円、家=灰菱形柱、ユニット=橙丸。
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      if (this.textures.exists(key) && !failedAssets.has(key)) return; // 正常ロード済み
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 菱形ポリゴン（64x32）。原点は左上、菱形は (0,16)-(32,0)-(64,16)-(32,32)。
    const diamond = (g, w, h, fill, top) => {
      g.fillStyle(fill, 1);
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.lineTo(w, h / 2);
      g.lineTo(w / 2, h);
      g.lineTo(0, h / 2);
      g.closePath();
      g.fillPath();
      // 上面の縁取り（奥行きが分かるよう薄く）
      g.lineStyle(1, 0x000000, 0.18);
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.lineTo(w, h / 2);
      g.lineTo(w / 2, h);
      g.lineTo(0, h / 2);
      g.closePath();
      g.strokePath();
      if (top !== undefined) {
        // 上半分にハイライト（質感）
        g.fillStyle(top, 0.25);
        g.beginPath();
        g.moveTo(w / 2, 0);
        g.lineTo(w, h / 2);
        g.lineTo(w / 2, h / 2);
        g.lineTo(0, h / 2);
        g.closePath();
        g.fillPath();
      }
    };

    make('tile_grass', TILE_W, TILE_H, (g, w, h) => diamond(g, w, h, C_GRASS, 0x8ad06a));
    make('tile_soil',  TILE_W, TILE_H, (g, w, h) => diamond(g, w, h, C_SOIL,  0xc99a66));
    make('tile_water', TILE_W, TILE_H, (g, w, h) => diamond(g, w, h, C_WATER, 0x6fa3e0));

    // 木 (48x64): 足元が菱形中心に来るよう下端中央に幹。茶幹 + 緑円。
    make('tree', 48, 64, (g, w, h) => {
      g.fillStyle(0x6b4423, 1).fillRect(w / 2 - 4, h - 22, 8, 22);     // 幹
      g.fillStyle(0x2f7d2f, 1).fillCircle(w / 2, h - 30, 18);          // 葉（暗）
      g.fillStyle(0x49a049, 1).fillCircle(w / 2 - 5, h - 36, 12);      // 葉（明）
      g.fillStyle(0x6fc46f, 0.7).fillCircle(w / 2 + 6, h - 30, 9);
    });

    // 家 (64x64): 灰の菱形柱（アイソメ風の箱）。足元が菱形中心。
    make('house', 64, 64, (g, w, h) => {
      const cx = w / 2;
      const baseY = h;            // 足元（菱形の中心相当）
      const dw = 28, dh = 14;     // 屋根菱形の半幅/半高
      const wallH = 26;           // 壁の高さ
      const topY = baseY - 12;    // 壁下端の菱形中心 y
      // 左壁
      g.fillStyle(0x8a8f96, 1);
      g.beginPath();
      g.moveTo(cx - dw, topY - dh);
      g.lineTo(cx,      topY);
      g.lineTo(cx,      topY - wallH);
      g.lineTo(cx - dw, topY - dh - wallH);
      g.closePath(); g.fillPath();
      // 右壁
      g.fillStyle(0x6f757c, 1);
      g.beginPath();
      g.moveTo(cx + dw, topY - dh);
      g.lineTo(cx,      topY);
      g.lineTo(cx,      topY - wallH);
      g.lineTo(cx + dw, topY - dh - wallH);
      g.closePath(); g.fillPath();
      // 屋根（菱形）
      g.fillStyle(0xb05a3a, 1);
      g.beginPath();
      g.moveTo(cx,      topY - wallH - dh);
      g.lineTo(cx + dw, topY - dh - wallH);
      g.lineTo(cx,      topY - wallH);
      g.lineTo(cx - dw, topY - dh - wallH);
      g.closePath(); g.fillPath();
    });

    // ユニット (24x32): 橙丸 + 影。足元が画像下端中央。
    make('villager', 24, 32, (g, w, h) => {
      g.fillStyle(0x000000, 0.2).fillEllipse(w / 2, h - 3, 16, 6); // 影
      g.fillStyle(0xff8a2b, 1).fillCircle(w / 2, h - 14, 8);       // 体
      g.fillStyle(0xffd0a0, 1).fillCircle(w / 2, h - 22, 5);       // 頭
    });
  }
}

// ============================================================
// GameScene ― 本体
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    this.resetState();
    this.buildWorld();
    this.buildInput();
    this.buildHUD();

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;
  }

  // 状態の初期化（リセットでも使う）
  resetState() {
    const map = generateMap();
    this.ground = map.ground;
    this.idxOf = map.idx;
    this.objectDefs = map.objects;   // 静的オブジェクト（木/家）の決定的配置
    this.occupied = map.occupied;

    this.setUnits = INITIAL_UNITS;   // 設定値
    this.tilesDrawn = 0;
    this.objectsSorted = 0;
    this.showGrid = false;

    // カメラ中心のワールド（グリッド）座標。中心はマップ中央スタート。
    this.camGX = MAP_N / 2;
    this.camGY = MAP_N / 2;
  }

  buildWorld() {
    // --- レイヤ構成 ---
    // 地面は深度 0 の Blitter 群（種別ごと）。可視カリングのみ・ソート不要。
    // オブジェクト/ユニットは深度 10 以降の Image プールで、毎フレーム gx+gy を depth に設定。
    this.cameras.main.setBackgroundColor('#1b2a17');

    // 地面: 種別ごとに Blitter（単一テクスチャ + 多数 Bob を高速バッチ）
    this.tileTex = { [T_GRASS]: 'tile_grass', [T_SOIL]: 'tile_soil', [T_WATER]: 'tile_water' };
    this.terrainBlitters = {};
    [T_GRASS, T_SOIL, T_WATER].forEach((t) => {
      const b = this.add.blitter(0, 0, this.tileTex[t]).setDepth(0);
      this.terrainBlitters[t] = b;
    });

    // グリッド線オーバレイ（G トグル）
    this.gridGfx = this.add.graphics().setDepth(5).setVisible(false);

    // ユニット: 連続グリッド座標 + 巡回状態を持つ論理データ。
    this.units = [];
    // 描画プール: 静的オブジェクト＋ユニットを「深度ソート後の並び」で使い回す共有 Image プール。
    // 1 つのプールに混在させ depth=gx+gy を付けることで前後関係を一括管理する。
    this.spritePool = [];

    this.buildUnits();   // 初期ユニット生成（決定的）
  }

  // ユニットを設定値ぶん決定的に生成/トリムする。
  buildUnits() {
    const want = this.setUnits;
    // 既存より少なければ末尾トリム
    if (this.units.length > want) {
      this.units.length = want;
    } else {
      // 不足ぶんを決定的に追加
      for (let i = this.units.length; i < want; i++) {
        this.units.push(this.makeUnit(i));
      }
    }
  }

  // index ごとに安定したユニット（位置・最初の目的地）を生成。
  makeUnit(index) {
    // index を seed に混ぜた PRNG で、増減しても配置が決定的に再現される。
    const r = mulberry32(0x5E1D17 ^ (index * 0x9E3779B1));
    // 非水タイルを初期位置に選ぶ（数回試行）。
    let gx = 1 + Math.floor(r() * (MAP_N - 2));
    let gy = 1 + Math.floor(r() * (MAP_N - 2));
    for (let tries = 0; tries < 8 && this.ground[this.idxOf(gx, gy)] === T_WATER; tries++) {
      gx = 1 + Math.floor(r() * (MAP_N - 2));
      gy = 1 + Math.floor(r() * (MAP_N - 2));
    }
    const u = { gx, gy, tgx: gx, tgy: gy, rng: r, face: 0, animT: 0 };
    this.pickWaypoint(u);
    return u;
  }

  // 次の決定的な目的地（非水タイル）を選ぶ。
  pickWaypoint(u) {
    const r = u.rng;
    for (let tries = 0; tries < 10; tries++) {
      const tx = 1 + Math.floor(r() * (MAP_N - 2));
      const ty = 1 + Math.floor(r() * (MAP_N - 2));
      if (this.ground[this.idxOf(tx, ty)] !== T_WATER) {
        u.tgx = tx; u.tgy = ty;
        return;
      }
    }
    // 全部水だった場合は現在地維持
    u.tgx = u.gx; u.tgy = u.gy;
  }

  unitFaceFromMove(dx, dy, current = 0) {
    if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) return current;
    const sx = dx - dy;
    const sy = dx + dy;
    if (Math.abs(sx) > Math.abs(sy)) return sx < 0 ? 2 : 3;
    return sy < 0 ? 1 : 0;
  }

  buildInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
    });
    // +/- でユニット数調整（テンキー対応）
    this.input.keyboard.on('keydown-PLUS', () => this.adjustUnits(+UNIT_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustUnits(-UNIT_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustUnits(+UNIT_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustUnits(-UNIT_STEP));
    this.input.keyboard.on('keydown-G', () => { this.showGrid = !this.showGrid; this.gridGfx.setVisible(this.showGrid); });
    this.input.keyboard.on('keydown-R', () => this.resetScene());
  }

  adjustUnits(delta) {
    this.setUnits = Phaser.Math.Clamp(this.setUnits + delta, MIN_UNITS, MAX_UNITS);
    this.buildUnits();
  }

  resetScene() {
    // プールを破棄して作り直し（決定的に同じ初期状態へ）。
    this.spritePool.forEach((o) => o.destroy());
    this.gridGfx.clear();
    Object.values(this.terrainBlitters).forEach((b) => b.clear());
    this.resetState();
    this.spritePool = [];
    this.units = [];
    this.gridGfx.setVisible(false);
    this.buildUnits();
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
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(10000);
  }

  // ============================================================
  // 画面オフセット（カメラ）
  // 画面中央にワールド中心(camGX,camGY)が来るようオフセットを決める。
  // worldScreen(gx,gy) = isoX/Y + offset。
  // ============================================================
  cameraOffset() {
    const ox = VIEW_W / 2 - isoX(this.camGX, this.camGY);
    const oy = VIEW_H / 2 - isoY(this.camGX, this.camGY);
    return { ox, oy };
  }

  // ============================================================
  // 地面カリング: 画面に入るアイソメ範囲のタイルだけ Blitter に再構築。
  // 画面四隅を逆投影してグリッド範囲(gx,gy)を AABB で囲み、その矩形を走査する。
  // ============================================================
  cullGround(ox, oy) {
    // 逆投影: screenX = (gx-gy)*32, screenY = (gx+gy)*16
    //   gx = sx/64 + sy/32 ,  gy = sy/32 - sx/64   （sx,sy はオフセット除去後）
    const inv = (px, py) => {
      const sx = px - ox, sy = py - oy;
      return { gx: sx / TILE_W + sy / TILE_H, gy: sy / TILE_H - sx / TILE_W };
    };
    // 画面四隅（オブジェクトの背高ぶん上下に余白）
    const margin = 96;
    const corners = [
      inv(-margin, -margin), inv(VIEW_W + margin, -margin),
      inv(-margin, VIEW_H + margin), inv(VIEW_W + margin, VIEW_H + margin),
    ];
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    for (const c of corners) {
      gx0 = Math.min(gx0, c.gx); gx1 = Math.max(gx1, c.gx);
      gy0 = Math.min(gy0, c.gy); gy1 = Math.max(gy1, c.gy);
    }
    gx0 = Math.max(0, Math.floor(gx0)); gx1 = Math.min(MAP_N - 1, Math.ceil(gx1));
    gy0 = Math.max(0, Math.floor(gy0)); gy1 = Math.min(MAP_N - 1, Math.ceil(gy1));

    this.cullRange = { gx0, gx1, gy0, gy1 };

    // 範囲が前フレームと同じなら Blitter 再構築は不要（offset は描画位置を都度動かすため
    // ここでは「どのタイルが可視か」が同じなら作り直さない最適化はせず、毎フレーム作る）。
    Object.values(this.terrainBlitters).forEach((b) => b.clear());
    let drawn = 0;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const t = this.ground[this.idxOf(gx, gy)];
        // Bob の位置: 菱形テクスチャ左上が (isoX-32, isoY-16) に来るよう配置（中心合わせ）。
        const px = isoX(gx, gy) + ox - HALF_W;
        const py = isoY(gx, gy) + oy - HALF_H;
        this.terrainBlitters[t].create(px, py);
        drawn++;
      }
    }
    this.tilesDrawn = drawn;
  }

  // ============================================================
  // オブジェクト＋ユニットの再ソート（ベンチの核）
  // 可視ぶんだけ集めて gx+gy 昇順に並べ、プール Image に depth=gx+gy を設定する。
  // ============================================================
  drawSorted(ox, oy) {
    const { gx0, gx1, gy0, gy1 } = this.cullRange;
    // オブジェクトのアイソメは背が高いので可視判定に余裕を持たせる。
    const list = [];

    // --- 静的オブジェクト（可視ぶん） ---
    for (const o of this.objectDefs) {
      if (o.gx < gx0 - 1 || o.gx > gx1 + 1 || o.gy < gy0 - 1 || o.gy > gy1 + 1) continue;
      list.push({ key: o.kind === 0 ? 'tree' : 'house', gx: o.gx, gy: o.gy, kind: o.kind });
    }

    // --- ユニット（連続座標。毎フレーム gx+gy が変わる＝再ソート対象） ---
    for (const u of this.units) {
      if (u.gx < gx0 - 1 || u.gx > gx1 + 1 || u.gy < gy0 - 1 || u.gy > gy1 + 1) continue;
      list.push({ key: 'villager', gx: u.gx, gy: u.gy, kind: 2, face: u.face || 0, animT: u.animT || 0 });
    }

    // --- gx+gy 昇順に安定ソート（同値は kind で安定化）---
    list.sort((a, b) => {
      const da = a.gx + a.gy, db = b.gx + b.gy;
      if (da !== db) return da - db;
      return a.kind - b.kind;
    });

    // --- プール Image に反映。depth = gx+gy（＋並び順の微小オフセットで安定化） ---
    const n = list.length;
    // プールを必要数まで拡張
    while (this.spritePool.length < n) {
      const img = this.add.image(0, 0, 'villager').setVisible(false);
      this.spritePool.push(img);
    }
    for (let i = 0; i < n; i++) {
      const e = list[i];
      const img = this.spritePool[i];
      const px = isoX(e.gx, e.gy) + ox;
      const py = isoY(e.gx, e.gy) + oy;
      if (img.texture.key !== e.key) img.setTexture(e.key);
      if (e.key === 'villager') img.setFrame((e.face || 0) * 4 + (Math.floor((e.animT || 0) * 8) % 4));
      // 足元を菱形中心に合わせる: 各テクスチャの origin を下端中央寄りに。
      img.setOrigin(0.5, 1);
      img.setPosition(px, py + HALF_H); // 菱形の床（中心の下端）に足を置く
      img.setDepth(10 + (e.gx + e.gy) + i * 1e-4);
      img.setVisible(true);
    }
    // 余剰プールを隠す
    for (let i = n; i < this.spritePool.length; i++) this.spritePool[i].setVisible(false);

    this.objectsSorted = n;
  }

  // ============================================================
  // ユニット更新: 目的地へ 40px/s 相当で直進。着いたら次の決定的目的地へ。水は避ける。
  // グリッド連続座標で移動（画面 px ではなくグリッド差分を速度換算）。
  // 40px/s は画面スクリーン上の速さ。アイソメ 1 グリッド ≈ sqrt(32^2+16^2)=~35.8px のため
  // グリッド速度に換算して進める。
  // ============================================================
  updateUnits(dt) {
    // 画面 40px/s をグリッド速度へ。アイソメで 1 グリッド進む画面距離 ~35.78px。
    const gridSpeed = (UNIT_SPEED / 35.777) * dt;
    for (const u of this.units) {
      const bx = u.gx, by = u.gy;
      let dx = u.tgx - u.gx;
      let dy = u.tgy - u.gy;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.05) {
        this.pickWaypoint(u);     // 到着 → 次の目的地
        continue;
      }
      const step = Math.min(gridSpeed, dist);
      const nx = u.gx + (dx / dist) * step;
      const ny = u.gy + (dy / dist) * step;
      // 水タイルを避ける: 次セルが水なら目的地を選び直す（その場で停止し再ターゲット）。
      const cx = Math.round(nx), cy = Math.round(ny);
      if (cx >= 0 && cy >= 0 && cx < MAP_N && cy < MAP_N &&
          this.ground[this.idxOf(cx, cy)] === T_WATER) {
        this.pickWaypoint(u);
        continue;
      }
      u.gx = nx; u.gy = ny;
      const mdx = u.gx - bx, mdy = u.gy - by;
      const moving = Math.abs(mdx) > 1e-5 || Math.abs(mdy) > 1e-5;
      u.face = this.unitFaceFromMove(mdx, mdy, u.face);
      u.animT = moving ? (u.animT || 0) + dt : 0;
    }
  }

  // グリッド線オーバレイ（可視範囲のみ）。
  drawGrid(ox, oy) {
    if (!this.showGrid) return;
    const { gx0, gx1, gy0, gy1 } = this.cullRange;
    const g = this.gridGfx;
    g.clear();
    g.lineStyle(1, 0xffffff, 0.18);
    // gx 一定の線
    for (let gx = gx0; gx <= gx1 + 1; gx++) {
      g.beginPath();
      g.moveTo(isoX(gx, gy0) + ox, isoY(gx, gy0) + oy);
      g.lineTo(isoX(gx, gy1 + 1) + ox, isoY(gx, gy1 + 1) + oy);
      g.strokePath();
    }
    // gy 一定の線
    for (let gy = gy0; gy <= gy1 + 1; gy++) {
      g.beginPath();
      g.moveTo(isoX(gx0, gy) + ox, isoY(gx0, gy) + oy);
      g.lineTo(isoX(gx1 + 1, gy) + ox, isoY(gx1 + 1, gy) + oy);
      g.strokePath();
    }
  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒（スパイク抑制）

    // FPS 移動平均（30 サンプル）
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    // --- カメラスクロール（矢印 / WASD）。中心をワールド内にクランプ ---
    const k = this.keys, c = this.cursors;
    const camSpeed = 14 * dt; // グリッド/秒
    let mgx = 0, mgy = 0;
    // 画面上下左右に対し、アイソメでは (gx,gy) 双方を動かすと直感的にスクロールする。
    if (c.up.isDown || k.W.isDown)    { mgx -= 1; mgy -= 1; }
    if (c.down.isDown || k.S.isDown)  { mgx += 1; mgy += 1; }
    if (c.left.isDown || k.A.isDown)  { mgx -= 1; mgy += 1; }
    if (c.right.isDown || k.D.isDown) { mgx += 1; mgy -= 1; }
    if (mgx || mgy) {
      this.camGX = Phaser.Math.Clamp(this.camGX + mgx * camSpeed, 0, MAP_N - 1);
      this.camGY = Phaser.Math.Clamp(this.camGY + mgy * camSpeed, 0, MAP_N - 1);
    }

    // --- ユニット更新（連続座標が動く＝毎フレーム再ソートが必要に）---
    this.updateUnits(dt);

    // --- 描画オフセット ---
    const { ox, oy } = this.cameraOffset();

    // --- 2層描画: 地面カリング → オブジェクト+ユニットの再ソート ---
    this.cullGround(ox, oy);
    this.drawSorted(ox, oy);
    this.drawGrid(ox, oy);

    this.updateHUD();
  }

  updateHUD() {
    this.hud.setText([
      `FPS          : ${this.fpsAvg.toFixed(1)}`,
      `Tiles drawn  : ${this.tilesDrawn}`,
      `Objects sorted: ${this.objectsSorted}`,
      `Units        : ${this.units.length} / ${this.setUnits}`,
      `camera world : (${this.camGX.toFixed(1)}, ${this.camGY.toFixed(1)})`,
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
  backgroundColor: '#1b2a17',
  scene: [BootScene, GameScene],
  render: { antialias: false, roundPixels: true, pixelArt: true },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
