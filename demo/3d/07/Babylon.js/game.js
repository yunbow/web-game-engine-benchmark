// 3D テーマ7(T7) ― ボクセルチャンク再生成（Babylon.js v8 移植版）
// SPEC: ../SPEC.md が唯一の正。波・チャンク/セル構成・カメラ・HUD は three.js リファレンス
// (../three.js/game.js) とビット単位で一致。描画レイヤだけを Babylon の updatable Mesh +
// updateVerticesData による「毎フレーム頂点バッファ再構築＋GPU再アップロード」に置き換えている。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const W = 960, H = 540;
const CS = 12, CS_SIZE = 2;              // 1チャンク=12x12セル, セル2u
const NC_INIT = 4, NC_MIN = 2, NC_MAX = 8;
const VERTS_PER_CELL = 30;               // 上面+側面4 = 5クアッド = 30頂点(非インデックス相当)
const CELLS = CS * CS;
const VPC = CELLS * VERTS_PER_CELL;      // チャンクあたり頂点数(4320)

// 高さの波（決定的・Math.random 不使用）。three.js 版と完全一致。
function heightAt(gx, gz, t) {
  return 1 + Math.floor((Math.sin(gx * 0.25 + t) + Math.cos(gz * 0.25 + t * 0.8) + 2) * 2);
}

// 高さ→色（緑→茶→白）。three.js 版 heightColor と同じ式（戻り値 r,g,b を out[0..2] へ）。
const _col = [0, 0, 0];
function heightColor(h, out) {
  const u = Math.min(1, (h - 1) / 8);
  if (u < 0.5) { const k = u * 2; out[0] = 0.18 + 0.32 * k; out[1] = 0.45 - 0.1 * k; out[2] = 0.18; }
  else { const k = (u - 0.5) * 2; out[0] = 0.5 + 0.5 * k; out[1] = 0.35 + 0.55 * k; out[2] = 0.18 + 0.72 * k; }
}

// ---- エンジン / シーン / カメラ ---------------------------------------------
const canvas = document.getElementById("renderCanvas");
// WebGL2 既定（第4引数 true で OffscreenCanvas 等を許容しつつ WebGL2 を優先）。
const engine = new BABYLON.Engine(canvas, true, { antialias: true }, true);

const scene = new BABYLON.Scene(engine);
// three.js と座標一致させるため右手系（Babylon 既定は左手系）。これで Z 軸の向き・
// 巻き順が three.js と揃い、上面/側面クアッドの表裏が一致する。
scene.useRightHandedSystem = true;
scene.clearColor = BABYLON.Color4.FromHexString("#0b1016ff");

// 固定カメラ（操作なし）。fov は垂直55°（既定 FOVMODE_VERTICAL_FIXED）。
const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(0, 60, 95), scene);
camera.setTarget(new BABYLON.Vector3(0, 4, 0));
camera.fov = 55 * Math.PI / 180;
camera.minZ = 0.5;
camera.maxZ = 2000;
// attachControl は呼ばない（カメラ固定）

// ライト: 環境光相当の Hemispheric + 平行光1灯（フラットなブロック感）
const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.FromHexString("#8090a0");
hemi.groundColor = BABYLON.Color3.FromHexString("#8090a0");
hemi.intensity = 0.7;
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.4, -1, -0.5).normalize(), scene);
sun.diffuse = new BABYLON.Color3(1, 1, 1);
sun.intensity = 1.1;

// 頂点カラーを使う共通マテリアル（全チャンク共有）。スペキュラなしのマット表現。
const mat = new BABYLON.StandardMaterial("voxel", scene);
mat.useVertexColor = true;          // VertexBuffer.ColorKind を使う
mat.specularColor = new BABYLON.Color3(0, 0, 0);
mat.backFaceCulling = true;

// 固定インデックス配列（[0,1,2,...,VPC-1]）。VertexData にはインデックスが必須なので
// 非インデックス相当（全頂点ユニーク）を一度だけ作る。全チャンクで共有してよい。
const INDICES = new Uint16Array(VPC); // VPC=4320 < 65536 なので 16bit で足りる
for (let i = 0; i < VPC; i++) INDICES[i] = i;

// ---- チャンク（事前確保バッファを毎フレーム書き換え） -----------------------
// { mesh, pos(Float32 VPC*3), nor(VPC*3), col(VPC*4 RGBA), Ci, Cj }
const chunks = [];

function makeChunk(Ci, Cj) {
  const pos = new Float32Array(VPC * 3);
  const nor = new Float32Array(VPC * 3);
  const col = new Float32Array(VPC * 4); // !!! Babylon の ColorKind は RGBA(4成分)
  // alpha は常に 1（再構築時は r,g,b のみ書き換えるので最初に埋めておく）
  for (let i = 3; i < col.length; i += 4) col[i] = 1;

  const mesh = new BABYLON.Mesh("chunk_" + Ci + "_" + Cj, scene);
  mesh.material = mat;
  // 毎フレーム形状が変わるためフラスタムカリングは無効化（境界再計算を避ける）
  mesh.alwaysSelectAsActiveMesh = true;

  const ch = { mesh, pos, nor, col, Ci, Cj };
  const halfWorld = (NC * CS * CS_SIZE) / 2;
  rebuildChunkArrays(ch, 0, halfWorld); // 初期形状を埋める

  const vd = new BABYLON.VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.colors = col;
  vd.indices = INDICES;
  // updatable=true で適用 → 以後は updateVerticesData で中身だけ再アップロード
  vd.applyToMesh(mesh, true);
  return ch;
}

// 1チャンクの事前確保配列(pos/nor/col)を現在の t で書き換える（再アロケートしない）。
function rebuildChunkArrays(ch, t, halfWorld) {
  const { pos, nor, col, Ci, Cj } = ch;
  // チャンク原点（全体を中心揃え）。three.js 版と同一式。
  const ox = Ci * CS * CS_SIZE - halfWorld;
  const oz = Cj * CS * CS_SIZE - halfWorld;
  let p = 0; // pos/nor の float オフセット (xyz×頂点)
  let c = 0; // col の float オフセット (rgba×頂点)

  // 1クアッド(2三角・6頂点)を書き込む。three.js 版の quad と頂点順・法線・色を同一に。
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, r, g, b) => {
    const v = [ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz];
    for (let i = 0; i < 18; i += 3) {
      pos[p] = v[i]; pos[p + 1] = v[i + 1]; pos[p + 2] = v[i + 2];
      nor[p] = nx; nor[p + 1] = ny; nor[p + 2] = nz;
      col[c] = r; col[c + 1] = g; col[c + 2] = b; // col[c+3]=alpha は 1 のまま
      p += 3; c += 4;
    }
  };

  for (let cz = 0; cz < CS; cz++) {
    for (let cx = 0; cx < CS; cx++) {
      const gx = Ci * CS + cx, gz = Cj * CS + cz;
      const h = heightAt(gx, gz, t);
      heightColor(h, _col);
      const r = _col[0], g = _col[1], b = _col[2];
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
}

// ---- チャンク集合の作成 -----------------------------------------------------
let NC = NC_INIT;
function clearChunks() {
  for (const ch of chunks) ch.mesh.dispose();
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
function frame() {
  const now = performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  const halfWorld = (NC * CS * CS_SIZE) / 2;
  for (const ch of chunks) {
    // 毎フレーム再構築（事前確保配列に書き込み）＋ GPU 再アップロード
    rebuildChunkArrays(ch, t, halfWorld);
    ch.mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, ch.pos);
    ch.mesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, ch.nor);
    ch.mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, ch.col);
  }

  scene.render();
  updateHUD();
}

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
// Draws は SceneInstrumentation の drawCallsCounter から取得（ベストエフォート）。
const instrumentation = new BABYLON.SceneInstrumentation(scene);
instrumentation.captureActiveMeshesEvaluationTime = false;
instrumentation.captureRenderTargetsRenderTime = false;
function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回更新（描画負荷の計測を妨げない）
  const draws = instrumentation.drawCallsCounter.current;
  // Tris 概算: チャンク数 × 144セル × 10三角（5クアッド×2）。SPEC 注記どおりの概算。
  const tris = NC * NC * CELLS * 10;
  hud.textContent =
    `FPS    ${fps.toFixed(1)}\n` +
    `Objects ${chunks.length}\n` +
    `Chunks ${NC}x${NC}\n` +
    `Draws  ${draws}\n` +
    `Tris   ${tris.toLocaleString()}`;
}

engine.runRenderLoop(frame);
addEventListener("resize", () => engine.resize());
