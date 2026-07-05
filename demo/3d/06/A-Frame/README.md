# 3D テーマ6（T5）― 動的シャドウ光源（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一挙動」で移植したもの。
仕様の唯一の正は `../SPEC.md`。柱配置・光源パラメータ・影解像度・カメラ・HUD はすべて SPEC / three.js 版と一致させている。

## 起動方法

CDN 読込のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/06
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- `+` / `-`（および `]` / `[`）: 影付き光源数を ±2（最小 1 / 最大 12）。**比較の主軸**。
- `R`: 光源数を初期値（4）に戻す。
- カメラ固定・光源は自動周回（無人ベンチ可）。

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。
  - 正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

## 実装メモ

- **renderer.shadowMap の有効化**: A-Frame 既定ではシャドウマップが無効。カスタムコンポーネント
  `shadowscene` の `init()` で `sceneEl.renderer.shadowMap.enabled = true` と
  `shadowMap.type = THREE.PCFSoftShadowMap`（ソフト影）を直接設定する。`init` 時点で renderer が
  未生成の場合に備え、`render-target-loaded` イベントでも一度だけ有効化する保険を入れている。
- **SpotLight 影設定をカスタムコンポーネントで移植**: 地面 Mesh（`receiveShadow=true`）・柱 64 本
  （`castShadow + receiveShadow`、共有 BoxGeometry/Material、高さ h=3〜9 を mulberry32(seed=0x9e3779b9)
  で決定的生成）・スポットライト（`castShadow=true` / `shadow.mapSize.set(1024,1024)` /
  `shadow.camera.near=5,far=90` / `bias=-0.0005` / target を (0,1,0)）を `AFRAME.THREE` で直接生成し、
  `this.el.object3D`（= `<a-scene>` の object3D）に `add` している。これらは宣言タグでは細かい影設定が
  表現しきれないため、three.js 版 `makeLight()` をほぼそのまま移植する形にした。
- **光源数 N の増減**: `+`/`-`/`[`/`]` で light を dispose / 再生成、`R` で初期値。位相 φ_i は描画ごとに
  `i*2π/N` で再計算するため、N 変更時に自動で再配置される。
- **光源周回**: `tick(time, timeDelta)` で秒へ変換し 0.05 クランプ。SPEC 通り 高さ30 / 半径22 /
  角速度0.4 / 位相 i*2π/N / 色相 i/N。three.js 版 `frame()` と同一ロジック。
- **カメラの手動制御とカメラ罠**: `<a-entity id="rig" camera>` に `look-controls`/`wasd-controls` を
  `enabled:false` で付けて A-Frame 既定入力を無効化。**重要な罠**として、`rig.object3D` は Group であり、
  `Group.lookAt` は非カメラ分岐で +Z を対象へ向けるため、子の PerspectiveCamera（-Z を見る）が逆を向く。
  そこで `rigEl.getObject3D("camera")`（= THREE.Camera 本体）に対して `position.set(0,28,40)` と
  `lookAt(0,2,0)` を呼ぶ（isCamera 分岐で -Z が対象を向く＝正しい）。カメラは固定なので、camera 本体が
  用意できたフレームで一度だけ設定している。
- **HUD は `renderer.info`**: `sceneEl.renderer.info.render.calls / triangles` から Draws / Tris を取得。
  **three.js の `renderer.info` はメインパスのみ計上し、シャドウパス（光源ごとのデプス描画）を含めない**ため、
  Draws/Tris は光源数を増やしてもほぼ一定で、Babylon/PlayCanvas の計測値とは意味がずれる。
  **影コストの主指標は FPS**（光源数を増やすとシャドウマップ生成パスが増え FPS が落ちる）。
  HUD / help / note は `<a-scene>` の外側の HTML オーバーレイで、three.js 版と同じ構造・CSS
  （960x540、FPS/Objects/Lights/Draws/Tris の 5 項目、note「dynamic shadows: SpotLight shadow maps (1024)」）。
  `<a-scene embedded>` で `#wrap`（960x540）内に収めている。

## AI コーディング生成のしやすさ所感

- シャドウマップは A-Frame の宣言層（`<a-light>` や `light` コンポーネント）でも `castShadow`/`receiveShadow` を
  扱えるが、解像度・シャドウカメラ near/far・bias など細かいパラメータと「N 個を動的に dispose/再生成」する
  挙動を SPEC 通りに揃えるには、結局 `AFRAME.THREE` で SpotLight を直接生成するのが確実だった。
  three.js を知っていれば `init()`/`tick()` がそのままセットアップ/ループに対応し、移植は機械的。
- 最大の罠は 2 点: (1) **A-Frame 既定では `renderer.shadowMap.enabled` が false** なので、明示的に有効化しないと
  影が一切出ない。(2) **カメラの Group.lookAt 逆向き問題**（getObject3D('camera') 本体で lookAt する）。
  この 2 点を押さえれば three.js 版とほぼ等価なコードになる。
