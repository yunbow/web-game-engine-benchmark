/* ============================================================================
 * ブロック崩し（マルチボール Breakout） - Babylon.js 版
 * --------------------------------------------------------------------------
 * 3Dエンジン Babylon.js を使い 2D ブロック崩しを実装。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を再現
 *  - スプライトは SpriteManager(テクスチャ) を使用、ロード失敗時は
 *    単色 Plane/Disc(マテリアル) にフォールバックして必ず起動する
 *  - SPEC.md の数値（パドル/ボール速度/ブロック配置/HP/スコア等）を厳密に再現
 *  - 物理エンジンは使わず、位置更新・反射・AABB×円(最近点)判定を自前実装
 *  - 性能比較用：多数のボール × 数百ブロックの反射/当たり判定を毎フレーム回す
 * ========================================================================== */

(function () {
  "use strict";

  // ---- 定数（SPEC 準拠） -------------------------------------------------
  const W = 960;
  const H = 540;

  // パドル
  const PADDLE_W = 96;
  const PADDLE_H = 18;
  const PADDLE_Y = 510;          // 中心 y 固定
  const PADDLE_SPEED = 600;      // px/s

  // ボール
  const BALL_R = 8;              // 半径
  const BALL_SPEED = 380;        // px/s（一定）
  const LAUNCH_ANGLE_MAX = 60 * Math.PI / 180; // 発射時の左右±60°

  // ブロック（グリッド 15列 × 9行）
  const BRICK_COLS = 15;
  const BRICK_ROWS = 9;
  const BRICK_W = 56;
  const BRICK_H = 20;
  const BRICK_GAP = 4;
  const BRICK_TOP = 60;          // 上オフセット

  const SCORE_PER_BRICK = 10;

  // 同時ボール数（負荷の主軸）
  const INITIAL_BALLS = 3;
  let ballSetting = INITIAL_BALLS; // 初期3個
  const BALL_MIN = 1;
  const BALL_MAX = 500;
  const BALL_STEP = 5;

  // タイトル/アトラクト状態（false=デモ中・操作無効）
  let started = false, blinkT = 0;

  const SPRITE_CAPACITY = 4000;  // 各 SpriteManager の容量上限

  // HP→色（HP3=赤 / HP2=橙 / HP1=緑）。brick.png は明色1枚を tint 乗算する前提。
  const HP_COLORS = {
    3: { hex: "#e84545", c4: new BABYLON.Color4(0.91, 0.27, 0.27, 1) }, // 赤
    2: { hex: "#ef9c2a", c4: new BABYLON.Color4(0.94, 0.61, 0.16, 1) }, // 橙
    1: { hex: "#4fc463", c4: new BABYLON.Color4(0.31, 0.77, 0.39, 1) }, // 緑
  };

  // ---- アセット定義 ------------------------------------------------------
  const ASSET_DIR = "../assets/";
  const ASSETS = {
    paddle: { file: "paddle.png",    size: 96,  fallback: "#f2f2f2", shape: "rect", w: PADDLE_W, h: PADDLE_H },
    ball:   { file: "ball.png",      size: 16,  fallback: "#ffffff", shape: "circle" },
    // brick は明色テクスチャ前提。色は HP に応じて sprite.color / material で付与。
    brick:  { file: "brick.png",     size: 64,  fallback: "#ffffff", shape: "rect", w: BRICK_W, h: BRICK_H },
    spark:  { file: "hit_spark.png", size: 32,  fallback: "#ffe066", shape: "circle" },
    bg:     { file: "bg_breakout.png", size: 512, fallback: null, shape: null },
  };

  // ============================================================
  // Babylon セットアップ
  // ============================================================
  const canvas = document.getElementById("renderCanvas");
  const engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    disableWebGL2Support: false,
  });

  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.047, 0.08, 1.0); // 暗色背景
  scene.skipPointerMovePicking = true;

  // --- 正射影カメラ：スクリーン座標 (x:0..960 右へ, y:0..540 下へ) ---
  // ワールド座標を左上原点・y下向きにする。ortho を反転(top<bottom)して 2D 画面に一致。
  const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
  camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = 0;
  camera.orthoRight = W;
  camera.orthoTop = 0;       // 上端 y=0
  camera.orthoBottom = H;    // 下端 y=540（top<bottom で y 下向き）
  camera.setTarget(new BABYLON.Vector3(0, 0, 0));
  camera.minZ = 0.1;
  camera.maxZ = 1000;

  // ライト不要（マテリアルは emissive / sprite は unlit）だが念のため
  const amb = new BABYLON.HemisphericLight("amb", new BABYLON.Vector3(0, 0, -1), scene);
  amb.intensity = 1.0;

  // ============================================================
  // テクスチャ存在チェック → SpriteManager 構築 or フォールバック
  // ============================================================
  // SpriteManager は失敗時に黒テクスチャになるので、事前に Image で存在確認。
  function checkImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.width > 0 && img.height > 0);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  const managers = {}; // key -> SpriteManager or null

  function makeManager(key) {
    const a = ASSETS[key];
    const sm = new BABYLON.SpriteManager(
      "sm_" + key,
      ASSET_DIR + a.file,
      SPRITE_CAPACITY,
      { width: a.size, height: a.size },
      scene
    );
    sm.isPickable = false;
    return sm;
  }

  // フォールバック用：単色マテリアルを共有
  const fallbackMats = {};
  function fallbackMat(key, hex) {
    const cacheKey = key + (hex || "");
    if (fallbackMats[cacheKey]) return fallbackMats[cacheKey];
    const a = ASSETS[key];
    const m = new BABYLON.StandardMaterial("fm_" + cacheKey, scene);
    const c = BABYLON.Color3.FromHexString(hex || a.fallback || "#888888");
    m.emissiveColor = c;
    m.diffuseColor = c;
    m.specularColor = new BABYLON.Color3(0, 0, 0);
    m.disableLighting = true;
    m.backFaceCulling = false;
    fallbackMats[cacheKey] = m;
    return m;
  }

  // テンプレ Mesh（フォールバック形状）。インスタンス毎に clone する。
  const fallbackTemplates = {};
  function fallbackTemplate(key) {
    if (fallbackTemplates[key]) return fallbackTemplates[key];
    const a = ASSETS[key];
    let mesh;
    if (a.shape === "rect") {
      // 矩形（パドル / ブロック）。基準サイズ 1x1 の Plane を scaling で調整。
      mesh = BABYLON.MeshBuilder.CreatePlane("ft_" + key, { width: 1, height: 1 }, scene);
    } else {
      // 円（disc）。半径 = size/2 で作り、scaling で調整。
      mesh = BABYLON.MeshBuilder.CreateDisc("ft_" + key, { radius: a.size / 2, tessellation: 20 }, scene);
    }
    mesh.material = fallbackMat(key);
    mesh.isPickable = false;
    mesh.setEnabled(false); // テンプレ本体は非表示
    fallbackTemplates[key] = mesh;
    return mesh;
  }

  // --- 統一スプライトラッパ ---
  // { setPos(x,y), setVisible(b), setSize(px) / setRectSize(w,h), setColor(hp), dispose() }
  function createEntitySprite(key) {
    const a = ASSETS[key];
    if (managers[key]) {
      const sp = new BABYLON.Sprite("s", managers[key]);
      sp.width = a.w || a.size;
      sp.height = a.h || a.size;
      return {
        kind: "sprite",
        obj: sp,
        baseSize: a.size,
        setPos(x, y) { sp.position.x = x; sp.position.y = y; sp.position.z = 0; },
        setVisible(b) { sp.isVisible = b; },
        setSize(px) { sp.width = px; sp.height = px; },
        setRectSize(w, h) { sp.width = w; sp.height = h; },
        setColor(hp) { const c = HP_COLORS[hp]; if (c) sp.color = c.c4; }, // tint(乗算)
        dispose() { sp.dispose(); },
      };
    } else {
      const mesh = fallbackTemplate(key).clone("c_" + key);
      mesh.setEnabled(true);
      mesh.isPickable = false;
      const isRect = a.shape === "rect";
      return {
        kind: "mesh",
        obj: mesh,
        baseSize: a.size,
        setPos(x, y) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = 0; },
        setVisible(b) { mesh.setEnabled(b); },
        setSize(px) {
          if (isRect) { mesh.scaling.x = px; mesh.scaling.y = px; }
          else { const s = px / a.size; mesh.scaling.x = s; mesh.scaling.y = s; }
        },
        setRectSize(w, h) { mesh.scaling.x = w; mesh.scaling.y = h; }, // Plane(1x1)を拡大
        setColor(hp) { const c = HP_COLORS[hp]; if (c) mesh.material = fallbackMat(key, c.hex); },
        dispose() { mesh.dispose(); },
      };
    }
  }

  // ============================================================
  // 背景（タイル or 暗色）
  // ============================================================
  let bgTiles = [];
  let bgIsTexture = false;

  function setupBackground(hasBgTexture) {
    bgIsTexture = hasBgTexture;
    if (hasBgTexture) {
      const bgMaterial = new BABYLON.StandardMaterial("bgMat", scene);
      const tex = new BABYLON.Texture(ASSET_DIR + ASSETS.bg.file, scene);
      bgMaterial.emissiveTexture = tex;
      bgMaterial.diffuseTexture = tex;
      bgMaterial.disableLighting = true;
      bgMaterial.backFaceCulling = false;
      // 画面全体を 1 枚で覆う（このゲームの背景はスクロールしない）。
      const p = BABYLON.MeshBuilder.CreatePlane("bg", { width: W, height: H }, scene);
      p.material = bgMaterial;
      p.position.set(W / 2, H / 2, 50); // 奥
      p.isPickable = false;
      bgTiles.push(p);
    }
    // テクスチャ無しの場合は scene.clearColor の暗色をそのまま使う（追加描画なし）。
  }

  // ============================================================
  // ゲーム状態
  // ============================================================
  const Game = {
    paddle: null,
    balls: [],     // { spr, x, y, vx, vy, r }
    bricks: [],    // { spr, x, y, w, h, hp, alive }
    effects: [],   // { spr, x, y, life, maxLife, size }
    score: 0,
    lost: 0,       // ロスト数（落下→再発射）
    aliveBricks: 0,
  };

  // プール（GC負荷軽減）。dispose せず再利用する。
  const pools = {
    ball: [],
    brick: [],
    spark: [],
  };

  function getFromPool(key) {
    const p = pools[key];
    let e = p.pop();
    if (!e) e = createEntitySprite(key);
    e.setVisible(true);
    return e;
  }
  function returnToPool(key, e) {
    e.setVisible(false);
    e.setPos(-9999, -9999);
    pools[key].push(e);
  }

  // ---- 入力 -------------------------------------------------------------
  const keys = {};
  window.addEventListener("keydown", (ev) => {
    keys[ev.key.toLowerCase()] = true;
    // Enter でデモ→プレイ開始
    if (ev.key === "Enter" && !started) { startGame(); ev.preventDefault(); }
    // +/- で同時ボール数を増減（'+','=','-','_' を許容）
    if (ev.key === "+" || ev.key === "=") { adjustBallSetting(+BALL_STEP); }
    if (ev.key === "-" || ev.key === "_") { adjustBallSetting(-BALL_STEP); }
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(ev.key.toLowerCase())) {
      ev.preventDefault();
    }
  });
  window.addEventListener("keyup", (ev) => { keys[ev.key.toLowerCase()] = false; });
  // フォーカスしてキー入力を確実に受ける
  canvas.tabIndex = 1;
  canvas.addEventListener("click", () => canvas.focus());
  setTimeout(() => canvas.focus(), 0);

  function adjustBallSetting(d) {
    ballSetting = Math.max(BALL_MIN, Math.min(BALL_MAX, ballSetting + d));
    syncBallCount(); // 設定値に合わせて即時増減
  }

  // Enter でデモ→プレイ開始: スコア/盤面/ボールを初期化して操作を有効化
  const titleEl = document.getElementById("title");
  function restart() {
    Game.score = 0; Game.lost = 0;
    ballSetting = INITIAL_BALLS;
    Game.paddle.x = W / 2;
    Game.paddle.spr.setPos(Game.paddle.x, Game.paddle.y);
    buildBricks();
    syncBallCount();
  }
  function startGame() {
    started = true; restart();
    if (titleEl) titleEl.style.display = "none";
  }

  // ============================================================
  // ボール：生成 / 再発射
  // ============================================================
  // 上方向へランダム角（左右 ±60°）の速度を作る。
  function launchVelocity() {
    const ang = (Math.random() * 2 - 1) * LAUNCH_ANGLE_MAX; // -60°..+60°
    const vx = Math.sin(ang) * BALL_SPEED;
    const vy = -Math.cos(ang) * BALL_SPEED; // 上向き（y下向き座標なので負）
    return { vx, vy };
  }

  // パドル上から1個発射してボール配列へ追加。
  function spawnBall() {
    const spr = getFromPool("ball");
    const x = Game.paddle.x;
    const y = PADDLE_Y - PADDLE_H / 2 - BALL_R - 1;
    spr.setSize(BALL_R * 2);
    spr.setPos(x, y);
    const v = launchVelocity();
    Game.balls.push({ spr, x, y, vx: v.vx, vy: v.vy, r: BALL_R });
  }

  // 設定値 ballSetting に現在のボール数を合わせる（増減両対応）。
  function syncBallCount() {
    while (Game.balls.length < ballSetting) spawnBall();
    while (Game.balls.length > ballSetting) {
      const b = Game.balls.pop();
      returnToPool("ball", b.spr);
    }
  }

  // 既存ボールをパドル上から再発射（位置/速度を初期化、配列はそのまま）。
  function respawnBall(b) {
    b.x = Game.paddle.x;
    b.y = PADDLE_Y - PADDLE_H / 2 - BALL_R - 1;
    const v = launchVelocity();
    b.vx = v.vx; b.vy = v.vy;
    b.spr.setPos(b.x, b.y);
  }

  // ============================================================
  // ブロック盤面：生成 / 再生成
  // ============================================================
  // グリッド全体を中央寄せする際の左端 x を計算。
  function gridLeft() {
    const totalW = BRICK_COLS * BRICK_W + (BRICK_COLS - 1) * BRICK_GAP;
    return (W - totalW) / 2;
  }

  function buildBricks() {
    // 既存をプールへ返却
    for (const br of Game.bricks) returnToPool("brick", br.spr);
    Game.bricks.length = 0;

    const left = gridLeft();
    for (let row = 0; row < BRICK_ROWS; row++) {
      // 上3行=HP3 / 中3行=HP2 / 下3行=HP1
      const hp = row < 3 ? 3 : (row < 6 ? 2 : 1);
      const cy = BRICK_TOP + row * (BRICK_H + BRICK_GAP) + BRICK_H / 2;
      for (let col = 0; col < BRICK_COLS; col++) {
        const cx = left + col * (BRICK_W + BRICK_GAP) + BRICK_W / 2;
        const spr = getFromPool("brick");
        spr.setRectSize(BRICK_W, BRICK_H);
        spr.setColor(hp);
        spr.setPos(cx, cy);
        Game.bricks.push({ spr, x: cx, y: cy, w: BRICK_W, h: BRICK_H, hp, alive: true });
      }
    }
    Game.aliveBricks = Game.bricks.length;
  }

  // ============================================================
  // パドル / エフェクト
  // ============================================================
  function initPaddle() {
    const spr = createEntitySprite("paddle");
    spr.setRectSize(PADDLE_W, PADDLE_H);
    Game.paddle = { spr, x: W / 2, y: PADDLE_Y, w: PADDLE_W, h: PADDLE_H };
    spr.setPos(Game.paddle.x, Game.paddle.y);
  }

  // 破壊エフェクト（一瞬の spark）
  function spawnSpark(x, y) {
    const e = getFromPool("spark");
    e.setPos(x, y);
    e.setSize(20);
    Game.effects.push({ spr: e, x, y, life: 0.20, maxLife: 0.20, size: 28 });
  }

  // ============================================================
  // 当たり判定：AABB(矩形) × 円（最近点）
  // ============================================================
  // 矩形(中心 bx,by, 半幅 hw, 半高 hh) と 円(cx,cy,r)。
  // 返り値：当たっていれば反転すべき面情報、無ければ null。
  function brickCircleHit(bx, by, hw, hh, cx, cy, r) {
    // 円中心を矩形ローカルへ。最近点をクランプで求める。
    const nx = Math.max(bx - hw, Math.min(cx, bx + hw));
    const ny = Math.max(by - hh, Math.min(cy, by + hh));
    const dx = cx - nx;
    const dy = cy - ny;
    if (dx * dx + dy * dy > r * r) return null;
    // 当たった面の判定：矩形中心からのめり込み量を正規化して比較。
    // x方向/y方向どちらの貫通が浅いかで反転面を決める。
    const ox = (hw + r) - Math.abs(cx - bx); // x方向の重なり量
    const oy = (hh + r) - Math.abs(cy - by); // y方向の重なり量
    if (ox < oy) {
      return { axis: "x", dir: Math.sign(cx - bx) || 1 };
    } else {
      return { axis: "y", dir: Math.sign(cy - by) || 1 };
    }
  }

  // ============================================================
  // 更新
  // ============================================================
  function update(dt) {
    // --- パドル移動（水平のみ + クランプ） ---
    let mx = 0;
    if (!started) {
      // デモAI: 最も下(最大y)のボールの x へパドルを追従させる(速度上限内で)
      let target = Game.paddle.x, lowestY = -Infinity;
      for (let i = 0; i < Game.balls.length; i++) { if (Game.balls[i].y > lowestY) { lowestY = Game.balls[i].y; target = Game.balls[i].x; } }
      const diff = target - Game.paddle.x;
      if (Math.abs(diff) > 1) mx = diff > 0 ? 1 : -1;
    } else {
      if (keys["arrowleft"] || keys["a"]) mx -= 1;
      if (keys["arrowright"] || keys["d"]) mx += 1;
    }
    Game.paddle.x += mx * PADDLE_SPEED * dt;
    const half = PADDLE_W / 2;
    Game.paddle.x = Math.max(half, Math.min(W - half, Game.paddle.x));
    Game.paddle.spr.setPos(Game.paddle.x, Game.paddle.y);

    const paddleTop = PADDLE_Y - PADDLE_H / 2;

    // --- ボール 更新（移動 / 壁・天井 / パドル / ブロック反射） ---
    for (let i = 0; i < Game.balls.length; i++) {
      const b = Game.balls[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // 左右の壁
      if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
      else if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx); }
      // 天井
      if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }

      // パドル反射（常に上方向へ。中心からのオフセットで角度を変える）
      if (b.vy > 0 &&
          b.y + b.r >= paddleTop &&
          b.y - b.r <= PADDLE_Y + PADDLE_H / 2 &&
          b.x >= Game.paddle.x - half - b.r &&
          b.x <= Game.paddle.x + half + b.r) {
        const offset = (b.x - Game.paddle.x) / half; // -1..+1（端ほど横に鋭く）
        const clamped = Math.max(-1, Math.min(1, offset));
        const ang = clamped * LAUNCH_ANGLE_MAX;       // ±60°
        b.vx = Math.sin(ang) * BALL_SPEED;
        b.vy = -Math.cos(ang) * BALL_SPEED;           // 上向き
        b.y = paddleTop - b.r - 0.5;                  // めり込み補正
      }

      // ブロック反射（1ボール=1フレーム1ブロックまで。最初の命中で break）
      for (let k = 0; k < Game.bricks.length; k++) {
        const br = Game.bricks[k];
        if (!br.alive) continue;
        const res = brickCircleHit(br.x, br.y, br.w / 2, br.h / 2, b.x, b.y, b.r);
        if (res) {
          // 当たった面で速度反転
          if (res.axis === "x") {
            b.vx = Math.abs(b.vx) * res.dir;
            b.x = br.x + res.dir * (br.w / 2 + b.r + 0.5); // めり込み押し出し
          } else {
            b.vy = Math.abs(b.vy) * res.dir;
            b.y = br.y + res.dir * (br.h / 2 + b.r + 0.5);
          }
          // HP-1、0で破壊
          br.hp -= 1;
          if (br.hp <= 0) {
            br.alive = false;
            Game.aliveBricks -= 1;
            Game.score += SCORE_PER_BRICK;
            spawnSpark(br.x, br.y);
            returnToPool("brick", br.spr);
          } else {
            br.spr.setColor(br.hp); // 残HPの色へ更新
          }
          break; // 1フレーム1ブロック
        }
      }

      // 速さを一定(380)へ再正規化（数値誤差/反射で僅かにずれるため）
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const k = BALL_SPEED / sp;
      b.vx *= k; b.vy *= k;

      // 下端を抜けたらロスト→パドル上から再発射（同時数を維持）
      if (b.y - b.r > H) {
        Game.lost += 1;
        respawnBall(b);
        continue;
      }

      b.spr.setPos(b.x, b.y);
    }

    // --- 全ブロック破壊で盤面再生成（ベンチ継続） ---
    if (Game.aliveBricks <= 0) {
      buildBricks();
    }

    // --- エフェクト（一瞬の spark をフェード/拡大） ---
    for (let i = Game.effects.length - 1; i >= 0; i--) {
      const f = Game.effects[i];
      f.life -= dt;
      const t = Math.max(0, f.life / f.maxLife);
      f.spr.setSize(f.size * (0.5 + (1 - t) * 0.8));
      if (f.life <= 0) {
        returnToPool("spark", f.spr);
        Game.effects.splice(i, 1);
      }
    }
  }

  // ============================================================
  // HUD（FPS 移動平均）
  // ============================================================
  const hudEl = document.getElementById("hud");
  let fpsAvg = 60;
  let hudTimer = 0;

  function objectCount() {
    // ボール + 残ブロック + エフェクト
    return Game.balls.length + Game.aliveBricks + Game.effects.length;
  }

  function updateHud(dt) {
    const inst = dt > 0 ? 1 / dt : 60;
    fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
    hudTimer -= dt;
    if (hudTimer > 0) return;
    hudTimer = 0.1;
    // 表示内容・書式は three.js に統一
    hudEl.textContent =
      `FPS     : ${fpsAvg.toFixed(1)}\n` +
      `Objects : ${objectCount()}  (ball ${Game.balls.length} / brick ${Game.aliveBricks} / fx ${Game.effects.length})\n` +
      `Score   : ${Game.score}\n` +
      `Balls   : ${Game.balls.length} / ${ballSetting}  (+/- to change, 1..${BALL_MAX})\n` +
      `Bricks  : ${Game.aliveBricks}\n` +
      `Lost    : ${Game.lost}`;
  }

  // ============================================================
  // 起動：アセット確認 → 構築 → ループ開始
  // ============================================================
  let assetsAllOk = true;

  async function boot() {
    const keysToCheck = ["paddle", "ball", "brick", "spark"];
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

    const bgOk = await checkImage(ASSET_DIR + ASSETS.bg.file);
    if (!bgOk) assetsAllOk = false;
    setupBackground(bgOk);

    // 盤面・パドル・初期ボール
    initPaddle();
    buildBricks();
    syncBallCount();

    engine.runRenderLoop(() => {
      let dt = engine.getDeltaTime() / 1000;
      if (dt > 0.05) dt = 0.05; // スパイク抑制（クランプ）
      update(dt);
      updateHud(dt);
      // タイトル点滅 (アトラクト中のみ)
      if (!started && titleEl) {
        blinkT += dt;
        titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
      }
      scene.render();
    });

    window.addEventListener("resize", () => engine.resize());
  }

  boot();
})();
