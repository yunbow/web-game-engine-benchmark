// 3D テーマ5(T2) ― 広域地形 + カリング/LOD/描画距離（A-Frame 移植）
// SPEC: ../SPEC.md が唯一の正。three.js リファレンス実装(../three.js/game.js)とロジックを完全一致させる。
//
// A-Frame は three.js 上の宣言的フレームワーク。10000本の木の生成・距離カリング・LOD は宣言タグでは
// 表現できないため、カスタムコンポーネント `forest` の init() で AFRAME.THREE のジオメトリ/マテリアル/
// Group を直接生成し、this.el.object3D（= <a-scene> の object3D）に add する。
// three は別途読み込まず、A-Frame 同梱の AFRAME.THREE を使う。

const THREE = AFRAME.THREE;

// ---- 共通定数（SPEC 準拠・全ライブラリ一致） --------------------------------
const GRID = 100, SP = 8;                       // 100x100=10000本, 間隔8
const DD_INIT = 120, DD_STEP = 40, DD_MIN = 40, DD_MAX = 360;
const CAM_R = 140, CAM_Y = 26, CAM_W = 0.15;    // 周回半径/高さ/角速度
const SEED = 0x9e3779b9 >>> 0;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

AFRAME.registerComponent("forest", {
  init: function () {
    const sceneEl = this.el.sceneEl;
    const root = this.el.object3D; // <a-scene> の object3D に木を追加

    // fog は <a-scene fog> で宣言済みだが、念のため object3D 側にも設定（同値）
    if (!sceneEl.object3D.fog) {
      sceneEl.object3D.fog = new THREE.Fog(0x8fb8e6, 80, 400);
    }

    const textureLoader = new THREE.TextureLoader();
    function loadRepeatingTexture(path, repeatX, repeatY) {
      const texture = textureLoader.load(path);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeatX, repeatY);
      return texture;
    }
    const groundTexture = loadRepeatingTexture("../assets/ground_forest_texture.png", 30, 30);
    const barkTexture = loadRepeatingTexture("../assets/tree_bark_texture.png", 1, 2);
    const foliageTexture = loadRepeatingTexture("../assets/tree_foliage_texture.png", 2, 2);

    // ---- 地面（大判の平面・暗緑） ------------------------------------------
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900),
      new THREE.MeshLambertMaterial({ color: 0x24402a, map: groundTexture })
    );
    ground.rotation.x = -Math.PI / 2;
    root.add(ground);

    // ---- 共有ジオメトリ / マテリアル（全木で共有） --------------------------
    const trunkGeo = new THREE.CylinderGeometry(0.4, 0.5, 2, 6); trunkGeo.translate(0, 1, 0);
    const foliageGeo = new THREE.ConeGeometry(1.7, 4, 8); foliageGeo.translate(0, 4, 0);
    const lowGeo = new THREE.ConeGeometry(1.7, 6, 4); lowGeo.translate(0, 3, 0); // LOD1: 単一低ポリ
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a633c, map: barkTexture });
    const foliageMat = new THREE.MeshLambertMaterial({ color: 0x4d8f4a, map: foliageTexture });
    const lowMat = new THREE.MeshLambertMaterial({ color: 0x4b8848, map: foliageTexture });

    // ---- 木を生成（共有ジオメトリ参照） ------------------------------------
    // 構造: obj(Group) ┬ lod0(Group: trunk + foliage)
    //                  └ lod1(low cone)
    this.trees = [];   // { obj, lod0, lod1, x, z }
    const rnd = mulberry32(SEED);
    for (let i = 0; i < GRID * GRID; i++) {
      const c = i % GRID, r = (i / GRID) | 0;
      const x = (c - (GRID - 1) / 2) * SP;
      const z = (r - (GRID - 1) / 2) * SP;
      const hf = 0.8 + rnd() * 0.6;       // 高さ係数（同順で消費）
      const ry = rnd() * Math.PI * 2;     // Y回転（同順で消費）

      const lod0 = new THREE.Group();
      lod0.add(new THREE.Mesh(trunkGeo, trunkMat), new THREE.Mesh(foliageGeo, foliageMat));
      const lod1 = new THREE.Mesh(lowGeo, lowMat);

      const obj = new THREE.Group();
      obj.add(lod0, lod1);
      obj.position.set(x, 0, z);
      obj.rotation.y = ry;
      obj.scale.set(1, hf, 1);
      obj.visible = false;
      root.add(obj);
      this.trees.push({ obj, lod0, lod1, x, z });
    }

    // ---- 状態 / 入力 -------------------------------------------------------
    this.drawDist = DD_INIT;
    this.fps = 60;
    this.inRange = 0;
    this.t = 0;
    this.hudT = 0;

    this.onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=" || k === "]") this.drawDist = Math.min(DD_MAX, this.drawDist + DD_STEP);
      if (k === "-" || k === "_" || k === "[") this.drawDist = Math.max(DD_MIN, this.drawDist - DD_STEP);
      if (k === "r") this.drawDist = DD_INIT;
    };
    addEventListener("keydown", this.onKeyDown);

    // ---- カメラ本体（宣言した #rig の object3D 'camera' を手動制御） -------
    this.cameraEl = sceneEl.querySelector("#rig");

    // ---- HUD ---------------------------------------------------------------
    this.hud = document.getElementById("hud");
  },

  remove: function () {
    removeEventListener("keydown", this.onKeyDown);
  },

  // ---- メインループ（three.js版 frame 相当） --------------------------------
  // tick(time, timeDelta): A-Frame は ms を渡す。dt は秒へ変換し 0.05 でクランプ。
  tick: function (time, timeDelta) {
    let dt = (timeDelta || 0) / 1000;
    if (dt > 0.05) dt = 0.05;               // スパイク抑制
    if (dt <= 0) dt = 1e-4;
    this.fps += ((1 / Math.max(dt, 1e-4)) - this.fps) * 0.1;
    this.t += dt;

    // カメラ自動周回飛行。
    // 重要: cameraEl.object3D は Group。Group.lookAt は +Z を対象へ向ける（非カメラ分岐）ため
    // 子の PerspectiveCamera(-Z を見る) が逆を向く。よって THREE.Camera 本体を直接制御する。
    // rig(Group) は HTML で position="0 0 0" の単位変換なので camera 本体の local=world。
    const th = this.t * CAM_W;
    const cx = CAM_R * Math.cos(th), cz = CAM_R * Math.sin(th);
    const cam = this.cameraEl.getObject3D("camera");
    if (cam) {
      cam.position.set(cx, CAM_Y, cz);
      cam.lookAt(CAM_R * 0.4 * Math.cos(th), 2, CAM_R * 0.4 * Math.sin(th));
    }

    // 距離カリング + LOD（アプリ側）。視錐台カリングは three が自動で行う。
    const drawDist = this.drawDist;
    const dd2 = drawDist * drawDist;
    const lod2 = (drawDist * 0.5) * (drawDist * 0.5);
    const trees = this.trees;
    let inRange = 0;
    for (let i = 0; i < trees.length; i++) {
      const tr = trees[i];
      const dx = tr.x - cx, dz = tr.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > dd2) { tr.obj.visible = false; continue; }
      tr.obj.visible = true; inRange++;
      const near = d2 <= lod2;
      tr.lod0.visible = near; tr.lod1.visible = !near;
    }
    this.inRange = inRange;

    // 描画は A-Frame のレンダループが自動で行う（明示 render 不要）。
    this.updateHUD();
  },

  // ---- HUD ------------------------------------------------------------------
  updateHUD: function () {
    if (++this.hudT % 6 !== 0) return; // 数フレームに1回更新
    const info = this.el.sceneEl.renderer.info.render;
    this.hud.textContent =
      `FPS      ${this.fps.toFixed(1)}\n` +
      `Objects  ${this.inRange}\n` +
      `DrawDist ${this.drawDist}\n` +
      `Draws    ${info.calls}\n` +
      `Tris     ${info.triangles.toLocaleString()}`;
  }
});
