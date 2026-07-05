// 3D テーマ7(T7) ― ボクセルチャンク再生成（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)とロジックを完全一致させる。
//
// A-Frame は three.js 上の宣言的フレームワーク。毎フレームの BufferGeometry 再構築/再アップロードは
// 宣言タグでは表現できないため、カスタムコンポーネント `voxels` の init/tick 内で AFRAME.THREE を
// 直接叩き、事前確保した属性配列を毎フレーム書き換えて GPU に再アップロードする。
// three は別途読み込まず、A-Frame 同梱の AFRAME.THREE を使う。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const CS = 12, CS_SIZE = 2;              // 1チャンク=12x12セル, セル2u
const NC_INIT = 4, NC_MIN = 2, NC_MAX = 8;
const VERTS_PER_CELL = 30;               // 上面+側面4 = 5クアッド = 30頂点(非インデックス)
const CELLS = CS * CS;
const VPC = CELLS * VERTS_PER_CELL;      // チャンクあたり頂点数(4320)

// 高さの波（決定的・Math.random 不使用）
function heightAt(gx, gz, t) {
  return 1 + Math.floor((Math.sin(gx * 0.25 + t) + Math.cos(gz * 0.25 + t * 0.8) + 2) * 2);
}

// 高さ→色（緑→茶→白）
function heightColor(h, out) {
  const u = Math.min(1, (h - 1) / 8);
  if (u < 0.5) { const k = u * 2; out.setRGB(0.18 + 0.32 * k, 0.45 - 0.1 * k, 0.18); }
  else { const k = (u - 0.5) * 2; out.setRGB(0.5 + 0.5 * k, 0.35 + 0.55 * k, 0.18 + 0.72 * k); }
}

AFRAME.registerComponent("voxels", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    this.root = this.el.object3D; // a-scene の object3D を親にする

    // ---- ライト（環境光 + 平行光1灯） --------------------------------------
    this.root.add(new THREE.AmbientLight(0x8090a0, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(0.4, 1, 0.5);
    this.root.add(sun);

    // ---- チャンク状態 ------------------------------------------------------
    this.chunks = [];        // { mesh, geo, pos, nor, col, Ci, Cj }
    this._c = new THREE.Color();
    this.NC = NC_INIT;

    // ---- カメラ（宣言した #rig の camera 本体を一度だけ設定） ----------------
    // 重要: rig(Group)の object3D に lookAt すると、Group.lookAt は +Z を対象へ向ける（非カメラ分岐）
    //       ため、子の PerspectiveCamera(-Z を見る)が逆を向く。よって camera 本体を直接制御する。
    // camera は init 時に未生成のことがあるため、生成済みになるまで待ってから一度だけ設定。
    this.cameraEl = sceneEl.querySelector("#rig");
    this.cameraSet = false;

    this.setChunks(NC_INIT);

    // ---- 入力 --------------------------------------------------------------
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.setChunks(this.NC + 1);
      if (k === "-" || k === "_" || k === "[") this.setChunks(this.NC - 1);
      if (k === "r") this.setChunks(NC_INIT);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- HUD / ループ状態 --------------------------------------------------
    this.hud = document.getElementById("hud");
    this.hudT = 0;
    this.fps = 60;
    this.t = 0;
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
    this.clearChunks();
  },

  // ---- チャンク（事前確保バッファを毎フレーム書き換え） ---------------------
  makeChunk: function (Ci, Cj) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(VPC * 3);
    const nor = new Float32Array(VPC * 3);
    const col = new Float32Array(VPC * 3);
    const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const norAttr = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", posAttr);
    geo.setAttribute("normal", norAttr);
    geo.setAttribute("color", colAttr);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return { mesh, geo, pos, nor, col, Ci, Cj };
  },

  // 1チャンクのメッシュを現在の t で再構築（事前確保配列に書き込み）
  rebuildChunk: function (ch, t, halfWorld) {
    const { pos, nor, col, Ci, Cj } = ch;
    // チャンク原点（全体を中心揃え）
    const ox = Ci * CS * CS_SIZE - halfWorld;
    const oz = Cj * CS * CS_SIZE - halfWorld;
    let o = 0; // float offset

    // 1クアッド(2三角・6頂点)を push
    const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, r, g, b) => {
      const v = [ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz];
      for (let i = 0; i < 18; i += 3) {
        pos[o] = v[i]; pos[o + 1] = v[i + 1]; pos[o + 2] = v[i + 2];
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
        col[o] = r; col[o + 1] = g; col[o + 2] = b;
        o += 3;
      }
    };

    for (let cz = 0; cz < CS; cz++) {
      for (let cx = 0; cx < CS; cx++) {
        const gx = Ci * CS + cx, gz = Cj * CS + cz;
        const h = heightAt(gx, gz, t);
        heightColor(h, this._c);
        const r = this._c.r, g = this._c.g, b = this._c.b;
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
    ch.geo.attributes.color.needsUpdate = true;
  },

  // ---- チャンク集合の作成 ---------------------------------------------------
  clearChunks: function () {
    for (const ch of this.chunks) { this.root.remove(ch.mesh); ch.geo.dispose(); ch.mesh.material.dispose(); }
    this.chunks.length = 0;
  },

  setChunks: function (nc) {
    this.NC = Math.max(NC_MIN, Math.min(NC_MAX, nc | 0));
    this.clearChunks();
    for (let Cj = 0; Cj < this.NC; Cj++)
      for (let Ci = 0; Ci < this.NC; Ci++) this.chunks.push(this.makeChunk(Ci, Cj));
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し 0.05 でクランプ。
  tick: function (time, timeDelta) {
    // カメラ本体を一度だけ設定（init 時には未生成のことがある）
    if (!this.cameraSet) {
      const cam = this.cameraEl && this.cameraEl.getObject3D("camera");
      if (cam) {
        cam.position.set(0, 60, 95);
        cam.lookAt(0, 4, 0);          // isCamera 分岐 → -Z が対象を向く（正しい）
        this.cameraSet = true;
      }
    }

    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;          // スパイク抑制
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.t += dt;

    const halfWorld = (this.NC * CS * CS_SIZE) / 2;
    for (const ch of this.chunks) this.rebuildChunk(ch, this.t, halfWorld); // 毎フレーム再構築＋再アップロード

    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS    ${this.fps.toFixed(1)}\n` +
      `Objects ${this.NC * this.NC}\n` +
      `Chunks ${this.NC}x${this.NC}\n` +
      `Draws  ${info.calls}\n` +
      `Tris   ${info.triangles.toLocaleString()}`;
  }
});
