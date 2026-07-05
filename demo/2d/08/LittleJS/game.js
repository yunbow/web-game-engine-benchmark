'use strict';

/*
  テーマ8 パーティクル / 魔法エフェクトデモ ― LittleJS 版
  --------------------------------------------------
  仕様(SPEC.md)準拠:
   - キャンバス 960x540 固定 / 背景は暗色(#05050a 相当)で発光が映える
   - 常設エミッタ: 画面内を決定的な軌道で周回する4個の発光オーブ。各オーブが連続噴出の
     ParticleEmitter(火花)。マウス無しでも常にパーティクルが流れる(ベンチ安定)。
   - マウス移動: カーソル位置(mousePos)に追従するトレイル用エミッタ。
   - 左クリック(mouseWasPressed(0)): クリック地点で 120〜200 個の放射状バースト。
   - Space(keyWasPressed): オート花火トグル。ON 中 0.5s 間隔で決定的位置に爆発バースト。
   - B: 加算 ⇄ 通常ブレンド切替(全エミッタの additive フラグを書き換え)。
   - + / -: 目標パーティクル上限(初期2000, ±2000, 下限500/上限50000)。
     上限に応じて常設オーブの emitRate / バースト個数をスケールし、実測値を上限付近に保つ。
   - R: リセット。
   - HUD(HTML overlay): FPS / Particles(実測) / Target / Emitters / Blend / Mode: CPU + 操作ヒント。

  ★ パーティクル機構 (最重要) ★
   - LittleJS 内蔵の ParticleEmitter / Particle(engine v1.18.x)。
   - ParticleEmitter は EngineObject を継承し、engine が自動で update/render する。
     一方 Particle は EngineObject では「ない」軽量オブジェクトで、各エミッタの
     `emitter.particles[]` 配列に保持される(global engineObjects には入らない)。
   - したがって「画面上の生存パーティクル総数」は、自分が生成した全エミッタの
     `particles.length` を合計して数える(下記 countLiveParticles を参照)。
   - 描画は CPU(Canvas2D / WebGL バッチ)。GPU パーティクル機構ではないため Mode=CPU。
   - 加算合成: Particle.render() が「emitter.additive」を毎フレーム参照して
     setAdditiveBlendMode() を掛ける。よって B キーでは各エミッタの .additive を
     書き換えるだけでよく、エミッタ再生成は不要。
   - 色グラデ(colorStart→colorEnd)・サイズ(sizeStart→sizeEnd)・alpha フェード(fadeRate)は
     すべて ParticleEmitter のコンストラクタ引数で表現する(自前更新は一切なし)。

  ★ 座標系 / Y軸メモ ★
   - LittleJS のワールドは Y軸"上向き"。本デモは中央配置の FX デモのため、
     cameraScale=1(1ワールド単位=1px)・カメラ中心を画面中央 (W/2, H/2) に固定し、
     「中央原点・px・Y上向き」の一貫モデルで全座標を保持する(画面上=Y大, 画面下=Y小)。
   - 周回オーブの軌道は決定的な正弦/円運動で定義。Y成分は素直に +sin を使い、
     "Y上向き"のまま破綻しない(重力等の上下依存物理が無いので符号の罠は最小)。
   - 各バーストの放出は等方的(全方位)なので Y軸の向きに依存しない。
   - マウス座標は LittleJS の mousePos(ワールド/Y上向き)をそのまま使うため、
     画面上のカーソルとパーティクル発生点が一致する(変換不要)。
*/

// ===================================================================
//  画面・数値定数 (SPEC)
// ===================================================================
const VIEW_W = 960, VIEW_H = 540;          // 固定キャンバス
const CENTER = () => vec2(VIEW_W / 2, VIEW_H / 2); // カメラ/画面中心 (px, y-up)

// パーティクル寿命・基準値 (SPEC: 0.6〜1.4s)。randomness で個体差を出す。
const PT_TIME = 1.0;          // 基準寿命(s) … randomness ±40% で 0.6〜1.4 に収まる
const PT_RANDOMNESS = 0.4;    // ±40%
const PT_FADE = 0.25;         // 寿命に対する fade-in+out 割合(alpha 1→0)
const PT_SIZE_START = 14;     // px(大) → 小へ
const PT_SIZE_END = 1.0;      // px(小)
const PT_DAMPING = 0.92;      // 減速(毎フレーム速度倍率) … 軽い減衰
const PT_GRAVITY = 0;         // 重力は使わず減速のみ(SPEC: 重力 or 減速を軽く)

// 暖色〜寒色グラデ用カラー(start=暖色, end=寒色寄り)。加算で重なるほど明るい。
const ORB_TINTS = [
  { a: new Color(1.0, 0.85, 0.30, 1), b: new Color(1.0, 0.45, 0.10, 1) }, // 金〜橙
  { a: new Color(1.0, 0.40, 0.55, 1), b: new Color(0.85, 0.20, 0.65, 1) }, // 桃〜紫
  { a: new Color(0.45, 0.85, 1.0, 1), b: new Color(0.20, 0.45, 1.0, 1) }, // 水〜青
  { a: new Color(0.65, 1.0, 0.55, 1), b: new Color(0.20, 0.85, 0.55, 1) }, // 黄緑〜青緑
];
// 寒色側の終端色(寿命末で alpha=0 へ)。CLEAR で消える。
const COLOR_COOL_END_A = new Color(0.25, 0.45, 1.0, 0);
const COLOR_COOL_END_B = new Color(0.55, 0.20, 1.0, 0);
// 爆発バースト: 暖色スタート → 寒色フェードアウト
const BURST_START_A = new Color(1.0, 0.90, 0.55, 1);
const BURST_START_B = new Color(1.0, 0.55, 0.20, 1);

// ---- 周回オーブ ----
const ORB_COUNT = 4;          // 常設オーブ数(SPEC: 初期4個)
const ORB_RADIUS_X = 300;     // 軌道半径(px)
const ORB_RADIUS_Y = 170;
const ORB_DRAW_R = 10;        // オーブ本体の描画半径(px)

// ---- パーティクル上限(負荷) ----
let particleTarget = 2000;    // 目標同時パーティクル数(初期2000)
const TARGET_STEP = 2000, TARGET_MIN = 500, TARGET_MAX = 50000;

// 上限スケールの基準: target=2000 のときオーブ1個あたりの emitRate(個/秒)。
// 連続噴出オーブが定常状態で供給する数 ≈ ORB_COUNT * emitRate * PT_TIME。
// これを target に概ね合わせるよう emitRate を毎回算出する(下記 orbEmitRate)。
const RATE_BASE_FRACTION = 0.8; // 上限の8割を常設オーブで満たす(残りはバースト/トレイル余地)

// ---- 爆発バースト個数(SPEC: 一度に120〜200個) ----
const BURST_MIN = 120, BURST_MAX = 200;

// ---- オート花火 ----
const AUTO_INTERVAL = 0.5;    // 0.5s 間隔(SPEC)

// ---- ブレンド ----
let additiveBlend = true;     // 初期は加算合成(発光感)

// ===================================================================
//  決定的疑似乱数 (mulberry32) ― Math.random は不使用
// ===================================================================
// 注意: LittleJS の ParticleEmitter 内部(個々のパーティクルの初速ジッタ等)は
//       エンジン側の乱数を使う。本デモが決定性を保証するのは「自前ロジック」
//       = オーブ軌道・オート花火の発生タイミング/位置・バースト個数 で、これらは
//       すべて下記 mulberry32 と固定シードに基づく(マウス無しでベンチ再現可能)。
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

const FW_RNG_SEED = 80808;    // オート花火の決定的位置に使うシード

// ===================================================================
//  アセット (../assets/, SPEC のファイル名/インデックスに厳密一致)
//   画像が無くても起動する。未読込ならテクスチャ無し(=内蔵タイルの単色)で描画。
// ===================================================================
const imageSources = [
  '../assets/particle_spark.png',  // 0 火花(加算前提の放射グロー)
  '../assets/particle_smoke.png',  // 1 煙/もや(任意)
  '../assets/orb.png',             // 2 周回オーブ本体
  '../assets/bg_dark.png',         // 3 背景(暗色, タイル可)
];
const TEX = { spark: 0, smoke: 1, orb: 2, bg: 3 };

// ===================================================================
//  グローバル状態
// ===================================================================
let orbs = [];                // [{ emitter, tint, phase, speed, rx, ry }]
let trailEmitter = null;      // マウス追従トレイル(常設・rate は移動で増減)
let burstEmitters = [];       // 一発バースト(emitTime>0 で寿命後に自然消滅)
let autoFireOn = false;       // オート花火 ON/OFF
let autoTimer = 0;            // オート花火の累積タイマ
let autoIndex = 0;            // 何発目か(決定的位置の算出に使用)
let useSprites = false;       // 画像が1枚でも読めたか

let fpsAvg = 60;              // FPS 指数移動平均
const hudEl = () => document.getElementById('hud');

// ===================================================================
//  テクスチャ判定 / フォールバック
//   画像が無い(=サイズ1x1 のダミー)場合は tileInfo を undefined にして
//   ParticleEmitter に渡す → 内蔵の白タイルが color で着色される。
// ===================================================================
function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}
// パーティクルに渡す tileInfo(画像があればそれ, 無ければ undefined=内蔵単色)。
function particleTileInfo(texIndex) {
  return spriteReady(texIndex) ? tile(0, textureInfos[texIndex].size, texIndex) : undefined;
}

// ===================================================================
//  emitRate 算出: 目標上限に実測を寄せる
//   定常パーティクル数 ≈ Σ(emitRate) * PT_TIME。
//   常設オーブで target*RATE_BASE_FRACTION 個を満たすよう、オーブ1個の rate を逆算。
// ===================================================================
function orbEmitRate() {
  // particles ≈ rate * PT_TIME (per emitter) → rate = particles / PT_TIME
  const perOrbParticles = (particleTarget * RATE_BASE_FRACTION) / ORB_COUNT;
  return perOrbParticles / PT_TIME;
}
// バースト1発の個数: 上限に比例させつつ SPEC の 120〜200 を基準にスケール。
function burstCount(rng) {
  const base = BURST_MIN + Math.floor(rng() * (BURST_MAX - BURST_MIN + 1)); // 120..200
  const scale = particleTarget / 2000;  // 上限2000を基準
  return Math.round(base * clamp(scale, 1, 25)); // 増やすほど大きな花火に
}

// ===================================================================
//  エミッタ生成ヘルパ
// ===================================================================
// 常設オーブ用: 連続噴出(emitTime=0=無限)・円状に弱く放射・減速・色グラデ。
function makeOrbEmitter(pos, tint) {
  const e = new ParticleEmitter(
    pos,                  // pos
    0,                    // angle
    ORB_DRAW_R,           // emitSize(円 直径相当)
    0,                    // emitTime: 0=無限(常設)
    orbEmitRate(),        // emitRate(個/秒) … 上限から逆算
    Math.PI,              // emitConeAngle: 全方位へ
    particleTileInfo(TEX.spark), // tileInfo(無ければ undefined=内蔵単色)
    tint.a, tint.b,       // colorStartA/B(暖色)
    COLOR_COOL_END_A, COLOR_COOL_END_B, // colorEndA/B(寒色→alpha0)
    PT_TIME,              // particleTime(寿命基準)
    PT_SIZE_START,        // sizeStart(大)
    PT_SIZE_END,          // sizeEnd(小)
    0.8,                  // speed(world/frame@60fps ≒ 48px/s)
    0.05,                 // angleSpeed
    PT_DAMPING,           // damping(減速)
    1,                    // angleDamping
    PT_GRAVITY,           // gravityScale
    Math.PI,              // particleConeAngle
    PT_FADE,              // fadeRate(alpha フェード)
    PT_RANDOMNESS,        // randomness(寿命/サイズ/速度に±40%)
    false,                // collideTiles
    additiveBlend,        // additive(加算合成)
    true                  // randomColorLinear
  );
  return e;
}

// 一発バースト用(クリック/オート花火): emitTime を極短にして放射状に大量放出。
// emitRate * emitTime ≈ 個数 になるよう逆算する。
function spawnBurst(pos, count, tintA, tintB) {
  const EMIT_TIME = 0.06;             // ごく短時間に集中放出
  const rate = count / EMIT_TIME;     // この rate*EMIT_TIME ≈ count
  const e = new ParticleEmitter(
    pos, 0,
    8,                                // emitSize(小さな点源)
    EMIT_TIME,                        // emitTime: 短命(放出後 particles 消滅で自然 destroy)
    rate,                             // emitRate
    Math.PI,                          // 全方位
    particleTileInfo(TEX.spark),
    tintA, tintB,
    COLOR_COOL_END_A, COLOR_COOL_END_B,
    PT_TIME * 1.1,                    // バーストはやや長寿命
    PT_SIZE_START * 1.2,              // やや大きめ
    PT_SIZE_END,
    2.4,                              // speed(放射状に勢いよく ≒ 144px/s)
    0.05,
    0.9,                              // damping(やや強めの減速で花火らしく)
    1,
    PT_GRAVITY,
    Math.PI,
    PT_FADE,
    PT_RANDOMNESS,
    false,
    additiveBlend,
    true
  );
  burstEmitters.push(e);
  return e;
}

// マウス追従トレイル: 常設だが emitRate は移動量で都度設定(静止時は弱く)。
function makeTrailEmitter() {
  const e = new ParticleEmitter(
    mousePos.copy(), 0,
    6,                                // 小さな点源
    0,                                // 無限
    0,                                // 初期 rate=0(移動で上書き)
    Math.PI,
    particleTileInfo(TEX.spark),
    new Color(0.7, 0.95, 1.0, 1), new Color(0.4, 0.7, 1.0, 1), // 寒色トレイル
    new Color(0.3, 0.4, 1.0, 0), new Color(0.5, 0.3, 1.0, 0),
    PT_TIME * 0.8,
    PT_SIZE_START * 0.8,
    PT_SIZE_END,
    0.5,
    0.05,
    PT_DAMPING,
    1,
    PT_GRAVITY,
    Math.PI,
    PT_FADE,
    PT_RANDOMNESS,
    false,
    additiveBlend,
    true
  );
  return e;
}

// ===================================================================
//  生存パーティクル数の実測
//   Particle は EngineObject ではなく emitter.particles[] に入るので、
//   自分が管理する全エミッタの particles.length を合計する。
// ===================================================================
function countLiveParticles() {
  let n = 0;
  for (const o of orbs) n += o.emitter.particles.length;
  if (trailEmitter) n += trailEmitter.particles.length;
  for (const b of burstEmitters) n += b.particles.length;
  return n;
}
// アクティブなエミッタ総数(常設オーブ + トレイル + 生存中バースト)。
function countEmitters() {
  let n = orbs.length + (trailEmitter ? 1 : 0);
  for (const b of burstEmitters) if (!b.destroyed) n++;
  return n;
}

// ===================================================================
//  生成済みエミッタを全破棄(リセット / 上限変更時の作り直し)
// ===================================================================
function destroyAllEmitters() {
  for (const o of orbs) o.emitter.destroy(true);   // immediate=true で即時破棄
  if (trailEmitter) trailEmitter.destroy(true);
  for (const b of burstEmitters) b.destroy(true);
  orbs = [];
  trailEmitter = null;
  burstEmitters = [];
}

// 常設エミッタ(オーブ + トレイル)を構築。決定的なオーブ初期位相を設定。
function buildPersistentEmitters() {
  const c = CENTER();
  for (let i = 0; i < ORB_COUNT; i++) {
    const phase = (i / ORB_COUNT) * Math.PI * 2;   // 等間隔の初期位相(決定的)
    const speed = 0.55 + 0.12 * i;                  // オーブごとに角速度を変える(決定的)
    const rx = ORB_RADIUS_X * (0.7 + 0.1 * i);
    const ry = ORB_RADIUS_Y * (0.9 - 0.08 * i);
    const tint = ORB_TINTS[i % ORB_TINTS.length];
    const pos = vec2(c.x + Math.cos(phase) * rx, c.y + Math.sin(phase) * ry);
    const emitter = makeOrbEmitter(pos, tint);
    orbs.push({ emitter, tint, phase, speed, rx, ry });
  }
  trailEmitter = makeTrailEmitter();
}

// 上限が変わったら emitRate を更新(エミッタ再生成は不要)。
function applyTargetToRates() {
  const rate = orbEmitRate();
  for (const o of orbs) o.emitter.emitRate = rate;
}

// ブレンド切替: 全エミッタの additive フラグを書き換え(render が毎フレ参照)。
function applyBlend() {
  for (const o of orbs) o.emitter.additive = additiveBlend;
  if (trailEmitter) trailEmitter.additive = additiveBlend;
  for (const b of burstEmitters) b.additive = additiveBlend;
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(1);                 // 1ワールド単位 = 1px(テーマ5と同じ思想)
  setCameraPos(CENTER());            // カメラ中心を画面中央に固定
  setGravity(vec2(0, 0));            // エンジン重力は使わない(減速のみ)
  // 背景は暗色。WebGL クリア色 / 2D 背景色の両方を暗色に。
  if (typeof setCanvasClearColor === 'function') setCanvasClearColor(new Color(0.02, 0.02, 0.04, 1));

  // テクスチャ読込判定(1枚でも読めれば sprites 使用)
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  particleTarget = 2000;
  additiveBlend = true;
  autoFireOn = false;
  autoTimer = 0;
  autoIndex = 0;

  destroyAllEmitters();
  buildPersistentEmitters();
}

function gameUpdate() {
  const dt = timeDelta;
  const c = CENTER();

  // ---- パーティクル上限 増減 (+/-) ----
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd')) {
    particleTarget = clamp(particleTarget + TARGET_STEP, TARGET_MIN, TARGET_MAX);
    applyTargetToRates();
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract')) {
    particleTarget = clamp(particleTarget - TARGET_STEP, TARGET_MIN, TARGET_MAX);
    applyTargetToRates();
  }

  // ---- ブレンド切替 (B) ----
  if (keyWasPressed('KeyB')) {
    additiveBlend = !additiveBlend;
    applyBlend();
  }

  // ---- リセット (R) ----
  if (keyWasPressed('KeyR')) {
    gameInit();
    return;
  }

  // ---- オート花火トグル (Space) ----
  if (keyWasPressed('Space')) {
    autoFireOn = !autoFireOn;
    autoTimer = 0; // 即座に1発目を出すため
  }

  // ---- 周回オーブの軌道更新(決定的: time に基づくリサージュ運動)----
  for (const o of orbs) {
    const t = time * o.speed + o.phase;
    // 中央原点・Y上向きの素直な楕円/リサージュ。マウス無しでも常に動く。
    o.emitter.pos.x = c.x + Math.cos(t) * o.rx;
    o.emitter.pos.y = c.y + Math.sin(t * 1.3) * o.ry; // x:y で周期差を付けて軌道を複雑化
  }

  // ---- マウス追従トレイル ----
  // mousePos はワールド(Y上向き)。移動量に応じて emitRate を増減。
  if (trailEmitter) {
    const move = mousePos.distance(trailEmitter.pos);
    trailEmitter.pos = mousePos.copy();
    // 動いているほど多く噴く。上限が大きいほどトレイルも濃く。
    const trailScale = particleTarget / 2000;
    trailEmitter.emitRate = clamp(move * 60, 0, 220) * clamp(trailScale, 1, 8);
  }

  // ---- 左クリック: 爆発バースト(120〜200個 × 上限スケール)----
  if (mouseWasPressed(0)) {
    const rng = makeRng((Math.floor(mousePos.x) * 73856093) ^ (Math.floor(mousePos.y) * 19349663));
    spawnBurst(mousePos.copy(), burstCount(rng), BURST_START_A, BURST_START_B);
  }

  // ---- オート花火: ON 中 0.5s 間隔で決定的位置にバースト ----
  if (autoFireOn) {
    autoTimer += dt;
    while (autoTimer >= AUTO_INTERVAL) {
      autoTimer -= AUTO_INTERVAL;
      const rng = makeRng(FW_RNG_SEED + autoIndex * 2654435761);
      // 画面内(余白80px)に決定的に散らす
      const px = 80 + rng() * (VIEW_W - 160);
      const py = 80 + rng() * (VIEW_H - 160);
      spawnBurst(vec2(px, py), burstCount(rng), BURST_START_A, BURST_START_B);
      autoIndex++;
    }
  }

  // ---- 自然消滅したバーストエミッタを配列から除去 ----
  // emitTime 経過 + particles 全消滅で destroy(true) 済みになる。
  for (let i = burstEmitters.length - 1; i >= 0; i--) {
    if (burstEmitters[i].destroyed) burstEmitters.splice(i, 1);
  }
}

function gameUpdatePost() {}

// ===================================================================
//  描画
//   パーティクル自体は ParticleEmitter(EngineObject)が自動 render するため
//   ここでは「背景」と「オーブ本体(発光円)」だけを描く。
// ===================================================================
function gameRender() {
  const c = CENTER();

  // ---- 背景(暗色) ----
  if (spriteReady(TEX.bg)) {
    drawTile(c, vec2(VIEW_W, VIEW_H), tile(0, textureInfos[TEX.bg].size, TEX.bg));
  } else {
    drawRect(c, vec2(VIEW_W, VIEW_H), new Color(0.03, 0.03, 0.06)); // 暗色フォールバック
  }

  // ---- オーブ本体(エミッタ位置に発光円。加算で芯を明るく)----
  for (const o of orbs) {
    const p = o.emitter.pos;
    if (spriteReady(TEX.orb)) {
      drawTile(p, vec2(ORB_DRAW_R * 2.4), tile(0, textureInfos[TEX.orb].size, TEX.orb), o.tint.a);
    } else {
      // フォールバック: 外側ハロー + 明るい芯(発光円)
      drawRect(p, vec2(ORB_DRAW_R * 2.4), new Color(o.tint.a.r, o.tint.a.g, o.tint.a.b, 0.25));
      drawRect(p, vec2(ORB_DRAW_R), new Color(1, 1, 1, 0.9));
    }
  }
}

// ===================================================================
//  HUD (HTML #hud overlay) + FPS 移動平均
// ===================================================================
function gameRenderPost() {
  // FPS 移動平均。LittleJS の `frameRate` は固定値 60(目標 fps)なので使わず、
  // エンジンが実測フレーム間隔から算出する `averageFPS` を採用してさらに平滑化する。
  const inst = (typeof averageFPS !== 'undefined' && averageFPS) ? averageFPS
             : (typeof timeDelta !== 'undefined' && timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const live = countLiveParticles();
  const emitters = countEmitters();
  const activeBursts = emitters - orbs.length - (trailEmitter ? 1 : 0);

  const el = hudEl();
  if (el) {
    el.textContent =
      'FPS       : ' + fpsAvg.toFixed(1) + '\n' +
      'Particles : ' + live + '\n' +
      'Target    : ' + particleTarget + '\n' +
      'Emitters  : ' + emitters + '  (オーブ ' + orbs.length +
        ' + トレイル ' + (trailEmitter ? 1 : 0) + ' + バースト ' + activeBursts + ')\n' +
      'Blend     : ' + (additiveBlend ? 'ADD' : 'NORMAL') + '\n' +
      'Mode      : CPU' + (useSprites ? '   [sprites]' : '   [shapes fallback]') +
        (autoFireOn ? '   [AUTO]' : '');
  }
}

// ===================================================================
//  起動: engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)
// ===================================================================
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources);
