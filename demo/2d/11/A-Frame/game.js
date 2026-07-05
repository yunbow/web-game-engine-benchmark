/* ============================================================================
 * テーマ11 2Dダイナミックライティング / 影（ライトマップ × 多光源 × 影）― A-Frame (1.7.0)
 * 共通仕様 11/SPEC.md に厳密準拠。性能比較用。定数は KAPLAY / PixiJS / three.js 版と同一。
 *
 * A-Frame は three.js 上の宣言的(entity-component)フレームワーク。シーンは index.html に
 * <a-scene> として宣言し、ゲーム本体は登録した `lighting-game` コンポーネントが駆動する
 * (A-Frame の renderer / tick ループを利用)。
 *
 * 設計判断: 床/柱/プレイヤー/ライトマップ overlay は、コンポーネント内で AFRAME.THREE の
 *   Mesh/Sprite を直接生成し this.el.object3D(=group) に足す(= A-Frame の自動描画に乗る)。
 *   2D 用に OrthographicCamera(0,W,H,0,-1000,1000) を sceneEl.camera に差し替える。
 *
 * --- A-Frame でのライトマップ実装の核(three.js と同一・エンジン自然な機構) --------
 *   ライトマップはオフスクリーンの ★WebGLRenderTarget★ へ加算合成で積み、結果を
 *   ★MultiplyBlending の全画面 quad★ にしてシーンへ重ねる:
 *     1) lightRT を ambient(0.10) のグレーでクリア。
 *     2) 影 OFF: 全グロー(AdditiveBlending の Sprite)を lightScene へまとめ lightRT に一括加算。
 *        影 ON : 光源ごとに scratchRT へ「グロー → 黒影ポリゴン」を描き、それを Additive quad
 *                経由で lightRT へ加算(光源数ぶんのバッファ往復＝影 ON のコスト)。
 *     3) lightRT を MultiplyBlending の overlay quad にして group に常駐させ、A-Frame の
 *        通常描画で床＋柱＋プレイヤーの上へ乗算合成する。
 *   tick の中で sceneEl.renderer を使い (2) のオフスクリーン描画を A-Frame 本描画の前に行う。
 * ========================================================================== */

const THREE = AFRAME.THREE;

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;
const TILE = 32;
const MAP_W = 30, MAP_H = 17;
const ROOM_W = MAP_W * TILE;             // 960
const ROOM_H = MAP_H * TILE;             // 544

const AMBIENT = 0.10;
const PLAYER_LIGHT_R = 240;
const DYN_LIGHT_R = 160;
const PLAYER_SPEED = 220;
const P_HALF = 11;
const P_DRAW_W = 24, P_DRAW_H = 36;

const LIGHT_INIT = 12, LIGHT_STEP = 6, LIGHT_MIN = 0, LIGHT_MAX = 120;
const DYN_SPEED = 120;

const OCCLUDER_COUNT = 16;
const SHADOW_PROJECT = 2000;
const SEED_OCCLUDER = 0x11AA11;
const SEED_LIGHTS = 0x51E0;

const ASSET_DEFS = {
  tile_floor:  '../assets/tile_floor.png',
  pillar:      '../assets/pillar.png',
  light_glow:  '../assets/light_glow.png',
  player_lamp: '../assets/player_lamp.png',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- 決定的擬似乱数 (mulberry32) ------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return ((Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)) >>> 0;
}

// ---- オクルーダ(柱) 決定的生成 + 外周壁 ------------------------------------
function generateOccluders() {
  const rnd = mulberry32(SEED_OCCLUDER);
  const pillars = [];
  const margin = TILE * 1.5;
  const tries = OCCLUDER_COUNT * 12;
  for (let t = 0; t < tries && pillars.length < OCCLUDER_COUNT; t++) {
    const w = TILE * (1 + Math.floor(rnd() * 2));
    const h = TILE * (1 + Math.floor(rnd() * 2));
    const x = Math.round(margin + rnd() * (ROOM_W - margin * 2 - w));
    const y = Math.round(margin + rnd() * (ROOM_H - margin * 2 - h));
    if (Math.abs((x + w / 2) - ROOM_W / 2) < 60 && Math.abs((y + h / 2) - ROOM_H / 2) < 60) continue;
    let ok = true;
    for (const o of pillars) {
      if (x < o.x + o.w + 20 && x + w + 20 > o.x && y < o.y + o.h + 20 && y + h + 20 > o.y) { ok = false; break; }
    }
    if (ok) pillars.push({ x, y, w, h });
  }
  return pillars;
}
function makeWallOccluders() {
  const T = TILE;
  return [
    { x: -T, y: -T, w: ROOM_W + 2 * T, h: T, wall: true },
    { x: -T, y: ROOM_H, w: ROOM_W + 2 * T, h: T, wall: true },
    { x: -T, y: -T, w: T, h: ROOM_H + 2 * T, wall: true },
    { x: ROOM_W, y: -T, w: T, h: ROOM_H + 2 * T, wall: true },
  ];
}

// ---- フォールバックテクスチャ (2D canvas → CanvasTexture) ------------------
const fbCache = {};
function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  fbCache[name] = t;
  return t;
}
function fbFloor() {
  return canvasTexture('floor', 64, 64, (g) => {
    g.fillStyle = '#161a22'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#12151c'; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
    g.strokeStyle = 'rgba(12,14,20,0.8)'; g.strokeRect(0.5, 0.5, 63, 63);
  });
}
function fbPillar() {
  return canvasTexture('pillar', 64, 64, (g) => {
    g.fillStyle = '#4a5160'; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#6b7388'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 61, 61);
  });
}
function fbPlayer() {
  return canvasTexture('player', P_DRAW_W * 2, P_DRAW_H * 2, (g) => {
    g.scale(2, 2);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(12, 33, 9, 4, 0, 0, 7); g.fill();
    g.fillStyle = '#f4ead0';
    g.beginPath(); g.roundRect ? g.roundRect(7, 12, 10, 18, 3) : g.rect(7, 12, 10, 18); g.fill();
    g.beginPath(); g.arc(12, 8, 5, 0, 7); g.fill();
    g.fillStyle = '#ffe6a0'; g.beginPath(); g.arc(19, 18, 3, 0, 7); g.fill();
  });
}
function fbGlow() {
  if (fbCache.glow) return fbCache.glow;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const cc = size / 2;
  const grad = ctx.createRadialGradient(cc, cc, 0, cc, cc, cc);
  const stops = 16;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops, u = 1 - t;
    const a = u * u * (3 - 2 * u);
    grad.addColorStop(t, `rgba(255,255,255,${a.toFixed(4)})`);
  }
  ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  fbCache.glow = tex;
  return tex;
}

AFRAME.registerComponent('lighting-game', {
  init() {
    const sceneEl = this.el.sceneEl;
    this.group = this.el.object3D;
    this.hudEl = document.getElementById('hud');

    // 2D 用 OrthographicCamera (tick で sceneEl.camera を維持)
    this.cam = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
    this.cam.position.z = 10;
    const applyCam = () => {
      sceneEl.camera = this.cam;
      if (sceneEl.renderer) sceneEl.renderer.setPixelRatio(1);
    };
    if (sceneEl.hasLoaded) applyCam(); else sceneEl.addEventListener('loaded', applyCam);

    this.tex = {};
    this.ready = false;
    this.shadowsOn = true;
    this.dynLights = [];
    this.lightTarget = 0;
    this.player = { x: ROOM_W / 2, y: ROOM_H / 2 };
    this.fpsSamples = []; this.hudTimer = 0;
    this.allLights = [];

    // 入力
    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { this.setLightCount(this.lightTarget + LIGHT_STEP); e.preventDefault(); }
      else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { this.setLightCount(this.lightTarget - LIGHT_STEP); e.preventDefault(); }
      else if (e.code === 'KeyL') { this.shadowsOn = !this.shadowsOn; }
      else if (e.code === 'KeyR') { this.resetAll(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // アセット読込 → ワールド構築
    const loader = new THREE.TextureLoader();
    Promise.all(Object.entries(ASSET_DEFS).map(([key, url]) => new Promise((res) => {
      loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; this.tex[key] = t; res(); },
        undefined, () => { this.tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); res(); });
    }))).then(() => this.build());
  },

  down(...c) { return c.some((k) => this.keys[k]); },

  setLightCount(n) {
    n = clamp(n, LIGHT_MIN, LIGHT_MAX);
    while (this.dynLights.length < n) this.dynLights.push(this.makeDynLight(this.dynLights.length));
    while (this.dynLights.length > n) this.dynLights.pop();
    this.lightTarget = n;
  },
  makeDynLight(i) {
    const rnd = mulberry32((SEED_LIGHTS ^ (i * 0x9E3779B1)) >>> 0);
    const ang = rnd() * Math.PI * 2;
    return {
      x: TILE * 2 + rnd() * (ROOM_W - TILE * 4),
      y: TILE * 2 + rnd() * (ROOM_H - TILE * 4),
      vx: Math.cos(ang) * DYN_SPEED, vy: Math.sin(ang) * DYN_SPEED,
      color: hsv2rgb(rnd(), 0.78, 1.0),
    };
  },
  resetAll() {
    this.player.x = ROOM_W / 2; this.player.y = ROOM_H / 2;
    this.dynLights.length = 0; this.setLightCount(LIGHT_INIT);
    this.shadowsOn = true;
  },

  hitsOccluder(cx, cy) {
    const left = cx - P_HALF, right = cx + P_HALF, top = cy - P_HALF, bot = cy + P_HALF;
    for (const o of this.pillars) {
      if (left < o.x + o.w && right > o.x && top < o.y + o.h && bot > o.y) return true;
    }
    return false;
  },

  build() {
    this.pillars = generateOccluders();
    this.walls = makeWallOccluders();
    this.occluders = [...this.pillars, ...this.walls];

    // --- メインシーン(= group の子。A-Frame が自動描画) ---
    // 床
    const floorTex = this.tex.tile_floor || fbFloor();
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(ROOM_W / TILE, ROOM_H / TILE);
    floorTex.magFilter = THREE.NearestFilter;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H),
      new THREE.MeshBasicMaterial({ map: floorTex, depthTest: false }));
    floor.position.set(ROOM_W / 2, H - ROOM_H / 2, 0);
    floor.renderOrder = 0; this.group.add(floor);

    // 柱
    const pillarTex = this.tex.pillar || fbPillar();
    for (const o of this.pillars) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(o.w, o.h),
        new THREE.MeshBasicMaterial({ map: pillarTex, depthTest: false }));
      m.position.set(o.x + o.w / 2, H - (o.y + o.h / 2), 0);
      m.renderOrder = 1; this.group.add(m);
    }

    // プレイヤー
    this.playerSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.player_lamp || fbPlayer(), transparent: true, depthTest: false }));
    this.playerSprite.scale.set(P_DRAW_W, P_DRAW_H, 1);
    this.playerSprite.renderOrder = 2; this.group.add(this.playerSprite);

    // --- ライトマップ用 RenderTarget / オフスクリーンシーン ---
    const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.lightRT = new THREE.WebGLRenderTarget(W, H, rtOpts);
    this.scratchRT = new THREE.WebGLRenderTarget(W, H, rtOpts);
    this.lightScene = new THREE.Scene();    // 影 OFF: 全グロー
    this.oneLightScene = new THREE.Scene(); // 影 ON : 1光源
    this.compositeScene = new THREE.Scene();// scratchRT → lightRT 加算
    this.ambGray = new THREE.Color(AMBIENT, AMBIENT, AMBIENT);

    this.glowTex = this.tex.light_glow || fbGlow();
    this.glowPool = [];
    this.oneGlow = this.makeGlowSprite();
    this.oneGlow.renderOrder = 0;
    this.oneLightScene.add(this.oneGlow);

    // 影メッシュ(動的 BufferGeometry)
    const MAX_SHADOW_TRIS = (OCCLUDER_COUNT + 4) * 4 * 2;
    this.shadowPos = new Float32Array(MAX_SHADOW_TRIS * 3 * 3);
    this.shadowGeo = new THREE.BufferGeometry();
    this.shadowGeo.setAttribute('position', new THREE.BufferAttribute(this.shadowPos, 3));
    this.shadowGeo.setDrawRange(0, 0);
    this.shadowMesh = new THREE.Mesh(this.shadowGeo, new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false }));
    this.shadowMesh.renderOrder = 1;
    this.oneLightScene.add(this.shadowMesh);

    // compositeScene: scratchRT を加算 quad で lightRT へ
    const compMat = new THREE.MeshBasicMaterial({ map: this.scratchRT.texture, transparent: true, depthTest: false, blending: THREE.AdditiveBlending });
    const compQuad = new THREE.Mesh(new THREE.PlaneGeometry(W, H), compMat);
    compQuad.position.set(W / 2, H / 2, 0);
    this.compositeScene.add(compQuad);

    // overlay: lightRT を乗算 quad にして group へ常駐(A-Frame 本描画で最後に重ねる)
    const overlayMat = new THREE.MeshBasicMaterial({ map: this.lightRT.texture, transparent: true, depthTest: false, blending: THREE.MultiplyBlending });
    this.overlayQuad = new THREE.Mesh(new THREE.PlaneGeometry(W, H), overlayMat);
    this.overlayQuad.position.set(W / 2, H - H / 2, 0);
    this.overlayQuad.renderOrder = 999;
    this.group.add(this.overlayQuad);

    this.setLightCount(LIGHT_INIT);
    this.ready = true;
  },

  makeGlowSprite() {
    const m = new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthTest: false, blending: THREE.AdditiveBlending });
    return new THREE.Sprite(m);
  },
  placeGlow(spr, sx, sy, r, color) {
    spr.position.set(sx, H - sy, 0);
    spr.scale.set(r * 2, r * 2, 1);
    spr.material.color.setHex(color);
  },

  buildShadowGeometry(sx, sy) {
    const lx = sx, ly = H - sy;
    const pos = this.shadowPos;
    let vi = 0;
    const tri = (ax, ay, bx, by, cx, cy) => {
      pos[vi++] = ax; pos[vi++] = ay; pos[vi++] = 0;
      pos[vi++] = bx; pos[vi++] = by; pos[vi++] = 0;
      pos[vi++] = cx; pos[vi++] = cy; pos[vi++] = 0;
    };
    for (const o of this.occluders) {
      if (sx >= o.x && sx <= o.x + o.w && sy >= o.y && sy <= o.y + o.h) continue;
      const X0 = o.x, X1 = o.x + o.w;
      const Y0 = H - o.y, Y1 = H - (o.y + o.h);
      const c = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];
      const edges = [
        { a: 0, b: 1, nx: 0, ny: 1 },
        { a: 1, b: 2, nx: 1, ny: 0 },
        { a: 2, b: 3, nx: 0, ny: -1 },
        { a: 3, b: 0, nx: -1, ny: 0 },
      ];
      for (const e of edges) {
        const ax = c[e.a][0], ay = c[e.a][1];
        const bx = c[e.b][0], by = c[e.b][1];
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if ((mx - lx) * e.nx + (my - ly) * e.ny <= 0) continue;
        const dxa = ax - lx, dya = ay - ly, la = Math.hypot(dxa, dya) || 1;
        const dxb = bx - lx, dyb = by - ly, lb = Math.hypot(dxb, dyb) || 1;
        const pax = ax + (dxa / la) * SHADOW_PROJECT, pay = ay + (dya / la) * SHADOW_PROJECT;
        const pbx = bx + (dxb / lb) * SHADOW_PROJECT, pby = by + (dyb / lb) * SHADOW_PROJECT;
        tri(ax, ay, bx, by, pbx, pby);
        tri(ax, ay, pbx, pby, pax, pay);
      }
    }
    this.shadowGeo.setDrawRange(0, vi / 3);
    this.shadowGeo.attributes.position.needsUpdate = true;
    this.shadowGeo.computeBoundingSphere();
  },

  buildLightmap(renderer) {
    const all = this.allLights;
    all.length = 0;
    all.push({ x: this.player.x, y: this.player.y, r: PLAYER_LIGHT_R, color: 0xfff2d8 });
    for (const L of this.dynLights) all.push({ x: L.x, y: L.y, r: DYN_LIGHT_R, color: L.color });

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1) lightRT を ambient で塗る
    renderer.setRenderTarget(this.lightRT);
    renderer.setClearColor(this.ambGray, 1);
    renderer.clear(true, false, false);

    if (!this.shadowsOn) {
      // 影 OFF: 全グローを一括加算
      while (this.glowPool.length < all.length) this.glowPool.push(this.makeGlowSprite());
      for (const s of this.glowPool) if (s.parent) this.lightScene.remove(s);
      for (let i = 0; i < all.length; i++) {
        const L = all[i], s = this.glowPool[i];
        this.placeGlow(s, L.x, L.y, L.r, L.color);
        this.lightScene.add(s);
      }
      renderer.setRenderTarget(this.lightRT);
      renderer.render(this.lightScene, this.cam);
    } else {
      // 影 ON: 光源ごとに scratchRT 往復
      for (const L of all) {
        this.placeGlow(this.oneGlow, L.x, L.y, L.r, L.color);
        this.buildShadowGeometry(L.x, L.y);
        renderer.setRenderTarget(this.scratchRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
        renderer.render(this.oneLightScene, this.cam);
        renderer.setRenderTarget(this.lightRT);
        renderer.render(this.compositeScene, this.cam);
      }
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  },

  tick(time, dtMs) {
    if (!this.ready) return;
    const sceneEl = this.el.sceneEl;
    if (sceneEl.camera !== this.cam) sceneEl.camera = this.cam;

    dtMs = Math.min(dtMs || 16.7, 50);
    const dt = dtMs / 1000;
    const inst = 1000 / Math.max(dtMs, 0.0001);
    this.fpsSamples.push(inst); if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    const fpsAvg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;

    // プレイヤー移動 (220px/s, AABB・軸分離)
    const p = this.player;
    let mx = 0, my = 0;
    if (this.down('ArrowLeft', 'KeyA')) mx -= 1;
    if (this.down('ArrowRight', 'KeyD')) mx += 1;
    if (this.down('ArrowUp', 'KeyW')) my -= 1;
    if (this.down('ArrowDown', 'KeyS')) my += 1;
    if (mx && my) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
    let nx = p.x + mx * PLAYER_SPEED * dt;
    if (!this.hitsOccluder(nx, p.y)) p.x = nx;
    let ny = p.y + my * PLAYER_SPEED * dt;
    if (!this.hitsOccluder(p.x, ny)) p.y = ny;
    p.x = clamp(p.x, TILE + P_HALF, ROOM_W - TILE - P_HALF);
    p.y = clamp(p.y, TILE + P_HALF, ROOM_H - TILE - P_HALF);
    this.playerSprite.position.set(p.x, H - p.y, 0);

    // 動的光源更新 (決定的軌道: 壁でバウンド・柱は通り抜け)
    for (const L of this.dynLights) {
      L.x += L.vx * dt; L.y += L.vy * dt;
      if (L.x < TILE) { L.x = TILE; L.vx = Math.abs(L.vx); }
      else if (L.x > ROOM_W - TILE) { L.x = ROOM_W - TILE; L.vx = -Math.abs(L.vx); }
      if (L.y < TILE) { L.y = TILE; L.vy = Math.abs(L.vy); }
      else if (L.y > ROOM_H - TILE) { L.y = ROOM_H - TILE; L.vy = -Math.abs(L.vy); }
    }

    // ライトマップ生成 (A-Frame 本描画の前にオフスクリーンへ)。overlayQuad は group 常駐で
    // この後 A-Frame が床＋柱＋プレイヤーの上に乗算合成する。
    if (sceneEl.renderer) this.buildLightmap(sceneEl.renderer);

    this.hudTimer += dtMs;
    if (this.hudTimer >= 120) {
      this.hudTimer = 0;
      this.hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Lights    : ${this.dynLights.length} / ${LIGHT_MAX}  (+player 1)\n` +
        `Occluders : ${this.pillars.length}  (+外周壁4)\n` +
        `Shadows   : ${this.shadowsOn ? 'ON' : 'OFF'}\n` +
        `Mode      : Lightmap(RenderTarget add → Multiply quad)\n` +
        `Ambient   : ${AMBIENT.toFixed(2)}`;
    }
  },
});

console.log('A-Frame theme11 lighting component registered.');
