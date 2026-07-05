/* =========================================================================
 * テーマ7 物理パズル (投擲物理) ― A-Frame (1.7.0) + Matter.js 実装
 * 仕様: SPEC.md (960x540, 34x34 箱スタック, スリングショット発射, 剛体数スケール)
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワークで、2D 剛体物理は
 * 内蔵しない (aframe-physics-system は 3D)。テーマ4/5 の "対" として本物の剛体ソルバ
 * (接触・スタック・反発・摩擦・スリープ) を比較するのが主題なので、物理は
 * **matter-js (CDN, PixiJS/Babylon/LittleJS と同一 0.19.0)** に完全委譲する。
 *
 * 設計判断: 箱は数百規模になり得るため「1箱 = 1 <a-entity>」では DOM / コンポーネント
 * 生成コストで FPS が破綻する。そこで剛体の表示物はコンポーネント内で THREE.Sprite を
 * 直接生成・管理する (A-Frame 内包の AFRAME.THREE を使用)。カメラは 2D 用 Ortho に差替え、
 * tick で sceneEl.camera を維持する。
 *
 * ★ Y軸の扱い (最重要):
 *   - Matter の座標は Y 下向き (重力 +y で箱は y 増加方向＝画面下へ落ちる)。
 *   - A-Frame/three.js の Ortho カメラ(0,W,H,0)は Y 上向き。
 *   → 描画同期で worldY = H - bodyY、回転は material.rotation = -body.angle と符号反転。
 *   これで「箱が画面下へ落ちる」「回転が見た目どおり」になる。
 *
 * 毎フレーム (tick): Matter.Engine.update → 各ボディ position/angle を Sprite へ反映。
 * 自前 AABB は一切書かない。
 * =========================================================================*/

const THREE = AFRAME.THREE;
const { Engine, Bodies, Body, Composite } = Matter;

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

const GROUND_H = 48;
const GROUND_TOP_Y = H - GROUND_H;    // 地面上面の Matter y (= 492)
const WALL_T = 40;

const BOX = 34;
const BALL_R = 12;

const GRAVITY_Y = 1.0;
const GRAVITY_SCALE = 0.001;
const BOX_DENSITY = 0.0018;
const BALL_DENSITY = 0.004;
const BOX_FRICTION = 0.6;
const BOX_RESTITUTION = 0.05;
const BALL_RESTITUTION = 0.25;

const SLING_X = 90;
const SLING_Y = GROUND_TOP_Y - 70;
const DRAG_TO_VEL = 0.22;
const MAX_LAUNCH_SPEED = 26;
const CLICK_SPEED = 18;
const MAX_SHOTS = 8;
const AUTO_INTERVAL = 0.8;            // s

const DISPLACE_DIST = 64;
const SCORE_NORMAL = 10;
const SCORE_TARGET = 50;

const BOX_INIT = 60;
const BOX_STEP = 20;
const BOX_MIN = 20;
const BOX_MAX = 600;

const KILL_MARGIN = 200;

const RO = { bg: -10, ground: -5, box: 1, ball: 2 };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const worldY = (matterY) => H - matterY;   // Matter y(下) → three y(上)

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSET_DEFS = {
  box:        '../assets/box.png',
  box_target: '../assets/box_target.png',
  ball:       '../assets/ball.png',
  ground:     '../assets/ground.png',
  slingshot:  '../assets/slingshot.png',
  bg_sky:     '../assets/bg_sky.png',
};

// ---- canvas → CanvasTexture フォールバック ---------------------------------
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
  box: () => canvasTexture('box', BOX, BOX, (g) => {
    g.fillStyle = '#b5793a'; g.fillRect(0, 0, BOX, BOX);
    g.strokeStyle = '#7a4e21'; g.lineWidth = 2; g.strokeRect(1, 1, BOX - 2, BOX - 2);
    g.beginPath(); g.moveTo(0, BOX / 2); g.lineTo(BOX, BOX / 2);
    g.moveTo(BOX / 2, 0); g.lineTo(BOX / 2, BOX); g.stroke();
  }),
  box_target: () => canvasTexture('boxt', BOX, BOX, (g) => {
    g.fillStyle = '#ff8c1a'; g.fillRect(0, 0, BOX, BOX);
    g.strokeStyle = '#c25e00'; g.lineWidth = 2; g.strokeRect(1, 1, BOX - 2, BOX - 2);
    g.fillStyle = '#fff2a8'; g.beginPath(); g.arc(BOX / 2, BOX / 2, 7, 0, 7); g.fill();
  }),
  ball: () => canvasTexture('ball', BALL_R * 2, BALL_R * 2, (g) => {
    g.fillStyle = '#e23b2e'; g.beginPath(); g.arc(BALL_R, BALL_R, BALL_R - 1, 0, 7); g.fill();
    g.strokeStyle = '#8a1810'; g.lineWidth = 2; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.arc(BALL_R - 3, BALL_R - 3, 3, 0, 7); g.fill();
  }),
  ground: () => canvasTexture('ground', 64, 64, (g) => {
    g.fillStyle = '#6b8f3a'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#8fbf52'; g.fillRect(0, 0, 64, 8);
  }),
  slingshot: () => canvasTexture('sling', 48, 64, (g) => {
    g.fillStyle = '#8a8f98'; g.fillRect(20, 24, 8, 40);
    g.lineWidth = 6; g.strokeStyle = '#8a8f98';
    g.beginPath(); g.moveTo(24, 26); g.lineTo(8, 2); g.moveTo(24, 26); g.lineTo(40, 2); g.stroke();
  }),
  bg_sky: () => null,
};

AFRAME.registerComponent('physics-puzzle', {
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

    // ---- Matter.js エンジン / ワールド ----
    this.engine = Engine.create();
    this.engine.gravity.x = 0;
    this.engine.gravity.y = GRAVITY_Y;
    this.engine.gravity.scale = GRAVITY_SCALE;
    this.engine.enableSleeping = true;
    this.world = this.engine.world;

    const staticOpts = { isStatic: true, friction: 0.8, restitution: 0.0, label: 'static' };
    const groundBody = Bodies.rectangle(W / 2, GROUND_TOP_Y + GROUND_H / 2, W, GROUND_H, staticOpts);
    const wallL = Bodies.rectangle(-WALL_T / 2, H / 2, WALL_T, H * 2, staticOpts);
    const wallR = Bodies.rectangle(W + WALL_T / 2, H / 2, WALL_T, H * 2, staticOpts);
    Composite.add(this.world, [groundBody, wallL, wallR]);

    // 状態
    this.tex = {};
    this.boxes = [];
    this.balls = [];
    this.boxSet = 0;
    this.score = 0;
    this.shotsFired = 0;
    this.autoShot = false;
    this.autoTimer = 0;
    this.autoRnd = mulberry32(0xAA70);
    this.fpsSamples = [];
    this.hudTimer = 0;
    this.ready = false;

    // タイトル/アトラクト状態: started=false … デモ中(操作無効・デモAIが自動発射)
    this.started = false;
    this.blinkT = 0;
    this.demoTimer = 0;   // デモ自動発射の計時(累積秒)
    this.demoSeq = 0;     // デモ発射回数(決定的に角度/強さを振る)
    this.titleEl = document.getElementById('title');

    // 入力 (マウス/キーボード)
    this.dragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.dragNow = { x: 0, y: 0 };
    this.bindInput(sceneEl);

    // アセット読み込み → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  // --- 表示ヘルパ ---
  texOf(key) { return this.tex[key] || (fb[key] && fb[key]()); },
  makeSprite(texture, w, h, renderOrder) {
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const s = new THREE.Sprite(mat);
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    this.group.add(s); return s;
  },

  bindInput(sceneEl) {
    const canvasOf = () => sceneEl.canvas || sceneEl.renderer?.domElement;
    const toMatter = (ev) => {
      const c = canvasOf(); if (!c) return { x: 0, y: 0 };
      const rect = c.getBoundingClientRect();
      const sx = W / rect.width, sy = H / rect.height;
      return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
    };
    const onDown = (ev) => { this.dragging = true; this.dragStart = toMatter(ev); this.dragNow = { ...this.dragStart }; };
    const onMove = (ev) => { if (this.dragging) this.dragNow = toMatter(ev); };
    const onUp = (ev) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (!this.started) return;       // アトラクト中はユーザー発射を無効化 (デモAIのみ)
      const end = toMatter(ev);
      const dx = end.x - this.dragStart.x, dy = end.y - this.dragStart.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 6) {
        const ax = end.x - SLING_X, ay = end.y - SLING_Y, a = Math.hypot(ax, ay) || 1;
        this.spawnBall(SLING_X, SLING_Y, (ax / a) * CLICK_SPEED, (ay / a) * CLICK_SPEED);
      } else {
        let vx = -dx * DRAG_TO_VEL, vy = -dy * DRAG_TO_VEL;
        const sp = Math.hypot(vx, vy);
        if (sp > MAX_LAUNCH_SPEED) { vx = vx / sp * MAX_LAUNCH_SPEED; vy = vy / sp * MAX_LAUNCH_SPEED; }
        this.spawnBall(SLING_X, SLING_Y, vx, vy);
      }
    };
    const attach = () => {
      const c = canvasOf(); if (!c) return;
      c.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    if (sceneEl.hasLoaded) attach(); else sceneEl.addEventListener('loaded', attach);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' && !this.started) { this.startGame(); e.preventDefault(); }
      else if (e.code === 'Space') { this.autoShot = !this.autoShot; this.autoTimer = AUTO_INTERVAL; e.preventDefault(); }
      else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.setBoxCount(this.boxSet + BOX_STEP); this.resetScore(); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.setBoxCount(this.boxSet - BOX_STEP); this.resetScore(); e.preventDefault(); }
      else if (e.code === 'KeyR') { this.setBoxCount(this.boxSet); this.clearBalls(); this.resetScore(); e.preventDefault(); }
    });
  },

  // --- 静的表示 + 初期スタック ---
  build() {
    if (this.tex.bg_sky) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
        new THREE.MeshBasicMaterial({ map: this.tex.bg_sky, depthTest: false }));
      m.position.set(W / 2, H / 2, 0); m.renderOrder = RO.bg; this.group.add(m);
    }
    {
      const g = this.makeSprite(this.texOf('ground'), W, GROUND_H, RO.ground);
      g.position.set(W / 2, worldY(GROUND_TOP_Y + GROUND_H / 2), 0.01);
    }
    {
      const s = this.makeSprite(this.texOf('slingshot'), 48, 64, RO.ground);
      s.position.set(SLING_X, worldY(GROUND_TOP_Y - 32), 0.02);
    }
    this.setBoxCount(BOX_INIT);
    this.ready = true;
  },

  computeStackLayout(n) {
    const baseCenterX = 690;
    const gap = 1;
    const step = BOX + gap;
    let baseW = 1;
    while (true) {
      let total = 0;
      for (let w = baseW; w >= 1; w--) total += w;
      if (total >= n || baseW >= 26) break;
      baseW++;
    }
    const positions = [];
    let placed = 0, rowW = baseW, row = 0;
    while (placed < n && rowW >= 1) {
      const rowCount = Math.min(rowW, n - placed);
      const left = baseCenterX - (rowCount * step) / 2 + step / 2;
      const cy = GROUND_TOP_Y - BOX / 2 - row * step;
      for (let c = 0; c < rowCount; c++) { positions.push({ x: left + c * step, y: cy }); placed++; }
      rowW--; row++;
      if (rowW < 1 && placed < n) { rowW = baseW; row = 0; }
    }
    return positions;
  },
  pickTargets(positions) {
    const rnd = mulberry32(0xA117);
    const targets = new Set();
    if (positions.length === 0) return targets;
    const sorted = positions.map((p, i) => ({ i, y: p.y })).sort((a, b) => a.y - b.y);
    const topPool = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.25)));
    const count = clamp(2 + Math.floor(positions.length / 120), 2, 6);
    for (let k = 0; k < count && topPool.length > 0; k++) {
      const idx = Math.floor(rnd() * topPool.length);
      targets.add(topPool[idx].i); topPool.splice(idx, 1);
    }
    return targets;
  },

  buildStack(n) {
    for (const b of this.boxes) { Composite.remove(this.world, b.body); this.group.remove(b.sprite); b.sprite.material.dispose(); }
    this.boxes.length = 0;
    const positions = this.computeStackLayout(n);
    const targets = this.pickTargets(positions);
    const rnd = mulberry32(0x5EED);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const isTarget = targets.has(i);
      const cx = p.x + (rnd() - 0.5) * 0.6;
      const cy = p.y;
      const body = Bodies.rectangle(cx, cy, BOX, BOX, {
        density: BOX_DENSITY, friction: BOX_FRICTION, frictionStatic: 0.8,
        restitution: BOX_RESTITUTION, label: isTarget ? 'target' : 'box', sleepThreshold: 30,
      });
      Composite.add(this.world, body);
      const sprite = this.makeSprite(this.texOf(isTarget ? 'box_target' : 'box'), BOX, BOX, RO.box);
      this.boxes.push({ body, sprite, isTarget, scored: false, x0: cx, y0: cy });
    }
    this.boxSet = n;
  },
  setBoxCount(n) { this.buildStack(clamp(n, BOX_MIN, BOX_MAX)); },

  spawnBall(x, y, vx, vy) {
    if (this.balls.length >= MAX_SHOTS) {
      const old = this.balls.shift();
      Composite.remove(this.world, old.body); this.group.remove(old.sprite); old.sprite.material.dispose();
    }
    const body = Bodies.circle(x, y, BALL_R, {
      density: BALL_DENSITY, friction: 0.4, frictionAir: 0.001,
      restitution: BALL_RESTITUTION, label: 'ball', sleepThreshold: 30,
    });
    Body.setVelocity(body, { x: vx, y: vy });
    Composite.add(this.world, body);
    const sprite = this.makeSprite(this.texOf('ball'), BALL_R * 2, BALL_R * 2, RO.ball);
    this.balls.push({ body, sprite });
    this.shotsFired++;
  },
  clearBalls() {
    for (const b of this.balls) { Composite.remove(this.world, b.body); this.group.remove(b.sprite); b.sprite.material.dispose(); }
    this.balls.length = 0;
  },

  // Enter でデモ→プレイ開始: 新規リセット (R 相当) して操作を有効化、タイトルを消す。
  startGame() {
    this.started = true;
    this.setBoxCount(this.boxSet); this.clearBalls(); this.resetScore();
    if (this.titleEl) this.titleEl.style.display = 'none';
  },

  // デモAI: アトラクト中 (started=false) は約2秒ごとに角度・強さを変えて発射 (累積時間ベース・決定的)。
  demoFire(dt) {
    this.demoTimer += dt;
    while (this.demoTimer >= 2.0) {
      this.demoTimer -= 2.0;
      const s = this.demoSeq++;
      const ang = (-58 + 22 * Math.sin(s * 0.9)) * Math.PI / 180; // Matter 座標で上向き右
      const spd = 19 + 5 * Math.sin(s * 1.7);
      this.spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
    }
  },

  resetScore() { this.score = 0; this.shotsFired = 0; },
  scanDisplacement() {
    for (const b of this.boxes) {
      if (b.scored) continue;
      const dx = b.body.position.x - b.x0, dy = b.body.position.y - b.y0;
      if ((dx * dx + dy * dy) >= DISPLACE_DIST * DISPLACE_DIST) {
        b.scored = true; this.score += b.isTarget ? SCORE_TARGET : SCORE_NORMAL;
      }
    }
  },
  reapOffWorld() {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i]; const p = b.body.position;
      const off = p.y > H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > W + KILL_MARGIN;
      if (off && b.body.isSleeping) { Composite.remove(this.world, b.body); this.group.remove(b.sprite); b.sprite.material.dispose(); this.boxes.splice(i, 1); }
    }
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i]; const p = b.body.position;
      const off = p.y > H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > W + KILL_MARGIN;
      if (off) { Composite.remove(this.world, b.body); this.group.remove(b.sprite); b.sprite.material.dispose(); this.balls.splice(i, 1); }
    }
  },
  countActive() {
    const all = Composite.allBodies(this.world);
    let awake = 0;
    for (const b of all) { if (b.isStatic) continue; if (!b.isSleeping) awake++; }
    return awake;
  },

  tick(time, dtMs) {
    if (!this.ready) return;
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50);
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    // デモAI: アトラクト中 (!started) は約2秒ごとに自動発射
    if (!this.started) this.demoFire(dt);

    // オートショット
    if (this.started && this.autoShot) {
      this.autoTimer += dt;
      while (this.autoTimer >= AUTO_INTERVAL) {
        this.autoTimer -= AUTO_INTERVAL;
        const t = this.autoRnd();
        const ang = (-55 + t * 40) * Math.PI / 180;
        const spd = 18 + this.autoRnd() * 6;
        this.spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
      }
    }

    // 物理1ステップ (Matter に完全委譲)
    Engine.update(this.engine, Math.min(dtMs, 32));

    this.scanDisplacement();
    this.reapOffWorld();

    // Matter ボディ → THREE.Sprite 同期 (worldY=H-y / rotation=-angle)
    for (const b of this.boxes) {
      const p = b.body.position;
      b.sprite.position.set(p.x, worldY(p.y), b.sprite.renderOrder * 0.001);
      b.sprite.material.rotation = -b.body.angle;
      b.sprite.material.opacity = b.scored ? 0.7 : 1.0;
    }
    for (const b of this.balls) {
      const p = b.body.position;
      b.sprite.position.set(p.x, worldY(p.y), b.sprite.renderOrder * 0.001);
      b.sprite.material.rotation = -b.body.angle;
    }

    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const totalBodies = Composite.allBodies(this.world).length;
      const active = this.countActive();
      this.hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Bodies : ${this.boxes.length} / ${this.boxSet}  (total ${totalBodies}, +balls/walls)\n` +
        `Active : ${active}  (awake bodies)\n` +
        `Shots  : ${this.balls.length} live / ${this.shotsFired} fired  (max ${MAX_SHOTS})\n` +
        `Score  : ${this.score}\n` +
        `Engine : Matter (CDN)   Auto: ${this.autoShot ? 'ON' : 'off'}`;
    }

    // タイトル点滅 (約0.45s 周期)
    if (!this.started && this.titleEl) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  },
});

console.log('[A-Frame + Matter.js] theme7 physics puzzle component registered.');
