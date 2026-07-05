// IIFE で全体を隔離する。classic script はグローバルの let/const レキシカルスコープを共有するため、
// トップレベルの `let t` 等が PlayCanvas エンジンの minified された単一文字グローバルと衝突し
// "Identifier 't' has already been declared" でブラウザ起動が失敗する（node --check では出ない）。
// 全コードを関数スコープに閉じて回避する。
(function () {
"use strict";
// 3D テーマ7(T7) ― ボクセルチャンク再生成（PlayCanvas エンジンのみ移植）
// SPEC: ../SPEC.md が唯一の正。数値・挙動は three.js リファレンス実装に完全一致させる。
// 毎フレーム全チャンクのブロック地形メッシュを作り直し、事前確保した pc.Mesh の
// positions/normals/colors を書き換えて GPU に再アップロードする。チャンク数が主軸。
// グローバル `pc` は CDN(playcanvas-stable.min.js / UMD) から読み込む。

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const CS = 12, CS_SIZE = 2;              // 1チャンク=12x12セル, セル2u
const NC_INIT = 4, NC_MIN = 2, NC_MAX = 8;
const VERTS_PER_CELL = 30;               // 上面+側面4 = 5クアッド = 30頂点(非インデックス)
const CELLS = CS * CS;
const VPC = CELLS * VERTS_PER_CELL;      // チャンクあたり頂点数(4320)

// 高さの波（決定的・Math.random 不使用）。three.js版 heightAt と一致。
function heightAt(gx, gz, t) {
  return 1 + Math.floor((Math.sin(gx * 0.25 + t) + Math.cos(gz * 0.25 + t * 0.8) + 2) * 2);
}

// 高さ→色（緑→茶→白）。three.js版 heightColor と同式。out=[r,g,b]
function heightColor(h, out) {
  const u = Math.min(1, (h - 1) / 8);
  if (u < 0.5) { const k = u * 2; out[0] = 0.18 + 0.32 * k; out[1] = 0.45 - 0.1 * k; out[2] = 0.18; }
  else { const k = (u - 0.5) * 2; out[0] = 0.5 + 0.5 * k; out[1] = 0.35 + 0.55 * k; out[2] = 0.18 + 0.72 * k; }
}

// ---- アプリケーション / グラフィックスデバイス（WebGL2 明示） ----------------
const canvas = document.getElementById("app");
const app = new pc.Application(canvas, {
  graphicsDeviceOptions: {
    deviceTypes: [pc.DEVICETYPE_WEBGL2],  // WebGL2 を明示（WebGPU は使わない）
    antialias: true,
    alpha: false,
  },
});
const device = app.graphicsDevice;
// 960x540 固定解像度
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_FIXED, W, H);

// 環境光（three.js版: AmbientLight(0x8090a0, 0.7)）。clearColor #0b1016 はカメラ側。
app.scene.ambientLight = new pc.Color(0x80 / 255, 0x90 / 255, 0xa0 / 255).mulScalar(0.7);

// ---- カメラ（fov55 / near0.5 / far2000・位置(0,60,95)・注視(0,4,0)） ---------
const camEntity = new pc.Entity("camera");
camEntity.addComponent("camera", {
  fov: 55,
  nearClip: 0.5,
  farClip: 2000,
  clearColor: new pc.Color(0x0b / 255, 0x10 / 255, 0x16 / 255),
});
app.root.addChild(camEntity);
camEntity.setPosition(0, 60, 95);
camEntity.lookAt(0, 4, 0);

// ---- ライト（平行光 + 環境光） ----------------------------------------------
// three.js版: DirectionalLight(0xffffff, 1.1), 光源位置(0.4,1,0.5)＝上方やや手前。
// PlayCanvas の directional は forward(-Z) が光の進む向き。進行方向 (-0.4,-1,-0.5) を
// forward に向け、上方やや手前から差し込むようにする。
const sun = new pc.Entity("sun");
sun.addComponent("light", {
  type: "directional",
  color: new pc.Color(1, 1, 1),
  intensity: 1.1,
  castShadows: false,
});
{
  const dir = new pc.Vec3(-0.4, -1, -0.5).normalize();
  sun.setPosition(0, 0, 0);
  sun.lookAt(dir.x, dir.y, dir.z);
}
app.root.addChild(sun);

// ---- 共有マテリアル（頂点カラー使用・フラットシェーディングのブロック感） -----
// pc.Mesh の color チャンネル(RGBA)を diffuse に乗せる。
const blockMat = new pc.StandardMaterial();
blockMat.diffuse = new pc.Color(1, 1, 1);
blockMat.diffuseVertexColor = true;       // 頂点カラーを diffuse に反映
blockMat.useMetalness = false;
blockMat.gloss = 0;
// 両面描画。three.js の巻き順は three の FrontSide では正だが、PlayCanvas の裏面カリング
// 規約だと一部の面が裏向き判定で消え、視点により地形が透けてスパイク状に見える。
// CULLFACE_NONE で全面を描画して回避する（ボクセル地形なので両面で問題なし）。
blockMat.cull = pc.CULLFACE_NONE;
blockMat.update();

// ---- 固定インデックス [0..VPC-1]（非インデックスメッシュを毎フレーム update する
//      ため、setIndices に渡す固定列を1度だけ作る。VPC=4320） ------------------
const SHARED_INDICES = new Uint16Array(VPC);
for (let i = 0; i < VPC; i++) SHARED_INDICES[i] = i;

// ---- チャンク（事前確保バッファを毎フレーム書き換え→ mesh.update で再アップロード） -
// chunks 要素: { mesh, mi, entity, pos, nor, col, Ci, Cj }
const chunks = [];
const _c = [0, 0, 0]; // heightColor の作業領域

function makeChunk(Ci, Cj) {
  const mesh = new pc.Mesh(device);
  mesh.clear(true, false); // dynamic=true(頂点バッファを毎フレーム更新), indexed=false
  const pos = new Float32Array(VPC * 3);
  const nor = new Float32Array(VPC * 3);
  const col = new Float32Array(VPC * 4); // RGBA
  // 初期確保: setIndices は固定。setPositions などはここで一度確保し、毎フレーム同形で上書き。
  mesh.setPositions(pos);
  mesh.setNormals(nor);
  mesh.setColors(col, 4);
  mesh.setIndices(SHARED_INDICES);
  mesh.update(pc.PRIMITIVE_TRIANGLES);

  const mi = new pc.MeshInstance(mesh, blockMat);
  mi.cull = false; // フラスタムカリングはせず一律描画（four-lib 揃え）
  const entity = new pc.Entity("chunk");
  entity.addComponent("render", {
    meshInstances: [mi],
    castShadows: false,
    receiveShadows: false,
  });
  app.root.addChild(entity);
  return { mesh, mi, entity, pos, nor, col, Ci, Cj };
}

// 1チャンクのメッシュを現在の t で再構築（事前確保配列に書き込み→ update で再アップロード）
function rebuildChunk(ch, t, halfWorld) {
  const pos = ch.pos, nor = ch.nor, col = ch.col, Ci = ch.Ci, Cj = ch.Cj;
  // チャンク原点（全体を中心揃え）。three.js版と一致。
  const ox = Ci * CS * CS_SIZE - halfWorld;
  const oz = Cj * CS * CS_SIZE - halfWorld;
  let o3 = 0; // pos/nor の float offset (3成分)
  let o4 = 0; // col の float offset (4成分)

  // 1クアッド(2三角・6頂点)を push。three.js版 quad と頂点順・巻き順を一致させる。
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, r, g, b) => {
    const v0 = ax, v1 = ay, v2 = az, v3 = bx, v4 = by, v5 = bz;
    const v6 = cx, v7 = cy, v8 = cz, v9 = dx, v10 = dy, v11 = dz;
    const vx = [v0, v1, v2, v3, v4, v5, v6, v7, v8, v0, v1, v2, v6, v7, v8, v9, v10, v11];
    for (let i = 0; i < 18; i += 3) {
      pos[o3] = vx[i]; pos[o3 + 1] = vx[i + 1]; pos[o3 + 2] = vx[i + 2];
      nor[o3] = nx; nor[o3 + 1] = ny; nor[o3 + 2] = nz;
      col[o4] = r; col[o4 + 1] = g; col[o4 + 2] = b; col[o4 + 3] = 1;
      o3 += 3; o4 += 4;
    }
  };

  for (let cz = 0; cz < CS; cz++) {
    for (let cx = 0; cx < CS; cx++) {
      const gx = Ci * CS + cx, gz = Cj * CS + cz;
      const h = heightAt(gx, gz, t);
      heightColor(h, _c);
      const r = _c[0], g = _c[1], b = _c[2];
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

  // 事前確保した同形配列へ書き戻し → GPU 再アップロード（負荷の主役）。
  ch.mesh.setPositions(pos);
  ch.mesh.setNormals(nor);
  ch.mesh.setColors(col, 4);
  ch.mesh.update(pc.PRIMITIVE_TRIANGLES);
}

// ---- チャンク集合の作成 / 破棄 ----------------------------------------------
let NC = NC_INIT;
function clearChunks() {
  for (const ch of chunks) {
    ch.entity.destroy();          // MeshInstance ごと破棄
    if (ch.mesh.destroy) ch.mesh.destroy(); // 各チャンク独自 mesh なので破棄は安全
  }
  chunks.length = 0;
}
function setChunks(nc) {
  NC = Math.max(NC_MIN, Math.min(NC_MAX, nc | 0));
  clearChunks();
  for (let Cj = 0; Cj < NC; Cj++)
    for (let Ci = 0; Ci < NC; Ci++) chunks.push(makeChunk(Ci, Cj));
}
setChunks(NC_INIT);

// ---- 入力（three.js版と同じ素の addEventListener 実装） ----------------------
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "+" || k === "=" || k === "]") setChunks(NC + 1);
  if (k === "-" || k === "_" || k === "[") setChunks(NC - 1);
  if (k === "r") setChunks(NC_INIT);
});

// ---- メインループ -----------------------------------------------------------
let fps = 60, t = 0;
app.on("update", (dtRaw) => {
  let dt = dtRaw;
  if (dt > 0.05) dt = 0.05;               // スパイク抑制
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.1;
  t += dt;

  const halfWorld = (NC * CS * CS_SIZE) / 2;
  for (const ch of chunks) rebuildChunk(ch, t, halfWorld); // 毎フレーム再構築＋再アップロード

  updateHUD();
});

// ---- HUD --------------------------------------------------------------------
const hud = document.getElementById("hud");
let hudT = 0;
function updateHUD() {
  if (++hudT % 6 !== 0) return; // 数フレームに1回更新
  // Draws: v2 系は app.stats.drawCalls.total が正。
  const dc = (app.stats && app.stats.drawCalls) || (device.stats && device.stats.drawCalls) || {};
  const draws = (dc.total != null ? dc.total : dc.forward) || chunks.length;
  // Tris 概算: チャンク数 × 144セル × 10三角（注記: 実測ではなく仕様上の三角数）。
  const tris = NC * NC * 144 * 10;
  hud.textContent =
    `FPS     ${fps.toFixed(1)}\n` +
    `Objects ${chunks.length}\n` +
    `Chunks  ${NC}x${NC}\n` +
    `Draws   ${draws}\n` +
    `Tris    ${tris.toLocaleString()}`;
}

app.start();
})();
