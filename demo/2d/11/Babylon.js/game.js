"use strict";

/* =========================================================================
 * テーマ11: 2D ダイナミックライティング / 影 ― Babylon.js 版
 *
 * 「暗い部屋を多数の動的光源が照らし、矩形オクルーダ(柱)が影を落とす」性能ベンチ。
 *
 * ─── Babylon でこの 2D ライティングをどう実現するか ───────────────────
 *  Babylon は本来 3D エンジンで、ライト/影機構(PointLight, ShadowGenerator)は
 *  3D メッシュ + 深度マップ前提に作られている。2D の「放射状フォールオフ × 多数の
 *  色付き点光源 × 矩形オクルーダのハードシャドウ × 加算→乗算のライトマップ合成」を
 *  3D の ShadowGenerator で再現するのは、平面メッシュ化・正射影シャドウ・ライト数上限
 *  などの制約が多く、本来の 2D ライトマップ手法と「比較対象がズレる」。
 *
 *  そこで本実装は、SPEC が JS 系標準として挙げる **ライトマップ方式** を
 *  オフスクリーン 2D Canvas 上の Canvas2D 合成で「正直に」実装し、
 *  完成した 1 枚を Babylon の DynamicTexture として全画面の正射影 Plane に貼って
 *  「提示(present)」だけ Babylon に任せる。
 *    1) light バッファ: 全光源を加算合成(lighter)で積む。光源ごとに影ポリゴンを
 *       黒で描いて光を削る(ハードシャドウ)。下地に ambient を足す。
 *    2) scene バッファ: 暗い床タイル + 柱(オクルーダ)を描く。
 *    3) scene に light を multiply 合成 → 照らされた所だけ見え、影/未照は沈む。
 *    4) その 1 枚を DynamicTexture 経由で Babylon に提示。
 *  → ライティングは honest な 2D 合成、Babylon は presenter。詳細は README 参照。
 *
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を再現。
 *  - 決定的擬似乱数 mulberry32 (Math.random 不使用)。柱配置・光源軌道・色を固定。
 *  - 画像アセットがあれば床/柱/グロー/プレイヤーに使い、無ければ図形でフォールバック。
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;
const TILE = 32;               // 床タイル px
const MAP_W = 30;              // 30 タイル = 960px
const MAP_H = 17;              // 17 タイル = 544px (画面 540 を覆う)

const AMBIENT = 0.10;          // 下地の明るさ (SPEC: 0.10)

// プレイヤー光源
const PLAYER_SPEED = 220;      // px/s
const PLAYER_LIGHT_R = 240;    // プレイヤー光半径
const PLAYER_W = 22;           // 当たり判定/描画幅
const PLAYER_H = 30;

// 動的光源 (負荷の主役)
const DYN_LIGHT_R = 160;       // 動的光源半径
const INITIAL_LIGHTS = 12;     // 初期数
const LIGHT_STEP = 6;          // ± 増減
const MIN_LIGHTS = 0;
const MAX_LIGHTS = 120;        // 上限 (cap)
const DYN_SPEED = 120;         // 軌道速度 ~120 px/s 相当

// オクルーダ (柱)
const PILLAR_COUNT = 16;       // 約16個 (SPEC)
const WALL_T = 16;             // 外周壁の厚み (影を落とす枠)

/* ---------- アセット定義 ---------- */
const ASSET_DIR = "../assets/";
const ASSETS = {
  floor:  { file: "tile_floor.png" },   // 暗い床
  pillar: { file: "pillar.png" },       // 柱(オクルーダ)
  glow:   { file: "light_glow.png" },   // 光源グロー(中心白→外周透明)
  player: { file: "player_lamp.png" },  // プレイヤー(ランタン)
};

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じ柱配置/光源軌道/色を生成する。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
 *  オクルーダ(柱) ― 矩形を決定的に配置
 * ========================================================================= */
// 各オクルーダは {x,y,w,h} (左上原点 px)。border 壁も同じ配列に入れて
// 「全光源 × 全オクルーダ」で一様に影を扱う。
function buildOccluders() {
  const occ = [];
  const rnd = mulberry32(0x0CC1);

  // --- 外周の壁 (4辺) ― これも影を落とす ---
  occ.push({ x: 0, y: 0, w: VIEW_W, h: WALL_T, wall: true });                 // 上
  occ.push({ x: 0, y: VIEW_H - WALL_T, w: VIEW_W, h: WALL_T, wall: true });    // 下
  occ.push({ x: 0, y: 0, w: WALL_T, h: VIEW_H, wall: true });                 // 左
  occ.push({ x: VIEW_W - WALL_T, y: 0, w: WALL_T, h: VIEW_H, wall: true });    // 右

  // --- 内部の柱 (約16個) ― 重なり/プレイヤー初期位置を避けて決定的配置 ---
  const spawnX = VIEW_W / 2, spawnY = VIEW_H / 2; // プレイヤー初期位置 (中央)
  let guard = 0;
  while (occ.length - 4 < PILLAR_COUNT && guard < 2000) {
    guard++;
    const w = 28 + Math.floor(rnd() * 48); // 28..76
    const h = 28 + Math.floor(rnd() * 48);
    const x = WALL_T + 20 + rnd() * (VIEW_W - 2 * WALL_T - 40 - w);
    const y = WALL_T + 20 + rnd() * (VIEW_H - 2 * WALL_T - 40 - h);
    const cand = { x, y, w, h, wall: false };
    // プレイヤー初期位置 (中央) と被らない
    if (spawnX > x - 30 && spawnX < x + w + 30 && spawnY > y - 30 && spawnY < y + h + 30) continue;
    // 既存柱と過度に重ならない (少しの重なりは可)
    let ok = true;
    for (let i = 4; i < occ.length; i++) {
      const o = occ[i];
      if (x < o.x + o.w + 12 && x + w > o.x - 12 && y < o.y + o.h + 12 && y + h > o.y - 12) { ok = false; break; }
    }
    if (!ok) continue;
    occ.push(cand);
  }
  return occ;
}

const occluders = buildOccluders();
// 影を落とす内部柱の数 (HUD 表示用 ― 壁は別枠)
const PILLAR_REAL = occluders.filter((o) => !o.wall).length;

/* =========================================================================
 *  Babylon セットアップ ― DynamicTexture を貼った全画面 Plane を提示
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) ---
// orthoTop < orthoBottom で y 下向きの 2D 画面に一致させる。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

// マテリアルが見えるよう環境光 (実際は unlit/emissive で描く)
const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* ---------- ライトマップ提示用 DynamicTexture + 全画面 Plane ----------
 * DynamicTexture は内部に 960x540 の 2D canvas を持つ。そこへ毎フレーム
 * 合成済みライトマップを drawImage して update() すると、貼った Plane に反映される。
 */
const dynTex = new BABYLON.DynamicTexture(
  "lightmap", { width: VIEW_W, height: VIEW_H }, scene,
  false, BABYLON.Texture.NEAREST_SAMPLINGMODE
);
dynTex.hasAlpha = false;
const dynCtx = dynTex.getContext(); // DynamicTexture が持つ 2D コンテキスト

const presentMat = new BABYLON.StandardMaterial("presentMat", scene);
presentMat.diffuseTexture = dynTex;
presentMat.emissiveTexture = dynTex; // 環境光に依らずテクスチャそのままを出す
presentMat.disableLighting = true;
presentMat.backFaceCulling = false;
presentMat.specularColor = new BABYLON.Color3(0, 0, 0);

// 全画面 Plane。CreatePlane は中心原点なので画面中央に置きサイズを画面一杯に。
const presentPlane = BABYLON.MeshBuilder.CreatePlane("present", { width: VIEW_W, height: VIEW_H }, scene);
presentPlane.position.set(VIEW_W / 2, VIEW_H / 2, 0);
presentPlane.material = presentMat;
presentPlane.isPickable = false;

/* =========================================================================
 *  オフスクリーン Canvas ― ライティングの本体 (2D 合成)
 * ========================================================================= */
// scene バッファ: 暗い床 + 柱を描く下地。
const sceneCv = document.createElement("canvas");
sceneCv.width = VIEW_W; sceneCv.height = VIEW_H;
const sceneCtx = sceneCv.getContext("2d");

// light バッファ: 全光源を加算合成し影で削った「明るさマップ」。
const lightCv = document.createElement("canvas");
lightCv.width = VIEW_W; lightCv.height = VIEW_H;
const lightCtx = lightCv.getContext("2d");

// 各光源の放射グラデを焼いたスプライト (色は乗算で着色)。
// 描画コスト削減のため白グローを 1 枚作り、塗り(globalAlpha+色)で使い回す。
function makeGlowSprite(radius) {
  const d = radius * 2;
  const cv = document.createElement("canvas");
  cv.width = d; cv.height = d;
  const c = cv.getContext("2d");
  // 中心 1.0 → 外周 0.0 の滑らかなフォールオフ (smoothstep 風の多段 stop)。
  const g = c.createRadialGradient(radius, radius, 0, radius, radius, radius);
  g.addColorStop(0.00, "rgba(255,255,255,1.0)");
  g.addColorStop(0.25, "rgba(255,255,255,0.72)");
  g.addColorStop(0.50, "rgba(255,255,255,0.40)");
  g.addColorStop(0.75, "rgba(255,255,255,0.15)");
  g.addColorStop(1.00, "rgba(255,255,255,0.0)");
  c.fillStyle = g;
  c.fillRect(0, 0, d, d);
  return cv;
}
// プレイヤー光(240) と 動的光(160) で半径が違うので 2 種類用意。
const glowPlayer = makeGlowSprite(PLAYER_LIGHT_R);
const glowDyn = makeGlowSprite(DYN_LIGHT_R);

/* ---------- 画像アセット (任意) ---------- */
// 読み込めたら床/柱/プレイヤー/グローに使う。無ければ図形フォールバック。
const images = {};            // key -> HTMLImageElement or null
let assetsAllOk = true;

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* =========================================================================
 *  ゲーム状態
 * ========================================================================= */
const Game = {
  player: { x: VIEW_W / 2, y: VIEW_H / 2 },
  lights: [],          // 動的光源 {x,y, dyn-state, color:{r,g,b}, r}
  lightSetting: INITIAL_LIGHTS,
  shadowsOn: true,
  tilesDrawn: 0,
};

/* ---------- 動的光源を決定的に生成 ----------
 * 各光源は固定シードで決まる軌道(円運動 or 直進バウンド)を自動で動く。
 * 色は決定的 PRNG で割当 (加法混色で重なるほど明るく)。
 */
function makeLight(rnd, i) {
  // 色: HSV 風に鮮やかな色を作る (彩度高め)。
  const hue = rnd();
  const col = hsvToRgb(hue, 0.65, 1.0);
  // 軌道タイプ: 0=円運動, 1=直進バウンド
  const type = rnd() < 0.5 ? 0 : 1;
  const cx = WALL_T + 40 + rnd() * (VIEW_W - 2 * WALL_T - 80);
  const cy = WALL_T + 40 + rnd() * (VIEW_H - 2 * WALL_T - 80);
  if (type === 0) {
    const orbit = 40 + rnd() * 120;     // 円半径
    const ang = rnd() * Math.PI * 2;
    const dir = rnd() < 0.5 ? 1 : -1;
    const w = (DYN_SPEED / Math.max(20, orbit)) * dir; // 角速度 (周速 ~120)
    return { type, x: cx, y: cy, cx, cy, orbit, ang, w, color: col, r: DYN_LIGHT_R };
  } else {
    const a = rnd() * Math.PI * 2;
    return {
      type, x: cx, y: cy,
      vx: Math.cos(a) * DYN_SPEED, vy: Math.sin(a) * DYN_SPEED,
      color: col, r: DYN_LIGHT_R,
    };
  }
}

// 設定数 n に合わせて動的光源を決定的に再構築する。
function setLightCount(n) {
  n = Math.max(MIN_LIGHTS, Math.min(MAX_LIGHTS, n));
  Game.lightSetting = n;
  // 毎回同じシードで作り直す → 決定的 (同じ n なら同じ軌道)。
  const rnd = mulberry32(0x11697 ^ 0x9E3779B9);
  Game.lights.length = 0;
  for (let i = 0; i < n; i++) Game.lights.push(makeLight(rnd, i));
}

// HSV(0..1) → RGB(0..255)
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/* =========================================================================
 *  入力
 * ========================================================================= */
const keys = Object.create(null);
window.addEventListener("keydown", (ev) => {
  const k = ev.key.toLowerCase();
  keys[k] = true;
  if (ev.key === "+" || ev.key === "=" || ev.key === "Add") {
    setLightCount(Game.lightSetting + LIGHT_STEP);
  } else if (ev.key === "-" || ev.key === "_" || ev.key === "Subtract") {
    setLightCount(Game.lightSetting - LIGHT_STEP);
  } else if (k === "l") {
    Game.shadowsOn = !Game.shadowsOn;
  } else if (k === "r") {
    resetGame();
  }
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " ", "w", "a", "s", "d"].includes(k)) ev.preventDefault();
});
window.addEventListener("keyup", (ev) => { keys[ev.key.toLowerCase()] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
canvas.addEventListener("click", () => canvas.focus());
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

function resetGame() {
  Game.player.x = VIEW_W / 2;
  Game.player.y = VIEW_H / 2;
  Game.shadowsOn = true;
  setLightCount(Game.lightSetting);
}

/* =========================================================================
 *  プレイヤー移動 ― 簡易 AABB (柱/壁で停止)
 * ========================================================================= */
// プレイヤー矩形 (cx,cy 中心 / w,h) が いずれかのオクルーダと重なるか
function playerHitsOcc(cx, cy) {
  const left = cx - PLAYER_W / 2, right = cx + PLAYER_W / 2;
  const top = cy - PLAYER_H / 2, bottom = cy + PLAYER_H / 2;
  for (let i = 0; i < occluders.length; i++) {
    const o = occluders[i];
    if (left < o.x + o.w && right > o.x && top < o.y + o.h && bottom > o.y) return true;
  }
  return false;
}

function updatePlayer(dt) {
  let dx = 0, dy = 0;
  if (keys["arrowleft"] || keys["a"]) dx -= 1;
  if (keys["arrowright"] || keys["d"]) dx += 1;
  if (keys["arrowup"] || keys["w"]) dy -= 1;
  if (keys["arrowdown"] || keys["s"]) dy += 1;
  if (dx !== 0 && dy !== 0) { const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv; }

  const p = Game.player;
  // 軸分離: x → y の順に移動し、柱/壁にめり込むなら戻す。
  const nx = p.x + dx * PLAYER_SPEED * dt;
  if (!playerHitsOcc(nx, p.y)) p.x = nx;
  const ny = p.y + dy * PLAYER_SPEED * dt;
  if (!playerHitsOcc(p.x, ny)) p.y = ny;

  // 念のため画面内クランプ
  p.x = Math.max(WALL_T + PLAYER_W / 2, Math.min(VIEW_W - WALL_T - PLAYER_W / 2, p.x));
  p.y = Math.max(WALL_T + PLAYER_H / 2, Math.min(VIEW_H - WALL_T - PLAYER_H / 2, p.y));
}

/* ---------- 動的光源の軌道更新 (柱は通り抜け / 画面端でバウンド) ---------- */
function updateLights(dt) {
  for (const L of Game.lights) {
    if (L.type === 0) {
      // 円運動
      L.ang += L.w * dt;
      L.x = L.cx + Math.cos(L.ang) * L.orbit;
      L.y = L.cy + Math.sin(L.ang) * L.orbit;
    } else {
      // 直進バウンド (画面内で反射)
      L.x += L.vx * dt;
      L.y += L.vy * dt;
      const m = WALL_T;
      if (L.x < m) { L.x = m; L.vx = Math.abs(L.vx); }
      else if (L.x > VIEW_W - m) { L.x = VIEW_W - m; L.vx = -Math.abs(L.vx); }
      if (L.y < m) { L.y = m; L.vy = Math.abs(L.vy); }
      else if (L.y > VIEW_H - m) { L.y = VIEW_H - m; L.vy = -Math.abs(L.vy); }
    }
  }
}

/* =========================================================================
 *  影ポリゴンの生成 ― 矩形オクルーダのハードシャドウ
 * ========================================================================= */
// 光源 (lx,ly) から見た矩形 o のシルエットを、各辺について
// 「光源側を向いていない辺の端点」を光源から遠ざかる方向へ extend だけ延長し、
// 影の四角形(辺端2点 + 延長2点)を黒で塗って光を削る。
// 凸の矩形なら、各辺ごとに独立に影四角形を描けば全シルエットを覆える。
function castRectShadow(ctx, lx, ly, o, extend) {
  const x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  // 矩形の4頂点 (時計回り)
  const corners = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  // 各辺の外向き法線 (左上原点・y下) ― 上,右,下,左
  const normals = [
    { nx: 0, ny: -1 }, { nx: 1, ny: 0 }, { nx: 0, ny: 1 }, { nx: -1, ny: 0 },
  ];
  ctx.fillStyle = "#000";
  for (let e = 0; e < 4; e++) {
    const a = corners[e];
    const b = corners[(e + 1) % 4];
    // 辺の中点から光源へのベクトルと外向き法線の内積 < 0 なら「光源を向いていない辺」
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const toLx = lx - mx, toLy = ly - my;
    const n = normals[e];
    if (toLx * n.nx + toLy * n.ny >= 0) continue; // 光源を向く辺は影を作らない
    // 端点を光源から遠ざかる方向へ延長
    const ax = a.x - lx, ay = a.y - ly;
    const bx = b.x - lx, by = b.y - ly;
    const aLen = Math.hypot(ax, ay) || 1;
    const bLen = Math.hypot(bx, by) || 1;
    const ax2 = a.x + (ax / aLen) * extend;
    const ay2 = a.y + (ay / aLen) * extend;
    const bx2 = b.x + (bx / bLen) * extend;
    const by2 = b.y + (by / bLen) * extend;
    // 影四角形: a → b → b延長 → a延長
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(bx2, by2);
    ctx.lineTo(ax2, ay2);
    ctx.closePath();
    ctx.fill();
  }
}

/* =========================================================================
 *  ライティング合成 ― 本テーマの核
 * ========================================================================= */
// 1) light バッファを作る: ambient 下地 → 各光源を加算 (影で削る)。
function renderLightBuffer() {
  const ctx = lightCtx;
  // ambient: 暗い灰を全面に (これが最低限の見え方)。
  const a = Math.round(AMBIENT * 255);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = "rgb(" + a + "," + a + "," + a + ")";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // 各光源を加算合成 (lighter) で積む。
  // 影 ON のときは、その光源について先にシルエットへ影四角形を黒で描いてから
  // 加算する必要があるが、加算バッファに直接黒を描いても引き算にならない。
  // → 「光源グローを描いた一時バッファ上で影を黒で削り → それを加算」する。
  const tmp = lightCtx2; // スクラッチバッファ (光源ごとに使い回す)
  const ext = Math.max(VIEW_W, VIEW_H) * 1.5; // 影の延長距離 (画面を超える)

  drawOneLight(ctx, tmp, Game.player.x, Game.player.y, PLAYER_LIGHT_R, glowPlayer,
    { r: 255, g: 250, b: 235 }, ext); // プレイヤーは温白色

  for (let i = 0; i < Game.lights.length; i++) {
    const L = Game.lights[i];
    drawOneLight(ctx, tmp, L.x, L.y, L.r, glowDyn, L.color, ext);
  }
}

// scratch バッファ (光源ごとに「グロー描画 → 影で削る」を行い dest へ加算)。
const lightCv2 = document.createElement("canvas");
lightCv2.width = VIEW_W; lightCv2.height = VIEW_H;
const lightCtx2 = lightCv2.getContext("2d");

// 1 光源ぶんの寄与を dest へ加算する。
//  - scratch をクリア → グロー(放射グラデ)を着色して描く
//  - 影 ON なら 各オクルーダの影ポリゴンを黒(destination-out)で削る
//  - scratch を dest へ lighter(加算)合成
function drawOneLight(dest, scratch, lx, ly, radius, glow, color, ext) {
  // 影なしの「単純加算」では scratch を経由せず直接描いても良いが、影ありと
  // コード経路を揃えるため常に scratch 経由にする (per-light バッファ往復 = ベンチ対象)。
  scratch.globalCompositeOperation = "source-over";
  scratch.globalAlpha = 1.0;
  scratch.clearRect(0, 0, VIEW_W, VIEW_H);

  // グロー描画 (白グローを色で乗算着色)。
  scratch.save();
  scratch.globalCompositeOperation = "source-over";
  scratch.drawImage(glow, lx - radius, ly - radius);
  // 着色: source-atop で既存グロー形状に色を乗せる。
  scratch.globalCompositeOperation = "source-atop";
  scratch.fillStyle = "rgb(" + color.r + "," + color.g + "," + color.b + ")";
  scratch.fillRect(lx - radius, ly - radius, radius * 2, radius * 2);
  scratch.restore();

  // 影: シルエット背後を destination-out (アルファ=光) で削る。
  if (Game.shadowsOn) {
    scratch.save();
    scratch.globalCompositeOperation = "destination-out";
    for (let i = 0; i < occluders.length; i++) {
      const o = occluders[i];
      // 光源がオクルーダ矩形の内側にある場合は影を出さない (自己内包回避)。
      if (lx > o.x && lx < o.x + o.w && ly > o.y && ly < o.y + o.h) continue;
      castRectShadow(scratch, lx, ly, o, ext);
    }
    scratch.restore();
  }

  // dest へ加算合成。
  dest.globalCompositeOperation = "lighter";
  dest.globalAlpha = 1.0;
  dest.drawImage(scratch.canvas, 0, 0);
  dest.globalCompositeOperation = "source-over";
}

// 2) scene バッファを作る: 暗い床タイル + 柱(オクルーダ)。
function renderSceneBuffer() {
  const ctx = sceneCtx;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1.0;
  Game.tilesDrawn = 0;

  if (images.floor) {
    // 画像タイルを敷き詰める。
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        ctx.drawImage(images.floor, tx * TILE, ty * TILE, TILE, TILE);
        Game.tilesDrawn++;
      }
    }
  } else {
    // フォールバック: 暗い灰の市松タイル。
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        ctx.fillStyle = ((tx + ty) & 1) ? "#1b1b22" : "#16161c";
        ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
        Game.tilesDrawn++;
      }
    }
  }

  // 柱(オクルーダ)。壁は外周なのでスキップして内部柱のみ可視化。
  for (let i = 0; i < occluders.length; i++) {
    const o = occluders[i];
    if (o.wall) continue;
    if (images.pillar) {
      ctx.drawImage(images.pillar, o.x, o.y, o.w, o.h);
    } else {
      // 図形フォールバック: 灰の矩形 + 明るい縁。
      ctx.fillStyle = "#4a4a55";
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = "#6c6c7a";
      ctx.lineWidth = 2;
      ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
    }
  }

  // プレイヤー (アバター + ランタン)。scene 側に描いておき、light の multiply で
  // 照らされる。プレイヤー自身の光源で必ず明るく見える。
  const p = Game.player;
  if (images.player) {
    ctx.drawImage(images.player, p.x - PLAYER_W / 2, p.y - PLAYER_H / 2, PLAYER_W, PLAYER_H);
  } else {
    // 小さな人型 + 灯り。
    ctx.fillStyle = "#d8d2c0";
    ctx.fillRect(p.x - 6, p.y - 10, 12, 20);       // 胴
    ctx.beginPath();
    ctx.arc(p.x, p.y - 14, 6, 0, Math.PI * 2);     // 頭
    ctx.fillStyle = "#e8e0cc";
    ctx.fill();
    // ランタン (温色の小円)。
    ctx.beginPath();
    ctx.arc(p.x + 9, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd98a";
    ctx.fill();
  }
}

// 3) scene に light を multiply 合成し、結果を DynamicTexture へ提示。
function compositeAndPresent() {
  // scene のコピーに light を multiply で重ねる (sceneCtx を直接使う)。
  sceneCtx.save();
  sceneCtx.globalCompositeOperation = "multiply";
  sceneCtx.globalAlpha = 1.0;
  sceneCtx.drawImage(lightCv, 0, 0);
  sceneCtx.restore();

  // 合成済み 1 枚を Babylon の DynamicTexture canvas へ転送して update。
  dynCtx.globalCompositeOperation = "source-over";
  dynCtx.drawImage(sceneCv, 0, 0);
  dynTex.update(false);
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;
function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const mode = "Lightmap(canvas)"; // Babylon: DynamicTexture へ 2D 合成結果を提示
  const renderNote = assetsAllOk ? "" : "  <span style=\"color:#888\">(アセット欠落→図形描画)</span>";

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>       <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Lights</span>    <span class="hudVal">' + Game.lights.length + ' / ' + MAX_LIGHTS + '</span>' +
      '  <span class="hudLabel">+Player</span> <span class="hudVal">1</span>\n' +
    '<span class="hudLabel">Occluders</span> <span class="hudVal">' + PILLAR_REAL + '</span>\n' +
    '<span class="hudLabel">Shadows</span>   <span class="hudVal">' + (Game.shadowsOn ? "ON" : "OFF") + '</span>\n' +
    '<span class="hudLabel">Mode</span>      <span class="hudVal">' + mode + '</span>\n' +
    '<span class="hudLabel">Ambient</span>   <span class="hudVal">' + AMBIENT.toFixed(2) + '</span>' + renderNote;
}

/* =========================================================================
 *  起動: アセット読込 → 構築 → ループ開始
 * ========================================================================= */
async function boot() {
  const keysToLoad = ["floor", "pillar", "glow", "player"];
  const results = await Promise.all(keysToLoad.map((k) => loadImage(ASSET_DIR + ASSETS[k].file)));
  keysToLoad.forEach((k, idx) => {
    images[k] = results[idx];
    if (!results[idx]) assetsAllOk = false;
  });
  // glow 画像があれば、それを使った着色グローへ差し替える余地もあるが、
  // 本実装は color 乗算が要るためコード生成グロー(白)を一貫使用する。
  // (light_glow.png は提示の見た目調整用。無くても放射グラデで必ず点灯する。)

  setLightCount(INITIAL_LIGHTS);

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制 (clamp 0.05)

    // --- 更新 ---
    updatePlayer(dt);
    updateLights(dt);

    // --- ライティング合成 (本体) ---
    renderLightBuffer();   // light バッファ: ambient + 全光源加算 (影で削る)
    renderSceneBuffer();   // scene バッファ: 床 + 柱 + プレイヤー
    compositeAndPresent(); // scene ×(multiply) light → DynamicTexture へ提示

    updateHud(dt);
    scene.render();        // Babylon は全画面 Plane を 1 枚提示するだけ
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
