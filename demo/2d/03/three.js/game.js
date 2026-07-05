/* ============================================================================
 * テーマ3 トップダウンRPG探索 (マップ歩行) - three.js (r184) 実装
 * 共通仕様 SPEC.md / 正準実装 PixiJS に厳密準拠。性能比較用。
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0, -1000, 1000) で 1ワールド単位 = 1px、原点左下・Y上向き。
 *   - ゲームロジックは画面座標 (Y 下向き, PixiJS と同一定数) のまま保持し、
 *     描画同期時のみ worldY = H - gameY に変換する。
 *   - スプライトは THREE.Sprite、重ね順は renderOrder (depthTest:false)。
 *   - 広大マップ(100x100=1万タイル)は可視範囲だけ描く: タイル/木のスプライトを
 *     可視枚数ぶんプール確保し、毎フレーム可視タイルへテクスチャ・座標を割り当て再利用。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC / PixiJS と同一値) -----------------------------------------
const TILE = 32;
const MAP_W = 100;
const MAP_H = 100;
const VIEW_W = 960;
const VIEW_H = 540;
const SPEED = 160;          // px/s
const DASH_MULT = 2;
const INIT_ENTITIES = 60;
const SLIME_SPEED = 50;     // px/s
const KNOCKBACK = 90;       // px

const T_GRASS = 0, T_PATH = 1, T_WATER = 2, T_WALL = 3, T_TREE = 4;
const BLOCKED = new Set([T_WATER, T_WALL, T_TREE]);

// フォールバック色 (#rrggbb)
const COL = {
  grass: '#4a7c3a', path: '#9b6b3a', water: '#2f6fb0',
  wall: '#6b6b6b', tree: '#2f5d2a', treeTrunk: '#5a3a1a',
  player: '#ffffff', npc: '#f2d33c', slime: '#6fd06f',
};

const ASSET_DEFS = {
  tile_grass:  '../assets/tile_grass.png',
  tile_path:   '../assets/tile_path.png',
  tile_water:  '../assets/tile_water.png',
  tile_wall:   '../assets/tile_wall.png',
  tree:        '../assets/tree.png',
  player:      '../assets/player.png',
  player_walk: '../assets/player_walk.png',
  npc:         '../assets/npc.png',
  npc_walk:    '../assets/npc_walk.png',
  enemy_slime: '../assets/enemy_slime.png',
  enemy_slime_walk: '../assets/enemy_slime_walk.png',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 描画順: 地面(タイル) < 木/エンティティ/自機(深度ソート)
const RO_TILE = 0, RO_ENT = 10;

// ---- 決定的擬似乱数 (mulberry32) — PixiJS と同一 ---------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMap() {
  const rnd = mulberry32(1337);
  const map = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < map.length; i++) map[i] = T_GRASS;
  const idx = (x, y) => y * MAP_W + x;

  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      const r = rnd();
      if (r < 0.06) map[idx(x, y)] = T_WATER;
      else if (r < 0.14) map[idx(x, y)] = T_TREE;
      else if (r < 0.17) map[idx(x, y)] = T_WALL;
    }
  }
  const lanes = 6;
  for (let i = 0; i < lanes; i++) {
    const ry = 6 + Math.floor(rnd() * (MAP_H - 12));
    for (let x = 1; x < MAP_W - 1; x++) map[idx(x, ry)] = T_PATH;
    const rx = 6 + Math.floor(rnd() * (MAP_W - 12));
    for (let y = 1; y < MAP_H - 1; y++) map[idx(rx, y)] = T_PATH;
  }
  for (let x = 0; x < MAP_W; x++) { map[idx(x, 0)] = T_WALL; map[idx(x, MAP_H - 1)] = T_WALL; }
  for (let y = 0; y < MAP_H; y++) { map[idx(0, y)] = T_WALL; map[idx(MAP_W - 1, y)] = T_WALL; }
  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_WALL;
  return map[ty * MAP_W + tx];
}
function rectBlocked(map, px, py, w, h) {
  const x0 = Math.floor(px / TILE), y0 = Math.floor(py / TILE);
  const x1 = Math.floor((px + w - 1) / TILE), y1 = Math.floor((py + h - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      if (BLOCKED.has(tileAt(map, tx, ty))) return true;
  return false;
}

// === シーン/カメラ/レンダラ =================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);
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
const FB = {
  tile_grass:  () => canvasTexture('tg', TILE, TILE, (g) => { g.fillStyle = COL.grass; g.fillRect(0, 0, TILE, TILE); }),
  tile_path:   () => canvasTexture('tp', TILE, TILE, (g) => { g.fillStyle = COL.path; g.fillRect(0, 0, TILE, TILE); }),
  tile_water:  () => canvasTexture('tw', TILE, TILE, (g) => { g.fillStyle = COL.water; g.fillRect(0, 0, TILE, TILE); g.fillStyle = 'rgba(111,168,224,0.6)'; g.fillRect(4, 8, 10, 3); g.fillRect(16, 20, 10, 3); }),
  tile_wall:   () => canvasTexture('twl', TILE, TILE, (g) => { g.fillStyle = COL.wall; g.fillRect(0, 0, TILE, TILE); g.strokeStyle = '#444'; g.lineWidth = 2; g.strokeRect(1, 1, TILE - 2, TILE - 2); }),
  tree:        () => canvasTexture('tr', 32, 48, (g) => { g.fillStyle = COL.treeTrunk; g.fillRect(13, 32, 6, 16); g.fillStyle = COL.tree; g.beginPath(); g.arc(16, 18, 15, 0, 7); g.fill(); }),
  player:      () => canvasTexture('pl', TILE, TILE, (g) => { g.fillStyle = COL.player; g.fillRect(2, 2, TILE - 4, TILE - 4); g.fillStyle = '#222'; g.beginPath(); g.arc(11, 13, 2.5, 0, 7); g.fill(); g.beginPath(); g.arc(21, 13, 2.5, 0, 7); g.fill(); }),
  npc:         () => canvasTexture('np', TILE, TILE, (g) => { g.fillStyle = COL.npc; g.fillRect(3, 3, TILE - 6, TILE - 6); }),
  enemy_slime: () => canvasTexture('sl', TILE, TILE, (g) => { g.fillStyle = COL.slime; g.beginPath(); g.arc(16, 18, 12, 0, 7); g.fill(); g.fillStyle = '#143a14'; g.beginPath(); g.arc(11, 15, 2, 0, 7); g.fill(); g.beginPath(); g.arc(21, 15, 2, 0, 7); g.fill(); }),
};
function texOf(key) { return tex[key] || FB[key](); }

function makeSprite(texture, w, h, renderOrder) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  // Sprite はデフォルト中心アンカー。topleft 基準で扱うため center を左上に。
  s.center.set(0, 1);   // (0,1)=左上 (THREE Sprite の center は左下原点UV)
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  return s;
}

function makeActorSprite(kind) {
  const walkKey = kind === 'slime' ? 'enemy_slime_walk' : `${kind}_walk`;
  const baseKey = kind === 'slime' ? 'enemy_slime' : kind;
  const walkTex = tex[walkKey];
  const map = (walkTex || texOf(baseKey)).clone();
  map.needsUpdate = true;
  map.magFilter = THREE.NearestFilter;
  const s = makeSprite(map, TILE, TILE, RO_ENT);
  s.userData.walk = !!walkTex;
  s.userData.animT = 0;
  s.userData.faceDir = 'down';
  if (walkTex) map.repeat.set(1 / 4, 1 / 4);
  return s;
}

function walkRow(sprite, dx, dy) {
  if (dx !== 0 || dy !== 0) sprite.userData.faceDir = Math.abs(dx) > Math.abs(dy)
    ? (dx < 0 ? 'left' : 'right')
    : (dy < 0 ? 'up' : 'down');
  return { down: 0, up: 1, left: 2, right: 3 }[sprite.userData.faceDir || 'down'];
}

function updateActorFrame(sprite, dx, dy, moving, dt) {
  if (!sprite.userData.walk) return;
  sprite.userData.animT = moving ? sprite.userData.animT + dt : 0;
  const row = walkRow(sprite, dx, dy);
  const col = moving ? Math.floor(sprite.userData.animT * 8) % 4 : 0;
  sprite.material.map.offset.set(col / 4, (3 - row) / 4);
}

(async function main() {
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
  const map = generateMap();

  // worldY = H - gameY。topleft 基準スプライトは左上を (gx, H-gy) に置く。
  const place = (s, gx, gy) => s.position.set(gx, VIEW_H - gy, s.renderOrder * 0.001);

  const tileTexByType = {
    [T_GRASS]: texOf('tile_grass'), [T_PATH]: texOf('tile_path'),
    [T_WATER]: texOf('tile_water'), [T_WALL]: texOf('tile_wall'),
    [T_TREE]: texOf('tile_grass'),
  };

  // ---- タイル/木 スプライトプール (可視範囲ぶん) ----
  const colsVis = Math.ceil(VIEW_W / TILE) + 2;
  const rowsVis = Math.ceil(VIEW_H / TILE) + 2;
  const POOL = colsVis * rowsVis;

  const tilePool = [];
  for (let i = 0; i < POOL; i++) {
    const s = makeSprite(tileTexByType[T_GRASS], TILE, TILE, RO_TILE);
    s.visible = false; tilePool.push(s); scene.add(s);
  }
  const treeTex = texOf('tree');
  const treePool = [];
  for (let i = 0; i < POOL; i++) {
    const s = makeSprite(treeTex, 32, 48, RO_ENT);
    s.visible = false; treePool.push(s); scene.add(s);
  }

  // ---- プレイヤー ----
  function findOpenTile() {
    const rnd = mulberry32(99);
    for (let tries = 0; tries < 5000; tries++) {
      const tx = 1 + Math.floor(rnd() * (MAP_W - 2));
      const ty = 1 + Math.floor(rnd() * (MAP_H - 2));
      if (!BLOCKED.has(tileAt(map, tx, ty))) return { tx, ty };
    }
    return { tx: 1, ty: 1 };
  }
  const spawn = findOpenTile();
  const player = {
    x: spawn.tx * TILE, y: spawn.ty * TILE, w: 28, h: 28, kx: 0, ky: 0,
    sprite: makeActorSprite('player'),
  };
  scene.add(player.sprite);

  // ---- タイトル/アトラクト状態 ----
  let started = false, blinkT = 0;
  const titleEl = document.getElementById('title');
  const demoRnd = mulberry32(20240619);
  let demoTarget = null, demoStuckT = 0;
  function pickDemoTarget() {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(demoRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(demoRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(map, tx, ty)) && guard < 100);
    demoTarget = { x: tx * TILE, y: ty * TILE };
  }
  pickDemoTarget();
  function demoInput() {
    if (!demoTarget) pickDemoTarget();
    const cx = player.x + player.w / 2, cy = player.y + player.h / 2;
    const tx = demoTarget.x + player.w / 2, ty = demoTarget.y + player.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (Math.hypot(dx, dy) < TILE * 0.6) { pickDemoTarget(); demoStuckT = 0; return { mx: 0, my: 0 }; }
    let mx = 0, my = 0;
    // 目標へ向けて、距離の大きい軸を選んで移動（上下左右の4方向）
    if (Math.abs(dx) > Math.abs(dy)) mx = dx > 0 ? 1 : -1;
    else my = dy > 0 ? 1 : -1;
    return { mx, my };
  }
  function resetGame() {
    player.x = spawn.tx * TILE; player.y = spawn.ty * TILE;
    player.kx = 0; player.ky = 0;
    setEntityCount(INIT_ENTITIES);
  }
  function startGame() {
    started = true; resetGame();
    titleEl.style.display = 'none';
  }

  // ---- エンティティ ----
  const entRnd = mulberry32(424242);
  const entities = [];
  function spawnEntity(type) {
    let tx, ty, guard = 0;
    do {
      tx = 1 + Math.floor(entRnd() * (MAP_W - 2));
      ty = 1 + Math.floor(entRnd() * (MAP_H - 2));
      guard++;
    } while (BLOCKED.has(tileAt(map, tx, ty)) && guard < 50);
    const s = makeActorSprite(type);
    scene.add(s);
    entities.push({ type, x: tx * TILE + 2, y: ty * TILE + 2, w: 28, h: 28, vx: 0, vy: 0, t: entRnd() * 3, sprite: s });
  }
  function removeEntity() {
    const e = entities.pop();
    if (e) { scene.remove(e.sprite); e.sprite.material.dispose(); }
  }
  function setEntityCount(n) {
    n = Math.max(0, n);
    while (entities.length < n) spawnEntity(entities.length % 2 === 0 ? 'slime' : 'npc');
    while (entities.length > n) removeEntity();
  }
  setEntityCount(INIT_ENTITIES);

  let _treeCount = -1;
  function countTrees() {
    if (_treeCount >= 0) return _treeCount;
    let c = 0;
    for (let i = 0; i < map.length; i++) if (map[i] === T_TREE) c++;
    _treeCount = c; return c;
  }

  // ---- 入力 ----
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Enter' && !started) startGame();
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { setEntityCount(entities.length + 10); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { setEntityCount(entities.length - 10); e.preventDefault(); }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // ---- 移動・衝突 ----
  function moveActor(actor, dx, dy) {
    if (dx !== 0) { const nx = actor.x + dx; if (!rectBlocked(map, nx, actor.y, actor.w, actor.h)) actor.x = nx; }
    if (dy !== 0) { const ny = actor.y + dy; if (!rectBlocked(map, actor.x, ny, actor.w, actor.h)) actor.y = ny; }
  }
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---- HUD / ループ ----
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;
  let tilesDrawn = 0, treesDrawn = 0;
  let dashOn = false;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // --- プレイヤー入力 (アトラクト中はデモAI) ---
    let mx = 0, my = 0;
    if (!started) {
      const d = demoInput();
      mx = d.mx; my = d.my;
      dashOn = false;
    } else {
      if (down('ArrowLeft', 'KeyA')) mx -= 1;
      if (down('ArrowRight', 'KeyD')) mx += 1;
      if (down('ArrowUp', 'KeyW')) my -= 1;
      if (down('ArrowDown', 'KeyS')) my += 1;
      dashOn = down('ShiftLeft', 'ShiftRight');
    }
    const sp = SPEED * (dashOn ? DASH_MULT : 1) * dt;
    const _bx = player.x, _by = player.y;
    moveActor(player, mx * sp, my * sp);
    updateActorFrame(player.sprite, player.x - _bx, player.y - _by, player.x !== _bx || player.y !== _by, dt);
    if (!started) {
      if ((mx !== 0 || my !== 0) && player.x === _bx && player.y === _by) {
        demoStuckT += dt;
        if (demoStuckT > 0.4) { pickDemoTarget(); demoStuckT = 0; }
      } else demoStuckT = 0;
    }

    if (player.kx !== 0 || player.ky !== 0) {
      moveActor(player, player.kx * dt, player.ky * dt);
      player.kx = 0; player.ky *= 0.85;
      if (Math.abs(player.kx) < 1) player.kx = 0;
      if (Math.abs(player.ky) < 1) player.ky = 0;
    }

    // --- エンティティ更新 ---
    for (const e of entities) {
      e.t -= dt;
      if (e.t <= 0) {
        e.t = 0.6 + entRnd() * 2.0;
        const dir = Math.floor(entRnd() * 5);
        const s = (e.type === 'slime' ? SLIME_SPEED : SLIME_SPEED * 0.7);
        e.vx = 0; e.vy = 0;
        if (dir === 0) e.vy = -s;
        else if (dir === 1) e.vy = s;
        else if (dir === 2) e.vx = -s;
        else if (dir === 3) e.vx = s;
      }
      if (e.vx !== 0 || e.vy !== 0) {
        const bx = e.x, by = e.y;
        moveActor(e, e.vx * dt, e.vy * dt);
        if (e.x === bx && e.y === by) e.t = 0;
        updateActorFrame(e.sprite, e.x - bx, e.y - by, e.x !== bx || e.y !== by, dt);
      } else {
        updateActorFrame(e.sprite, 0, 0, false, dt);
      }
      if (e.type === 'slime' && aabb(player, e)) {
        const cx = (player.x + player.w / 2) - (e.x + e.w / 2);
        const cy = (player.y + player.h / 2) - (e.y + e.h / 2);
        const len = Math.hypot(cx, cy) || 1;
        player.kx = 0;
        player.ky = (cy / len) * KNOCKBACK;
      }
    }

    // --- カメラ追従 ---
    const camX = Math.round(player.x + player.w / 2 - VIEW_W / 2);
    const camY = Math.round(player.y + player.h / 2 - VIEW_H / 2);
    const clX = clamp(camX, 0, MAP_W * TILE - VIEW_W);
    const clY = clamp(camY, 0, MAP_H * TILE - VIEW_H);

    // --- タイルカリング描画 (可視範囲のみ / プール再利用) ---
    const startTx = Math.floor(clX / TILE);
    const startTy = Math.floor(clY / TILE);
    tilesDrawn = 0;
    let pi = 0, ti = 0;
    for (let row = 0; row < rowsVis; row++) {
      const ty = startTy + row;
      if (ty < 0 || ty >= MAP_H) continue;
      for (let col = 0; col < colsVis; col++) {
        const tx = startTx + col;
        if (tx < 0 || tx >= MAP_W) continue;
        const type = map[ty * MAP_W + tx];
        const s = tilePool[pi++];
        if (!s) break;
        s.material.map = tileTexByType[type];
        // 画面座標: tile*32 - cam。topleft アンカーなので worldY=H-gameY。
        place(s, tx * TILE - clX, ty * TILE - clY);
        s.visible = true;
        tilesDrawn++;
        if (type === T_TREE) {
          const tr = treePool[ti++];
          if (tr) {
            // 木は 32x48、足元(タイル下端)を合わせるため gy = ty*32 - 16
            place(tr, tx * TILE - clX, ty * TILE - 16 - clY);
            tr.renderOrder = RO_ENT + (ty * TILE + 48) * 0.0001;
            tr.visible = true;
          }
        }
      }
    }
    for (; pi < tilePool.length; pi++) tilePool[pi].visible = false;
    treesDrawn = ti;
    for (; ti < treePool.length; ti++) treePool[ti].visible = false;

    // --- エンティティ描画 + 深度ソート(y順 → renderOrder) ---
    for (const e of entities) {
      place(e.sprite, e.x - 2 - clX, e.y - 2 - clY);
      e.sprite.renderOrder = RO_ENT + (e.y + e.h) * 0.0001;
    }
    place(player.sprite, player.x - 2 - clX, player.y - 2 - clY);
    player.sprite.renderOrder = RO_ENT + (player.y + player.h) * 0.0001;

    // --- HUD ---
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const ptx = Math.floor((player.x + player.w / 2) / TILE);
      const pty = Math.floor((player.y + player.h / 2) / TILE);
      const treeCount = countTrees();
      hudEl.textContent =
        `FPS         : ${fpsAvg.toFixed(1)}\n` +
        `Tiles drawn : ${tilesDrawn}  (trees: ${treesDrawn})\n` +
        `Entities    : ${entities.length + treeCount}  (NPC+敵:${entities.length} / 木:${treeCount})\n` +
        `Player tile : (${ptx}, ${pty})  ${dashOn ? '[DASH]' : ''}`;
    }

    renderer.render(scene, camera);

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  console.log('three.js トップダウンRPG探索 started. renderer: WebGL');
}
