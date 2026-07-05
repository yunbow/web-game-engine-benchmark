// 3D テーマ6(T5) ― 動的シャドウ光源（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)と同一挙動にする。
//
// A-Frame は three.js 上の宣言的フレームワーク。リアルタイムシャドウマップ設定は宣言タグでは
// 表現しきれないため、カスタムコンポーネント `shadowscene` の init() で
//   renderer.shadowMap 有効化 / 地面・柱(cast+receive shadow) / SpotLight(影あり)
// を AFRAME.THREE で直接生成し、object3D に載せる。three は別途読み込まず AFRAME.THREE を使う。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const COLS = 8, PILLARS = COLS * COLS, GAP = 6;
const L_INIT = 4, L_STEP = 2, L_MIN = 1, L_MAX = 12;
const SHADOW_RES = 1024;
const SEED = 0x9e3779b9 >>> 0;

// ---- 決定的疑似乱数（mulberry32, Math.random 不使用） -----------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

AFRAME.registerComponent("shadowscene", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    const root = this.el.object3D; // <a-scene> の object3D に追加する親

    // ---- シャドウマップ有効化（three.js 版と同一設定） ----------------------
    // A-Frame でも three の renderer をそのまま使うので、直接 shadowMap を有効化。
    const enableShadows = () => {
      const r = sceneEl.renderer;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
    };
    if (sceneEl.renderer) enableShadows();
    else sceneEl.addEventListener("render-target-loaded", enableShadows, { once: true });

    // ---- 弱い環境光（影が真っ黒に潰れない程度の暗い青） --------------------
    root.add(new THREE.AmbientLight(0x223044, 0.8));

    // ---- 地面（影を受ける） ------------------------------------------------
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x55606a, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);

    // ---- 柱 8x8=64 本（影を落とし受ける・共有 Geometry/Material） ----------
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.9, metalness: 0 });
    const boxGeo = new THREE.BoxGeometry(2, 1, 2); // 高さは scale.y で
    const rnd = mulberry32(SEED);
    for (let i = 0; i < PILLARS; i++) {
      const c = i % COLS, r = (i / COLS) | 0;
      const h = 3 + rnd() * 6;
      const m = new THREE.Mesh(boxGeo, pillarMat);
      m.position.set((c - 3.5) * GAP, h / 2, (r - 3.5) * GAP);
      m.scale.set(1, h, 1);
      m.castShadow = true; m.receiveShadow = true;
      root.add(m);
    }

    // ---- スポットライト（影あり）プール ------------------------------------
    this.lights = []; // { light }
    this.setLightCount(L_INIT);

    // ---- カメラ（宣言した #rig の camera 本体を直接制御） ------------------
    // 重要: rig.object3D は Group。Group.lookAt は +Z を対象へ向ける（非カメラ分岐）ため
    // 子の PerspectiveCamera(-Z を見る)が逆を向く。よって THREE.Camera 本体を直接 lookAt する。
    // カメラは固定なので一度だけ設定すればよい（描画開始後に camera が用意される場合に備え遅延）。
    this.rigEl = sceneEl.querySelector("#rig");
    this.camPlaced = false;

    // ---- 入力 --------------------------------------------------------------
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.setLightCount(this.lights.length + L_STEP);
      if (k === "-" || k === "_" || k === "[") this.setLightCount(this.lights.length - L_STEP);
      if (k === "r") this.setLightCount(L_INIT);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- ループ用 / HUD ----------------------------------------------------
    this.col = new THREE.Color();
    this.fps = 60;
    this.t = 0;
    this.hud = document.getElementById("hud");
    this.hudT = 0;
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
  },

  // ---- スポットライト生成（three.js 版 makeLight と同一） --------------------
  makeLight: function () {
    const root = this.el.object3D;
    const light = new THREE.SpotLight(0xffffff, 600, 120, (50 * Math.PI / 180) / 2, 0.4, 1.5);
    light.castShadow = true;
    light.shadow.mapSize.set(SHADOW_RES, SHADOW_RES);
    light.shadow.camera.near = 5; light.shadow.camera.far = 90;
    light.shadow.bias = -0.0005;
    const target = new THREE.Object3D();
    target.position.set(0, 1, 0);
    root.add(target); light.target = target;
    root.add(light);
    return { light };
  },

  // ---- 光源数の設定（N に合わせて dispose/再生成） --------------------------
  setLightCount: function (n) {
    const root = this.el.object3D;
    n = Math.max(L_MIN, Math.min(L_MAX, n | 0));
    while (this.lights.length < n) this.lights.push(this.makeLight());
    while (this.lights.length > n) {
      const e = this.lights.pop();
      e.light.dispose(); root.remove(e.light); root.remove(e.light.target);
    }
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し 0.05 でクランプ。
  tick: function (time, timeDelta) {
    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.t += dt;

    // カメラ固定配置（camera 本体が用意できたら一度だけ）
    if (!this.camPlaced && this.rigEl) {
      const cam = this.rigEl.getObject3D("camera");
      if (cam) {
        cam.position.set(0, 28, 40);
        cam.lookAt(0, 2, 0); // isCamera 分岐 → -Z が対象を向く（正しい）
        this.camPlaced = true;
      }
    }

    // 光源周回（SPEC: 高さ30 / 半径22 / 角速度0.4 / 位相 i*2π/N / 色相 i/N）
    const t = this.t, col = this.col, lights = this.lights, n = lights.length;
    for (let i = 0; i < n; i++) {
      const phi = (i * Math.PI * 2) / n;
      const a = t * 0.4 + phi;
      lights[i].light.position.set(22 * Math.cos(a), 30, 22 * Math.sin(a));
      col.setHSL(i / n, 0.85, 0.6);
      lights[i].light.color.copy(col);
    }

    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    // three.js は info にシャドウパスを含めない＝メインパスのみ計上。
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS    ${this.fps.toFixed(1)}\n` +
      `Objects ${PILLARS}\n` +
      `Lights ${this.lights.length}\n` +
      `Draws  ${info.calls}\n` +
      `Tris   ${info.triangles.toLocaleString()}`;
  }
});
