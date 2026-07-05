'use strict';

/*
  テーマ11 2Dダイナミックライティング / 影 ― LittleJS 版
  --------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / タイル 32x32 / 部屋 30x17 (=960x544px, 決定的生成)
   - 暗いトップダウンの部屋。ambient=0.10 の下地に、放射状フォールオフの光源を加算で積み、
     完成したライトマップを描画済みシーン(床・柱)へ "乗算(multiply)" で重ねる。
   - プレイヤー光源: 白色 半径240。WASD/矢印で 220px/s 移動、壁/柱に AABB 停止。
   - 動的光源: 色付き 半径160。決定的軌道で自動移動(無入力でもベンチが回る)。初期12, ±6, 0..120。
   - オクルーダ: 軸平行の矩形(柱)約16個 + 外周壁。光源ごとにハードシャドウ(影ポリゴン)を落とす。
   - L:影 ON/OFF / +/-:動的光源数 / R:リセット。HUD は #hud overlay。

  ★ ライティングの実装方式 (このテーマの肝) ★
   - LittleJS には高レベルな 2D ライト機構が無いため、"オフスクリーン 2D canvas に
     ライトマップを自前生成 → multiply 合成" という現実的経路を採る(SPEC のライトマップ方式)。
   - 手順(毎フレーム):
     1. オフスクリーン canvas(960x540) を ambient(0.10) の灰でクリア。
     2. 各光源を 加算合成(globalCompositeOperation='lighter') の放射グラデで描く。
        影 ON 時は、その光源描画の前後で「光源から見た矩形オクルーダのシルエット」を
        黒(=光ゼロ)の影ポリゴンとして塗り、光を削る(ハードシャドウ)。
     3. 出来たライトマップを、LittleJS が描いた暗いシーンへ multiply で重ねる。

  ★ 座標系 / Y軸メモ (最重要・このテーマの主な罠) ★
   - LittleJS のワールドは Y軸"上向き"(画面下=Y小, 画面上=Y大)。一方、
     ライトマップを描く 2D canvas は "Y下向き"(左上原点, 画面下=Y大)。
   - 2つの座標系を毎フレーム混ぜると事故るので、本実装では
     「ライトマップの計算は最初から最後までスクリーン空間(左上原点・Y下向き・px)で完結」させる。
   - そのため、ゲーム論理(光源・プレイヤー・オクルーダの位置)は ★スクリーン空間(Y下向き)★ で保持する。
     ・worldFromScreen() で 1 回だけスクリーン→ワールドに変換し、LittleJS の drawRect/drawTile に渡す。
     ・ライトマップ canvas へはスクリーン座標をそのまま使う(変換不要)。
   - cameraScale=1 / カメラ中心 = ワールド中心 に固定。部屋高さ544 はキャンバス540 より僅かに高いが、
     上下 2px ずつはみ出すだけ(下地が暗いので視覚的に問題なし)。スクリーン↔ワールドは線形 1:1。
*/

// ---- 画面・部屋定数 (SPEC) ----
const VIEW_W = 960, VIEW_H = 540;        // 固定キャンバス(スクリーン px)
const TILE = 32;                         // 1タイル px
const MAP_W = 30, MAP_H = 17;            // 部屋タイル数 (960 x 544 px)
const ROOM_W = MAP_W * TILE;             // 960
const ROOM_H = MAP_H * TILE;             // 544

// ---- ライティング数値 (SPEC) ----
const AMBIENT = 0.10;                    // 下地の明るさ
const PLAYER_LIGHT_R = 240;              // プレイヤー光源 半径
const DYN_LIGHT_R = 160;                 // 動的光源 半径
const PLAYER_SPEED = 220;                // プレイヤー移動 px/s
const PLAYER_HALF = 11;                  // プレイヤー当たり半サイズ(22px角相当)

// ---- 動的光源数(負荷) ----
let lightTarget = 12;                    // 設定値(初期12)
const LIGHT_STEP = 6, LIGHT_MIN = 0, LIGHT_MAX = 120;

// ---- 状態 ----
let shadowsOn = true;                    // L トグル
let useSprites = false;                  // 画像が1枚でも読めたか
let occluders = [];                      // 矩形オクルーダ {x,y,w,h}(スクリーン空間, 左上原点)
let dynLights = [];                      // 動的光源 {x,y,vx,vy,r,g,b,phase,kind,...}(スクリーン空間)
let player = { x: VIEW_W / 2, y: VIEW_H / 2, vx: 0, vy: 0 }; // スクリーン空間(Y下向き)
let fpsAvg = 60;

// ---- ライトマップ用オフスクリーン canvas ----
let lmCanvas = null, lmCtx = null;       // 960x540, 2D, スクリーン空間(Y下向き)

const hudEl = () => document.getElementById('hud');

// ---- 決定的疑似乱数 (mulberry32, Math.random 不使用) ----
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ===================================================================
//  スクリーン(Y下向き) <-> ワールド(Y上向き) 変換
//  cameraScale=1, カメラ中心=ワールド中心 固定。
//  スクリーン左上(0,0) が ワールドの (cx-VIEW_W/2, cy+VIEW_H/2) に対応(Yは反転)。
// ===================================================================
function worldFromScreen(sx, sy) {
  // ワールド中心は (ROOM_W/2, ROOM_H/2)。スクリーン中心(VIEW_W/2,VIEW_H/2)へマップ。
  // X: そのまま(原点ずれのみ)。Y: 反転。
  const wx = sx + (ROOM_W / 2 - VIEW_W / 2);
  const wy = (ROOM_H / 2 + VIEW_H / 2) - sy;
  return vec2(wx, wy);
}

// ===================================================================
//  決定的生成: オクルーダ(柱) と 動的光源
// ===================================================================
const MAP_SEED = 20261115;
const LIGHT_SEED = 71013;

// 約16個の矩形柱を決定的配置(部屋の内側、外周壁の内側に分散)。
// + 外周壁(上下左右の4枚)もオクルーダとして登録(影を落とす境界)。
function generateOccluders() {
  occluders = [];
  const rng = makeRng(MAP_SEED);

  // --- 外周壁(厚み TILE)。スクリーン空間 左上原点。 ---
  const wt = TILE; // 壁厚
  occluders.push({ x: 0, y: 0, w: VIEW_W, h: wt, wall: true });               // 上
  occluders.push({ x: 0, y: VIEW_H - wt, w: VIEW_W, h: wt, wall: true });     // 下
  occluders.push({ x: 0, y: 0, w: wt, h: VIEW_H, wall: true });              // 左
  occluders.push({ x: VIEW_W - wt, y: 0, w: wt, h: VIEW_H, wall: true });    // 右

  // --- 内部の柱 約16個。重なり/外周近接を避けつつ決定的に配置。 ---
  const wantPillars = 16;
  let guard = 0;
  while (occluders.filter(o => !o.wall).length < wantPillars && guard++ < 2000) {
    const w = TILE * (1 + Math.floor(rng() * 2));   // 32 or 64
    const h = TILE * (1 + Math.floor(rng() * 2));   // 32 or 64
    // 壁厚 + 余白を空けて配置
    const x = wt + 24 + Math.floor(rng() * (VIEW_W - 2 * wt - 48 - w));
    const y = wt + 24 + Math.floor(rng() * (VIEW_H - 2 * wt - 48 - h));
    const cand = { x, y, w, h, wall: false };
    // 既存柱と余白16px以上空ける / 画面中央(プレイヤー初期)を避ける
    let ok = true;
    for (const o of occluders) {
      if (o.wall) continue;
      if (rectsOverlap(cand, o, 24)) { ok = false; break; }
    }
    // 中央のプレイヤー初期位置(±40)に被らない
    if (ok && Math.abs((x + w / 2) - VIEW_W / 2) < 60 && Math.abs((y + h / 2) - VIEW_H / 2) < 60) ok = false;
    if (ok) occluders.push(cand);
  }
}

function rectsOverlap(a, b, pad) {
  pad = pad || 0;
  return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x &&
         a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
}

// 内部柱のみ(影/描画対象)。外周壁は影は落とすが「柱の数」には含めない。
function pillarOccluders() { return occluders.filter(o => !o.wall); }

// 動的光源を決定的に最大数ぶん生成(色・初期位置・速度・軌道種別)。
// 実際に使うのは先頭 lightTarget 個。+/- で体数だけ変わり配置は決定的。
let dynLightPool = [];
function buildDynLightPool() {
  const rng = makeRng(LIGHT_SEED);
  dynLightPool = [];
  for (let i = 0; i < LIGHT_MAX; i++) {
    // 鮮やかな色(HSV 風: 決定的に色相を回す)
    const hue = rng();
    const col = hsvToRgb(hue, 0.85, 1.0);
    const x = TILE + 24 + rng() * (VIEW_W - 2 * TILE - 48);
    const y = TILE + 24 + rng() * (VIEW_H - 2 * TILE - 48);
    const ang = rng() * Math.PI * 2;
    const spd = 90 + rng() * 60;          // ~120px/s 相当
    const kind = rng() < 0.5 ? 0 : 1;     // 0=バウンド, 1=円運動
    dynLightPool.push({
      x0: x, y0: y, x, y,
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      r: col[0], g: col[1], b: col[2],
      kind,
      // 円運動用パラメータ
      cx: x, cy: y, radius: 40 + rng() * 90, phase: rng() * Math.PI * 2,
      omega: (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 1.0),
    });
  }
}

// 現在の lightTarget に合わせて稼働光源リストを作る(プールの先頭 N 個を採用)。
function syncDynLights() {
  dynLights = [];
  for (let i = 0; i < lightTarget && i < dynLightPool.length; i++) {
    const p = dynLightPool[i];
    // プール値から作業用にコピー(位置はリセットして決定的に再開)
    p.x = p.x0; p.y = p.y0; p.phase = p._phase0 !== undefined ? p._phase0 : p.phase;
    dynLights.push(p);
  }
}

// HSV(0..1) -> RGB(0..1)
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// ===================================================================
//  動的光源の更新(決定的軌道)。柱は通り抜けてよい(影は落とす)。
// ===================================================================
function updateDynLights(dt) {
  const margin = TILE; // 外周壁内側でバウンド
  for (const L of dynLights) {
    if (L.kind === 0) {
      // バウンド: 外周壁内で反射
      L.x += L.vx * dt; L.y += L.vy * dt;
      if (L.x < margin) { L.x = margin; L.vx = Math.abs(L.vx); }
      if (L.x > VIEW_W - margin) { L.x = VIEW_W - margin; L.vx = -Math.abs(L.vx); }
      if (L.y < margin) { L.y = margin; L.vy = Math.abs(L.vy); }
      if (L.y > VIEW_H - margin) { L.y = VIEW_H - margin; L.vy = -Math.abs(L.vy); }
    } else {
      // 円運動: 中心 (cx,cy) のまわりを公転(中心もゆっくり漂流)
      L.phase += L.omega * dt;
      L.cx += L.vx * 0.15 * dt; L.cy += L.vy * 0.15 * dt;
      if (L.cx < margin + L.radius) { L.cx = margin + L.radius; L.vx = Math.abs(L.vx); }
      if (L.cx > VIEW_W - margin - L.radius) { L.cx = VIEW_W - margin - L.radius; L.vx = -Math.abs(L.vx); }
      if (L.cy < margin + L.radius) { L.cy = margin + L.radius; L.vy = Math.abs(L.vy); }
      if (L.cy > VIEW_H - margin - L.radius) { L.cy = VIEW_H - margin - L.radius; L.vy = -Math.abs(L.vy); }
      L.x = L.cx + Math.cos(L.phase) * L.radius;
      L.y = L.cy + Math.sin(L.phase) * L.radius;
    }
  }
}

// ===================================================================
//  プレイヤー移動(スクリーン空間, Y下向き)。WASD/矢印 + AABB(柱/壁)。
// ===================================================================
function movePlayer(dt) {
  let mx = 0, my = 0;
  if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) mx -= 1;
  if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) mx += 1;
  if (keyIsDown('ArrowUp') || keyIsDown('KeyW')) my -= 1;     // 画面上 = Y小(スクリーン)
  if (keyIsDown('ArrowDown') || keyIsDown('KeyS')) my += 1;
  // 斜め正規化
  if (mx !== 0 && my !== 0) { const k = Math.SQRT1_2; mx *= k; my *= k; }
  player.vx = mx * PLAYER_SPEED;
  player.vy = my * PLAYER_SPEED;

  // X 軸 → Y 軸 の順で AABB 解決(柱 + 外周壁)
  const hw = PLAYER_HALF;
  let nx = player.x + player.vx * dt;
  if (!hitsAnyOccluder(nx, player.y, hw)) player.x = nx;
  let ny = player.y + player.vy * dt;
  if (!hitsAnyOccluder(player.x, ny, hw)) player.y = ny;

  // 念のため外周内にクランプ
  player.x = clamp(player.x, TILE + hw, VIEW_W - TILE - hw);
  player.y = clamp(player.y, TILE + hw, VIEW_H - TILE - hw);
}

// 中心(cx,cy) 半サイズhw の正方が、どれかのオクルーダ矩形と重なるか。
// 外周壁は内側境界として扱う(壁本体に侵入しない)。
function hitsAnyOccluder(cx, cy, hw) {
  const left = cx - hw, right = cx + hw, top = cy - hw, bot = cy + hw;
  for (const o of occluders) {
    if (o.wall) continue; // 壁はクランプで処理
    if (left < o.x + o.w && right > o.x && top < o.y + o.h && bot > o.y) return true;
  }
  return false;
}

// ===================================================================
//  ライトマップ生成(オフスクリーン 2D canvas, スクリーン空間)
// ===================================================================
function ensureLightmap() {
  if (lmCanvas) return;
  lmCanvas = document.createElement('canvas');
  lmCanvas.width = VIEW_W;
  lmCanvas.height = VIEW_H;
  lmCtx = lmCanvas.getContext('2d');
}

// 1つの光源(中心 sx,sy / 半径 r / 色 rgb)を加算で描く。
// 影 ON 時は、この光源描画の中で各オクルーダの影ポリゴンを黒で塗って光を削る。
function drawLight(ctx, sx, sy, r, cr, cg, cb) {
  // 放射グラデ(中心=色, 外周=透明)。smoothstep 風に途中を作る。
  const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
  const R = Math.round(cr * 255), G = Math.round(cg * 255), B = Math.round(cb * 255);
  grad.addColorStop(0.00, `rgba(${R},${G},${B},1.0)`);
  grad.addColorStop(0.35, `rgba(${R},${G},${B},0.65)`);
  grad.addColorStop(0.70, `rgba(${R},${G},${B},0.22)`);
  grad.addColorStop(1.00, `rgba(${R},${G},${B},0.0)`);

  // この光源寄与だけを一旦中間バッファ(scratch)に描き、影を黒で削ってから
  // 全体ライトマップへ 'lighter'(加算)合成する…のが SPEC のスクラッチ方式。
  // ここでは性能のため、scratch を使わず直接 lighter で光を足し、影は
  // 「光の上に黒い影ポリゴンを destination-out で抜く」のではなく、
  // 後段でまとめて影を引くと多光源で破綻するため、光源単位で scratch を使う。
  const s = scratch();
  const sc = s.ctx;
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, VIEW_W, VIEW_H);

  // 1) この光源の放射光を scratch に描く
  sc.globalCompositeOperation = 'source-over';
  sc.fillStyle = grad;
  sc.beginPath();
  sc.arc(sx, sy, r, 0, Math.PI * 2);
  sc.fill();

  // 2) 影 ON なら、各オクルーダの影ポリゴンを黒(=光ゼロ)で塗り、光を削る
  if (shadowsOn) {
    sc.globalCompositeOperation = 'source-over';
    sc.fillStyle = '#000';
    for (const o of occluders) {
      drawShadowPolygon(sc, sx, sy, r, o);
    }
    // 柱本体も暗く(光源が柱内部側を照らさないよう、柱矩形自体も黒で塗る)
    for (const o of pillarOccluders()) {
      sc.fillRect(o.x, o.y, o.w, o.h);
    }
  }

  // 3) scratch(影込みの光寄与) を全体ライトマップへ加算
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(s.canvas, 0, 0);
}

// scratch バッファ(光源ごとに使い回す単一の中間 canvas)
let _scratch = null;
function scratch() {
  if (!_scratch) {
    const c = document.createElement('canvas');
    c.width = VIEW_W; c.height = VIEW_H;
    _scratch = { canvas: c, ctx: c.getContext('2d') };
  }
  return _scratch;
}

// 矩形オクルーダ o の、光源(sx,sy)から見たハードシャドウ四角形を ctx に塗る。
// 各辺について、光源と反対側の端点を光半径を超えて延長し影ポリゴンを作る。
// 軸平行矩形なので、4頂点それぞれを光源から放射方向に延ばした凸包…ではなく、
// 「シルエット辺ごとに四角形」を塗る簡潔版(辺=2点 → 延長2点 の四角)。
function drawShadowPolygon(ctx, sx, sy, r, o) {
  const far = r + Math.max(VIEW_W, VIEW_H); // 光半径を十分超える延長距離
  // 矩形の4頂点
  const corners = [
    { x: o.x,       y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x + o.w, y: o.y + o.h },
    { x: o.x,       y: o.y + o.h },
  ];
  // 各辺(i, i+1)について、光源から見て"裏向き"(シルエット)なら影四角を塗る。
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    // 辺の外向き法線(矩形は時計回り定義なので外向きを計算)。
    // 辺ベクトル e=(b-a)、外向き法線 n=(e.y, -e.x)(時計回り頂点列での外向き)。
    const ex = b.x - a.x, ey = b.y - a.y;
    const nx = ey, ny = -ex;
    // 辺中点から光源へのベクトル
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const lx = sx - mx, ly = sy - my;
    // 法線が光源と反対(裏向き)なら、その辺は影を落とすシルエット辺
    if (nx * lx + ny * ly < 0) {
      // a,b を光源から放射方向に far だけ延長
      const a2 = extend(sx, sy, a.x, a.y, far);
      const b2 = extend(sx, sy, b.x, b.y, far);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(a2.x, a2.y);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// 点(px,py) を 光源(sx,sy) から外側へ dist だけ延長した座標。
function extend(sx, sy, px, py, dist) {
  let dx = px - sx, dy = py - sy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  return { x: px + dx * dist, y: py + dy * dist };
}

// 毎フレーム、ライトマップを生成(ambient → 全光源加算 → 影込み)。
function buildLightmap() {
  ensureLightmap();
  const ctx = lmCtx;
  // 1) ambient で下地クリア(灰)。multiply 下地なので 0.10 の明るさ。
  ctx.globalCompositeOperation = 'source-over';
  const amb = Math.round(AMBIENT * 255);
  ctx.fillStyle = `rgb(${amb},${amb},${amb})`;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // 2) プレイヤー光源(白) + 動的光源(色付き) を加算
  drawLight(ctx, player.x, player.y, PLAYER_LIGHT_R, 1.0, 1.0, 0.95);
  for (const L of dynLights) {
    drawLight(ctx, L.x, L.y, DYN_LIGHT_R, L.r, L.g, L.b);
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ===================================================================
//  テクスチャ読込判定 / フォールバック
// ===================================================================
const imageSources = [
  '../assets/tile_floor.png',  // 0
  '../assets/pillar.png',      // 1
  '../assets/light_glow.png',  // 2 (本実装ではライトは常にコード生成、未使用でも可)
  '../assets/player_lamp.png', // 3
];
const TEX = { floor: 0, pillar: 1, glow: 2, player: 3 };

function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}
function texTile(i) { return tile(0, textureInfos[i].size, i); }

// ===================================================================
//  リセット
// ===================================================================
function resetAll() {
  generateOccluders();
  buildDynLightPool();
  lightTarget = 12;
  syncDynLights();
  shadowsOn = true;
  player.x = VIEW_W / 2; player.y = VIEW_H / 2; player.vx = 0; player.vy = 0;
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);                       // 1ワールド単位 = 1px
  setCameraPos(vec2(ROOM_W / 2, ROOM_H / 2)); // カメラ中心 = 部屋中心(固定)
  setGravity(vec2(0, 0));

  // テクスチャ読込判定(1枚でも読めれば sprites 使用。空でも起動する)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  ensureLightmap();
  resetAll();
}

function gameUpdate() {
  const dt = timeDelta;

  // ---- 動的光源数 増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    lightTarget = clamp(lightTarget + LIGHT_STEP, LIGHT_MIN, LIGHT_MAX);
    syncDynLights();
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    lightTarget = clamp(lightTarget - LIGHT_STEP, LIGHT_MIN, LIGHT_MAX);
    syncDynLights();
  }
  // ---- 影 ON/OFF (L) ----
  if (keyWasPressed('KeyL')) shadowsOn = !shadowsOn;
  // ---- リセット (R) ----
  if (keyWasPressed('KeyR')) resetAll();

  movePlayer(dt);
  updateDynLights(dt);
}

function gameUpdatePost() {}

// ===================================================================
//  描画: 暗いシーン(床 + 柱)を LittleJS(WebGL)で描く。
//  ライトマップ合成は gameRenderPost で行う。
// ===================================================================
function gameRender() {
  // ---- 床(暗いタイル) ----
  // スプライトがあればタイル描画、無ければ暗い灰の床を1枚 + 市松で起伏。
  if (spriteReady(TEX.floor)) {
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const w = worldFromScreen(tx * TILE + TILE / 2, ty * TILE + TILE / 2);
        drawTile(w, vec2(TILE, TILE), texTile(TEX.floor));
      }
    }
  } else {
    // 暗い床ベース
    const c = worldFromScreen(VIEW_W / 2, VIEW_H / 2);
    drawRect(c, vec2(VIEW_W, VIEW_H), new Color(0.18, 0.19, 0.22));
    // 市松で薄く明暗(タイル感)。multiply 前提なので元から暗め。
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        if (((tx + ty) & 1) === 0) continue;
        const w = worldFromScreen(tx * TILE + TILE / 2, ty * TILE + TILE / 2);
        drawRect(w, vec2(TILE, TILE), new Color(0.13, 0.14, 0.17));
      }
    }
  }

  // ---- 柱(オクルーダ) ----
  for (const o of pillarOccluders()) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const w = worldFromScreen(cx, cy);
    if (spriteReady(TEX.pillar)) {
      drawTile(w, vec2(o.w, o.h), texTile(TEX.pillar));
    } else {
      drawRect(w, vec2(o.w, o.h), new Color(0.42, 0.43, 0.48));        // 灰の柱
      drawRect(w, vec2(o.w, o.h), new Color(0.62, 0.64, 0.70), 0, false); // 縁(線)
    }
  }

  // ---- プレイヤー(人型 + ランタン) ----
  const pw = worldFromScreen(player.x, player.y);
  if (spriteReady(TEX.player)) {
    drawTile(pw, vec2(24, 36), texTile(TEX.player));
  } else {
    drawRect(pw, vec2(16, 24), new Color(0.85, 0.82, 0.55));          // 体(明るめ=灯りで見える)
    // ランタン(小さな黄丸)を足元脇に
    const lampW = worldFromScreen(player.x + 10, player.y + 6);
    drawCircle(lampW, 4, new Color(1.0, 0.92, 0.5));
  }
}

// ===================================================================
//  ライトマップ合成 + HUD
// ===================================================================
function gameRenderPost() {
  // ---- 1) ライトマップ生成(オフスクリーン 2D canvas, スクリーン空間) ----
  buildLightmap();

  // ---- 2) LittleJS の overlayContext へ multiply で blit ----
  //   overlayContext は LittleJS が用意する 2D オーバーレイ。スクリーン左上原点・Y下向きで
  //   ピクセル一致するため、ライトマップ canvas をそのまま (0,0) に重ねられる。
  //   globalCompositeOperation='multiply' により「照らされた所だけ見え、影/未照は沈む」。
  if (typeof overlayContext !== 'undefined' && overlayContext) {
    const octx = overlayContext;
    octx.save();
    octx.globalCompositeOperation = 'multiply';
    // overlayCanvas は実ピクセルサイズが VIEW_W x VIEW_H 想定。一致しない場合に備え引き伸ばす。
    const ow = (typeof overlayCanvas !== 'undefined' && overlayCanvas) ? overlayCanvas.width : VIEW_W;
    const oh = (typeof overlayCanvas !== 'undefined' && overlayCanvas) ? overlayCanvas.height : VIEW_H;
    octx.drawImage(lmCanvas, 0, 0, VIEW_W, VIEW_H, 0, 0, ow, oh);
    octx.restore();
  }

  // ---- 3) HUD(HTML overlay) ----
  const inst = (typeof frameRate !== 'undefined' && frameRate) ? frameRate
             : (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const nPillars = pillarOccluders().length;
  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS       : ' + fpsAvg.toFixed(1) + '\n' +
      'Lights    : ' + dynLights.length + ' / ' + LIGHT_MAX + '  (+player 1)\n' +
      'Occluders : ' + nPillars + '  (+外周壁4)\n' +
      'Shadows   : ' + (shadowsOn ? 'ON' : 'OFF') + '\n' +
      'Mode      : Lightmap(canvas+multiply)\n' +
      'Ambient   : ' + AMBIENT.toFixed(2) +
      (useSprites ? '   [sprites]' : '   [shapes fallback]');
  }
}

// ===================================================================
//  起動
// ===================================================================
// 第7引数 rootElement に #game-container を渡し、canvas をそこへ生成させる
// (three.js 版と同じ 960x540・上下中央配置。CSS の !important でサイズ固定)。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
