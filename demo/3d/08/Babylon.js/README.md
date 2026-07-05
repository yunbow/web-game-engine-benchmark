# 3D T8 ― PBR マテリアル + ポストプロセス(Bloom) / Babylon.js 版

three.js リファレンス実装を **同一仕様**（`../SPEC.md` が唯一の正）で Babylon.js v8 に移植したもの。
比較の主軸は **PBR 球の描画数 ＋ Bloom 合成パイプラインのコスト**。

## 起動方法

画像読込（任意の env）のため `file://` 直開きは不可。テーマフォルダをルートに HTTP サーバを立てる:

```bash
cd 3d/08
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

`../assets/env_equirect.png` は **任意**。無くても手続き的環境で起動する。

## 使用バージョン

- Babylon.js: `https://cdn.babylonjs.com/babylon.js`（グローバル `BABYLON`、最新安定版 v8 系）
- WebGL2（`new BABYLON.Engine(canvas, true, {antialias:true}, true)`）

## 操作

- `+` / `-`（`]` / `[`）: PBR 球数の増減（±100、最小50／最大2000）。**比較の主軸**。
- `R`: 球数を初期値(200)に戻す。
- カメラは自動周回（無人ベンチ可）。

## 実装メモ：PBR マテリアル設定

- 共有球メッシュ `CreateSphere`（直径 = 半径0.7 × 2、segments=24）を `isVisible=false` のテンプレートにし、
  各球は `clone()` で複製。
- 各球のマテリアルは **`PBRMetallicRoughnessMaterial`**。three.js の `MeshStandardMaterial` に最も近い PBR で、
  `baseColor` / `metallic` / `roughness` / `emissiveColor` を直接指定できる。
- 乱数は **mulberry32(seed=0x9e3779b9)**。`metallic`(半分は1.0)→`roughness`(0.05..1)→baseColor HSL(彩度0.7)
  →emissive 判定(15%)→emissive HSL の順で、**three.js 版とビット単位で同じ消費順**にしてある（色は同じ
  HSL→RGB 式を移植）。
- emissive 球（約15%）は `emissiveColor` を **×2.0** して強発光させ、Bloom で滲ませる
  （three.js の `emissiveIntensity=2.0` 相当）。
- 配置は `k=ceil(cbrt(N))` の立方格子・間隔2.2・中心揃え（`(idx-half)*SP`）。

## 実装メモ：DefaultRenderingPipeline（Bloom / ACES トーンマップ）統合とつまずき

- ポストは **`DefaultRenderingPipeline`** 1本で完結する（three.js の EffectComposer + UnrealBloomPass +
  OutputPass を 1 オブジェクトに集約）。
  ```js
  const pipe = new BABYLON.DefaultRenderingPipeline("p", true, scene, [camera]);
  pipe.bloomEnabled = true;
  pipe.bloomThreshold = 0.9;   // SPEC: 明るい/emissive 部分のみ滲む
  pipe.bloomWeight = 0.4;
  pipe.fxaaEnabled = true;
  pipe.imageProcessing.toneMappingEnabled = true;
  pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipe.imageProcessing.exposure = 1.0;
  ```
- **つまずき1（座標系）**: Babylon は既定が左手系。Y軸上向き・three.js と挙動を揃えるため
  `scene.useRightHandedSystem = true`。これを忘れるとカメラ周回の回転方向が反転する。
- **つまずき2（露出オーバー / 白飛び）**: PBR + 環境テクスチャ + 平行光 を素直に足すと白飛びしやすい。
  three.js 版で `environmentIntensity=0.5` に絞った経緯に合わせ、Babylon でも
  `scene.environmentIntensity = 0.5`、平行光は PBR スケール（物理的に明るい）に合わせて
  `intensity 2.0 / 1.2`、環境光は `HemisphericLight intensity=0.35` に抑えた。
  ACES トーンマップが効くので Bloom しきい値 0.9 で emissive 球だけが光る。
- **つまずき3（トーンマップ定数）**: トーンマップは `imageProcessing` 経由。`TONEMAPPING_ACES` は
  `BABYLON.ImageProcessingConfiguration` の静的定数（`scene.imageProcessingConfiguration` ではなく
  パイプライン側の `pipe.imageProcessing` に設定するとパイプライン全体に適用される）。

## 実装メモ：環境テクスチャのフォールバック

- PBR の反射には環境が要る。`../assets/env_equirect.png` を `Image()` で存在チェックし、
  - **あれば** `new BABYLON.Texture(...)` を作り `coordinatesMode = EQUIRECTANGULAR_MODE` で
    `scene.environmentTexture` に設定（equirectangular を反射に使用）。
  - **無ければ** `scene.createDefaultEnvironment({createSkybox:false, createGround:false})` で
    手続き的環境（既定の環境テクスチャ）を与えるフォールバック。背景は `#1a1f2a`。
- スカイボックス／地面は SPEC どおり生成しない（背景は単色クリアカラー）。

## HUD

左上 HTML オーバーレイ。`FPS`(移動平均) / `Objects`(=N) / `Spheres`(=N) /
`Draws`(`SceneInstrumentation.drawCallsCounter.current`) / `Tris`(概算: segments=24 球 × N) /
`Post`(bloom)。負荷測定の邪魔をしないよう数フレームに1回だけ更新。

## AI 生成所感

- three.js → Babylon の移植で **一番ラクだったのが Bloom**。EffectComposer に 3 パスを積む three.js に対し、
  Babylon は `DefaultRenderingPipeline` 1 行で Bloom + ACES + FXAA が揃う。SPEC が「統合の手間」を比較軸に
  挙げているとおり、ここは Babylon が明確に短い。
- 逆に **露出合わせは Babylon の方がシビア**。PBR の光強度スケールが three.js と異なり、同じ「白2.0」を
  そのまま入れると白飛びする。環境強度・平行光・トーンマップの三つ巴を手で詰める必要があった。
- `PBRMetallicRoughnessMaterial` は three.js の `MeshStandardMaterial` とパラメータ対応が素直で、
  乱数消費順を保ったまま 1:1 移植できた。個別マテリアル × N 個なので draw call は N に比例する
  （instancing はしていない＝three.js 版と同条件で比較）。
