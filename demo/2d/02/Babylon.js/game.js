/* =====================================================================
 * トップダウン・サバイバー - Babylon.js 実装
 *
 * - 2Dゲームを Babylon.js (3Dエンジン) で構築。
 * - 正射影カメラ (ORTHOGRAPHIC) + SpriteManager / Sprite でスプライト描画。
 *   数百〜千体の敵を SpriteManager のバッチ描画で一括処理する。
 * - 画像アセット (../assets/) が読めない場合は、動的生成した単色図形
 *   テクスチャでフォールバックして必ず起動する。
 * - 全数値は SPEC.md に厳密準拠。
 * ===================================================================== */

(function () {
  "use strict";

  // ----------------------------------------------------------------- 定数
  const VIEW_W = 960;
  const VIEW_H = 540;

  const PLAYER_SPEED = 180;          // px/s
  const ATTACK_INTERVAL = 0.4;       // 400ms
  const PROJECTILE_SPEED = 350;      // px/s
  const PROJECTILE_LIFE = 2.0;       // 弾の生存秒(画面外掃除用)
  const ENEMY_SPEED_MIN = 60;        // px/s
  const ENEMY_SPEED_MAX = 90;        // px/s
  const INVULN_TIME = 0.5;           // 無敵 0.5s
  const PLAYER_HP_MAX = 5;

  const SPAWN_INITIAL = 150;         // 初期同時敵数(=目標数)
  const SPAWN_STEP = 50;             // +/- 増減
  const SPAWN_CAP = 1000;            // 上限
  const AUTO_INCREASE_EVERY = 10.0;  // 10秒ごと
  const AUTO_INCREASE_AMT = 25;      // +25

  // 半径(円当たり判定 / px)。スプライト推奨pxの概ね半分。
  const PLAYER_R = 20;
  const BAT_R = 14;
  const ZOMBIE_R = 18;
  const PROJ_R = 10;
  const GEM_R = 10;
  const PICKUP_R = 26;               // gem 取得半径(自機R + 余裕)

  // ワールド座標は px とする。Babylon の Y を画面の上方向に対応させる。
  // 敵スポーンは画面外周の少し外。
  const SPAWN_MARGIN = 60;

  // ----------------------------------------------------------------- DOM
  const canvas = document.getElementById("renderCanvas");
  const hudEl = document.getElementById("hud");
  const titleEl = document.getElementById("title");

  // ----------------------------------------------------------------- Babylon 初期化
  const engine = new BABYLON.Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
    disableWebGL2Support: false,
  });
  engine.setHardwareScalingLevel(1);

  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04, 0.10, 0.04, 1);
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;
  scene.autoClearDepthAndStencil = true;

  // 正射影カメラ。画面 px とワールド px を 1:1 にする。
  const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 0, -100), scene);
  camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  camera.setTarget(new BABYLON.Vector3(0, 0, 0));
  function applyOrtho(centerX, centerY) {
    camera.orthoLeft = centerX - VIEW_W / 2;
    camera.orthoRight = centerX + VIEW_W / 2;
    camera.orthoTop = centerY + VIEW_H / 2;
    camera.orthoBottom = centerY - VIEW_H / 2;
  }
  applyOrtho(0, 0);

  // SpriteManager は深度を z で扱わない(描画順は manager 単位)。
  // 重なり順: ground(背景plane) < gem < enemy < projectile < player。

  // ----------------------------------------------------------------- フォールバックテクスチャ生成
  // canvas に図形を描いて DynamicTexture/DataURL を作る。
  function makeShapeTexture(size, drawFn) {
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    drawFn(ctx, size);
    return c.toDataURL("image/png");
  }
  function circleTex(size, color) {
    return makeShapeTexture(size, (ctx, s) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.stroke();
    });
  }
  function diamondTex(size, color) {
    return makeShapeTexture(size, (ctx, s) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(s / 2, 2);
      ctx.lineTo(s - 2, s / 2);
      ctx.lineTo(s / 2, s - 2);
      ctx.lineTo(2, s / 2);
      ctx.closePath();
      ctx.fill();
    });
  }

  const FALLBACK = {
    player: circleTex(48, "#ffffff"),
    enemy_bat: circleTex(32, "#a64dff"),
    enemy_zombie: circleTex(40, "#3fcf5a"),
    projectile: circleTex(24, "#ffd400"),
    xp_gem: diamondTex(16, "#39d8ff"),
  };

  // アセット存在チェック: Image を試しに読み、成功時のみ使う。
  // 失敗時はフォールバックを使う。
  function resolveTexture(name, px, fallbackUrl, cb) {
    const url = "../assets/" + name;
    const img = new Image();
    let done = false;
    img.onload = function () {
      if (done) return; done = true;
      cb(url, true);
    };
    img.onerror = function () {
      if (done) return; done = true;
      cb(fallbackUrl, false);
    };
    img.src = url;
  }

  // ----------------------------------------------------------------- 地面タイル
  let groundMesh = null;
  let groundMat = null;
  function setupGround(url, isImage) {
    const mat = new BABYLON.StandardMaterial("groundMat", scene);
    mat.disableLighting = true;
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.backFaceCulling = false;
    if (isImage) {
      const tex = new BABYLON.Texture(url, scene, true, true,
        BABYLON.Texture.NEAREST_SAMPLINGMODE);
      tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      mat.emissiveTexture = tex;
    } else {
      mat.emissiveColor = new BABYLON.Color3(0.07, 0.16, 0.07);
    }
    groundMat = mat;
    // 大きな平面を作りカメラ追従させて無限スクロール風に。
    const W = VIEW_W * 3, H = VIEW_H * 3;
    groundMesh = BABYLON.MeshBuilder.CreatePlane("ground",
      { width: W, height: H }, scene);
    groundMesh.material = mat;
    groundMesh.position.z = 10; // カメラは z=-100 を向くので奥
    groundMesh.isPickable = false;
    if (isImage && mat.emissiveTexture) {
      const tile = 64;
      mat.emissiveTexture.uScale = W / tile;
      mat.emissiveTexture.vScale = H / tile;
    }
  }

  // ----------------------------------------------------------------- SpriteManager 群
  // capacity は上限敵数 + 余裕。SPEC上限 1000。
  let mgrBat, mgrZombie, mgrProj, mgrGem, mgrPlayer;
  function createManagers() {
    mgrGem = new BABYLON.SpriteManager("gemMgr", FALLBACK.xp_gem, 2200, 16, scene);
    mgrBat = new BABYLON.SpriteManager("batMgr", FALLBACK.enemy_bat, 1100, 32, scene);
    mgrZombie = new BABYLON.SpriteManager("zombieMgr", FALLBACK.enemy_zombie, 1100, 40, scene);
    mgrProj = new BABYLON.SpriteManager("projMgr", FALLBACK.projectile, 600, 24, scene);
    mgrPlayer = new BABYLON.SpriteManager("playerMgr", FALLBACK.player, 1, 48, scene);

    for (const m of [mgrGem, mgrBat, mgrZombie, mgrProj, mgrPlayer]) {
      m.texture.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
      m.isPickable = false;
    }
  }

  // 画像アセット解決後、各 manager のテクスチャを差し替える。
  function loadAssets() {
    resolveTexture("ground_tile.png", 64, null, (url, ok) => setupGround(url, ok));

    const swap = (mgr, name, px, fb) => {
      resolveTexture(name, px, fb, (url, ok) => {
        if (ok) {
          mgr.texture = new BABYLON.Texture(url, scene, true, true,
            BABYLON.Texture.NEAREST_SAMPLINGMODE);
        }
      });
    };
    swap(mgrPlayer, "player_walk.png", 48, FALLBACK.player);
    swap(mgrBat, "enemy_bat_walk.png", 32, FALLBACK.enemy_bat);
    swap(mgrZombie, "enemy_zombie_walk.png", 40, FALLBACK.enemy_zombie);
    swap(mgrProj, "projectile.png", 24, FALLBACK.projectile);
    swap(mgrGem, "xp_gem.png", 16, FALLBACK.xp_gem);
  }

  // ----------------------------------------------------------------- 入力
  const keys = Object.create(null);
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === "+" || k === "=" ) { changeSpawnTarget(+SPAWN_STEP); e.preventDefault(); }
    else if (k === "-" || k === "_") { changeSpawnTarget(-SPAWN_STEP); e.preventDefault(); }
    else if (k === "enter") { if (!state.started) startGame(); else if (state.gameOver) restart(); }
    else if (k === "r") { if (state.gameOver) restart(); }
    if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(k)) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

  function cardinal(mx, my) {
    if (mx === 0 && my === 0) return { x: 0, y: 0 };
    if (Math.abs(mx) >= Math.abs(my)) return { x: Math.sign(mx), y: 0 };
    return { x: 0, y: Math.sign(my) };
  }

  // ----------------------------------------------------------------- エンティティ プール
  // 敵 / 弾 / gem はオブジェクトを再利用する(プール再利用必須)。
  function Enemy() {
    this.sprite = null;       // 現在割当中の Sprite
    this.type = 0;            // 0=bat,1=zombie
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.r = BAT_R;
    this.hp = 1;
    this.active = false;
  }
  function Projectile() {
    this.sprite = null;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.life = 0;
    this.active = false;
  }
  function Gem() {
    this.sprite = null;
    this.x = 0; this.y = 0;
    this.active = false;
  }

  // プール本体 + フリーリスト。Sprite も型ごとに使い回す。
  const enemies = [];
  const enemyFree = [];
  const projectiles = [];
  const projFree = [];
  const gems = [];
  const gemFree = [];

  // Sprite プール (manager 別)。Sprite 生成/破棄コストを避ける。
  const batSpriteFree = [];
  const zombieSpriteFree = [];
  const projSpriteFree = [];
  const gemSpriteFree = [];

  function acquireSprite(pool, mgr, size) {
    let s = pool.pop();
    if (!s) {
      s = new BABYLON.Sprite("s", mgr);
      s.width = size; s.height = size;
    }
    s.isVisible = true;
    return s;
  }

  function dirFrame(x, y) {
    if (y > 0) return 1;
    if (x < 0) return 2;
    if (x > 0) return 3;
    return 0;
  }

  function walkFrame(x, y, moving) {
    return dirFrame(x, y) * 4 + (moving ? Math.floor(state.time * 10) % 4 : 0);
  }
  function releaseSprite(pool, s) {
    s.isVisible = false;
    s.position.x = -100000; // 画面外へ
    pool.push(s);
  }

  // ----------------------------------------------------------------- ゲーム状態
  const state = {
    time: 0,
    kills: 0,
    hp: PLAYER_HP_MAX,
    invuln: 0,
    spawnTarget: SPAWN_INITIAL,
    attackCd: 0,
    autoIncCd: AUTO_INCREASE_EVERY,
    gameOver: false,
    px: 0, py: 0,        // player world pos
    started: false,      // タイトル/アトラクト状態（false=デモ中・操作無効）
    blinkT: 0,
    autoT: 0,
  };

  let playerSprite = null;

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  function startGame() {
    state.started = true;
    restart();
    if (titleEl) titleEl.style.display = "none";
  }

  function changeSpawnTarget(delta) {
    state.spawnTarget = Math.max(0, Math.min(SPAWN_CAP, state.spawnTarget + delta));
  }

  // ----------------------------------------------------------------- スポーン
  function spawnEnemy() {
    let e = enemyFree.pop();
    if (!e) { e = new Enemy(); enemies.push(e); }
    e.active = true;

    // 種別: 70% bat(小/HP1), 30% zombie(大/HP3)
    const isZombie = Math.random() < 0.3;
    e.type = isZombie ? 1 : 0;
    if (isZombie) {
      e.r = ZOMBIE_R; e.hp = 3;
      e.sprite = acquireSprite(zombieSpriteFree, mgrZombie, 40);
    } else {
      e.r = BAT_R; e.hp = 1;
      e.sprite = acquireSprite(batSpriteFree, mgrBat, 32);
    }
    e.sprite.stopAnimation();
    e.sprite.cellIndex = 0;

    // 画面外周(カメラ視野の外)からスポーン
    const side = (Math.random() * 4) | 0;
    const halfW = VIEW_W / 2 + SPAWN_MARGIN;
    const halfH = VIEW_H / 2 + SPAWN_MARGIN;
    let sx, sy;
    if (side === 0) { sx = state.px - halfW; sy = state.py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 1) { sx = state.px + halfW; sy = state.py + (Math.random() * 2 - 1) * halfH; }
    else if (side === 2) { sx = state.px + (Math.random() * 2 - 1) * halfW; sy = state.py - halfH; }
    else { sx = state.px + (Math.random() * 2 - 1) * halfW; sy = state.py + halfH; }
    e.x = sx; e.y = sy;

    const sp = ENEMY_SPEED_MIN + Math.random() * (ENEMY_SPEED_MAX - ENEMY_SPEED_MIN);
    // zombie は遅め寄りに(範囲内で下方向にバイアス)
    e.speed = isZombie ? ENEMY_SPEED_MIN + Math.random() * 15 : sp;
    e.active = true;
  }

  function countActiveEnemies() {
    let n = 0;
    for (let i = 0; i < enemies.length; i++) if (enemies[i].active) n++;
    return n;
  }

  function fireProjectile(tx, ty) {
    const dx = tx - state.px, dy = ty - state.py;
    const d = Math.hypot(dx, dy) || 1;
    let p = projFree.pop();
    if (!p) { p = new Projectile(); projectiles.push(p); }
    p.active = true;
    p.x = state.px; p.y = state.py;
    p.vx = (dx / d) * PROJECTILE_SPEED;
    p.vy = (dy / d) * PROJECTILE_SPEED;
    p.life = PROJECTILE_LIFE;
    p.sprite = acquireSprite(projSpriteFree, mgrProj, 24);
  }

  function dropGem(x, y) {
    let g = gemFree.pop();
    if (!g) { g = new Gem(); gems.push(g); }
    g.active = true;
    g.x = x; g.y = y;
    g.sprite = acquireSprite(gemSpriteFree, mgrGem, 16);
  }

  function killEnemy(e) {
    dropGem(e.x, e.y);
    deactivateEnemy(e);
  }
  function deactivateEnemy(e) {
    e.active = false;
    if (e.sprite) {
      releaseSprite(e.type === 1 ? zombieSpriteFree : batSpriteFree, e.sprite);
      e.sprite = null;
    }
    enemyFree.push(e);
  }
  function deactivateProj(p) {
    p.active = false;
    if (p.sprite) { releaseSprite(projSpriteFree, p.sprite); p.sprite = null; }
    projFree.push(p);
  }
  function deactivateGem(g) {
    g.active = false;
    if (g.sprite) { releaseSprite(gemSpriteFree, g.sprite); g.sprite = null; }
    gemFree.push(g);
  }

  // ----------------------------------------------------------------- 更新
  function findNearestEnemy() {
    let best = null, bestD = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = e.x - state.px, dy = e.y - state.py;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function update(dt) {
    // アトラクト中の被弾死はデモをループ再開
    if (state.gameOver && !state.started) { restart(); return; }
    if (state.gameOver) return;

    state.time += dt;

    // --- 自機移動 (8方向) ---
    let mx = 0, my = 0;
    if (!state.started) {
      // デモAI: 累積時間ベースの sin で緩やかに徘徊（決定的）。Y上向き系。
      state.autoT += dt;
      const phase = Math.floor(state.autoT / 1.25) % 4;
      if (phase === 0) mx = 1;
      else if (phase === 1) my = 1;
      else if (phase === 2) mx = -1;
      else my = -1;
    } else {
      if (keys["a"] || keys["arrowleft"]) mx -= 1;
      if (keys["d"] || keys["arrowright"]) mx += 1;
      if (keys["w"] || keys["arrowup"]) my += 1;
      if (keys["s"] || keys["arrowdown"]) my -= 1;
    }
    const mv = cardinal(mx, my);
    if (mx !== 0 || my !== 0) {
      state.px += mv.x * PLAYER_SPEED * dt;
      state.py += mv.y * PLAYER_SPEED * dt;
    }
    state.dirX = mv.x; state.dirY = mv.y;
    state.moving = mv.x !== 0 || mv.y !== 0;

    // --- 自動増加 ---
    state.autoIncCd -= dt;
    if (state.autoIncCd <= 0) {
      state.autoIncCd += AUTO_INCREASE_EVERY;
      state.spawnTarget = Math.min(SPAWN_CAP, state.spawnTarget + AUTO_INCREASE_AMT);
    }

    // --- スポーン (目標同時数まで補充) ---
    let alive = countActiveEnemies();
    // 1フレームのスポーン上限を設け、急増時のスパイクを緩和。
    let budget = 40;
    while (alive < state.spawnTarget && budget-- > 0) {
      spawnEnemy();
      alive++;
    }

    // --- 自動攻撃 ---
    state.attackCd -= dt;
    if (state.attackCd <= 0) {
      const target = findNearestEnemy();
      if (target) {
        fireProjectile(target.x, target.y);
        state.attackCd += ATTACK_INTERVAL;
      } else {
        state.attackCd = 0; // 敵がいなければ即時待機
      }
    }

    // --- 敵移動 + 接触判定 ---
    if (state.invuln > 0) state.invuln -= dt;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = state.px - e.x, dy = state.py - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const ev = cardinal(dx, dy);
      e.x += ev.x * e.speed * dt;
      e.y += ev.y * e.speed * dt;
      e.dirX = ev.x; e.dirY = ev.y;
      // 接触
      const rr = e.r + PLAYER_R;
      if (d <= rr && state.invuln <= 0) {
        state.hp -= 1;
        state.invuln = INVULN_TIME;
        if (state.hp <= 0) { triggerGameOver(); }
      }
    }

    // --- 弾移動 + 命中判定 ---
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (!p.active) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) { deactivateProj(p); continue; }
      // 最近傍命中(全敵走査)。大量時は重いがSPEC負荷測定目的なので素直に。
      let hit = null;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        if (!e.active) continue;
        const ddx = e.x - p.x, ddy = e.y - p.y;
        const rr = e.r + PROJ_R;
        if (ddx * ddx + ddy * ddy <= rr * rr) { hit = e; break; }
      }
      if (hit) {
        hit.hp -= 1;
        deactivateProj(p);
        if (hit.hp <= 0) { killEnemy(hit); }
      }
    }

    // --- gem 取得 ---
    for (let i = 0; i < gems.length; i++) {
      const g = gems[i];
      if (!g.active) continue;
      const ddx = g.x - state.px, ddy = g.y - state.py;
      const rr = PICKUP_R;
      if (ddx * ddx + ddy * ddy <= rr * rr) {
        state.kills += 1;
        deactivateGem(g);
      }
    }
  }

  // ----------------------------------------------------------------- 描画同期
  function syncSprites() {
    // 自機(無敵中は点滅)
    playerSprite.position.x = state.px;
    playerSprite.position.y = state.py;
    playerSprite.cellIndex = walkFrame(state.dirX || 0, state.dirY || 0, !!state.moving);
    playerSprite.isVisible = !(state.invuln > 0 && (Math.floor(state.time * 12) % 2 === 0));

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active || !e.sprite) continue;
      e.sprite.position.x = e.x;
      e.sprite.position.y = e.y;
      e.sprite.cellIndex = walkFrame(e.dirX || 0, e.dirY || 0, true);
    }
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (!p.active || !p.sprite) continue;
      p.sprite.position.x = p.x;
      p.sprite.position.y = p.y;
    }
    for (let i = 0; i < gems.length; i++) {
      const g = gems[i];
      if (!g.active || !g.sprite) continue;
      g.sprite.position.x = g.x;
      g.sprite.position.y = g.y;
    }

    // カメラ追従
    applyOrtho(state.px, state.py);
    if (groundMesh) {
      groundMesh.position.x = state.px;
      groundMesh.position.y = state.py;
      // 地面メッシュはカメラ追従。テクスチャUVを自機移動量に応じてずらし、
      // タイルがワールド固定に見えるようスクロールさせる。
      if (groundMat && groundMat.emissiveTexture) {
        const tex = groundMat.emissiveTexture;
        const tile = 64;
        tex.uOffset = state.px / tile / tex.uScale;
        tex.vOffset = -state.py / tile / tex.vScale;
      }
    }
  }

  // ----------------------------------------------------------------- HUD
  let fpsAvg = 60;
  let objCountCache = 0;
  function updateHud() {
    let inst = engine.getFps();
    // 異常値(headless等で Infinity / 巨大値)を弾き、0〜240 にクランプ
    if (!isFinite(inst) || inst <= 0) inst = fpsAvg;
    inst = Math.min(240, inst);
    fpsAvg += (inst - fpsAvg) * 0.1; // 移動平均
    if (!isFinite(fpsAvg)) fpsAvg = 60;
    const ne = countActiveEnemies();
    let np = 0, ng = 0;
    for (let i = 0; i < projectiles.length; i++) if (projectiles[i].active) np++;
    for (let i = 0; i < gems.length; i++) if (gems[i].active) ng++;
    const nObj = ne + np + ng;
    const hp = Math.max(0, state.hp);
    // 表示内容・書式は three.js に統一
    hudEl.textContent =
      `FPS     : ${fpsAvg.toFixed(1)}\n` +
      `Enemies : ${ne}  (cap ${state.spawnTarget})\n` +
      `Objects : ${nObj}  (ene ${ne} / proj ${np} / gem ${ng})\n` +
      `Time    : ${state.time.toFixed(1)}s   Kills: ${state.kills}\n` +
      `HP      : ${(state.gameOver && state.started) ? 'GAME OVER (R to restart)' : '♥'.repeat(hp) + ' (' + hp + ')'}`;
  }

  // ----------------------------------------------------------------- ゲームオーバー / リスタート
  function triggerGameOver() {
    state.gameOver = true;
    // GAME OVER は HUD内に inline 表示（three.js と同様、別演出は持たない）。
  }

  function clearAll() {
    for (let i = 0; i < enemies.length; i++) if (enemies[i].active) deactivateEnemy(enemies[i]);
    for (let i = 0; i < projectiles.length; i++) if (projectiles[i].active) deactivateProj(projectiles[i]);
    for (let i = 0; i < gems.length; i++) if (gems[i].active) deactivateGem(gems[i]);
  }

  function restart() {
    clearAll();
    state.time = 0;
    state.kills = 0;
    state.hp = PLAYER_HP_MAX;
    state.invuln = 0;
    state.spawnTarget = SPAWN_INITIAL;
    state.attackCd = ATTACK_INTERVAL;
    state.autoIncCd = AUTO_INCREASE_EVERY;
    state.gameOver = false;
    state.px = 0; state.py = 0;
    state.dirX = 0; state.dirY = 0; state.moving = false;
  }

  // ----------------------------------------------------------------- 起動
  createManagers();
  loadAssets();
  playerSprite = new BABYLON.Sprite("player", mgrPlayer);
  playerSprite.width = 48; playerSprite.height = 48;
  playerSprite.position.set(0, 0, 0);
  playerSprite.stopAnimation();
  playerSprite.cellIndex = 0;
  restart();

  scene.onBeforeRenderObservable.add(() => {
    let dt = engine.getDeltaTime() / 1000;
    if (dt > 0.05) dt = 0.05; // スパイク時のクランプ
    update(dt);
    syncSprites();
    // アトラクト中はタイトルを点滅
    if (!state.started && titleEl) {
      state.blinkT += dt;
      titleEl.style.visibility = (Math.floor(state.blinkT / 0.45) % 2 === 0) ? "visible" : "hidden";
    }
  });

  engine.runRenderLoop(() => {
    scene.render();
    updateHud();
  });

  window.addEventListener("resize", () => engine.resize());

  // デバッグ用に公開
  window.__game = { state, engine, scene };
})();
