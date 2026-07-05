# 3D テーマ8（T8）― PBR マテリアル + ポストプロセス(Bloom) / PlayCanvas

three.js リファレンス実装（`../three.js/`）を PlayCanvas へ「同一仕様」で移植したもの。
仕様の唯一の正は `../SPEC.md`。多数の PBR 球を環境反射＋Bloom 付きで描画し、球数を主軸に性能を比較する。

## 起動方法

`file://` 直開きは不可（CORS で `../assets/` が読めない）。テーマフォルダをルートに HTTP サーバを立てる:

```bash
cd 3d/08
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

画像（`../assets/env_equirect.png`）が未配置でも、ambient + 2平行光のフォールバックで起動する。

## 操作

- `+` / `-`（`]` / `[`）: PBR 球数 N の増減（±100、min 50 / max 2000）。**比較の主軸**。
- `R`: 球数を初期値（200）に戻す。
- カメラは自動周回（無人ベンチ可）。

## 使用バージョン

- PlayCanvas **2.7.x**（CDN: `https://code.playcanvas.com/playcanvas-stable.min.js`、グローバル `pc`）。
- WebGL2 明示（`deviceTypes: [pc.DEVICETYPE_WEBGL2]`）、960x540 固定（`RESOLUTION_FIXED`）。

## 実装メモ（PBR / Bloom / 環境 / IIFE 隔離）

### PBR: StandardMaterial（metalness ワークフロー）
- 共有球メッシュ `pc.createSphere({radius:0.7})` を全球で共有し、`incRefCount()` で永続化
  （球 Entity を作り直しても破棄されないようにする）。
- 各球は固有の `pc.StandardMaterial`:
  - `useMetalness = true`（物理ベース）、`metalness`（半分は 1.0、残りは 0..1）。
  - three.js の `roughness` に対応するのは PlayCanvas の `gloss`（0..1）で、**`gloss = 1 - roughness`** に変換。
  - `diffuse` = 決定的 HSL（`setHSL(rnd(),0.7,0.5)` を three.js と同じ式・同順で再現）。
  - 約 15% の球は `emissive`（`setHSL(rnd(),0.9,0.6)`）＋ `emissiveIntensity = 2.0` で発光させ、Bloom で光らせる。
- 乱数は `mulberry32(seed=0x9e3779b9)`。**three.js 版と完全に同じ順序**で消費するため、配置・色・発光が一致する
  （HSL 変換も three.js の `Color.setHSL` と同式を移植）。立方格子 `k=ceil(cbrt(N))`・間隔 2.2・中心揃え。

### Bloom: pc.CameraFrame（engine-only で実現できた）
PlayCanvas 2.x はポストエフェクトを **`pc.CameraFrame`**（内部で `RenderPassCameraFrame` /
`RenderPassBloom` 等を構成）に統合しており、**posteffect スクリプトファイル無し・engine CDN のみ**で Bloom を有効化できる。

```js
const cf = new pc.CameraFrame(app, camEntity.camera);
cf.rendering.toneMapping = pc.TONEMAP_ACES; // ACES Filmic
cf.rendering.samples = 4;                   // MSAA（簡易AA）
cf.bloom.intensity = 0.04;                  // 発光部のみ滲ませる
cf.bloom.blurLevel = 16;
cf.update();                                // ★ 設定変更後は update() 必須
```

- `bloom.intensity > 0` で Bloom が有効になる（既定は 0 = 無効）。HDR の明るい部分（emissive 球）が滲んで光る。
- **トーンマッピングは `CameraFrame.rendering.toneMapping = pc.TONEMAP_ACES`（=3）** で ACES Filmic。
  SPEC の「ACES Filmic」を満たす。
- 旧来の `pc.PostEffectQueue` + 個別 posteffect スクリプト（別ファイル）方式は使っていない。`CameraFrame` 一本で完結する。
- HUD の `Post` は `bloom`（CameraFrame が使えない環境ではフォールバックで `none` を表示し、emissive を明るくして擬似グローにとどめる）。

### 環境（反射）
- 任意 `../assets/env_equirect.png`（equirectangular 2:1）があれば、`pc.Texture(projection: EQUIRECT)` に読み込み
  **`pc.EnvLighting.generateAtlas()` で envAtlas 化**して `app.scene.envAtlas` に設定（金属球に反射が出る）。
  このとき `ambientLight` を弱め、`skyboxIntensity` を 0.5 にして白飛びを抑える。
- 画像が無ければ **`app.scene.ambientLight`（弱め）＋ directional 2灯** のフォールバックで起動。
  背景クリアカラーは `#1a1f2a`。directional は forward(-Z) が光の進行方向なので、three.js の
  `light.position` から原点を照らす向き（`lookAt(-pos)`）に合わせている。

### IIFE 隔離（重要）
- `index.html` は `game.js` を **classic script**（`type="module"` ではない）で読み込む。複数の classic script や
  ホットリロードでトップレベル `let`/`const` が衝突し `Identifier 't' has already been declared` を起こす罠がある
  （3d/05 で実際に発生、`node --check` では検出されない）。これを避けるため **`game.js` 全体を IIFE
  `(function(){ ... })();` で包んで**いる。

## HUD（共通仕様）
左上 HTML オーバーレイに `FPS`(移動平均) / `Objects`(=N) / `Spheres`(=N) /
`Draws`(`app.stats.drawCalls.total`) / `Tris`(共有球面数×N の概算) / `Post`(bloom|none)。数フレームに1回更新。

## AI 生成所感
- PlayCanvas は three.js と座標系（Y上・右手）が同じで、カメラ/ライト/PBR の概念対応も素直。最大の翻訳ポイントは
  **roughness → gloss(=1-roughness)** と、Bloom の実現方法の調査だった。
- Bloom は当初「engine-only では posteffect スクリプト依存で難しいのでは」と懸念したが、2.x の `pc.CameraFrame` が
  Bloom/ACES トーンマップ/MSAA を**外部スクリプトファイル無しで**まとめて提供しており、CDN のみで成立した。
  `update()` の呼び忘れだけ注意。
- 環境反射は equirect → `EnvLighting.generateAtlas` が定石。画像任意・フォールバック起動の二系統を維持。
- このテーマはインスタンシングを使わず**球ごとに固有マテリアル＋個別 Entity**（PBR パラメータが球ごとに違うため）。
  そのぶん draw call は球数ぶん出るので、まさに「PBR マテリアル描画数 × Bloom コスト」を測る比較軸になっている。
