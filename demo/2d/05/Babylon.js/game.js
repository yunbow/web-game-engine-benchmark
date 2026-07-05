"use strict";

/* =========================================================================
 * テーマ5: 横スクロールアクション ― Babylon.js 版
 *
 * 3Dエンジン Babylon.js で 2D 横スクロールアクションを実装する。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を再現。
 *  - カメラの ortho 窓を cameraX 分だけ平行移動して横スクロールを表現。
 *  - タイルは種別ごとの SpriteManager + スプライトプールで「可視範囲のみ描画」(カリング)。
 *  - 物理エンジンは使わず、重力・軸分離AABB衝突・カメラ追従を自前実装する。
 *  - テクスチャがあれば Sprite、無ければ単色 Plane/Disc にフォールバックして必ず起動する。
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;
const TILE = 32;              // タイルサイズ px
const MAP_W = 200;            // マップ幅 (タイル)
const MAP_H = 17;             // マップ高 (タイル) → 200x17 = 6400x544
const MAP_PX_W = MAP_W * TILE; // 6400
const MAP_PX_H = MAP_H * TILE; // 544

const GRAVITY = 1800;         // px/s^2
const WALK_SPEED = 180;       // px/s
const DASH_SPEED = 288;       // px/s (×1.6)
const JUMP_VY = -640;         // ジャンプ初速 (上)
const JUMP_CUT = 0.40;        // 可変ジャンプ: キーを離した時の上昇減衰係数

// 自機 当たり判定 24x44 / 描画 32x48
const PLAYER_W = 24;
const PLAYER_H = 44;
const PLAYER_DRAW_W = 32;
const PLAYER_DRAW_H = 48;
const PLAYER_HP_INIT = 3;
const INVULN_TIME = 1.0;      // 被弾後無敵 (s)
const KNOCKBACK_VX = 220;     // 横接触ノックバック
const KNOCKBACK_VY = -260;

// 敵 (goomba) 当たり判定 28x28
const GOOMBA_W = 28;
const GOOMBA_H = 28;
const GOOMBA_SPEED = 60;      // 水平歩行 px/s
const STOMP_BOUNCE = -380;    // 踏みつけ跳ね返り
const SCORE_STOMP = 100;
const SCORE_COIN = 50;

const COIN_W = 24;

// 敵数 (負荷)
const INITIAL_ENEMIES = 20;
const ENEMY_STEP = 10;
const MIN_ENEMIES = 0;
const MAX_ENEMIES = 500;

// タイル種別: 0=空, 1=地面(ground), 2=ブロック(brick), 3=土管(pipe)
const T_EMPTY = 0, T_GROUND = 1, T_BRICK = 2, T_PIPE = 3;
const SOLID = new Set([T_GROUND, T_BRICK, T_PIPE]);

const FALL_LIMIT = MAP_PX_H + 120; // この y を超えたら穴落下扱い

/* ---------- アセット定義 ---------- */
const ASSET_DIR = "../assets/";
const ASSETS = {
  player: { file: "player_walk.png",   w: 32, h: 48, fallback: "#e23b3b", shape: "rect" },
  goomba: { file: "enemy_goomba_walk.png", w: 32, h: 32, fallback: "#8a5a2b", shape: "circle" },
  ground: { file: "tile_ground.png",   w: 32, h: 32, fallback: "#8a5a2b", shape: "rect" },
  brick:  { file: "tile_brick.png",    w: 32, h: 32, fallback: "#d9802b", shape: "rect" },
  pipe:   { file: "tile_pipe.png",     w: 32, h: 32, fallback: "#2eaa4a", shape: "rect" },
  coin:   { file: "coin.png",          w: 24, h: 24, fallback: "#ffd23f", shape: "circle" },
  bg:     { file: "bg_sky.png",        w: 512, h: 512, fallback: "#6bb7ff", shape: null },
};

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じマップ/敵配置を生成する。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- マップ決定的生成 ---------- */
// 最下段は地面、所々に穴(gap)、空中にブロック足場、地上に土管、左右端は壁。
const GROUND_TOP = MAP_H - 2; // 地面の上面行 (最下段=床, その上1行も床にする)
function generateMap() {
  const rnd = mulberry32(0xB17A);
  const map = new Uint8Array(MAP_W * MAP_H);
  const set = (tx, ty, v) => { if (tx >= 0 && tx < MAP_W && ty >= 0 && ty < MAP_H) map[ty * MAP_W + tx] = v; };

  // --- 最下段 2 行を地面で埋める。所々に幅1の穴を空ける(連続穴を防ぐ) ---
  let x = 0;
  while (x < MAP_W) {
    const run = 5 + Math.floor(rnd() * 6);
    for (let i = 0; i < run && x < MAP_W; i++, x++) {
      set(x, GROUND_TOP, T_GROUND);
      set(x, GROUND_TOP + 1, T_GROUND);
    }
    if (x > 6 && x < MAP_W - 6 && rnd() < 0.30) x += 1; // 幅1の穴を1つだけ
  }

  // --- 空中のブロック足場: ジャンプ頂点より上(py<=9)に置き、走路に天井を作らない ---
  for (let i = 0; i < MAP_W; i++) {
    if (i < 4 || i > MAP_W - 4) continue;
    if (rnd() < 0.14) {
      const py = 4 + Math.floor(rnd() * 6); // 4..9
      const plen = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < plen && i + k < MAP_W - 2; k++) {
        if (map[py * MAP_W + (i + k)] === T_EMPTY) set(i + k, py, T_BRICK);
      }
      i += plen; // 連続配置を避ける
    }
  }

  // --- 地上の土管 (高さ 2〜3)。穴の近く(±4)には置かない(越えジャンプが穴に着地するため) ---
  const noGapNear = (cx) => {
    for (let g = cx - 4; g <= cx + 5; g++) if (g < 0 || g >= MAP_W || map[GROUND_TOP * MAP_W + g] !== T_GROUND) return false;
    return true;
  };
  for (let i = 8; i < MAP_W - 4; i++) {
    if (rnd() < 0.05) {
      if (map[GROUND_TOP * MAP_W + i] === T_GROUND && noGapNear(i)) {
        const ph = 2 + Math.floor(rnd() * 2);
        for (let k = 1; k <= ph; k++) set(i, GROUND_TOP - k, T_PIPE);
        i += 2;
      }
    }
  }

  // --- 左右端は壁 ---
  for (let ty = 0; ty < MAP_H; ty++) {
    set(0, ty, T_GROUND);
    set(MAP_W - 1, ty, T_GROUND);
  }

  return map;
}

function tileAt(map, tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return T_GROUND; // 外周は壁扱い
  return map[ty * MAP_W + tx];
}
function isSolidAt(map, tx, ty) {
  return SOLID.has(tileAt(map, tx, ty));
}

/* =========================================================================
 *  Babylon セットアップ
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.42, 0.72, 1.0, 1.0); // 空色 (背景フォールバック)
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) ---
// orthoTop < orthoBottom で y 下向きの 2D 画面に一致させる。
// 横スクロールは camera.position.x を cameraX 分だけ動かして表現する。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(0, 0, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

// sprite/plane が見えるよう環境光 (マテリアルは emissive/unlit だが念のため)
const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
amb.intensity = 1.0;

/* ---------- テクスチャ存在チェック ---------- */
// SpriteManager は読込失敗時に黒テクスチャになるので、事前に Image で存在確認する。
function checkImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

// テクスチャがあれば Sprite、無ければ Plane/Disc を使う統一ラッパを構築する。
const managers = {}; // key -> SpriteManager or null
const SPRITE_CAPACITY = 4096;

function makeManager(key, capacity) {
  const a = ASSETS[key];
  const sm = new BABYLON.SpriteManager(
    "sm_" + key, ASSET_DIR + a.file, capacity || SPRITE_CAPACITY,
    { width: a.w, height: a.h }, scene
  );
  sm.isPickable = false;
  return sm;
}

// フォールバック用 単色マテリアル (共有)
const fallbackMats = {};
function fallbackMat(key) {
  if (fallbackMats[key]) return fallbackMats[key];
  const a = ASSETS[key];
  const m = new BABYLON.StandardMaterial("fm_" + key, scene);
  const c = BABYLON.Color3.FromHexString(a.fallback || "#888888");
  m.emissiveColor = c;
  m.diffuseColor = c;
  m.specularColor = new BABYLON.Color3(0, 0, 0);
  m.disableLighting = true;
  m.backFaceCulling = false;
  fallbackMats[key] = m;
  return m;
}

// テンプレ mesh (矩形 or 円)。インスタンス毎に clone する。
const fallbackTemplates = {};
function fallbackTemplate(key) {
  if (fallbackTemplates[key]) return fallbackTemplates[key];
  const a = ASSETS[key];
  let mesh;
  if (a.shape === "circle") {
    mesh = BABYLON.MeshBuilder.CreateDisc("ft_" + key, { radius: 0.5, tessellation: 18 }, scene);
  } else {
    // 1x1 の Plane を基準にし、scaling で実サイズへ
    mesh = BABYLON.MeshBuilder.CreatePlane("ft_" + key, { width: 1, height: 1 }, scene);
  }
  mesh.material = fallbackMat(key);
  mesh.isPickable = false;
  mesh.setEnabled(false);
  fallbackTemplates[key] = mesh;
  return mesh;
}

/* ---------- 統一スプライトラッパ ----------
 * { setPos(x,y,z), setVisible(b), setSize(w,h), dispose() }
 * 座標は画面/ワールド px をそのまま渡す (ortho が px 等倍なので変換不要)。
 */
function createEntitySprite(key) {
  const a = ASSETS[key];
  if (managers[key]) {
    const sp = new BABYLON.Sprite("s_" + key, managers[key]);
    sp.width = a.w;
    sp.height = a.h;
    return {
      kind: "sprite", obj: sp,
      setPos(x, y, z) { sp.position.x = x; sp.position.y = y; sp.position.z = (z == null ? 0 : z); },
      setVisible(b) { sp.isVisible = b; },
      setSize(w, h) { sp.width = w; sp.height = h; },
      setFrame(i) { sp.cellIndex = i; },
      dispose() { sp.dispose(); },
    };
  } else {
    const mesh = fallbackTemplate(key).clone("c_" + key);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    return {
      kind: "mesh", obj: mesh,
      setPos(x, y, z) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = (z == null ? 0 : z); },
      setVisible(b) { mesh.setEnabled(b); },
      setSize(w, h) { mesh.scaling.x = w; mesh.scaling.y = h; },
      setFrame() {},
      dispose() { mesh.dispose(); },
    };
  }
}

/* =========================================================================
 *  背景 (空) ― ortho 窓に追従させて常に画面を覆う
 * ========================================================================= */
let bgSprite = null;
function setupBackground() {
  bgSprite = createEntitySprite("bg");
  bgSprite.setSize(VIEW_W, VIEW_H);
  bgSprite.setPos(VIEW_W / 2, VIEW_H / 2, 60); // 一番奥
}
function updateBackground(cameraX) {
  // カメラ(ortho)が cameraX 動くので、背景も同量動かして画面を覆い続ける。
  if (bgSprite) bgSprite.setPos(cameraX + VIEW_W / 2, VIEW_H / 2, 60);
}

/* =========================================================================
 *  ゲーム状態
 * ========================================================================= */
const map = generateMap();

const Game = {
  player: null,
  enemies: [],   // {spr,x,y,vx,vy,dir,grounded,alive}
  coins: [],     // {spr,x,y,taken}
  effects: [],   // 撃破スパーク {spr,x,y,life,maxLife}
  score: 0,
  coinsCollected: 0,
  hp: PLAYER_HP_INIT,
  cameraX: 0,
  enemySetting: INITIAL_ENEMIES, // 設定上の敵数
  tilesDrawn: 0,
  over: false,
};

// タイトル/アトラクト状態 (false=デモ中・操作無効, デモAIが自機を駆動)
let started = false;
let blinkT = 0;
const titleEl = document.getElementById("title");

// スポーン地点 (左の安全地帯)
const SPAWN_TX = 2;
const SPAWN_TY = GROUND_TOP - 3;
const spawnPx = SPAWN_TX * TILE + TILE / 2;
const spawnPy = SPAWN_TY * TILE + PLAYER_H / 2;

/* ---------- プール (撃破スパーク) ---------- */
const sparkPool = [];
function getSpark() {
  let s = sparkPool.pop();
  if (!s) s = createEntitySprite("coin"); // 黄色い小円を流用
  s.setVisible(true);
  return s;
}
function returnSpark(s) {
  s.setVisible(false);
  s.setPos(-9999, -9999);
  sparkPool.push(s);
}

/* =========================================================================
 *  プレイヤー初期化
 * ========================================================================= */
function initPlayer() {
  const spr = createEntitySprite("player");
  spr.setSize(PLAYER_DRAW_W, PLAYER_DRAW_H);
  Game.player = {
    spr, x: spawnPx, y: spawnPy,
    vx: 0, vy: 0,
    grounded: false,
    facing: 1,
    invuln: 0,
  };
  spr.setPos(Game.player.x, Game.player.y, -3);
}

function respawnPlayer() {
  // 穴落下 or HP0 でスポーン地点へ復帰。スコア・敵は保持 (ベンチ継続)。
  const p = Game.player;
  p.x = spawnPx; p.y = spawnPy;
  p.vx = 0; p.vy = 0;
  p.grounded = false;
  p.invuln = INVULN_TIME;
  Game.hp = PLAYER_HP_INIT;
  Game.cameraX = clampCameraX(p.x - VIEW_W / 2);
}

/* =========================================================================
 *  敵 (goomba) / コイン ― 決定的に配置
 * ========================================================================= */
// 足場のある地形 (直下が solid) のタイルを決定的に列挙する。
function buildSpawnSlots() {
  const slots = [];
  const rnd = mulberry32(0x60BA);
  for (let tx = 4; tx < MAP_W - 4; tx++) {
    // 上から見て、空タイルの直下が solid な位置を候補にする
    for (let ty = 1; ty < MAP_H - 1; ty++) {
      if (tileAt(map, tx, ty) === T_EMPTY && isSolidAt(map, tx, ty + 1)) {
        // 確率で候補化 (決定的)
        if (rnd() < 0.5) slots.push({ tx, ty });
        break; // 各列で一番上の地面のみ
      }
    }
  }
  return slots;
}
const spawnSlots = buildSpawnSlots();

function makeEnemy(slot) {
  const spr = createEntitySprite("goomba");
  spr.setSize(GOOMBA_W, GOOMBA_H);
  const e = {
    spr,
    x: slot.tx * TILE + TILE / 2,
    y: slot.ty * TILE + GOOMBA_H / 2,
    vx: -GOOMBA_SPEED,
    vy: 0,
    dir: -1,
    grounded: false,
    alive: true,
    slot,
  };
  spr.setPos(e.x, e.y, -2);
  return e;
}

// 設定値 n に合わせて敵を決定的に再構築する (穴落下分は再生成されない単純実装)。
function setEnemyCount(n) {
  n = Math.max(MIN_ENEMIES, Math.min(MAX_ENEMIES, n));
  Game.enemySetting = n;
  // 既存を全破棄して決定的に作り直す (同じスロット順 → 決定的)
  for (const e of Game.enemies) e.spr.dispose();
  Game.enemies.length = 0;
  for (let i = 0; i < n; i++) {
    const slot = spawnSlots[i % spawnSlots.length];
    // スロットを使い切る場合は x を少しずらして重なりを避ける
    const rep = Math.floor(i / spawnSlots.length);
    const e = makeEnemy(slot);
    if (rep > 0) e.x += rep * (TILE * 0.5);
    Game.enemies.push(e);
  }
}

// コインを決定的に配置 (足場候補の一部を採用)。
function buildCoins() {
  const rnd = mulberry32(0xC0FE);
  for (let i = 0; i < spawnSlots.length; i++) {
    const s = spawnSlots[i];
    if (rnd() < 0.45) {
      const spr = createEntitySprite("coin");
      spr.setSize(COIN_W, COIN_W);
      const x = s.tx * TILE + TILE / 2;
      const y = (s.ty - 1) * TILE + TILE / 2; // 足場の少し上
      spr.setPos(x, y, -2);
      Game.coins.push({ spr, x, y, taken: false });
    }
  }
}

/* =========================================================================
 *  入力
 * ========================================================================= */
const keys = Object.create(null);
window.addEventListener("keydown", (ev) => {
  const k = ev.key.toLowerCase();
  keys[k] = true;
  if (ev.key === "+" || ev.key === "=" || ev.key === "Add") {
    setEnemyCount(Game.enemySetting + ENEMY_STEP);
  } else if (ev.key === "-" || ev.key === "_" || ev.key === "Subtract") {
    setEnemyCount(Game.enemySetting - ENEMY_STEP);
  }
  if (ev.code === "Enter" && !started) { startGame(); ev.preventDefault(); }
  if (Game.over && ev.key === "Enter") restart();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) ev.preventDefault();
});
window.addEventListener("keyup", (ev) => { keys[ev.key.toLowerCase()] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });
canvas.addEventListener("click", () => { if (Game.over) restart(); canvas.focus(); });
// フォーカスしてキー入力を確実に受ける
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

/* =========================================================================
 *  AABB タイル衝突 (軸分離)
 * ========================================================================= */
// 矩形 (cx,cy 中心 / w,h) が solid タイルと重なるか
function rectHitsSolid(cx, cy, w, h) {
  const left = cx - w / 2, right = cx + w / 2;
  const top = cy - h / 2, bottom = cy + h / 2;
  const tx0 = Math.floor(left / TILE);
  const tx1 = Math.floor((right - 0.0001) / TILE);
  const ty0 = Math.floor(top / TILE);
  const ty1 = Math.floor((bottom - 0.0001) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (isSolidAt(map, tx, ty)) return true;
    }
  }
  return false;
}

// body: {x,y,vx,vy,grounded} を w,h と dt で動かし、x→y の順に軸分離解決する。
function moveBody(body, w, h, dt) {
  body.grounded = false;

  // --- X 軸 ---
  let nx = body.x + body.vx * dt;
  if (rectHitsSolid(nx, body.y, w, h)) {
    // 衝突: タイル境界まで寄せて停止
    if (body.vx > 0) {
      const right = nx + w / 2;
      const wall = Math.floor((right - 0.0001) / TILE) * TILE;
      nx = wall - w / 2 - 0.001;
    } else if (body.vx < 0) {
      const left = nx - w / 2;
      const wall = (Math.floor(left / TILE) + 1) * TILE;
      nx = wall + w / 2 + 0.001;
    }
    body.vx = 0;
    body.hitWallX = true;
  } else {
    body.hitWallX = false;
  }
  body.x = nx;

  // --- Y 軸 ---
  let ny = body.y + body.vy * dt;
  if (rectHitsSolid(body.x, ny, w, h)) {
    if (body.vy > 0) {
      // 落下中に着地
      const bottom = ny + h / 2;
      const floor = Math.floor((bottom - 0.0001) / TILE) * TILE;
      ny = floor - h / 2 - 0.001;
      body.grounded = true;
    } else if (body.vy < 0) {
      // 上昇中に頭打ち
      const top = ny - h / 2;
      const ceil = (Math.floor(top / TILE) + 1) * TILE;
      ny = ceil + h / 2 + 0.001;
    }
    body.vy = 0;
  }
  body.y = ny;
}

/* ---------- カメラ ---------- */
function clampCameraX(x) {
  return Math.max(0, Math.min(MAP_PX_W - VIEW_W, x));
}

/* ---------- AABB 重なり (エンティティ同士) ---------- */
function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return Math.abs(ax - bx) < (aw + bw) / 2 && Math.abs(ay - by) < (ah + bh) / 2;
}

/* =========================================================================
 *  更新
 * ========================================================================= */
function update(dt) {
  if (Game.over) return;
  const p = Game.player;

  /* --- 自機: 入力 → 水平速度 --- */
  // !started (アトラクト) 中はデモAIで右走行＋障害/穴で自動ジャンプ。キー入力は無視。
  let dir = 0;
  let jumpKey = false;
  let speed = WALK_SPEED;
  if (!started) {
    // 中心座標(p.x,p.y) → 左上原点ビューに変換して three.js と同一ロジックの demoAI へ
    const view = {
      x: p.x - PLAYER_W / 2, y: p.y - PLAYER_H / 2,
      w: PLAYER_W, h: PLAYER_H, vy: p.vy, onGround: p.grounded,
    };
    const d = demoAI(view);
    dir = d.move;
    jumpKey = d.jump;
  } else {
    if (keys["arrowleft"] || keys["a"]) dir -= 1;
    if (keys["arrowright"] || keys["d"]) dir += 1;
    const dashing = !!keys["shift"];
    speed = dashing ? DASH_SPEED : WALK_SPEED;
    jumpKey = keys[" "] || keys["arrowup"] || keys["w"];
  }
  p.vx = dir * speed;
  if (dir !== 0) p.facing = dir;

  // ジャンプ (接地時のみ)
  if (jumpKey && p.grounded) {
    p.vy = JUMP_VY;
    p.grounded = false;
  }
  // 可変ジャンプ: 上昇中にジャンプキーを離したら上昇を減衰
  if (!jumpKey && p.vy < 0) {
    p.vy *= JUMP_CUT;
  }

  // 重力
  p.vy += GRAVITY * dt;
  if (p.vy > 1400) p.vy = 1400; // 終端速度クランプ (すり抜け防止)

  // 軸分離 AABB 移動
  moveBody(p, PLAYER_W, PLAYER_H, dt);

  // 無敵タイマー
  if (p.invuln > 0) p.invuln -= dt;

  // 穴落下 → HP-1 + 復帰 (HP0 でも respawnPlayer が HP を3に戻す)
  if (p.y > FALL_LIMIT) {
    Game.hp -= 1;
    respawnPlayer();
  }

  /* --- 敵更新 --- */
  for (const e of Game.enemies) {
    if (!e.alive) continue;
    e.vx = e.dir * GOOMBA_SPEED;
    e.vy += GRAVITY * dt;
    if (e.vy > 1400) e.vy = 1400;
    moveBody(e, GOOMBA_W, GOOMBA_H, dt);
    // 壁で反転
    if (e.hitWallX) e.dir = -e.dir;
    // 任意: ガケ落下回避 (進行方向の足元が空なら反転)
    if (e.grounded) {
      const footX = e.x + e.dir * (GOOMBA_W / 2 + 2);
      const footTy = Math.floor((e.y + GOOMBA_H / 2 + 2) / TILE);
      const footTx = Math.floor(footX / TILE);
      if (!isSolidAt(map, footTx, footTy)) e.dir = -e.dir;
    }
    // 場外落下した敵は次フレームで非表示にするだけ (設定数保持のため alive 維持)
  }

  /* --- 自機 × 敵 衝突 (踏みつけ / 横接触) --- */
  for (const e of Game.enemies) {
    if (!e.alive) continue;
    if (!aabbOverlap(p.x, p.y, PLAYER_W, PLAYER_H, e.x, e.y, GOOMBA_W, GOOMBA_H)) continue;

    // 踏みつけ判定: 自機が落下中 (vy>0) かつ自機下端が敵上半分にある
    const playerBottom = p.y + PLAYER_H / 2;
    const enemyTop = e.y - GOOMBA_H / 2;
    if (p.vy > 0 && playerBottom < e.y + GOOMBA_H * 0.4) {
      // 撃破
      e.alive = false;
      e.spr.setVisible(false);
      Game.score += SCORE_STOMP;
      spawnSpark(e.x, e.y);
      p.vy = STOMP_BOUNCE; // 跳ねる
    } else if (p.invuln <= 0) {
      // 横接触 → 被弾
      damagePlayer(e);
    }
  }

  /* --- 自機 × コイン --- */
  for (const c of Game.coins) {
    if (c.taken) continue;
    if (aabbOverlap(p.x, p.y, PLAYER_W, PLAYER_H, c.x, c.y, COIN_W, COIN_W)) {
      c.taken = true;
      c.spr.setVisible(false);
      Game.coinsCollected += 1;
      Game.score += SCORE_COIN;
    }
  }

  /* --- スパーク (撃破エフェクト) --- */
  for (let i = Game.effects.length - 1; i >= 0; i--) {
    const f = Game.effects[i];
    f.life -= dt;
    f.y -= 60 * dt;
    if (f.life <= 0) {
      returnSpark(f.spr);
      Game.effects.splice(i, 1);
    }
  }

  /* --- カメラ追従 (自機を概ね中央, x をクランプ) --- */
  Game.cameraX = clampCameraX(p.x - VIEW_W / 2);
}

function spawnSpark(x, y) {
  const s = getSpark();
  s.setSize(14, 14);
  s.setPos(x, y, -4);
  Game.effects.push({ spr: s, x, y, life: 0.30, maxLife: 0.30 });
}

function damagePlayer(e) {
  const p = Game.player;
  Game.hp -= 1;
  p.invuln = INVULN_TIME;
  // ノックバック (敵と反対方向へ)
  const kdir = (p.x < e.x) ? -1 : 1;
  p.vx = kdir * KNOCKBACK_VX;
  p.vy = KNOCKBACK_VY;
  if (Game.hp <= 0) respawnPlayer();
}

function restart() {
  Game.score = 0;
  Game.coinsCollected = 0;
  Game.hp = PLAYER_HP_INIT;
  Game.over = false;
  respawnPlayer();
  for (const c of Game.coins) { c.taken = false; c.spr.setVisible(true); }
  setEnemyCount(Game.enemySetting);
  document.getElementById("gameover").style.display = "none";
}

// Enter でデモ→プレイ開始: スコア等を新規リセットして操作を有効化、タイトルを消す
function startGame() {
  started = true;
  Game.score = 0;
  Game.coinsCollected = 0;
  for (const c of Game.coins) { c.taken = false; c.spr.setVisible(true); }
  setEnemyCount(INITIAL_ENEMIES);
  respawnPlayer();
  titleEl.style.display = "none";
}

/* ---------- デモAI (決定的): 右走行 + 接地時に前方の障害/穴で自動ジャンプ ----------
 * 三段重要: Babylon は p.x/p.y を中心座標で持つが、デモAIは three.js と同一ロジック
 * (画面座標・Y下向き・左上原点 x/y/w/h/vy/onGround) で動かす。中心→左上に変換した
 * ビュー p を渡す。tileAt/SOLID/TILE は既存定義を再利用する。
 */
function demoAI(p) {
  const aheadX = p.x + p.w + 4;
  const midY = p.y + p.h * 0.5;
  const footY = p.y + p.h - 2;
  const wallAhead = SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(midY / TILE)))
                 || SOLID.has(tileAt(map, Math.floor(aheadX / TILE), Math.floor(footY / TILE)));
  const gapProbeX = p.x + p.w + TILE * 1.2;
  const belowTy = Math.floor((p.y + p.h + TILE * 0.5) / TILE);
  const gapAhead = p.onGround && !SOLID.has(tileAt(map, Math.floor(gapProbeX / TILE), belowTy));
  let jump = false;
  if (p.onGround) jump = wallAhead || gapAhead;
  else if (p.vy < 0) jump = true; // 上昇中は保持 (可変ジャンプを伸ばす)
  return { move: 1, jump };
}

/* =========================================================================
 *  描画: 可視タイルのカリング
 * ========================================================================= */
// 種別ごとの SpriteManager/フォールバックと、再利用するスプライトプールを持つ。
const tilePools = {}; // type -> { def, pool:[], used }
const tileKeyByType = { [T_GROUND]: "ground", [T_BRICK]: "brick", [T_PIPE]: "pipe" };

function initTilePools() {
  for (const t of [T_GROUND, T_BRICK, T_PIPE]) {
    tilePools[t] = { key: tileKeyByType[t], pool: [], used: 0 };
  }
}

function renderVisibleTiles() {
  // カメラ可視範囲のタイル列範囲を求める (cameraX 起点)
  const x0 = Math.max(0, Math.floor(Game.cameraX / TILE) - 1);
  const x1 = Math.min(MAP_W - 1, Math.floor((Game.cameraX + VIEW_W) / TILE) + 1);
  // 縦は全行 (画面≒マップ高) だが一応 0..MAP_H
  const y0 = 0, y1 = MAP_H - 1;

  for (const t in tilePools) tilePools[t].used = 0;

  Game.tilesDrawn = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const type = map[ty * MAP_W + tx];
      if (type === T_EMPTY) continue;
      const tp = tilePools[type];
      const idx = tp.used++;
      let spr = tp.pool[idx];
      if (!spr) {
        spr = createEntitySprite(tp.key);
        spr.setSize(TILE, TILE);
        tp.pool[idx] = spr;
      }
      spr.setVisible(true);
      // タイル中心 (画面/ワールド px = ortho px なのでそのまま)
      spr.setPos(tx * TILE + TILE / 2, ty * TILE + TILE / 2, 0);
      Game.tilesDrawn++;
    }
  }
  // 余ったプールを隠す
  for (const t in tilePools) {
    const tp = tilePools[t];
    for (let i = tp.used; i < tp.pool.length; i++) tp.pool[i].setVisible(false);
  }
}

/* ---------- 描画位置の更新 (自機/敵/コイン) ----------
 * ortho 窓は cameraX に追従させるので、エンティティは「ワールド px」をそのまま置く。
 * 視野外の敵/コインは isVisible=false で描画から外す (簡易カリング)。
 */
function renderEntities() {
  const p = Game.player;
  // 自機: 無敵中は点滅
  const blink = (p.invuln > 0) && (Math.floor(p.invuln * 12) % 2 === 0);
  p.spr.setVisible(!blink);
  p.spr.setFrame((p.facing < 0 ? 4 : 0) + (Math.abs(p.vx) > 5 && p.grounded ? Math.floor(performance.now() / 110) % 4 : 0));
  p.spr.setPos(p.x, p.y, -3);

  const left = Game.cameraX - TILE;
  const right = Game.cameraX + VIEW_W + TILE;

  for (const e of Game.enemies) {
    if (!e.alive) { e.spr.setVisible(false); continue; }
    if (e.x < left || e.x > right || e.y > FALL_LIMIT) { e.spr.setVisible(false); continue; }
    e.spr.setVisible(true);
    e.spr.setFrame((e.vx < 0 ? 4 : 0) + (Math.floor((performance.now() / 140) + e.x * 0.01) % 4));
    e.spr.setPos(e.x, e.y, -2);
  }
  for (const c of Game.coins) {
    if (c.taken) continue;
    if (c.x < left || c.x > right) { c.spr.setVisible(false); continue; }
    c.spr.setVisible(true);
    c.spr.setPos(c.x, c.y, -2);
  }
  for (const f of Game.effects) {
    f.spr.setPos(f.x, f.y, -4);
  }
}

/* ---------- カメラ ortho 窓の平行移動 (横スクロール) ---------- */
function applyCamera() {
  // orthoLeft/Right を cameraX 分シフトして窓を動かす。
  camera.orthoLeft = Game.cameraX;
  camera.orthoRight = Game.cameraX + VIEW_W;
  camera.position.x = Game.cameraX + VIEW_W / 2;
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;
function liveEnemyCount() {
  let n = 0;
  for (const e of Game.enemies) if (e.alive) n++;
  return n;
}
function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const p = Game.player;
  const ptx = Math.floor(p.x / TILE);
  const pty = Math.floor(p.y / TILE);
  const liveEnemies = liveEnemyCount();
  const entities = liveEnemies + Game.coins.filter((c) => !c.taken).length;
  const renderMode = managers.player ? "Sprite(tex)" : "Plane(fallback)";

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>         <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Tiles drawn</span> <span class="hudVal">' + Game.tilesDrawn + '</span>' +
      '  <span class="hudLabel">Entities</span> <span class="hudVal">' + entities + '</span>\n' +
    '<span class="hudLabel">Player</span>      <span class="hudVal">(' + ptx + ', ' + pty + ')</span>\n' +
    '<span class="hudLabel">Score</span> <span class="hudVal">' + Game.score + '</span>' +
      '  <span class="hudLabel">Coins</span> <span class="hudVal">' + Game.coinsCollected + '</span>' +
      '  <span class="hudLabel">HP</span> <span class="hudVal">' + Game.hp + ' / ' + PLAYER_HP_INIT + '</span>\n' +
    '<span class="hudLabel">Enemies</span>     <span class="hudVal">' + liveEnemies + ' / ' + Game.enemySetting + '</span>\n' +
    '<span class="warn">Render</span>      <span class="hudVal">' + renderMode + '</span>' +
      (assetsAllOk ? '' : '  <span style="color:#888">(一部/全アセット欠落→図形描画)</span>');
}

/* =========================================================================
 *  起動: アセット確認 → 構築 → ループ開始
 * ========================================================================= */
let assetsAllOk = true;

async function boot() {
  const keysToCheck = ["player", "goomba", "ground", "brick", "pipe", "coin", "bg"];
  const results = await Promise.all(
    keysToCheck.map((k) => checkImage(ASSET_DIR + ASSETS[k].file))
  );
  keysToCheck.forEach((k, idx) => {
    if (results[idx]) {
      try { managers[k] = makeManager(k); }
      catch (e) { managers[k] = null; assetsAllOk = false; }
    } else {
      managers[k] = null;
      assetsAllOk = false;
    }
  });

  setupBackground();
  initTilePools();
  initPlayer();
  buildCoins();
  setEnemyCount(INITIAL_ENEMIES);

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制 (SPEC: clamp 0.05)
    update(dt);
    applyCamera();
    updateBackground(Game.cameraX);
    renderVisibleTiles();
    renderEntities();
    updateHud(dt);
    scene.render();

    // タイトル点滅 (アトラクト中のみ)
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
    }
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
