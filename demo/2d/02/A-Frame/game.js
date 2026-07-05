/* ============================================================================
 * トップダウン・サバイバー - A-Frame (1.7.0)
 * 共通仕様 ../SPEC.md に厳密準拠。性能比較用。
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `survivor-game` コンポーネントが駆動する (A-Frame の renderer / tick ループ /
 * カメラ管理を利用)。
 *
 * 設計判断: 敵・弾・gem は数百規模になり得るため「1体 = 1 <a-entity>」だと DOM /
 * コンポーネント生成コストで FPS が破綻する。そこで動的オブジェクトは
 * コンポーネント内で THREE.Sprite を直接生成・管理する (AFRAME.THREE を使用)。
 * カメラは 2D 用に OrthographicCamera へ差し替え、自機追従で平行移動する。
 * 当たり判定は SPEC 準拠の自前円判定。座標は画面座標(Y下)保持→worldY=H-y 変換。
 * ========================================================================== */

const THREE = AFRAME.THREE;

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
  // 静止画は廃止。walk のみ使用し、欠落時は texOf() が図形フォールバックに落ちる。
  playerWalk: '../assets/player_walk.png',
  batWalk: '../assets/enemy_bat_walk.png',
  zombieWalk: '../assets/enemy_zombie_walk.png',
  proj:   '../assets/projectile.png',
  gem:    '../assets/xp_gem.png',
  ground: '../assets/ground_tile.png',
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RO = { ground: 0, gem: 1, enemy: 2, proj: 3, player: 4 };

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
  player: () => canvasTexture('player', 48, 48, (g) => { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(24, 24, 22, 0, 7); g.fill(); }),
  bat:    () => canvasTexture('bat', 32, 32, (g) => { g.fillStyle = '#9b59ff'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); }),
  zombie: () => canvasTexture('zombie', 40, 40, (g) => { g.fillStyle = '#47d16a'; g.beginPath(); g.arc(20, 20, 19, 0, 7); g.fill(); }),
  proj:   () => canvasTexture('proj', 24, 24, (g) => { g.fillStyle = '#ffe34d'; g.beginPath(); g.arc(12, 12, 11, 0, 7); g.fill(); }),
  gem:    () => canvasTexture('gem', 16, 16, (g) => { g.fillStyle = '#4dd6ff'; g.beginPath(); g.moveTo(8, 0); g.lineTo(16, 8); g.lineTo(8, 16); g.lineTo(0, 8); g.closePath(); g.fill(); }),
  ground: () => canvasTexture('ground', 64, 64, (g) => { g.fillStyle = '#1b1b26'; g.fillRect(0, 0, 64, 64); g.strokeStyle = '#262633'; g.lineWidth = 2; g.strokeRect(1, 1, 62, 62); }),
};

AFRAME.registerComponent('survivor-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');
    this.titleEl = document.getElementById('title');

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
    this.enemies = []; this.projectiles = []; this.gems = [];
    this.kills = 0; this.spawnCap = SPAWN_INIT;
    this.fireTimer = 0; this.autoGrowTimer = 0; this.time = 0;
    this.over = false;
    this.started = false; this.blinkT = 0; this.autoT = 0;   // タイトル/アトラクト状態
    this.fpsSamples = []; this.hudTimer = 0;
    this.ready = false;

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.spawnCap = Math.min(SPAWN_MAX, this.spawnCap + SPAWN_STEP); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.spawnCap = Math.max(SPAWN_MIN, this.spawnCap - SPAWN_STEP); e.preventDefault(); }
      else if (e.code === 'Enter' && !this.started) { this.startGame(); e.preventDefault(); }
      else if (e.code === 'KeyR' && this.over) { this.resetGame(); }
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
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
  makeWalkSprite(walkKey, stillKey, w, h, renderOrder) {
    const base = this.tex[walkKey] || this.texOf(stillKey);
    const map = base.clone();
    map.needsUpdate = true;
    const frames = this.tex[walkKey] ? 4 : 1;
    const rows = this.tex[walkKey] ? 4 : 1;
    if (frames > 1) {
      map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      map.repeat.set(1 / frames, 1 / rows);
    }
    const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    s.userData.anim = { frames, rows, t: 0, dir: 0 };
    this.group.add(s); return s;
  },
  dirFrame(x, y) {
    if (y < 0) return 1;
    if (x < 0) return 2;
    if (x > 0) return 3;
    return 0;
  },
  stepAnim(sprite, moving, dt, x = 0, y = 0) {
    const anim = sprite.userData.anim;
    if (!anim || anim.frames <= 1) return;
    anim.t = moving ? anim.t + dt : 0;
    if (moving) anim.dir = this.dirFrame(x, y);
    sprite.material.map.offset.x = (moving ? Math.floor(anim.t * 10) % anim.frames : 0) / anim.frames;
    sprite.material.map.offset.y = (anim.rows - anim.dir - 1) / anim.rows;
  },
  cardinal(mx, my) {
    if (mx === 0 && my === 0) return { x: 0, y: 0 };
    if (Math.abs(mx) >= Math.abs(my)) return { x: Math.sign(mx), y: 0 };
    return { x: 0, y: Math.sign(my) };
  },
  sync(o) { o.sprite.position.set(o.x, H - o.y, o.sprite.renderOrder * 0.01); },
  rm(arr, i) { const o = arr[i]; this.group.remove(o.sprite); o.sprite.material.dispose(); arr[i] = arr[arr.length - 1]; arr.pop(); },
  down(...c) { return c.some((k) => this.keys[k]); },

  build() {
    // 地面: 繰り返しテクスチャの大きな Plane を自機追従、offset でスクロール
    const groundTex = this.tex.ground || fb.ground();
    groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
    const GW = W + TILE_SIZE * 2, GH = H + TILE_SIZE * 2;
    groundTex.repeat.set(GW / TILE_SIZE, GH / TILE_SIZE);
    this.groundTex = groundTex;
    const groundMat = new THREE.MeshBasicMaterial({ map: groundTex, depthTest: false });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), groundMat);
    this.ground.renderOrder = RO.ground;
    this.group.add(this.ground);

    this.player = { sprite: this.makeWalkSprite('playerWalk', 'player', 48, 48, RO.player), x: 0, y: 0, hp: PLAYER_HP_INIT, invuln: 0 };
    this.sync(this.player);
    this.ready = true;
  },

  resetGame() {
    for (let i = this.enemies.length - 1; i >= 0; i--) this.rm(this.enemies, i);
    for (let i = this.projectiles.length - 1; i >= 0; i--) this.rm(this.projectiles, i);
    for (let i = this.gems.length - 1; i >= 0; i--) this.rm(this.gems, i);
    const p = this.player;
    p.x = 0; p.y = 0; p.hp = PLAYER_HP_INIT; p.invuln = 0; p.sprite.material.opacity = 1;
    this.kills = 0; this.spawnCap = SPAWN_INIT;
    this.fireTimer = 0; this.autoGrowTimer = 0; this.time = 0; this.over = false;
  },

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame() {
    this.started = true; this.resetGame();
    if (this.titleEl) this.titleEl.style.display = 'none';
  },

  spawnEnemy() {
    const isZombie = Math.random() < 0.3;
    const s = isZombie
      ? this.makeWalkSprite('zombieWalk', 'zombie', 40, 40, RO.enemy)
      : this.makeWalkSprite('batWalk', 'bat', 32, 32, RO.enemy);
    const side = Math.floor(Math.random() * 4);
    const px = this.player.x, py = this.player.y;
    const halfW = W / 2 + SPAWN_MARGIN, halfH = H / 2 + SPAWN_MARGIN;
    let x, y;
    if (side === 0) { x = px - halfW; y = py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 1) { x = px + halfW; y = py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 2) { y = py - halfH; x = px + (Math.random() * 2 - 1) * halfW; }
    else { y = py + halfH; x = px + (Math.random() * 2 - 1) * halfW; }
    const e = { sprite: s, x, y, r: isZombie ? ZOMBIE_RADIUS : BAT_RADIUS,
      hp: isZombie ? ZOMBIE_HP : BAT_HP, speed: rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX) };
    this.sync(e); this.enemies.push(e);
  },
  dropGem(x, y) {
    const s = this.makeSprite('gem', 16, 16, RO.gem);
    const g = { sprite: s, x, y }; this.sync(g); this.gems.push(g);
  },
  fireProjectile() {
    let best = null, bestD2 = Infinity;
    const px = this.player.x, py = this.player.y;
    for (const e of this.enemies) {
      const dx = e.x - px, dy = e.y - py, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    if (!best) return;
    const dx = best.x - px, dy = best.y - py, d = Math.hypot(dx, dy) || 1;
    const s = this.makeSprite('proj', 24, 24, RO.proj);
    const p = { sprite: s, x: px, y: py, vx: (dx / d) * PROJ_SPEED, vy: (dy / d) * PROJ_SPEED, life: PROJ_LIFETIME };
    this.sync(p); this.projectiles.push(p);
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

    if (this.over && !this.started) this.resetGame();   // アトラクト中の被弾死はデモをループ再開

    if (!this.over) {
      // --- 自機移動 (8方向, 正規化) ---
      let mx = 0, my = 0;
      if (!this.started) {
        // デモAI: 累積時間ベースの sin で緩やかに徘徊（決定的）
        this.autoT += dt;
        const phase = Math.floor(this.autoT / 1.25) % 4;
        if (phase === 0) mx = 1;
        else if (phase === 1) my = 1;
        else if (phase === 2) mx = -1;
        else my = -1;
      } else {
        if (this.down('ArrowLeft', 'KeyA')) mx -= 1;
        if (this.down('ArrowRight', 'KeyD')) mx += 1;
        if (this.down('ArrowUp', 'KeyW')) my -= 1;
        if (this.down('ArrowDown', 'KeyS')) my += 1;
      }
      const mv = this.cardinal(mx, my);
      if (mx !== 0 || my !== 0) {
        p.x += mv.x * PLAYER_SPEED * dt;
        p.y += mv.y * PLAYER_SPEED * dt;
      }
      this.stepAnim(p.sprite, mv.x !== 0 || mv.y !== 0, dt, mv.x, mv.y);
      this.sync(p);
      if (p.invuln > 0) {
        p.invuln -= dt;
        p.sprite.material.opacity = (Math.floor(this.time * 20) % 2 === 0) ? 0.4 : 1;
        if (p.invuln <= 0) p.sprite.material.opacity = 1;
      }

      this.time += dt;
      this.autoGrowTimer += dt;
      if (this.autoGrowTimer >= AUTO_GROW_INTERVAL) { this.autoGrowTimer -= AUTO_GROW_INTERVAL; this.spawnCap = Math.min(SPAWN_MAX, this.spawnCap + AUTO_GROW_AMOUNT); }

      let toSpawn = Math.min(this.spawnCap - this.enemies.length, SPAWN_PER_FRAME);
      for (let i = 0; i < toSpawn; i++) this.spawnEnemy();

      this.fireTimer += dt;
      while (this.fireTimer >= FIRE_INTERVAL) { this.fireTimer -= FIRE_INTERVAL; this.fireProjectile(); }

      // --- 敵更新 (自機へ直進 + 接触) ---
      const px = p.x, py = p.y;
      for (const e of this.enemies) {
        const dx = px - e.x, dy = py - e.y, d = Math.hypot(dx, dy) || 1;
        const ev = this.cardinal(dx, dy);
        e.x += ev.x * e.speed * dt; e.y += ev.y * e.speed * dt;
        this.stepAnim(e.sprite, ev.x !== 0 || ev.y !== 0, dt, ev.x, ev.y);
        this.sync(e);
        const rr = e.r + PLAYER_RADIUS;
        if (d < rr && p.invuln <= 0) {
          p.hp -= 1; p.invuln = PLAYER_INVULN;
          if (p.hp <= 0) { p.hp = 0; this.over = true; }
        }
      }

      // --- 弾更新 (移動 + 寿命 + 命中) ---
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const pr = this.projectiles[i];
        pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt; this.sync(pr);
        if (pr.life <= 0) { this.rm(this.projectiles, i); continue; }
        let hit = false;
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j], dx = e.x - pr.x, dy = e.y - pr.y, rr = e.r + PROJ_RADIUS;
          if (dx * dx + dy * dy < rr * rr) {
            e.hp -= 1;
            if (e.hp <= 0) { this.dropGem(e.x, e.y); this.rm(this.enemies, j); }
            hit = true; break;
          }
        }
        if (hit) this.rm(this.projectiles, i);
      }

      // --- gem 取得 ---
      for (let i = this.gems.length - 1; i >= 0; i--) {
        const g = this.gems[i], dx = g.x - px, dy = g.y - py, rr = GEM_RADIUS + PICKUP_RADIUS;
        if (dx * dx + dy * dy < rr * rr) { this.rm(this.gems, i); this.kills += 1; }
      }
    }

    // --- カメラ追従 (自機が中央) + 地面スクロール ---
    this.cam.position.x = p.x - W / 2;
    this.cam.position.y = (H - p.y) - H / 2;
    this.cam.updateMatrixWorld();
    this.ground.position.set(p.x, H - p.y, -10);
    this.groundTex.offset.set(p.x / TILE_SIZE, -p.y / TILE_SIZE);

    // --- HUD ---
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const objects = this.enemies.length + this.projectiles.length + this.gems.length;
      this.hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Enemies : ${this.enemies.length}  (cap ${this.spawnCap})\n` +
        `Objects : ${objects}  (ene ${this.enemies.length} / proj ${this.projectiles.length} / gem ${this.gems.length})\n` +
        `Time    : ${this.time.toFixed(1)}s   Kills: ${this.kills}\n` +
        `HP      : ${(this.over && this.started) ? 'GAME OVER (R to restart)' : '♥'.repeat(p.hp) + ' (' + p.hp + ')'}`;
    }

    // アトラクト中はタイトルを点滅
    if (!this.started && this.titleEl) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  },
});

console.log('A-Frame トップダウン・サバイバー component registered.');
