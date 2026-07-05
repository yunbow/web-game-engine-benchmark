/* ============================================================================
 * 弾幕STG (縦スクロールSTG) - three.js (r184) 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * three.js は 3D 描画ライブラリ。2D ゲームとして使うため:
 *   - OrthographicCamera(0, W, H, 0) で 1ワールド単位 = 1px、原点左下・Y上向き。
 *   - ゲームロジックは画面座標 (Y 下向き, 他エンジンと同一定数) のまま保持し、
 *     描画同期時のみ worldY = H - gameY に変換する (テクスチャの上下が崩れない)。
 *   - スプライトは THREE.Sprite (常にカメラを向く板) を使い、重ね順は renderOrder。
 *   - ゲームループ/入力/円判定/プールは自前。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;
const PLAYER_SPEED = 300;
const PLAYER_BULLET_SPEED = 600;
const FIRE_INTERVAL = 150;          // ms
const ENEMY_SPEED_MIN = 80, ENEMY_SPEED_MAX = 140;
const ENEMY_BULLET_SPEED = 200;
const ENEMY_FIRE_MIN = 900, ENEMY_FIRE_MAX = 2200; // ms
const INITIAL_MAX_ENEMIES = 40, MAX_ENEMIES_CAP = 300, ENEMY_STEP = 10;
const INITIAL_HP = 3, SCORE_PER_KILL = 10;
const EXPLOSION_LIFE = 250;         // ms

const R_PLAYER = 16, R_PLAYER_BULLET = 6;
const R_ENEMY_SMALL = 18, R_ENEMY_BIG = 40, R_ENEMY_BULLET = 7;

const ASSET_DEFS = {
  player_ship:  '../assets/player_ship.png',
  enemy_small:  '../assets/enemy_small.png',
  enemy_big:    '../assets/enemy_big.png',
  bullet_player:'../assets/bullet_player.png',
  bullet_enemy: '../assets/bullet_enemy.png',
  explosion:    '../assets/explosion.png',
  bg_space:     '../assets/bg_space.png',
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RO = { bg: 0, enemy: 1, bullet: 2, fx: 3, player: 4 }; // renderOrder

// === シーン/カメラ/レンダラ =================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060f);
// left=0, right=W, top=H, bottom=0 → x:0..W / y:0..H (Y上向き)
const camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);          // 性能比較のため DPR=1 固定
renderer.setSize(W, H);
document.getElementById('game-container').appendChild(renderer.domElement);

// === テクスチャ (画像 or canvas フォールバック) =============================
const loader = new THREE.TextureLoader();
const tex = {};
const fbCache = {};

// 2D canvas に描いて CanvasTexture 化するヘルパ。
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
function fbPlayer()      { return canvasTexture('player', 64, 64, (g) => { g.fillStyle = '#55e0ff'; g.beginPath(); g.moveTo(32, 2); g.lineTo(60, 60); g.lineTo(4, 60); g.closePath(); g.fill(); }); }
function fbEnemySmall()  { return canvasTexture('es', 48, 48, (g) => { g.fillStyle = '#ff5050'; g.beginPath(); g.arc(24, 24, 22, 0, 7); g.fill(); }); }
function fbEnemyBig()    { return canvasTexture('eb', 96, 96, (g) => { g.fillStyle = '#ff3070'; g.beginPath(); g.arc(48, 48, 44, 0, 7); g.fill(); g.fillStyle = '#aa0030'; g.beginPath(); g.arc(48, 48, 22, 0, 7); g.fill(); }); }
function fbPBullet()     { return canvasTexture('pb', 16, 24, (g) => { g.fillStyle = '#ffe24d'; g.fillRect(2, 0, 12, 24); }); }
function fbEBullet()     { return canvasTexture('ebt', 16, 16, (g) => { g.fillStyle = '#ff9020'; g.beginPath(); g.arc(8, 8, 7, 0, 7); g.fill(); }); }
function fbExplosion()   { return canvasTexture('ex', 64, 64, (g) => { g.fillStyle = '#ffcc33'; g.beginPath(); g.arc(32, 32, 30, 0, 7); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 16, 0, 7); g.fill(); }); }

function makeSprite(texture, w, h, renderOrder) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  return s;
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
  // --- 背景: スターフィールド (Points) + 任意で bg タイル ---
  const STAR_N = 140;
  const starPos = new Float32Array(STAR_N * 3);
  const starSpd = new Float32Array(STAR_N);
  for (let i = 0; i < STAR_N; i++) {
    const x = rand(0, W), y = rand(0, H);
    starPos[i * 3] = x; starPos[i * 3 + 1] = H - y; starPos[i * 3 + 2] = -5;
    starSpd[i] = rand(40, 120);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x9fb8ff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.6, depthTest: false }));
  stars.renderOrder = RO.bg;
  scene.add(stars);

  const bgTiles = [];
  if (tex.bg_space) {
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
        new THREE.MeshBasicMaterial({ map: tex.bg_space, depthTest: false }));
      m.renderOrder = -1;
      m.userData.gy = i * -H;          // 画面座標での上端y
      bgTiles.push(m); scene.add(m);
    }
  }

  // --- 自機 ---
  const player = {
    sprite: makeSprite(tex.player_ship || fbPlayer(), 48, 48, RO.player),
    x: W / 2, y: H - 70, hp: INITIAL_HP, alive: true, invul: 0,
  };
  scene.add(player.sprite);

  const playerBullets = [], enemies = [], enemyBullets = [], effects = [];
  let score = 0, maxEnemies = INITIAL_MAX_ENEMIES, fireTimer = 0, spawnAcc = 0;
  let started = false, blinkT = 0, autoT = 0;   // タイトル/アトラクト状態 (false=デモ中・操作無効)
  const titleEl = document.getElementById('title');

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    score = 0; maxEnemies = INITIAL_MAX_ENEMIES;
    player.hp = INITIAL_HP; player.alive = true; player.invul = 0;
    player.x = W / 2; player.y = H - 70; player.sprite.material.opacity = 1;
    for (let i = enemies.length - 1; i >= 0; i--) rm(enemies, i);
    for (let i = playerBullets.length - 1; i >= 0; i--) rm(playerBullets, i);
    for (let i = enemyBullets.length - 1; i >= 0; i--) rm(enemyBullets, i);
    for (let i = effects.length - 1; i >= 0; i--) rm(effects, i);
    if (titleEl) titleEl.style.display = 'none';
  }

  // --- 入力 ---
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === 'Enter' && !started) startGame();
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { maxEnemies = Math.min(MAX_ENEMIES_CAP, maxEnemies + ENEMY_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { maxEnemies = Math.max(0, maxEnemies - ENEMY_STEP); e.preventDefault(); }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);
  const sync = (o) => { o.sprite.position.set(o.x, H - o.y, o.sprite.renderOrder * 0.01); };

  function spawnEnemy() {
    const big = Math.random() < 0.18;
    const s = big ? makeSprite(tex.enemy_big || fbEnemyBig(), 80, 80, RO.enemy)
                  : makeSprite(tex.enemy_small || fbEnemySmall(), 40, 40, RO.enemy);
    scene.add(s);
    const e = { sprite: s, x: rand(40, W - 40), y: -40, vx: rand(-30, 30),
      vy: rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX), big, r: big ? R_ENEMY_BIG : R_ENEMY_SMALL,
      hp: big ? 3 : 1, fireTimer: rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX) };
    sync(e); enemies.push(e);
  }
  function firePlayer() {
    const s = makeSprite(tex.bullet_player || fbPBullet(), 12, 22, RO.bullet); scene.add(s);
    const b = { sprite: s, x: player.x, y: player.y - 24 }; sync(b); playerBullets.push(b);
  }
  function fireEnemy(e) {
    const dx = player.x - e.x, dy = player.y - e.y, len = Math.hypot(dx, dy) || 1;
    const s = makeSprite(tex.bullet_enemy || fbEBullet(), 14, 14, RO.bullet); scene.add(s);
    const b = { sprite: s, x: e.x, y: e.y, vx: dx / len * ENEMY_BULLET_SPEED, vy: dy / len * ENEMY_BULLET_SPEED };
    sync(b); enemyBullets.push(b);
  }
  function spawnExplosion(x, y, big) {
    const sz = big ? 80 : 48;
    const s = makeSprite(tex.explosion || fbExplosion(), sz, sz, RO.fx); scene.add(s);
    const f = { sprite: s, x, y, life: EXPLOSION_LIFE, max: EXPLOSION_LIFE, base: sz }; sync(f); effects.push(f);
  }
  function rm(arr, i) {
    const o = arr[i]; scene.remove(o.sprite); o.sprite.material.dispose();
    arr[i] = arr[arr.length - 1]; arr.pop();
  }
  function hurtPlayer() {
    player.hp -= 1;
    if (player.hp <= 0) {
      player.hp = 0; player.alive = false; player.sprite.material.opacity = 0.15;
      spawnExplosion(player.x, player.y, true);
      setTimeout(() => { player.hp = INITIAL_HP; player.alive = true; player.sprite.material.opacity = 1;
        player.x = W / 2; player.y = H - 70; player.invul = 1500; }, 1500);
    } else { player.invul = 1500; }
  }

  // --- ループ ---
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05); // 秒。タブ復帰時の暴発を抑制
    const dtMs = dt * 1000;
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // 背景
    const sp = stars.geometry.attributes.position.array;
    for (let i = 0; i < STAR_N; i++) {
      let gy = (H - sp[i * 3 + 1]) + starSpd[i] * dt; // 画面座標で下方向へ
      if (gy > H) { gy = 0; sp[i * 3] = rand(0, W); }
      sp[i * 3 + 1] = H - gy;
    }
    stars.geometry.attributes.position.needsUpdate = true;
    for (const m of bgTiles) { m.userData.gy += 60 * dt; if (m.userData.gy >= H) m.userData.gy -= H * 2; m.position.set(W / 2, (H - m.userData.gy) - H / 2, -10); }

    if (player.alive) {
      let mx = 0, my = 0;
      if (!started) {
        // デモAI: 累積時間の sin で緩やかに左右＋上下移動 (決定的)
        autoT += dt;
        mx = Math.cos(autoT * 0.8);
        my = 0;
      } else {
        if (down('ArrowLeft', 'KeyA')) mx -= 1;
        if (down('ArrowRight', 'KeyD')) mx += 1;
        if (down('ArrowUp', 'KeyW')) my -= 1;
        if (down('ArrowDown', 'KeyS')) my += 1;
      }
      if (mx && my) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
      player.x = clamp(player.x + mx * PLAYER_SPEED * dt, 24, W - 24);
      player.y = clamp(player.y + my * PLAYER_SPEED * dt, 24, H - 24);
      sync(player);
      if (player.invul > 0) {
        player.invul -= dtMs;
        player.sprite.material.opacity = (Math.floor(player.invul / 60) % 2 === 0) ? 0.35 : 1;
        if (player.invul <= 0) player.sprite.material.opacity = 1;
      }
      fireTimer -= dtMs;
      if (fireTimer <= 0) { firePlayer(); fireTimer += FIRE_INTERVAL; if (fireTimer < 0) fireTimer = 0; }
    }

    spawnAcc += dtMs;
    while (spawnAcc >= 80) { spawnAcc -= 80; if (enemies.length < maxEnemies) spawnEnemy(); }

    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i]; b.y -= PLAYER_BULLET_SPEED * dt; sync(b);
      if (b.y < -30) rm(playerBullets, i);
    }
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i]; e.x += e.vx * dt; e.y += e.vy * dt;
      if (e.x < 24 && e.vx < 0) e.vx = -e.vx;
      if (e.x > W - 24 && e.vx > 0) e.vx = -e.vx;
      sync(e);
      if (e.y > H + 50) { rm(enemies, i); continue; }
      e.fireTimer -= dtMs;
      if (e.fireTimer <= 0 && player.alive && e.y > 0) { fireEnemy(e); e.fireTimer = rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX); }
    }
    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i]; b.x += b.vx * dt; b.y += b.vy * dt; sync(b);
      if (b.x < -30 || b.x > W + 30 || b.y < -30 || b.y > H + 30) rm(enemyBullets, i);
    }

    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i]; let hit = false;
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j], dx = b.x - e.x, dy = b.y - e.y, rr = R_PLAYER_BULLET + e.r;
        if (dx * dx + dy * dy <= rr * rr) {
          e.hp -= 1; hit = true;
          if (e.hp <= 0) { spawnExplosion(e.x, e.y, e.big); rm(enemies, j); score += SCORE_PER_KILL; }
          break;
        }
      }
      if (hit) rm(playerBullets, i);
    }
    if (player.alive && player.invul <= 0) {
      for (let i = enemyBullets.length - 1; i >= 0; i--) {
        const b = enemyBullets[i], dx = b.x - player.x, dy = b.y - player.y, rr = R_ENEMY_BULLET + R_PLAYER;
        if (dx * dx + dy * dy <= rr * rr) { rm(enemyBullets, i); hurtPlayer(); break; }
      }
    }
    if (player.alive && player.invul <= 0) {
      for (let j = enemies.length - 1; j >= 0; j--) {
        const e = enemies[j], dx = e.x - player.x, dy = e.y - player.y, rr = e.r + R_PLAYER;
        if (dx * dx + dy * dy <= rr * rr) { spawnExplosion(e.x, e.y, e.big); rm(enemies, j); hurtPlayer(); break; }
      }
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i]; f.life -= dtMs; const t = f.life / f.max;
      f.sprite.material.opacity = clamp(t, 0, 1);
      const sc = (1 - t) * 0.5 + 1; f.sprite.scale.set(f.base * sc, f.base * sc, 1);
      if (f.life <= 0) rm(effects, i);
    }

    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const objects = playerBullets.length + enemyBullets.length + enemies.length + effects.length;
      hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Objects : ${objects}  (bul ${playerBullets.length + enemyBullets.length} / ene ${enemies.length} / fx ${effects.length})\n` +
        `Score   : ${score}\n` +
        `HP      : ${player.alive ? '♥'.repeat(player.hp) + ' (' + player.hp + ')' : 'GAME OVER'}\n` +
        `MaxEnemy: ${maxEnemies}  (+/- to change, cap ${MAX_ENEMIES_CAP})`;
    }

    renderer.render(scene, camera);

    if (!started && titleEl) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('three.js 弾幕STG started. renderer: WebGL');
}
