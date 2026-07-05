/* ============================================================================
 * 弾幕STG (縦スクロールSTG) - A-Frame (1.7.0) 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `stg-game` コンポーネントが駆動する (A-Frame の renderer / tick ループ /
 * カメラ管理を利用)。
 *
 * 設計判断: 弾・敵は数百規模になり得るため「1弾 = 1 <a-entity>」だと DOM /
 * コンポーネント生成コストで FPS が破綻する。そこで動的オブジェクトは
 * コンポーネント内で THREE.Sprite を直接生成・管理する (A-Frame が内包する
 * AFRAME.THREE を使用)。カメラは 2D 用に OrthographicCamera へ差し替える。
 * 当たり判定は SPEC 準拠の自前円判定。座標は画面座標(Y下)保持→worldY=H-y 変換。
 * ========================================================================== */

const THREE = AFRAME.THREE;

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
const RO = { bg: 0, enemy: 1, bullet: 2, fx: 3, player: 4 };

// 2D canvas → CanvasTexture フォールバック
const fbCache = {};
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
  fbCache[name] = t; return t;
}
const fb = {
  player_ship:   () => canvasTexture('player', 64, 64, (g) => { g.fillStyle = '#55e0ff'; g.beginPath(); g.moveTo(32, 2); g.lineTo(60, 60); g.lineTo(4, 60); g.closePath(); g.fill(); }),
  enemy_small:   () => canvasTexture('es', 48, 48, (g) => { g.fillStyle = '#ff5050'; g.beginPath(); g.arc(24, 24, 22, 0, 7); g.fill(); }),
  enemy_big:     () => canvasTexture('eb', 96, 96, (g) => { g.fillStyle = '#ff3070'; g.beginPath(); g.arc(48, 48, 44, 0, 7); g.fill(); g.fillStyle = '#aa0030'; g.beginPath(); g.arc(48, 48, 22, 0, 7); g.fill(); }),
  bullet_player: () => canvasTexture('pb', 16, 24, (g) => { g.fillStyle = '#ffe24d'; g.fillRect(2, 0, 12, 24); }),
  bullet_enemy:  () => canvasTexture('ebt', 16, 16, (g) => { g.fillStyle = '#ff9020'; g.beginPath(); g.arc(8, 8, 7, 0, 7); g.fill(); }),
  explosion:     () => canvasTexture('ex', 64, 64, (g) => { g.fillStyle = '#ffcc33'; g.beginPath(); g.arc(32, 32, 30, 0, 7); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 16, 0, 7); g.fill(); }),
};

AFRAME.registerComponent('stg-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera を用意 (tick で sceneEl.camera を維持)
    this.cam = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1); // DPR=1 固定
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    // 状態
    this.tex = {};
    this.player = null;
    this.playerBullets = []; this.enemies = []; this.enemyBullets = []; this.effects = [];
    this.score = 0; this.maxEnemies = INITIAL_MAX_ENEMIES;
    this.fireTimer = 0; this.spawnAcc = 0;
    this.fpsSamples = []; this.hudTimer = 0;
    this.ready = false;
    this.started = false; this.blinkT = 0; this.autoT = 0;   // タイトル/アトラクト状態
    this.titleEl = document.getElementById('title');

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.key === 'Enter' && !this.started) this.startGame();
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.maxEnemies = Math.min(MAX_ENEMIES_CAP, this.maxEnemies + ENEMY_STEP); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.maxEnemies = Math.max(0, this.maxEnemies - ENEMY_STEP); e.preventDefault(); }
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // アセット読み込み → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  texOf(key) { return this.tex[key] || fb[key](); },

  makeSprite(key, w, h, renderOrder) {
    const mat = new THREE.SpriteMaterial({ map: this.texOf(key), transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    this.group.add(s); return s;
  },
  sync(o) { o.sprite.position.set(o.x, H - o.y, o.sprite.renderOrder * 0.01); },
  rm(arr, i) { const o = arr[i]; this.group.remove(o.sprite); o.sprite.material.dispose(); arr[i] = arr[arr.length - 1]; arr.pop(); },
  down(...c) { return c.some((k) => this.keys[k]); },

  build() {
    // 背景スターフィールド
    this.STAR_N = 140;
    const pos = new Float32Array(this.STAR_N * 3);
    this.starSpd = new Float32Array(this.STAR_N);
    for (let i = 0; i < this.STAR_N; i++) {
      const x = rand(0, W), y = rand(0, H);
      pos[i * 3] = x; pos[i * 3 + 1] = H - y; pos[i * 3 + 2] = -5;
      this.starSpd[i] = rand(40, 120);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fb8ff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.6, depthTest: false }));
    this.stars.renderOrder = RO.bg; this.group.add(this.stars);

    this.bgTiles = [];
    if (this.tex.bg_space) {
      for (let i = 0; i < 2; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: this.tex.bg_space, depthTest: false }));
        m.renderOrder = -1; m.userData.gy = i * -H; this.bgTiles.push(m); this.group.add(m);
      }
    }

    this.player = { sprite: this.makeSprite('player_ship', 48, 48, RO.player), x: W / 2, y: H - 70, hp: INITIAL_HP, alive: true, invul: 0 };
    this.sync(this.player);
    this.ready = true;
  },

  spawnEnemy() {
    const big = Math.random() < 0.18;
    const s = this.makeSprite(big ? 'enemy_big' : 'enemy_small', big ? 80 : 40, big ? 80 : 40, RO.enemy);
    const e = { sprite: s, x: rand(40, W - 40), y: -40, vx: rand(-30, 30), vy: rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX),
      big, r: big ? R_ENEMY_BIG : R_ENEMY_SMALL, hp: big ? 3 : 1, fireTimer: rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX) };
    this.sync(e); this.enemies.push(e);
  },
  firePlayer() {
    const s = this.makeSprite('bullet_player', 12, 22, RO.bullet);
    const b = { sprite: s, x: this.player.x, y: this.player.y - 24 }; this.sync(b); this.playerBullets.push(b);
  },
  fireEnemy(e) {
    const dx = this.player.x - e.x, dy = this.player.y - e.y, len = Math.hypot(dx, dy) || 1;
    const s = this.makeSprite('bullet_enemy', 14, 14, RO.bullet);
    const b = { sprite: s, x: e.x, y: e.y, vx: dx / len * ENEMY_BULLET_SPEED, vy: dy / len * ENEMY_BULLET_SPEED };
    this.sync(b); this.enemyBullets.push(b);
  },
  spawnExplosion(x, y, big) {
    const sz = big ? 80 : 48;
    const s = this.makeSprite('explosion', sz, sz, RO.fx);
    const f = { sprite: s, x, y, life: EXPLOSION_LIFE, max: EXPLOSION_LIFE, base: sz }; this.sync(f); this.effects.push(f);
  },
  hurtPlayer() {
    const p = this.player; p.hp -= 1;
    if (p.hp <= 0) {
      p.hp = 0; p.alive = false; p.sprite.material.opacity = 0.15;
      this.spawnExplosion(p.x, p.y, true);
      setTimeout(() => { p.hp = INITIAL_HP; p.alive = true; p.sprite.material.opacity = 1; p.x = W / 2; p.y = H - 70; p.invul = 1500; }, 1500);
    } else { p.invul = 1500; }
  },

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true;
    this.score = 0; this.maxEnemies = INITIAL_MAX_ENEMIES;
    const p = this.player;
    if (p) { p.hp = INITIAL_HP; p.alive = true; p.invul = 0; p.x = W / 2; p.y = H - 70; p.sprite.material.opacity = 1; }
    for (let i = this.enemies.length - 1; i >= 0; i--) this.rm(this.enemies, i);
    for (let i = this.playerBullets.length - 1; i >= 0; i--) this.rm(this.playerBullets, i);
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) this.rm(this.enemyBullets, i);
    for (let i = this.effects.length - 1; i >= 0; i--) this.rm(this.effects, i);
    if (this.titleEl) this.titleEl.style.display = 'none';
  },

  tick(time, dtMs) {
    if (!this.ready) return;
    // カメラを 2D 用に維持 (A-Frame が別カメラを差し込んでも上書き)
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50); // タブ復帰時の暴発抑制
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    const p = this.player;

    // 背景
    const sp = this.stars.geometry.attributes.position.array;
    for (let i = 0; i < this.STAR_N; i++) {
      let gy = (H - sp[i * 3 + 1]) + this.starSpd[i] * dt;
      if (gy > H) { gy = 0; sp[i * 3] = rand(0, W); }
      sp[i * 3 + 1] = H - gy;
    }
    this.stars.geometry.attributes.position.needsUpdate = true;
    for (const m of this.bgTiles) { m.userData.gy += 60 * dt; if (m.userData.gy >= H) m.userData.gy -= H * 2; m.position.set(W / 2, (H - m.userData.gy) - H / 2, -10); }

    if (p.alive) {
      let mx = 0, my = 0;
      if (!this.started) {
        // デモAI: 累積時間の sin で緩やかに左右＋上下移動 (決定的)
        this.autoT += dt;
        mx = Math.cos(this.autoT * 0.8);
        my = 0;
      } else {
        if (this.down('ArrowLeft', 'KeyA')) mx -= 1;
        if (this.down('ArrowRight', 'KeyD')) mx += 1;
        if (this.down('ArrowUp', 'KeyW')) my -= 1;
        if (this.down('ArrowDown', 'KeyS')) my += 1;
      }
      if (mx && my) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
      p.x = clamp(p.x + mx * PLAYER_SPEED * dt, 24, W - 24);
      p.y = clamp(p.y + my * PLAYER_SPEED * dt, 24, H - 24);
      this.sync(p);
      if (p.invul > 0) {
        p.invul -= dtMs;
        p.sprite.material.opacity = (Math.floor(p.invul / 60) % 2 === 0) ? 0.35 : 1;
        if (p.invul <= 0) p.sprite.material.opacity = 1;
      }
      this.fireTimer -= dtMs;
      if (this.fireTimer <= 0) { this.firePlayer(); this.fireTimer += FIRE_INTERVAL; if (this.fireTimer < 0) this.fireTimer = 0; }
    }

    this.spawnAcc += dtMs;
    while (this.spawnAcc >= 80) { this.spawnAcc -= 80; if (this.enemies.length < this.maxEnemies) this.spawnEnemy(); }

    for (let i = this.playerBullets.length - 1; i >= 0; i--) {
      const b = this.playerBullets[i]; b.y -= PLAYER_BULLET_SPEED * dt; this.sync(b);
      if (b.y < -30) this.rm(this.playerBullets, i);
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]; e.x += e.vx * dt; e.y += e.vy * dt;
      if (e.x < 24 && e.vx < 0) e.vx = -e.vx;
      if (e.x > W - 24 && e.vx > 0) e.vx = -e.vx;
      this.sync(e);
      if (e.y > H + 50) { this.rm(this.enemies, i); continue; }
      e.fireTimer -= dtMs;
      if (e.fireTimer <= 0 && p.alive && e.y > 0) { this.fireEnemy(e); e.fireTimer = rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX); }
    }
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      const b = this.enemyBullets[i]; b.x += b.vx * dt; b.y += b.vy * dt; this.sync(b);
      if (b.x < -30 || b.x > W + 30 || b.y < -30 || b.y > H + 30) this.rm(this.enemyBullets, i);
    }

    for (let i = this.playerBullets.length - 1; i >= 0; i--) {
      const b = this.playerBullets[i]; let hit = false;
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j], dx = b.x - e.x, dy = b.y - e.y, rr = R_PLAYER_BULLET + e.r;
        if (dx * dx + dy * dy <= rr * rr) {
          e.hp -= 1; hit = true;
          if (e.hp <= 0) { this.spawnExplosion(e.x, e.y, e.big); this.rm(this.enemies, j); this.score += SCORE_PER_KILL; }
          break;
        }
      }
      if (hit) this.rm(this.playerBullets, i);
    }
    if (p.alive && p.invul <= 0) {
      for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
        const b = this.enemyBullets[i], dx = b.x - p.x, dy = b.y - p.y, rr = R_ENEMY_BULLET + R_PLAYER;
        if (dx * dx + dy * dy <= rr * rr) { this.rm(this.enemyBullets, i); this.hurtPlayer(); break; }
      }
    }
    if (p.alive && p.invul <= 0) {
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j], dx = e.x - p.x, dy = e.y - p.y, rr = e.r + R_PLAYER;
        if (dx * dx + dy * dy <= rr * rr) { this.spawnExplosion(e.x, e.y, e.big); this.rm(this.enemies, j); this.hurtPlayer(); break; }
      }
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const f = this.effects[i]; f.life -= dtMs; const t = f.life / f.max;
      f.sprite.material.opacity = clamp(t, 0, 1);
      const sc = (1 - t) * 0.5 + 1; f.sprite.scale.set(f.base * sc, f.base * sc, 1);
      if (f.life <= 0) this.rm(this.effects, i);
    }

    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const objects = this.playerBullets.length + this.enemyBullets.length + this.enemies.length + this.effects.length;
      this.hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Objects : ${objects}  (bul ${this.playerBullets.length + this.enemyBullets.length} / ene ${this.enemies.length} / fx ${this.effects.length})\n` +
        `Score   : ${this.score}\n` +
        `HP      : ${p.alive ? '♥'.repeat(p.hp) + ' (' + p.hp + ')' : 'GAME OVER'}\n` +
        `MaxEnemy: ${this.maxEnemies}  (+/- to change, cap ${MAX_ENEMIES_CAP})`;
    }

    if (!this.started && this.titleEl) { this.blinkT += dt; this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  },
});

console.log('A-Frame 弾幕STG component registered.');
