/* ============================================================================
 * テーマ5 横スクロールアクション ― three.js (r184) 実装
 * 共通仕様 SPEC.md / 正準実装 PixiJS に厳密準拠。性能比較用。
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0, -1000, 1000) で 1ワールド単位 = 1px、原点左下・
 *     Y 上向き。ゲームロジックは画面座標 (Y 下向き, PixiJS と同一定数) のまま保持し、
 *     描画同期時のみ worldY = H - gameY に変換する。
 *   - 広い横長マップ (200x17 = 6400x544px) の水平スクロールは、ワールド全体を載せた
 *     THREE.Group を -camX, +camY 平行移動して表現する (= カメラ追従)。
 *   - スプライトは THREE.Sprite + renderOrder (depthTest:false)。
 *   - タイルは可視範囲ぶんの Sprite プールを確保し、毎フレーム可視タイルへテクスチャ・
 *     座標を割り当てて再利用する真のカリング (PixiJS と同方式)。
 *   - 物理 (重力 + 可変ジャンプ + AABB 軸分離) は SPEC 準拠の自前実装。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const TILE = 32;
const MAP_W = 200;
const MAP_H = 17;
const VIEW_W = 960;
const VIEW_H = 540;
const WORLD_W = MAP_W * TILE;     // 6400
const WORLD_H = MAP_H * TILE;     // 544

const GRAVITY = 1800;
const WALK_SPEED = 180;
const DASH_SPEED = 288;
const JUMP_VY = -640;
const JUMP_CUT = 0.45;
const FALL_MARGIN = 80;

const P_W = 24, P_H = 44;
const P_DRAW_W = 32, P_DRAW_H = 48;
const P_HP = 3;
const INVULN = 1.0;
const KNOCKBACK_X = 220;
const KNOCKBACK_Y = -260;

const E_W = 28, E_H = 28;
const E_SPEED = 60;
const STOMP_BOUNCE = -380;
const SCORE_STOMP = 100;
const SCORE_COIN = 50;

const ENEMY_INIT = 20;
const ENEMY_STEP = 10;
const ENEMY_MIN = 0;
const ENEMY_MAX = 500;

const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = new Set([T_GROUND, T_BRICK, T_PIPE]);

const ASSET_DEFS = {
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

const SKY = 0x6ab4ff;
// renderOrder: bg < tile < coin < enemy < player < fx
const RO = { bg: 0, tile: 1, coin: 2, enemy: 3, player: 4, fx: 5 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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

// ---- マップ決定的生成 (PixiJS と同一) -------------------------------------
function generateMap() {
  const rnd = mulberry32(20250614);
  const map = new Uint8Array(MAP_W * MAP_H);
  const idx = (x, y) => y * MAP_W + x;
  const GROUND_TOP = MAP_H - 2;

  let x = 0;
  while (x < MAP_W) {
    // 地面の連続区間を敷く
    const run = 5 + Math.floor(rnd() * 6);
    for (let i = 0; i < run && x < MAP_W; i++, x++) {
      map[idx(x, GROUND_TOP)] = T_GROUND;
      map[idx(x, MAP_H - 1)] = T_GROUND;
    }
    // その後に幅1の穴を1つだけ（連続穴を防ぎ、デモが必ず越えられる幅にする）
    if (x > 8 && x < MAP_W - 8 && rnd() < 0.30) x += 1;
  }
  // 浮遊ブロックはジャンプ頂点(約3.5タイル)より上(py<=9)にのみ置く。
  // 地表付近(py>=10)に置くと穴や土管を越えるジャンプの天井になり、デモが詰まる/落下するため。
  for (let i = 0; i < 70; i++) {
    const px = 6 + Math.floor(rnd() * (MAP_W - 12));
    const py = 4 + Math.floor(rnd() * 6); // 4..9 (走路の天井を作らない高さ)
    const len = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < len && px + k < MAP_W - 2; k++) {
      const bx = px + k;
      if (map[idx(bx, py)] === T_EMPTY) map[idx(bx, py)] = T_BRICK;
    }
  }
  // 穴の近く(±4)に地面があるか（土管を穴の手前/直後に置くと、土管越えジャンプが穴に着地して
  // デモが落下するため、穴付近には土管を置かない）。
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (tileAt(map, g, GROUND_TOP) !== T_GROUND) return false;
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const px = 12 + Math.floor(rnd() * (MAP_W - 24));
    if (map[idx(px, GROUND_TOP)] === T_GROUND && map[idx(px + 1, GROUND_TOP)] === T_GROUND && noGapNear(px)) {
      const h = 1 + Math.floor(rnd() * 2);
      for (let k = 1; k <= h; k++) {
        map[idx(px, GROUND_TOP - k)] = T_PIPE;
        map[idx(px + 1, GROUND_TOP - k)] = T_PIPE;
      }
    }
  }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_GROUND; map[idx(MAP_W - 1, y)] = T_GROUND; }
  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return T_EMPTY;
  return map[ty * MAP_W + tx];
}
function rectHitsSolid(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE), y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE), y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (SOLID.has(tileAt(map, tx, ty))) return true;
  }
  return false;
}

// === シーン / カメラ / レンダラ =============================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
// left=0, right=W, top=H, bottom=0 → x:0..W / y:0..H (Y上向き)
const camera = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);          // 性能比較のため DPR=1 固定
renderer.setSize(VIEW_W, VIEW_H);
document.getElementById('game-container').appendChild(renderer.domElement);

// === テクスチャ (画像 or canvas フォールバック) =============================
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
// フォールバック図形 (SPEC: 自機=赤, goomba=茶丸, 地面=茶, ブロック=橙, 土管=緑, コイン=黄丸)
const FB = {
  player:      () => canvasTexture('player', 32, 48, (g) => { g.fillStyle = '#e23b2e'; g.fillRect(2, 2, 28, 44); g.fillStyle = '#ffe0c0'; g.fillRect(4, 4, 24, 10); g.fillStyle = '#222'; g.beginPath(); g.arc(11, 9, 2, 0, 7); g.arc(21, 9, 2, 0, 7); g.fill(); }),
  goomba:      () => canvasTexture('goomba', 32, 32, (g) => { g.fillStyle = '#8a5a2b'; g.beginPath(); g.ellipse(16, 14, 13, 11, 0, 0, 7); g.fill(); g.fillStyle = '#3a2410'; g.fillRect(8, 24, 16, 6); g.fillStyle = '#fff'; g.beginPath(); g.arc(11, 13, 2.5, 0, 7); g.arc(21, 13, 2.5, 0, 7); g.fill(); }),
  tile_ground: () => canvasTexture('tg', 32, 32, (g) => { g.fillStyle = '#9b6b3a'; g.fillRect(0, 0, 32, 32); g.fillStyle = '#6e9b3a'; g.fillRect(0, 0, 32, 4); }),
  tile_brick:  () => canvasTexture('tb', 32, 32, (g) => { g.fillStyle = '#d08030'; g.fillRect(0, 0, 32, 32); g.strokeStyle = '#8a5418'; g.lineWidth = 2; g.strokeRect(1, 1, 30, 30); g.beginPath(); g.moveTo(0, 16); g.lineTo(32, 16); g.stroke(); }),
  tile_pipe:   () => canvasTexture('tp', 32, 32, (g) => { g.fillStyle = '#3aa64a'; g.fillRect(0, 0, 32, 32); g.strokeStyle = '#216b2a'; g.lineWidth = 2; g.strokeRect(2, 0, 28, 32); g.fillStyle = 'rgba(139,227,154,0.5)'; g.fillRect(5, 3, 5, 26); }),
  coin:        () => canvasTexture('coin', 24, 24, (g) => { g.fillStyle = '#f2d33c'; g.beginPath(); g.arc(12, 12, 10, 0, 7); g.fill(); g.strokeStyle = '#c9a51e'; g.lineWidth = 2; g.stroke(); }),
  spark:       () => canvasTexture('spark', 16, 16, (g) => { g.fillStyle = '#fff2a8'; g.beginPath(); g.arc(8, 8, 7, 0, 7); g.fill(); }),
};
function texOf(key) {
  return tex[key] || (FB[key] && FB[key]()) || tex[key.replace('_walk', '')] || FB[key.replace('_walk', '')]();
}

function makeSprite(key, w, h, renderOrder, frames = 1, rows = 1) {
  let map = texOf(key);
  if (frames > 1 || rows > 1) {
    map = map.clone();
    map.repeat.set(1 / frames, 1 / rows);
    map.needsUpdate = true;
  }
  const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.center.set(0, 0);                 // 左下原点アンカー (worldY=H-y 変換と整合)
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  s.userData.frames = frames;
  s.userData.rows = rows;
  s.userData.frame = -1;
  s.userData.row = -1;
  return s;
}

function setSpriteFrame(s, frame, row = 0) {
  const frames = s.userData.frames || 1;
  const rows = s.userData.rows || 1;
  frame = ((frame % frames) + frames) % frames;
  row = Math.max(0, Math.min(rows - 1, row));
  if (frames <= 1 && rows <= 1) return;
  if (s.userData.frame === frame && s.userData.row === row) return;
  s.material.map.offset.x = frame / frames;
  s.material.map.offset.y = (rows - 1 - row) / rows;
  s.userData.frame = frame;
  s.userData.row = row;
}

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { const t = await loader.loadAsync(url); t.colorSpace = THREE.SRGBColorSpace; tex[key] = t; }
    catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  const map = generateMap();

  // ---- ワールド Group (カメラ追従で -camX, +camY 平行移動) ----
  const world = new THREE.Group();
  scene.add(world);

  // ---- 背景 (画面固定: 大きな空色 Plane + 軽い視差は割愛し単色) ----
  // bg_sky 画像があれば repeat タイル Plane を画面固定で敷く。
  let bgMesh = null;
  if (tex.bg_sky) {
    tex.bg_sky.wrapS = tex.bg_sky.wrapT = THREE.RepeatWrapping;
    tex.bg_sky.repeat.set(VIEW_W / 512, VIEW_H / 512);
    bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(VIEW_W, VIEW_H),
      new THREE.MeshBasicMaterial({ map: tex.bg_sky, depthTest: false }));
    bgMesh.position.set(VIEW_W / 2, VIEW_H / 2, -10);
    bgMesh.renderOrder = RO.bg;
    scene.add(bgMesh); // world ではなく scene 直下 = 画面固定
  }

  // ---- タイル描画プール (可視範囲のみ / Sprite 再利用カリング) ----
  const colsVis = Math.ceil(VIEW_W / TILE) + 2;
  const rowsVis = Math.ceil(VIEW_H / TILE) + 2;
  const tileTexByType = { [T_GROUND]: texOf('tile_ground'), [T_BRICK]: texOf('tile_brick'), [T_PIPE]: texOf('tile_pipe') };
  const tilePool = [];
  for (let i = 0; i < colsVis * rowsVis; i++) {
    const s = makeSprite('tile_ground', TILE, TILE, RO.tile);
    s.visible = false;
    tilePool.push(s);
    world.add(s);
  }

  // ---- コイン (決定的配置) ----
  const coins = [];
  (function buildCoins() {
    const rnd = mulberry32(777);
    for (let tx = 2; tx < MAP_W - 2; tx++) for (let ty = 2; ty < MAP_H - 1; ty++) {
      if (tileAt(map, tx, ty) !== T_EMPTY) continue;
      if (!SOLID.has(tileAt(map, tx, ty + 1))) continue;
      if (rnd() < 0.10) {
        const s = makeSprite('coin', 24, 24, RO.coin);
        const x = tx * TILE + (TILE - 24) / 2, y = ty * TILE + (TILE - 24) / 2;
        s.position.set(x, H2(y) - 24, 0); world.add(s);
        coins.push({ x, y, w: 24, h: 24, taken: false, sprite: s });
      }
    }
  })();

  // ---- スポーン地点 ----
  const SPAWN_TX = 3;
  const GROUND_TOP_Y = (MAP_H - 2) * TILE;
  const spawn = { x: SPAWN_TX * TILE, y: GROUND_TOP_Y - P_H };

  // ---- プレイヤー ----
  const player = { x: spawn.x, y: spawn.y, w: P_W, h: P_H, vx: 0, vy: 0, onGround: false, hp: P_HP, invuln: 0, facing: 1 };
  const playerSprite = makeSprite('player_walk', P_DRAW_W, P_DRAW_H, RO.player, 4, 2);
  world.add(playerSprite);

  // ---- 敵スポーン候補 (決定的列挙 + シャッフル) ----
  const spawnSlots = [];
  (function buildSpawnSlots() {
    for (let tx = 5; tx < MAP_W - 5; tx++) for (let ty = 2; ty < MAP_H - 1; ty++) {
      if (tileAt(map, tx, ty) !== T_EMPTY) continue;
      if (SOLID.has(tileAt(map, tx, ty + 1))) spawnSlots.push({ tx, ty });
    }
    const rnd = mulberry32(31337);
    for (let i = spawnSlots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = spawnSlots[i]; spawnSlots[i] = spawnSlots[j]; spawnSlots[j] = t;
    }
  })();

  const enemies = [];
  const enemyPool = [];
  function getEnemySprite() {
    let s = enemyPool.pop();
    if (!s) { s = makeSprite('goomba_walk', 32, 32, RO.enemy, 4, 2); world.add(s); }
    s.visible = true;
    return s;
  }
  let enemySet = 0;
  function setEnemyCount(n) {
    n = clamp(n, ENEMY_MIN, ENEMY_MAX);
    while (enemies.length < n) {
      const i = enemies.length;
      const slot = spawnSlots[i % spawnSlots.length];
      const dir = (i % 2 === 0) ? 1 : -1;
      enemies.push({
        x: slot.tx * TILE + (TILE - E_W) / 2, y: slot.ty * TILE + (TILE - E_H),
        w: E_W, h: E_H, vx: dir * E_SPEED, vy: 0, onGround: false, alive: true, sprite: getEnemySprite(),
      });
    }
    while (enemies.length > n) { const e = enemies.pop(); e.sprite.visible = false; enemyPool.push(e.sprite); }
    enemySet = n;
  }
  setEnemyCount(ENEMY_INIT);

  // ---- 火花 ----
  const sparks = [];
  const sparkPool = [];
  function spawnSpark(x, y) {
    let s = sparkPool.pop();
    if (!s) { s = makeSprite('spark', 16, 16, RO.fx); s.center.set(0.5, 0.5); world.add(s); }
    s.visible = true; s.material.opacity = 1;
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
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { setEnemyCount(enemySet + ENEMY_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { setEnemyCount(enemySet - ENEMY_STEP); e.preventDefault(); }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // worldY = H - gameY 変換 (世界全体 H = WORLD_H を基準にし、世界 Group を camY で持ち上げる)
  function H2(gameY) { return WORLD_H - gameY; }

  // ---- 当たり判定 (AABB) ----
  function aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
  function moveAndCollide(a, dx, dy) {
    let hitX = false, hitY = false;
    if (dx !== 0) {
      let nx = a.x + dx;
      if (rectHitsSolid(map, nx, a.y, a.w, a.h)) {
        if (dx > 0) nx = Math.floor((nx + a.w) / TILE) * TILE - a.w - 0.001;
        else nx = Math.floor(nx / TILE + 1) * TILE + 0.001;
        a.vx = 0; hitX = true;
      }
      a.x = nx;
    }
    a.onGround = false;
    if (dy !== 0) {
      let ny = a.y + dy;
      if (rectHitsSolid(map, a.x, ny, a.w, a.h)) {
        if (dy > 0) { ny = Math.floor((ny + a.h) / TILE) * TILE - a.h - 0.001; a.onGround = true; }
        else ny = Math.floor(ny / TILE + 1) * TILE + 0.001;
        a.vy = 0; hitY = true;
      }
      a.y = ny;
    }
    return { hitX, hitY };
  }

  let score = 0, coinsCollected = 0, tilesDrawn = 0;

  function respawnPlayer() {
    player.x = spawn.x; player.y = spawn.y; player.vx = 0; player.vy = 0; player.hp = P_HP; player.invuln = INVULN; player.onGround = false;
  }
  function hurtPlayer(fromX) {
    if (player.invuln > 0) return;
    player.hp -= 1; player.invuln = INVULN;
    const dir = (player.x + player.w / 2) < fromX ? -1 : 1;
    player.vx = KNOCKBACK_X * dir; player.vy = KNOCKBACK_Y; player.onGround = false;
    if (player.hp <= 0) respawnPlayer();
  }

  // Enter でデモ→プレイ開始: スコア等を新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    score = 0; coinsCollected = 0;
    for (let i = 0; i < coins.length; i++) { if (coins[i].taken) { coins[i].taken = false; coins[i].sprite.visible = true; } }
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

  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const dtMs = dt * 1000;
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();

    // 1) 入力 + 物理
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
    if (knockbackActive) { player.vx *= 0.9; if (Math.abs(player.vx) < speed) player.vx = move * speed; }
    else player.vx = move * speed;
    if (move !== 0) player.facing = move;

    if (jumpHeld && player.onGround) { player.vy = JUMP_VY; player.onGround = false; }
    if (!jumpHeld && player.vy < 0) player.vy *= JUMP_CUT;

    player.vy += GRAVITY * dt;
    if (player.vy > 1200) player.vy = 1200;
    moveAndCollide(player, player.vx * dt, player.vy * dt);

    if (player.invuln > 0) { player.invuln -= dt; if (player.invuln < 0) player.invuln = 0; }

    if (player.y > WORLD_H + FALL_MARGIN) {
      player.hp -= 1;
      if (player.hp <= 0) respawnPlayer();
      else { player.x = spawn.x; player.y = spawn.y; player.vx = 0; player.vy = 0; player.invuln = INVULN; }
    }

    // 2) 敵更新
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      e.vy += GRAVITY * dt; if (e.vy > 1200) e.vy = 1200;
      const dir = Math.sign(e.vx) || 1;
      const beforeX = e.x;
      const res = moveAndCollide(e, e.vx * dt, e.vy * dt);
      if (res.hitX || Math.abs(e.x - beforeX) < 0.01) e.vx = -dir * E_SPEED;
      else e.vx = dir * E_SPEED;
    }

    // 3) 自機 × 敵
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!aabb(player, e)) continue;
      const playerFalling = player.vy > 0;
      const stomp = playerFalling && ((player.y + player.h) - e.y) < (e.h * 0.6 + Math.abs(player.vy * dt) + 1);
      if (stomp) {
        e.sprite.visible = false; enemyPool.push(e.sprite);
        enemies[i] = enemies[enemies.length - 1]; enemies.pop(); i--;
        score += SCORE_STOMP; spawnSpark(e.x + e.w / 2, e.y + e.h / 2); player.vy = STOMP_BOUNCE;
      } else hurtPlayer(e.x + e.w / 2);
    }

    // 4) コイン
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c.taken) continue;
      if (aabb(player, c)) { c.taken = true; c.sprite.visible = false; coinsCollected += 1; score += SCORE_COIN; }
    }

    // 5) カメラ (水平追従 + クランプ) → world を平行移動
    const camX = clamp(Math.round(player.x + player.w / 2 - VIEW_W / 2), 0, WORLD_W - VIEW_W);
    const camY = clamp(Math.round(player.y + player.h / 2 - VIEW_H / 2), 0, Math.max(0, WORLD_H - VIEW_H));
    // world は worldY=WORLD_H-gameY で配置済み。画面に映すには x:-camX, y:-(WORLD_H-VIEW_H-camY)
    world.position.set(-camX, -(WORLD_H - VIEW_H - camY), 0);

    // 6) タイルカリング
    const startTx = Math.floor(camX / TILE);
    const startTy = Math.floor(camY / TILE);
    let pi = 0;
    for (let row = 0; row < rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        if (type === T_EMPTY) continue;
        const s = tilePool[pi++];
        if (!s) break;
        if (s.material.map !== tileTexByType[type]) { s.material.map = tileTexByType[type]; s.material.needsUpdate = true; }
        s.position.set(tx * TILE, H2(ty * TILE) - TILE, 0);
        s.visible = true;
      }
    }
    tilesDrawn = pi;
    for (; pi < tilePool.length; pi++) tilePool[pi].visible = false;

    // 7) スプライト位置反映
    const dirRow = player.facing < 0 ? 1 : 0;
    const playerFrame = Math.abs(player.vx) > 5 && player.onGround ? Math.floor(performance.now() / 110) % 4 : 0;
    setSpriteFrame(playerSprite, playerFrame, dirRow);
    playerSprite.center.set(0, 0);
    playerSprite.scale.set(P_DRAW_W, P_DRAW_H, 1);
    const pdx = player.x - (P_DRAW_W - P_W) / 2;
    const pdy = player.y - (P_DRAW_H - P_H);
    playerSprite.position.set(pdx, H2(pdy) - P_DRAW_H, 0);
    playerSprite.material.opacity = (player.invuln > 0 && Math.floor(player.invuln * 20) % 2 === 0) ? 0.35 : 1;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dx = e.x - (32 - E_W) / 2, dy = e.y - (32 - E_H);
      setSpriteFrame(e.sprite, Math.floor((performance.now() / 140) + i) % 4, e.vx < 0 ? 1 : 0);
      e.sprite.position.set(dx, H2(dy) - 32, 0);
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i]; sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.material.opacity = clamp(t, 0, 1);
      const sc = 16 * (1 + (1 - t) * 0.8);
      sp.sprite.scale.set(sc, sc, 1);
      sp.sprite.position.set(sp.x, H2(sp.y), 0);
      if (sp.life <= 0) { sp.sprite.visible = false; sparkPool.push(sp.sprite); sparks[i] = sparks[sparks.length - 1]; sparks.pop(); }
    }

    // 8) HUD
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
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

    renderer.render(scene, camera);

    // タイトル点滅 (アトラクト中のみ)
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('three.js theme5 platformer started. renderer: WebGL');
}
