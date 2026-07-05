/* ============================================================================
 * ブロック崩し (マルチボール Breakout) - A-Frame (1.7.0) 実装
 * 共通仕様 SPEC.md に厳密準拠。性能比較用。
 *
 * A-Frame は three.js 上の宣言的 (entity-component) フレームワーク。
 * シーンは index.html に <a-scene> として宣言し、ゲーム本体は登録した
 * `breakout-game` コンポーネントが駆動する (A-Frame の renderer / tick ループ /
 * カメラ管理を利用)。
 *
 * 設計判断: ボール・ブロックは数百規模になり得るため「1個 = 1 <a-entity>」だと
 * DOM/コンポーネント生成コストで FPS が破綻する。そこで動的オブジェクトは
 * コンポーネント内で THREE.Sprite を直接生成・管理する (AFRAME.THREE を使用)。
 * カメラは 2D 用に OrthographicCamera へ差し替える。
 * 当たり判定は SPEC 準拠の自前 AABB×円(最近点)。座標は画面座標(Y下)保持→
 * worldY=H-y 変換。物理エンジンは不使用。
 * ========================================================================== */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

// パドル
const PADDLE_W = 96, PADDLE_H = 18, PADDLE_Y = 510, PADDLE_SPEED = 600;
// ボール
const BALL_R = 8, BALL_SPEED = 380, LAUNCH_ANGLE = 60;
// ブロック (グリッド)
const BRICK_COLS = 15, BRICK_ROWS = 9, BRICK_W = 56, BRICK_H = 20, BRICK_GAP = 4, BRICK_TOP = 60;
// 同時ボール数 (負荷)
const INITIAL_BALLS = 3, BALL_STEP = 5, BALL_MIN = 1, BALL_MAX = 500;

const SCORE_PER_BRICK = 10;
const SPARK_LIFE = 220;             // ms

// HP ごとの色 (HP3=赤 / HP2=橙 / HP1=緑)。明色テクスチャに乗算 (tint)。
const HP_COLOR = { 3: 0xff4444, 2: 0xffa23a, 1: 0x55cc66 };

const ASSET_DEFS = {
  paddle:      '../assets/paddle.png',
  ball:        '../assets/ball.png',
  brick:       '../assets/brick.png',
  hit_spark:   '../assets/hit_spark.png',
  bg_breakout: '../assets/bg_breakout.png',
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RO = { bg: 0, brick: 1, ball: 2, fx: 3, paddle: 4 };

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
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const fb = {
  paddle:      () => canvasTexture('paddle', PADDLE_W, PADDLE_H, (g, w, h) => { g.fillStyle = '#fff'; roundRect(g, 0, 0, w, h, 9); g.fill(); }),
  ball:        () => canvasTexture('ball', 32, 32, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); }),
  brick:       () => canvasTexture('brick', 64, 24, (g, w, h) => { g.fillStyle = '#fff'; roundRect(g, 0, 0, w, h, 4); g.fill(); }),
  hit_spark:   () => canvasTexture('spark', 32, 32, (g) => { g.fillStyle = 'rgba(255,210,58,0.9)'; g.beginPath(); g.arc(16, 16, 15, 0, 7); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(16, 16, 7, 0, 7); g.fill(); }),
};

AFRAME.registerComponent('breakout-game', {
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
    this.paddle = null;
    this.balls = []; this.bricks = []; this.effects = [];
    this.score = 0; this.lost = 0; this.ballSetting = INITIAL_BALLS;
    this.fpsSamples = []; this.hudTimer = 0;
    this.ready = false;
    this.started = false; this.blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
    this.titleEl = document.getElementById('title');

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.key === 'Enter' && !this.started) { this.startGame(); e.preventDefault(); }
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.ballSetting = clamp(this.ballSetting + BALL_STEP, BALL_MIN, BALL_MAX); this.syncBallCount(); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.ballSetting = clamp(this.ballSetting - BALL_STEP, BALL_MIN, BALL_MAX); this.syncBallCount(); e.preventDefault(); }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
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

  makeSprite(key, w, h, renderOrder, color) {
    const mat = new THREE.SpriteMaterial({ map: this.texOf(key), transparent: true, depthTest: false });
    if (color !== undefined) mat.color.setHex(color); // HP 色を乗算 (tint)
    const s = new THREE.Sprite(mat);
    s.scale.set(w, h, 1); s.renderOrder = renderOrder;
    this.group.add(s); return s;
  },
  // 画面座標(Y下)→ワールド(Y上)変換。cx,cy は中心。
  syncCenter(sprite, cx, cy) { sprite.position.set(cx, H - cy, sprite.renderOrder * 0.01); },
  rm(arr, i) { const o = arr[i]; this.group.remove(o.sprite); o.sprite.material.dispose(); arr[i] = arr[arr.length - 1]; arr.pop(); },
  down(...c) { return c.some((k) => this.keys[k]); },
  renormSpeed(b) { const len = Math.hypot(b.vx, b.vy) || 1; b.vx = (b.vx / len) * BALL_SPEED; b.vy = (b.vy / len) * BALL_SPEED; },

  build() {
    // 背景: bg画像があればタイル Plane、無ければスターフィールド(Points)
    if (this.tex.bg_breakout) {
      this.tex.bg_breakout.wrapS = this.tex.bg_breakout.wrapT = THREE.RepeatWrapping;
      this.tex.bg_breakout.repeat.set(W / 512, H / 512);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: this.tex.bg_breakout, depthTest: false }));
      m.position.set(W / 2, H / 2, -10); m.renderOrder = RO.bg; this.group.add(m);
    } else {
      const STAR_N = 160;
      const pos = new Float32Array(STAR_N * 3);
      for (let i = 0; i < STAR_N; i++) { pos[i * 3] = rand(0, W); pos[i * 3 + 1] = rand(0, H); pos[i * 3 + 2] = -5; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5, depthTest: false }));
      this.stars.renderOrder = RO.bg; this.group.add(this.stars);
    }

    // パドル
    this.paddle = { sprite: this.makeSprite('paddle', PADDLE_W, PADDLE_H, RO.paddle), x: W / 2, y: PADDLE_Y };
    this.syncCenter(this.paddle.sprite, this.paddle.x, this.paddle.y);

    this.buildBricks();
    this.syncBallCount();
    this.ready = true;
  },

  // Enter でデモ→プレイ開始: スコア/盤面/ボールを初期化して操作を有効化
  restart() {
    this.score = 0; this.lost = 0; this.ballSetting = INITIAL_BALLS;
    this.paddle.x = W / 2;
    this.buildBricks();
    this.syncBallCount();
  },
  startGame() { this.started = true; this.restart(); this.titleEl.style.display = 'none'; },

  // ボール生成 (パドル上から上方向へ ±60° のランダム角で発射)
  makeBall() {
    const s = this.makeSprite('ball', BALL_R * 2, BALL_R * 2, RO.ball);
    const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
    const a = (-90 + deg) * Math.PI / 180;
    const b = { sprite: s, x: this.paddle.x, y: this.paddle.y - PADDLE_H, vx: Math.cos(a) * BALL_SPEED, vy: Math.sin(a) * BALL_SPEED };
    this.syncCenter(s, b.x, b.y);
    this.balls.push(b);
  },
  syncBallCount() {
    while (this.balls.length < this.ballSetting) this.makeBall();
    while (this.balls.length > this.ballSetting) {
      const b = this.balls.pop();
      this.group.remove(b.sprite); b.sprite.material.dispose();
    }
  },

  // ブロック盤面の生成 (15列 × 9行)
  buildBricks() {
    for (const br of this.bricks) { this.group.remove(br.sprite); br.sprite.material.dispose(); }
    this.bricks.length = 0;
    const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    const startX = (W - totalW) / 2;
    for (let row = 0; row < BRICK_ROWS; row++) {
      const hp = row < 3 ? 3 : row < 6 ? 2 : 1; // 上3=HP3 / 中3=HP2 / 下3=HP1
      for (let col = 0; col < BRICK_COLS; col++) {
        const x = startX + col * (BRICK_W + BRICK_GAP);
        const y = BRICK_TOP + row * (BRICK_H + BRICK_GAP);
        const s = this.makeSprite('brick', BRICK_W, BRICK_H, RO.brick, HP_COLOR[hp]);
        this.syncCenter(s, x + BRICK_W / 2, y + BRICK_H / 2); // 左上→中心
        this.bricks.push({ sprite: s, x, y, hp });
      }
    }
  },

  spawnSpark(cx, cy) {
    const s = this.makeSprite('hit_spark', 28, 28, RO.fx);
    this.syncCenter(s, cx, cy);
    this.effects.push({ sprite: s, life: SPARK_LIFE, max: SPARK_LIFE, base: 28 });
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

    const paddle = this.paddle;

    // --- パドル移動 (水平のみ + クランプ) ---
    let mx = 0;
    if (!this.started) {
      // デモAI: 最も下(最大y)のボールの x へパドルを追従させる(速度上限内で)
      let target = paddle.x, lowestY = -Infinity;
      for (let i = 0; i < this.balls.length; i++) { if (this.balls[i].y > lowestY) { lowestY = this.balls[i].y; target = this.balls[i].x; } }
      const diff = target - paddle.x;
      if (Math.abs(diff) > 1) mx = diff > 0 ? 1 : -1;
    } else {
      if (this.down('ArrowLeft', 'KeyA')) mx -= 1;
      if (this.down('ArrowRight', 'KeyD')) mx += 1;
    }
    paddle.x = clamp(paddle.x + mx * PADDLE_SPEED * dt, PADDLE_W / 2, W - PADDLE_W / 2);
    this.syncCenter(paddle.sprite, paddle.x, paddle.y);

    const padL = paddle.x - PADDLE_W / 2, padR = paddle.x + PADDLE_W / 2;
    const padT = paddle.y - PADDLE_H / 2, padB = paddle.y + PADDLE_H / 2;

    // --- ボール更新 (移動 → 壁/天井/パドル反射 → ブロック判定) ---
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
      else if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
      if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

      // パドルで反射 (常に上方向へ。中心からのオフセットで反射角を変える)
      if (b.vy > 0 &&
          b.x + BALL_R > padL && b.x - BALL_R < padR &&
          b.y + BALL_R > padT && b.y - BALL_R < padB) {
        const off = clamp((b.x - paddle.x) / (PADDLE_W / 2), -1, 1);
        const a = (-90 + off * LAUNCH_ANGLE) * Math.PI / 180;
        b.vx = Math.cos(a) * BALL_SPEED;
        b.vy = Math.sin(a) * BALL_SPEED;
        b.y = padT - BALL_R;
      }

      // 下端を抜けたらロスト → パドル上から再発射 (数を維持)
      if (b.y - BALL_R > H) {
        this.lost++;
        const deg = rand(-LAUNCH_ANGLE, LAUNCH_ANGLE);
        const a = (-90 + deg) * Math.PI / 180;
        b.x = paddle.x; b.y = paddle.y - PADDLE_H;
        b.vx = Math.cos(a) * BALL_SPEED; b.vy = Math.sin(a) * BALL_SPEED;
      }

      // --- ボール × ブロック (AABB矩形 × 円, 最近点) ---
      for (let j = this.bricks.length - 1; j >= 0; j--) {
        const br = this.bricks[j];
        const nx = clamp(b.x, br.x, br.x + BRICK_W);
        const ny = clamp(b.y, br.y, br.y + BRICK_H);
        const dx = b.x - nx, dy = b.y - ny;
        if (dx * dx + dy * dy <= BALL_R * BALL_R) {
          const bcx = br.x + BRICK_W / 2, bcy = br.y + BRICK_H / 2;
          const ox = (BRICK_W / 2 + BALL_R) - Math.abs(b.x - bcx);
          const oy = (BRICK_H / 2 + BALL_R) - Math.abs(b.y - bcy);
          if (ox < oy) b.vx = (b.x < bcx) ? -Math.abs(b.vx) : Math.abs(b.vx);
          else b.vy = (b.y < bcy) ? -Math.abs(b.vy) : Math.abs(b.vy);
          this.renormSpeed(b);

          br.hp -= 1;
          if (br.hp <= 0) {
            this.spawnSpark(bcx, bcy);
            this.rm(this.bricks, j);
            this.score += SCORE_PER_BRICK;
          } else {
            br.sprite.material.color.setHex(HP_COLOR[br.hp]); // HP 色を更新
          }
          break; // 1フレーム1ブロックまで
        }
      }

      this.syncCenter(b.sprite, b.x, b.y);
    }

    // --- 全ブロック破壊で盤面を再生成 ---
    if (this.bricks.length === 0) this.buildBricks();

    // --- エフェクト更新 (フェードアウト + 膨張) ---
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const f = this.effects[i]; f.life -= dtMs; const t = f.life / f.max;
      f.sprite.material.opacity = clamp(t, 0, 1);
      const sc = (1 - t) * 0.6 + 1; f.sprite.scale.set(f.base * sc, f.base * sc, 1);
      if (f.life <= 0) this.rm(this.effects, i);
    }

    // --- HUD 更新 (約120msに1回) ---
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const objects = this.balls.length + this.bricks.length + this.effects.length;
      this.hudEl.textContent =
        `FPS     : ${fpsAvg.toFixed(1)}\n` +
        `Objects : ${objects}  (ball ${this.balls.length} / brick ${this.bricks.length} / fx ${this.effects.length})\n` +
        `Score   : ${this.score}\n` +
        `Balls   : ${this.balls.length} / ${this.ballSetting}  (+/- to change, 1..${BALL_MAX})\n` +
        `Bricks  : ${this.bricks.length}\n` +
        `Lost    : ${this.lost}`;
    }

    // --- タイトル点滅 (アトラクト中のみ) ---
    if (!this.started) { this.blinkT += dt; this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  },
});

console.log('A-Frame Breakout component registered.');
