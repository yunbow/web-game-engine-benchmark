/* ============================================================================
 * トップダウン・サバイバー - three.js (r184)
 * 共通仕様 ../SPEC.md に厳密準拠。性能比較用。
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0) で 1ワールド単位 = 1px、原点左下・Y上向き。
 *   - ゲームロジックは画面座標 (Y 下向き, 他エンジンと同一定数) のまま保持し、
 *     描画同期時のみ worldY = H - gameY に変換する (テクスチャの上下が崩れない)。
 *   - スプライトは THREE.Sprite (常にカメラを向く板) を使い、重ね順は renderOrder。
 *   - カメラ追従: camera.position を平行移動して自機を画面中央に置く。
 *   - 地面は 1枚の繰り返しテクスチャ Plane を自機位置に追従させ offset でスクロール。
 *   - ゲームループ/入力/円判定/配列管理は自前。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

const PLAYER_SPEED = 180;          // px/s
const PLAYER_RADIUS = 18;
const PLAYER_HP_INIT = 5;
const PLAYER_INVULN = 0.5;         // s

const FIRE_INTERVAL = 0.4;         // 400ms
const PROJ_SPEED = 350;            // px/s
const PROJ_RADIUS = 8;
const PROJ_LIFETIME = 2.0;

const ENEMY_SPEED_MIN = 60, ENEMY_SPEED_MAX = 90;
const BAT_RADIUS = 12, ZOMBIE_RADIUS = 16;
const BAT_HP = 1, ZOMBIE_HP = 3;

const GEM_RADIUS = 8, PICKUP_RADIUS = 22;

const SPAWN_INIT = 150, SPAWN_STEP = 50, SPAWN_MAX = 1000, SPAWN_MIN = 0;
const AUTO_GROW_INTERVAL = 10, AUTO_GROW_AMOUNT = 25;
const SPAWN_MARGIN = 60;
const TILE_SIZE = 64;
const SPAWN_PER_FRAME = 40;

const ASSET_DEFS = {
  // 静止画(player.png 等)は廃止。walk スプライトシートのみ使用し、欠落時は図形フォールバック。
  playerWalk: '../assets/player_walk.png?v=dir3',
  batWalk: '../assets/enemy_bat_walk.png?v=dir3',
  zombieWalk: '../assets/enemy_zombie_walk.png?v=dir3',
  proj:   '../assets/projectile.png',
  gem:    '../assets/xp_gem.png',
  ground: '../assets/ground_tile.png',
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RO = { ground: 0, gem: 1, enemy: 2, proj: 3, player: 4 }; // renderOrder

// === シーン/カメラ/レンダラ =================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101018);
// left=0, right=W, top=H, bottom=0 → x:0..W / y:0..H (Y上向き)
const camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);          // 性能比較のため DPR=1 固定
renderer.setSize(W, H);
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
const fb = {
  player: () => canvasTexture('player', 48, 48, (g) => { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(24, 24, 22, 0, 7); g.fill(); }),
  bat:    () => canvasTexture('bat', 32, 32, (g) => { g.fillStyle = '#9b59ff'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); }),
  zombie: () => canvasTexture('zombie', 40, 40, (g) => { g.fillStyle = '#47d16a'; g.beginPath(); g.arc(20, 20, 19, 0, 7); g.fill(); }),
  proj:   () => canvasTexture('proj', 24, 24, (g) => { g.fillStyle = '#ffe34d'; g.beginPath(); g.arc(12, 12, 11, 0, 7); g.fill(); }),
  gem:    () => canvasTexture('gem', 16, 16, (g) => { g.fillStyle = '#4dd6ff'; g.beginPath(); g.moveTo(8, 0); g.lineTo(16, 8); g.lineTo(8, 16); g.lineTo(0, 8); g.closePath(); g.fill(); }),
  ground: () => canvasTexture('ground', 64, 64, (g) => { g.fillStyle = '#1b1b26'; g.fillRect(0, 0, 64, 64); g.strokeStyle = '#262633'; g.lineWidth = 2; g.strokeRect(1, 1, 62, 62); }),
};

function makeSprite(texture, w, h, renderOrder) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  return s;
}

function makeWalkSprite(sheet, still, w, h, renderOrder) {
  const map = (sheet || still).clone();
  map.needsUpdate = true;
  const frames = sheet ? 4 : 1;
  const rows = sheet ? 4 : 1;
  if (sheet) {
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.repeat.set(1 / frames, 1 / rows);
  }
  const s = makeSprite(map, w, h, renderOrder);
  s.userData.anim = { frames, rows, t: 0, dir: 0 };
  return s;
}

function dirFrame(x, y) {
  if (y < 0) return 1;
  if (x < 0) return 2;
  if (x > 0) return 3;
  return 0;
}

function stepAnim(sprite, moving, dt, x = 0, y = 0) {
  const anim = sprite.userData.anim;
  if (!anim || anim.frames <= 1) return;
  anim.t = moving ? anim.t + dt : 0;
  if (moving) anim.dir = dirFrame(x, y);
  sprite.material.map.offset.x = (moving ? Math.floor(anim.t * 10) % anim.frames : 0) / anim.frames;
  sprite.material.map.offset.y = (anim.rows - anim.dir - 1) / anim.rows;
}

function cardinal(mx, my) {
  if (mx === 0 && my === 0) return { x: 0, y: 0 };
  if (Math.abs(mx) >= Math.abs(my)) return { x: Math.sign(mx), y: 0 };
  return { x: 0, y: Math.sign(my) };
}

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      const t = await loader.loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      tex[key] = t;
    } catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  // --- 地面: 繰り返しテクスチャの大きな Plane を自機に追従、offset でスクロール ---
  const groundTex = tex.ground || fb.ground();
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  // 画面より十分大きく、自機中心に置いて offset でスクロールさせる
  const GW = W + TILE_SIZE * 2, GH = H + TILE_SIZE * 2;
  groundTex.repeat.set(GW / TILE_SIZE, GH / TILE_SIZE);
  const groundMat = new THREE.MeshBasicMaterial({ map: groundTex, depthTest: false });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), groundMat);
  ground.renderOrder = RO.ground;
  scene.add(ground);

  // --- 自機 ---
  const player = {
    sprite: makeWalkSprite(tex.playerWalk, tex.player || fb.player(), 48, 48, RO.player),
    x: 0, y: 0, hp: PLAYER_HP_INIT, invuln: 0,
  };
  scene.add(player.sprite);

  const enemies = [], projectiles = [], gems = [];
  let kills = 0, spawnCap = SPAWN_INIT;
  let fireTimer = 0, autoGrowTimer = 0, time = 0;
  let over = false;
  let started = false, blinkT = 0, autoT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
  const titleEl = document.getElementById('title');

  // --- 入力 ---
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { spawnCap = Math.min(SPAWN_MAX, spawnCap + SPAWN_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { spawnCap = Math.max(SPAWN_MIN, spawnCap - SPAWN_STEP); e.preventDefault(); }
    else if ((e.code === 'Enter') && !started) { startGame(); e.preventDefault(); }
    else if ((e.code === 'KeyR') && over) { resetGame(); }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() { started = true; resetGame(); titleEl.style.display = 'none'; }

  // 画面座標(Y下) → ワールド(Y上) へ変換して同期
  const sync = (o) => { o.sprite.position.set(o.x, H - o.y, o.sprite.renderOrder * 0.01); };

  function rm(arr, i) {
    const o = arr[i]; scene.remove(o.sprite); o.sprite.material.dispose();
    arr[i] = arr[arr.length - 1]; arr.pop();
  }

  function resetGame() {
    for (let i = enemies.length - 1; i >= 0; i--) rm(enemies, i);
    for (let i = projectiles.length - 1; i >= 0; i--) rm(projectiles, i);
    for (let i = gems.length - 1; i >= 0; i--) rm(gems, i);
    player.x = 0; player.y = 0; player.hp = PLAYER_HP_INIT; player.invuln = 0;
    player.sprite.material.opacity = 1;
    kills = 0; spawnCap = SPAWN_INIT; fireTimer = 0; autoGrowTimer = 0; time = 0; over = false;
  }

  function spawnEnemy() {
    const isZombie = Math.random() < 0.3;
    const s = isZombie ? makeWalkSprite(tex.zombieWalk, tex.zombie || fb.zombie(), 40, 40, RO.enemy)
                       : makeWalkSprite(tex.batWalk, tex.bat || fb.bat(), 32, 32, RO.enemy);
    scene.add(s);
    const side = Math.floor(Math.random() * 4);
    const px = player.x, py = player.y;
    const halfW = W / 2 + SPAWN_MARGIN, halfH = H / 2 + SPAWN_MARGIN;
    let x, y;
    if (side === 0) { x = px - halfW; y = py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 1) { x = px + halfW; y = py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 2) { y = py - halfH; x = px + (Math.random() * 2 - 1) * halfW; }
    else { y = py + halfH; x = px + (Math.random() * 2 - 1) * halfW; }
    const e = { sprite: s, x, y, r: isZombie ? ZOMBIE_RADIUS : BAT_RADIUS,
      hp: isZombie ? ZOMBIE_HP : BAT_HP, speed: rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX) };
    sync(e); enemies.push(e);
  }
  function dropGem(x, y) {
    const s = makeSprite(tex.gem || fb.gem(), 16, 16, RO.gem); scene.add(s);
    const g = { sprite: s, x, y }; sync(g); gems.push(g);
  }
  function fireProjectile() {
    let best = null, bestD2 = Infinity;
    const px = player.x, py = player.y;
    for (const e of enemies) {
      const dx = e.x - px, dy = e.y - py, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    if (!best) return;
    const dx = best.x - px, dy = best.y - py, d = Math.hypot(dx, dy) || 1;
    const s = makeSprite(tex.proj || fb.proj(), 24, 24, RO.proj); scene.add(s);
    const p = { sprite: s, x: px, y: py, vx: (dx / d) * PROJ_SPEED, vy: (dy / d) * PROJ_SPEED, life: PROJ_LIFETIME };
    sync(p); projectiles.push(p);
  }

  // --- ループ ---
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    if (over && !started) resetGame();   // アトラクト中の被弾死はデモをループ再開

    if (!over) {
      // --- 自機移動 (8方向, 正規化) ---
      let mx = 0, my = 0;
      if (!started) {
        // デモAI: 累積時間ベースの sin で緩やかに周回/徘徊（決定的）
        autoT += dt;
        const phase = Math.floor(autoT / 1.25) % 4;
        if (phase === 0) mx = 1;
        else if (phase === 1) my = 1;
        else if (phase === 2) mx = -1;
        else my = -1;
      } else {
        if (down('ArrowLeft', 'KeyA')) mx -= 1;
        if (down('ArrowRight', 'KeyD')) mx += 1;
        if (down('ArrowUp', 'KeyW')) my -= 1;
        if (down('ArrowDown', 'KeyS')) my += 1;
      }
      const mv = cardinal(mx, my);
      if (mx !== 0 || my !== 0) {
        player.x += mv.x * PLAYER_SPEED * dt;
        player.y += mv.y * PLAYER_SPEED * dt;
      }
      stepAnim(player.sprite, mv.x !== 0 || mv.y !== 0, dt, mv.x, mv.y);
      sync(player);
      if (player.invuln > 0) {
        player.invuln -= dt;
        player.sprite.material.opacity = (Math.floor(time * 20) % 2 === 0) ? 0.4 : 1;
        if (player.invuln <= 0) player.sprite.material.opacity = 1;
      }

      time += dt;
      autoGrowTimer += dt;
      if (autoGrowTimer >= AUTO_GROW_INTERVAL) { autoGrowTimer -= AUTO_GROW_INTERVAL; spawnCap = Math.min(SPAWN_MAX, spawnCap + AUTO_GROW_AMOUNT); }

      let toSpawn = Math.min(spawnCap - enemies.length, SPAWN_PER_FRAME);
      for (let i = 0; i < toSpawn; i++) spawnEnemy();

      fireTimer += dt;
      while (fireTimer >= FIRE_INTERVAL) { fireTimer -= FIRE_INTERVAL; fireProjectile(); }

      // --- 敵更新 (自機へ直進 + 接触) ---
      const px = player.x, py = player.y;
      for (const e of enemies) {
        const dx = px - e.x, dy = py - e.y, d = Math.hypot(dx, dy) || 1;
        const ev = cardinal(dx, dy);
        e.x += ev.x * e.speed * dt; e.y += ev.y * e.speed * dt;
        stepAnim(e.sprite, ev.x !== 0 || ev.y !== 0, dt, ev.x, ev.y);
        sync(e);
        const rr = e.r + PLAYER_RADIUS;
        if (d < rr && player.invuln <= 0) {
          player.hp -= 1; player.invuln = PLAYER_INVULN;
          if (player.hp <= 0) { player.hp = 0; over = true; }
        }
      }

      // --- 弾更新 (移動 + 寿命 + 命中) ---
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; sync(p);
        if (p.life <= 0) { rm(projectiles, i); continue; }
        let hit = false;
        for (let j = enemies.length - 1; j >= 0; j--) {
          const e = enemies[j], dx = e.x - p.x, dy = e.y - p.y, rr = e.r + PROJ_RADIUS;
          if (dx * dx + dy * dy < rr * rr) {
            e.hp -= 1;
            if (e.hp <= 0) { dropGem(e.x, e.y); rm(enemies, j); }
            hit = true; break;
          }
        }
        if (hit) rm(projectiles, i);
      }

      // --- gem 取得 ---
      for (let i = gems.length - 1; i >= 0; i--) {
        const g = gems[i], dx = g.x - px, dy = g.y - py, rr = GEM_RADIUS + PICKUP_RADIUS;
        if (dx * dx + dy * dy < rr * rr) { rm(gems, i); kills += 1; }
      }
    }

    // --- カメラ追従 (自機が中央) + 地面スクロール ---
    camera.position.x = player.x - W / 2;
    camera.position.y = (H - player.y) - H / 2;
    camera.updateMatrixWorld();
    ground.position.set(player.x, H - player.y, -10);
    groundTex.offset.set(player.x / TILE_SIZE, -player.y / TILE_SIZE);

    // --- HUD ---
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const objects = enemies.length + projectiles.length + gems.length;
      hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Enemies : ${enemies.length}  (cap ${spawnCap})\n` +
        `Objects : ${objects}  (ene ${enemies.length} / proj ${projectiles.length} / gem ${gems.length})\n` +
        `Time    : ${time.toFixed(1)}s   Kills: ${kills}\n` +
        `HP      : ${(over && started) ? 'GAME OVER (R to restart)' : '♥'.repeat(player.hp) + ' (' + player.hp + ')'}`;
    }

    renderer.render(scene, camera);

    // アトラクト中はタイトルを点滅
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('three.js トップダウン・サバイバー started. renderer: WebGL');
}
