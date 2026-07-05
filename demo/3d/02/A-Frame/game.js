// 3D テーマ2(T3) ― 箱タワー崩し（A-Frame + aframe-physics-system 移植）
// SPEC: ../SPEC.md が唯一の正。物理は必ず物理システムを使う（自前物理は不可・統合相性が比較対象）。
//
// 採用 driver: ammo（Bullet/WASM）。aframe-physics-system(@c-frame) の ammo driver は
//   ・<a-scene physics="driver: ammo; gravity: 0 -20 0"> で世界を作る
//   ・各剛体 = <a-box>/<a-sphere> に `ammo-body`(type/mass/restitution) + `ammo-shape`(type/halfExtents/sphereRadius)
//   ・el.body は Ammo.btRigidBody。`body-loaded` 後に setLinearVelocity / setFriction / setRestitution が使える
// 重要トラップ:
//   ・ammo-body/ammo-shape には friction プロパティが無い → SPEC の摩擦は body-loaded で btRigidBody.setFriction() で付与。
//   ・ammo は ammo.js を別途 <script> で読み込む必要（index.html で読込）。Ammo() の初期化完了を待ってから生成する。
//   ・mass>0 と shape を与えれば慣性テンソルは ammo が自動計算（Rapier の density 指定は不要・mass 直指定でSPEC一致）。
//   ・cameraEl.object3D は Group なので lookAt の分岐が逆。getObject3D('camera') を取得しそれに position/lookAt する。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const GRAV = -20;
const BOX = 2, BOX_HALF = 1;                 // 箱 2x2x2
const COLS = 20, GAP = 0.05, ROW_H = 2.02;   // タワー配置（ワイドな壁）
const N_INIT = 200, N_STEP = 50, N_MIN = 20, N_MAX = 1500;
const BALL_R = 1.5, MAX_PROJ = 8, FIRE_MS = 2000;
const FIRE_POS = [0, 10, 40], FIRE_VEL = [0, 2, -55];

// SPEC 物理値
const BOX_REST = 0.1, BOX_FRIC = 0.6;
const BALL_REST = 0.2, BALL_FRIC = 0.4;
const GROUND_REST = 0.1, GROUND_FRIC = 0.8;

AFRAME.registerComponent("game-t3", {
  init: function () {
    const sceneEl = this.el.sceneEl;

    // ---- 親エンティティ（箱・砲弾をここにぶら下げて一括 remove する） -------
    this.tower = document.createElement("a-entity");
    this.tower.setAttribute("id", "tower");
    sceneEl.appendChild(this.tower);
    this.proj = document.createElement("a-entity");
    this.proj.setAttribute("id", "proj");
    sceneEl.appendChild(this.proj);

    // ---- ゲーム状態 --------------------------------------------------------
    this.boxes = [];      // { el, scored }
    this.projs = [];      // { el }（最大 MAX_PROJ・FIFO）
    this.count = N_INIT;
    this.score = 0;
    this.fireT = FIRE_MS;
    this.fps = 60;
    this.ready = false;   // ammo 初期化＆初回タワー構築完了
    this.hudT = 0;
    this._wp = new THREE.Vector3(); // world position 取得用テンポラリ

    // ---- カメラ（宣言した #rig の camera 本体を手動制御） ------------------
    this.cameraEl = sceneEl.querySelector("#rig");

    // ---- 床にも SPEC 物理値を付与（ammo に friction プロパティが無いため） --
    const ground = document.getElementById("ground");
    if (ground) this.applyMaterial(ground, GROUND_REST, GROUND_FRIC);

    // ---- 入力 --------------------------------------------------------------
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.rebuild(this.count + N_STEP);
      else if (k === "-" || k === "_" || k === "[") this.rebuild(this.count - N_STEP);
      else if (k === " ") { e.preventDefault(); this.fire(); }
      else if (k === "r") this.rebuild(this.count);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- ammo の初期化完了を待ってからタワーを建てる ----------------------
    // aframe-physics-system は内部で Ammo() を解決する。ammo driver では
    // 世界生成完了まで body 生成しても良いが、確実にするため少し待ってから構築。
    this.hud = document.getElementById("hud");
    this.startWhenReady();
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
  },

  // ammo(WASM) が window.Ammo の関数→オブジェクトに解決されるまで待つ
  startWhenReady: function () {
    const tryStart = () => {
      // Ammo は最初 function、初期化後はインスタンス(btVector3 等が生える)。
      const ammoReady = (typeof window.Ammo !== "undefined") &&
        (typeof window.Ammo.btVector3 === "function");
      if (ammoReady) {
        this.ready = true;
        this.buildTower(this.count);
      } else {
        setTimeout(tryStart, 100);
      }
    };
    tryStart();
  },

  // btRigidBody に SPEC の restitution / friction を確実に適用（body-loaded 後）
  applyMaterial: function (el, rest, fric) {
    const setIt = () => {
      const b = el.body; // Ammo.btRigidBody
      if (b) {
        b.setRestitution(rest);
        b.setFriction(fric);
        b.activate(true);
      }
    };
    if (el.body) setIt();
    else el.addEventListener("body-loaded", setIt, { once: true });
  },

  // ---- タワー構築（決定的・Math.random 不使用） ----------------------------
  buildTower: function (n) {
    // 既存の箱/砲弾を全 remove（要素ごと破棄 → ammo-body も破棄される）
    this.clearChildren(this.tower);
    this.clearChildren(this.proj);
    this.boxes = [];
    this.projs = [];
    this.score = 0;
    this.fireT = FIRE_MS;
    this.count = n;

    // rows = ceil(n/COLS) は r=floor(i/COLS) に内包（最終行は端数ぶんだけ置かれる）
    for (let i = 0; i < n; i++) {
      const c = i % COLS, r = Math.floor(i / COLS);
      const x = (c - (COLS - 1) / 2) * (BOX + GAP);
      const y = BOX_HALF + r * ROW_H;

      const el = document.createElement("a-box");
      el.setAttribute("position", `${x} ${y} 0`);
      el.setAttribute("depth", BOX);
      el.setAttribute("height", BOX);
      el.setAttribute("width", BOX);
      el.setAttribute("color", "#b9a98c");
      el.setAttribute("ammo-body", `type: dynamic; mass: 1; restitution: ${BOX_REST}`);
      el.setAttribute("ammo-shape", `type: box; fit: manual; halfExtents: ${BOX_HALF} ${BOX_HALF} ${BOX_HALF}`);
      this.tower.appendChild(el);
      // 摩擦は body-loaded で付与（ammo-body/shape に friction が無いため）
      this.applyMaterial(el, BOX_REST, BOX_FRIC);
      this.boxes.push({ el, scored: false });
    }
  },

  clearChildren: function (parent) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
  },

  // ---- 砲弾発射（決定的・最大8発・FIFO 回収） ------------------------------
  fire: function () {
    if (!this.ready) return;
    // 最大数を超える場合は最古を回収
    while (this.projs.length >= MAX_PROJ) {
      const old = this.projs.shift();
      if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
    const el = document.createElement("a-sphere");
    el.setAttribute("position", `${FIRE_POS[0]} ${FIRE_POS[1]} ${FIRE_POS[2]}`);
    el.setAttribute("radius", BALL_R);
    el.setAttribute("color", "#e8533b");
    el.setAttribute("ammo-body", `type: dynamic; mass: 8; restitution: ${BALL_REST}`);
    el.setAttribute("ammo-shape", `type: sphere; fit: manual; sphereRadius: ${BALL_R}`);
    this.proj.appendChild(el);

    // body-loaded を待って初速・摩擦・反発を付与
    const onLoaded = () => {
      const b = el.body; // Ammo.btRigidBody
      if (!b) return;
      b.setRestitution(BALL_REST);
      b.setFriction(BALL_FRIC);
      const v = new Ammo.btVector3(FIRE_VEL[0], FIRE_VEL[1], FIRE_VEL[2]);
      b.setLinearVelocity(v);
      Ammo.destroy(v);
      b.activate(true);
    };
    if (el.body) onLoaded();
    else el.addEventListener("body-loaded", onLoaded, { once: true });

    this.projs.push({ el });
  },

  // ---- 入力ハンドラ補助 ----------------------------------------------------
  rebuild: function (n) {
    if (!this.ready) return;
    n = Math.max(N_MIN, Math.min(N_MAX, n | 0));
    this.buildTower(n);
  },

  // ---- メインループ（three.js版 frame 相当） ------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。物理は physics system が tick で進める（固定ステップ）。
  tick: function (time, timeDelta) {
    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;

    // カメラ固定（毎tick設定でも軽い）。rig(Group)は単位変換なので camera 本体の local=world。
    const cam = this.cameraEl && this.cameraEl.getObject3D("camera");
    if (cam) {
      cam.position.set(0, 14, 56);
      cam.lookAt(0, 10, 0); // isCamera 分岐 → -Z が対象を向く（正しい）
    }

    if (!this.ready) { this.updateHUD(0); return; }

    // 発射タイマ（2秒ごとに自動発射）
    this.fireT -= dt * 1000;
    if (this.fireT <= 0) { this.fireT = FIRE_MS; this.fire(); }

    // 箱のスコア判定（中心 world-y<0.5 初到達で +10）。位置は physics system が object3D へ同期済み。
    const wp = this._wp;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.scored) continue;
      const o = b.el.object3D;
      if (o) { o.getWorldPosition(wp); if (wp.y < 0.5) { b.scored = true; this.score += 10; } }
    }

    // 砲弾の寿命（world z<-60 or y<-20 で消滅・回収）
    for (let j = this.projs.length - 1; j >= 0; j--) {
      const p = this.projs[j];
      const o = p.el.object3D;
      if (o) {
        o.getWorldPosition(wp);
        if (wp.z < -60 || wp.y < -20) {
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          this.projs.splice(j, 1);
        }
      }
    }
    const pn = this.projs.length;

    this.updateHUD(pn);
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function (pn) {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    const objects = this.boxes.length + pn;
    this.hud.textContent =
      `FPS     ${this.fps.toFixed(1)}\n` +
      `Objects ${objects}\n` +
      `Score   ${this.score}\n` +
      `Bodies  ${this.count}\n` +
      `Draws   ${info.calls}\n` +
      `Tris    ${info.triangles.toLocaleString()}`;
  }
});
