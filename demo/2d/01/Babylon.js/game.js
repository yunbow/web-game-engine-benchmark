/* ============================================================================
 * 弾幕STG（縦スクロールシューティング） - Babylon.js 版
 * --------------------------------------------------------------------------
 * 3Dエンジン Babylon.js を使い 2D STG を実装。
 *  - 正射影(Orthographic)カメラで画面座標 (0,0)=左上 / (960,540)=右下 を再現
 *  - スプライトは SpriteManager(テクスチャ) を使用、ロード失敗時は
 *    単色 Plane(マテリアル) にフォールバックして必ず起動する
 *  - SPEC.md の数値（弾速/連射間隔/敵速/HP/スコア等）を厳密に再現
 * ========================================================================== */

(function () {
  "use strict";

  // ---- 定数（SPEC 準拠） -------------------------------------------------
  const W = 960;
  const H = 540;

  const PLAYER_SPEED = 300;        // 自機移動 px/s（8方向）
  const PLAYER_BULLET_SPEED = 600; // 自機弾速 px/s（上方向）
  const FIRE_INTERVAL = 0.150;     // 連射間隔 150ms
  const ENEMY_BULLET_SPEED = 200;  // 敵弾速 px/s
  const ENEMY_SPEED_MIN = 80;      // 敵 下方向 px/s
  const ENEMY_SPEED_MAX = 140;
  const ENEMY_FIRE_MIN = 1.0;      // 敵の発射間隔(s) ランダム範囲
  const ENEMY_FIRE_MAX = 2.5;

  const PLAYER_HP_INIT = 3;
  const SCORE_PER_KILL = 10;

  // 当たり判定半径（円判定）
  const R_PLAYER = 16;
  const R_PLAYER_BULLET = 6;
  const R_ENEMY_SMALL = 18;
  const R_ENEMY_BIG = 40;
  const R_ENEMY_BULLET = 7;

  let maxEnemies = 40;             // 初期同時最大40体
  const MAX_ENEMIES_LIMIT = 300;
  const MAX_ENEMIES_STEP = 10;

  const SPRITE_CAPACITY = 4000;    // 各 SpriteManager の容量上限

  // ---- アセット定義 ------------------------------------------------------
  const ASSET_DIR = "../assets/";
  const ASSETS = {
    player:  { file: "player_ship.png",  size: 64, fallback: "#55ccff", shape: "tri" },
    small:   { file: "enemy_small.png",  size: 48, fallback: "#ff5555", shape: "circle" },
    big:     { file: "enemy_big.png",    size: 96, fallback: "#ff77aa", shape: "circle" },
    pbullet: { file: "bullet_player.png",size: 24, fallback: "#ffff55", shape: "circle" },
    ebullet: { file: "bullet_enemy.png", size: 16, fallback: "#ff9933", shape: "circle" },
    boom:    { file: "explosion.png",    size: 64, fallback: "#ffcc66", shape: "circle" },
    bg:      { file: "bg_space.png",     size: 512, fallback: null, shape: null },
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
  scene.clearColor = new BABYLON.Color4(0.02, 0.024, 0.06, 1.0); // 宇宙の暗色
  scene.skipPointerMovePicking = true;

  // --- 正射影カメラ：スクリーン座標 (x:0..960 右へ, y:0..540 下へ) ---
  // ワールド座標は左上原点・y下向きにする。ortho を反転して 2D 画面に一致させる。
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

  // --- スプライト型エンティティ：テクスチャがあれば Sprite、無ければ Plane ---
  // 統一インターフェース { setPos(x,y), setVisible(b), setSize(px), dispose() }
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

  // テンプレ Plane（フォールバック形状）。インスタンス毎に clone する。
  const fallbackTemplates = {};
  function fallbackTemplate(key) {
    if (fallbackTemplates[key]) return fallbackTemplates[key];
    const a = ASSETS[key];
    let mesh;
    if (a.shape === "tri") {
      // 上向き三角形（自機）
      const s = a.size / 2;
      const positions = [0, -s, 0, -s, s, 0, s, s, 0];
      const indices = [0, 1, 2];
      const vd = new BABYLON.VertexData();
      vd.positions = positions;
      vd.indices = indices;
      vd.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1];
      mesh = new BABYLON.Mesh("ft_" + key, scene);
      vd.applyToMesh(mesh);
    } else {
      // 円（disc）。デフォルトサイズで作り、scaling で調整
      mesh = BABYLON.MeshBuilder.CreateDisc("ft_" + key, { radius: a.size / 2, tessellation: 20 }, scene);
    }
    mesh.material = fallbackMat(key);
    mesh.isPickable = false;
    mesh.setEnabled(false); // テンプレ本体は非表示
    fallbackTemplates[key] = mesh;
    return mesh;
  }

  // 統一スプライトラッパ
  function createEntitySprite(key) {
    const a = ASSETS[key];
    if (managers[key]) {
      const sp = new BABYLON.Sprite("s", managers[key]);
      sp.width = a.size;
      sp.height = a.size;
      return {
        kind: "sprite",
        obj: sp,
        baseSize: a.size,
        setPos(x, y) { sp.position.x = x; sp.position.y = y; sp.position.z = 0; },
        setVisible(b) { sp.isVisible = b; },
        setSize(px) { sp.width = px; sp.height = px; },
        setAngle(r) { sp.angle = r; },
        dispose() { sp.dispose(); },
      };
    } else {
      const mesh = fallbackTemplate(key).clone("c_" + key);
      mesh.setEnabled(true);
      mesh.isPickable = false;
      return {
        kind: "mesh",
        obj: mesh,
        baseSize: a.size,
        setPos(x, y) { mesh.position.x = x; mesh.position.y = y; mesh.position.z = 0; },
        setVisible(b) { mesh.setEnabled(b); },
        setSize(px) {
          const s = px / a.size;
          mesh.scaling.x = s; mesh.scaling.y = s;
        },
        setAngle(r) { mesh.rotation.z = -r; },
        dispose() { mesh.dispose(); },
      };
    }
  }

  // ============================================================
  // 背景（スクロール）
  // ============================================================
  let bgTiles = [];     // 縦タイル用
  let bgMaterial = null;
  let bgIsTexture = false;

  function setupBackground(hasBgTexture) {
    bgIsTexture = hasBgTexture;
    if (hasBgTexture) {
      bgMaterial = new BABYLON.StandardMaterial("bgMat", scene);
      const tex = new BABYLON.Texture(ASSET_DIR + ASSETS.bg.file, scene);
      tex.wAng = 0;
      bgMaterial.emissiveTexture = tex;
      bgMaterial.diffuseTexture = tex;
      bgMaterial.disableLighting = true;
      bgMaterial.backFaceCulling = false;

      // 画面を覆う 2 枚の縦タイル（スクロール用に上下に並べる）
      for (let i = 0; i < 2; i++) {
        const p = BABYLON.MeshBuilder.CreatePlane("bg" + i, { width: W, height: H }, scene);
        p.material = bgMaterial;
        p.position.x = W / 2;
        p.position.y = H / 2 - i * H;
        p.position.z = 50; // 奥
        p.isPickable = false;
        bgTiles.push(p);
      }
    } else {
      // 星空をパーティクル風に点で表現（軽量：小さな disc を散らす）
      const starMat = new BABYLON.StandardMaterial("starMat", scene);
      starMat.emissiveColor = new BABYLON.Color3(0.8, 0.85, 1.0);
      starMat.disableLighting = true;
      const starTpl = BABYLON.MeshBuilder.CreateDisc("starTpl", { radius: 1.2, tessellation: 6 }, scene);
      starTpl.material = starMat;
      starTpl.isPickable = false;
      starTpl.setEnabled(false);
      for (let i = 0; i < 80; i++) {
        const s = starTpl.clone("star" + i);
        s.setEnabled(true);
        s.position.x = Math.random() * W;
        s.position.y = Math.random() * H;
        s.position.z = 50;
        s.scaling.setAll(0.5 + Math.random() * 1.5);
        bgTiles.push({ mesh: s, speed: 30 + Math.random() * 60 });
      }
    }
  }

  function updateBackground(dt) {
    const scroll = 60; // px/s
    if (bgIsTexture) {
      for (const p of bgTiles) {
        p.position.y += scroll * dt;
        if (p.position.y - H / 2 >= H) {
          p.position.y -= H * 2;
        }
      }
    } else {
      for (const s of bgTiles) {
        s.mesh.position.y += s.speed * dt;
        if (s.mesh.position.y > H + 4) {
          s.mesh.position.y = -4;
          s.mesh.position.x = Math.random() * W;
        }
      }
    }
  }

  // ============================================================
  // ゲーム状態
  // ============================================================
  const Game = {
    player: null,
    playerBullets: [],
    enemyBullets: [],
    enemies: [],
    effects: [],
    score: 0,
    hp: PLAYER_HP_INIT,
    fireTimer: 0,
    spawnTimer: 0,
    over: false,
  };

  // タイトル/アトラクト状態（false=デモ中・操作無効、デモAIが自機を動かす）
  let started = false, blinkT = 0, autoT = 0;
  const titleEl = document.getElementById("title");

  // プール（GC負荷軽減）。dispose せず再利用する。
  const pools = {
    pbullet: [],
    ebullet: [],
    small: [],
    big: [],
    boom: [],
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
    if (ev.key === "Enter" && !started) startGame();
    if (ev.key === "+" || ev.key === "=") { adjustMaxEnemies(+MAX_ENEMIES_STEP); }
    if (ev.key === "-" || ev.key === "_") { adjustMaxEnemies(-MAX_ENEMIES_STEP); }
    if (started && Game.over && (ev.key === "Enter")) restart();
    if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(ev.key.toLowerCase())) {
      ev.preventDefault();
    }
  });
  window.addEventListener("keyup", (ev) => { keys[ev.key.toLowerCase()] = false; });
  canvas.addEventListener("click", () => { if (started && Game.over) restart(); });
  // フォーカスしてキー入力を確実に受ける
  canvas.tabIndex = 1;
  setTimeout(() => canvas.focus(), 0);

  function adjustMaxEnemies(d) {
    maxEnemies = Math.max(0, Math.min(MAX_ENEMIES_LIMIT, maxEnemies + d));
  }

  // ============================================================
  // スポーン / 発射
  // ============================================================
  function spawnEnemy() {
    const isBig = Math.random() < 0.18;
    const key = isBig ? "big" : "small";
    const e = getFromPool(key);
    const r = isBig ? R_ENEMY_BIG : R_ENEMY_SMALL;
    const x = r + Math.random() * (W - 2 * r);
    const y = -r;
    e.setPos(x, y);
    Game.enemies.push({
      spr: e, key: key, x: x, y: y, r: r,
      vy: ENEMY_SPEED_MIN + Math.random() * (ENEMY_SPEED_MAX - ENEMY_SPEED_MIN),
      hp: isBig ? 3 : 1,
      fireTimer: ENEMY_FIRE_MIN + Math.random() * (ENEMY_FIRE_MAX - ENEMY_FIRE_MIN),
    });
  }

  function firePlayerBullet() {
    const b = getFromPool("pbullet");
    const px = Game.player.x, py = Game.player.y - R_PLAYER;
    b.setPos(px, py);
    Game.playerBullets.push({ spr: b, x: px, y: py, vy: -PLAYER_BULLET_SPEED, r: R_PLAYER_BULLET });
  }

  function fireEnemyBullet(enemy) {
    const b = getFromPool("ebullet");
    const dx = Game.player.x - enemy.x;
    const dy = Game.player.y - enemy.y;
    const len = Math.hypot(dx, dy) || 1;
    const vx = (dx / len) * ENEMY_BULLET_SPEED;
    const vy = (dy / len) * ENEMY_BULLET_SPEED;
    b.setPos(enemy.x, enemy.y);
    Game.enemyBullets.push({ spr: b, x: enemy.x, y: enemy.y, vx: vx, vy: vy, r: R_ENEMY_BULLET });
  }

  function spawnExplosion(x, y, size) {
    const e = getFromPool("boom");
    e.setPos(x, y);
    e.setSize(size * 0.6);
    Game.effects.push({ spr: e, x: x, y: y, life: 0.30, maxLife: 0.30, size: size });
  }

  // ============================================================
  // プレイヤー初期化
  // ============================================================
  function initPlayer() {
    const spr = createEntitySprite("player");
    Game.player = { spr: spr, x: W / 2, y: H - 80, r: R_PLAYER };
    spr.setPos(Game.player.x, Game.player.y);
  }

  function restart() {
    // 全エンティティをプールへ戻す
    for (const b of Game.playerBullets) returnToPool("pbullet", b.spr);
    for (const b of Game.enemyBullets) returnToPool("ebullet", b.spr);
    for (const e of Game.enemies) returnToPool(e.key, e.spr);
    for (const f of Game.effects) returnToPool("boom", f.spr);
    Game.playerBullets.length = 0;
    Game.enemyBullets.length = 0;
    Game.enemies.length = 0;
    Game.effects.length = 0;
    Game.score = 0;
    Game.hp = PLAYER_HP_INIT;
    Game.fireTimer = 0;
    Game.spawnTimer = 0;
    Game.over = false;
    Game.player.x = W / 2; Game.player.y = H - 80;
    Game.player.spr.setVisible(true);
    Game.player.spr.setPos(Game.player.x, Game.player.y);
    document.getElementById("gameover").style.display = "none";
  }

  // Enter でデモ→プレイ開始: 新規リセット（restart 流用）して操作を有効化、タイトルを消す
  function startGame() {
    started = true;
    restart();
    if (titleEl) titleEl.style.display = "none";
  }

  // ============================================================
  // 当たり判定（円）
  // ============================================================
  function hit(ax, ay, ar, bx, by, br) {
    const dx = ax - bx, dy = ay - by;
    const rr = ar + br;
    return dx * dx + dy * dy <= rr * rr;
  }

  // ============================================================
  // 更新
  // ============================================================
  function update(dt) {
    updateBackground(dt);
    if (Game.over && !started) restart(); // アトラクト中の被弾死はデモをループ再開
    if (Game.over) return;

    // --- 自機移動（8方向 + クランプ） ---
    let mx = 0, my = 0;
    if (!started) {
      // デモAI: 累積時間の sin で緩やかに左右＋上下移動（決定的・Math.random不使用）
      autoT += dt;
      mx = Math.cos(autoT * 0.8);
      my = 0;
    } else {
      if (keys["arrowleft"] || keys["a"]) mx -= 1;
      if (keys["arrowright"] || keys["d"]) mx += 1;
      if (keys["arrowup"] || keys["w"]) my -= 1;
      if (keys["arrowdown"] || keys["s"]) my += 1;
    }
    if (mx !== 0 && my !== 0) { const inv = 1 / Math.sqrt(2); mx *= inv; my *= inv; }
    Game.player.x += mx * PLAYER_SPEED * dt;
    Game.player.y += my * PLAYER_SPEED * dt;
    Game.player.x = Math.max(R_PLAYER, Math.min(W - R_PLAYER, Game.player.x));
    Game.player.y = Math.max(R_PLAYER, Math.min(H - R_PLAYER, Game.player.y));
    Game.player.spr.setPos(Game.player.x, Game.player.y);

    // --- オート連射 ---
    Game.fireTimer -= dt;
    if (Game.fireTimer <= 0) {
      firePlayerBullet();
      Game.fireTimer += FIRE_INTERVAL;
      if (Game.fireTimer < 0) Game.fireTimer = FIRE_INTERVAL;
    }

    // --- スポーン（同時最大 maxEnemies を維持） ---
    Game.spawnTimer -= dt;
    if (Game.spawnTimer <= 0) {
      let need = maxEnemies - Game.enemies.length;
      // 1フレームに出し過ぎないよう小刻みに補充
      const batch = Math.min(need, 6);
      for (let i = 0; i < batch; i++) spawnEnemy();
      Game.spawnTimer = 0.08;
    }

    // --- 自機弾 ---
    for (let i = Game.playerBullets.length - 1; i >= 0; i--) {
      const b = Game.playerBullets[i];
      b.y += b.vy * dt;
      b.spr.setPos(b.x, b.y);
      if (b.y < -20) {
        returnToPool("pbullet", b.spr);
        Game.playerBullets.splice(i, 1);
      }
    }

    // --- 敵 更新 + 発射 ---
    for (let i = Game.enemies.length - 1; i >= 0; i--) {
      const e = Game.enemies[i];
      e.y += e.vy * dt;
      e.spr.setPos(e.x, e.y);
      e.fireTimer -= dt;
      if (e.fireTimer <= 0 && e.y > 0 && e.y < H * 0.7) {
        fireEnemyBullet(e);
        e.fireTimer = ENEMY_FIRE_MIN + Math.random() * (ENEMY_FIRE_MAX - ENEMY_FIRE_MIN);
      }
      if (e.y > H + e.r) {
        returnToPool(e.key, e.spr);
        Game.enemies.splice(i, 1);
      }
    }

    // --- 敵弾 ---
    for (let i = Game.enemyBullets.length - 1; i >= 0; i--) {
      const b = Game.enemyBullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.spr.setPos(b.x, b.y);
      if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
        returnToPool("ebullet", b.spr);
        Game.enemyBullets.splice(i, 1);
      }
    }

    // --- 衝突：自機弾 × 敵 ---
    for (let i = Game.enemies.length - 1; i >= 0; i--) {
      const e = Game.enemies[i];
      for (let j = Game.playerBullets.length - 1; j >= 0; j--) {
        const b = Game.playerBullets[j];
        if (hit(e.x, e.y, e.r, b.x, b.y, b.r)) {
          returnToPool("pbullet", b.spr);
          Game.playerBullets.splice(j, 1);
          e.hp -= 1;
          if (e.hp <= 0) {
            spawnExplosion(e.x, e.y, e.r * 2);
            Game.score += SCORE_PER_KILL;
            returnToPool(e.key, e.spr);
            Game.enemies.splice(i, 1);
            break;
          }
        }
      }
    }

    // --- 衝突：敵弾 × 自機 ---
    for (let i = Game.enemyBullets.length - 1; i >= 0; i--) {
      const b = Game.enemyBullets[i];
      if (hit(Game.player.x, Game.player.y, Game.player.r, b.x, b.y, b.r)) {
        returnToPool("ebullet", b.spr);
        Game.enemyBullets.splice(i, 1);
        damagePlayer();
      }
    }

    // --- 衝突：敵 × 自機 ---
    for (let i = Game.enemies.length - 1; i >= 0; i--) {
      const e = Game.enemies[i];
      if (hit(Game.player.x, Game.player.y, Game.player.r, e.x, e.y, e.r)) {
        spawnExplosion(e.x, e.y, e.r * 2);
        returnToPool(e.key, e.spr);
        Game.enemies.splice(i, 1);
        damagePlayer();
      }
    }

    // --- エフェクト ---
    for (let i = Game.effects.length - 1; i >= 0; i--) {
      const f = Game.effects[i];
      f.life -= dt;
      const t = Math.max(0, f.life / f.maxLife);
      f.spr.setSize(f.size * (0.4 + (1 - t) * 0.9));
      if (f.life <= 0) {
        returnToPool("boom", f.spr);
        Game.effects.splice(i, 1);
      }
    }
  }

  function damagePlayer() {
    if (Game.over) return;
    Game.hp -= 1;
    spawnExplosion(Game.player.x, Game.player.y, 64);
    if (Game.hp <= 0) {
      Game.hp = 0;
      Game.over = true;
      Game.player.spr.setVisible(false);
      // GAME OVER 表示はプレイ中のみ。アトラクト中はデモをループ再開する。
      if (started) {
        document.getElementById("goScore").textContent = "Score: " + Game.score;
        document.getElementById("gameover").style.display = "flex";
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
    return Game.playerBullets.length + Game.enemyBullets.length +
           Game.enemies.length + Game.effects.length;
  }

  function updateHud(dt) {
    const inst = dt > 0 ? 1 / dt : 60;
    fpsAvg += (inst - fpsAvg) * 0.08; // 指数移動平均
    hudTimer -= dt;
    if (hudTimer > 0) return;
    hudTimer = 0.1;
    const pb = Game.playerBullets.length, eb = Game.enemyBullets.length;
    const en = Game.enemies.length, fx = Game.effects.length;
    const objects = pb + eb + en + fx;
    // 表示内容は three.js に統一
    hudEl.textContent =
      'FPS     : ' + fpsAvg.toFixed(1) + "\n" +
      'Objects : ' + objects + "  (bul " + (pb + eb) + " / ene " + en + " / fx " + fx + ")\n" +
      'Score   : ' + Game.score + "\n" +
      'HP      : ' + (Game.hp > 0 ? '♥'.repeat(Game.hp) + ' (' + Game.hp + ')' : 'GAME OVER') + "\n" +
      'MaxEnemy: ' + maxEnemies + "  (+/- to change, cap " + MAX_ENEMIES_LIMIT + ")";
  }

  // ============================================================
  // 起動：アセット確認 → 構築 → ループ開始
  // ============================================================
  let assetsAllOk = true;

  async function boot() {
    const keysToCheck = ["player", "small", "big", "pbullet", "ebullet", "boom"];
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

    initPlayer();

    engine.runRenderLoop(() => {
      let dt = engine.getDeltaTime() / 1000;
      if (dt > 0.05) dt = 0.05; // スパイク抑制
      update(dt);
      updateHud(dt);
      scene.render();

      if (!started && titleEl) {
        blinkT += dt;
        titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
      }
    });

    window.addEventListener("resize", () => engine.resize());
  }

  boot();
})();
