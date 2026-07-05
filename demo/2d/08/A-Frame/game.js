/* =========================================================================
 * テーマ8 パーティクル / 魔法エフェクトデモ ― A-Frame (1.7.0) 実装
 * 仕様: SPEC.md (960x540 / 加算合成 / 周回オーブ / 爆発バースト / プール再利用)
 *
 * 使用機構: **THREE.Points + BufferGeometry（GPU 寄り）を fx-game コンポーネント
 * 内で直接構築**。A-Frame は three.js 上の宣言的フレームワークだが、5万個の
 * パーティクルを「1 個 = 1 <a-entity>」で作ると DOM/コンポーネント生成で即破綻する。
 * そこで動的描画は **コンポーネント内で AFRAME.THREE の Points を 1 個生成**し、
 * 位置/色/サイズを TypedArray attribute に詰めて毎フレーム更新 → GPU が単一 draw call
 * でまとめて描く（three.js 版と同一機構）。
 *   - 加算合成: PointsMaterial.blending = THREE.AdditiveBlending。B で Normal 切替。
 *   - per-particle サイズは PointsMaterial.onBeforeCompile で aSize → gl_PointSize に注入。
 *   - 物理更新（位置/寿命）は CPU の TypedArray ループ＝「GPU 描画 + CPU 更新」比較。
 *
 * 2D 化: tick で sceneEl.camera を OrthographicCamera(0,W,H,0,-1000,1000) に維持
 * （A-Frame 既定の perspective を上書き）。setPixelRatio(1)。座標は画面座標(Y下)で
 * 保持し worldY = H - gameY 変換。tick の dt は ms 単位。
 * =========================================================================*/

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC) — 全エンジン共通値 ---------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;

const LIFE_MIN = 0.6, LIFE_MAX = 1.4;
const GRAVITY = 90;
const DRAG = 0.86;
const SIZE_BIG = 1.4, SIZE_SMALL = 0.15;
const SPRITE_BASE = 32;

const TARGET_INIT = 2000;
const TARGET_STEP = 2000;
const TARGET_MIN = 500;
const TARGET_MAX = 50000;
const POOL_CAP = TARGET_MAX + 4000;

const ORB_COUNT = 4;
const ORB_RADIUS = 14;
const ORB_EMIT_BASE = 60;

const BURST_MIN = 120, BURST_MAX = 200;
const AUTO_INTERVAL = 0.5;
const BURST_LIFETIME = 0.45;
const TRAIL_RATE = 90;

const WARM = { r: 1.0, g: 0.78, b: 0.32 };
const COOL = { r: 0.30, g: 0.55, b: 1.0 };

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
const lerp = (a, b, t) => a + (b - a) * t;
function lerpColor(t) {
  return {
    r: clamp(lerp(WARM.r, COOL.r, t), 0, 1),
    g: clamp(lerp(WARM.g, COOL.g, t), 0, 1),
    b: clamp(lerp(WARM.b, COOL.b, t), 0, 1),
  };
}
function makeGlowTexture(size, inner, outer) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const cc = size / 2;
  const grad = ctx.createRadialGradient(cc, cc, 0, cc, cc, cc);
  grad.addColorStop(0.0, inner);
  grad.addColorStop(0.35, inner);
  grad.addColorStop(1.0, outer);
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cc, cc, cc, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

AFRAME.registerComponent('fx-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera（tick で sceneEl.camera を維持）
    this.cam = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1);
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    this.ready = false;
    this.tex = {};

    // ---- 状態 ----
    this.rnd = mulberry32(20250615);
    this.targetCap = TARGET_INIT;
    this.blendAdd = true;
    this.autoFire = false;
    this.autoAcc = 0; this.autoSeq = 0;
    this.elapsed = 0;
    this.bursts = [];
    this.liveCount = 0;
    this.maxIndex = 0;

    this.mouseX = VIEW_W / 2; this.mouseY = VIEW_H / 2;
    this.mouseInside = false;
    this.mousePrevX = this.mouseX; this.mousePrevY = this.mouseY;
    this.trailAcc = 0;
    this.fpsSamples = []; this.hudTimer = 0;

    const autoRnd = mulberry32(13579);
    this.autoSpots = [];
    for (let i = 0; i < 32; i++) {
      this.autoSpots.push({ x: 80 + autoRnd() * (VIEW_W - 160), y: 70 + autoRnd() * (VIEW_H - 200) });
    }

    // ---- 入力 ----
    this.keyHandler = (e) => {
      if (e.code === 'Space') { this.autoFire = !this.autoFire; this.autoAcc = 0; e.preventDefault(); }
      else if (e.code === 'KeyB') {
        this.blendAdd = !this.blendAdd;
        if (this.mat) { this.mat.blending = this.blendAdd ? THREE.AdditiveBlending : THREE.NormalBlending; this.mat.needsUpdate = true; }
        for (const s of this.orbSprites || []) { s.material.blending = this.blendAdd ? THREE.AdditiveBlending : THREE.NormalBlending; s.material.needsUpdate = true; }
      }
      else if (e.code === 'KeyR') { this.resetAll(); }
      else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
        this.targetCap = clamp(this.targetCap + TARGET_STEP, TARGET_MIN, TARGET_MAX); e.preventDefault();
      }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
        this.targetCap = clamp(this.targetCap - TARGET_STEP, TARGET_MIN, TARGET_MAX); e.preventDefault();
      }
    };
    window.addEventListener('keydown', this.keyHandler);

    const canvasEl = sceneEl.canvas || sceneEl;
    const localPoint = (ev) => {
      const rect = (sceneEl.canvas || sceneEl).getBoundingClientRect();
      const sx = VIEW_W / rect.width, sy = VIEW_H / rect.height;
      return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
    };
    const bindCanvas = () => {
      const cv = sceneEl.canvas;
      if (!cv) return;
      cv.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return;
        const p = localPoint(ev);
        const count = BURST_MIN + Math.floor(this.rnd() * (BURST_MAX - BURST_MIN + 1));
        this.burst(p.x, p.y, count);
      });
      cv.addEventListener('mousemove', (ev) => { const p = localPoint(ev); this.mouseX = p.x; this.mouseY = p.y; this.mouseInside = true; });
      cv.addEventListener('mouseleave', () => { this.mouseInside = false; });
    };
    if (sceneEl.canvas) bindCanvas(); else sceneEl.addEventListener('loaded', bindCanvas);

    // ---- アセット読込 → ワールド構築 ----
    const loader = new THREE.TextureLoader();
    const defs = { spark: '../assets/particle_spark.png', orb: '../assets/orb.png', bg: '../assets/bg_dark.png' };
    Promise.all(Object.entries(defs).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> glow fallback`); res(); });
    }))).then(() => {
      if (!this.tex.spark) this.tex.spark = makeGlowTexture(32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
      if (!this.tex.orb)   this.tex.orb   = makeGlowTexture(64, 'rgba(255,255,255,1)', 'rgba(180,200,255,0)');
      this.build();
    });
  },

  build() {
    // 背景: 暗色 plane + 微弱な星
    if (this.tex.bg) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(VIEW_W, VIEW_H),
        new THREE.MeshBasicMaterial({ map: this.tex.bg, depthTest: false }));
      m.position.set(VIEW_W / 2, VIEW_H / 2, -50); m.renderOrder = -2;
      this.group.add(m);
    }
    const starRnd = mulberry32(424242);
    const STAR_N = 90;
    const starPos = new Float32Array(STAR_N * 3);
    for (let i = 0; i < STAR_N; i++) {
      starPos[i * 3] = starRnd() * VIEW_W;
      starPos[i * 3 + 1] = starRnd() * VIEW_H;
      starPos[i * 3 + 2] = -10;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xbcc8ff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5, depthTest: false }));
    stars.renderOrder = -1; this.group.add(stars);

    // ---- パーティクル: 単一 THREE.Points（GPU 寄り） ----
    this.posArr = new Float32Array(POOL_CAP * 3);
    this.colArr = new Float32Array(POOL_CAP * 3);
    this.sizeArr = new Float32Array(POOL_CAP);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArr, 3);
    this.colAttr = new THREE.BufferAttribute(this.colArr, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.sizeArr, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setDrawRange(0, 0);
    this.geo = geo;

    this.mat = new THREE.PointsMaterial({
      map: this.tex.spark,
      size: SPRITE_BASE,
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
    });
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float aSize;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = aSize;');
    };
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    // ---- パーティクル状態（SoA） ----
    this.px = new Float32Array(POOL_CAP);
    this.py = new Float32Array(POOL_CAP);
    this.vx = new Float32Array(POOL_CAP);
    this.vy = new Float32Array(POOL_CAP);
    this.life = new Float32Array(POOL_CAP);
    this.maxLife = new Float32Array(POOL_CAP);
    this.big = new Float32Array(POOL_CAP);
    this.live = new Uint8Array(POOL_CAP);
    this.free = [];
    for (let i = POOL_CAP - 1; i >= 0; i--) this.free.push(i);

    this.orbSprites = [];
    this.buildOrbs();
    this.ready = true;
  },

  makeOrbSprite() {
    const m = new THREE.SpriteMaterial({ map: this.tex.orb, transparent: true, depthTest: false,
      depthWrite: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(m);
    s.scale.set(ORB_RADIUS * 2.6, ORB_RADIUS * 2.6, 1);
    s.renderOrder = 5;
    this.group.add(s);
    return s;
  },

  buildOrbs() {
    for (const s of this.orbSprites) { this.group.remove(s); s.material.dispose(); }
    this.orbSprites.length = 0;
    this.orbs = [];
    const orbRnd = mulberry32(987654321);
    for (let i = 0; i < ORB_COUNT; i++) {
      const c = lerpColor(i / Math.max(1, ORB_COUNT - 1));
      const sprite = this.makeOrbSprite();
      sprite.material.color.setRGB(c.r, c.g, c.b);
      this.orbSprites.push(sprite);
      this.orbs.push({
        sprite,
        cx: VIEW_W * (0.3 + orbRnd() * 0.4),
        cy: VIEW_H * (0.3 + orbRnd() * 0.4),
        ax: 140 + orbRnd() * 180,
        ay: 90 + orbRnd() * 130,
        wx: 0.5 + orbRnd() * 0.8,
        wy: 0.6 + orbRnd() * 1.0,
        phx: orbRnd() * Math.PI * 2,
        phy: orbRnd() * Math.PI * 2,
        x: 0, y: 0, px: 0, py: 0, emitAcc: 0,
      });
    }
  },

  emit(x, y, ivx, ivy, lifeScale = 1, bigScale = 1) {
    if (this.liveCount >= this.targetCap) return false;
    const idx = this.free.pop();
    if (idx === undefined) return false;
    this.live[idx] = 1;
    this.px[idx] = x; this.py[idx] = y;
    this.vx[idx] = ivx; this.vy[idx] = ivy;
    this.maxLife[idx] = (LIFE_MIN + this.rnd() * (LIFE_MAX - LIFE_MIN)) * lifeScale;
    this.life[idx] = this.maxLife[idx];
    this.big[idx] = SIZE_BIG * bigScale;
    if (idx + 1 > this.maxIndex) this.maxIndex = idx + 1;
    this.liveCount++;
    return true;
  },

  burst(x, y, count) {
    for (let i = 0; i < count; i++) {
      const ang = this.rnd() * Math.PI * 2;
      const spd = 80 + this.rnd() * 320;
      if (!this.emit(x, y, Math.cos(ang) * spd, Math.sin(ang) * spd, 1.0, 1.1)) break;
    }
    this.bursts.push({ x, y, t: BURST_LIFETIME });
  },

  resetAll() {
    for (let i = 0; i < this.maxIndex; i++) {
      if (this.live[i]) { this.live[i] = 0; this.sizeArr[i] = 0; this.free.push(i); }
    }
    this.liveCount = 0; this.maxIndex = 0;
    this.bursts.length = 0;
    this.targetCap = TARGET_INIT;
    this.autoFire = false; this.autoAcc = 0; this.autoSeq = 0; this.elapsed = 0;
    this.rnd = mulberry32(20250615);
    this.buildOrbs();
  },

  tick(time, dtMsRaw) {
    if (!this.ready) return;
    if (this.el.sceneEl.camera !== this.cam) this.el.sceneEl.camera = this.cam;

    const dtMs = Math.min(dtMsRaw || 16.7, 50);
    const dt = dtMs / 1000;
    this.elapsed += dt;

    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    const headroom = clamp((this.targetCap - this.liveCount) / this.targetCap, 0, 1);
    const orbEmitRate = ORB_EMIT_BASE * (0.4 + this.targetCap / TARGET_INIT * 0.6) * (0.3 + headroom);

    // 1) 周回オーブ + 連続噴出
    for (let i = 0; i < this.orbs.length; i++) {
      const o = this.orbs[i];
      o.px = o.x; o.py = o.y;
      o.x = o.cx + Math.sin(this.elapsed * o.wx + o.phx) * o.ax;
      o.y = o.cy + Math.sin(this.elapsed * o.wy + o.phy) * o.ay;
      o.sprite.position.set(o.x, VIEW_H - o.y, 1);
      o.sprite.material.opacity = 0.7 + 0.3 * Math.sin(this.elapsed * 3 + i);

      o.emitAcc += orbEmitRate * dt;
      let n = Math.floor(o.emitAcc); o.emitAcc -= n;
      const vmx = (o.x - o.px) / Math.max(dt, 1e-4);
      const vmy = (o.y - o.py) / Math.max(dt, 1e-4);
      while (n-- > 0) {
        const ang = this.rnd() * Math.PI * 2;
        const spd = 20 + this.rnd() * 70;
        if (!this.emit(o.x, o.y, Math.cos(ang) * spd - vmx * 0.25, Math.sin(ang) * spd - vmy * 0.25, 0.9, 0.8)) break;
      }
    }

    // 2) マウストレイル
    if (this.mouseInside) {
      const dx = this.mouseX - this.mousePrevX, dy = this.mouseY - this.mousePrevY;
      const moved = Math.hypot(dx, dy);
      if (moved > 0.5) {
        this.trailAcc += TRAIL_RATE * (0.3 + headroom) * dt + Math.min(moved * 0.6, 12);
        let n = Math.floor(this.trailAcc); this.trailAcc -= n;
        const inv = 1 / Math.max(moved, 1e-4);
        const dirx = dx * inv, diry = dy * inv;
        while (n-- > 0) {
          const along = -(20 + this.rnd() * 80);
          const side = (this.rnd() - 0.5) * 80;
          if (!this.emit(this.mouseX, this.mouseY, dirx * along - diry * side, diry * along + dirx * side, 0.8, 0.7)) break;
        }
      }
    }
    this.mousePrevX = this.mouseX; this.mousePrevY = this.mouseY;

    // 3) オート花火
    if (this.autoFire) {
      this.autoAcc += dt;
      while (this.autoAcc >= AUTO_INTERVAL) {
        this.autoAcc -= AUTO_INTERVAL;
        const spot = this.autoSpots[this.autoSeq % this.autoSpots.length]; this.autoSeq++;
        const count = BURST_MIN + Math.floor(this.rnd() * (BURST_MAX - BURST_MIN + 1));
        this.burst(spot.x, spot.y, count);
      }
    }

    // 4) パーティクル CPU 更新 → attribute 書き込み
    const dragF = Math.pow(DRAG, dt);
    let newMax = 0;
    for (let i = 0; i < this.maxIndex; i++) {
      if (!this.live[i]) { this.sizeArr[i] = 0; continue; }
      let l = this.life[i] - dt;
      if (l <= 0) {
        this.live[i] = 0; this.sizeArr[i] = 0; this.free.push(i); this.liveCount--;
        continue;
      }
      this.life[i] = l;
      this.vy[i] += GRAVITY * dt;
      this.vx[i] *= dragF; this.vy[i] *= dragF;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;

      const t = 1 - l / this.maxLife[i];
      const j3 = i * 3;
      this.posArr[j3] = this.px[i];
      this.posArr[j3 + 1] = VIEW_H - this.py[i];
      this.posArr[j3 + 2] = 0;
      const a = 1 - t * t;
      const c = lerpColor(t);
      this.colArr[j3] = c.r * a;
      this.colArr[j3 + 1] = c.g * a;
      this.colArr[j3 + 2] = c.b * a;
      this.sizeArr[i] = SPRITE_BASE * lerp(this.big[i], SIZE_SMALL, t);
      if (i + 1 > newMax) newMax = i + 1;
    }
    this.maxIndex = newMax;
    this.geo.setDrawRange(0, this.maxIndex);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;

    // 5) バースト残光
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      this.bursts[i].t -= dt;
      if (this.bursts[i].t <= 0) { this.bursts[i] = this.bursts[this.bursts.length - 1]; this.bursts.pop(); }
    }

    // 6) HUD
    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      const emitters = ORB_COUNT + this.bursts.length + (this.mouseInside ? 1 : 0);
      this.hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Particles : ${this.liveCount}  (live)\n` +
        `Target    : ${this.targetCap}   (+/- で ±${TARGET_STEP}, ${TARGET_MIN}..${TARGET_MAX})\n` +
        `Emitters  : ${emitters}   (orb ${ORB_COUNT} + burst ${this.bursts.length}${this.mouseInside ? ' + trail 1' : ''})\n` +
        `Blend     : ${this.blendAdd ? 'ADD' : 'NORMAL'}   (B で切替)\n` +
        `Mode      : GPU (THREE.Points / 1 draw call)\n` +
        `[click=爆発 / Space=オート(${this.autoFire ? 'ON' : 'OFF'}) / B / +/- / R]`;
    }
  },
});

console.log('[A-Frame 1.7.0] theme8 particles component (fx-game) registered. mode = GPU Points');
