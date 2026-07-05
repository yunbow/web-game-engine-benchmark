/* ============================================================================
 * テーマ11 2Dダイナミックライティング / 影（ライトマップ × 多光源 × 影）― KAPLAY 実装
 * 共通仕様 11/SPEC.md に厳密準拠。性能比較用。
 *
 *   960x540 / 30x17 タイル(32px) の暗い床 / 約16個の矩形オクルーダ(柱)＋外周壁。
 *   ambient=0.10 を下地に、全光源を「加算」でライトバッファへ積み、
 *   完成したライトバッファを描画済みシーン(床＋柱)へ「乗算」で重ねる。
 *   各光源はオクルーダ背後を「影ポリゴン(黒)」で削ってから加算する(ハードシャドウ)。
 *
 * --- KAPLAY でのライトマップ実装の核 ---------------------------------------
 *   KAPLAY は「全部入り」の 2D ゲームライブラリ。床/柱/プレイヤーの描画・ループ・
 *   入力は KAPLAY 機構を使う。ただしライトマップは「光源ごとにスクラッチへ放射グロー
 *   を描き、影ポリゴン(黒)で光を削り、全体バッファへ加算」という per-light のバッファ
 *   往復が核で、これは destination-out(光を抜く) + lighter(加算) が必要になる。
 *   KAPLAY の onDraw 経路だけではスクラッチ往復(中間バッファ)を素直に表現できないため、
 *   ライトマップ生成は ★オフスクリーン 2D canvas★ で「正直に」実装する:
 *     1) lightmap canvas を ambient(0.10) の灰でクリア。
 *     2) 各光源について scratch canvas をクリア → 放射グラデ描画 →
 *        影 ON なら影ポリゴン(黒)を source-over で塗って光を削る →
 *        scratch を lightmap へ 'lighter'(加算) 合成。
 *     3) 完成 lightmap canvas を KAPLAY キャンバスの真上に DOM オーバーレイとして重ね、
 *        ★CSS mix-blend-mode: multiply★ でシーン(床＋柱)へ乗算合成する。
 *   → 「加算でライトマップ生成」は 2D canvas、「乗算でシーンへ合成」は CSS multiply。
 *      KAPLAY 3001 は乗算ブレンド(BlendMode.Multiply)を公開していないための実装。詳細は README。
 *
 * 決定的生成(mulberry32, Math.random 不使用)。柱配置・光源軌道・色を固定。
 * ========================================================================== */

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

const LIGHT_INIT = 12, LIGHT_STEP = 6, LIGHT_MIN = 0, LIGHT_MAX = 120;
const DYN_SPEED = 120;                   // px/s 相当の決定的軌道

const OCCLUDER_COUNT = 16;
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
// HSV(0..1) -> RGB(0..255)
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
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ===================================================================
//  オクルーダ(柱) 決定的生成 + 外周壁
// ===================================================================
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
    // 中央(プレイヤー初期)を避ける
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

// ===================================================================
//  KAPLAY 初期化
// ===================================================================
const k = kaplay({
  width: W, height: H,
  canvas: document.getElementById('game-canvas'),
  background: [5, 7, 11],
  crisp: true,
  global: false,                 // 名前空間 k.* を明示利用
});

// ===================================================================
//  オフスクリーン 2D canvas (ライトマップ本体)
// ===================================================================
const lmCanvas = document.createElement('canvas');
lmCanvas.width = W; lmCanvas.height = H;
const lmCtx = lmCanvas.getContext('2d');

const scCanvas = document.createElement('canvas'); // 光源ごとのスクラッチ
scCanvas.width = W; scCanvas.height = H;
const scCtx = scCanvas.getContext('2d');

// 影ポリゴンを光源から遠方へ延ばす距離(光半径より十分大)
const SHADOW_FAR = W + H;

// 矩形 o の、光源(sx,sy)から見たハードシャドウ四角形を黒で塗る。
function castRectShadow(ctx, sx, sy, o) {
  const x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  const corners = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  // 各辺の外向き法線(左上原点・y下): 上,右,下,左
  const normals = [
    { nx: 0, ny: -1 }, { nx: 1, ny: 0 }, { nx: 0, ny: 1 }, { nx: -1, ny: 0 },
  ];
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[(e + 1) % 4];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const toLx = sx - mx, toLy = sy - my;
    const n = normals[e];
    if (toLx * n.nx + toLy * n.ny >= 0) continue; // 光源を向く辺は影を作らない
    // 端点を光源から遠ざかる方向へ延長
    const ax = a.x - sx, ay = a.y - sy, bx = b.x - sx, by = b.y - sy;
    const aLen = Math.hypot(ax, ay) || 1, bLen = Math.hypot(bx, by) || 1;
    const ax2 = a.x + (ax / aLen) * SHADOW_FAR, ay2 = a.y + (ay / aLen) * SHADOW_FAR;
    const bx2 = b.x + (bx / bLen) * SHADOW_FAR, by2 = b.y + (by / bLen) * SHADOW_FAR;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineTo(bx2, by2); ctx.lineTo(ax2, ay2);
    ctx.closePath(); ctx.fill();
  }
}

// 1光源を加算合成で積む(影 ON 時はスクラッチで光を削ってから加算)。
function drawLight(sx, sy, r, cr, cg, cb, occluders, pillars, shadowsOn) {
  const grad = scCtx.createRadialGradient(sx, sy, 0, sx, sy, r);
  grad.addColorStop(0.00, `rgba(${cr},${cg},${cb},1.0)`);
  grad.addColorStop(0.35, `rgba(${cr},${cg},${cb},0.65)`);
  grad.addColorStop(0.70, `rgba(${cr},${cg},${cb},0.22)`);
  grad.addColorStop(1.00, `rgba(${cr},${cg},${cb},0.0)`);

  scCtx.globalCompositeOperation = 'source-over';
  scCtx.clearRect(0, 0, W, H);
  scCtx.fillStyle = grad;
  scCtx.beginPath();
  scCtx.arc(sx, sy, r, 0, Math.PI * 2);
  scCtx.fill();

  if (shadowsOn) {
    scCtx.fillStyle = '#000';
    for (const o of occluders) {
      if (sx > o.x && sx < o.x + o.w && sy > o.y && sy < o.y + o.h) continue; // 光源が内部
      castRectShadow(scCtx, sx, sy, o);
    }
    // 柱本体も暗く(柱内部を照らさない)
    for (const o of pillars) scCtx.fillRect(o.x, o.y, o.w, o.h);
  }

  lmCtx.globalCompositeOperation = 'lighter';
  lmCtx.drawImage(scCanvas, 0, 0);
  lmCtx.globalCompositeOperation = 'source-over';
}

// ===================================================================
//  アセット読み込み (失敗してもフォールバックで起動)
// ===================================================================
const loaded = {};
(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { await k.loadSprite(key, url); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> shape fallback`); }
  }));
  start();
})();

function start() {
  const pillars = generateOccluders();
  const walls = makeWallOccluders();
  const occluders = [...pillars, ...walls];

  // --- シーン: 暗い床(タイル) ---
  if (loaded.tile_floor) {
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const t = k.add([k.sprite('tile_floor'), k.pos(tx * TILE, ty * TILE), k.anchor('topleft'), { z: 0 }]);
        t.width = TILE; t.height = TILE;
      }
    }
  } else {
    k.onDraw(() => {
      for (let ty = 0; ty < MAP_H; ty++) {
        for (let tx = 0; tx < MAP_W; tx++) {
          const c = ((tx + ty) & 1) ? k.rgb(27, 27, 34) : k.rgb(22, 22, 28);
          k.drawRect({ pos: k.vec2(tx * TILE, ty * TILE), width: TILE, height: TILE, color: c });
        }
      }
    });
  }

  // --- シーン: 柱(オクルーダ) ---
  for (const o of pillars) {
    if (loaded.pillar) {
      const s = k.add([k.sprite('pillar'), k.pos(o.x, o.y), k.anchor('topleft')]);
      s.width = o.w; s.height = o.h;
    } else {
      k.add([k.rect(o.w, o.h), k.pos(o.x, o.y), k.anchor('topleft'), k.color(74, 75, 85), k.outline(2, k.rgb(108, 108, 122))]);
    }
  }

  // --- プレイヤー (シーン層・乗算ライトの下) ---
  const player = { x: ROOM_W / 2, y: ROOM_H / 2 };
  let playerObj;
  if (loaded.player_lamp) {
    playerObj = k.add([k.sprite('player_lamp'), k.pos(player.x, player.y), k.anchor('center')]);
    playerObj.width = 24; playerObj.height = 36;
  } else {
    playerObj = k.add([k.rect(16, 28, { radius: 3 }), k.pos(player.x, player.y), k.anchor('center'), k.color(216, 210, 192)]);
  }

  // --- 動的光源 (決定的初期化＆軌道) ---
  const dynLights = [];
  function makeDynLight(i) {
    const rnd = mulberry32((SEED_LIGHTS ^ (i * 0x9E3779B1)) >>> 0);
    const ang = rnd() * Math.PI * 2;
    const [r, g, b] = hsv2rgb(rnd(), 0.78, 1.0);
    return {
      x: TILE * 2 + rnd() * (ROOM_W - TILE * 4),
      y: TILE * 2 + rnd() * (ROOM_H - TILE * 4),
      vx: Math.cos(ang) * DYN_SPEED, vy: Math.sin(ang) * DYN_SPEED,
      r, g, b,
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

  // --- 入力 ---
  // '+' は Shift+'=' / テンキー+ いずれも event.key='+' として届く。'=' と両対応。
  k.onKeyPress(['=', '+'], () => setLightCount(lightTarget + LIGHT_STEP));
  k.onKeyPress(['-'], () => setLightCount(lightTarget - LIGHT_STEP));
  k.onKeyPress('l', () => { shadowsOn = !shadowsOn; });
  k.onKeyPress('r', () => resetAll());

  // --- AABB (プレイヤー vs 柱/壁) ---
  function hitsOccluder(cx, cy) {
    const left = cx - P_HALF, right = cx + P_HALF, top = cy - P_HALF, bot = cy + P_HALF;
    for (const o of pillars) {
      if (left < o.x + o.w && right > o.x && top < o.y + o.h && bot > o.y) return true;
    }
    return false;
  }

  // --- ライトマップ生成 (オフスクリーン 2D canvas) ---
  function buildLightmap() {
    const amb = Math.round(AMBIENT * 255);
    lmCtx.globalCompositeOperation = 'source-over';
    lmCtx.fillStyle = `rgb(${amb},${amb},${amb})`;
    lmCtx.fillRect(0, 0, W, H);

    drawLight(player.x, player.y, PLAYER_LIGHT_R, 255, 242, 216, occluders, pillars, shadowsOn);
    for (const L of dynLights) {
      drawLight(L.x, L.y, DYN_LIGHT_R, L.r, L.g, L.b, occluders, pillars, shadowsOn);
    }
  }

  // --- ライトマップを「乗算」でシーンへ重ねる ---
  // KAPLAY 3001 は乗算ブレンド(BlendMode.Multiply / drawSprite blend)を公開していないため、
  // ライトマップ canvas を KAPLAY キャンバスの真上に DOM オーバーレイとして重ね、
  // CSS の mix-blend-mode: multiply（ブラウザネイティブの乗算合成）で合成段を担う。
  // → シーン描画は KAPLAY、加算ライトマップ生成は 2D canvas、乗算合成は CSS。
  lmCanvas.style.position = 'absolute';
  lmCanvas.style.left = '0';
  lmCanvas.style.top = '0';
  lmCanvas.style.width = W + 'px';
  lmCanvas.style.height = H + 'px';
  lmCanvas.style.mixBlendMode = 'multiply';
  lmCanvas.style.pointerEvents = 'none';
  const gameCanvas = document.getElementById('game-canvas');
  // game-canvas の直後（HUD より下）に挿入し、シーンにだけ乗算がかかるようにする。
  gameCanvas.insertAdjacentElement('afterend', lmCanvas);

  // --- HUD ---
  const hudEl = document.getElementById('hud');
  const fpsSamples = []; let hudTimer = 0;

  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // プレイヤー移動 (220px/s, AABB)
    let mx = 0, my = 0;
    if (k.isKeyDown('left') || k.isKeyDown('a')) mx -= 1;
    if (k.isKeyDown('right') || k.isKeyDown('d')) mx += 1;
    if (k.isKeyDown('up') || k.isKeyDown('w')) my -= 1;
    if (k.isKeyDown('down') || k.isKeyDown('s')) my += 1;
    if (mx && my) { const inv = 1 / Math.SQRT2; mx *= inv; my *= inv; }
    let nx = player.x + mx * PLAYER_SPEED * dt;
    if (!hitsOccluder(nx, player.y)) player.x = nx;
    let ny = player.y + my * PLAYER_SPEED * dt;
    if (!hitsOccluder(player.x, ny)) player.y = ny;
    player.x = clamp(player.x, TILE + P_HALF, ROOM_W - TILE - P_HALF);
    player.y = clamp(player.y, TILE + P_HALF, ROOM_H - TILE - P_HALF);
    playerObj.pos.x = player.x; playerObj.pos.y = player.y;

    // 動的光源更新 (決定的軌道: 壁でバウンド・柱は通り抜け)
    for (const L of dynLights) {
      L.x += L.vx * dt; L.y += L.vy * dt;
      if (L.x < TILE) { L.x = TILE; L.vx = Math.abs(L.vx); }
      else if (L.x > ROOM_W - TILE) { L.x = ROOM_W - TILE; L.vx = -Math.abs(L.vx); }
      if (L.y < TILE) { L.y = TILE; L.vy = Math.abs(L.vy); }
      else if (L.y > ROOM_H - TILE) { L.y = ROOM_H - TILE; L.vy = -Math.abs(L.vy); }
    }

    // ライトマップ生成 (描画は onDraw で multiply 合成)
    buildLightmap();

    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Lights    : ${dynLights.length} / ${LIGHT_MAX}  (+player 1)\n` +
        `Occluders : ${pillars.length}  (+外周壁4)\n` +
        `Shadows   : ${shadowsOn ? 'ON' : 'OFF'}\n` +
        `Mode      : Lightmap(canvas add → CSS multiply)\n` +
        `Ambient   : ${AMBIENT.toFixed(2)}` +
        (loaded.tile_floor || loaded.pillar ? '   [sprites]' : '   [shapes fallback]');
    }
  });

  console.log('KAPLAY theme11 lighting started.');
}
