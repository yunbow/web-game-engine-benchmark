// 3D テーマ10(T10) ― 大量レイキャスト（LIDAR スキャナ・A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)とロジックを完全一致させる。
//
// A-Frame は three.js 上の宣言的フレームワーク。Raycaster や InstancedMesh は宣言タグでは扱えないため、
// カスタムコンポーネント `lidar` の中で AFRAME.THREE を直接使い、ターゲット/当たり点/スキャナを object3D に載せる。
// three は別途読み込まず、A-Frame 同梱の AFRAME.THREE を使う。
//
// 中心スキャナから毎フレーム N 本のレイを全方位へ放ち、THREE.Raycaster で M ターゲット(InstancedMesh)との
// 最近交差を求め、当たり点を InstancedMesh の小球で描画する。レイ数 N が比較の主軸。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致させる） --------------------------
const W = 960, H = 540;
const M = 120, SHELL = 28, BOX = 4;
const N_INIT = 1500, N_STEP = 1500, N_MIN = 500, N_MAX = 15000;
const FAR = 200;
const CAM_R = 55, CAM_Y = 20, CAM_W = 0.15;
const GOLDEN = 2.399963229728653; // 黄金角

AFRAME.registerComponent("lidar", {
  init: function () {
    const root = this.el.object3D; // a-scene の object3D に追加する親

    // ---- ターゲット（M個の box を1つの InstancedMesh に。Raycaster はこれを交差判定） ----
    const targets = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BOX, BOX, BOX),
      new THREE.MeshLambertMaterial({ color: 0x6d8db0 }), M);
    {
      const d = new THREE.Object3D();
      for (let i = 0; i < M; i++) {
        const y = 1 - 2 * (i + 0.5) / M, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * GOLDEN;
        d.position.set(Math.cos(th) * r * SHELL, y * SHELL, Math.sin(th) * r * SHELL);
        d.rotation.set(0, 0, 0); // 軸整列（無回転）。PlayCanvasの自前ray-AABBと結果を揃えるため
        d.updateMatrix(); targets.setMatrixAt(i, d.matrix);
      }
      targets.instanceMatrix.needsUpdate = true;
    }
    root.add(targets);
    this.targets = targets;

    // スキャナ原点マーカー（小さな自発光球）
    const scanner = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), new THREE.MeshBasicMaterial({ color: 0x6cff9a }));
    root.add(scanner);
    this.scanner = scanner;

    // 当たり点マーカー（インスタンス）
    const hits = new THREE.InstancedMesh(new THREE.SphereGeometry(0.4, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffd54a }), N_MAX);
    hits.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    hits.frustumCulled = false;
    root.add(hits);
    this.hits = hits;

    // ---- レイ方向（フィボナッチ球・決定的）。N 変更時に再構築 ----
    this.count = N_INIT;
    this.dirs = new Float32Array(0);
    this.buildDirs(N_INIT);

    // ---- カメラ（宣言した #rig の object3D を手動制御） ----
    this.cameraEl = this.el.querySelector("#rig");

    // ---- ループ用テンポラリ ----
    this.ray = new THREE.Raycaster(); this.ray.far = FAR;
    this.origin = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.dummy = new THREE.Object3D();

    // ---- 状態 ----
    this.fps = 60; this.t = 0; this.hitCount = 0; this.hudT = 0;

    // ---- 入力 ----
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.setCount(this.count + N_STEP);
      if (k === "-" || k === "_" || k === "[") this.setCount(this.count - N_STEP);
      if (k === "r") this.setCount(N_INIT);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- HUD ----
    this.hud = document.getElementById("hud");
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
  },

  buildDirs: function (n) {
    const dirs = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * GOLDEN;
      dirs[i * 3] = Math.cos(th) * r; dirs[i * 3 + 1] = y; dirs[i * 3 + 2] = Math.sin(th) * r;
    }
    this.dirs = dirs;
  },

  setCount: function (n) {
    this.count = Math.max(N_MIN, Math.min(N_MAX, n | 0));
    this.buildDirs(this.count);
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し min(0.05, max(0, dt)) でクランプ。
  tick: function (time, timeDelta) {
    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05; else if (dt < 0) dt = 0;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.t += dt;
    const t = this.t;

    // カメラ周回。
    // 重要: cameraEl.object3D は Group。Group.lookAt は +Z を対象へ向ける（非カメラ分岐）ため、
    // 子の PerspectiveCamera(-Z を見る)が真後ろを向く。よって THREE.Camera 本体を直接制御する。
    // rig(Group)は HTML で position="0 0 0" の単位変換なので、camera 本体の local=world。
    const cam = this.cameraEl.getObject3D("camera");
    if (cam) {
      const a = t * CAM_W;
      cam.position.set(CAM_R * Math.cos(a), CAM_Y, CAM_R * Math.sin(a));
      cam.lookAt(0, 0, 0); // isCamera 分岐 → -Z が対象を向く（正しい）
    }

    // スキャナ原点（微小上下）＋ レイ全体をゆっくり Y 回転
    const origin = this.origin, dir = this.dir, dummy = this.dummy;
    origin.set(0, Math.sin(t * 0.7) * 2, 0);
    this.scanner.position.copy(origin);
    const rot = t * 0.1, cs = Math.cos(rot), sn = Math.sin(rot);

    const dirs = this.dirs, count = this.count, ray = this.ray, targets = this.targets, hits = this.hits;
    let hitCount = 0;
    for (let i = 0; i < count; i++) {
      // 方向（Y回転を適用）
      const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
      dir.set(dx * cs - dz * sn, dy, dx * sn + dz * cs);
      ray.set(origin, dir);
      const hit = ray.intersectObject(targets, false);
      if (hit.length) {
        const p = hit[0].point;
        dummy.position.set(p.x, p.y, p.z); dummy.updateMatrix();
        hits.setMatrixAt(hitCount++, dummy.matrix);
      }
    }
    hits.count = hitCount;
    hits.instanceMatrix.needsUpdate = true;
    this.hitCount = hitCount;

    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS    ${this.fps.toFixed(1)}\n` +
      `Objects ${M}\n` +
      `Rays   ${this.count}\n` +
      `Hits   ${this.hitCount}\n` +
      `Draws  ${info.calls}\n` +
      `Tris   ${info.triangles.toLocaleString()}`;
  }
});
