// 3D テーマ3(T4) ― スキンドキャラ大群（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)とロジックを完全一致させる。
//
// 採用方式: 方式A（GLTFLoader 1回ロード → SkeletonUtils.clone で個体複製 → 個体ごとに AnimationMixer）。
//  - glTF のロードは A-Frame 同梱の gltf-model コンポーネント（<a-entity id="loader" gltf-model="#man">）に任せる。
//    A-Frame 1.7.0 では GLTFLoader が THREE に公開されない（ESM内蔵）ため、宣言的ロードを利用するのが堅い。
//    model-loaded イベントで baseModel(=gltf.scene) と animations を取得する。
//  - SkeletonUtils.clone は AFRAME.THREE のバージョン(super-three 0.173)に追従させるため、
//    three r173 の SkeletonUtils.clone 実装をここに「自前インライン」する（外部 import 不要・バージョン不一致回避）。
//    通常の .clone() はスケルトンを共有して破綻するため、スキンドメッシュ専用のクローンが必須。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const GLB_URL = "../assets/CesiumMan.glb"; // 参考（実ロードは a-asset-item #man 経由）
const N_INIT = 50, N_STEP = 25, N_MIN = 10, N_MAX = 1000;
const SPACING = 2.2, TARGET_H = 1.7;
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

// ---- SkeletonUtils.clone（three r173 相当を自前インライン） ------------------
// 出典: three/examples/jsm/utils/SkeletonUtils.js（clone のみ移植）。
// THREE のコンストラクタを使わず source.clone()/skeleton.clone() のみで完結するため
// AFRAME.THREE のバージョンに自動追従する（version mismatch なし）。
function skeletonClone(source) {
  const sourceLookup = new Map();
  const cloneLookup = new Map();
  const clone = source.clone();

  parallelTraverse(source, clone, function (sourceNode, clonedNode) {
    sourceLookup.set(clonedNode, sourceNode);
    cloneLookup.set(sourceNode, clonedNode);
  });

  clone.traverse(function (node) {
    if (!node.isSkinnedMesh) return;
    const clonedMesh = node;
    const sourceMesh = sourceLookup.get(node);
    const sourceBones = sourceMesh.skeleton.bones;
    clonedMesh.skeleton = sourceMesh.skeleton.clone();
    clonedMesh.bindMatrix.copy(sourceMesh.bindMatrix);
    clonedMesh.skeleton.bones = sourceBones.map(function (bone) {
      return cloneLookup.get(bone);
    });
    clonedMesh.bind(clonedMesh.skeleton, clonedMesh.bindMatrix);
  });

  return clone;
}
function parallelTraverse(a, b, callback) {
  callback(a, b);
  for (let i = 0; i < a.children.length; i++) {
    parallelTraverse(a.children[i], b.children[i], callback);
  }
}

AFRAME.registerComponent("crowd", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    this.root = this.el.object3D; // a-scene の object3D を親に使う

    // ---- 状態 ---------------------------------------------------------------
    this.count = N_INIT;
    this.fps = 60;
    this.hudT = 0;
    this.tAccum = 0;
    this.baseModel = null;
    this.walkClip = null;
    this.modelScale = 1;
    this.footOffset = 0;
    this.fallback = false;
    this.ready = false;        // glTF ロード完了 or フォールバック確定後 true
    this.crowd = [];           // { root, mixer }

    // ---- カメラ（宣言した #rig の camera 本体を手動制御） -------------------
    this.cameraEl = sceneEl.querySelector("#rig");
    this.cameraSet = false;

    // ---- HUD ----------------------------------------------------------------
    this.hud = document.getElementById("hud");

    // ---- 入力 ---------------------------------------------------------------
    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.rebuild(this.count + N_STEP);
      if (k === "-" || k === "_" || k === "[") this.rebuild(this.count - N_STEP);
      if (k === "r") this.rebuild(this.count);
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- glTF ロード（A-Frame 同梱 gltf-model 経由） ------------------------
    const loaderEl = sceneEl.querySelector("#loader");
    this.onModelLoaded = (e) => {
      const model = e.detail.model;
      const clip = model.animations && model.animations[0];
      if (!clip) { this.startFallback(); return; }
      this.baseModel = model;
      this.walkClip = clip;
      // gltf-model は base を setObject3D('mesh') でシーンに載せる。テンプレートとしてのみ使い、
      // 描画/HUD計数に混ぜないようシーンから外す（three.js版は base を add しない）。
      const loaderEl = this.el.sceneEl.querySelector("#loader");
      if (model.parent) model.parent.remove(model);
      if (loaderEl && loaderEl.object3DMap && loaderEl.object3DMap.mesh) {
        delete loaderEl.object3DMap.mesh;
      }
      // バウンディングボックスから身長 TARGET_H に合わせるスケールと接地オフセットを算出
      const box = new THREE.Box3().setFromObject(this.baseModel);
      const h = (box.max.y - box.min.y) || 1;
      this.modelScale = TARGET_H / h;
      this.footOffset = -box.min.y * this.modelScale;
      if (this.loadTimer) { clearTimeout(this.loadTimer); this.loadTimer = null; }
      this.ready = true;
      this.buildCrowd(N_INIT);
    };
    this.onModelError = () => {
      console.warn("glTF load failed, using primitive fallback.");
      this.startFallback();
    };
    loaderEl.addEventListener("model-loaded", this.onModelLoaded);
    loaderEl.addEventListener("model-error", this.onModelError);

    // セーフティ: アセット preload 失敗等で model-loaded/error が来ない場合も
    //            一定時間で図形フォールバックに切り替えて必ず起動する。
    this.loadTimer = setTimeout(() => { if (!this.ready) this.startFallback(); }, 8000);
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
    if (this.loadTimer) { clearTimeout(this.loadTimer); this.loadTimer = null; }
  },

  startFallback: function () {
    if (this.ready) return;
    if (this.loadTimer) { clearTimeout(this.loadTimer); this.loadTimer = null; }
    this.fallback = true;
    this.footOffset = 1.0;
    this.ready = true;
    this.buildCrowd(N_INIT);
  },

  // ---- グリッド配置（three.js版 placeAt と一致） ---------------------------
  placeAt: function (obj, i, n) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const c = i % cols, r = Math.floor(i / cols);
    obj.position.set(
      (c - (cols - 1) / 2) * SPACING,
      this.footOffset,
      (r - (rows - 1) / 2) * SPACING
    );
  },

  // ---- 群衆構築 -----------------------------------------------------------
  clearCrowd: function () {
    for (const e of this.crowd) {
      this.root.remove(e.root);
      if (e.mixer) e.mixer.stopAllAction();
    }
    this.crowd.length = 0;
  },

  buildCrowd: function (n) {
    this.clearCrowd();
    const rnd = mulberry32(SEED);
    for (let i = 0; i < n; i++) {
      const speed = 0.8 + rnd() * 0.4;        // timeScale [0.8,1.2]
      const phase = rnd();                      // 開始位相 [0,1)*clipDuration
      let root, mixer = null;
      if (!this.fallback) {
        root = skeletonClone(this.baseModel);   // スキン独立クローン（必須: 通常clone不可）
        root.scale.setScalar(this.modelScale);
        mixer = new THREE.AnimationMixer(root);
        const action = mixer.clipAction(this.walkClip);
        action.play();
        action.time = phase * this.walkClip.duration;
        mixer.timeScale = speed;
      } else {
        // フォールバック: 上下に弾むカプセル（スキニング無し）
        root = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.4, 1.0, 4, 8),
          new THREE.MeshLambertMaterial({ color: 0x8ab4ff })
        );
        root.userData.speed = speed * 3;
        root.userData.phase = phase * Math.PI * 2;
      }
      this.placeAt(root, i, n);
      this.root.add(root);
      this.crowd.push({ root, mixer });
    }
    this.count = n;
  },

  rebuild: function (n) {
    if (!this.ready) return;
    this.buildCrowd(Math.max(N_MIN, Math.min(N_MAX, n | 0)));
  },

  // ---- メインループ（three.js版 frame 相当） -------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し 0.05 でクランプ。
  tick: function (time, timeDelta) {
    // カメラ本体を制御（rig は単位変換 0 0 0 なので camera 本体の local=world）。
    // 重要: rig.object3D は Group。Group.lookAt は逆を向く罠があるため、
    //       getObject3D('camera') = THREE.Camera 本体に position/lookAt する。
    if (!this.cameraSet && this.cameraEl) {
      const cam = this.cameraEl.getObject3D("camera");
      if (cam) {
        cam.position.set(0, 12, 26);
        cam.lookAt(0, 1.5, 0);   // isCamera 分岐 → -Z が対象を向く（正しい）
        this.cameraSet = true;
      }
    }

    if (!this.ready) { this.updateHUD(); return; }

    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;               // スパイク抑制
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.tAccum += dt;

    if (!this.fallback) {
      for (const e of this.crowd) e.mixer.update(dt);
    } else {
      for (const e of this.crowd) {
        e.root.position.y = this.footOffset +
          Math.max(0, Math.sin(this.tAccum * e.root.userData.speed + e.root.userData.phase)) * 0.4;
      }
    }

    this.updateHUD();
  },

  // ---- HUD ----------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS     ${this.fps.toFixed(1)}\n` +
      `Objects ${this.count}\n` +
      `Chars   ${this.count}${this.fallback ? " (fallback: no skin)" : ""}\n` +
      `Draws   ${info.calls}\n` +
      `Tris    ${info.triangles.toLocaleString()}`;
  }
});
