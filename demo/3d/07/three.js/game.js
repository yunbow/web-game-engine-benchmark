// 3D テーマ7(T7) ― ボクセルチャンク再生成（three.js リファレンス実装）
// SPEC: ../SPEC.md が唯一の正。毎フレーム全チャンクのブロック地形メッシュを作り直し、
// 事前確保した BufferGeometry の属性を書き換えて GPU に再アップロードする。チャンク数が主軸。
import * as THREE from "three";

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const CS = 12, CS_SIZE = 2;              // 1チャンク=12x12セル, セル2u
const NC_INIT = 4, NC_MIN = 2, NC_MAX = 8;
const VERTS_PER_CELL = 30;               // 上面+側面4 = 5クアッド = 30頂点(非インデックス)
const CELLS = CS * CS;
const VPC = CELLS * VERTS_PER_CELL;      // チャンクあたり頂点数(4320)

// 高さの波（決定的・Math.random 不使用）
function heightAt(gx, gz, t) {
  return 1 + Math.floor((Math.sin(gx * 0.25 + t) + Math.cos(gz * 0.25 + t * 0.8) + 2) * 2);
}

// ---- レンダラ / シーン / カメラ ---------------------------------------------
const wrap = document.getElementById("wrap");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
wrap.insertBefore(renderer.domElement, wrap.firstChild);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1016);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.5, 2000);
camera.position.set(0, 60, 95);
camera.lookAt(0, 4, 0);
const themeTexture = new THREE.TextureLoader().load("../assets/theme_texture.png");
themeTexture.colorSpace = THREE.SRGBColorSpace;
themeTexture.wrapS = themeTexture.wrapT = THREE.RepeatWrapping;
themeTexture.repeat.set(4, 4);

scene.add(new THREE.AmbientLight(0x8090a0, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(0.4, 1, 0.5);
scene.add(sun);

// 高さ→色（緑→茶→白）
function heightColor(h, out) {
  const u = Math.min(1, (h - 1) / 8);
  if (u < 0.5) { const k = u * 2; out.setRGB(0.18 + 0.32 * k, 0.45 - 0.1 * k, 0.18); }
  else { const k = (u - 0.5) * 2; out.setRGB(0.5 + 0.5 * k, 0.35 + 0.55 * k, 0.18 + 0.72 * k); }
}

// ---- チャンク（事前確保バッファを毎フレーム書き換え） -----------------------
const chunks = [];   // { mesh, geo, pos, nor, uv, col, Ci, Cj }
const _c = new THREE.Color();

function makeChunk(Ci, Cj) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(VPC * 3);
  const nor = new Float32Array(VPC * 3);
  const uv = new Float32Array(VPC * 2);
  const col = new Float32Array(VPC * 3);
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
  const uvAttr = new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("normal", norAttr);
  geo.setAttribute("uv", uvAttr);
  geo.setAttribute("color", colAttr);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, map: themeTexture }));
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, geo, pos, nor, uv, col, Ci, Cj };
}

// 1チャンクのメッシュを現在の t で再構築（事前確保配列に書き込み）
function rebuildChunk(ch, t, halfWorld) {
  const { pos, nor, uv, col, Ci, Cj } = ch;
  // チャンク原点（全体を中心揃え）
  const ox = Ci * CS * CS_SIZE - halfWorld;
  const oz = Cj * CS * CS_SIZE - halfWorld;
  let o = 0; // float offset

  // 1クアッド(2三角・6頂点)を push
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, r, g, b) => {
    const v = [ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz];
    const tuv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
    for (let i = 0; i < 18; i += 3) {
      const vi = i / 3;
      pos[o] = v[i]; pos[o + 1] = v[i + 1]; pos[o + 2] = v[i + 2];
      nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
      col[o] = r; col[o + 1] = g; col[o + 2] = b;
      uv[(o / 3) * 2] = tuv[vi * 2];
      uv[(o / 3) * 2 + 1] = tuv[vi * 2 + 1];
      o += 3;
    }
  };

  for (let cz = 0; cz < CS; cz++) {
    for (let cx = 0; cx < CS; cx++) {
      const gx = Ci * CS + cx, gz = Cj * CS + cz;
      const h = heightAt(gx, gz, t);
      heightColor(h, _c);
      const r = _c.r, g = _c.g, b = _c.b;
      const x0 = ox + cx * CS_SIZE, x1 = x0 + CS_SIZE;
      const z0 = oz + cz * CS_SIZE, z1 = z0 + CS_SIZE;
      const y = h;
      // 上面 (+Y)
      quad(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, 0, 1, 0, r, g, b);
      // +X
      quad(x1, 0, z0, x1, y, z0, x1, y, z1, x1, 0, z1, 1, 0, 0, r, g, b);
      // -X
      quad(x0, 0, z1, x0, y, z1, x0, y, z0, x0, 0, z0, -1, 0, 0, r, g, b);
      // +Z
      quad(x1, 0, z1, x1, y, z1, x0, y, z1, x0, 0, z1, 0, 0, 1, r, g, b);
      // -Z
      quad(x0, 0, z0, x0, y, z0, x1, y, z0, x1, 0, z0, 0, 0, -1, r, g, b);
    }
  }
  ch.geo.attributes.position.needsUpdate = true;
  ch.geo.attributes.normal.needsUpdate = true;
  ch.geo.attributes.uv.needsUpdate = true;
  ch.geo.attributes.color.needsUpdate = true;
}

// ---- チャンク集合の作成 -----------------------------------------------------
let NC = NC_INIT;
function clearChunks() {
  for (const ch of chunks) { scene.remove(ch.mesh); ch.geo.dispose(); ch.mesh.material.dispose(); }
  chunks.length = 0;
}
function setChunks(nc) {
  NC = Math.max(NC_MIN, Math.min(NC_MAX, nc | 0));
  clearChunks();
  for (let Cj = 0; Cj < NC; Cj++)
    for (let Ci = 0; Ci < NC; Ci++) chunks.push(makeChunk(Ci, Cj));
}
setChunks(NC_INIT);

// ---- 入力 -------------------------------------------------------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setChunks(NC + 1);
  if (k === "-" || k === "_" || k === "[") setChunks(NC - 1);
  if (k === "r") setChunks(NC_INIT);
});

// ---- メインループ -----------------------------------------------------------
let fps = 60, last = performance.now(), hudT = 0, t = 0;
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  const halfWorld = (NC * CS * CS_SIZE) / 2;
  for (const ch of chunks) rebuildChunk(ch, t, halfWorld); // 毎フレーム再構築＋再アップロード

  renderer.render(scene, camera);
  updateHUD();
  requestAnimationFrame(frame);
}

const hud = document.getElementById("hud");
function updateHUD() {
  if (++hudT % 6 !== 0) return;
  const info = renderer.info.render;
  hud.textContent =
    `FPS    ${fps.toFixed(1)}\n` +
    `Objects ${chunks.length}\n` +
    `Chunks ${NC}x${NC}\n` +
    `Draws  ${info.calls}\n` +
    `Tris   ${info.triangles.toLocaleString()}`;
}

requestAnimationFrame(frame);
