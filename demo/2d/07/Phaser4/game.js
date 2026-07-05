/* ============================================================
 * テーマ7 物理パズル (剛体物理 / 投擲物理) ― Phaser 4 実装
 * 仕様: ../SPEC.md に厳密準拠。
 *   - 本テーマは「本物の 2D 剛体物理エンジンを“使う”」のが主題。
 *     テーマ4/5の自前 AABB とは対照的に、重力・接触・スタック・反発・スリープを
 *     すべて Phaser 4 内蔵の Matter.js に委譲する。
 *   - 画面 960x540 固定 / 地面+左右壁は静的ボディ / 箱(34x34)は動的ボディを
 *     決定的に積み上げ / スリングショットから円(半径12)の発射体を撃つ。
 *
 * 性能比較の核: 「シーン内の剛体数(箱数)」と「覚醒(awake)剛体数」のスケール。
 *   箱数を +/- で増減し、ソルバ/スリープ実装差を Active 数で観測する。
 *
 * 数値・ルールはすべて SPEC.md に一致。Math.random は不使用 (mulberry32)。
 * ============================================================ */

// ---- 画面・ワールド定数 (SPEC.md より) ----
const VIEW_W = 960;
const VIEW_H = 540;
const GROUND_H = 48;                 // 画面下端から上 48px が地面
const GROUND_TOP = VIEW_H - GROUND_H; // 地面上面の y (= 492)
const WALL_T = 40;                    // 壁/床の厚み (見えない部分は画面外へ)

// 重力: 見た目で「箱が約 1〜1.5s で落ち着く」よう調整。
// Matter の重力スケールは config の matter.gravity.y で与える (下記)。
const GRAVITY_Y = 1.0;

// ---- 箱 / ターゲット / 発射体 (SPEC.md より) ----
const BOX = 34;                       // 箱 1 辺 34px (動的剛体)
const BALL_R = 12;                    // 発射体 円 半径 12
const DISPLACE_THRESHOLD = 64;        // 初期位置から 64px 以上動いたら「崩した」
const SCORE_BOX = 10;                 // 通常箱 崩し +10
const SCORE_TARGET = 50;              // ターゲット箱 崩し +50

// ---- スリングショット / 発射 ----
const PAD_X = 90;                     // 発射台 中心 x (画面左)
const PAD_TOP = GROUND_TOP - 64;      // 発射台上端 y
const LAUNCH_X = PAD_X;               // 発射点 x
const LAUNCH_Y = PAD_TOP + 6;         // 発射点 y (台の上)
const DRAG_TO_SPEED = 0.22;           // ドラッグ距離(px) → 初速 の係数
const MAX_LAUNCH_SPEED = 26;          // 初速の上限 (Matter 速度単位)
const CLICK_SPEED = 18;               // クリックのみ発射の固定初速
const MAX_SHOTS = 8;                  // 発射体プール 同時最大 8 発
const AUTO_INTERVAL = 800;            // オートショット間隔 0.8s (ms)

// ---- 箱数 (負荷) (SPEC.md より) ----
const INIT_BOXES = 60;
const BOX_STEP = 20;
const MIN_BOXES = 20;
const MAX_BOXES = 600;

// ---- 除去 ----
const OFFWORLD_MARGIN = 120;          // この余白を越え、かつスリープ中なら除去

// ---- フォールバック色 ----
const COLOR_BOX = 0x9c6b3a;           // 木目茶
const COLOR_TARGET = 0xff8a1e;        // 橙
const COLOR_BALL = 0xe23b3b;          // 赤
const COLOR_GROUND = 0x5a7a3a;        // 緑茶
const COLOR_SLING = 0x808890;         // 灰
const COLOR_SKY = 0x8fc7ff;           // 空色

// ---- 決定的疑似乱数 (Mulberry32) ----
// 箱の積み方・ターゲット位置・オートショットの角度/初速は、すべてこの PRNG で
// 生成し、Math.random は使わない (再構築 R で完全再現できる)。
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
const ASSET_DEFS = [
  { key: 'box',        file: 'box.png' },
  { key: 'box_target', file: 'box_target.png' },
  { key: 'ball',       file: 'ball.png' },
  { key: 'ground',     file: 'ground.png' },
  { key: 'slingshot',  file: 'slingshot.png' },
  { key: 'bg_sky',     file: 'bg_sky.png' },
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

  // Graphics.generateTexture で単色/図形テクスチャを焼いてフォールバック。
  buildFallbackTextures() {
    const make = (key, w, h, drawFn) => {
      if (this.textures.exists(key) && !failedAssets.has(key)) return; // 正常ロード済み
      if (this.textures.exists(key)) this.textures.remove(key);
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      drawFn(g, w, h);
      g.generateTexture(key, w, h);
      g.destroy();
    };

    // 通常の箱 = 木目茶矩形 (34x34)
    make('box', BOX, BOX, (g, w, h) => {
      g.fillStyle(COLOR_BOX, 1).fillRect(0, 0, w, h);
      g.fillStyle(0x7d5226, 1).fillRect(0, 0, w, 4).fillRect(0, h - 4, w, 4);
      g.lineStyle(2, 0x6b4420, 1).strokeRect(1, 1, w - 2, h - 2);
      g.lineStyle(1, 0x6b4420, 0.5).lineBetween(2, h / 2, w - 2, h / 2);
    });

    // ターゲット箱 = 橙矩形 (34x34, 中央に印)
    make('box_target', BOX, BOX, (g, w, h) => {
      g.fillStyle(COLOR_TARGET, 1).fillRect(0, 0, w, h);
      g.lineStyle(2, 0xc25a00, 1).strokeRect(1, 1, w - 2, h - 2);
      g.fillStyle(0xfff0d0, 1).fillCircle(w / 2, h / 2, 6);
      g.fillStyle(COLOR_TARGET, 1).fillCircle(w / 2, h / 2, 3);
    });

    // 発射体 = 赤丸 (24x24)
    make('ball', BALL_R * 2, BALL_R * 2, (g, w, h) => {
      g.fillStyle(COLOR_BALL, 1).fillCircle(w / 2, h / 2, BALL_R);
      g.fillStyle(0xff8c8c, 1).fillCircle(w / 2 - 3, h / 2 - 3, 4); // ハイライト
      g.lineStyle(1, 0x8c1a1a, 1).strokeCircle(w / 2, h / 2, BALL_R - 0.5);
    });

    // 地面タイル = 緑茶 (64x64)
    make('ground', 64, 64, (g, w, h) => {
      g.fillStyle(COLOR_GROUND, 1).fillRect(0, 0, w, h);
      g.fillStyle(0x6f9444, 1).fillRect(0, 0, w, 6);       // 上面の草
      g.fillStyle(0x4a5f2e, 1);
      g.fillRect(8, 22, 10, 10).fillRect(40, 38, 12, 12);  // 土の粒
    });

    // 発射台 = 灰 (48x64)
    make('slingshot', 48, 64, (g, w, h) => {
      g.fillStyle(COLOR_SLING, 1);
      g.fillRect(w / 2 - 5, 14, 10, h - 14);               // 支柱
      g.fillRect(w / 2 - 16, h - 8, 32, 8);                // 台座
      g.fillStyle(0x6a7078, 1);
      g.fillRect(4, 0, 8, 22).fillRect(w - 12, 0, 8, 22);  // Y 字の腕
    });

    // 背景 = 空色 (512x512 タイル)
    make('bg_sky', 512, 512, (g, w, h) => {
      g.fillStyle(COLOR_SKY, 1).fillRect(0, 0, w, h);
      g.fillStyle(0xffffff, 0.85);
      g.fillCircle(120, 96, 26).fillCircle(150, 106, 30).fillCircle(180, 98, 24);
      g.fillCircle(370, 190, 30).fillCircle(405, 200, 34).fillCircle(440, 192, 26);
      g.fillStyle(0x76b657, 1); // 遠景の丘
      g.fillCircle(260, 540, 130).fillCircle(440, 545, 150);
    });
  }
}

// ============================================================
// GameScene ― 本体 (Matter.js 物理)
// ============================================================
class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    // --- 背景 (静止した空) ---
    this.add.tileSprite(0, 0, VIEW_W, VIEW_H, 'bg_sky')
      .setOrigin(0, 0).setDepth(0);

    // --- 地面タイル帯 (描画のみ。物理は静的ボディ側) ---
    // 地面の見た目を 64px 幅のタイルで敷き、その上面 (GROUND_TOP) に静的床を置く。
    this.add.tileSprite(0, GROUND_TOP, VIEW_W, GROUND_H, 'ground')
      .setOrigin(0, 0).setDepth(1);

    // --- 発射台 (スリングショット, 描画のみ) ---
    this.add.image(PAD_X, GROUND_TOP, 'slingshot').setOrigin(0.5, 1).setDepth(2);

    // --- Matter 静的ワールド境界 (床 + 左右壁) ---
    // SPEC: 地面=画面下端から上 48px の水平静的床、左右にも静的壁(場外流出防止)。
    // isStatic な剛体は重力・接触で動かず、箱/弾を受け止める。
    const sOpt = { isStatic: true, label: 'wall', friction: 0.9, restitution: 0.0 };
    this.staticBodies = [];
    // 床 (上面が GROUND_TOP に来るよう、厚みの半分ぶん下げて中心を置く)
    this.staticBodies.push(
      this.matter.add.rectangle(VIEW_W / 2, GROUND_TOP + WALL_T / 2, VIEW_W, WALL_T, sOpt));
    // 左壁 / 右壁 (画面の縁。中心を画面外側に置き、内側の面だけが効く)
    this.staticBodies.push(
      this.matter.add.rectangle(-WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, sOpt));
    this.staticBodies.push(
      this.matter.add.rectangle(VIEW_W + WALL_T / 2, VIEW_H / 2, WALL_T, VIEW_H * 2, sOpt));
    // 天井 (高く撃った弾/箱の取りこぼし防止。上方向にだけ余裕を持たせる)
    this.staticBodies.push(
      this.matter.add.rectangle(VIEW_W / 2, -200, VIEW_W, WALL_T, sOpt));

    // --- 状態 ---
    this.boxCount = INIT_BOXES;   // 設定上の箱数 (負荷値)
    this.boxes = [];              // { sprite, body, isTarget, startX, startY, scored }
    this.shots = [];             // 発射体プール { sprite, body, active, spawnTime }
    this.score = 0;
    this.shotsFired = 0;          // 発射した累計
    this.autoShot = false;
    this.autoTimer = 0;
    this.autoRng = mulberry32(0x5107A0); // オートショット専用 PRNG (決定的)
    this.dragStart = null;        // ドラッグ開始ワールド座標

    // --- タイトル/アトラクト状態: started=false … デモ中(操作無効・デモAIが自動発射) ---
    this.started = false;
    this.blinkT = 0;
    this.demoTimer = 0;           // デモ自動発射の計時 (ms 累積)
    this.demoSeq = 0;             // デモ発射回数 (決定的に角度/強さを振る)
    this.titleEl = document.getElementById('title');

    // --- 箱を決定的に積む ---
    this.buildStack();

    // --- 入力: ドラッグ&リリース / クリック ---
    this.setupInput();

    // --- キーボード ---
    this.input.keyboard.on('keydown-ENTER', () => { if (!this.started) this.startGame(); });
    this.input.keyboard.on('keydown-SPACE', () => { this.autoShot = !this.autoShot; });
    this.input.keyboard.on('keydown-R', () => this.rebuild());
    this.input.keyboard.on('keydown-PLUS', () => this.adjustBoxes(+BOX_STEP));
    this.input.keyboard.on('keydown-MINUS', () => this.adjustBoxes(-BOX_STEP));
    this.input.keyboard.on('keydown-NUMPAD_ADD', () => this.adjustBoxes(+BOX_STEP));
    this.input.keyboard.on('keydown-NUMPAD_SUBTRACT', () => this.adjustBoxes(-BOX_STEP));

    // --- ドラッグ予測線 (発射方向の可視化) ---
    this.aimGfx = this.add.graphics().setDepth(50);

    // --- HUD ---
    this.buildHUD();
    this.fpsSamples = [];
    this.fpsAvg = 60;
  }

  // ============================================================
  // 構造物: 箱をピラミッド状/格子状に決定的に積む (SPEC.md)
  // ============================================================
  // 箱数(負荷値)に応じて列数・段数を決定的に決める。下段ほど広いピラミッドを
  // 基本とし、頂上付近の数個をターゲット箱(色違い・加点)にする。
  buildStack() {
    const rng = mulberry32(0xB0C5 ^ (this.boxCount * 0x9E3779B1)); // 箱数で決定的に変わる配置
    const n = this.boxCount;

    // ピラミッドの段数を箱数から逆算 (1+2+...+rows ≒ n の rows を求める)。
    // 1段あたりの箱はやや余裕を持たせ、余りは格子状に積み増す。
    const gap = 2;                          // 箱間の隙間 (安定のため僅かに空ける)
    const cell = BOX + gap;
    const baseRightX = VIEW_W - 60;         // ピラミッド右端 x
    const maxCols = Math.min(12, Math.floor((VIEW_W - PAD_X - 160) / cell)); // 段の最大幅

    // 段の幅は下ほど広い (1, 2, 3, ... maxCols でクランプ) ピラミッド。
    // 箱が尽きるまで段を積む。中央寄せで各段を配置。
    let placed = 0;
    let row = 0;
    const positions = []; // { cx, cy }
    while (placed < n) {
      const cols = Math.min(maxCols, row + 2);            // 段ごとの列数 (頂上に向け細く)
      const rowWidth = cols * cell;
      const left = baseRightX - rowWidth + gap;           // この段の左端
      const cy = GROUND_TOP - BOX / 2 - row * cell;       // 段の中心 y (下から積む)
      for (let c = 0; c < cols && placed < n; c++) {
        // 各箱に微小な x ジッタを決定的に与える (完全格子だと不自然なため)
        const jitter = (rng() - 0.5) * 1.5;
        const cx = left + c * cell + BOX / 2 + jitter;
        positions.push({ cx, cy });
        placed++;
      }
      row++;
      if (row > 60) break; // 安全弁
    }

    // ターゲット箱: 上位の段(最後に積んだ数個)から決定的に選ぶ。
    // 箱数に応じて 2〜5 個。
    const targetCount = Phaser.Math.Clamp(2 + Math.floor(n / 120), 2, 5);
    const targetSet = new Set();
    for (let i = 0; i < targetCount && i < positions.length; i++) {
      // 末尾 (= 上段) から決定的に選ぶ
      targetSet.add(positions.length - 1 - i);
    }

    // 動的ボディ生成。
    // friction(摩擦) / frictionStatic / restitution(反発) は積み崩しが
    // 自然に見える値に調整。Matter のスリープを有効化して Active 数を観測する。
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const isTarget = targetSet.has(i);
      this.spawnBox(p.cx, p.cy, isTarget);
    }
  }

  // 1 箱を生成 (スプライト + Matter 動的矩形ボディ)。
  spawnBox(cx, cy, isTarget) {
    const sprite = this.add.image(cx, cy, isTarget ? 'box_target' : 'box').setDepth(10);
    // Matter 矩形ボディを直接生成し、スプライトと結び付ける。
    const body = this.matter.add.rectangle(cx, cy, BOX, BOX, {
      label: isTarget ? 'target' : 'box',
      friction: 0.55,
      frictionStatic: 0.8,
      restitution: 0.05,
      density: 0.0016,
      // スリープを有効化: 静止すると isSleeping=true になり Active 数から外れる。
      sleepThreshold: 24,
    });
    this.boxes.push({
      sprite, body, isTarget,
      startX: cx, startY: cy, scored: false,
    });
  }

  // ============================================================
  // 発射体 (プール最大 8 発, 円 半径 12)
  // ============================================================
  // 発射点から (vx, vy) の初速で円ボディを撃つ。プールが満杯なら最古を除去。
  fire(vx, vy) {
    // 速度クランプ
    const sp = Math.hypot(vx, vy);
    if (sp > MAX_LAUNCH_SPEED) {
      vx = vx / sp * MAX_LAUNCH_SPEED;
      vy = vy / sp * MAX_LAUNCH_SPEED;
    }
    if (sp < 0.001) return;

    // プールが上限なら最古(先頭)の生存弾を除去。
    const live = this.shots.filter((s) => s.active);
    if (live.length >= MAX_SHOTS) {
      this.removeShot(live[0]);
    }

    // 空きスロットを探す or 新規作成。
    let s = this.shots.find((x) => !x.active);
    if (!s) {
      const sprite = this.add.image(LAUNCH_X, LAUNCH_Y, 'ball').setDepth(20);
      s = { sprite, body: null, active: false, spawnTime: 0 };
      this.shots.push(s);
    }

    // 円ボディ生成。やや高密度・低摩擦・適度な反発で「ぶつけて崩す」感触に。
    const body = this.matter.add.circle(LAUNCH_X, LAUNCH_Y, BALL_R, {
      label: 'ball',
      friction: 0.2,
      restitution: 0.35,
      density: 0.004,
      sleepThreshold: 30,
    });
    this.matter.body.setVelocity(body, { x: vx, y: vy });

    s.body = body;
    s.active = true;
    s.spawnTime = this.time.now;
    s.sprite.setVisible(true).setPosition(LAUNCH_X, LAUNCH_Y);
    this.shotsFired++;
  }

  removeShot(s) {
    if (!s.active) return;
    if (s.body) this.matter.world.remove(s.body);
    s.body = null;
    s.active = false;
    s.sprite.setVisible(false);
  }

  // ============================================================
  // 入力 (ドラッグ&リリース / クリックのみ)
  // ============================================================
  setupInput() {
    this.input.on('pointerdown', (p) => {
      // 発射台付近からのドラッグを発射操作とみなす。どこを押しても起点は記録。
      this.dragStart = { x: p.worldX, y: p.worldY };
    });

    this.input.on('pointerup', (p) => {
      this.aimGfx.clear();
      if (!this.dragStart) return;
      if (!this.started) { this.dragStart = null; return; } // アトラクト中はユーザー発射を無効化
      const dx = this.dragStart.x - p.worldX; // ドラッグと逆方向へ撃つ (パチンコ)
      const dy = this.dragStart.y - p.worldY;
      const dist = Math.hypot(dx, dy);

      if (dist < 6) {
        // クリックのみ: クリック地点へ向けた固定初速で発射 (簡易操作)。
        let tx = p.worldX - LAUNCH_X;
        let ty = p.worldY - LAUNCH_Y;
        const tn = Math.hypot(tx, ty) || 1;
        this.fire(tx / tn * CLICK_SPEED, ty / tn * CLICK_SPEED);
      } else {
        // ドラッグ&リリース: 引いた方向と距離に比例した初速。
        this.fire(dx * DRAG_TO_SPEED, dy * DRAG_TO_SPEED);
      }
      this.dragStart = null;
    });

    // ドラッグ中は予測線を描画。
    this.input.on('pointermove', (p) => {
      if (!this.dragStart || !p.isDown) return;
      const dx = this.dragStart.x - p.worldX;
      const dy = this.dragStart.y - p.worldY;
      this.aimGfx.clear();
      this.aimGfx.lineStyle(2, 0xffffff, 0.6);
      this.aimGfx.lineBetween(LAUNCH_X, LAUNCH_Y, LAUNCH_X + dx, LAUNCH_Y + dy);
    });
  }

  // ============================================================
  // オートショット (Space): 0.8s 間隔で決定的な角度/初速を自動発射 (マウス無しベンチ)
  // ============================================================
  autoFire() {
    // 角度: 右上方向 (山に向かう) を中心に決定的に揺らす。初速も決定的に変える。
    const r1 = this.autoRng();
    const r2 = this.autoRng();
    const angle = -0.7 + (r1 - 0.5) * 0.7;      // ラジアン (-0.7 ≒ 右上)
    const speed = MAX_LAUNCH_SPEED * (0.6 + r2 * 0.4);
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;          // 上向きは負
    this.fire(vx, vy);
  }

  // ============================================================
  // デモAI / タイトル開始
  // ============================================================
  // アトラクト中 (started=false) は約2秒ごとに角度・強さを変えて発射 (累積時間ベース・決定的)。
  demoFire(deltaMs) {
    this.demoTimer += deltaMs;
    while (this.demoTimer >= 2000) {
      this.demoTimer -= 2000;
      const s = this.demoSeq++;
      const angle = -0.66 + 0.38 * Math.sin(s * 0.9);     // 右上方向で角度を振る (rad)
      const speed = MAX_LAUNCH_SPEED * (0.72 + 0.2 * Math.sin(s * 1.7));
      this.fire(Math.cos(angle) * speed, Math.sin(angle) * speed);
    }
  }

  // Enter でデモ→プレイ開始: 新規リセット (R 相当) して操作を有効化、タイトルを消す。
  startGame() {
    this.started = true;
    this.rebuild();
    if (this.titleEl) this.titleEl.style.display = 'none';
  }

  // ============================================================
  // 箱数調整 / 再構築 (決定的)
  // ============================================================
  adjustBoxes(delta) {
    this.boxCount = Phaser.Math.Clamp(this.boxCount + delta, MIN_BOXES, MAX_BOXES);
    this.rebuild();
  }

  // 既存の箱・発射体をすべて除去し、スコアをリセットして決定的に再構築。
  rebuild() {
    for (const b of this.boxes) {
      this.matter.world.remove(b.body);
      b.sprite.destroy();
    }
    this.boxes.length = 0;
    for (const s of this.shots) this.removeShot(s);
    this.score = 0;
    this.shotsFired = 0;
    this.autoRng = mulberry32(0x5107A0); // オート PRNG も巻き戻して完全再現
    this.buildStack();
  }

  // ============================================================
  // HUD
  // ============================================================
  buildHUD() {
    const style = {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      color: '#eaf2ff',
      backgroundColor: 'rgba(10,16,22,0.55)',
      padding: { x: 8, y: 6 },
    };
    // setScrollFactor(0): スクロールしない 1 画面だが、HUD 固定の規約を踏襲。
    this.hud = this.add.text(8, 8, '', style).setScrollFactor(0).setDepth(1000);
  }

  // ============================================================
  // メインループ
  // ============================================================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;

    // FPS 移動平均 (30 サンプル)
    const instFps = delta > 0 ? 1000 / delta : 60;
    this.fpsSamples.push(instFps);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0; for (const f of this.fpsSamples) sum += f;
    this.fpsAvg = sum / this.fpsSamples.length;

    // --- デモAI: アトラクト中 (!started) は約2秒ごとに自動発射 ---
    if (!this.started) this.demoFire(delta);

    // --- オートショット ---
    if (this.started && this.autoShot) {
      this.autoTimer += delta;
      if (this.autoTimer >= AUTO_INTERVAL) {
        this.autoTimer -= AUTO_INTERVAL;
        this.autoFire();
      }
    } else {
      this.autoTimer = AUTO_INTERVAL; // OFF→ON 直後に即発射されるよう満タンに
    }

    // --- 箱: スプライト同期 + 加点判定 + 場外スリープ除去 ---
    // Matter ボディが物理を解決し、こちらは毎フレームその位置/角度を
    // スプライトへ写すだけ (描画は物理に追従)。
    let awake = 0;
    for (const b of this.boxes) {
      const body = b.body;
      b.sprite.setPosition(body.position.x, body.position.y);
      b.sprite.setRotation(body.angle);
      if (!body.isSleeping) awake++;

      // 崩し加点: 重心が初期位置から 64px 以上移動したら 1 回だけ加点。
      if (!b.scored) {
        const moved = Math.hypot(body.position.x - b.startX, body.position.y - b.startY);
        if (moved > DISPLACE_THRESHOLD) {
          b.scored = true;
          this.score += b.isTarget ? SCORE_TARGET : SCORE_BOX;
        }
      }
    }

    // --- 発射体: スプライト同期 + 場外/スリープ除去 ---
    let liveShots = 0;
    for (const s of this.shots) {
      if (!s.active) continue;
      const body = s.body;
      s.sprite.setPosition(body.position.x, body.position.y);
      s.sprite.setRotation(body.angle);
      if (!body.isSleeping) awake++;
      liveShots++;
      // 場外 (画面外へ大きく出た) かつ静止 → 除去。生存 5s 超でも除去。
      const off = body.position.y > VIEW_H + OFFWORLD_MARGIN ||
                  body.position.x < -OFFWORLD_MARGIN ||
                  body.position.x > VIEW_W + OFFWORLD_MARGIN;
      if (off || (body.isSleeping && time - s.spawnTime > 2500) ||
          time - s.spawnTime > 8000) {
        this.removeShot(s);
        liveShots--;
      }
    }

    // --- 場外の箱: スリープ後に除去 (剛体数の暴走防止, 負荷値には影響しない) ---
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      const pos = b.body.position;
      const off = pos.y > VIEW_H + OFFWORLD_MARGIN ||
                  pos.x < -OFFWORLD_MARGIN || pos.x > VIEW_W + OFFWORLD_MARGIN;
      if (off && b.body.isSleeping) {
        this.matter.world.remove(b.body);
        b.sprite.destroy();
        this.boxes.splice(i, 1);
      }
    }

    this.updateHUD(awake, liveShots);

    // --- タイトル点滅 (約0.45s 周期) ---
    if (!this.started && this.titleEl) {
      this.blinkT += dt;
      this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  }

  updateHUD(awake, liveShots) {
    // Bodies: 箱数 (現存 / 設定値) を主表示 (SPEC は「箱数/設定値」を主に表示でも可)。
    // 静的(床/壁)は常にスリープ状態なので Active には含めない。
    this.hud.setText([
      `FPS    : ${this.fpsAvg.toFixed(1)}`,
      `Bodies : ${this.boxes.length} / ${this.boxCount}  (箱)`,
      `Active : ${awake}  (awake bodies)`,
      `Shots  : ${liveShots} / ${MAX_SHOTS}   (fired ${this.shotsFired})`,
      `Score  : ${this.score}   Engine: Matter`,
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
  backgroundColor: '#8fc7ff',
  scene: [BootScene, GameScene],
  render: { antialias: true, pixelArt: false },
  scale: {
    mode: Phaser.Scale.NONE,   // 960x540 固定
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  // ---- Matter.js (内蔵剛体物理) ----
  // SPEC: physics.default='matter' / gravity.y 下向き。
  // 箱が約 1〜1.5s で落ち着くよう gravity.y=1.0 (Matter の既定スケール)。
  // enableSleeping: 静止ボディをスリープさせ Active 数を観測可能にする。
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: GRAVITY_Y },
      enableSleeping: true,
      // 接触ソルバの反復数 (スタックの安定性向上)
      positionIterations: 8,
      velocityIterations: 6,
      // debug: true, // ボディ可視化が必要なときに有効化
    },
  },
};

new Phaser.Game(config);
