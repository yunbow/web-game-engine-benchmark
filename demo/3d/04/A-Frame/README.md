# 3D テーマ4（T6）― GPUパーティクル（魔法/噴水）（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一仕様」で移植したもの。
仕様の唯一の正は `../SPEC.md`。粒子数・寿命・速度域・重力・色・ブレンド・カメラ・HUD はすべて SPEC / three.js 版と一致させている。

## 起動方法

画像は使わないが、CDN 読込とローカル配信のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/04
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- `+` / `-`（および `]` / `[`）: 目標粒子数 N を ±20000（最小 5000 / 最大 500000）。**比較の主軸**。
- `R`: リセット（N を初期 20000 に戻す）。
- 入力なしで噴出は継続（無人ベンチ可能・`Math.random` 不使用の決定的生成）。

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。
  - 正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

## 実装メモ

- **A-Frame には標準の粒子機構が無い** → three.js 版と同方式で、`THREE.Points` + 自作 `ShaderMaterial` をカスタムコンポーネント `particles` の `init()` で生成し、`this.el.object3D`（= `<a-scene>` の object3D）に `add` する。背景・カメラは `<a-scene background>` / `<a-entity camera>` で宣言的に記述（A-Frame らしさを維持）。
- **GPU側アニメ（CPU毎フレーム更新なし）**: `N_MAX=500000` ぶんの BufferGeometry（`position` / `aVel` / `aOffset`）を1回だけ確保し、`mulberry32(seed=0x9e3779b9)` で各粒子の初速（上方コーン 仰角35〜90° / 速さ 4〜10 u/s）と寿命オフセット（位相）を three.js 版と**同じ順序で**決定的に生成。実位置は**頂点シェーダで** `pos = aVel*age + 0.5*g*age^2` を時間から計算する（`uTime` のみ毎フレーム更新）。
- **加算ブレンド発光**: `ShaderMaterial` を `blending: THREE.AdditiveBlending` / `depthWrite: false` / `depthTest: true` / `transparent: true` で設定。フラグメントで `gl_PointCoord` から円形 discard + ソフトエッジ、寿命で 黄(#fff1a8)→橙(#ff8a3d)→赤紫 に色と輝度・アルファをフェード。頂点/フラグメント GLSL・uniforms（`uTime` / `uLife` / `uGrav` / `uSize` / `uDpr`）は three.js 版と同一。
- **粒子数 N の制御**: `geo.setDrawRange(0, N)` で描画範囲を変えるだけ（バッファ再生成なし）。`+`/`-`/`]`/`[` で ±20000、`R` で 20000 に。
- **カリング無効化**: `points.frustumCulled = false` と `boundingSphere`（中心 (0,5,0)・半径 1000）を大きめに設定し、画面外判定で粒子群がカリングされるのを防ぐ。
- **カメラの罠（T1で踏んだもの）**: `<a-entity id="rig" camera>` の `object3D` は **Group**。Group の `lookAt` は +Z を対象へ向ける（非カメラ分岐）ため、Group に `lookAt(0,5,0)` すると**逆を向く**。よって `cameraEl.getObject3D("camera")`（= `THREE.PerspectiveCamera` 本体、isCamera 分岐で -Z が対象を向く）に対して `position.set(0,8,26)` / `lookAt(0,5,0)` を行う。rig は `position="0 0 0"` なので camera 本体の local=world。`look-controls`/`wasd-controls` は無効化し既定入力を打ち消す。`getObject3D("camera")` は `init` より生成が遅れることがあるため、`tick` で一度だけ確実に設定している。
- **HUD は `renderer.info`**: `this.el.sceneEl.renderer.info.render.calls`（Draws）/ `.points`（Points）を数フレームに1回（6フレームごと）取得。HUD / help / note は `<a-scene>` 外の HTML オーバーレイで、three.js 版 T6 と同一構造・CSS（960x540、FPS / Objects / Particles / Draws / Points、note「GPU particles: Points + vertex-shader (additive)」）。`<a-scene embedded>` で `#wrap`（960x540）内に収めている。
- **座標系**: A-Frame は three.js と同じ右手系・Y軸上向き。SPEC 通り原点 (0,0,0) から +Y へ噴き上がり、重力 (0,-9,0) で放物線を描いて落ちる定常噴水。

## AI コーディング生成のしやすさ所感

- A-Frame には粒子コンポーネントの標準実装が無いため、AI に素直に書かせると外部の `aframe-particle-system-component` のような第三者ライブラリに頼りがちで、SPEC（頂点シェーダ駆動・GPU側アニメ・特定の色/ブレンド）と一致しなくなる。**「Points + 自作 ShaderMaterial をカスタムコンポーネントで」**という方針を明示する必要がある。一度その方針を与えれば、`init()` がセットアップ、`tick()` がメインループに綺麗に対応し、three.js 版からの移植は機械的で容易（シェーダ・属性生成はそのまま流用できる）。
- 罠は主に 3 点: (1) `<a-scene>` が独自に three.js を内包するため別途 three を import せず `AFRAME.THREE` を使う、(2) カメラ手動制御は **Group ではなく camera 本体**（`getObject3D("camera")`）に対して行う・`look-controls`/`wasd-controls` を無効化する、(3) `getObject3D("camera")` の生成タイミングが `init` より遅れることがあるため `tick` 内で設定する。これらを押さえれば three.js 版とほぼ等価。
- HUD の Draws/Points も `sceneEl.renderer.info.render` で three.js と同一 API のため移植容易。総じて「粒子機構を自前シェーダで書く」と割り切れば、three.js を知っていればそのまま書ける、という所感。
