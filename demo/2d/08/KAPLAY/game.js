/* =========================================================================
 * テーマ8 パーティクル / 魔法エフェクトデモ ― KAPLAY 実装
 * 仕様: SPEC.md (960x540 / 加算合成 / 周回オーブ / 爆発バースト / プール再利用)
 *
 * 使用機構: **CPU パーティクル（自前配列 + onDraw による手描き）**。
 *   - KAPLAY には GPU パーティクルシステムが無い（add([...]) でゲームオブジェクト
 *     化すると 1 個 = 1 オブジェクトでスケールしない）。そこで LittleJS と同様に
 *     **自前のパーティクル配列を JS で更新し、毎フレーム onDraw でまとめて描画**する
 *     CPU 方式を採る。これは three.js / A-Frame の GPU(THREE.Points) 方式と対比する
 *     「CPU 更新 + CPU/描画コール」の比較サンプルであり、本デモの比較軸そのもの。
 *   - 加算合成: 1 パーティクル = 1 drawSprite。KAPLAY のレンダラはスプライト単位で
 *     blend を指定できないため、**白基調グローのテクスチャを暗背景に重ね描き**して
 *     加算「風」の発光を得る（重なるほど明るく見える）。可能なら drawSprite の
 *     blend オプション（KAPLAY 3001 の BlendMode.Add 相当）を使い、無ければ通常合成。
 *   - CPU 方式のため GPU エンジンより低い上限で頭打ちになる（＝正当な比較結果）。
 *
 * KAPLAY 機構を使う部分: 初期化(kaplay) / ループ(onUpdate,dt) / 入力(onKeyPress,
 * onMousePress,onMouseMove) / 描画(onDraw, drawSprite, drawRect)。
 * 自前実装: 決定的擬似乱数 / パーティクルのプール再利用 / 周回オーブ軌道 /
 * 寿命に沿う size/alpha/色 補間 / フォールバックテクスチャ生成。
 * =========================================================================*/

// ---- 定数 (SPEC) — 全エンジン共通値 ---------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = [8, 8, 15];      // 暗色背景（発光が映える）

// パーティクル寿命・物理
const LIFE_MIN = 0.6;             // s
const LIFE_MAX = 1.4;             // s
const GRAVITY = 90;               // px/s^2（軽い重力で下方向へ）
const DRAG = 0.86;                // 1秒あたりの速度保持率（減速）
const SIZE_BIG = 1.4;             // 寿命開始時スケール（大）
const SIZE_SMALL = 0.15;          // 寿命終端スケール（小）
const SPRITE_BASE = 32;           // パーティクルテクスチャの基準px

// 目標同時パーティクル数（負荷の主軸）
const TARGET_INIT = 2000;
const TARGET_STEP = 2000;
const TARGET_MIN = 500;
const TARGET_MAX = 50000;
const POOL_CAP = TARGET_MAX + 4000;

// 周回オーブ
const ORB_COUNT = 4;
const ORB_RADIUS = 14;
const ORB_EMIT_BASE = 60;

// 爆発バースト（クリック / オート花火）
const BURST_MIN = 120;
const BURST_MAX = 200;
const AUTO_INTERVAL = 0.5;
const BURST_LIFETIME = 0.45;      // HUD 表示用: バーストを「アクティブ」と見なす残光時間

// トレイル（マウス追従）
const TRAIL_RATE = 90;

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

const clampv = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// 暖色→寒色を線形補間して {r,g,b}(0..255) を返す。
function lerpColor(t) {
  return {
    r: Math.round(clampv(lerp(WARM.r, COOL.r, t), 0, 1) * 255),
    g: Math.round(clampv(lerp(WARM.g, COOL.g, t), 0, 1) * 255),
    b: Math.round(clampv(lerp(WARM.b, COOL.b, t), 0, 1) * 255),
  };
}

// ---- フォールバックテクスチャ生成 ----------------------------------------
// 放射状グロー（中心白→外周透明）を Canvas で描き dataURL 化。
function makeGlowDataURL(size, inner, outer) {
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
  return cnv.toDataURL();
}

// === KAPLAY 初期化 =========================================================
const k = kaplay({
  width: VIEW_W, height: VIEW_H,
  canvas: document.getElementById('game-canvas'),
  background: BG_COLOR,
  crisp: false,
  global: false,            // 名前空間 k.* を明示利用（グローバル汚染を避ける）
});

// KAPLAY の加算ブレンド定数（3001 系）。無い環境でも壊れないようガード。
const ADD_BLEND = (k.BlendMode && k.BlendMode.Add) !== undefined ? k.BlendMode.Add : null;

// === アセット読込（失敗してもフォールバックで起動） ========================
// loadSprite は失敗時に reject。個別 try/catch して有無を記録、欠落は図形グローで代替。
const ASSET_DEFS = {
  spark: '../assets/particle_spark.png',
  smoke: '../assets/particle_smoke.png',
  orb:   '../assets/orb.png',
  bg:    '../assets/bg_dark.png',
};
const FALLBACK_DATAURL = {
  spark: makeGlowDataURL(32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
  smoke: makeGlowDataURL(32, 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0)'),
  orb:   makeGlowDataURL(64, 'rgba(255,255,255,1)', 'rgba(180,200,255,0)'),
};
const loaded = {};

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try { await k.loadSprite(key, url); loaded[key] = true; }
    catch (e) { loaded[key] = false; console.warn(`[asset] ${url} -> glow fallback`); }
  }));
  // 欠落分は図形グローの dataURL を sprite 登録（spark/smoke/orb のみ）。
  await Promise.all(Object.entries(FALLBACK_DATAURL).map(async ([key, dataURL]) => {
    if (!loaded[key]) { try { await k.loadSprite(key, dataURL); } catch (e) {} }
  }));
  start();
})();

function start() {
  // ---- 背景（微弱な星）: 決定的に配置し onDraw で薄く描く ----
  const starRnd = mulberry32(424242);
  const stars = [];
  for (let i = 0; i < 90; i++) {
    stars.push({ x: starRnd() * VIEW_W, y: starRnd() * VIEW_H,
      a: 0.15 + starRnd() * 0.45, s: starRnd() < 0.85 ? 1 : 2 });
  }
  const hasBg = !!loaded.bg;

  // ====================================================================
  // パーティクルプール（SoA でない軽量オブジェクト配列 + free スタック）
  // ====================================================================
  // 各エントリは { live, x,y, vx,vy, life, maxLife, big } を持つ。
  // live=false の間は free スタックに index を積み、emit で再利用する（GC 回避）。
  const pool = [];
  const free = [];
  let liveCount = 0;

  function makeEntry() {
    const e = { live: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, big: 1 };
    pool.push(e);
    free.push(pool.length - 1);
    return e;
  }
  function ensurePool(n) {
    const want = Math.min(n, POOL_CAP);
    while (pool.length < want) makeEntry();
  }
  ensurePool(TARGET_INIT + BURST_MAX * 2);

  // ---- 状態 ----
  let rnd = mulberry32(20250615);   // パーティクル乱数（R で再シード）
  let targetCap = TARGET_INIT;      // 目標同時数（+/- で増減）
  let blendAdd = true;              // 現在のブレンド（true=ADD / false=NORMAL）
  let autoFire = false;             // Space オート花火
  let autoAcc = 0;
  let autoSeq = 0;
  let elapsed = 0;
  const bursts = [];                // アクティブバースト（残光）リスト

  // マウス（トレイル）
  let mouseX = VIEW_W / 2, mouseY = VIEW_H / 2;
  let mouseInside = false;
  let mousePrevX = mouseX, mousePrevY = mouseY;
  let trailAcc = 0;

  // オート花火の決定的着弾位置
  const autoRnd = mulberry32(13579);
  const autoSpots = [];
  for (let i = 0; i < 32; i++) {
    autoSpots.push({ x: 80 + autoRnd() * (VIEW_W - 160), y: 70 + autoRnd() * (VIEW_H - 200) });
  }

  // ---- パーティクル発生 ----
  function emit(x, y, vx, vy, lifeScale = 1, big = 1) {
    if (liveCount >= targetCap) return false;     // 目標上限で打ち止め（レート抑制）
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
    e.big = SIZE_BIG * big;
    liveCount++;
    return true;
  }

  // 放射状バースト（クリック / オート花火）。
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
    orbs.length = 0;
    const orbRnd = mulberry32(987654321);
    for (let i = 0; i < ORB_COUNT; i++) {
      const col = lerpColor(i / Math.max(1, ORB_COUNT - 1));
      orbs.push({
        col,
        cx: VIEW_W * (0.3 + orbRnd() * 0.4),
        cy: VIEW_H * (0.3 + orbRnd() * 0.4),
        ax: 140 + orbRnd() * 180,
        ay: 90 + orbRnd() * 130,
        wx: 0.5 + orbRnd() * 0.8,
        wy: 0.6 + orbRnd() * 1.0,
        phx: orbRnd() * Math.PI * 2,
        phy: orbRnd() * Math.PI * 2,
        x: 0, y: 0, px: 0, py: 0, alpha: 1,
        emitAcc: 0,
      });
    }
  }
  buildOrbs();

  function resetAll() {
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.live) { e.live = false; free.push(i); }
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

  // ---- 入力 ----
  k.onMousePress('left', () => {
    const p = k.mousePos();
    const count = BURST_MIN + Math.floor(rnd() * (BURST_MAX - BURST_MIN + 1));
    burst(p.x, p.y, count);
  });
  k.onMouseMove((p) => { mouseX = p.x; mouseY = p.y; mouseInside = true; });
  k.onKeyPress('space', () => { autoFire = !autoFire; autoAcc = 0; });
  k.onKeyPress('b', () => { blendAdd = !blendAdd; });
  k.onKeyPress('r', () => { resetAll(); });
  k.onKeyPress(['=', 'kpadd'], () => {
    targetCap = clampv(targetCap + TARGET_STEP, TARGET_MIN, TARGET_MAX);
    ensurePool(targetCap + BURST_MAX * 2);
  });
  k.onKeyPress(['minus', 'kpsubtract'], () => {
    targetCap = clampv(targetCap - TARGET_STEP, TARGET_MIN, TARGET_MAX);
  });

  // ---- HUD ----
  const hudEl = document.getElementById('hud');
  const fpsSamples = [];
  let hudTimer = 0;
  let fpsAvg = 60;

  // ====================================================================
  // 更新ループ（KAPLAY onUpdate / dt 基準）
  // ====================================================================
  k.onUpdate(() => {
    const dt = Math.min(k.dt(), 0.05);   // スパイク抑制
    elapsed += dt;

    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // 噴出レートは「目標に対する不足分(headroom)」でスケールし生存数を上限近くに保つ。
    const headroom = clampv((targetCap - liveCount) / targetCap, 0, 1);
    const orbEmitRate = ORB_EMIT_BASE * (0.4 + targetCap / TARGET_INIT * 0.6) * (0.3 + headroom);

    // 1) 周回オーブ更新 + 連続噴出
    for (let i = 0; i < orbs.length; i++) {
      const o = orbs[i];
      o.px = o.x; o.py = o.y;
      o.x = o.cx + Math.sin(elapsed * o.wx + o.phx) * o.ax;
      o.y = o.cy + Math.sin(elapsed * o.wy + o.phy) * o.ay;
      o.alpha = 0.7 + 0.3 * Math.sin(elapsed * 3 + i);

      o.emitAcc += orbEmitRate * dt;
      let n = Math.floor(o.emitAcc);
      o.emitAcc -= n;
      const vmx = (o.x - o.px) / Math.max(dt, 1e-4);
      const vmy = (o.y - o.py) / Math.max(dt, 1e-4);
      while (n-- > 0) {
        const ang = rnd() * Math.PI * 2;
        const spd = 20 + rnd() * 70;
        const vx = Math.cos(ang) * spd - vmx * 0.25;
        const vy = Math.sin(ang) * spd - vmy * 0.25;
        if (!emit(o.x, o.y, vx, vy, 0.9, 0.8)) break;
      }
    }

    // 2) マウストレイル（移動中のみ連続噴出）
    if (mouseInside) {
      const dx = mouseX - mousePrevX;
      const dy = mouseY - mousePrevY;
      const moved = Math.hypot(dx, dy);
      if (moved > 0.5) {
        trailAcc += TRAIL_RATE * (0.3 + headroom) * dt + Math.min(moved * 0.6, 12);
        let n = Math.floor(trailAcc);
        trailAcc -= n;
        const inv = 1 / Math.max(moved, 1e-4);
        const dirx = dx * inv, diry = dy * inv;
        while (n-- > 0) {
          const along = -(20 + rnd() * 80);
          const side = (rnd() - 0.5) * 80;
          const vx = dirx * along - diry * side;
          const vy = diry * along + dirx * side;
          if (!emit(mouseX, mouseY, vx, vy, 0.8, 0.7)) break;
        }
      }
    }
    mousePrevX = mouseX; mousePrevY = mouseY;

    // 3) オート花火（Space ON 中・0.5s 間隔・決定的位置）
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

    // 4) パーティクル CPU 更新（位置 / 寿命）。描画は onDraw 側で実施。
    const dragF = Math.pow(DRAG, dt);
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.live) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.live = false;
        free.push(i);
        liveCount--;
        continue;
      }
      e.vy += GRAVITY * dt;
      e.vx *= dragF;
      e.vy *= dragF;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
    }

    // 5) バースト残光カウント更新（HUD 用）
    for (let i = bursts.length - 1; i >= 0; i--) {
      bursts[i].t -= dt;
      if (bursts[i].t <= 0) { bursts[i] = bursts[bursts.length - 1]; bursts.pop(); }
    }

    // 6) HUD（約120msごと）
    hudTimer += dt;
    if (hudTimer >= 0.12) {
      hudTimer = 0;
      const emitters = ORB_COUNT + bursts.length + (mouseInside ? 1 : 0);
      hudEl.textContent =
        `FPS       : ${fpsAvg.toFixed(1)}\n` +
        `Particles : ${liveCount}  (live)\n` +
        `Target    : ${targetCap}   (+/- で ±${TARGET_STEP}, ${TARGET_MIN}..${TARGET_MAX})\n` +
        `Emitters  : ${emitters}   (orb ${ORB_COUNT} + burst ${bursts.length}${mouseInside ? ' + trail 1' : ''})\n` +
        `Blend     : ${blendAdd ? 'ADD' : 'NORMAL'}   (B で切替)\n` +
        `Mode      : CPU (manual array + onDraw)\n` +
        `[click=爆発 / Space=オート(${autoFire ? 'ON' : 'OFF'}) / B / +/- / R]`;
    }
  });

  // ====================================================================
  // 描画ループ（KAPLAY onDraw）: 背景 → パーティクル → オーブ
  // ====================================================================
  // 加算合成は drawSprite の blend オプションで指定（ADD_BLEND があれば）。
  // 無ければ通常合成（白グローを暗背景に重ねるので近い見た目にはなる）。
  k.onDraw(() => {
    // 背景: bg があればタイル、なければ暗矩形 + 星
    if (hasBg) {
      k.drawSprite({ sprite: 'bg', pos: k.vec2(0, 0), width: VIEW_W, height: VIEW_H, opacity: 1 });
    }
    for (const s of stars) {
      k.drawRect({ pos: k.vec2(s.x, s.y), width: s.s, height: s.s,
        color: k.rgb(180, 200, 255), opacity: s.a });
    }

    const blend = blendAdd ? ADD_BLEND : null;

    // パーティクル: 1 個 = 1 drawSprite（CPU 方式の描画コスト主役）
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.live) continue;
      const t = 1 - e.life / e.maxLife;       // 0(生成)→1(消滅)
      const sc = lerp(e.big, SIZE_SMALL, t);
      const sz = SPRITE_BASE * sc;
      const col = lerpColor(t);
      const opt = {
        sprite: 'spark',
        pos: k.vec2(e.x - sz / 2, e.y - sz / 2),
        width: sz, height: sz,
        color: k.rgb(col.r, col.g, col.b),    // 白グローを暖色→寒色に着色
        opacity: 1 - t * t,                   // alpha: 1→0（終盤で急減）
      };
      if (blend !== null) opt.blend = blend;
      k.drawSprite(opt);
    }

    // オーブ本体（常に加算で発光）
    for (let i = 0; i < orbs.length; i++) {
      const o = orbs[i];
      const sz = ORB_RADIUS * 2.6;
      const opt = {
        sprite: 'orb',
        pos: k.vec2(o.x - sz / 2, o.y - sz / 2),
        width: sz, height: sz,
        color: k.rgb(o.col.r, o.col.g, o.col.b),
        opacity: o.alpha,
      };
      if (blend !== null) opt.blend = blend;
      k.drawSprite(opt);
    }
  });

  const loadedList = Object.entries(loaded).filter(([, v]) => v).map(([k2]) => k2);
  console.log('[KAPLAY 3001] theme8 particles init ok. mode = CPU /',
    'add-blend =', ADD_BLEND !== null ? 'on' : 'normal (no BlendMode.Add)',
    '/ loaded assets =', loadedList.length ? loadedList.join(',') : '(none, using fallback)');
}
