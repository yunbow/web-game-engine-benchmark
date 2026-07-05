/* =========================================================================
 * テーマ8 パーティクル / 魔法エフェクトデモ ― three.js (r184) 実装
 * 仕様: SPEC.md (960x540 / 加算合成 / 周回オーブ / 爆発バースト / プール再利用)
 *
 * 使用機構: **THREE.Points + BufferGeometry（GPU 寄り）**。
 *   - 全パーティクルを 1 個の Points（単一 draw call）として描画する。位置/色/サイズ/
 *     不透明度を **TypedArray (BufferGeometry の attribute)** に詰め、毎フレーム
 *     CPU で書き換えて `needsUpdate = true` で GPU へアップロードする。描画自体は
 *     GPU が点スプライトをまとめて処理するため、Sprite を 1 個ずつ描く方式や
 *     CPU(KAPLAY) 方式よりはるかにスケールし、50000 個でも 1 draw call。
 *   - 加算合成: PointsMaterial.blending = THREE.AdditiveBlending（重なるほど明るく）。
 *     B キーで NormalBlending に切替。発光グローのテクスチャを map に使う。
 *   - 色は vertexColors（per-vertex color attribute）で暖色→寒色を表現。サイズは
 *     attribute 'aSize' を ShaderMaterial 風に……ではなく、PointsMaterial の制約上
 *     点ごとのサイズは持てないため、**寿命で alpha と色を変え、size は per-particle に
 *     onBeforeCompile でシェーダ注入**して大→小を実現する（GPU 側で gl_PointSize 可変）。
 *   - 物理更新（位置/速度/寿命）は CPU の TypedArray ループ。これが「GPU 描画 +
 *     CPU 更新」の比較サンプル。Points 描画なので CPU エンジンより上限が伸びる。
 *
 * three.js を 2D 化する足場: OrthographicCamera(0,W,H,0,-1000,1000)（1単位=1px・
 * 原点左下・Y上向き）。ゲーム座標は画面座標(Y下)で保持し worldY = H - gameY 変換。
 * ループ/入力/プール/決定的乱数/オーブ軌道は自前。
 * =========================================================================*/

import * as THREE from 'three';

// ---- 定数 (SPEC) — 全エンジン共通値 ---------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = 0x08080f;

const LIFE_MIN = 0.6, LIFE_MAX = 1.4;
const GRAVITY = 90;
const DRAG = 0.86;
const SIZE_BIG = 1.4, SIZE_SMALL = 0.15;
const SPRITE_BASE = 32;           // 点スプライトの基準px（gl_PointSize ベース）

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
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
function lerpColor(t) {
  return {
    r: clamp(lerp(WARM.r, COOL.r, t), 0, 1),
    g: clamp(lerp(WARM.g, COOL.g, t), 0, 1),
    b: clamp(lerp(WARM.b, COOL.b, t), 0, 1),
  };
}

// ---- フォールバックグローテクスチャ（中心白→外周透明） ----
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

// === シーン / カメラ / レンダラ ============================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
// left=0,right=W,top=H,bottom=0 → x:0..W / y:0..H（Y上向き）
const camera = new THREE.OrthographicCamera(0, VIEW_W, VIEW_H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);          // 性能比較のため DPR=1 固定
renderer.setSize(VIEW_W, VIEW_H);
document.getElementById('game-container').appendChild(renderer.domElement);

const loader = new THREE.TextureLoader();
const tex = {};

(async function main() {
  const defs = {
    spark: '../assets/particle_spark.png',
    orb:   '../assets/orb.png',
    bg:    '../assets/bg_dark.png',
  };
  await Promise.all(Object.entries(defs).map(async ([key, url]) => {
    try { const t = await loader.loadAsync(url); t.colorSpace = THREE.SRGBColorSpace; tex[key] = t; }
    catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> glow fallback`); }
  }));
  if (!tex.spark) tex.spark = makeGlowTexture(32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  if (!tex.orb)   tex.orb   = makeGlowTexture(64, 'rgba(255,255,255,1)', 'rgba(180,200,255,0)');
  start();
})();

function start() {
  // ---- 背景: 暗色 + 微弱な星（Points, 加算なし） ----
  if (tex.bg) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(VIEW_W, VIEW_H),
      new THREE.MeshBasicMaterial({ map: tex.bg, depthTest: false }));
    m.position.set(VIEW_W / 2, VIEW_H / 2, -50); m.renderOrder = -2;
    scene.add(m);
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
  stars.renderOrder = -1;
  scene.add(stars);

  // ====================================================================
  // パーティクル: 単一 THREE.Points（GPU 寄り）
  // ====================================================================
  // attribute:
  //   position(vec3) : 画面→ワールド変換済み座標（worldY=H-y, z=0）
  //   color(vec3)    : 暖色→寒色 + alpha 焼き込み（加算なので alpha は色の明るさに乗算）
  //   aSize(float)   : per-particle の点サイズ（px）。onBeforeCompile で gl_PointSize に注入。
  // 全 attribute を POOL_CAP 分確保し、live でない点は size=0（描画されない）にする。
  const posArr = new Float32Array(POOL_CAP * 3);
  const colArr = new Float32Array(POOL_CAP * 3);
  const sizeArr = new Float32Array(POOL_CAP);     // 0 = 非表示
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(posArr, 3);
  const colAttr = new THREE.BufferAttribute(colArr, 3);
  const sizeAttr = new THREE.BufferAttribute(sizeArr, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  geo.setAttribute('aSize', sizeAttr);
  geo.setDrawRange(0, 0);

  const mat = new THREE.PointsMaterial({
    map: tex.spark,
    size: SPRITE_BASE,            // ベースサイズ（aSize で per-particle に上書き）
    sizeAttenuation: false,      // ortho 2D なので距離減衰なし
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending,   // 加算合成（重なるほど明るく）
  });
  // PointsMaterial は per-particle サイズを持たないので、シェーダに aSize を注入して
  // gl_PointSize を可変にする（GPU 側でサイズ計算 = 大→小を GPU で）。
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float aSize;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      'gl_PointSize = size;',
      'gl_PointSize = aSize;'
    );
  };
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;   // 画面全体に散る + setDrawRange 管理なので無効化
  scene.add(points);

  // オーブ本体（数が少ないので Sprite で加算描画）
  const orbSprites = [];
  function makeOrbSprite() {
    const m = new THREE.SpriteMaterial({ map: tex.orb, transparent: true, depthTest: false,
      depthWrite: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(m);
    s.scale.set(ORB_RADIUS * 2.6, ORB_RADIUS * 2.6, 1);
    s.renderOrder = 5;
    scene.add(s);
    return s;
  }

  // ---- パーティクル状態（SoA: 物理用 TypedArray） ----
  const px = new Float32Array(POOL_CAP);   // 画面座標 x
  const py = new Float32Array(POOL_CAP);   // 画面座標 y（Y下）
  const vx = new Float32Array(POOL_CAP);
  const vy = new Float32Array(POOL_CAP);
  const life = new Float32Array(POOL_CAP);
  const maxLife = new Float32Array(POOL_CAP);
  const big = new Float32Array(POOL_CAP);
  const live = new Uint8Array(POOL_CAP);
  const free = [];
  for (let i = POOL_CAP - 1; i >= 0; i--) free.push(i);
  let liveCount = 0;
  let maxIndex = 0;     // 使用された最大 index + 1（drawRange 用）

  // ---- 状態 ----
  let rnd = mulberry32(20250615);
  let targetCap = TARGET_INIT;
  let blendAdd = true;
  let autoFire = false;
  let autoAcc = 0, autoSeq = 0;
  let elapsed = 0;
  const bursts = [];

  let mouseX = VIEW_W / 2, mouseY = VIEW_H / 2;
  let mouseInside = false;
  let mousePrevX = mouseX, mousePrevY = mouseY;
  let trailAcc = 0;

  const autoRnd = mulberry32(13579);
  const autoSpots = [];
  for (let i = 0; i < 32; i++) {
    autoSpots.push({ x: 80 + autoRnd() * (VIEW_W - 160), y: 70 + autoRnd() * (VIEW_H - 200) });
  }

  function emit(x, y, ivx, ivy, lifeScale = 1, bigScale = 1) {
    if (liveCount >= targetCap) return false;
    const idx = free.pop();
    if (idx === undefined) return false;
    live[idx] = 1;
    px[idx] = x; py[idx] = y;
    vx[idx] = ivx; vy[idx] = ivy;
    maxLife[idx] = (LIFE_MIN + rnd() * (LIFE_MAX - LIFE_MIN)) * lifeScale;
    life[idx] = maxLife[idx];
    big[idx] = SIZE_BIG * bigScale;
    if (idx + 1 > maxIndex) maxIndex = idx + 1;
    liveCount++;
    return true;
  }
  function burst(x, y, count) {
    for (let i = 0; i < count; i++) {
      const ang = rnd() * Math.PI * 2;
      const spd = 80 + rnd() * 320;
      if (!emit(x, y, Math.cos(ang) * spd, Math.sin(ang) * spd, 1.0, 1.1)) break;
    }
    bursts.push({ x, y, t: BURST_LIFETIME });
  }

  // ---- 周回オーブ（決定的軌道） ----
  const orbs = [];
  function buildOrbs() {
    for (const s of orbSprites) { scene.remove(s); s.material.dispose(); }
    orbSprites.length = 0;
    orbs.length = 0;
    const orbRnd = mulberry32(987654321);
    for (let i = 0; i < ORB_COUNT; i++) {
      const c = lerpColor(i / Math.max(1, ORB_COUNT - 1));
      const sprite = makeOrbSprite();
      sprite.material.color.setRGB(c.r, c.g, c.b);
      orbSprites.push(sprite);
      orbs.push({
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
  }
  buildOrbs();

  function resetAll() {
    for (let i = 0; i < maxIndex; i++) {
      if (live[i]) { live[i] = 0; sizeArr[i] = 0; free.push(i); }
    }
    liveCount = 0; maxIndex = 0;
    bursts.length = 0;
    targetCap = TARGET_INIT;
    autoFire = false; autoAcc = 0; autoSeq = 0; elapsed = 0;
    rnd = mulberry32(20250615);
    buildOrbs();
  }

  // ---- 入力 ----
  function localPoint(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const sx = VIEW_W / rect.width, sy = VIEW_H / rect.height;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }
  renderer.domElement.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const p = localPoint(ev);
    const count = BURST_MIN + Math.floor(rnd() * (BURST_MAX - BURST_MIN + 1));
    burst(p.x, p.y, count);
  });
  renderer.domElement.addEventListener('mousemove', (ev) => {
    const p = localPoint(ev); mouseX = p.x; mouseY = p.y; mouseInside = true;
  });
  renderer.domElement.addEventListener('mouseleave', () => { mouseInside = false; });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { autoFire = !autoFire; autoAcc = 0; e.preventDefault(); }
    else if (e.code === 'KeyB') {
      blendAdd = !blendAdd;
      mat.blending = blendAdd ? THREE.AdditiveBlending : THREE.NormalBlending;
      mat.needsUpdate = true;
      for (const s of orbSprites) { s.material.blending = blendAdd ? THREE.AdditiveBlending : THREE.NormalBlending; s.material.needsUpdate = true; }
    }
    else if (e.code === 'KeyR') { resetAll(); }
    else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      targetCap = clamp(targetCap + TARGET_STEP, TARGET_MIN, TARGET_MAX); e.preventDefault();
    }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      targetCap = clamp(targetCap - TARGET_STEP, TARGET_MIN, TARGET_MAX); e.preventDefault();
    }
  });

  // ---- HUD / ループ ----
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = [];
  let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const dtMs = dt * 1000;
    elapsed += dt;

    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    const headroom = clamp((targetCap - liveCount) / targetCap, 0, 1);
    const orbEmitRate = ORB_EMIT_BASE * (0.4 + targetCap / TARGET_INIT * 0.6) * (0.3 + headroom);

    // 1) 周回オーブ + 連続噴出
    for (let i = 0; i < orbs.length; i++) {
      const o = orbs[i];
      o.px = o.x; o.py = o.y;
      o.x = o.cx + Math.sin(elapsed * o.wx + o.phx) * o.ax;
      o.y = o.cy + Math.sin(elapsed * o.wy + o.phy) * o.ay;
      o.sprite.position.set(o.x, VIEW_H - o.y, 1);
      o.sprite.material.opacity = 0.7 + 0.3 * Math.sin(elapsed * 3 + i);

      o.emitAcc += orbEmitRate * dt;
      let n = Math.floor(o.emitAcc); o.emitAcc -= n;
      const vmx = (o.x - o.px) / Math.max(dt, 1e-4);
      const vmy = (o.y - o.py) / Math.max(dt, 1e-4);
      while (n-- > 0) {
        const ang = rnd() * Math.PI * 2;
        const spd = 20 + rnd() * 70;
        if (!emit(o.x, o.y, Math.cos(ang) * spd - vmx * 0.25, Math.sin(ang) * spd - vmy * 0.25, 0.9, 0.8)) break;
      }
    }

    // 2) マウストレイル
    if (mouseInside) {
      const dx = mouseX - mousePrevX, dy = mouseY - mousePrevY;
      const moved = Math.hypot(dx, dy);
      if (moved > 0.5) {
        trailAcc += TRAIL_RATE * (0.3 + headroom) * dt + Math.min(moved * 0.6, 12);
        let n = Math.floor(trailAcc); trailAcc -= n;
        const inv = 1 / Math.max(moved, 1e-4);
        const dirx = dx * inv, diry = dy * inv;
        while (n-- > 0) {
          const along = -(20 + rnd() * 80);
          const side = (rnd() - 0.5) * 80;
          if (!emit(mouseX, mouseY, dirx * along - diry * side, diry * along + dirx * side, 0.8, 0.7)) break;
        }
      }
    }
    mousePrevX = mouseX; mousePrevY = mouseY;

    // 3) オート花火
    if (autoFire) {
      autoAcc += dt;
      while (autoAcc >= AUTO_INTERVAL) {
        autoAcc -= AUTO_INTERVAL;
        const spot = autoSpots[autoSeq % autoSpots.length]; autoSeq++;
        const count = BURST_MIN + Math.floor(rnd() * (BURST_MAX - BURST_MIN + 1));
        burst(spot.x, spot.y, count);
      }
    }

    // 4) パーティクル CPU 更新 → attribute へ書き込み
    const dragF = Math.pow(DRAG, dt);
    let newMax = 0;
    for (let i = 0; i < maxIndex; i++) {
      if (!live[i]) { sizeArr[i] = 0; continue; }
      let l = life[i] - dt;
      if (l <= 0) {
        live[i] = 0; sizeArr[i] = 0; free.push(i); liveCount--;
        continue;
      }
      life[i] = l;
      vy[i] += GRAVITY * dt;
      vx[i] *= dragF; vy[i] *= dragF;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;

      const t = 1 - l / maxLife[i];           // 0(生成)→1(消滅)
      const j3 = i * 3;
      posArr[j3] = px[i];
      posArr[j3 + 1] = VIEW_H - py[i];         // worldY = H - gameY
      posArr[j3 + 2] = 0;
      const a = 1 - t * t;                     // alpha 1→0（加算なので色の明るさへ乗算）
      const c = lerpColor(t);
      colArr[j3] = c.r * a;
      colArr[j3 + 1] = c.g * a;
      colArr[j3 + 2] = c.b * a;
      sizeArr[i] = SPRITE_BASE * lerp(big[i], SIZE_SMALL, t);  // 大→小（GPU の gl_PointSize）
      if (i + 1 > newMax) newMax = i + 1;
    }
    maxIndex = newMax;
    geo.setDrawRange(0, maxIndex);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;

    // 5) バースト残光
    for (let i = bursts.length - 1; i >= 0; i--) {
      bursts[i].t -= dt;
      if (bursts[i].t <= 0) { bursts[i] = bursts[bursts.length - 1]; bursts.pop(); }
    }

    // 6) HUD
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const emitters = ORB_COUNT + bursts.length + (mouseInside ? 1 : 0);
      hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Particles : ${liveCount}  (live)\n` +
        `Target    : ${targetCap}   (+/- で ±${TARGET_STEP}, ${TARGET_MIN}..${TARGET_MAX})\n` +
        `Emitters  : ${emitters}   (orb ${ORB_COUNT} + burst ${bursts.length}${mouseInside ? ' + trail 1' : ''})\n` +
        `Blend     : ${blendAdd ? 'ADD' : 'NORMAL'}   (B で切替)\n` +
        `Mode      : GPU (THREE.Points / 1 draw call)\n` +
        `[click=爆発 / Space=オート(${autoFire ? 'ON' : 'OFF'}) / B / +/- / R]`;
    }

    renderer.render(scene, camera);
  });

  console.log('[three.js r184] theme8 particles init ok. mode = GPU Points / renderer =', renderer.constructor.name);
}
