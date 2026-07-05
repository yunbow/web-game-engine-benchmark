/* ============================================================
 * テーマ8 パーティクル / 魔法エフェクトデモ ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠
 *   画面 960x540 固定 / 背景 暗色(#08080f) / デルタタイム基準。
 *   - 決定的軌道で周回する 4 個の発光オーブ = 連続火花エミッタ(常設)。
 *   - マウス移動 → カーソル追従の小トレイルエミッタ。
 *   - 左クリック → 放射状の爆発バースト(一度に 120〜200 個)。
 *   - Space → オート花火トグル(0.5s 間隔・決定的位置で爆発, マウス無しでベンチ可)。
 *   - B → ブレンド切替(ADD ⇄ NORMAL)。
 *   - +/- → 目標パーティクル数(上限)を ±2000(初期 2000 / 下限 500・上限 50000)。
 *           エミッションレートを上限に合わせて自動調整し Particles を上限付近で安定させる。
 *   - R → リセット。スコア/ライフ無し(代わりにパーティクル統計を HUD 表示)。
 *
 * 使用機構: Phaser 内蔵 GameObjects.Particles.ParticleEmitter(GPU バッチ描画)。
 *   各パーティクル: 寿命 0.6〜1.4s / size 大→小 / alpha 1→0 / 暖色→寒色グラデ /
 *   軽い重力 + 減速。加算合成(blendMode ADD)で重なるほど明るく。
 *   生存数は emitter.getAliveParticleCount() の総和で実測。
 *
 * 性能比較の核: 「画面上の生存パーティクル総数」を上限まで増やしたときの
 *   更新(位置/alpha/size)＋加算ブレンド描画スループット。
 * Math.random は使わず決定的 PRNG(mulberry32)を使用。
 * ============================================================ */

// ---- 基本定数 ----
const VIEW_W = 960;
const VIEW_H = 540;
const BG_COLOR = '#08080f';

// オーブ(常設エミッタ)
const ORB_COUNT = 4;            // 周回オーブ数(初期 4)
const ORB_BASE_FREQ = 30;       // オーブ 1 個の基準噴出間隔(ms) ※ Target で動的に調整

// 爆発バースト
const BURST_MIN = 120;          // 1 バーストのパーティクル数 下限
const BURST_MAX = 200;          // 1 バーストのパーティクル数 上限
const AUTO_INTERVAL = 0.5;      // オート花火 間隔(秒)

// 寿命(SPEC: 0.6〜1.4s)
const LIFE_MIN = 600;           // ms
const LIFE_MAX = 1400;          // ms

// 目標パーティクル数(負荷)
const TARGET_INIT = 2000;
const TARGET_STEP = 2000;
const TARGET_MIN = 500;
const TARGET_MAX = 50000;

// 暖色→寒色グラデ(寿命進行で色補間)
//   開始: 暖色(白〜橙〜赤)/ 終了: 寒色(青〜紫)
const COLOR_WARM = [0xffffff, 0xffe08a, 0xffae42, 0xff5a3c];
const COLOR_COOL = [0x6a9cff, 0x9a6aff, 0x3a6aff, 0x8a3cff];

// ---- 決定的疑似乱数 (Mulberry32) ----
// オーブ軌道・初速・色割り当て・オート花火位置はすべてこの PRNG で生成し、Math.random は使わない。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// BootScene ― アセット読込 + 失敗キャプチャ
// ============================================================
// SPEC のアセット(無ければフォールバック生成):
//   particle_spark.png / particle_smoke.png / orb.png / bg_dark.png
const ASSET_DEFS = [
  { key: 'particle_spark', file: 'particle_spark.png' },
  { key: 'particle_smoke', file: 'particle_smoke.png' },
  { key: 'orb',            file: 'orb.png' },
  { key: 'bg_dark',        file: 'bg_dark.png' },
];
const failedAssets = new Set();

class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  preload() {
    // 画像が無くても起動する: 読込失敗を記録し、後でフォールバックテクスチャを生成。
    this.load.on('loaderror', (fileObj) => { failedAssets.add(fileObj.key); });
    for (const def of ASSET_DEFS) {
      this.load.image(def.key, '../assets/' + def.file);
    }
  }

  create() {
    this.buildFallbackTextures();
    this.scene.start('GameScene');
  }

  // Graphics.generateTexture で図形テクスチャを焼いてフォールバック。
  // パーティクル = 放射グラデの白丸 / オーブ = 発光円 / 背景 = 暗色。
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      if (this.textures.exists(key) && !failedAssets.has(key)) return; // 正常ロード済み
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 放射状グロー(中心白→外周透明)を同心円の重ね塗りで近似。
    // 加算合成前提なので中心を強く明るく。
    const radialGlow = (g, w, h, coreRGB) => {
      const cx = w / 2, cy = h / 2;
      const rMax = w / 2;
      const steps = 16;
      for (let i = steps; i >= 1; i--) {
        const t = i / steps;            // 1(外)→ 0(中心)
        const r = rMax * t;
        // 外周ほど薄く、中心ほど濃く(加算で重なって発光感)
        const a = Math.pow(1 - t, 1.6) * 0.9 + 0.05;
        g.fillStyle(coreRGB, a);
        g.fillCircle(cx, cy, r);
      }
      // 中心コア
      g.fillStyle(0xffffff, 1).fillCircle(cx, cy, rMax * 0.18);
    };

    // 火花 = 白の放射状グロー(32x32)。色は emitter の tint で動的に着色。
    make('particle_spark', 32, 32, (g, w, h) => radialGlow(g, w, h, 0xffffff));

    // 煙/もや = 柔らかい白丸(第2テクスチャ・任意)。
    make('particle_smoke', 32, 32, (g, w, h) => {
      const cx = w / 2, cy = h / 2, rMax = w / 2;
      for (let i = 12; i >= 1; i--) {
        const t = i / 12;
        g.fillStyle(0xbfcfff, Math.pow(1 - t, 1.2) * 0.5 + 0.03);
        g.fillCircle(cx, cy, rMax * t);
      }
    });

    // オーブ = 発光円(32x32)。コア + ハロー。
    make('orb', 32, 32, (g, w, h) => {
      const cx = w / 2, cy = h / 2, rMax = w / 2;
      for (let i = 10; i >= 1; i--) {
        const t = i / 10;
        g.fillStyle(0x9ad0ff, Math.pow(1 - t, 1.5) * 0.7 + 0.04);
        g.fillCircle(cx, cy, rMax * t);
      }
      g.fillStyle(0xffffff, 1).fillCircle(cx, cy, rMax * 0.32);
    });

    // 背景 = 暗色 + 微弱な星(512x512 タイル可)。負荷の主役はパーティクルなので控えめ。
    make('bg_dark', 512, 512, (g, w, h) => {
      g.fillStyle(0x08080f, 1).fillRect(0, 0, w, h);
      const r = mulberry32(0xB6D0); // 星配置 専用 seed
      for (let i = 0; i < 90; i++) {
        const x = r() * w, y = r() * h;
        const s = r() * 1.4 + 0.4;
        g.fillStyle(0x2a3050, r() * 0.5 + 0.2);
        g.fillCircle(x, y, s);
      }
    });
  }
}

// ============================================================
// GameScene ― 本体
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    this.rng = mulberry32(0x8FA17C); // 全般用 決定的 PRNG

    // --- 背景(暗色・微弱な星。明滅は tween で軽く) ---
    this.bg = this.add.tileSprite(0, 0, VIEW_W, VIEW_H, 'bg_dark')
      .setOrigin(0, 0).setDepth(0).setAlpha(0.9);
    this.tweens.add({ targets: this.bg, alpha: 0.75, duration: 2200, yoyo: true, repeat: -1 });

    // --- 状態 ---
    this.target = TARGET_INIT;     // 目標パーティクル数(上限)
    this.blendAdd = true;          // true=ADD / false=NORMAL
    this.autoFireworks = false;    // Space トグル
    this.autoTimer = 0;            // オート花火 経過秒
    this.autoIndex = 0;           // オート花火 決定的位置インデックス
    this.activeBursts = 0;         // 現在生存中のバーストエミッタ数(HUD用)

    // パーティクルのブレンドモード(Phaser 定数)
    this.blendMode = () => (this.blendAdd ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL);

    // --- 全パーティクルを単一マネージャ風にまとめる深度レイヤ ---
    // Phaser4 では this.add.particles(x,y,texture,config) が ParticleEmitter を直接返す。
    this.fxDepth = 10;

    // === 常設: 周回オーブ + 連続火花エミッタ ===
    this.buildOrbs();

    // === トレイル(マウス追従)エミッタ ===
    this.buildTrailEmitter();

    // === バーストエミッタのプール ===
    // クリック/オート花火は一度に大量放出する単発エミッタ。プールして使い回す。
    this.burstPool = [];

    // --- 入力 ---
    // マウス移動 → トレイル位置更新 / 左クリック → 爆発バースト
    this.input.on('pointermove', (p) => {
      this.trail.setPosition(p.x, p.y);
      this.trailActiveUntil = this.time.now + 120; // 動いた直後だけ噴く
    });
    this.input.on('pointerdown', (p) => {
      if (p.leftButtonDown()) this.spawnBurst(p.x, p.y);
    });
    this.trailActiveUntil = 0;

    // キーボード
    this.input.keyboard.on('keydown-SPACE', () => { this.autoFireworks = !this.autoFireworks; this.autoTimer = 0; });
    this.input.keyboard.on('keydown-B', () => this.toggleBlend());
    this.input.keyboard.on('keydown-R', () => this.resetAll());
    this.input.keyboard.on('keydown-PLUS', () => this.adjustTarget(+TARGET_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustTarget(-TARGET_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustTarget(+TARGET_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustTarget(-TARGET_STEP));
    // 一部キーボード(JIS等)では '=' / '-' がこちらに来るため保険でバインド
    this.input.keyboard.on('keydown-EQUALS', () => this.adjustTarget(+TARGET_STEP));

    // --- HUD ---
    this.buildHUD();

    // FPS 移動平均
    this.fpsSamples = [];
    this.fpsAvg = 60;

    // 初期レートを Target に合わせて適用
    this.applyTargetRate();
  }

  // ============================================================
  // パーティクル共通設定(寿命に沿う size 大→小 / alpha 1→0 / 色グラデ)
  // ============================================================
  // 決定的に暖色/寒色を 1 組選び、寿命進行で色補間する onUpdate 風の挙動を
  // tint(開始色)+ Phaser の lifecycle で近似する。Phaser4 の emitter は
  // particleTint や color(配列で寿命補間)を受け付ける。
  baseEmitterConfig(extra) {
    const cfg = {
      // 寿命 0.6〜1.4s
      lifespan: { min: LIFE_MIN, max: LIFE_MAX },
      // size 大→小: 開始 1.1 倍 → 終了 0.05 倍へ縮小
      scale: { start: 1.1, end: 0.05 },
      // alpha 1→0
      alpha: { start: 1.0, end: 0.0 },
      // 暖色→寒色: color 配列で寿命に沿って補間(Phaser4 ParticleEmitter)
      color: [0xffffff, 0xffae42, 0xff5a3c, 0x9a6aff, 0x3a6aff],
      colorEase: 'quad.out',
      // 軽い重力 + 減速(空気抵抗)
      gravityY: 60,
      // 加算合成(ADD)。B キーで NORMAL に切替。
      blendMode: this.blendMode(),
      // 既定では発生停止(各エミッタ側で frequency / explode を制御)
      emitting: false,
    };
    return Object.assign(cfg, extra || {});
  }

  // ============================================================
  // 常設: 周回オーブ(発光円) + 連続火花エミッタ
  // ============================================================
  buildOrbs() {
    this.orbs = [];
    for (let i = 0; i < ORB_COUNT; i++) {
      // 各オーブの軌道パラメータを決定的に生成(正弦/円運動の合成)。
      const r = mulberry32(0x0B000 ^ (i * 0x9E3779B1));
      const orbit = {
        cx: VIEW_W * (0.28 + 0.44 * r()),     // 中心 x
        cy: VIEW_H * (0.28 + 0.44 * r()),     // 中心 y
        ax: 120 + 140 * r(),                   // x 振幅
        ay: 90 + 110 * r(),                    // y 振幅
        wx: 0.5 + 0.9 * r(),                   // x 角速度(rad/s)
        wy: 0.4 + 1.0 * r(),                   // y 角速度
        phase: r() * Math.PI * 2,              // 位相
        t: 0,
      };

      // 連続火花エミッタ(オーブに追従)。frequency は applyTargetRate で調整。
      const emitter = this.add.particles(orbit.cx, orbit.cy, 'particle_spark',
        this.baseEmitterConfig({
          speed: { min: 20, max: 90 },          // 初速(全方向 = angle 0..360)
          angle: { min: 0, max: 360 },
          quantity: 2,
          frequency: ORB_BASE_FREQ,
          emitting: true,
        }));
      emitter.setDepth(this.fxDepth);

      // オーブ本体(発光円)はパーティクルの上に描画。
      const sprite = this.add.image(orbit.cx, orbit.cy, 'orb')
        .setDepth(this.fxDepth + 1)
        .setBlendMode(this.blendMode())
        .setScale(1.1);

      this.orbs.push({ orbit, emitter, sprite });
    }
  }

  // ============================================================
  // トレイル(マウス追従)エミッタ
  // ============================================================
  buildTrailEmitter() {
    this.trail = this.add.particles(VIEW_W / 2, VIEW_H / 2, 'particle_spark',
      this.baseEmitterConfig({
        speed: { min: 10, max: 50 },
        angle: { min: 0, max: 360 },
        lifespan: { min: LIFE_MIN, max: 1000 },
        scale: { start: 0.9, end: 0.05 },
        quantity: 2,
        frequency: 16,
        emitting: false, // 動いた直後だけ on にする(update で制御)
      }));
    this.trail.setDepth(this.fxDepth);
  }

  // ============================================================
  // 爆発バースト(クリック / オート花火)
  // ============================================================
  // 一度に 120〜200 個を放射状に放出する単発エミッタ。プールから使い回す。
  spawnBurst(x, y) {
    const count = BURST_MIN + Math.floor(this.rng() * (BURST_MAX - BURST_MIN + 1));

    // プールから停止中のものを探す。なければ新規作成。
    let b = this.burstPool.find((e) => !e._busy);
    if (!b) {
      b = this.add.particles(x, y, 'particle_spark',
        this.baseEmitterConfig({
          speed: { min: 120, max: 360 },        // 放射状の初速
          angle: { min: 0, max: 360 },
          gravityY: 120,
          emitting: false,
        }));
      b.setDepth(this.fxDepth);
      b._busy = false;
      this.burstPool.push(b);
    }

    b.setPosition(x, y);
    b.setParticleGravity(0, 120);
    b.setBlendMode(this.blendMode());
    b._busy = true;
    b.explode(count, x, y); // 一括放出(GPU バッチ)

    // 最長寿命ぶん経過したら busy 解除(プール再利用可能に)。
    this.time.delayedCall(LIFE_MAX + 60, () => { b._busy = false; });
  }

  // ============================================================
  // Target に合わせてエミッションレートを調整
  // ============================================================
  // 目標生存数 = Target。常設オーブの連続噴出が定常生存数を支配するため、
  // 「オーブ合計の毎秒発生数 × 平均寿命 ≒ Target」となるよう frequency/quantity を決める。
  //   定常生存数 ≈ rate(個/秒) × avgLife(秒)
  //   rate = quantity / (frequency/1000)
  // バースト/トレイルは上乗せ。Target を大きくするほどオーブのレートを上げて上限付近を狙う。
  applyTargetRate() {
    const avgLife = (LIFE_MIN + LIFE_MAX) / 2 / 1000; // 平均寿命(秒) = 1.0s
    // オーブ全体で確保したい定常生存数(Target の約 85%。残りはトレイル/バースト余地)。
    const orbSteady = this.target * 0.85;
    const perOrbSteady = orbSteady / ORB_COUNT;
    // 1 オーブの必要 rate(個/秒)
    const perOrbRate = perOrbSteady / avgLife;

    // frequency(ms) と quantity を決める。quantity は rate に応じて段階的に増やし、
    // frequency は短くしすぎない(極小 frequency は CPU 側のオーバーヘッドが増えるため)。
    // 1 噴出あたりの quantity を rate と矛盾しない範囲で設定。
    for (const o of this.orbs) {
      // 目標: rate = quantity / (freqSec)
      // まず quantity を rate に比例した粒度で決める(最小 1)。
      let quantity = Math.max(1, Math.round(perOrbRate / 60)); // 60Hz 噴出を基準にした 1 回量
      let freqMs = 1000 * quantity / Math.max(1, perOrbRate);  // その quantity で rate を満たす間隔
      // frequency は 8ms〜120ms にクランプ(過剰な細切れ/間延びを防ぐ)
      if (freqMs < 8) { freqMs = 8; quantity = Math.max(1, Math.round(perOrbRate * freqMs / 1000)); }
      if (freqMs > 120) freqMs = 120;
      o.emitter.frequency = freqMs;
      o.emitter.quantity = quantity;
      // maxParticles でエミッタ単位の安全上限(暴走防止)。Target に余裕を持たせる。
      o.emitter.maxParticles = 0; // 0=無制限(全体は frequency で制御)
    }
  }

  adjustTarget(delta) {
    this.target = Phaser.Math.Clamp(this.target + delta, TARGET_MIN, TARGET_MAX);
    this.applyTargetRate();
  }

  // ============================================================
  // ブレンド切替(ADD ⇄ NORMAL)
  // ============================================================
  toggleBlend() {
    this.blendAdd = !this.blendAdd;
    const mode = this.blendMode();
    for (const o of this.orbs) {
      o.emitter.setBlendMode(mode);
      o.sprite.setBlendMode(mode);
    }
    this.trail.setBlendMode(mode);
    for (const b of this.burstPool) b.setBlendMode(mode);
  }

  // ============================================================
  // リセット
  // ============================================================
  resetAll() {
    this.target = TARGET_INIT;
    this.blendAdd = true;
    this.autoFireworks = false;
    this.autoTimer = 0;
    this.autoIndex = 0;
    this.rng = mulberry32(0x8FA17C); // PRNG も初期化して決定的に戻す
    // 生存パーティクルを一掃
    for (const o of this.orbs) o.emitter.killAll();
    this.trail.killAll();
    for (const b of this.burstPool) { b.killAll(); b._busy = false; }
    this.toggleBlendTo(true);  // ADD に戻す
    this.applyTargetRate();
  }

  // 指定状態のブレンドへ強制設定(reset 用)
  toggleBlendTo(add) {
    this.blendAdd = add;
    const mode = this.blendMode();
    for (const o of this.orbs) { o.emitter.setBlendMode(mode); o.sprite.setBlendMode(mode); }
    this.trail.setBlendMode(mode);
    for (const b of this.burstPool) b.setBlendMode(mode);
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    const style = {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(8,10,22,0.55)',
      padding: { x: 8, y: 6 },
    };
    // setScrollFactor(0) でスクロール非追従に固定(本デモはスクロール無しだが規約に合わせる)。
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(1000);
  }

  // 生存パーティクル総数 = 全エミッタの getAliveParticleCount() 総和。
  countAlive() {
    let n = 0;
    for (const o of this.orbs) n += o.emitter.getAliveParticleCount();
    n += this.trail.getAliveParticleCount();
    for (const b of this.burstPool) n += b.getAliveParticleCount();
    return n;
  }

  // 現在アクティブなバーストエミッタ数(生存粒子を持つもの)。
  countActiveBursts() {
    let n = 0;
    for (const b of this.burstPool) if (b.getAliveParticleCount() > 0) n++;
    return n;
  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000; // 秒(スパイク抑制)

    // FPS 移動平均(30 サンプル)
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    // --- オーブの決定的軌道更新(正弦/円運動の合成) ---
    for (const o of this.orbs) {
      const ob = o.orbit;
      ob.t += dt;
      const x = ob.cx + Math.cos(ob.t * ob.wx + ob.phase) * ob.ax;
      const y = ob.cy + Math.sin(ob.t * ob.wy + ob.phase * 1.3) * ob.ay;
      o.emitter.setPosition(x, y);
      o.sprite.setPosition(x, y);
      // オーブ本体を軽く脈動
      o.sprite.setScale(1.0 + 0.12 * Math.sin(ob.t * 3 + ob.phase));
    }

    // --- トレイル: マウスが直前に動いた間だけ噴出 ---
    const trailOn = time < this.trailActiveUntil;
    if (this.trail.emitting !== trailOn) this.trail.emitting = trailOn;

    // --- オート花火: 0.5s ごとに決定的位置で爆発 ---
    if (this.autoFireworks) {
      this.autoTimer += dt;
      while (this.autoTimer >= AUTO_INTERVAL) {
        this.autoTimer -= AUTO_INTERVAL;
        // 決定的位置(インデックス由来 PRNG。画面内に分散)。
        const r = mulberry32(0xF1A2 ^ (this.autoIndex * 0x9E3779B1));
        const x = VIEW_W * (0.12 + 0.76 * r());
        const y = VIEW_H * (0.18 + 0.64 * r());
        this.autoIndex++;
        this.spawnBurst(x, y);
      }
    }

    this.updateHUD();
  }

  updateHUD() {
    const alive = this.countAlive();
    const bursts = this.countActiveBursts();
    const emitters = ORB_COUNT + bursts; // 常設オーブ数 + アクティブバースト数
    this.hud.setText([
      `FPS       : ${this.fpsAvg.toFixed(1)}`,
      `Particles : ${alive}`,
      `Target    : ${this.target}`,
      `Emitters  : ${emitters}  (orbs ${ORB_COUNT} + bursts ${bursts})`,
      `Blend     : ${this.blendAdd ? 'ADD' : 'NORMAL'}`,
      `Mode      : GPU`,
    ].join('\n'));
  }
}

// ============================================================
// 起動
// ============================================================
const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: VIEW_W,
  height: VIEW_H,
  backgroundColor: BG_COLOR,
  scene: [BootScene, GameScene],
  render: { antialias: true },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
};

new Phaser.Game(config);
