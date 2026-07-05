/* =========================================================================
 * テーマ5 横スクロールアクション ― PixiJS v8 実装
 * 仕様: SPEC.md (タイル32x32, マップ200x17, 可視カリング, カメラ水平追従)
 *
 * PixiJS は描画ライブラリのため、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker の deltaMS でデルタタイム駆動)
 *   - キーボード入力
 *   - 重力 + 可変ジャンプ
 *   - AABB を軸分離 (X→解決, Y→解決) したタイル当たり判定
 *   - カメラ (world コンテナを -cameraX 平行移動)
 *   - タイル / 敵スプライトのプール再利用 (カリング)
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const TILE = 32;
const MAP_W = 200;
const MAP_H = 17;
const VIEW_W = 960;
const VIEW_H = 540;
const WORLD_W = MAP_W * TILE;     // 6400
const WORLD_H = MAP_H * TILE;     // 544

// 物理 (デルタタイム基準, px/s, px/s^2)
const GRAVITY = 1800;
const WALK_SPEED = 180;
const DASH_SPEED = 288;           // ×1.6
const JUMP_VY = -640;
const JUMP_CUT = 0.45;            // 可変ジャンプ: 上昇中にキーを離した際の減衰係数
const FALL_MARGIN = 80;           // マップ下端 + 余白を越えたら落下死

// 自機 (当たり判定 24x44 / 描画 32x48)
const P_W = 24, P_H = 44;
const P_DRAW_W = 32, P_DRAW_H = 48;
const P_HP = 3;
const INVULN = 1.0;              // 被弾後の無敵 (s)
const KNOCKBACK_X = 220;
const KNOCKBACK_Y = -260;

// 敵 (goomba: 当たり判定 28x28)
const E_W = 28, E_H = 28;
const E_SPEED = 60;
const STOMP_BOUNCE = -380;
const SCORE_STOMP = 100;
const SCORE_COIN = 50;

// 敵数 (負荷)
const ENEMY_INIT = 20;
const ENEMY_STEP = 10;
const ENEMY_MIN = 0;
const ENEMY_MAX = 500;

// タイル種別: 0=空, 1=地面, 2=ブロック, 3=土管
const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = new Set([T_GROUND, T_BRICK, T_PIPE]);

// フォールバック色
const COLORS = {
  player: 0xe23b2e,   // 赤
  goomba: 0x8a5a2b,   // 茶
  ground: 0x9b6b3a,   // 茶
  brick:  0xd08030,   // 橙
  pipe:   0x3aa64a,   // 緑
  coin:   0xf2d33c,   // 黄
  sky:    0x6ab4ff,   // 空色
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

// ---- マップ決定的生成 ------------------------------------------------------
// 固定シードで全エンジン共通の見た目を狙う。
//   最下段(+1段)は地面 / 所々に穴(gap) / 空中にブロック足場 / 地上に土管 / 左右端は壁。
function generateMap() {
  const rnd = mulberry32(20250614);
  const map = new Uint8Array(MAP_W * MAP_H); // 既定 0 = 空
  const idx = (x, y) => y * MAP_W + x;

  const GROUND_TOP = MAP_H - 2;   // 地表段 (この段とその下=最下段を地面に)

  // --- 最下2段を地面に。所々を穴(gap)として抜く ---
  let x = 0;
  while (x < MAP_W) {
    // 地面の連続区間を敷く
    const run = 5 + Math.floor(rnd() * 6); // 連続地面の長さ
    for (let i = 0; i < run && x < MAP_W; i++, x++) {
      map[idx(x, GROUND_TOP)] = T_GROUND;
      map[idx(x, MAP_H - 1)] = T_GROUND;
    }
    // その後に幅1の穴を1つだけ（連続穴を防ぎ、デモが必ず越えられる幅にする）
    if (x > 8 && x < MAP_W - 8 && rnd() < 0.30) x += 1;
  }

  // --- 空中のブロック足場: ジャンプ頂点より上(py<=9)に置き、走路に天井を作らない ---
  for (let i = 0; i < 70; i++) {
    const px = 6 + Math.floor(rnd() * (MAP_W - 12));
    const py = 4 + Math.floor(rnd() * 6); // 4..9
    const len = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < len && px + k < MAP_W - 2; k++) {
      if (map[idx(px + k, py)] === T_EMPTY) map[idx(px + k, py)] = T_BRICK;
    }
  }

  // --- 地上の土管 (地面の上に2段)。穴の近く(±4)には置かない(越えジャンプが穴に着地するため) ---
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (map[idx(g, GROUND_TOP)] !== T_GROUND) return false;
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const px = 12 + Math.floor(rnd() * (MAP_W - 24));
    if (map[idx(px, GROUND_TOP)] === T_GROUND && map[idx(px + 1, GROUND_TOP)] === T_GROUND && noGapNear(px)) {
      const h = 1 + Math.floor(rnd() * 2); // 高さ1〜2
      for (let k = 1; k <= h; k++) {
        map[idx(px, GROUND_TOP - k)] = T_PIPE;
        map[idx(px + 1, GROUND_TOP - k)] = T_PIPE;
      }
    }
  }

  // --- 左右端は壁 (全高) ---
  for (let y = 0; y < MAP_H; y++) {
    map[idx(0, y)] = T_GROUND;
    map[idx(MAP_W - 1, y)] = T_GROUND;
  }

  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return T_EMPTY;
  return map[ty * MAP_W + tx];
}

// 矩形(px)が solid タイルに重なるか
function rectHitsSolid(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE);
  const y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE);
  const y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (SOLID.has(tileAt(map, tx, ty))) return true;
    }
  }
  return false;
}

// ---- フォールバックテクスチャ生成 (Graphics→Texture) ----------------------
// 生成テクスチャはキャッシュして全スプライトで再利用する。
function makeFallbackTextures(app) {
  const tex = {};
  const g = (w, h, draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, width: w, height: h, resolution: 1 });
    gr.destroy();
    return t;
  };

  tex.tile_ground = g(TILE, TILE, (gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.ground);
    gr.rect(0, 0, TILE, 4).fill({ color: 0x6e9b3a }); // 上面に草の縁
    gr.rect(0, 0, TILE, TILE).stroke({ width: 1, color: 0x6f4a26, alpha: 0.6 });
  });
  tex.tile_brick = g(TILE, TILE, (gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.brick);
    gr.rect(0, 0, TILE, TILE).stroke({ width: 2, color: 0x8a5418 });
    gr.moveTo(0, 16).lineTo(TILE, 16).stroke({ width: 1, color: 0x8a5418 });
    gr.moveTo(16, 0).lineTo(16, 16).stroke({ width: 1, color: 0x8a5418 });
    gr.moveTo(8, 16).lineTo(8, 32).stroke({ width: 1, color: 0x8a5418 });
    gr.moveTo(24, 16).lineTo(24, 32).stroke({ width: 1, color: 0x8a5418 });
  });
  tex.tile_pipe = g(TILE, TILE, (gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.pipe);
    gr.rect(2, 0, TILE - 4, TILE).stroke({ width: 2, color: 0x216b2a });
    gr.rect(5, 3, 5, TILE - 6).fill({ color: 0x8be39a, alpha: 0.5 }); // ハイライト
  });
  // 自機: 32x48 の赤矩形 (顔つき)
  tex.player = g(P_DRAW_W, P_DRAW_H, (gr) => {
    gr.roundRect(2, 2, P_DRAW_W - 4, P_DRAW_H - 4, 5).fill(COLORS.player);
    gr.roundRect(2, 2, P_DRAW_W - 4, P_DRAW_H - 4, 5).stroke({ width: 2, color: 0x8a1810 });
    gr.rect(4, 4, P_DRAW_W - 8, 10).fill({ color: 0xffe0c0, alpha: 0.9 }); // 帽子下の顔帯
    gr.circle(11, 9, 2).fill(0x222222);
    gr.circle(21, 9, 2).fill(0x222222);
  });
  // goomba: 32x32 の茶丸
  tex.goomba = g(32, 32, (gr) => {
    gr.ellipse(16, 14, 13, 11).fill(COLORS.goomba);
    gr.ellipse(16, 14, 13, 11).stroke({ width: 2, color: 0x5c3a18 });
    gr.rect(8, 24, 16, 6).fill(0x3a2410); // 足
    gr.circle(11, 13, 2.5).fill(0xffffff);
    gr.circle(21, 13, 2.5).fill(0xffffff);
    gr.circle(11, 13, 1.2).fill(0x000000);
    gr.circle(21, 13, 1.2).fill(0x000000);
  });
  // コイン: 24x24 の黄丸
  tex.coin = g(24, 24, (gr) => {
    gr.circle(12, 12, 10).fill(COLORS.coin);
    gr.circle(12, 12, 10).stroke({ width: 2, color: 0xc9a51e });
    gr.rect(10, 5, 4, 14).fill({ color: 0xfff4b0, alpha: 0.8 });
  });
  // 火花(撃破エフェクト): 16x16 の白星
  tex.spark = g(16, 16, (gr) => {
    gr.star(8, 8, 5, 7, 3).fill(0xfff2a8);
  });
  // 背景: 512x512 の空色 (雲つき)
  tex.bg_sky = g(512, 512, (gr) => {
    gr.rect(0, 0, 512, 512).fill(COLORS.sky);
    gr.rect(0, 360, 512, 152).fill({ color: 0x8fd0ff, alpha: 0.5 });
    for (let i = 0; i < 6; i++) {
      const cx = 40 + i * 90, cy = 60 + (i % 3) * 70;
      gr.ellipse(cx, cy, 36, 18).fill({ color: 0xffffff, alpha: 0.85 });
      gr.ellipse(cx + 26, cy + 6, 26, 14).fill({ color: 0xffffff, alpha: 0.85 });
    }
  });
  return tex;
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
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
  const tex = { ...fallback }; // spark など画像が無いものはフォールバックを既定で持つ
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key];
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形フォールバック
    }
  }
  const frames = (base, w, h, cols, rows = 1) => {
    if (!base || !base.source || base.source.width < w * cols) return Array(cols * rows).fill(base);
    const actualRows = Math.min(rows, Math.max(1, Math.floor(base.source.height / h)));
    const out = [];
    for (let row = 0; row < actualRows; row++) {
      for (let col = 0; col < cols; col++) {
        out.push(new PIXI.Texture({
          source: base.source,
          frame: new PIXI.Rectangle(col * w, row * h, w, h),
        }));
      }
    }
    while (out.length < cols * rows) out.push(out[out.length % cols]);
    return out;
  };
  tex.playerFrames = frames(tex.player_walk || tex.player, P_DRAW_W, P_DRAW_H, 4, 2);
  tex.goombaFrames = frames(tex.goomba_walk || tex.goomba, 32, 32, 4, 2);
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
    background: COLORS.sky,
    antialias: false,
    // 性能比較用途のため解像度は 1 固定。
    resolution: 1,
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  const map = generateMap();
  const tex = await loadTextures(app);

  // ---- 背景 (画面固定の TilingSprite。視差は軽くカメラに連動) ----
  const bg = new PIXI.TilingSprite({ texture: tex.bg_sky, width: VIEW_W, height: VIEW_H });
  app.stage.addChild(bg);

  // ---- world: カメラに合わせ平行移動するコンテナ ----
  const world = new PIXI.Container();
  app.stage.addChild(world);

  const tileLayer = new PIXI.Container();
  const coinLayer = new PIXI.Container();
  const enemyLayer = new PIXI.Container();
  const fxLayer = new PIXI.Container();
  world.addChild(tileLayer, coinLayer, enemyLayer, fxLayer);

  // ---- タイル描画プール (可視範囲のみ描画 / スプライト再利用カリング) ----
  // 画面に収まる最大タイル数ぶんの Sprite を確保し、毎フレーム可視タイルへ
  // テクスチャ・座標を割り当てて再利用する (TilingSprite を使わない真のカリング)。
  const colsVis = Math.ceil(VIEW_W / TILE) + 2; // 32
  const rowsVis = Math.ceil(VIEW_H / TILE) + 2; // 19 (MAP_H=17 を超えるが上限でクランプ)
  const tilePool = [];
  for (let i = 0; i < colsVis * rowsVis; i++) {
    const s = new PIXI.Sprite(tex.tile_ground);
    s.visible = false;
    tilePool.push(s);
    tileLayer.addChild(s);
  }
  const tileTexByType = {
    [T_GROUND]: tex.tile_ground,
    [T_BRICK]: tex.tile_brick,
    [T_PIPE]: tex.tile_pipe,
  };

  // ---- コイン (決定的配置) ----
  // ブロック足場の少し上 / 地表の上 に決定的に撒く。
  const coins = []; // {x,y,w,h, taken, sprite}
  function buildCoins() {
    const rnd = mulberry32(777);
    const GROUND_TOP = MAP_H - 2;
    for (let tx = 2; tx < MAP_W - 2; tx++) {
      for (let ty = 2; ty < MAP_H - 1; ty++) {
        if (tileAt(map, tx, ty) !== T_EMPTY) continue;
        // 直下が solid (足場/地面) の空きマスにコインを置く候補
        const below = tileAt(map, tx, ty + 1);
        if (!SOLID.has(below)) continue;
        if (rnd() < 0.10) {
          const cx = tx * TILE + (TILE - 24) / 2;
          const cy = ty * TILE + (TILE - 24) / 2;
          const sprite = new PIXI.Sprite(tex.coin);
          sprite.width = 24; sprite.height = 24;
          sprite.x = cx; sprite.y = cy;
          coinLayer.addChild(sprite);
          coins.push({ x: cx, y: cy, w: 24, h: 24, taken: false, sprite });
        }
      }
    }
  }
  buildCoins();

  // ---- スポーン地点 (左端付近の地表上) ----
  const SPAWN_TX = 3;
  const GROUND_TOP_Y = (MAP_H - 2) * TILE; // 地表段の上端 y
  const spawn = { x: SPAWN_TX * TILE, y: GROUND_TOP_Y - P_H };

  // ---- プレイヤー ----
  const player = {
    x: spawn.x, y: spawn.y,
    w: P_W, h: P_H,
    vx: 0, vy: 0,
    onGround: false,
    hp: P_HP,
    invuln: 0,    // 残り無敵時間 (s)
    facing: 1,
  };
  const playerSprite = new PIXI.Sprite(tex.playerFrames[0]);
  playerSprite.width = P_DRAW_W; playerSprite.height = P_DRAW_H;
  playerSprite.anchor.set(0);
  enemyLayer.addChild(playerSprite); // 敵と同レイヤ (自機を最前面に保つため後段で zIndex 管理せず addChild 順で前)

  // ---- 敵プール (goomba) ----
  // スポーン候補: 「真下が地面 or ブロック」で、その段が空の地表セルを決定的に列挙。
  const spawnSlots = [];
  (function buildSpawnSlots() {
    for (let tx = 5; tx < MAP_W - 5; tx++) {
      for (let ty = 2; ty < MAP_H - 1; ty++) {
        if (tileAt(map, tx, ty) !== T_EMPTY) continue;
        if (SOLID.has(tileAt(map, tx, ty + 1))) {
          spawnSlots.push({ tx, ty });
        }
      }
    }
    // 決定的にシャッフル (固定シード) して、+/- 増減でも同じ順に取り出す。
    const rnd = mulberry32(31337);
    for (let i = spawnSlots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = spawnSlots[i]; spawnSlots[i] = spawnSlots[j]; spawnSlots[j] = t;
    }
  })();

  const enemies = []; // {x,y,w,h,vx,vy,onGround,alive,sprite}
  const enemyPool = []; // 破棄せず再利用する sprite プール

  function getEnemySprite() {
    let s = enemyPool.pop();
    if (!s) {
      s = new PIXI.Sprite(tex.goombaFrames[0]);
      s.width = 32; s.height = 32;
      enemyLayer.addChildAt(s, 0); // 自機より背面へ
    }
    s.visible = true;
    return s;
  }

  function spawnEnemyAt(slot, dir) {
    const sprite = getEnemySprite();
    const e = {
      // 当たり判定 28x28 をセル中央寄せで配置
      x: slot.tx * TILE + (TILE - E_W) / 2,
      y: slot.ty * TILE + (TILE - E_H),
      w: E_W, h: E_H,
      vx: dir * E_SPEED, vy: 0,
      onGround: false,
      alive: true,
      sprite,
    };
    enemies.push(e);
  }

  // 決定的な増減: 設定数 n になるよう spawnSlots を順に使って追加 / 末尾から削除。
  function setEnemyCount(n) {
    n = clamp(n, ENEMY_MIN, ENEMY_MAX);
    while (enemies.length < n) {
      const i = enemies.length;
      const slot = spawnSlots[i % spawnSlots.length];
      const dir = (i % 2 === 0) ? 1 : -1;
      spawnEnemyAt(slot, dir);
    }
    while (enemies.length > n) {
      const e = enemies.pop();
      e.sprite.visible = false;
      enemyPool.push(e.sprite);
    }
    enemySet = n;
  }
  let enemySet = 0;
  setEnemyCount(ENEMY_INIT);

  // ---- 火花エフェクト (撃破時) ----
  const sparks = []; // {x,y,life,max,sprite}
  const sparkPool = [];
  function spawnSpark(x, y) {
    let s = sparkPool.pop();
    if (!s) { s = new PIXI.Sprite(tex.spark); s.anchor.set(0.5); s.width = 16; s.height = 16; fxLayer.addChild(s); }
    s.visible = true; s.x = x; s.y = y; s.alpha = 1; s.scale.set(1);
    sparks.push({ x, y, life: 0.35, max: 0.35, sprite: s });
  }

  // ---- タイトル/アトラクト状態 (false=デモ中・操作無効) ----
  let started = false, blinkT = 0;
  const titleEl = document.getElementById('title');

  // ---- 入力 ----
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Enter' && !started) { startGame(); e.preventDefault(); }
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      setEnemyCount(enemySet + ENEMY_STEP);
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      setEnemyCount(enemySet - ENEMY_STEP);
      e.preventDefault();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // ---- 当たり判定 (AABB) ----
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // 軸分離移動: X を動かして解決 → Y を動かして解決。接地フラグを更新。
  // アクターは {x,y,w,h,vx,vy,onGround} を持つ。戻り値で衝突方向を返す。
  function moveAndCollide(a, dx, dy) {
    let hitX = false, hitY = false;
    // --- X 軸 ---
    if (dx !== 0) {
      let nx = a.x + dx;
      if (rectHitsSolid(map, nx, a.y, a.w, a.h)) {
        // ピクセル単位で押し戻し (タイル境界へスナップ)
        if (dx > 0) nx = Math.floor((nx + a.w) / TILE) * TILE - a.w - 0.001;
        else nx = Math.floor(nx / TILE + 1) * TILE + 0.001;
        a.vx = 0; hitX = true;
      }
      a.x = nx;
    }
    // --- Y 軸 ---
    a.onGround = false;
    if (dy !== 0) {
      let ny = a.y + dy;
      if (rectHitsSolid(map, a.x, ny, a.w, a.h)) {
        if (dy > 0) { // 落下中に床へ着地
          ny = Math.floor((ny + a.h) / TILE) * TILE - a.h - 0.001;
          a.onGround = true;
        } else {     // 上昇中に天井
          ny = Math.floor(ny / TILE + 1) * TILE + 0.001;
        }
        a.vy = 0; hitY = true;
      }
      a.y = ny;
    }
    return { hitX, hitY };
  }

  // ---- ゲーム状態 ----
  let score = 0;
  let coinsCollected = 0;
  let tilesDrawn = 0;

  // 自機をスポーンへ戻す (HP は3に復帰。スコア・敵は保持)
  function respawnPlayer() {
    player.x = spawn.x; player.y = spawn.y;
    player.vx = 0; player.vy = 0;
    player.hp = P_HP;
    player.invuln = INVULN;
    player.onGround = false;
  }

  // 被弾 (ノックバック + 無敵 + HP-1)。HP0 で復帰。
  function hurtPlayer(fromX) {
    if (player.invuln > 0) return;
    player.hp -= 1;
    player.invuln = INVULN;
    const dir = (player.x + player.w / 2) < fromX ? -1 : 1;
    player.vx = KNOCKBACK_X * dir;
    player.vy = KNOCKBACK_Y;
    player.onGround = false;
    if (player.hp <= 0) respawnPlayer();
  }

  // Enter でデモ→プレイ開始: スコア等を新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    score = 0; coinsCollected = 0;
    for (let i = 0; i < coins.length; i++) {
      if (coins[i].taken) { coins[i].taken = false; coins[i].sprite.visible = true; }
    }
    setEnemyCount(ENEMY_INIT);
    respawnPlayer();
    titleEl.style.display = 'none';
  }

  // ---- デモAI (決定的): 右走行 + 接地時に前方の障害/穴で自動ジャンプ ----
  // 上昇中はジャンプ保持を続けて十分な高さを確保 (可変ジャンプと整合)。
  function demoAI(p) {
    // 前方に壁(solid)があるか: 体の中段〜足元のタイルを見る
    const aheadX = p.x + p.w + 4;
    const midY = p.y + p.h * 0.5;
    const footY = p.y + p.h - 2;
    const wallAhead =
      SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(midY / TILE))) ||
      SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(footY / TILE)));
    // 前方に穴があるか: 数タイル先の足元直下に地面が無い
    const gapProbeX = p.x + p.w + TILE * 1.2;
    const belowTy = Math.floor((p.y + p.h + TILE * 0.5) / TILE);
    const gapAhead = p.onGround && !SOLID.has(tileAt(map, Math.floor(gapProbeX / TILE), belowTy));
    let jump = false;
    if (p.onGround) jump = wallAhead || gapAhead;
    else if (p.vy < 0) jump = true;   // 上昇中は保持 (可変ジャンプを伸ばす)
    return { move: 1, jump };
  }

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // ---- メインループ ----
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05); // スパイク抑制

    // --- FPS 移動平均 (直近60フレーム) ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // ====================================================================
    // 1) プレイヤー入力 + 物理
    // ====================================================================
    // !started (アトラクト) 中はデモAIで右走行＋障害/穴で自動ジャンプ。キー入力は無視。
    let move = 0, jumpHeld = false, speed = WALK_SPEED;
    if (!started) {
      const demo = demoAI(player);
      move = demo.move; jumpHeld = demo.jump;
    } else {
      const dash = down('ShiftLeft', 'ShiftRight');
      speed = dash ? DASH_SPEED : WALK_SPEED;
      if (down('ArrowLeft', 'KeyA')) move -= 1;
      if (down('ArrowRight', 'KeyD')) move += 1;
      jumpHeld = down('Space', 'ArrowUp', 'KeyW');
    }

    const knockbackActive = Math.abs(player.vx) > speed + 1 && player.invuln > 0;
    if (knockbackActive) {
      // ノックバック中は入力より残存速度を優先 (摩擦で減衰)
      player.vx *= 0.9;
      if (Math.abs(player.vx) < speed) player.vx = move * speed;
    } else {
      player.vx = move * speed;
    }
    if (move !== 0) player.facing = move;

    // ジャンプ (接地時のみ)
    if (jumpHeld && player.onGround) {
      player.vy = JUMP_VY;
      player.onGround = false;
    }
    // 可変ジャンプ: 上昇中にジャンプキーを離したら上昇を減衰
    if (!jumpHeld && player.vy < 0) {
      player.vy *= JUMP_CUT;
    }

    // 重力
    player.vy += GRAVITY * dt;
    if (player.vy > 1200) player.vy = 1200; // 終端

    // 軸分離移動
    moveAndCollide(player, player.vx * dt, player.vy * dt);

    // 無敵タイマ
    if (player.invuln > 0) {
      player.invuln -= dt;
      if (player.invuln < 0) player.invuln = 0;
    }

    // 穴に落下 → HP-1 + 復帰
    if (player.y > WORLD_H + FALL_MARGIN) {
      player.hp -= 1;
      if (player.hp <= 0) respawnPlayer();
      else { // HP は残すが位置だけ戻す
        player.x = spawn.x; player.y = spawn.y;
        player.vx = 0; player.vy = 0; player.invuln = INVULN;
      }
    }

    // ====================================================================
    // 2) 敵更新 (重力 + 壁で反転)
    // ====================================================================
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      e.vy += GRAVITY * dt;
      if (e.vy > 1200) e.vy = 1200;

      // moveAndCollide は X衝突時に vx を 0 にするため、反転用に向きを保持しておく。
      const dir = Math.sign(e.vx) || 1;
      const beforeX = e.x;
      const res = moveAndCollide(e, e.vx * dt, e.vy * dt);
      // 壁衝突で反転 (vx は 0 化されているので保持した dir から復元)
      if (res.hitX || Math.abs(e.x - beforeX) < 0.01) {
        e.vx = -dir * E_SPEED;
      } else {
        e.vx = dir * E_SPEED;
      }
    }

    // ====================================================================
    // 3) 当たり判定: 自機 × 敵 (踏みつけ / 横接触)
    // ====================================================================
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      if (!aabb(player, e)) continue;

      const playerFalling = player.vy > 0;
      const playerBottom = player.y + player.h;
      // 踏みつけ判定: 落下中 + 自機の足が敵上面付近
      const stomp = playerFalling && (playerBottom - e.y) < (e.h * 0.6 + Math.abs(player.vy * dt) + 1);

      if (stomp) {
        e.alive = false;
        e.sprite.visible = false;
        enemyPool.push(e.sprite);
        // 配列から除去 (末尾とスワップ)
        enemies[i] = enemies[enemies.length - 1];
        enemies.pop();
        i--;
        score += SCORE_STOMP;
        spawnSpark(e.x + e.w / 2, e.y + e.h / 2);
        player.vy = STOMP_BOUNCE; // 跳ねる
      } else {
        hurtPlayer(e.x + e.w / 2); // 横接触で被弾
      }
    }

    // ====================================================================
    // 4) コイン取得 (オーバーラップ)
    // ====================================================================
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c.taken) continue;
      if (aabb(player, c)) {
        c.taken = true;
        c.sprite.visible = false;
        coinsCollected += 1;
        score += SCORE_COIN;
      }
    }

    // ====================================================================
    // 5) カメラ (水平追従 + クランプ)。world を -camX 平行移動。
    // ====================================================================
    let camX = Math.round(player.x + player.w / 2 - VIEW_W / 2);
    camX = clamp(camX, 0, WORLD_W - VIEW_W);
    const camY = clamp(Math.round(player.y + player.h / 2 - VIEW_H / 2), 0, Math.max(0, WORLD_H - VIEW_H));
    world.x = -camX;
    world.y = -camY;
    // 背景の軽い視差 (カメラに対し 0.4 倍スクロール)
    bg.tilePosition.x = -camX * 0.4;

    // ====================================================================
    // 6) タイルカリング描画 (可視範囲のみ)
    // ====================================================================
    const startTx = Math.floor(camX / TILE);
    const startTy = Math.floor(camY / TILE);
    tilesDrawn = 0;
    let pi = 0;
    for (let row = 0; row < rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        if (type === T_EMPTY) continue; // 空気は描かない
        const s = tilePool[pi++];
        if (!s) break;
        s.texture = tileTexByType[type];
        s.width = TILE; s.height = TILE;
        s.x = tx * TILE; s.y = ty * TILE;
        s.visible = true;
        tilesDrawn++;
      }
    }
    for (; pi < tilePool.length; pi++) tilePool[pi].visible = false;

    // ====================================================================
    // 7) スプライト位置反映
    // ====================================================================
    // 自機 (描画 32x48 を当たり判定 24x44 の中央下に合わせる)
    // 描画 32x48 を当たり判定 24x44 の中央下に合わせる。
    // 左右反転は anchor.x(0↔1) + scale.x 符号で行い、位置がずれないようにする。
    const dirRow = player.facing < 0 ? 1 : 0;
    const playerFrame = Math.abs(player.vx) > 5 && player.onGround ? Math.floor(performance.now() / 110) % 4 : 0;
    playerSprite.texture = tex.playerFrames[dirRow * 4 + playerFrame];
    playerSprite.anchor.x = 0;
    playerSprite.scale.x = Math.abs(playerSprite.scale.x);
    playerSprite.x = player.x - (P_DRAW_W - P_W) / 2;
    playerSprite.y = player.y - (P_DRAW_H - P_H);
    // 無敵中は点滅
    playerSprite.alpha = (player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0) ? 0.35 : 1;

    // 敵 (28x28 当たり判定を 32x32 描画の中央に)
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const row = e.vx < 0 ? 1 : 0;
      e.sprite.texture = tex.goombaFrames[row * 4 + (Math.floor((performance.now() / 140) + i) % 4)];
      e.sprite.x = e.x - (32 - E_W) / 2;
      e.sprite.y = e.y - (32 - E_H);
    }

    // 火花
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.alpha = clamp(t, 0, 1);
      sp.sprite.scale.set(1 + (1 - t) * 0.8);
      sp.sprite.x = sp.x; sp.sprite.y = sp.y;
      if (sp.life <= 0) {
        sp.sprite.visible = false;
        sparkPool.push(sp.sprite);
        sparks[i] = sparks[sparks.length - 1];
        sparks.pop();
      }
    }

    // ====================================================================
    // 8) HUD (約120msごと更新)
    // ====================================================================
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const ptx = Math.floor((player.x + player.w / 2) / TILE);
      const pty = Math.floor((player.y + player.h / 2) / TILE);
      const entities = enemies.length + coins.filter((c) => !c.taken).length;
      hudEl.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${tilesDrawn}  /  Entities : ${entities}\n` +
        `Player tile : (${ptx}, ${pty})\n` +
        `Score : ${score}   Coins : ${coinsCollected}   HP : ${player.hp}\n` +
        `Enemies : ${enemies.length} / ${enemySet}   (+/- で増減, 上限 ${ENEMY_MAX})`;
    }

    // タイトル点滅 (アトラクト中のみ)
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
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
    // HUD は等倍のまま (オーバーレイなのでスケールしない)
  }
  fit();
  window.addEventListener('resize', fit);

  console.log('[PixiJS v8] theme5 platformer init ok. renderer =', app.renderer.type);
})();
