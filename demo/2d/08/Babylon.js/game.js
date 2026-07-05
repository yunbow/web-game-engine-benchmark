"use strict";

/* =========================================================================
 * テーマ8: パーティクル / 魔法エフェクトデモ ― Babylon.js 版
 *
 * Babylon.js の組込パーティクル機構で「加算合成・大量パーティクル」のスループットを測る。
 *  - GPUParticleSystem.IsSupported が true なら GPUParticleSystem を優先採用。
 *    非対応(WebGL2なし等)なら CPU ParticleSystem に自動フォールバックする。
 *  - すべて BLENDMODE_ADD(加算) で発光感を出す。B キーで NORMAL(通常) と切替。
 *  - 寿命に沿って size:大→小 / alpha:1→0 / 色:暖色→寒色 をグラデ(addSizeGradient/
 *    addColorGradient)で表現する。
 *  - 描画は正射影(Orthographic)カメラで 2D スクリーン座標 (0,0)=左上 / (960,540)=右下。
 *  - パーティクルテクスチャは ../assets/particle_spark.png を試し、無ければ DynamicTexture で
 *    中心白の放射状グロー(ラジアルグラデ)を生成してフォールバック。必ず起動する。
 *
 *  常設エミッタ : 決定的軌道で周回する 4 個の発光オーブ(各 連続スパーク噴出)
 *  マウス移動   : カーソル追従トレイルエミッタ
 *  左クリック   : 着弾点で 120〜200 個の放射バースト(manualEmitCount)
 *  Space        : オート花火トグル(0.5s 間隔で決定的位置にバースト, マウス不要)
 *  + / -        : 目標同時パーティクル上限を ±2000 (500..50000)。emitRate/capacity を調整。
 *  R            : リセット
 * ========================================================================= */

(function () {

/* ---------- 定数 (SPEC 準拠) ---------- */
const VIEW_W = 960;
const VIEW_H = 540;
const CLEAR = new BABYLON.Color4(0x08 / 255, 0x08 / 255, 0x0f / 255, 1.0); // 暗色背景 #08080f

const ORB_COUNT = 4;            // 常設周回オーブ数
const LIFE_MIN = 0.6;           // パーティクル寿命 最小 (s)
const LIFE_MAX = 1.4;           // パーティクル寿命 最大 (s)

const TARGET_INIT = 2000;       // 目標同時パーティクル上限 初期
const TARGET_STEP = 2000;       // +/- の増減幅
const TARGET_MIN = 500;
const TARGET_MAX = 50000;

const BURST_MIN = 120;          // クリック/花火の一度の放出数
const BURST_MAX = 200;
const AUTO_INTERVAL = 0.5;      // オート花火の間隔 (s)

/* ---------- アセット定義 ---------- */
const ASSET_DIR = "../assets/";
const SPARK_FILE = "particle_spark.png"; // 火花(中心白の放射状グロー前提)

/* ---------- 決定的擬似乱数 (mulberry32) ---------- */
// Math.random は使わず固定シードで毎回同じ軌道/花火位置を生成する(ベンチの再現性)。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 花火位置用の決定的シーケンス(オート花火で毎回同じ並び)
const fireRnd = mulberry32(0xF17E);

/* =========================================================================
 *  Babylon セットアップ
 * ========================================================================= */
const canvas = document.getElementById("renderCanvas");
const hudEl = document.getElementById("hud");
const engine = new BABYLON.Engine(canvas, true, {
  preserveDrawingBuffer: false, stencil: false,
}, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = CLEAR;
scene.skipPointerMovePicking = true;
scene.autoClear = true;

// --- 正射影カメラ: 画面座標 (x:0..960 右へ, y:0..540 下へ) を再現 ---
// orthoTop < orthoBottom で y 下向きの 2D 画面に一致させる。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(VIEW_W / 2, VIEW_H / 2, -100), scene);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft = 0;
camera.orthoRight = VIEW_W;
camera.orthoTop = 0;
camera.orthoBottom = VIEW_H;
camera.setTarget(new BABYLON.Vector3(VIEW_W / 2, VIEW_H / 2, 0));
camera.minZ = 0.1;
camera.maxZ = 1000;

/* =========================================================================
 *  パーティクルテクスチャ
 *  - particle_spark.png があれば採用。
 *  - 無ければ DynamicTexture に放射状(ラジアル)グラデの白丸を描いて代替。
 *    加算合成前提なので中心=白(不透明) → 外周=透明 のグローにする。
 * ========================================================================= */
let usingTextureAsset = false;

function makeRadialGlowTexture() {
  const size = 64;
  const dt = new BABYLON.DynamicTexture("sparkGlow", { width: size, height: size }, scene, false);
  const ctx = dt.getContext();
  const cx = size / 2, cy = size / 2, r = size / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  // 中心は明るい白、外へ向かって減衰(加算で重なるほど白飛びして発光)
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.30)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  dt.hasAlpha = true;
  dt.update();
  return dt;
}

// 画像存在チェック(失敗時は黒テクスチャになるので Image で事前確認)
function checkImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

let particleTexture = null; // 全システム共有

/* =========================================================================
 *  パーティクルシステム生成ラッパ
 *  - GPUParticleSystem.IsSupported が true なら GPU、無理なら CPU。
 *  - capacity はシステムごとの最大同時数。emitRate は 1 秒あたりの生成数。
 *  - 全システムの capacity/emitRate を合算して「目標上限」付近に収める。
 * ========================================================================= */
let USE_GPU = false; // boot 時に確定

// 共通の見た目(寿命に沿う size/alpha/色グラデ)を設定する。
function applyCommonLook(ps) {
  ps.particleTexture = particleTexture;
  ps.blendMode = currentBlend; // ADD / STANDARD

  // 寿命: 0.6〜1.4s
  ps.minLifeTime = LIFE_MIN;
  ps.maxLifeTime = LIFE_MAX;

  // emitRate は後で目標数に合わせて上書きする
  ps.emitRate = 100;

  // 重力(下向き=+y)を軽く。screen は y 下向きなので正で落ちる。
  ps.gravity = new BABYLON.Vector3(0, 120, 0);

  // --- サイズ: 大→小 (addSizeGradient) ---
  // emitRate ベースのスケール。最小/最大は emitter ごとに調整する。
  ps.minSize = 6;
  ps.maxSize = 14;
  ps.addSizeGradient(0.0, 1.0, 1.4);   // 誕生直後は大きめ(揺らぎ)
  ps.addSizeGradient(1.0, 0.05, 0.15); // 寿命末で極小

  // --- 色: 暖色(白〜橙) → 寒色(青紫) → 透明 (addColorGradient) ---
  // 加算合成なので alpha=1→0 のフェードで自然に消える。
  ps.addColorGradient(0.0, new BABYLON.Color4(1.0, 0.95, 0.70, 1.0)); // 暖白
  ps.addColorGradient(0.35, new BABYLON.Color4(1.0, 0.55, 0.20, 0.9)); // 橙
  ps.addColorGradient(0.7, new BABYLON.Color4(0.35, 0.45, 1.0, 0.5));  // 寒(青)
  ps.addColorGradient(1.0, new BABYLON.Color4(0.20, 0.10, 0.60, 0.0)); // 青紫→透明

  ps.minEmitPower = 40;
  ps.maxEmitPower = 140;
  ps.updateSpeed = 0.016;
}

// GPU/CPU いずれかでシステムを作る統一ファクトリ。
function createSystem(name, capacity) {
  let ps;
  if (USE_GPU) {
    ps = new BABYLON.GPUParticleSystem(name, { capacity: capacity }, scene);
  } else {
    ps = new BABYLON.ParticleSystem(name, capacity, scene);
  }
  applyCommonLook(ps);
  return ps;
}

/* =========================================================================
 *  状態
 * ========================================================================= */
let currentBlend = BABYLON.ParticleSystem.BLENDMODE_ADD; // 初期は加算
let targetCap = TARGET_INIT;     // 目標同時パーティクル上限
let autoFireworks = false;       // Space トグル
let autoTimer = 0;               // オート花火タイマ
const mouse = { x: VIEW_W / 2, y: VIEW_H / 2, inside: false };

// 全システムをまとめて保持(getActiveCount 合算 / blend 切替 / dispose 用)
const allSystems = [];

/* ---------- 周回オーブ(常設エミッタ) ---------- */
// 各オーブは決定的な円/正弦の合成軌道で画面内を周回し、連続スパークを噴く。
const orbs = []; // { ps, cx, cy, rx, ry, w, phase, x, y }

function buildOrbs() {
  const rnd = mulberry32(0x0B12);
  for (let i = 0; i < ORB_COUNT; i++) {
    // 画面中央付近を中心に、それぞれ異なる半径/角速度/位相で回す。
    const cx = VIEW_W * (0.30 + 0.40 * rnd());
    const cy = VIEW_H * (0.30 + 0.40 * rnd());
    const rx = 120 + 140 * rnd();
    const ry = 70 + 110 * rnd();
    const w = (0.4 + 0.8 * rnd()) * (i % 2 === 0 ? 1 : -1); // 角速度(向き交互)
    const phase = rnd() * Math.PI * 2;

    const ps = createSystem("orb" + i, 4096);
    // オーブは点エミッタ。周囲に小さく広がる火花。
    ps.createPointEmitter(
      new BABYLON.Vector3(-0.3, -0.3, 0),
      new BABYLON.Vector3(0.3, 0.3, 0)
    );
    ps.minSize = 5; ps.maxSize = 12;
    ps.minEmitPower = 20; ps.maxEmitPower = 70;
    ps.start();
    allSystems.push(ps);

    orbs.push({ ps, cx, cy, rx, ry, w, phase, x: cx, y: cy });
  }
}

function updateOrbs(t, dt) {
  for (const o of orbs) {
    // 決定的軌道: 楕円 + 緩い正弦ゆらぎ。マウス無しでも常に流れる。
    const a = o.phase + o.w * t;
    o.x = o.cx + o.rx * Math.cos(a) + 18 * Math.sin(a * 2.3);
    o.y = o.cy + o.ry * Math.sin(a) + 18 * Math.cos(a * 1.7);
    // エミッタ位置を更新(z=0 平面)
    o.ps.emitter = new BABYLON.Vector3(o.x, o.y, 0);
  }
}

/* ---------- マウス追従トレイル ---------- */
let trail = null; // ParticleSystem
function buildTrail() {
  const ps = createSystem("trail", 4096);
  ps.createPointEmitter(
    new BABYLON.Vector3(-0.2, -0.2, 0),
    new BABYLON.Vector3(0.2, 0.2, 0)
  );
  ps.minSize = 6; ps.maxSize = 14;
  ps.minEmitPower = 10; ps.maxEmitPower = 50;
  ps.minLifeTime = LIFE_MIN;
  ps.maxLifeTime = (LIFE_MIN + LIFE_MAX) / 2; // トレイルは短命
  ps.emitter = new BABYLON.Vector3(mouse.x, mouse.y, 0);
  ps.start();
  allSystems.push(ps);
  trail = ps;
}
function updateTrail() {
  if (!trail) return;
  trail.emitter = new BABYLON.Vector3(mouse.x, mouse.y, 0);
  // マウスが画面外のときはトレイルを止める(噴出を抑える)
  trail.emitRate = mouse.inside ? trailRate : 0;
}

/* ---------- 爆発バースト(クリック / オート花火) ----------
 * 1 個の常駐バーストシステムを使い回し、放出地点だけ動かして manualEmitCount で
 * 一度に 120〜200 個を放射状に出す。プール再利用(GC回避)に相当。
 */
let burst = null;
const burstRnd = mulberry32(0xB0B1);
function buildBurst() {
  const ps = createSystem("burst", 8192);
  // 球(=画面では円)状に放射。半径0の点から全方向へ。
  ps.createSphereEmitter(2, 1.0); // radius, radiusRange
  ps.minSize = 8; ps.maxSize = 20;
  ps.minEmitPower = 120; ps.maxEmitPower = 320;
  ps.minLifeTime = LIFE_MIN;
  ps.maxLifeTime = LIFE_MAX;
  ps.emitRate = 0;            // 連続噴出はしない(バーストのみ)
  ps.manualEmitCount = 0;     // 既定は 0、爆発時に一括投入
  ps.start();                 // start しておき manualEmitCount で都度放出
  allSystems.push(ps);
  burst = ps;
}

// 着弾点 (x,y) で 120〜200 個を一括放出。
function explodeAt(x, y) {
  if (!burst) return;
  const n = BURST_MIN + Math.floor(burstRnd() * (BURST_MAX - BURST_MIN + 1));
  burst.emitter = new BABYLON.Vector3(x, y, 0);
  // 既存の保留分に積み増し(同フレーム多重爆発でも取りこぼさない)
  burst.manualEmitCount = (burst.manualEmitCount > 0 ? burst.manualEmitCount : 0) + n;
}

/* =========================================================================
 *  目標パーティクル数 → emitRate 配分
 *  - 連続噴出は orbs(4) + trail。平均寿命を掛けると概ねの定常生存数になる:
 *      live ≒ Σ(emitRate) × avgLife
 *    avgLife ≒ 1.0s なので Σ(emitRate) ≒ targetCap を狙う。
 *  - バースト分の余地を少し残し、連続噴出に targetCap の約 85% を割り当てる。
 *  - GPU の capacity は固定確保なので、目標が capacity を超える場合は再生成する。
 * ========================================================================= */
let trailRate = 200;

function applyTargetCap() {
  // 連続噴出に回す総レート(/s)。平均寿命 ~1s 前提で live ≒ rate。
  const contRate = targetCap * 0.85;
  // トレイルに 25%、オーブ群に 75% を配分。
  trailRate = contRate * 0.25;
  const perOrb = (contRate * 0.75) / Math.max(1, orbs.length);
  for (const o of orbs) o.ps.emitRate = perOrb;
  // トレイルは updateTrail() で inside 判定して反映。

  // --- capacity 不足チェック(主に GPU)---
  // 目標が大きいと CPU/GPU とも capacity 上限で頭打ちになるので必要なら作り直す。
  ensureCapacity();
}

// 各システムの capacity が目標に対して十分か確認し、不足なら再生成する。
let lastCapTier = 0;
function ensureCapacity() {
  // 段階的に capacity を確保(頻繁な再生成を避けるため tier 化)。
  // 連続噴出系は目標の余裕を持って確保。バーストは別枠。
  const tier = Math.ceil(targetCap / TARGET_STEP) * TARGET_STEP; // 2000 刻み
  if (tier === lastCapTier) return;
  lastCapTier = tier;

  // 連続系 1 システムあたりの確保量(オーブ4+トレイル1 = 5 で分け、各 +余裕)。
  const contCap = Math.min(TARGET_MAX, Math.ceil((tier * 0.85 / 5) * 1.6) + 256);
  rebuildSystemCapacity(trail, contCap);
  for (const o of orbs) o.ps = rebuildSystemCapacity(o.ps, contCap, o);
  // バーストは一度に最大 BURST_MAX を複数回、余裕をもって確保。
  rebuildSystemCapacity(burst, Math.min(TARGET_MAX, Math.max(4096, tier)));
}

// capacity を変えるには ParticleSystem/GPUParticleSystem を作り直す必要がある
// (capacity は生成時固定)。設定を引き継いで差し替える。
function rebuildSystemCapacity(oldPs, newCap, orbRef) {
  if (!oldPs) return oldPs;
  if (oldPs.getCapacity && oldPs.getCapacity() >= newCap) return oldPs; // 十分なら据置
  const name = oldPs.name;
  const wasEmitter = oldPs.emitter;
  const emitRate = oldPs.emitRate;
  const manual = oldPs.manualEmitCount || 0;

  // 旧システムを破棄(allSystems からも除去)
  const idx = allSystems.indexOf(oldPs);
  if (idx >= 0) allSystems.splice(idx, 1);
  oldPs.dispose();

  const ps = createSystem(name, newCap);
  // エミッタ形状を名前で復元(単純化のため種別を名前から判定)
  if (name === "burst") {
    ps.createSphereEmitter(2, 1.0);
    ps.minSize = 8; ps.maxSize = 20;
    ps.minEmitPower = 120; ps.maxEmitPower = 320;
    ps.emitRate = 0;
  } else if (name === "trail") {
    ps.createPointEmitter(new BABYLON.Vector3(-0.2, -0.2, 0), new BABYLON.Vector3(0.2, 0.2, 0));
    ps.minSize = 6; ps.maxSize = 14;
    ps.minEmitPower = 10; ps.maxEmitPower = 50;
    ps.maxLifeTime = (LIFE_MIN + LIFE_MAX) / 2;
  } else { // orbN
    ps.createPointEmitter(new BABYLON.Vector3(-0.3, -0.3, 0), new BABYLON.Vector3(0.3, 0.3, 0));
    ps.minSize = 5; ps.maxSize = 12;
    ps.minEmitPower = 20; ps.maxEmitPower = 70;
  }
  ps.emitter = wasEmitter;
  ps.emitRate = emitRate;
  ps.manualEmitCount = manual;
  ps.start();
  allSystems.push(ps);

  // 参照の差し替え
  if (name === "trail") trail = ps;
  else if (name === "burst") burst = ps;
  else if (orbRef) orbRef.ps = ps;
  return ps;
}

/* =========================================================================
 *  ブレンドモード切替 (B)
 * ========================================================================= */
function setBlend(mode) {
  currentBlend = mode;
  for (const ps of allSystems) ps.blendMode = mode;
}
function toggleBlend() {
  setBlend(currentBlend === BABYLON.ParticleSystem.BLENDMODE_ADD
    ? BABYLON.ParticleSystem.BLENDMODE_STANDARD
    : BABYLON.ParticleSystem.BLENDMODE_ADD);
}

/* =========================================================================
 *  入力
 * ========================================================================= */
canvas.tabIndex = 1;
setTimeout(() => canvas.focus(), 0);

function canvasToView(ev) {
  const rect = canvas.getBoundingClientRect();
  // CSS サイズと内部解像度が同一(960x540)なのでスケールはほぼ1だが一応補正。
  const sx = VIEW_W / rect.width;
  const sy = VIEW_H / rect.height;
  return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
}

canvas.addEventListener("pointermove", (ev) => {
  const p = canvasToView(ev);
  mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
});
canvas.addEventListener("pointerleave", () => { mouse.inside = false; });
canvas.addEventListener("pointerdown", (ev) => {
  canvas.focus();
  if (ev.button === 0) {
    const p = canvasToView(ev);
    explodeAt(p.x, p.y);
  }
});

window.addEventListener("keydown", (ev) => {
  const k = ev.key;
  if (k === " " || k === "Spacebar") {
    autoFireworks = !autoFireworks;
    autoTimer = 0;
    ev.preventDefault();
  } else if (k === "b" || k === "B") {
    toggleBlend();
  } else if (k === "+" || k === "=" || k === "Add") {
    setTarget(targetCap + TARGET_STEP);
  } else if (k === "-" || k === "_" || k === "Subtract") {
    setTarget(targetCap - TARGET_STEP);
  } else if (k === "r" || k === "R") {
    resetDemo();
  }
});

function setTarget(n) {
  targetCap = Math.max(TARGET_MIN, Math.min(TARGET_MAX, n));
  applyTargetCap();
}

/* =========================================================================
 *  リセット (R)
 * ========================================================================= */
function resetDemo() {
  autoFireworks = false;
  autoTimer = 0;
  targetCap = TARGET_INIT;
  setBlend(BABYLON.ParticleSystem.BLENDMODE_ADD);
  // 既存パーティクルを掃き出して作り直す(決定的状態へ)
  for (const ps of allSystems.slice()) ps.dispose();
  allSystems.length = 0;
  orbs.length = 0;
  trail = null; burst = null;
  lastCapTier = 0;
  elapsed = 0;
  buildOrbs();
  buildTrail();
  buildBurst();
  applyTargetCap();
}

/* =========================================================================
 *  HUD (FPS 移動平均, 約 0.1s 更新)
 * ========================================================================= */
let fpsAvg = 60;
let hudTimer = 0;

function liveParticles() {
  // 仕様: 生存パーティクル総数 = Σ system.getActiveCount()
  let n = 0;
  for (const ps of allSystems) {
    if (typeof ps.getActiveCount === "function") n += ps.getActiveCount();
  }
  return n;
}

function updateHud(dt) {
  const inst = dt > 0 ? 1 / dt : 60;
  fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.1;

  const live = liveParticles();
  // Emitters = 常設オーブ数 + アクティブバースト数(トレイルも常設として加算)
  const burstActive = (burst && burst.getActiveCount() > 0) ? 1 : 0;
  const emitters = orbs.length + (mouse.inside ? 1 : 0) + burstActive;
  const blendName = (currentBlend === BABYLON.ParticleSystem.BLENDMODE_ADD) ? "ADD" : "NORMAL";
  const modeName = USE_GPU ? "GPU" : "CPU";

  hudEl.innerHTML =
    '<span class="hudLabel">FPS</span>       <span class="hudVal">' + fpsAvg.toFixed(1) + '</span>\n' +
    '<span class="hudLabel">Particles</span> <span class="hudVal">' + live + '</span>' +
      '  <span class="hudLabel">Target</span> <span class="hudVal">' + targetCap + '</span>\n' +
    '<span class="hudLabel">Emitters</span>  <span class="hudVal">' + emitters + '</span>' +
      '  <span class="hudLabel">(orb ' + orbs.length + ' + trail + burst)</span>\n' +
    '<span class="hudLabel">Blend</span>     <span class="hudVal">' + blendName + '</span>' +
      '  <span class="hudLabel">Mode</span> <span class="hudVal">' + modeName + '</span>' +
      (autoFireworks ? '  <span class="warn">[AUTO]</span>' : '') + '\n' +
    '<span class="warn">Texture</span>   <span class="hudVal">' +
      (usingTextureAsset ? 'particle_spark.png' : 'DynamicTexture(glow)') + '</span>';
}

/* =========================================================================
 *  毎フレーム更新
 * ========================================================================= */
let elapsed = 0;

function frame(dt) {
  elapsed += dt;

  updateOrbs(elapsed, dt);
  updateTrail();

  // オート花火: 0.5s ごとに決定的位置でバースト(マウス不要)
  if (autoFireworks) {
    autoTimer -= dt;
    if (autoTimer <= 0) {
      autoTimer += AUTO_INTERVAL;
      // 決定的に画面内の位置を選ぶ(中央寄りに散らす)
      const fx = VIEW_W * (0.15 + 0.70 * fireRnd());
      const fy = VIEW_H * (0.15 + 0.55 * fireRnd());
      explodeAt(fx, fy);
    }
  }

  updateHud(dt);
}

/* =========================================================================
 *  起動: GPU 判定 → テクスチャ確定 → 構築 → ループ開始
 * ========================================================================= */
async function boot() {
  // --- 使用パーティクル機構の決定(GPU 優先) ---
  USE_GPU = !!(BABYLON.GPUParticleSystem && BABYLON.GPUParticleSystem.IsSupported);

  // --- テクスチャ: アセット優先、無ければ放射グロー生成 ---
  const ok = await checkImage(ASSET_DIR + SPARK_FILE);
  if (ok) {
    try {
      particleTexture = new BABYLON.Texture(ASSET_DIR + SPARK_FILE, scene);
      usingTextureAsset = true;
    } catch (e) {
      particleTexture = makeRadialGlowTexture();
      usingTextureAsset = false;
    }
  } else {
    particleTexture = makeRadialGlowTexture();
    usingTextureAsset = false;
  }

  // --- エミッタ群構築 ---
  buildOrbs();
  buildTrail();
  buildBurst();
  applyTargetCap();

  engine.runRenderLoop(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク抑制
    frame(dt);
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

boot();

})();
