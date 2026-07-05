/* ============================================================================
 * テーマ11 2Dダイナミックライティング / 影（ライトマップ × 多光源 × 影）― three.js (r184)
 * 共通仕様 11/SPEC.md に厳密準拠。性能比較用。定数は KAPLAY / PixiJS 版と同一。
 *
 *   960x540 / 30x17 タイル(32px) の暗い床 / 約16個の矩形オクルーダ(柱)＋外周壁。
 *   ambient=0.10 を下地に、全光源を「加算」でライトバッファへ積み、
 *   完成したライトバッファを描画済みシーン(床＋柱)へ「乗算」で重ねる。
 *   各光源はオクルーダ背後を「影ポリゴン(黒)」で削ってから加算する(ハードシャドウ)。
 *
 * --- three.js でのライトマップ実装の核(エンジン自然な機構) -------------------
 *   three.js は 3D 描画ライブラリ。2D 化は OrthographicCamera(0,W,H,0,-1000,1000)
 *   (1ワールド単位=1px・原点左下・Y上向き) で行い、ロジックは画面座標(Y下)保持→
 *   描画同期時のみ worldY = H - gameY に変換する。
 *
 *   ライトマップはオフスクリーンの ★WebGLRenderTarget★ へ加算合成で積む:
 *     - lightScene  : 光源グロー(AdditiveBlending の Sprite)を集めた専用シーン。
 *                     ambient の下地メッシュを最背面に置く。
 *     - shadowScene : 影 ON 時、1光源ごとに「グロー1枚 ＋ 影ポリゴン(黒メッシュ)」を
 *                     scratchRT(別 RenderTarget)へ描き、それを lightRT へ加算する。
 *     1) lightRT を ambient で塗る (背景クリアカラー = ambient グレー)。
 *     2) 影 OFF: 全グロー Sprite を AdditiveBlending で lightRT へ直接描画(往復なし)。
 *        影 ON : 光源ごとに scratchRT へ「グロー → 黒影ポリゴン」を描き、その結果を
 *                fullscreen quad(MultiplyやAddの板) 経由で lightRT へ加算(バッファ往復)。
 *     3) lightRT のテクスチャを ★MultiplyBlending の全画面 quad★ にしてメインシーンへ
 *        重ねる(= 乗算合成段)。照らされた所だけ見え、影/未照は暗く沈む。
 *   → 「加算で積む」も「乗算で合成」も three.js の Blending(Additive/Multiply)で表現。
 * ========================================================================== */

import * as THREE from 'three';

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;
const TILE = 32;
const MAP_W = 30, MAP_H = 17;            // 30x17 タイル = 960x544
const ROOM_W = MAP_W * TILE;             // 960
const ROOM_H = MAP_H * TILE;             // 544

const AMBIENT = 0.10;                    // 下地の明るさ
const PLAYER_LIGHT_R = 240;              // プレイヤー光源 半径
const DYN_LIGHT_R = 160;                 // 動的光源 半径
const PLAYER_SPEED = 220;                // px/s
const P_HALF = 11;                       // プレイヤー当たり半サイズ(22px角)
const P_DRAW_W = 24, P_DRAW_H = 36;      // プレイヤー描画サイズ

const LIGHT_INIT = 12, LIGHT_STEP = 6, LIGHT_MIN = 0, LIGHT_MAX = 120;
const DYN_SPEED = 120;                   // px/s 相当の決定的軌道

const OCCLUDER_COUNT = 16;
const SHADOW_PROJECT = 2000;             // 影ポリゴンを光源から遠方へ延ばす距離
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
// HSV(0..1) -> 0xRRGGBB
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
    const w = TILE * (1 + Math.floor(rnd() * 2));   // 32 or 64
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
// 放射グロー: 中心白(不透明)→外周透明。加算前提なので白(色は Sprite の tint=color で付ける)。
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
    const a = u * u * (3 - 2 * u); // smoothstep(1-t)
    grad.addColorStop(t, `rgba(255,255,255,${a.toFixed(4)})`);
  }
  ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  fbCache.glow = tex;
  return tex;
}

// === レンダラ / メインシーン / カメラ ========================================
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);               // 性能比較のため DPR=1 固定
renderer.setSize(W, H);
renderer.autoClear = false;
document.getElementById('game-container').appendChild(renderer.domElement);

// left=0,right=W,top=H,bottom=0 → x:0..W / y:0..H (Y上向き)
const camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
camera.position.z = 10;

// メインシーン(床＋柱＋プレイヤー)。背景は暗い夜。
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070b);

// ライトマップ生成用のオフスクリーンシーン群。
const lightScene = new THREE.Scene();   // 影 OFF: 全グローをまとめて加算
const oneLightScene = new THREE.Scene(); // 影 ON : 1光源ぶん(グロー＋黒影)
const compositeScene = new THREE.Scene(); // scratchRT を lightRT へ加算する全画面 quad

// === テクスチャ読込 (失敗時フォールバック) ===================================
const loader = new THREE.TextureLoader();
const tex = {};

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
  const pillars = generateOccluders();
  const walls = makeWallOccluders();
  const occluders = [...pillars, ...walls];

  // ---- メインシーン: 床 (タイルを並べた1メッシュ群 or タイリング) ----------
  const floorTex = tex.tile_floor || fbFloor();
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(ROOM_W / TILE, ROOM_H / TILE);
  floorTex.magFilter = THREE.NearestFilter;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_H),
    new THREE.MeshBasicMaterial({ map: floorTex, depthTest: false })
  );
  floor.position.set(ROOM_W / 2, H - ROOM_H / 2, 0);
  floor.renderOrder = 0;
  scene.add(floor);

  // ---- メインシーン: 柱(オクルーダの見た目) ----
  const pillarTex = tex.pillar || fbPillar();
  for (const o of pillars) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(o.w, o.h),
      new THREE.MeshBasicMaterial({ map: pillarTex, depthTest: false })
    );
    m.position.set(o.x + o.w / 2, H - (o.y + o.h / 2), 0);
    m.renderOrder = 1;
    scene.add(m);
  }

  // ---- メインシーン: プレイヤー (乗算ライトの下) ----
  const player = { x: ROOM_W / 2, y: ROOM_H / 2 };
  const playerMat = new THREE.SpriteMaterial({ map: tex.player_lamp || fbPlayer(), transparent: true, depthTest: false });
  const playerSprite = new THREE.Sprite(playerMat);
  playerSprite.scale.set(P_DRAW_W, P_DRAW_H, 1);
  playerSprite.renderOrder = 2;
  scene.add(playerSprite);

  // =====================================================================
  // ライトマップ用 RenderTarget
  // =====================================================================
  const rtOpts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  const lightRT = new THREE.WebGLRenderTarget(W, H, rtOpts);
  const scratchRT = new THREE.WebGLRenderTarget(W, H, rtOpts);

  // 放射グロー素材。光源ごとに位置/スケール/色を差し替えて使う Sprite を必要数プール。
  const glowTex = tex.light_glow || fbGlow();
  function makeGlowSprite() {
    const m = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthTest: false, blending: THREE.AdditiveBlending });
    return new THREE.Sprite(m);
  }
  // lightScene 用のグロープール(影 OFF パス。光源数だけ使う)。
  const glowPool = [];
  function getGlow(n) {
    while (glowPool.length < n) glowPool.push(makeGlowSprite());
    return glowPool;
  }

  // 影 ON パス: oneLightScene に「グロー1枚 ＋ 黒影メッシュ」を組む。
  const oneGlow = makeGlowSprite();
  oneLightScene.add(oneGlow);
  // 影ポリゴンは BufferGeometry を毎フレーム書き換える1つの黒メッシュ群で表現する。
  // 簡潔さのため、矩形ごと辺ごとに小さな PlaneGeometry ではなく動的 BufferGeometry を使う。
  const MAX_SHADOW_TRIS = (OCCLUDER_COUNT + 4) * 4 * 2; // 矩形数 × 4辺 × 2三角
  const shadowPos = new Float32Array(MAX_SHADOW_TRIS * 3 * 3);
  const shadowGeo = new THREE.BufferGeometry();
  shadowGeo.setAttribute('position', new THREE.BufferAttribute(shadowPos, 3));
  shadowGeo.setDrawRange(0, 0);
  const shadowMesh = new THREE.Mesh(
    shadowGeo,
    new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false }) // 黒で光を削る(通常合成)
  );
  shadowMesh.renderOrder = 1; // グロー(=0)の上に黒を重ねる
  oneGlow.renderOrder = 0;
  oneLightScene.add(shadowMesh);

  // compositeScene: scratchRT を加算合成で lightRT へ流し込む全画面 quad。
  const compositeMat = new THREE.MeshBasicMaterial({ map: scratchRT.texture, transparent: true, depthTest: false, blending: THREE.AdditiveBlending });
  const compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(W, H), compositeMat);
  compositeQuad.position.set(W / 2, H / 2, 0);
  compositeScene.add(compositeQuad);

  // 最終: lightRT を MultiplyBlending の全画面 quad にしてメインシーンへ重ねる。
  const overlayMat = new THREE.MeshBasicMaterial({ map: lightRT.texture, transparent: true, depthTest: false, blending: THREE.MultiplyBlending });
  const overlayQuad = new THREE.Mesh(new THREE.PlaneGeometry(W, H), overlayMat);
  overlayQuad.position.set(W / 2, H - H / 2, 0);
  overlayQuad.renderOrder = 999;
  scene.add(overlayQuad);

  // ambient 下地: lightRT をクリアする際の背景色(グレー)。
  const ambGray = new THREE.Color(AMBIENT, AMBIENT, AMBIENT);

  // 光源 Sprite を画面座標(光源 sx,sy)へ配置(worldY=H-sy)。スケール=半径×2。
  function placeGlow(spr, sx, sy, r, color) {
    spr.position.set(sx, H - sy, 0);
    spr.scale.set(r * 2, r * 2, 1);
    spr.material.color.setHex(color);
  }

  // =====================================================================
  // 影ポリゴン生成 (光源 sx,sy / 矩形 o → 黒台形2三角を shadowPos へ書く)
  //   光源側を向いていない(外向き法線が光源と逆)辺の端点を遠方へ投影。
  //   座標は ★ワールド座標(Y上)★ で直接書く: worldY = H - gameY。
  // =====================================================================
  function projectW(lx, ly, px, py) {
    const dx = px - lx, dy = py - ly;
    const len = Math.hypot(dx, dy) || 1;
    return [px + (dx / len) * SHADOW_PROJECT, py + (dy / len) * SHADOW_PROJECT];
  }
  function buildShadowGeometry(sx, sy) {
    // ワールド光源座標
    const lx = sx, ly = H - sy;
    let vi = 0; // float index
    const pos = shadowPos;
    function tri(ax, ay, bx, by, cx, cy) {
      pos[vi++] = ax; pos[vi++] = ay; pos[vi++] = 0;
      pos[vi++] = bx; pos[vi++] = by; pos[vi++] = 0;
      pos[vi++] = cx; pos[vi++] = cy; pos[vi++] = 0;
    }
    for (const o of occluders) {
      // 光源が矩形内部(画面座標)なら影なし
      if (sx >= o.x && sx <= o.x + o.w && sy >= o.y && sy <= o.y + o.h) continue;
      // 矩形4隅(ワールド座標)
      const X0 = o.x, X1 = o.x + o.w;
      const Y0 = H - o.y, Y1 = H - (o.y + o.h); // ワールドでは上が大
      // 4隅(時計回り想定。ワールドY上)
      const c = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];
      // 各辺の外向き法線(ワールドY上)。上(Y0)辺の外向きは +Y、下(Y1)辺は -Y。
      const edges = [
        { a: 0, b: 1, nx: 0, ny: 1 },  // 上辺
        { a: 1, b: 2, nx: 1, ny: 0 },  // 右辺
        { a: 2, b: 3, nx: 0, ny: -1 }, // 下辺
        { a: 3, b: 0, nx: -1, ny: 0 }, // 左辺
      ];
      for (const e of edges) {
        const ax = c[e.a][0], ay = c[e.a][1];
        const bx = c[e.b][0], by = c[e.b][1];
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        // 光源→辺中点 と 外向き法線 の内積が正 = 光源は法線の裏 = 影側の辺
        if ((mx - lx) * e.nx + (my - ly) * e.ny <= 0) continue;
        const [pax, pay] = projectW(lx, ly, ax, ay);
        const [pbx, pby] = projectW(lx, ly, bx, by);
        // 台形 a,b,pb,pa を 2三角に
        tri(ax, ay, bx, by, pbx, pby);
        tri(ax, ay, pbx, pby, pax, pay);
      }
    }
    shadowGeo.setDrawRange(0, vi / 3);
    shadowGeo.attributes.position.needsUpdate = true;
    shadowGeo.computeBoundingSphere();
  }

  // =====================================================================
  // 光源データ
  // =====================================================================
  const dynLights = [];
  function makeDynLight(i) {
    const rnd = mulberry32((SEED_LIGHTS ^ (i * 0x9E3779B1)) >>> 0);
    const ang = rnd() * Math.PI * 2;
    return {
      x: TILE * 2 + rnd() * (ROOM_W - TILE * 4),
      y: TILE * 2 + rnd() * (ROOM_H - TILE * 4),
      vx: Math.cos(ang) * DYN_SPEED, vy: Math.sin(ang) * DYN_SPEED,
      color: hsv2rgb(rnd(), 0.78, 1.0),
    };
  }
  let lightTarget = 0;
  function setLightCount(n) {
    n = clamp(n, LIGHT_MIN, LIGHT_MAX);
    while (dynLights.length < n) dynLights.push(makeDynLight(dynLights.length));
    while (dynLights.length > n) dynLights.pop();
    lightTarget = n;
  }
  setLightCount(LIGHT_INIT);

  let shadowsOn = true;
  function resetAll() {
    player.x = ROOM_W / 2; player.y = ROOM_H / 2;
    dynLights.length = 0; setLightCount(LIGHT_INIT);
    shadowsOn = true;
  }

  // ---- 入力 ----
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { setLightCount(lightTarget + LIGHT_STEP); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { setLightCount(lightTarget - LIGHT_STEP); e.preventDefault(); }
    else if (e.code === 'KeyL') { shadowsOn = !shadowsOn; }
    else if (e.code === 'KeyR') { resetAll(); }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  const down = (...c) => c.some((k) => keys[k]);

  // ---- AABB (プレイヤー vs 柱) ----
  function hitsOccluder(cx, cy) {
    const left = cx - P_HALF, right = cx + P_HALF, top = cy - P_HALF, bot = cy + P_HALF;
    for (const o of pillars) {
      if (left < o.x + o.w && right > o.x && top < o.y + o.h && bot > o.y) return true;
    }
    return false;
  }

  // =====================================================================
  // ライトマップ構築 (毎フレーム)
  // =====================================================================
  const allLights = []; // 再利用バッファ
  function buildLightmap() {
    allLights.length = 0;
    allLights.push({ x: player.x, y: player.y, r: PLAYER_LIGHT_R, color: 0xfff2d8 });
    for (const L of dynLights) allLights.push({ x: L.x, y: L.y, r: DYN_LIGHT_R, color: L.color });

    // 1) lightRT を ambient で塗る
    renderer.setRenderTarget(lightRT);
    renderer.setClearColor(ambGray, 1);
    renderer.clear(true, false, false);

    if (!shadowsOn) {
      // --- 影 OFF: 全グローをまとめて加算(バッファ往復なし) ---
      const pool = getGlow(allLights.length);
      // 一旦全部 lightScene から外し、必要分だけ再追加
      for (const s of glowPool) if (s.parent) lightScene.remove(s);
      for (let i = 0; i < allLights.length; i++) {
        const L = allLights[i], s = pool[i];
        placeGlow(s, L.x, L.y, L.r, L.color);
        lightScene.add(s);
      }
      renderer.setRenderTarget(lightRT);
      renderer.render(lightScene, camera); // autoClear=false なので ambient を保持して加算
    } else {
      // --- 影 ON: 光源ごとに scratchRT へ「グロー → 黒影」→ lightRT へ加算 ---
      for (const L of allLights) {
        placeGlow(oneGlow, L.x, L.y, L.r, L.color);
        buildShadowGeometry(L.x, L.y);
        // (a) scratchRT を黒クリア → グロー → 黒影
        renderer.setRenderTarget(scratchRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear(true, false, false);
        renderer.render(oneLightScene, camera);
        // (b) scratchRT を lightRT へ加算合成
        renderer.setRenderTarget(lightRT);
        renderer.render(compositeScene, camera);
      }
    }
    renderer.setRenderTarget(null);
  }

  // ---- HUD / ループ ----
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = []; let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const dtMs = dt * 1000;
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // プレイヤー移動 (220px/s, AABB・軸分離)
    let mx = 0, my = 0;
    if (down('ArrowLeft', 'KeyA')) mx -= 1;
    if (down('ArrowRight', 'KeyD')) mx += 1;
    if (down('ArrowUp', 'KeyW')) my -= 1;
    if (down('ArrowDown', 'KeyS')) my += 1;
    if (mx && my) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
    let nx = player.x + mx * PLAYER_SPEED * dt;
    if (!hitsOccluder(nx, player.y)) player.x = nx;
    let ny = player.y + my * PLAYER_SPEED * dt;
    if (!hitsOccluder(player.x, ny)) player.y = ny;
    player.x = clamp(player.x, TILE + P_HALF, ROOM_W - TILE - P_HALF);
    player.y = clamp(player.y, TILE + P_HALF, ROOM_H - TILE - P_HALF);
    playerSprite.position.set(player.x, H - player.y, 0);

    // 動的光源更新 (決定的軌道: 壁でバウンド・柱は通り抜け)
    for (const L of dynLights) {
      L.x += L.vx * dt; L.y += L.vy * dt;
      if (L.x < TILE) { L.x = TILE; L.vx = Math.abs(L.vx); }
      else if (L.x > ROOM_W - TILE) { L.x = ROOM_W - TILE; L.vx = -Math.abs(L.vx); }
      if (L.y < TILE) { L.y = TILE; L.vy = Math.abs(L.vy); }
      else if (L.y > ROOM_H - TILE) { L.y = ROOM_H - TILE; L.vy = -Math.abs(L.vy); }
    }

    // ライトマップ生成 (オフスクリーン RenderTarget) → overlayQuad(乗算)へ反映
    buildLightmap();

    // メインシーン描画 (床＋柱＋プレイヤー → 上に lightRT を乗算 quad で重ねる)
    renderer.setRenderTarget(null);
    renderer.setClearColor(scene.background, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Lights    : ${dynLights.length} / ${LIGHT_MAX}  (+player 1)\n` +
        `Occluders : ${pillars.length}  (+外周壁4)\n` +
        `Shadows   : ${shadowsOn ? 'ON' : 'OFF'}\n` +
        `Mode      : Lightmap(RenderTarget add → Multiply quad)\n` +
        `Ambient   : ${AMBIENT.toFixed(2)}`;
    }
  });

  console.log('three.js theme11 lighting started. renderer: WebGL');
}
