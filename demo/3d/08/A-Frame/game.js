// 3D テーマ8(T8) ― PBR + ポストプロセス(Bloom)（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)と数値・挙動を完全一致させる。
//
// A-Frame は three.js 上の宣言的フレームワーク。多数の PBR 球は宣言タグでは表現しづらいため、
// カスタムコンポーネント `pbrscene` の中で AFRAME.THREE.Mesh / MeshStandardMaterial を直接生成し object3D に載せる。
//
// ポストプロセス(Bloom):
//   A-Frame 1.7.0 同梱 three は super-three@0.173.4。EffectComposer/UnrealBloomPass 等の addon は
//   AFRAME.THREE には公開されていない。そこで index.html の importmap で 'three' を同一リビジョンの
//   super-three@0.173.4 本体へ解決し、addon を動的 import する。EffectComposer は renderer を直接使い、
//   passes の instanceof 判定は addon 内のローカル import 同士なので、同一バージョン間なら互換に動く。
//   addon の取得・初期化に失敗した場合は「強い emissive + ACES トーンマップ」の擬似グローにフォールバックする
//   （捏造はしない。採用方式は HUD の Post と画面下 note に表示）。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const N_INIT = 200, N_STEP = 100, N_MIN = 50, N_MAX = 2000;
const R = 0.7, SP = 2.2;
const CAM_R = 30, CAM_Y = 8, CAM_W = 0.2;
const SEED = 0x9e3779b9 >>> 0;
const ENV_URL = "../assets/env_equirect.png"; // 任意。無ければ RoomEnvironment

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

AFRAME.registerComponent("pbrscene", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    this.root = this.el.object3D;           // a-scene の object3D（=three の Scene）
    this.scene = sceneEl.object3D;          // 同上（環境マップ/環境光を載せる）
    this.cameraEl = sceneEl.querySelector("#rig");

    // ---- renderer 非依存の初期化（即実行可） ------------------------------
    // 直接光（金属ハイライト用。three.js 版と同値）
    this.scene.add(new THREE.AmbientLight(0x404a5a, 0.35));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.0); d1.position.set(1, 1, 0.6); this.scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffd9a8, 0.6); d2.position.set(-0.8, 0.5, -0.6); this.scene.add(d2);
    // 環境反射を控えめに（白飛び防止。three.js 版 scene.environmentIntensity=0.5 相当）
    this.scene.environmentIntensity = 0.5;

    // PBR 球
    this.sphereGeo = new THREE.SphereGeometry(R, 24, 16);
    this.spheres = [];
    this.count = N_INIT;
    this.buildSpheres(N_INIT);

    // HUD / 時間 / FPS
    this.hud = document.getElementById("hud");
    this.note = document.getElementById("note");
    this.hudT = 0;
    this.fps = 60;
    this.t = 0;
    this.postMode = "init";   // "bloom" | "glow"（addon ロード結果で確定）
    this.composer = null;

    // 入力
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.buildSpheres(Math.min(N_MAX, this.count + N_STEP));
      if (k === "-" || k === "_" || k === "[") this.buildSpheres(Math.max(N_MIN, this.count - N_STEP));
      if (k === "r") this.buildSpheres(N_INIT);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- renderer 依存の初期化（renderer 生成後に実行） ------------------
    // a-scene の component init 時点では sceneEl.renderer が未生成のことがあるため待つ。
    const start = () => this.setupRenderer();
    if (sceneEl.renderer) start();
    else sceneEl.addEventListener("renderstart", start, { once: true });
  },

  // renderer 生成後に呼ばれる: トーンマップ / 環境 / ポストプロセス初期化
  setupRenderer: function () {
    this.renderer = this.el.sceneEl.renderer;
    // 露出（renderer 属性でも設定済みだが明示）
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // info.autoReset は既定(true)のまま。bloom 採用時のみ setupPostprocessing で false にする
    // （EffectComposer の全パスを手動 reset で集計するため）。glow 時は既定のままで良い。
    this.setupEnvironment();                // 環境（反射）
    this.setupPostprocessing();             // ポストプロセス（Bloom）
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
    if (this.renderer && this._origRender) this.renderer.render = this._origRender; // レンダ乗っ取りを戻す
  },

  // ---- 環境（反射） ----------------------------------------------------------
  setupEnvironment: function () {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const useRoomEnv = () => {
      // RoomEnvironment は AFRAME.THREE に無い場合がある。動的 import を試み、ダメなら簡易環境。
      import("three/addons/environments/RoomEnvironment.js")
        .then((mod) => {
          const Room = mod.RoomEnvironment;
          this.scene.environment = pmrem.fromScene(new Room(), 0.04).texture;
        })
        .catch(() => {
          // フォールバック: 環境マップ無し。ambient + 平行光のみで反射の代替（白飛び防止のため弱め）。
          this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x202830, 0.4));
        });
    };
    new THREE.TextureLoader().load(
      ENV_URL,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        this.scene.environment = tex;
        this.scene.background = tex;
        if (this.note) this.note.textContent = (this.postMode === "glow")
          ? "PBR + post: env_equirect.png + pseudo-glow"
          : "PBR + post: env_equirect.png + UnrealBloom";
        this._hasEnvImage = true;
      },
      undefined,
      () => useRoomEnv()   // 読込失敗（未配置）→ 手続き的環境
    );
  },

  // ---- PBR 球（three.js 版と完全一致の決定的生成） -------------------------
  clearSpheres: function () {
    for (const m of this.spheres) { this.root.remove(m); m.material.dispose(); }
    this.spheres = [];
  },

  buildSpheres: function (n) {
    this.clearSpheres();
    const rnd = mulberry32(SEED);
    const k = Math.ceil(Math.cbrt(n));
    const half = (k - 1) / 2;
    for (let i = 0; i < n; i++) {
      const ix = i % k, iy = ((i / k) | 0) % k, iz = (i / (k * k)) | 0;
      const metalness = rnd() < 0.5 ? 1.0 : rnd();         // 半分は完全金属
      const roughness = 0.05 + rnd() * 0.95;
      const c = new THREE.Color().setHSL(rnd(), 0.7, 0.5);
      const emissiveOn = rnd() < 0.15;                      // 約15%は発光（Bloom）
      const mat = new THREE.MeshStandardMaterial({
        color: c, metalness, roughness,
        emissive: emissiveOn ? new THREE.Color().setHSL(rnd(), 0.9, 0.6) : 0x000000,
        emissiveIntensity: emissiveOn ? 2.0 : 0,
      });
      const m = new THREE.Mesh(this.sphereGeo, mat);
      m.position.set((ix - half) * SP, (iy - half) * SP, (iz - half) * SP);
      this.root.add(m);
      this.spheres.push(m);
    }
    this.count = n;
    // 擬似グローモードで球を再構築した場合は emissive 強化を再適用（rng 順序は不変のまま）
    if (this._glowBoost) this.boostEmissiveForGlow();
  },

  // ---- ポストプロセス（Bloom）: 動的 import → 失敗時は擬似グロー ----------
  setupPostprocessing: function () {
    Promise.all([
      import("three/addons/postprocessing/EffectComposer.js"),
      import("three/addons/postprocessing/RenderPass.js"),
      import("three/addons/postprocessing/UnrealBloomPass.js"),
      import("three/addons/postprocessing/OutputPass.js"),
    ]).then(([EC, RP, UB, OP]) => {
      // カメラ本体は init 時点で未生成のことがある。ここで取得し、tick でも毎フレーム再同期する。
      const cam = this.getCamera() || this.el.sceneEl.camera;
      const composer = new EC.EffectComposer(this.renderer);
      composer.setSize(W, H);
      composer.addPass(new RP.RenderPass(this.scene, cam));
      // strength/radius/threshold（発光部のみ滲ませる。three.js 版と同値）
      const bloom = new UB.UnrealBloomPass(new THREE.Vector2(W, H), 0.35, 0.4, 0.9);
      composer.addPass(bloom);
      composer.addPass(new OP.OutputPass());
      this.composer = composer;
      this.renderPass = composer.passes[0];
      this.postMode = "bloom";
      this.renderer.info.autoReset = false;  // 全パス集計のため手動 reset に切替
      // A-Frame の標準レンダ(renderer.render)を composer.render に乗っ取る。
      // tick 内で composer.render() を呼ぶため、A-Frame の内部 render は no-op 化する。
      this._origRender = this.renderer.render.bind(this.renderer);
      this.renderer.render = () => {};   // A-Frame の自動描画を無効化（composer が描く）
      if (this.note && !this._hasEnvImage) this.note.textContent = "PBR + post: MeshStandardMaterial + UnrealBloom";
    }).catch((err) => {
      // フォールバック: 擬似グロー（emissive 強め + ACES トーンマップ）。A-Frame 標準描画のまま。
      console.warn("[T8/A-Frame] postprocessing addon の読込に失敗。擬似グローへフォールバック:", err);
      this.postMode = "glow";
      this.boostEmissiveForGlow();
      if (this.note && !this._hasEnvImage) this.note.textContent = "PBR + post: MeshStandardMaterial + pseudo-glow (no composer)";
    });
  },

  // emissive 球の自発光をさらに強め、ACES トーンマップ下で滲み感を擬似的に出す
  boostEmissiveForGlow: function () {
    this._glowBoost = true;
    for (const m of this.spheres) {
      if (m.material.emissiveIntensity > 0) m.material.emissiveIntensity = 3.5;
    }
  },

  // ---- カメラ本体（Group ではなく PerspectiveCamera を直接取得） -----------
  // 罠: cameraEl.object3D は Group。Group.lookAt は +Z を対象へ向ける（非カメラ分岐）。
  //     getObject3D('camera') で THREE.Camera 本体を取り、lookAt の isCamera 分岐(-Z)を使う。
  getCamera: function () {
    return this.cameraEl.getObject3D("camera");
  },

  // ---- メインループ（three.js 版 frame 相当） -------------------------------
  tick: function (time, timeDelta) {
    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.t += dt;

    const cam = this.getCamera();
    if (cam) {
      const a = this.t * CAM_W;
      cam.position.set(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
      cam.lookAt(0, 0, 0);                 // isCamera 分岐 → -Z が原点を向く（正しい）
      // composer の RenderPass はマウント時のカメラ参照を保持。念のため毎フレーム同期。
      if (this.renderPass) this.renderPass.camera = cam;
    }

    if (this.composer) {
      // bloom モード: A-Frame 標準描画は no-op 化済み。composer が全描画を担う。
      // info.autoReset=false なので直前に手動 reset → composer の全パスを集計。
      this.renderer.info.reset();
      this.composer.render();
    }
    // glow モード（composer 無し）: A-Frame 標準の renderer.render が tick 後に描画する。
    // info は autoReset=true（既定）のままなので、HUD は前フレームの集計値を読む。

    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return;     // 数フレームに1回更新
    if (!this.renderer) return;            // renderer 未生成中はスキップ
    const info = this.renderer.info.render;
    const post = this.postMode === "bloom" ? "bloom"
               : this.postMode === "glow" ? "glow"
               : "init";
    this.hud.textContent =
      `FPS     ${this.fps.toFixed(1)}\n` +
      `Objects ${this.count}\n` +
      `Spheres ${this.count}\n` +
      `Draws   ${info.calls}\n` +
      `Tris    ${info.triangles.toLocaleString()}\n` +
      `Post    ${post}`;
  }
});
