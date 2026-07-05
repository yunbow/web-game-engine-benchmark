/* =========================================================================
 * テーマ8 パーティクル / 魔法エフェクトデモ ― PixiJS v8 実装
 * 仕様: SPEC.md (960x540 / 加算合成 / 周回オーブ / 爆発バースト / プール再利用)
 *
 * 使用機構: PixiJS v8 の **ParticleContainer + Particle**（自前 CPU 更新）。
 *   - ParticleContainer は「位置・スケール・回転・色のみ」を持つ軽量パーティクル専用
 *     コンテナ。Sprite を大量に Container へ入れるより描画スループットが高い。
 *   - ただし v8 でも更新は GPU ではなく **CPU 自前**: 毎フレーム各 Particle の
 *     位置/alpha/scale を JS で書き換える。本デモの比較軸はこの「CPU 更新 + 加算ブレンド
 *     描画」のスループット（GPU パーティクルを持つ Babylon/Godot との対比）。
 *   - 加算ブレンドは **コンテナ単位**（particles.blendMode = 'add'）。v8 の Particle は
 *     個別 blendMode を持てないため、ADD/NORMAL 切替はコンテナのプロパティを差し替える。
 *
 * PixiJS は描画ライブラリのため、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker の deltaMS でデルタタイム駆動)
 *   - 決定的擬似乱数 (mulberry32 / Math.random 不使用 = ベンチ再現性)
 *   - パーティクルのプール再利用 (生成/破棄の GC を避ける)
 *   - 周回オーブの決定的軌道・連続噴出・爆発バースト・オート花火
 *   - 寿命に沿う size(大→小) / alpha(1→0) / 色(暖色→寒色) の補間
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = 0x08080f;        // 暗色背景（発光が映える）

// パーティクル寿命・物理
const LIFE_MIN = 0.6;             // s
const LIFE_MAX = 1.4;             // s
const GRAVITY = 90;               // px/s^2（軽い重力で下方向へ）
const DRAG = 0.86;                // 1秒あたりの速度保持率（減速）
const SIZE_BIG = 1.4;             // 寿命開始時スケール（大）
const SIZE_SMALL = 0.15;          // 寿命終端スケール（小）

// 目標同時パーティクル数（負荷の主軸）
const TARGET_INIT = 2000;
const TARGET_STEP = 2000;
const TARGET_MIN = 500;
const TARGET_MAX = 50000;

// プールの物理上限（目標上限 + バースト余裕分）。確保し過ぎを防ぐためやや上に取る。
const POOL_CAP = TARGET_MAX + 4000;

// 周回オーブ
const ORB_COUNT = 4;              // 常設エミッタ数
const ORB_RADIUS = 14;            // 描画半径
const ORB_EMIT_BASE = 60;         // オーブ1個あたり基準噴出レート（/s, 目標数で動的スケール）

// 爆発バースト（クリック / オート花火）
const BURST_MIN = 120;
const BURST_MAX = 200;
const AUTO_INTERVAL = 0.5;        // オート花火間隔 (s)
const BURST_LIFETIME = 0.45;      // HUD 表示用: バーストを「アクティブ」と見なす残光時間 (s)

// トレイル（マウス追従）
const TRAIL_RATE = 90;            // /s（マウス移動中の噴出レート）

// 暖色→寒色グラデ（寿命 0→1 で warm→cool へ補間）
const WARM = { r: 1.0, g: 0.78, b: 0.32 };  // 黄橙（発生直後）
const COOL = { r: 0.30, g: 0.55, b: 1.0 };  // 青（消える直前）

// ---- 決定的擬似乱数 (mulberry32) -----------------------------------------
// Math.random は使わない（全エンジン・全実行で同一軌道 = ベンチ安定）。
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

// 暖色→寒色を線形補間し 0xRRGGBB に詰める。
function lerpColor(t) {
  const r = Math.round(clamp(lerp(WARM.r, COOL.r, t), 0, 1) * 255);
  const g = Math.round(clamp(lerp(WARM.g, COOL.g, t), 0, 1) * 255);
  const b = Math.round(clamp(lerp(WARM.b, COOL.b, t), 0, 1) * 255);
  return (r << 16) | (g << 8) | b;
}

// ---- フォールバックテクスチャ生成 ----------------------------------------
// 画像が無いときの放射状グロー（中心白→外周透明）。Canvas の放射グラデで描き、
// app.renderer.textureGenerator.texture で 1 枚にして全パーティクルで共有する。
// アセット画像（particle_spark.png 等）がある場合はそちらを優先する。
function makeGlowTexture(app, size, inner, outer) {
  const cnv = document.createElement('canvas');
  cnv.width = size; cnv.height = size;
  const ctx = cnv.getContext('2d');
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, inner);
  grad.addColorStop(0.35, inner);
  grad.addColorStop(1.0, outer);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  // v8: Canvas から Texture を直接生成（白基調 → tint で色付け）
  return PIXI.Texture.from(cnv);
}

// 暗色背景タイル（微弱な星）を Canvas で生成（bg_dark.png 欠落時のフォールバック）。
function makeBgTexture(rnd, size) {
  const cnv = document.createElement('canvas');
  cnv.width = size; cnv.height = size;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#08080f';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rnd() * size);
    const y = Math.floor(rnd() * size);
    const a = 0.15 + rnd() * 0.45;
    const s = rnd() < 0.85 ? 1 : 2;
    ctx.fillStyle = `rgba(${160 + Math.floor(rnd() * 80)},${180 + Math.floor(rnd() * 60)},255,${a})`;
    ctx.fillRect(x, y, s, s);
  }
  return PIXI.Texture.from(cnv);
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
// 画像が 1 枚も無くても起動すること（SPEC 必須）。各 load を try/catch で囲む。
async function loadTextures(app) {
  const rndStar = mulberry32(424242);
  const fallback = {
    // 白基調のグロー（加算合成 + tint で暖色〜寒色を表現）
    spark: makeGlowTexture(app, 32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
    // 煙/もや: 中心も半透明の柔らかいグロー
    smoke: makeGlowTexture(app, 32, 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0)'),
    // オーブ本体: 強めの中心グロー
    orb: makeGlowTexture(app, 64, 'rgba(255,255,255,1)', 'rgba(180,200,255,0)'),
    // 背景: 暗色 + 星
    bg: makeBgTexture(rndStar, 512),
  };
  const files = {
    spark: '../assets/particle_spark.png',
    smoke: '../assets/particle_smoke.png',
    orb:   '../assets/orb.png',
    bg:    '../assets/bg_dark.png',
  };
  const tex = { ...fallback };
  const loaded = {};
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      if (t && t.source) { tex[key] = t; loaded[key] = true; }
    } catch (e) {
      // 画像欠落 → 図形フォールバックのまま（既に tex[key] に入っている）
      loaded[key] = false;
    }
  }
  return { tex, loaded };
}

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須。app.view は app.canvas。
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: BG_COLOR,
    antialias: false,
    resolution: 1,        // 性能比較のため解像度は 1 固定
    autoDensity: false,
  });
  document.getElementById('game').appendChild(app.canvas);

  const { tex, loaded } = await loadTextures(app);

  // ---- 背景（微弱な星を敷く TilingSprite。発光の主役はパーティクル） ----
  const bg = new PIXI.TilingSprite({ texture: tex.bg, width: VIEW_W, height: VIEW_H });
  app.stage.addChild(bg);

  // ====================================================================
  // ParticleContainer 構築（本デモの核）
  // ====================================================================
  // v8 の ParticleContainer は dynamicProperties で「毎フレーム変わる属性」を宣言する。
  //   position : true  … 位置を毎フレーム更新（必須）
  //   scale    : true  … 寿命で大→小に変えるので動的
  //   color    : true  … tint と alpha は color パイプライン。alpha フェードに必須
  //   rotation : false … 回転は使わない（静的）→ アップロードを省いて軽量化
  // texture は「全パーティクル共通の 1 枚」を指定（バッチ最大化）。
  const particles = new PIXI.ParticleContainer({
    dynamicProperties: { position: true, scale: true, rotation: false, color: true },
    texture: tex.spark,
  });
  particles.blendMode = 'add';   // 加算合成（重なるほど明るく光る）
  app.stage.addChild(particles);

  // オーブ本体は通常のスプライト（数が少ないので Container でよい）。常に加算で発光。
  const orbLayer = new PIXI.Container();
  orbLayer.blendMode = 'add';
  app.stage.addChild(orbLayer);

  // ---- パーティクル状態（SoA ではなく軽量オブジェクト配列 + プール） ----
  // 各エントリは { particle(PIXI.Particle), live, x,y, vx,vy, life, maxLife, base } を持つ。
  // particle は ParticleContainer に「常駐」させ、live=false の間は alpha=0 + 画面外で隠す
  // （addParticle/removeParticle を毎フレーム叩くより、属性更新だけの方が速い）。
  const pool = [];        // 全エントリ（生存・待機の両方）
  const free = [];        // 待機中エントリの index スタック（再利用元）
  let liveCount = 0;

  function makeEntry() {
    const p = new PIXI.Particle({
      texture: tex.spark,
      x: -100, y: -100,
      scaleX: 0, scaleY: 0,
      tint: 0xffffff,
      alpha: 0,
      anchorX: 0.5, anchorY: 0.5,
    });
    particles.addParticle(p);
    const e = { particle: p, live: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1 };
    pool.push(e);
    free.push(pool.length - 1);
    return e;
  }

  // プールを必要数まで確保（初期は控えめに、足りなければ上限まで都度拡張）。
  function ensurePool(n) {
    const want = Math.min(n, POOL_CAP);
    while (pool.length < want) makeEntry();
  }
  ensurePool(TARGET_INIT + BURST_MAX * 2);

  // ---- パーティクル発生（プールから 1 個取り出す） ----
  // vx,vy: 初速（px/s）。spread を加えると放射状になる。
  function emit(x, y, vx, vy, lifeScale = 1, big = 1) {
    if (liveCount >= targetCap) return false;     // 目標上限で打ち止め（レートを抑制）
    let idx = free.pop();
    if (idx === undefined) {
      if (pool.length >= POOL_CAP) return false;  // 物理上限
      makeEntry();
      idx = free.pop();
    }
    const e = pool[idx];
    e.live = true;
    e.x = x; e.y = y;
    e.vx = vx; e.vy = vy;
    e.maxLife = (LIFE_MIN + rnd() * (LIFE_MAX - LIFE_MIN)) * lifeScale;
    e.life = e.maxLife;
    e._big = SIZE_BIG * big;
    // 初期見た目（直後に update でも上書きされるが、初回フレームのチラつき防止）
    const p = e.particle;
    p.x = x; p.y = y;
    p.tint = WARM_INT;
    p.alpha = 1;
    p.scaleX = p.scaleY = e._big;
    liveCount++;
    return true;
  }
  const WARM_INT = lerpColor(0);

  // 放射状バースト（クリック / オート花火）: count 個を全方位へ。
  function burst(x, y, count) {
    for (let i = 0; i < count; i++) {
      const ang = rnd() * Math.PI * 2;
      const spd = 80 + rnd() * 320;
      if (!emit(x, y, Math.cos(ang) * spd, Math.sin(ang) * spd, 1.0, 1.1)) break;
    }
    bursts.push({ x, y, t: BURST_LIFETIME }); // HUD の Emitters カウント用
  }

  // ---- 周回オーブ（決定的軌道） ----
  // 各オーブは中心 + 2 つの正弦（リサージュ風）で画面内を周回。シードで位相を散らす。
  const orbs = [];
  function buildOrbs() {
    orbLayer.removeChildren();
    orbs.length = 0;
    const orbRnd = mulberry32(987654321);
    for (let i = 0; i < ORB_COUNT; i++) {
      const sprite = new PIXI.Sprite(tex.orb);
      sprite.anchor.set(0.5);
      sprite.width = ORB_RADIUS * 2.6;
      sprite.height = ORB_RADIUS * 2.6;
      // 暖色〜寒色の中間色でオーブごとに色付け
      sprite.tint = lerpColor(i / Math.max(1, ORB_COUNT - 1));
      orbLayer.addChild(sprite);
      orbs.push({
        sprite,
        // 軌道パラメータ（決定的）
        cx: VIEW_W * (0.3 + orbRnd() * 0.4),
        cy: VIEW_H * (0.3 + orbRnd() * 0.4),
        ax: 140 + orbRnd() * 180,
        ay: 90 + orbRnd() * 130,
        wx: 0.5 + orbRnd() * 0.8,
        wy: 0.6 + orbRnd() * 1.0,
        phx: orbRnd() * Math.PI * 2,
        phy: orbRnd() * Math.PI * 2,
        x: 0, y: 0, px: 0, py: 0,
        emitAcc: 0,
      });
    }
  }

  // ---- 状態 ----
  let rnd = mulberry32(20250615);   // パーティクル乱数（R でリセット時に再シード）
  let targetCap = TARGET_INIT;      // 目標同時数（+/- で増減）
  let blendAdd = true;              // 現在のブレンド（true=ADD / false=NORMAL）
  let autoFire = false;             // Space オート花火
  let autoAcc = 0;                  // オート花火タイマ
  let autoSeq = 0;                  // オート花火の決定的位置インデックス
  let elapsed = 0;                  // 経過時間（オーブ軌道用）
  const bursts = [];                // アクティブバースト（残光）リスト

  // マウス（トレイル）
  let mouseX = VIEW_W / 2, mouseY = VIEW_H / 2;
  let mouseInside = false;
  let mousePrevX = mouseX, mousePrevY = mouseY;
  let trailAcc = 0;

  // オート花火の決定的な着弾位置（マウス無しでベンチできるよう固定列）。
  const autoRnd = mulberry32(13579);
  const autoSpots = [];
  for (let i = 0; i < 32; i++) {
    autoSpots.push({ x: 80 + autoRnd() * (VIEW_W - 160), y: 70 + autoRnd() * (VIEW_H - 200) });
  }

  function resetAll() {
    // 全パーティクルを待機へ戻す
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.live) { e.live = false; e.particle.alpha = 0; e.particle.x = -100; e.particle.y = -100; free.push(i); }
    }
    liveCount = 0;
    bursts.length = 0;
    targetCap = TARGET_INIT;
    autoFire = false;
    autoAcc = 0; autoSeq = 0;
    elapsed = 0;
    rnd = mulberry32(20250615);
    buildOrbs();
  }
  buildOrbs();

  // ---- 入力 ----
  // クリック=爆発バースト（キャンバス座標に変換）。
  function localPoint(ev) {
    const rect = app.canvas.getBoundingClientRect();
    const sx = VIEW_W / rect.width;   // 表示縮小ぶんを論理座標へ補正
    const sy = VIEW_H / rect.height;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }
  app.canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const p = localPoint(ev);
    const count = BURST_MIN + Math.floor(rnd() * (BURST_MAX - BURST_MIN + 1));
    burst(p.x, p.y, count);
  });
  app.canvas.addEventListener('mousemove', (ev) => {
    const p = localPoint(ev);
    mouseX = p.x; mouseY = p.y; mouseInside = true;
  });
  app.canvas.addEventListener('mouseleave', () => { mouseInside = false; });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      autoFire = !autoFire; autoAcc = 0; e.preventDefault();
    } else if (e.code === 'KeyB') {
      blendAdd = !blendAdd;
      particles.blendMode = blendAdd ? 'add' : 'normal';
      orbLayer.blendMode = blendAdd ? 'add' : 'normal';
    } else if (e.code === 'KeyR') {
      resetAll();
    } else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      targetCap = clamp(targetCap + TARGET_STEP, TARGET_MIN, TARGET_MAX);
      ensurePool(targetCap + BURST_MAX * 2);
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      targetCap = clamp(targetCap - TARGET_STEP, TARGET_MIN, TARGET_MAX);
      e.preventDefault();
    }
  });

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // ====================================================================
  // メインループ
  // ====================================================================
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05);   // スパイク抑制
    elapsed += dt;

    // --- FPS 移動平均（直近60フレーム）---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // ====================================================================
    // 1) 周回オーブ更新 + 連続噴出
    // ====================================================================
    // 噴出レートは「目標数に対する不足分」に応じてスケールし、生存数を上限近くに保つ。
    // 余裕(headroom)が大きいほど多く出す。連続エミッタ(オーブ+トレイル)で埋める。
    const headroom = clamp((targetCap - liveCount) / targetCap, 0, 1);
    const orbEmitRate = ORB_EMIT_BASE * (0.4 + targetCap / TARGET_INIT * 0.6) * (0.3 + headroom);

    for (let i = 0; i < orbs.length; i++) {
      const o = orbs[i];
      o.px = o.x; o.py = o.y;
      o.x = o.cx + Math.sin(elapsed * o.wx + o.phx) * o.ax;
      o.y = o.cy + Math.sin(elapsed * o.wy + o.phy) * o.ay;
      o.sprite.x = o.x; o.sprite.y = o.y;
      // 軽い明滅
      o.sprite.alpha = 0.7 + 0.3 * Math.sin(elapsed * 3 + i);

      // 連続噴出（オーブの進行方向と逆へ少し散らす = 火花トレイル）
      o.emitAcc += orbEmitRate * dt;
      let n = Math.floor(o.emitAcc);
      o.emitAcc -= n;
      const vmx = (o.x - o.px) / Math.max(dt, 1e-4);  // オーブの瞬間速度
      const vmy = (o.y - o.py) / Math.max(dt, 1e-4);
      while (n-- > 0) {
        const ang = rnd() * Math.PI * 2;
        const spd = 20 + rnd() * 70;
        // オーブ速度の逆向きを少し混ぜると尾を引く
        const vx = Math.cos(ang) * spd - vmx * 0.25;
        const vy = Math.sin(ang) * spd - vmy * 0.25;
        if (!emit(o.x, o.y, vx, vy, 0.9, 0.8)) break;
      }
    }

    // ====================================================================
    // 2) マウストレイル（移動中のみ連続噴出）
    // ====================================================================
    if (mouseInside) {
      const dx = mouseX - mousePrevX;
      const dy = mouseY - mousePrevY;
      const moved = Math.hypot(dx, dy);
      if (moved > 0.5) {
        trailAcc += TRAIL_RATE * (0.3 + headroom) * dt + Math.min(moved * 0.6, 12);
        let n = Math.floor(trailAcc);
        trailAcc -= n;
        // マウスの移動方向に沿って噴く + 直交方向に散らす
        const inv = 1 / Math.max(moved, 1e-4);
        const dirx = dx * inv, diry = dy * inv;
        while (n-- > 0) {
          const along = -(20 + rnd() * 80);                 // 進行方向の逆へ
          const side = (rnd() - 0.5) * 80;                  // 直交方向へ散らす
          const vx = dirx * along - diry * side;
          const vy = diry * along + dirx * side;
          if (!emit(mouseX, mouseY, vx, vy, 0.8, 0.7)) break;
        }
      }
    }
    mousePrevX = mouseX; mousePrevY = mouseY;

    // ====================================================================
    // 3) オート花火（Space ON 中・0.5s 間隔・決定的位置）
    // ====================================================================
    if (autoFire) {
      autoAcc += dt;
      while (autoAcc >= AUTO_INTERVAL) {
        autoAcc -= AUTO_INTERVAL;
        const spot = autoSpots[autoSeq % autoSpots.length];
        autoSeq++;
        const count = BURST_MIN + Math.floor(rnd() * (BURST_MAX - BURST_MIN + 1));
        burst(spot.x, spot.y, count);
      }
    }

    // ====================================================================
    // 4) パーティクル CPU 更新（位置 / alpha / scale / 色）
    // ====================================================================
    // ParticleContainer の各 Particle 属性を毎フレーム書き換える（=本デモの負荷の主役）。
    const dragF = Math.pow(DRAG, dt);   // フレーム独立な減速係数
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.live) continue;
      e.life -= dt;
      if (e.life <= 0) {
        // 寿命終了 → 待機へ返す（プール再利用）
        e.live = false;
        const p = e.particle;
        p.alpha = 0; p.x = -100; p.y = -100;
        free.push(i);
        liveCount--;
        continue;
      }
      // 物理: 重力 + 減速
      e.vy += GRAVITY * dt;
      e.vx *= dragF;
      e.vy *= dragF;
      e.x += e.vx * dt;
      e.y += e.vy * dt;

      // 寿命進行 0(生成)→1(消滅)
      const t = 1 - e.life / e.maxLife;
      const p = e.particle;
      p.x = e.x; p.y = e.y;
      // size: 大→小、alpha: 1→0（終盤で急に消えるよう t^2 を使う）
      const sc = lerp(e._big, SIZE_SMALL, t);
      p.scaleX = sc; p.scaleY = sc;
      p.alpha = 1 - t * t;
      // 色: 暖色→寒色
      p.tint = lerpColor(t);
    }

    // ====================================================================
    // 5) バースト残光カウント更新（HUD の Emitters 表示用）
    // ====================================================================
    for (let i = bursts.length - 1; i >= 0; i--) {
      bursts[i].t -= dt;
      if (bursts[i].t <= 0) { bursts[i] = bursts[bursts.length - 1]; bursts.pop(); }
    }

    // 背景の微弱スクロール（ごく僅か）
    bg.tilePosition.x = elapsed * 4;
    bg.tilePosition.y = elapsed * 2;

    // ====================================================================
    // 6) HUD（約120msごと更新）
    // ====================================================================
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
        `Mode      : CPU (manual update) / ParticleContainer\n` +
        `[click=爆発 / Space=オート(${autoFire ? 'ON' : 'OFF'}) / B / +/- / R]`;
    }
  });

  // three.js 版に合わせ、キャンバスは 960x540 固定・上端中央配置(ウィンドウ追従の縮小はしない)。
  app.canvas.style.width = VIEW_W + 'px';
  app.canvas.style.height = VIEW_H + 'px';

  const loadedList = Object.entries(loaded).filter(([, v]) => v).map(([k]) => k);
  console.log('[PixiJS v8] theme8 particles init ok. renderer =', app.renderer.type,
    '/ loaded assets =', loadedList.length ? loadedList.join(',') : '(none, using fallback)');
})();
