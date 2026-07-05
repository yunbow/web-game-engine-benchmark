/* ============================================================
 * テーマ11 2Dダイナミックライティング / 影 ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠 (960x540 / 30x17 タイル32px の暗い床 /
 *       ambient=0.10 / プレイヤー光源(半径240) + 動的色付き光源(半径160) /
 *       矩形オクルーダ約16個 + 外周壁 / 光源ごとのハードシャドウ /
 *       L=影ON/OFF, +/-=光源数(初期12, ±6, 0..120), R=リセット)。
 *
 * ライティング方式: 自前「ライトマップ」合成 (Lightmap blend)。
 *   ※ Phaser 4.2 の RenderTexture/DynamicTexture.draw はオフスクリーン合成が機能しない
 *     ため、ライトマップ生成は ★オフスクリーン 2D canvas★ で行い、完成画像を CanvasTexture
 *     化して MULTIPLY ブレンドの Image でシーンへ乗算合成する。
 *   1) 暗いシーン(床タイル + 柱 + 外周壁)を Phaser 表示オブジェクト(depth 0/1)で描画。
 *   2) ライトマップ canvas を ambient(0.10 灰)でクリア。
 *   3) 各光源ごとに scratch canvas を使い回し:
 *        クリア → 放射グロー描画 → (影ONなら)矩形オクルーダの影ポリゴンを
 *        黒で塗って光を削る → 'lighter'(加算) で全体ライトマップへ積む。
 *   4) 完成ライトマップを CanvasTexture(refresh)化し、MULTIPLY の Image でシーンへ乗算。
 *
 * 性能比較の核: 同時動的光源数 と 影ON/OFF の描画コスト差
 *   (= 光源数ぶんの scratch バッファ往復 + 影ポリゴン生成)。
 * デルタタイム基準更新 / 数値はすべて SPEC.md に一致 / Math.random 不使用。
 * ============================================================ */

// ---- 基本定数 ----
const TILE = 32;
const MAP_W = 30;              // タイル数 (横)
const MAP_H = 17;              // タイル数 (縦) → 30x17
const VIEW_W = 960;
const VIEW_H = 540;            // 30*32=960, 17*32=544 ≒ 540 (床は544まで敷く)

// ライティング (SPEC.md)
const AMBIENT = 0.10;          // 下地の明るさ
const PLAYER_LIGHT_RADIUS = 240;
const DYN_LIGHT_RADIUS = 160;
const PLAYER_SPEED = 220;      // px/s
const DYN_SPEED = 120;         // px/s 相当の決定的軌道

// プレイヤー当たり判定 (簡易AABB)
const PLAYER_BOX = 22;

// 動的光源数 (負荷)
const INITIAL_LIGHTS = 12;
const LIGHT_STEP = 6;
const MIN_LIGHTS = 0;
const MAX_LIGHTS = 120;

// オクルーダ (柱)
const PILLAR_COUNT = 16;       // 内部の矩形オクルーダ約16個

// フォールバック色
const FLOOR_COLOR = 0x141821;  // 暗い灰
const FLOOR_LINE  = 0x1d2330;
const PILLAR_FILL = 0x55606e;  // 灰の矩形
const PILLAR_EDGE = 0x8893a3;  // 縁

// ---- 決定的疑似乱数 (Mulberry32) ----
// 柱配置・光源軌道・色はすべてこの PRNG で生成し、Math.random は使わない。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// HSV→RGB (0..1) 動的光源の色を彩度高めで決定的に割当てる
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return { r, g, b };
}

// ---- オクルーダ(柱)の決定的生成 ----
// 内部に軸平行の矩形を約16個、固定シードで重なり少なく配置する。
function generatePillars() {
  const rng = mulberry32(0x11A0CC);   // seed 固定
  const pillars = [];
  const margin = 48;                  // 外周壁の内側に余白
  let attempts = 0;
  while (pillars.length < PILLAR_COUNT && attempts < 400) {
    attempts++;
    const w = 24 + Math.floor(rng() * 48);  // 24〜71
    const h = 24 + Math.floor(rng() * 48);
    const x = margin + rng() * (VIEW_W - margin * 2 - w);
    const y = margin + rng() * (VIEW_H - margin * 2 - h);
    const rect = { x, y, w, h };
    // 既存と近すぎる(重なり+12pxパディング)なら棄却
    let ok = true;
    for (const p of pillars) {
      if (x < p.x + p.w + 12 && x + w + 12 > p.x &&
          y < p.y + p.h + 12 && y + h + 12 > p.y) { ok = false; break; }
    }
    // プレイヤー初期位置(中央付近)を塞がない
    const cx = VIEW_W / 2, cy = VIEW_H / 2;
    if (x < cx + 40 && x + w > cx - 40 && y < cy + 40 && y + h > cy - 40) ok = false;
    if (ok) pillars.push(rect);
  }
  return pillars;
}

// ============================================================
// BootScene ― アセット読込 + 失敗キャプチャ
// ============================================================
const ASSET_DEFS = [
  { key: 'tile_floor',  file: 'tile_floor.png' },
  { key: 'pillar',      file: 'pillar.png' },
  { key: 'light_glow',  file: 'light_glow.png' },
  { key: 'player_lamp', file: 'player_lamp.png' },
];
const failedAssets = new Set();

class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  preload() {
    // 画像が無くても起動する: 読込失敗を記録し、後でフォールバックテクスチャを生成。
    this.load.on('loaderror', (fileObj) => { failedAssets.add(fileObj.key); });
    for (const def of ASSET_DEFS) {
      this.load.image(def.key, '../assets/' + def.file);
    }
  }

  create() {
    this.buildFallbackTextures();
    this.scene.start('GameScene');
  }

  // Graphics.generateTexture で図形テクスチャを焼いてフォールバック。
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      if (this.textures.exists(key) && !failedAssets.has(key)) return;
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 床タイル = 暗い灰 (32x32) + 薄いグリッド線
    make('tile_floor', TILE, TILE, (g, w, h) => {
      g.fillStyle(FLOOR_COLOR, 1).fillRect(0, 0, w, h);
      g.lineStyle(1, FLOOR_LINE, 1).strokeRect(0.5, 0.5, w - 1, h - 1);
    });

    // 柱(オクルーダ) = 灰の矩形 + 縁 (64x64, 任意サイズへ拡縮して使う)
    make('pillar', 64, 64, (g, w, h) => {
      g.fillStyle(PILLAR_FILL, 1).fillRect(0, 0, w, h);
      g.lineStyle(2, PILLAR_EDGE, 1).strokeRect(1, 1, w - 2, h - 2);
      g.fillStyle(0x3c4450, 1).fillRect(4, 4, w - 8, 6); // 上面ハイライト
    });

    // 光源グロー = 放射グラデ (256x256, 中心白→外周透明・加算前提)
    // Graphics ではグラデを直接焼けないため Canvas テクスチャで生成する。
    if (failedAssets.has('light_glow') || !this.textures.exists('light_glow')) {
      this.makeRadialGlow('light_glow', 256);
    }

    // プレイヤー = 小さな人型 + 灯り (32x48)
    make('player_lamp', 32, 48, (g, w, h) => {
      g.fillStyle(0x202832, 1).fillRoundedRect(8, 14, w - 16, h - 18, 4); // 胴
      g.fillStyle(0xd0d8e4, 1).fillCircle(w / 2, 10, 7);                  // 頭
      g.fillStyle(0xffe9a8, 1).fillCircle(w - 7, 22, 5);                 // ランタン
      g.lineStyle(2, 0x8893a3, 1).lineBetween(w / 2 + 2, 18, w - 7, 22); // 腕
    });
  }

  // Canvas で放射状グラデーション(白→透明)を焼く。加算合成で点灯する素材。
  makeRadialGlow(key, size) {
    if (this.textures.exists(key)) this.textures.remove(key);
    const tex = this.textures.createCanvas(key, size, size);
    const ctx = tex.getContext();
    const r = size / 2;
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    // smoothstep 風: 中心 1.0 → 外周 0.0 へ滑らかに
    grad.addColorStop(0.00, 'rgba(255,255,255,1.0)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(0.65, 'rgba(255,255,255,0.28)');
    grad.addColorStop(0.85, 'rgba(255,255,255,0.08)');
    grad.addColorStop(1.00, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    tex.refresh();
  }
}

// ============================================================
// GameScene ― 本体 (ライトマップ合成)
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    this.shadowsOn = true;
    this.lightCount = INITIAL_LIGHTS;

    // --- 静的データ生成 ---
    this.pillars = generatePillars();        // 内部オクルーダ
    this.walls = this.buildBorderWalls();    // 外周壁 (影は内側に落ちないが衝突に使用)

    // --- 1) シーン(暗い床 + 柱 + 外周壁)を Phaser 表示オブジェクトとして depth 0/1 に置く ---
    // ※ Phaser 4.2 の RenderTexture/DynamicTexture.draw はオフスクリーン合成が機能しない
    //    ため、シーンは通常の表示オブジェクトで描き、ライトマップ合成は 2D canvas + CanvasTexture
    //    (MULTIPLY ブレンド) で行う(後述)。compositing の核は SPEC 通りの自前ライトマップ。
    this.buildSceneObjects();

    // --- 2) ライトマップ本体 = オフスクリーン 2D canvas (ambient 下地 + 全光源を加算) ---
    //    各光源は scratch canvas に放射グロー描画 →(影ON)影ポリゴンを黒で削る → 'lighter' で加算。
    this.lmCanvas = document.createElement('canvas');
    this.lmCanvas.width = VIEW_W; this.lmCanvas.height = VIEW_H;
    this.lmCtx = this.lmCanvas.getContext('2d');
    this.scCanvas = document.createElement('canvas');   // 光源ごとのスクラッチ
    this.scCanvas.width = VIEW_W; this.scCanvas.height = VIEW_H;
    this.scCtx = this.scCanvas.getContext('2d');

    // 完成ライトマップを CanvasTexture 化し、MULTIPLY ブレンドの Image で
    // シーン(depth 0/1) の上・プレイヤー(depth 2) の上・HUD(depth 1000) の下に重ねる。
    if (this.textures.exists('__lightmap__')) this.textures.remove('__lightmap__');
    this.lmTex = this.textures.addCanvas('__lightmap__', this.lmCanvas);
    this.lmImage = this.add.image(0, 0, '__lightmap__').setOrigin(0, 0).setDepth(5)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);

    // --- プレイヤー (アバター。ライトマップの下=照らされる。HUD の下) ---
    this.player = { x: VIEW_W / 2, y: VIEW_H / 2 };
    this.playerSpr = this.add.image(this.player.x, this.player.y, 'player_lamp').setDepth(2);

    // --- 動的光源 (決定的軌道) ---
    this.buildDynamicLights();

    // --- 入力 ---
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.input.keyboard.on('keydown-PLUS', () => this.adjustLights(+LIGHT_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustLights(-LIGHT_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustLights(+LIGHT_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustLights(-LIGHT_STEP));
    this.input.keyboard.on('keydown-L', () => { this.shadowsOn = !this.shadowsOn; });
    this.input.keyboard.on('keydown-R', () => this.resetAll());

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // ベンチ統計 (影ポリゴン数など)
    this.shadowPolyCount = 0;
  }

  // ============================================================
  // 外周壁 (内側を囲む 4 本の矩形。プレイヤー衝突に使用)
  // ============================================================
  buildBorderWalls() {
    const t = 16; // 壁の厚み
    return [
      { x: 0, y: 0, w: VIEW_W, h: t },                  // 上
      { x: 0, y: VIEW_H - t, w: VIEW_W, h: t },         // 下
      { x: 0, y: 0, w: t, h: VIEW_H },                  // 左
      { x: VIEW_W - t, y: 0, w: t, h: VIEW_H },         // 右
    ];
  }

  // ============================================================
  // シーン構築: 暗い床タイル + 外周壁 + 柱を Phaser 表示オブジェクト(depth 0/1)で置く。
  //   (Phaser 4.2 の RenderTexture.draw は機能しないため通常オブジェクトで描画する)
  // ============================================================
  buildSceneObjects() {
    // 床タイル (30x17 を敷き詰め。544px まで敷いて 540 を満たす)
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        this.add.image(tx * TILE, ty * TILE, 'tile_floor').setOrigin(0, 0).setDepth(0);
      }
    }
    // 外周壁 (暗めに塗る。pillar テクスチャを拡縮して帯状に)
    for (const wll of this.walls) {
      this.add.image(wll.x, wll.y, 'pillar').setOrigin(0, 0)
        .setDisplaySize(wll.w, wll.h).setTint(0x2a3038).setDepth(1);
    }
    // 柱 (オクルーダ。pillar テクスチャを各矩形サイズへ拡縮)
    for (const p of this.pillars) {
      this.add.image(p.x, p.y, 'pillar').setOrigin(0, 0)
        .setDisplaySize(p.w, p.h).setDepth(1);
    }
  }

  // ============================================================
  // 動的光源生成 (決定的軌道 + 決定的色)
  // 軌道タイプ: 0=バウンド(直線反射), 1=円運動(オービット)
  // ============================================================
  buildDynamicLights() {
    this.lights = [];
    const rng = mulberry32(0x71607C); // seed 固定
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const hue = rng();
      const col = hsvToRgb(hue, 0.85, 1.0);
      const type = rng() < 0.5 ? 0 : 1;
      const light = {
        type,
        // 色 (0..255)
        r: Math.round(col.r * 255), g: Math.round(col.g * 255), b: Math.round(col.b * 255),
        tint: (Math.round(col.r * 255) << 16) | (Math.round(col.g * 255) << 8) | Math.round(col.b * 255),
      };
      if (type === 0) {
        // バウンド: 位置 + 速度ベクトル (大きさ DYN_SPEED)
        light.x = 60 + rng() * (VIEW_W - 120);
        light.y = 60 + rng() * (VIEW_H - 120);
        const ang = rng() * Math.PI * 2;
        light.vx = Math.cos(ang) * DYN_SPEED;
        light.vy = Math.sin(ang) * DYN_SPEED;
      } else {
        // オービット: 中心 + 半径 + 角速度
        light.cx = 80 + rng() * (VIEW_W - 160);
        light.cy = 80 + rng() * (VIEW_H - 160);
        light.orbitR = 40 + rng() * 90;
        light.ang = rng() * Math.PI * 2;
        // 角速度は接線速度が ~DYN_SPEED になるよう調整
        light.angVel = (DYN_SPEED / light.orbitR) * (rng() < 0.5 ? 1 : -1);
        light.x = light.cx + Math.cos(light.ang) * light.orbitR;
        light.y = light.cy + Math.sin(light.ang) * light.orbitR;
      }
      this.lights.push(light);
    }
  }

  // ============================================================
  // 光源数増減 / リセット
  // ============================================================
  adjustLights(delta) {
    this.lightCount = Phaser.Math.Clamp(this.lightCount + delta, MIN_LIGHTS, MAX_LIGHTS);
  }

  resetAll() {
    this.shadowsOn = true;
    this.lightCount = INITIAL_LIGHTS;
    this.player.x = VIEW_W / 2;
    this.player.y = VIEW_H / 2;
    this.buildDynamicLights();
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    const style = {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(6,10,16,0.6)',
      padding: { x: 8, y: 6 },
    };
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(1000);
  }

  // ============================================================
  // AABB: プレイヤーが柱/壁に重なるか
  // ============================================================
  hitsOccluder(cx, cy) {
    const half = PLAYER_BOX / 2;
    const l = cx - half, r = cx + half, t = cy - half, b = cy + half;
    const test = (o) => !(r <= o.x || l >= o.x + o.w || b <= o.y || t >= o.y + o.h);
    for (const o of this.pillars) if (test(o)) return true;
    for (const o of this.walls) if (test(o)) return true;
    return false;
  }

  // ============================================================
  // プレイヤー移動 (軸分離簡易AABB, 220px/s)
  // ============================================================
  updatePlayer(dt) {
    const k = this.keys, c = this.cursors;
    let ix = 0, iy = 0;
    if (c.left.isDown || k.A.isDown) ix -= 1;
    if (c.right.isDown || k.D.isDown) ix += 1;
    if (c.up.isDown || k.W.isDown) iy -= 1;
    if (c.down.isDown || k.S.isDown) iy += 1;
    // 斜め移動の正規化
    if (ix !== 0 && iy !== 0) { const inv = Math.SQRT1_2; ix *= inv; iy *= inv; }

    const dx = ix * PLAYER_SPEED * dt;
    const dy = iy * PLAYER_SPEED * dt;
    // X → 解決, Y → 解決
    if (dx !== 0 && !this.hitsOccluder(this.player.x + dx, this.player.y)) this.player.x += dx;
    if (dy !== 0 && !this.hitsOccluder(this.player.x, this.player.y + dy)) this.player.y += dy;

    this.playerSpr.setPosition(this.player.x, this.player.y);
  }

  // ============================================================
  // 動的光源更新 (決定的軌道。柱は通り抜け可)
  // ============================================================
  updateLights(dt) {
    for (let i = 0; i < this.lightCount; i++) {
      const L = this.lights[i];
      if (L.type === 0) {
        L.x += L.vx * dt;
        L.y += L.vy * dt;
        // 画面端でバウンド (反射)
        if (L.x < 24) { L.x = 24; L.vx = Math.abs(L.vx); }
        if (L.x > VIEW_W - 24) { L.x = VIEW_W - 24; L.vx = -Math.abs(L.vx); }
        if (L.y < 24) { L.y = 24; L.vy = Math.abs(L.vy); }
        if (L.y > VIEW_H - 24) { L.y = VIEW_H - 24; L.vy = -Math.abs(L.vy); }
      } else {
        L.ang += L.angVel * dt;
        L.x = L.cx + Math.cos(L.ang) * L.orbitR;
        L.y = L.cy + Math.sin(L.ang) * L.orbitR;
      }
    }
  }

  // ============================================================
  // 影ポリゴン: 1 つの矩形オクルーダが 1 光源に落とす影を 2D ctx に黒で塗る。
  //   光源側を向いていない辺(シルエット辺)の端点を、光源から遠ざかる方向へ
  //   光半径を超えて延長し、影の四角形を作る。これを黒で塗って光を削る。
  // ============================================================
  castRectShadow(ctx, lx, ly, rect, radius) {
    const v = [
      { x: rect.x,          y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x,          y: rect.y + rect.h },
    ];
    const ext = radius * 2.2; // 光半径を超えて十分に延長
    const project = (p) => {
      const dx = p.x - lx, dy = p.y - ly;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * ext, y: p.y + (dy / len) * ext };
    };
    for (let i = 0; i < 4; i++) {
      const a = v[i];
      const b = v[(i + 1) % 4];
      const ex = b.x - a.x, ey = b.y - a.y;
      const nx = ey, ny = -ex; // 右回り外向き法線
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const toLx = lx - mx, toLy = ly - my;
      // 法線・光方向の内積が負 = 辺は光に背を向ける = この辺が影を落とす
      if (nx * toLx + ny * toLy < 0) {
        const pa = project(a), pb = project(b);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.lineTo(pb.x, pb.y); ctx.lineTo(pa.x, pa.y);
        ctx.closePath(); ctx.fill();
        this.shadowPolyCount++;
      }
    }
  }

  // ============================================================
  // 1 光源の寄与を scratch canvas に作り、ライトマップへ 'lighter'(加算) で積む。
  //   scratch クリア → 放射グロー描画 → (影ON)影ポリゴンを黒で削る → lighter で加算。
  // ============================================================
  renderLight(lx, ly, r, cr, cg, cb, intensity) {
    const sc = this.scCtx;
    sc.globalCompositeOperation = 'source-over';
    sc.clearRect(0, 0, VIEW_W, VIEW_H);

    // 放射グロー (中心 → 半径で 0 へ。smoothstep 風)
    const grad = sc.createRadialGradient(lx, ly, 0, lx, ly, r);
    const a0 = intensity;
    grad.addColorStop(0.00, `rgba(${cr},${cg},${cb},${a0})`);
    grad.addColorStop(0.35, `rgba(${cr},${cg},${cb},${0.65 * a0})`);
    grad.addColorStop(0.70, `rgba(${cr},${cg},${cb},${0.22 * a0})`);
    grad.addColorStop(1.00, `rgba(${cr},${cg},${cb},0.0)`);
    sc.fillStyle = grad;
    sc.beginPath(); sc.arc(lx, ly, r, 0, Math.PI * 2); sc.fill();

    // 影: 各オクルーダの影ポリゴン(黒)で光を削る + 柱本体も暗く。
    if (this.shadowsOn) {
      sc.fillStyle = '#000';
      for (const rect of this.pillars) {
        // 早期カリング: 光半径に掛からない柱は無視
        const nearX = Math.max(rect.x, Math.min(lx, rect.x + rect.w));
        const nearY = Math.max(rect.y, Math.min(ly, rect.y + rect.h));
        if (Math.hypot(lx - nearX, ly - nearY) > r) continue;
        if (lx > rect.x && lx < rect.x + rect.w && ly > rect.y && ly < rect.y + rect.h) continue;
        this.castRectShadow(sc, lx, ly, rect, r);
      }
      for (const rect of this.pillars) sc.fillRect(rect.x, rect.y, rect.w, rect.h);
    }

    // scratch(= 影込みのこの光源の寄与) を全体ライトマップへ加算
    this.lmCtx.globalCompositeOperation = 'lighter';
    this.lmCtx.drawImage(this.scCanvas, 0, 0);
    this.lmCtx.globalCompositeOperation = 'source-over';
  }

  // ============================================================
  // ライトマップ合成: ambient 下地 → 全光源を加算 → CanvasTexture を更新。
  //   (CanvasTexture を MULTIPLY ブレンドの Image でシーンへ乗算合成: lmImage)
  // ============================================================
  renderLightmap() {
    this.shadowPolyCount = 0;

    // 下地: ambient(0.10) の灰でフィル。乗算で残る最低限の明るさ。
    const a = Math.round(AMBIENT * 255);
    this.lmCtx.globalCompositeOperation = 'source-over';
    this.lmCtx.fillStyle = `rgb(${a},${a},${a})`;
    this.lmCtx.fillRect(0, 0, VIEW_W, VIEW_H);

    // 動的光源 (色付き, 半径160)
    for (let i = 0; i < this.lightCount; i++) {
      const L = this.lights[i];
      this.renderLight(L.x, L.y, DYN_LIGHT_RADIUS, L.r, L.g, L.b, 0.9);
    }
    // プレイヤー光源 (白, 半径240) ― 常に 1 つ別枠
    this.renderLight(this.player.x, this.player.y, PLAYER_LIGHT_RADIUS, 255, 242, 216, 1.0);

    // 完成ライトマップを GPU テクスチャへ反映。
    this.lmTex.refresh();
  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒 (スパイク抑制)

    // FPS 移動平均
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    this.updatePlayer(dt);
    this.updateLights(dt);

    // ライトマップ合成 (本フレームの描画負荷の核)
    this.renderLightmap();

    this.updateHUD();
  }

  updateHUD() {
    this.hud.setText([
      `FPS      : ${this.fpsAvg.toFixed(1)}`,
      `Lights   : ${this.lightCount} / ${MAX_LIGHTS}  (+player 1)`,
      `Occluders: ${this.pillars.length}`,
      `Shadows  : ${this.shadowsOn ? 'ON' : 'OFF'}`,
      `Mode     : Lightmap(canvas add → CanvasTexture Multiply)`,
      `Ambient  : ${AMBIENT.toFixed(2)}`,
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
  backgroundColor: '#06080c',
  scene: [BootScene, GameScene],
  render: { antialias: true, roundPixels: false },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
