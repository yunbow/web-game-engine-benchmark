/* =========================================================================
 * テーマ11 2Dダイナミックライティング / 影（ライトマップ × 多光源 × 影）― PixiJS v8 実装
 * 仕様: 11/SPEC.md
 *   960x540 / 30x17 タイル(32px) の暗い床 / 約16個の矩形オクルーダ(柱)＋外周壁。
 *   ambient=0.10 を下地に、全光源を「加算」でライトバッファへ積み、
 *   完成したライトバッファを描画済みシーン(床＋柱)へ「乗算」で重ねる。
 *   各光源はオクルーダ背後を「影ポリゴン(黒)」で削ってから加算する(ハードシャドウ)。
 *
 * --- PixiJS でのライトマップ実装の核(v8) ---
 *   PixiJS は描画ライブラリのため、ライティングは自前のオフスクリーン合成で組む:
 *     1) シーン(床＋柱)を stage に普通に描く。
 *     2) RenderTexture「lightRT」に、ambient の下地を引いた後、各光源の寄与を
 *        blendMode:'add' で積む。光源1個ぶんは「スクラッチRT」に放射グロー→影ポリ(黒)で
 *        削る→ lightRT へ加算、という往復。スクラッチRTはプールして使い回す。
 *     3) lightRT を Sprite にして blendMode:'multiply' でシーンに重ねる。
 *   描画指示は app.renderer.render({ container, target: renderTexture }) を使う。
 *
 * すべて自前実装:
 *   - ゲームループ (PIXI.Ticker の deltaMS でデルタタイム駆動)
 *   - キーボード入力 / AABB 当たり判定 (プレイヤー vs 柱/壁)
 *   - 光源の決定的軌道 (mulberry32, Math.random 不使用)
 *   - ライトマップ合成 (RenderTexture + add/multiply ブレンド + 影ポリゴン生成)
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const TILE = 32;
const MAP_W = 30;
const MAP_H = 17;
const VIEW_W = 960;
const VIEW_H = 540;             // 30x17 タイル = 960x544。表示は 540 にクランプ。
const ROOM_W = MAP_W * TILE;    // 960
const ROOM_H = MAP_H * TILE;    // 544

// ライティング
const AMBIENT = 0.10;           // 下地の明るさ
const PLAYER_LIGHT_RADIUS = 240;
const DYN_LIGHT_RADIUS = 160;

// プレイヤー (当たり判定 22x22 / 描画 24x36)
const P_W = 22, P_H = 22;
const P_DRAW_W = 24, P_DRAW_H = 36;
const P_SPEED = 220;            // px/s

// 動的光源 (負荷の主役)
const LIGHT_INIT = 12;
const LIGHT_STEP = 6;
const LIGHT_MIN = 0;
const LIGHT_MAX = 120;
const DYN_LIGHT_SPEED = 120;    // px/s 相当の決定的軌道

// オクルーダ(柱)生成
const OCCLUDER_COUNT = 16;
const SHADOW_PROJECT = 2000;    // 影ポリゴンを光源から遠方へ延ばす距離(光半径より十分大)

// 決定的シード
const SEED_OCCLUDER = 0x11AA11;
const SEED_LIGHTS = 0x51E0;

// フォールバック色
const COLORS = {
  floor:   0x161a22,   // 暗い床タイル
  floor2:  0x12151c,   // 床の市松(暗)
  pillar:  0x4a5160,   // 柱
  pillarHi:0x6b7388,   // 柱の縁
  player:  0xf4ead0,   // プレイヤー(ランタン体)
  wall:    0x222732,   // 外周壁
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

// HSV→RGB (0..1)。決定的に色付き光源の色を割り当てるのに使う。
function hsv2rgb(h, s, v) {
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
  return ((Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)) >>> 0;
}

// ---- オクルーダ(矩形の柱)決定的生成 --------------------------------------
// 外周は壁。内部に約16個の軸平行矩形を、互いに重なりすぎない様に決定的配置。
function generateOccluders() {
  const rnd = mulberry32(SEED_OCCLUDER);
  const list = []; // {x,y,w,h}
  const margin = TILE * 1.5;        // 外周壁の内側余白
  const tries = OCCLUDER_COUNT * 12;
  for (let t = 0; t < tries && list.length < OCCLUDER_COUNT; t++) {
    const w = TILE * (1 + Math.floor(rnd() * 2));        // 32 or 64
    const h = TILE * (1 + Math.floor(rnd() * 2));        // 32 or 64
    const x = Math.round(margin + rnd() * (ROOM_W - margin * 2 - w));
    const y = Math.round(margin + rnd() * (ROOM_H - margin * 2 - h));
    const r = { x, y, w, h };
    // 近接しすぎ(間隔不足)は弾く
    let ok = true;
    for (const o of list) {
      if (x < o.x + o.w + 20 && x + w + 20 > o.x &&
          y < o.y + o.h + 20 && y + h + 20 > o.y) { ok = false; break; }
    }
    if (ok) list.push(r);
  }
  return list;
}

// 外周壁を「影を落とす矩形」として4枚加える(画面外側へ厚みを持たせる)。
function makeWallOccluders() {
  const T = TILE; // 壁厚
  return [
    { x: -T, y: -T, w: ROOM_W + 2 * T, h: T, wall: true },        // 上
    { x: -T, y: ROOM_H, w: ROOM_W + 2 * T, h: T, wall: true },    // 下
    { x: -T, y: -T, w: T, h: ROOM_H + 2 * T, wall: true },        // 左
    { x: ROOM_W, y: -T, w: T, h: ROOM_H + 2 * T, wall: true },    // 右
  ];
}

// ---- フォールバックテクスチャ生成 ----------------------------------------
// 画像が無い場合の図形テクスチャを生成して再利用する。
function makeFallbackTextures(app) {
  const tex = {};
  const g = (w, h, draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, width: w, height: h, resolution: 1 });
    gr.destroy();
    return t;
  };

  // 暗い床タイル(市松＋格子) 64x64
  tex.tile_floor = g(64, 64, (gr) => {
    gr.rect(0, 0, 64, 64).fill(COLORS.floor);
    gr.rect(0, 0, 32, 32).fill(COLORS.floor2);
    gr.rect(32, 32, 32, 32).fill(COLORS.floor2);
    gr.rect(0, 0, 64, 64).stroke({ width: 1, color: 0x0c0e14, alpha: 0.8 });
  });

  // 柱(オクルーダ) 64x64。乗算ライトで暗く沈むので地色はやや明るめ。
  tex.pillar = g(64, 64, (gr) => {
    gr.rect(0, 0, 64, 64).fill(COLORS.pillar);
    gr.rect(0, 0, 64, 64).stroke({ width: 3, color: COLORS.pillarHi });
    gr.rect(8, 8, 48, 48).stroke({ width: 1, color: 0x2c313c, alpha: 0.8 });
  });

  // プレイヤー(ランタン持ちの人型) 24x36
  tex.player_lamp = g(P_DRAW_W, P_DRAW_H, (gr) => {
    gr.ellipse(12, 33, 9, 4).fill({ color: 0x000000, alpha: 0.35 }); // 影
    gr.roundRect(7, 12, 10, 18, 3).fill(COLORS.player);              // 胴
    gr.circle(12, 8, 5).fill(COLORS.player);                         // 頭
    gr.circle(12, 8, 5).stroke({ width: 1, color: 0x9a8d6e });
    gr.circle(19, 18, 3).fill(0xffe6a0);                             // ランタン(灯り)
    gr.circle(19, 18, 3).stroke({ width: 1, color: 0xffb84d });
  });

  // 放射グロー 256x256: 中心白→外周透明(加算前提)。smoothstep 風フォールオフ。
  // light_glow.png が無くてもこれで必ず点灯する。
  tex.light_glow = makeGlowTexture(app, 256);

  return tex;
}

// 放射グラデーション(中心 1.0 → 外周 0.0)を Canvas で生成して Texture 化する。
// 加算で積む前提なので白(=全チャンネル)。色は Sprite の tint で付ける。
function makeGlowTexture(app, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  // smoothstep に近い段階的グラデで中心が強く外周がなだらかに 0 へ落ちるようにする。
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  const stops = 16;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;          // 0(中心)..1(外周)
    // smoothstep(1-t): 中心1.0 → 外周0.0
    const u = 1 - t;
    const a = u * u * (3 - 2 * u);
    grad.addColorStop(t, `rgba(255,255,255,${a.toFixed(4)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return PIXI.Texture.from(canvas);
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
    tile_floor:  '../assets/tile_floor.png',
    pillar:      '../assets/pillar.png',
    light_glow:  '../assets/light_glow.png',
    player_lamp: '../assets/player_lamp.png',
  };
  const tex = { ...fallback };
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key];
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形/生成フォールバック
    }
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
    background: 0x05070b,
    antialias: false,
    resolution: 1,
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  const tex = await loadTextures(app);

  // ---- オクルーダ(柱)＋壁 ----
  const pillars = generateOccluders();        // 影を落とす柱(HUD のカウント対象)
  const walls = makeWallOccluders();           // 外周壁(影は落とすがカウント外)
  const occluders = [...pillars, ...walls];    // 影生成に使う全矩形

  // =====================================================================
  // シーン層(床＋柱) : 普通に描く。後でこの上に乗算ライトを重ねる。
  // =====================================================================
  const scene = new PIXI.Container();
  app.stage.addChild(scene);

  // 床: TilingSprite で 960x544 を敷く(タイル32表示なので tileScale で 64→32)。
  const floor = new PIXI.TilingSprite({ texture: tex.tile_floor, width: ROOM_W, height: ROOM_H });
  floor.tileScale.set(TILE / 64);
  scene.addChild(floor);

  // 外周壁(見た目)。
  const wallGfx = new PIXI.Graphics();
  wallGfx.rect(0, 0, ROOM_W, TILE).fill(COLORS.wall);
  wallGfx.rect(0, ROOM_H - TILE, ROOM_W, TILE).fill(COLORS.wall);
  wallGfx.rect(0, 0, TILE, ROOM_H).fill(COLORS.wall);
  wallGfx.rect(ROOM_W - TILE, 0, TILE, ROOM_H).fill(COLORS.wall);
  scene.addChild(wallGfx);

  // 柱スプライト(オクルーダの見た目)。
  const pillarLayer = new PIXI.Container();
  scene.addChild(pillarLayer);
  for (const p of pillars) {
    const s = new PIXI.Sprite(tex.pillar);
    s.x = p.x; s.y = p.y; s.width = p.w; s.height = p.h;
    pillarLayer.addChild(s);
  }

  // プレイヤー(シーン層・乗算ライトの下。灯りで照らされる側)。
  const playerSprite = new PIXI.Sprite(tex.player_lamp);
  playerSprite.width = P_DRAW_W; playerSprite.height = P_DRAW_H;
  playerSprite.anchor.set(0.5, 0.9);
  scene.addChild(playerSprite);

  // =====================================================================
  // ライトマップ用 RenderTexture
  //   lightRT : 全光源の寄与(＋ambient下地)を加算で積む最終ライトバッファ。
  //   scratch : 光源1個ぶんの「放射グロー − 影ポリ(黒)」を作る作業用(プール)。
  // =====================================================================
  const lightRT = PIXI.RenderTexture.create({ width: VIEW_W, height: VIEW_H, resolution: 1 });

  // スクラッチRTプール(影 ON 時に光源1個ごと往復する)。必要数だけ確保して使い回す。
  const scratchPool = [];
  function getScratch() {
    let rt = scratchPool.pop();
    if (!rt) rt = PIXI.RenderTexture.create({ width: VIEW_W, height: VIEW_H, resolution: 1 });
    return rt;
  }
  function freeScratch(rt) { scratchPool.push(rt); }

  // --- 合成に使う使い捨てコンテナ(毎フレーム作り直さず使い回す) ---
  // ambient 下地(暗いグレーの全面塗り)。
  const ambientFill = new PIXI.Graphics()
    .rect(0, 0, VIEW_W, VIEW_H)
    .fill({ color: 0xffffff, alpha: 1 });
  const amb = Math.round(AMBIENT * 255);
  ambientFill.tint = (amb << 16) | (amb << 8) | amb; // ambient のグレー

  // グロー描画用 Sprite(中心アンカー)。光源ごとに位置/サイズ/色を差し替えて使い回す。
  const glowSprite = new PIXI.Sprite(tex.light_glow);
  glowSprite.anchor.set(0.5);
  glowSprite.blendMode = 'add';

  // 影ポリゴン描画用 Graphics(光源ごとにクリアして使い回す)。黒で光を削る。
  const shadowGfx = new PIXI.Graphics();

  // スクラッチを lightRT へ加算する際に使う Sprite(スクラッチRTを貼る)。
  const accumSprite = new PIXI.Sprite();
  accumSprite.blendMode = 'add';

  // lightRT を multiply でシーンへ重ねる最終 Sprite。
  const lightOverlay = new PIXI.Sprite(lightRT);
  lightOverlay.blendMode = 'multiply';
  app.stage.addChild(lightOverlay);

  // =====================================================================
  // 光源
  // =====================================================================
  // プレイヤー光源(白・別枠)。
  const player = {
    x: ROOM_W * 0.5, y: ROOM_H * 0.5,
    w: P_W, h: P_H,
  };

  // 動的光源: {x,y, vx,vy, radius, color}。決定的初期化＆軌道。
  const dynLights = [];
  function makeDynLight(i) {
    const rnd = mulberry32((SEED_LIGHTS ^ (i * 0x9E3779B1)) >>> 0);
    const ang = rnd() * Math.PI * 2;
    return {
      x: TILE * 2 + rnd() * (ROOM_W - TILE * 4),
      y: TILE * 2 + rnd() * (ROOM_H - TILE * 4),
      vx: Math.cos(ang) * DYN_LIGHT_SPEED,
      vy: Math.sin(ang) * DYN_LIGHT_SPEED,
      radius: DYN_LIGHT_RADIUS,
      color: hsv2rgb(rnd(), 0.75, 1.0), // 決定的な色付き
    };
  }
  let lightSet = 0;
  function setLightCount(n) {
    n = clamp(n, LIGHT_MIN, LIGHT_MAX);
    while (dynLights.length < n) dynLights.push(makeDynLight(dynLights.length));
    while (dynLights.length > n) dynLights.pop();
    lightSet = n;
  }
  setLightCount(LIGHT_INIT);

  // ---- 状態 ----
  let shadowsOn = true;

  function reset() {
    player.x = ROOM_W * 0.5; player.y = ROOM_H * 0.5;
    dynLights.length = 0;
    setLightCount(LIGHT_INIT);
    shadowsOn = true;
  }

  // ---- 入力 ----
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      setLightCount(lightSet + LIGHT_STEP); e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      setLightCount(lightSet - LIGHT_STEP); e.preventDefault();
    } else if (e.code === 'KeyL') {
      shadowsOn = !shadowsOn;
    } else if (e.code === 'KeyR') {
      reset();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // ---- AABB (プレイヤー vs 柱/壁) ----
  function rectHit(px, py, w, h) {
    // 外周壁(室内の可動域 [TILE, ROOM_W-TILE])
    if (px < TILE || py < TILE || px + w > ROOM_W - TILE || py + h > ROOM_H - TILE) return true;
    for (const o of pillars) {
      if (px < o.x + o.w && px + w > o.x && py < o.y + o.h && py + h > o.y) return true;
    }
    return false;
  }
  // 軸分離移動(X→解決, Y→解決)。
  function movePlayer(dx, dy) {
    const x0 = player.x - P_W / 2, y0 = player.y - P_H / 2;
    let nx = x0 + dx;
    if (!rectHit(nx, y0, P_W, P_H)) player.x = nx + P_W / 2;
    const y1 = player.y - P_H / 2;
    let ny = y1 + dy;
    if (!rectHit(player.x - P_W / 2, ny, P_W, P_H)) player.y = ny + P_H / 2;
  }

  // =====================================================================
  // 影ポリゴン生成
  //   光源 (lx,ly) から見て、矩形 occ のシルエット辺(光源側を向いていない辺)の
  //   端点を光源から遠ざかる方向へ SHADOW_PROJECT 延長し、影の四角形を作る。
  //   矩形の各辺について「辺の外向き法線が光源と逆を向く=影になる辺」を判定し、
  //   その辺の2端点を投影して台形(4頂点)を shadowGfx に黒で塗る。
  // =====================================================================
  function projectPoint(lx, ly, px, py) {
    const dx = px - lx, dy = py - ly;
    const len = Math.hypot(dx, dy) || 1;
    return [px + (dx / len) * SHADOW_PROJECT, py + (dy / len) * SHADOW_PROJECT];
  }

  function drawShadowForOccluder(gfx, lx, ly, o) {
    // 矩形の4隅
    const x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    // 4辺: [A,B] (時計回り)。外向き法線で光源との向きを見る。
    const edges = [
      { a: 0, b: 1, nx: 0, ny: -1 }, // 上辺 (法線 上向き)
      { a: 1, b: 2, nx: 1, ny: 0 },  // 右辺
      { a: 2, b: 3, nx: 0, ny: 1 },  // 下辺
      { a: 3, b: 0, nx: -1, ny: 0 }, // 左辺
    ];
    // 矩形中心から光源へのベクトル(辺が光源側を向くか判定する補助)
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const e of edges) {
      const ax = corners[e.a][0], ay = corners[e.a][1];
      // 辺中点
      const mx = (corners[e.a][0] + corners[e.b][0]) / 2;
      const my = (corners[e.a][1] + corners[e.b][1]) / 2;
      // 光源→辺中点 と 外向き法線 の内積が正 = 光源は法線の裏側 = この辺は影側
      const toEdgeX = mx - lx, toEdgeY = my - ly;
      if (toEdgeX * e.nx + toEdgeY * e.ny <= 0) continue; // 光源側を向く辺はスキップ
      const bx = corners[e.b][0], by = corners[e.b][1];
      const [pax, pay] = projectPoint(lx, ly, ax, ay);
      const [pbx, pby] = projectPoint(lx, ly, bx, by);
      // 影台形: 辺AB → 投影B' → 投影A'
      gfx.poly([ax, ay, bx, by, pbx, pby, pax, pay]).fill(0x000000);
    }
    void cx; void cy;
  }

  // =====================================================================
  // ライトマップ構築 (毎フレーム)
  //   影 ON : 光源ごとに scratch へ「グロー → 影ポリ(黒) → lightRT へ加算」を往復。
  //   影 OFF: lightRT へ直接 glow を add するだけ(往復なし＝軽い)。
  // =====================================================================
  function buildLightmap(renderer) {
    // 1) lightRT を ambient 下地でクリア(全面に薄いグレーを 1.0 不透明で塗る)。
    //    clear:true で前フレームを消し、ambientFill を上書き描画。
    renderer.render({ container: ambientFill, target: lightRT, clear: true });

    const allLights = [
      { x: player.x, y: player.y, radius: PLAYER_LIGHT_RADIUS, color: 0xfff2d8 },
      ...dynLights,
    ];

    for (const L of allLights) {
      // glowSprite を光源に合わせる(直径 = 半径×2)。色は tint。
      glowSprite.x = L.x; glowSprite.y = L.y;
      glowSprite.width = L.radius * 2;
      glowSprite.height = L.radius * 2;
      glowSprite.tint = L.color;

      if (!shadowsOn) {
        // --- 影 OFF: lightRT へ直接 add (バッファ往復なし) ---
        renderer.render({ container: glowSprite, target: lightRT, clear: false });
        continue;
      }

      // --- 影 ON: scratch にこの光源の寄与を作ってから lightRT へ加算 ---
      const scratch = getScratch();
      // (a) スクラッチを黒クリア＆グロー描画。
      //     glowSprite は blend=add だが clear:true の黒下地に対しては加算=実質コピー。
      renderer.render({ container: glowSprite, target: scratch, clear: true });

      // (b) 影ポリゴン(黒)をスクラッチへ重ねて光を削る。
      //     shadowGfx は通常ブレンド(black の不透明塗り)で該当領域を 0 にする。
      shadowGfx.clear();
      for (const o of occluders) {
        // 光源が矩形内部にある場合は影なし(全周照らす)。
        if (L.x >= o.x && L.x <= o.x + o.w && L.y >= o.y && L.y <= o.y + o.h) continue;
        drawShadowForOccluder(shadowGfx, L.x, L.y, o);
      }
      // clear:false で (a) のグローの上に黒影を重ね描き。
      renderer.render({ container: shadowGfx, target: scratch, clear: false });

      // (c) スクラッチ(=影込みの光寄与)を lightRT へ add 加算。
      accumSprite.texture = scratch;
      renderer.render({ container: accumSprite, target: lightRT, clear: false });

      freeScratch(scratch);
    }
  }

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // ---- メインループ ----
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05);

    // --- FPS 移動平均 ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // === 1) プレイヤー移動 (WASD/矢印, 220px/s, AABB) ===
    let mx = 0, my = 0;
    if (down('ArrowLeft', 'KeyA')) mx -= 1;
    if (down('ArrowRight', 'KeyD')) mx += 1;
    if (down('ArrowUp', 'KeyW')) my -= 1;
    if (down('ArrowDown', 'KeyS')) my += 1;
    if (mx !== 0 && my !== 0) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
    movePlayer(mx * P_SPEED * dt, my * P_SPEED * dt);

    // === 2) 動的光源の更新 (決定的軌道: 壁でバウンド。柱は通り抜け) ===
    for (const L of dynLights) {
      L.x += L.vx * dt;
      L.y += L.vy * dt;
      // 室内領域でバウンド(外周壁の内側)。
      if (L.x < TILE) { L.x = TILE; L.vx = Math.abs(L.vx); }
      else if (L.x > ROOM_W - TILE) { L.x = ROOM_W - TILE; L.vx = -Math.abs(L.vx); }
      if (L.y < TILE) { L.y = TILE; L.vy = Math.abs(L.vy); }
      else if (L.y > ROOM_H - TILE) { L.y = ROOM_H - TILE; L.vy = -Math.abs(L.vy); }
    }

    // === 3) スプライト位置反映 ===
    playerSprite.x = player.x;
    playerSprite.y = player.y + P_H / 2;

    // === 4) ライトマップ構築 → 乗算オーバーレイへ反映 ===
    // (scene は app.stage の子として自動描画される。lightOverlay も自動描画される
    //  が、その中身 lightRT を毎フレーム手動レンダリングで更新する。)
    buildLightmap(app.renderer);

    // === 5) HUD (約120msごと) ===
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Lights    : ${dynLights.length} / ${LIGHT_MAX}  (+player)\n` +
        `Occluders : ${pillars.length}\n` +
        `Shadows   : ${shadowsOn ? 'ON' : 'OFF'}\n` +
        `Mode      : Lightmap(blend)\n` +
        `Ambient   : ${AMBIENT.toFixed(2)}\n` +
        `WASD=移動 / +/-=光源数 / L=影 / R=リセット`;
    }
  });

  // リサイズ: キャンバスは 960x540 固定、ウィンドウに合わせて等倍縮小表示。
  function fit() {
    const scale = Math.min(window.innerWidth / VIEW_W, (window.innerHeight - 48) / VIEW_H, 1);
    const stageEl = document.getElementById('stage');
    stageEl.style.width = (VIEW_W * scale) + 'px';
    stageEl.style.height = (VIEW_H * scale) + 'px';
    app.canvas.style.width = (VIEW_W * scale) + 'px';
    app.canvas.style.height = (VIEW_H * scale) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);

  console.log('[PixiJS v8] theme11 lighting init ok. renderer =', app.renderer.type);
})();
