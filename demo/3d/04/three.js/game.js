// 3D テーマ4(T6) ― GPUパーティクル（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。WebGL2（compute無し）なので Points + 頂点シェーダで
// 各粒子を時間から計算する（GPU側アニメ・CPU毎フレーム更新なし）。加算ブレンド発光。
import * as THREE from "three";

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

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 2000);
camera.position.set(0, 8, 26);
camera.lookAt(0, 5, 0);
const particleTexture = new THREE.TextureLoader().load("../assets/theme_texture.png");
particleTexture.colorSpace = THREE.SRGBColorSpace;

// ---- 粒子属性（決定的に1回だけ生成） ---------------------------------------
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

const mat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 }, uLife: { value: LIFE }, uGrav: { value: GRAVITY },
    uSize: { value: 26.0 }, uDpr: { value: Math.min(devicePixelRatio, 2) },
    uSprite: { value: particleTexture },
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
    uniform sampler2D uSprite;
    varying float vLifeT;
    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = dot(d, d);
      if (r > 0.25) discard;                 // 円形
      vec4 sprite = texture2D(uSprite, gl_PointCoord);
      float soft = smoothstep(0.25, 0.0, r); // ソフトエッジ
      // 色: 黄(#fff1a8) → 橙(#ff8a3d) → 赤紫
      vec3 c0 = vec3(1.0, 0.945, 0.659);
      vec3 c1 = vec3(1.0, 0.541, 0.239);
      vec3 c2 = vec3(0.55, 0.12, 0.35);
      vec3 col = (vLifeT < 0.5)
        ? mix(c0, c1, vLifeT * 2.0)
        : mix(c1, c2, (vLifeT - 0.5) * 2.0);
      float alpha = (1.0 - vLifeT) * soft * max(sprite.r, max(sprite.g, sprite.b));
      gl_FragColor = vec4(col * sprite.rgb * alpha, alpha);  // 加算なので premultiplied 風
    }
  `,
});

const points = new THREE.Points(geo, mat);
points.frustumCulled = false;
scene.add(points);

// ---- 状態 / 入力 ------------------------------------------------------------
let count = N_INIT, fps = 60, last = performance.now(), hudT = 0;
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setCount(count + N_STEP);
  if (k === "-" || k === "_" || k === "[") setCount(count - N_STEP);
  if (k === "r") setCount(N_INIT);
});
function setCount(n) { count = Math.max(N_MIN, Math.min(N_MAX, n | 0)); geo.setDrawRange(0, count); }

// ---- メインループ -----------------------------------------------------------
let t = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;
  mat.uniforms.uTime.value = t;
  renderer.render(scene, camera);
  updateHUD();
  requestAnimationFrame(frame);
}

const hud = document.getElementById("hud");
function updateHUD() {
  if (++hudT % 6 !== 0) return;
  const info = renderer.info.render;
  hud.textContent =
    `FPS       ${fps.toFixed(1)}\n` +
    `Objects   ${count}\n` +
    `Particles ${count}\n` +
    `Draws     ${info.calls}\n` +
    `Points    ${info.points.toLocaleString()}`;
}

requestAnimationFrame(frame);
