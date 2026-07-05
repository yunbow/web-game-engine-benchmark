// 3D テーマ1 ― インスタンス小惑星フィールド（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)とロジックを完全一致させる。
//
// A-Frame は three.js 上の宣言的フレームワーク。大量描画(InstancedMesh)は宣言的タグでは表現できないため、
// カスタムコンポーネント `game-field` の中で AFRAME.THREE.InstancedMesh を直接生成し、object3D に載せる。
// three は別途読み込まず、A-Frame 同梱の AFRAME.THREE を使う。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const FIELD_X = 60, FIELD_Y = 34;     // 自機可動 & 小惑星散布の半幅
const Z_FAR = -1200, Z_NEAR = 30;     // 出現(奥)〜消滅(手前)
const PLAYER_SPEED = 60;              // u/s
const PLAYER_R = 2.0;
const BULLET_SPEED = 400, BULLET_R = 0.5, FIRE_MS = 150, MAX_BULLETS = 64;
const AST_MAX = 50000, AST_INIT = 2000, AST_STEP = 1000, AST_MIN = 1000;
const SEED = 0x9e3779b9 >>> 0;
const INVULN = 1.0;                    // 被弾後無敵秒

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

AFRAME.registerComponent("game-field", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    const root = this.el.object3D; // a-scene の object3D に追加する親

    // 乱数（決定的）
    const rnd = mulberry32(SEED);
    this.rnd = rnd;
    this.rng = (lo, hi) => lo + (hi - lo) * rnd();

    // ---- 小惑星: InstancedMesh（比較主軸） ----------------------------------
    const astGeo = new THREE.IcosahedronGeometry(1, 0);   // 低ポリ 20面
    const astMat = new THREE.MeshLambertMaterial();
    const asteroids = new THREE.InstancedMesh(astGeo, astMat, AST_MAX);
    asteroids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    asteroids.frustumCulled = false; // 中心が範囲外でも全インスタンスを描画対象に
    root.add(asteroids);
    this.asteroids = asteroids;

    // per-instance 状態（SoA）
    this.sx = new Float32Array(AST_MAX); this.sy = new Float32Array(AST_MAX); this.sz = new Float32Array(AST_MAX);
    this.svz = new Float32Array(AST_MAX); this.sr = new Float32Array(AST_MAX);
    this.sax = new Float32Array(AST_MAX); this.say = new Float32Array(AST_MAX); this.saz = new Float32Array(AST_MAX);
    this.sang = new Float32Array(AST_MAX); this.saspd = new Float32Array(AST_MAX);

    const col = new THREE.Color();
    for (let i = 0; i < AST_MAX; i++) {
      this.initAsteroid(i, true);
      col.setHSL(0.07 + rnd() * 0.08, 0.35, 0.35 + rnd() * 0.25); // 茶〜灰の岩色
      asteroids.setColorAt(i, col);
    }
    asteroids.instanceColor.needsUpdate = true;

    // ---- 弾: InstancedMesh -------------------------------------------------
    const bulGeo = new THREE.SphereGeometry(BULLET_R, 8, 6);
    const bulMat = new THREE.MeshBasicMaterial({ color: 0xffe66d });
    const bullets = new THREE.InstancedMesh(bulGeo, bulMat, MAX_BULLETS);
    bullets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bullets.frustumCulled = false;
    root.add(bullets);
    this.bullets = bullets;
    this.bx = new Float32Array(MAX_BULLETS); this.by = new Float32Array(MAX_BULLETS); this.bz = new Float32Array(MAX_BULLETS);
    this.bAlive = new Uint8Array(MAX_BULLETS);

    // ---- 自機 --------------------------------------------------------------
    const player = new THREE.Mesh(
      new THREE.ConeGeometry(1.4, 4, 12),
      new THREE.MeshLambertMaterial({ color: 0x49c9ff })
    );
    player.rotation.x = -Math.PI / 2; // コーンを -Z 方向へ向ける
    root.add(player);
    this.player = player;
    this.pp = new THREE.Vector3(0, 0, 0);

    // ---- カメラ（宣言した #rig の object3D を手動制御） --------------------
    this.cameraEl = sceneEl.querySelector("#rig");

    // ---- ゲーム状態 --------------------------------------------------------
    this.activeCount = AST_INIT;
    this.score = 0; this.hp = 3; this.invuln = 0; this.over = false; this.autoplay = false; this.autoT = 0;
    this.started = false; this.blinkT = 0;   // タイトル/アトラクト状態（false=デモ中・操作無効）
    this.fireT = 0;
    this.fps = 60;

    // ---- 入力 --------------------------------------------------------------
    this.keys = {};
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      if (k === "+" || k === "=" || k === "]") this.setCount(this.activeCount + AST_STEP);
      if (k === "-" || k === "_" || k === "[") this.setCount(this.activeCount - AST_STEP);
      if (k === "p") this.autoplay = !this.autoplay;
      if (k === "enter" && !this.started) this.startGame();
      if (k === "r") this.restart();
    };
    this.onKeyUp = (e) => { this.keys[e.key.toLowerCase()] = false; };
    addEventListener("keydown", this.onKeyDown);
    addEventListener("keyup", this.onKeyUp);

    // ---- ループ用テンポラリ -------------------------------------------------
    this.dummy = new THREE.Object3D();
    this.q = new THREE.Quaternion();
    this.axis = new THREE.Vector3();

    // ---- HUD ---------------------------------------------------------------
    this.hud = document.getElementById("hud");
    this.titleEl = document.getElementById("title");
    this.hudT = 0;
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
  },

  initAsteroid: function (i, spreadZ) {
    const rng = this.rng;
    this.sx[i] = rng(-FIELD_X, FIELD_X);
    this.sy[i] = rng(-FIELD_Y, FIELD_Y);
    this.sz[i] = spreadZ ? rng(Z_FAR, Z_NEAR) : Z_FAR + rng(0, 60);
    this.svz[i] = rng(80, 160);
    this.sr[i] = rng(2.0, 5.0);
    // 自転軸（正規化）
    let ax = rng(-1, 1), ay = rng(-1, 1), az = rng(-1, 1);
    const L = Math.hypot(ax, ay, az) || 1; ax /= L; ay /= L; az /= L;
    this.sax[i] = ax; this.say[i] = ay; this.saz[i] = az;
    this.sang[i] = rng(0, Math.PI * 2);
    this.saspd[i] = rng(-1.5, 1.5);
  },

  setCount: function (n) {
    this.activeCount = Math.max(AST_MIN, Math.min(AST_MAX, n | 0));
  },

  restart: function () {
    this.score = 0; this.hp = 3; this.invuln = 0; this.over = false;
    this.pp.set(0, 0, 0);
    document.getElementById("over").style.display = "none";
  },

  // Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
  startGame: function () {
    this.started = true; this.restart();
    document.getElementById("title").style.display = "none";
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し 0.05 でクランプ。
  tick: function (time, timeDelta) {
    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;               // スパイク抑制
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;

    if (this.over && !this.started) this.restart();   // アトラクト中の被弾死はデモをループ再開

    const pp = this.pp;
    const keys = this.keys;

    // 入力 → 自機移動
    if (!this.over) {
      let mx = 0, my = 0;
      if (!this.started || this.autoplay) { this.autoT += dt; mx = Math.sin(this.autoT * 0.8); my = Math.sin(this.autoT * 1.3) * 0.6; }
      else {
        if (keys["a"] || keys["arrowleft"]) mx -= 1;
        if (keys["d"] || keys["arrowright"]) mx += 1;
        if (keys["w"] || keys["arrowup"]) my += 1;
        if (keys["s"] || keys["arrowdown"]) my -= 1;
      }
      pp.x = Math.max(-FIELD_X, Math.min(FIELD_X, pp.x + mx * PLAYER_SPEED * dt));
      pp.y = Math.max(-FIELD_Y, Math.min(FIELD_Y, pp.y + my * PLAYER_SPEED * dt));
      if (this.invuln > 0) this.invuln -= dt;
    }
    this.player.position.copy(pp);

    // カメラ追従（自機後方やや上）— look/wasd-controls 無効化済み。
    // 重要: cameraEl.object3D は Group。Group.lookAt は +Z を対象へ向ける（非カメラ分岐）ため、
    // 子の PerspectiveCamera(-Z を見る)が真後ろを向く。よって THREE.Camera 本体を直接制御する。
    // rig(Group)は HTML で position="0 0 0" の単位変換なので、camera 本体の local=world。
    const cam = this.cameraEl.getObject3D("camera");
    if (cam) {
      cam.position.set(pp.x, pp.y + 6, pp.z + 22);
      cam.lookAt(pp.x, pp.y + 2, pp.z);   // isCamera 分岐 → -Z が対象を向く（正しい）
    }

    // 発射
    if (!this.over) {
      this.fireT -= dt * 1000;
      if (this.fireT <= 0) {
        this.fireT = FIRE_MS;
        for (let b = 0; b < MAX_BULLETS; b++) if (!this.bAlive[b]) { this.bAlive[b] = 1; this.bx[b] = pp.x; this.by[b] = pp.y; this.bz[b] = pp.z; break; }
      }
    }

    const dummy = this.dummy, q = this.q, axis = this.axis;
    const bx = this.bx, by = this.by, bz = this.bz, bAlive = this.bAlive;
    const sx = this.sx, sy = this.sy, sz = this.sz, svz = this.svz, sr = this.sr;
    const sax = this.sax, say = this.say, saz = this.saz, sang = this.sang, saspd = this.saspd;

    // 弾更新
    let bn = 0;
    for (let b = 0; b < MAX_BULLETS; b++) {
      if (!bAlive[b]) continue;
      bz[b] -= BULLET_SPEED * dt;
      if (bz[b] < Z_FAR) { bAlive[b] = 0; continue; }
      dummy.position.set(bx[b], by[b], bz[b]);
      dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.bullets.setMatrixAt(bn++, dummy.matrix);
    }
    this.bullets.count = bn;
    this.bullets.instanceMatrix.needsUpdate = true;

    // 小惑星更新 + 当たり判定（自前球判定）
    const pr = PLAYER_R;
    const activeCount = this.activeCount;
    for (let i = 0; i < activeCount; i++) {
      let z = sz[i] + svz[i] * dt;
      if (z > Z_NEAR) { this.initAsteroid(i, false); z = sz[i]; }   // リサイクル(奥へ)
      sz[i] = z;
      const r = sr[i];

      // 弾 × 小惑星（z ゲートで早期 continue）
      for (let b = 0; b < MAX_BULLETS; b++) {
        if (!bAlive[b]) continue;
        const dz = bz[b] - z; if (dz < -r - 1 || dz > r + 1) continue;
        const dx = bx[b] - sx[i], dy = by[b] - sy[i];
        const rr = r + BULLET_R;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) { bAlive[b] = 0; this.score += 10; this.initAsteroid(i, false); z = sz[i]; break; }
      }
      // 小惑星 × 自機
      if (!this.over && this.invuln <= 0) {
        const dx = pp.x - sx[i], dy = pp.y - sy[i], dz = pp.z - sz[i];
        const rr = r + pr;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) {
          this.hp--; this.invuln = INVULN; this.initAsteroid(i, false);
          if (this.hp <= 0) { this.hp = 0; this.over = true; if (this.started) document.getElementById("over").style.display = "grid"; }
        }
      }

      // 行列を更新（位置・自転・スケール）
      sang[i] += saspd[i] * dt;
      axis.set(sax[i], say[i], saz[i]);
      q.setFromAxisAngle(axis, sang[i]);
      dummy.position.set(sx[i], sy[i], sz[i]);
      dummy.quaternion.copy(q);
      dummy.scale.set(r, r, r);
      dummy.updateMatrix();
      this.asteroids.setMatrixAt(i, dummy.matrix);
    }
    this.asteroids.count = activeCount;
    this.asteroids.instanceMatrix.needsUpdate = true;

    this.updateHUD(bn);
    if (!this.started) { this.blinkT += dt; this.titleEl.style.visibility = (Math.floor(this.blinkT / 0.45) % 2 === 0) ? "visible" : "hidden"; }
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function (bn) {
    this.hudT++;
    if (this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS       ${this.fps.toFixed(1)}\n` +
      `Objects   ${this.activeCount + bn}\n` +
      `Score     ${this.score}\n` +
      `HP        ${this.hp}\n` +
      `Asteroids ${this.activeCount}\n` +
      `Draws     ${info.calls}\n` +
      `Tris      ${info.triangles.toLocaleString()}`;
  }
});
