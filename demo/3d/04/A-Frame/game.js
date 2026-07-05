// 3D テーマ4(T6) ― GPUパーティクル（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)と
// 頂点シェーダ・属性生成・色・加算ブレンドを完全一致させる。
//
// A-Frame には標準の粒子機構が無いので、three.js 版と同方式で
//   THREE.Points + 自作 ShaderMaterial（頂点シェーダで各粒子を時間から計算＝GPU側アニメ）
// をカスタムコンポーネント `particles` の中で AFRAME.THREE で生成し、object3D に載せる。
// three は別途読み込まず、A-Frame 同梱の AFRAME.THREE を使う。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const N_MAX = 500000, N_INIT = 20000, N_STEP = 20000, N_MIN = 5000;
const LIFE = 3.0, GRAVITY = -9.0;
const SPEED_MIN = 4, SPEED_MAX = 10;
const SEED = 0x9e3779b9 >>> 0;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

AFRAME.registerComponent("particles", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    const root = this.el.object3D; // a-scene の object3D に Points を載せる

    // ---- 粒子属性（決定的に1回だけ生成。three.js版と同じ順序） ----------------
    // 速度ベクトル（上方コーン）と寿命オフセット（位相）を per-particle に持たせ、
    // 頂点シェーダで pos = vel*age + 0.5*g*age^2 を計算する。
    const rnd = mulberry32(SEED);
    const vel = new Float32Array(N_MAX * 3);
    const offset = new Float32Array(N_MAX);
    const positions = new Float32Array(N_MAX * 3); // 原点固定（実位置はシェーダ計算）。Points描画用に必要。
    for (let i = 0; i < N_MAX; i++) {
      // 上方(+Y)を軸とする広めのコーン: 仰角 35°〜90°
      const az = rnd() * Math.PI * 2;
      const elev = (35 + rnd() * 55) * Math.PI / 180; // 地平から上向き角
      const sp = SPEED_MIN + rnd() * (SPEED_MAX - SPEED_MIN);
      const cy = Math.sin(elev), cxz = Math.cos(elev);
      vel[i * 3] = Math.cos(az) * cxz * sp;
      vel[i * 3 + 1] = cy * sp;
      vel[i * 3 + 2] = Math.sin(az) * cxz * sp;
      offset[i] = rnd() * LIFE;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aVel", new THREE.BufferAttribute(vel, 3));
    geo.setAttribute("aOffset", new THREE.BufferAttribute(offset, 1));
    geo.setDrawRange(0, N_INIT);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 5, 0), 1000); // カリング無効化用

    const dpr = Math.min(window.devicePixelRatio, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uLife: { value: LIFE }, uGrav: { value: GRAVITY },
        uSize: { value: 26.0 }, uDpr: { value: dpr },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      vertexShader: /* glsl */`
        attribute vec3 aVel;
        attribute float aOffset;
        uniform float uTime, uLife, uGrav, uSize, uDpr;
        varying float vLifeT;
        void main() {
          float age = mod(uTime + aOffset, uLife);
          vLifeT = age / uLife;
          vec3 p = aVel * age + vec3(0.0, 0.5 * uGrav * age * age, 0.0); // エミッタ=原点
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uDpr * (1.0 - vLifeT * 0.7) * (10.0 / max(-mv.z, 0.5));
        }
      `,
      fragmentShader: /* glsl */`
        precision mediump float;
        varying float vLifeT;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;                 // 円形
          float soft = smoothstep(0.25, 0.0, r); // ソフトエッジ
          // 色: 黄(#fff1a8) → 橙(#ff8a3d) → 赤紫
          vec3 c0 = vec3(1.0, 0.945, 0.659);
          vec3 c1 = vec3(1.0, 0.541, 0.239);
          vec3 c2 = vec3(0.55, 0.12, 0.35);
          vec3 col = (vLifeT < 0.5)
            ? mix(c0, c1, vLifeT * 2.0)
            : mix(c1, c2, (vLifeT - 0.5) * 2.0);
          float alpha = (1.0 - vLifeT) * soft;
          gl_FragColor = vec4(col * alpha, alpha);  // 加算なので premultiplied 風
        }
      `,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    root.add(points);

    this.geo = geo;
    this.mat = mat;
    this.points = points;

    // ---- カメラ（宣言した #rig の object3D を手動制御） --------------------
    // 重要(T1で踏んだ罠): cameraEl.object3D は Group。Group.lookAt は +Z を対象へ向ける
    // （非カメラ分岐）ため lookAt すると逆を向く。よって THREE.Camera 本体に対して
    // position / lookAt を行う。rig(Group)は position="0 0 0" なので camera 本体の local=world。
    this.cameraEl = sceneEl.querySelector("#rig");
    this.cameraSet = false;

    // ---- 状態 / 入力 ------------------------------------------------------------
    this.count = N_INIT;
    this.fps = 60;
    this.t = 0;
    this.hudT = 0;

    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.setCount(this.count + N_STEP);
      if (k === "-" || k === "_" || k === "[") this.setCount(this.count - N_STEP);
      if (k === "r") this.setCount(N_INIT);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- HUD ---------------------------------------------------------------
    this.hud = document.getElementById("hud");
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
  },

  setCount: function (n) {
    this.count = Math.max(N_MIN, Math.min(N_MAX, n | 0));
    this.geo.setDrawRange(0, this.count);
  },

  // カメラ本体に位置(0,8,26)・lookAt(0,5,0) を一度だけ設定。
  // object3D('camera') は生成タイミングが init より遅れることがあるため tick で確実に。
  setupCamera: function () {
    const cam = this.cameraEl && this.cameraEl.getObject3D("camera");
    if (!cam) return;
    cam.position.set(0, 8, 26);
    cam.lookAt(0, 5, 0); // isCamera 分岐 → -Z が対象を向く（正しい）
    this.cameraSet = true;
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し 0.05 でクランプ。
  tick: function (time, timeDelta) {
    if (!this.cameraSet) this.setupCamera();

    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;               // スパイク抑制
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;

    this.t += dt;
    this.mat.uniforms.uTime.value = this.t;

    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS       ${this.fps.toFixed(1)}\n` +
      `Objects   ${this.count}\n` +
      `Particles ${this.count}\n` +
      `Draws     ${info.calls}\n` +
      `Points    ${info.points.toLocaleString()}`;
  }
});
