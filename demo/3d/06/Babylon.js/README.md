# 3D テーマ6(T5) 動的シャドウ光源 — Babylon.js 版

three.js リファレンス実装を Babylon.js v8 へ「同一仕様」で移植したもの。柱 64 本の上を
N 個のスポットライトが周回し、各光源が 1024×1024 のシャドウマップ（`ShadowGenerator`）を
生成する。**比較の主軸 = 影付き光源の数 N**。数値は `../SPEC.md` が唯一の正。

## 起動方法

`file://` 直開きは不可ではないが（本テーマは画像アセット未使用のため CORS の制約は弱い）、
他テーマと揃えて HTTP サーバ経由を推奨。

```bash
cd 3d/06            # テーマフォルダをルートに
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

## 操作

- `+` / `-`（`]` / `[`）: 影付き光源数 N の増減（±2、最小 1 / 最大 12）。比較の主軸。
- `R`: 光源数を初期値 4 に戻す。
- カメラ固定・光源は自動周回（無人ベンチ可）。

## 使用バージョン

- Babylon.js: CDN `https://cdn.babylonjs.com/babylon.js`（グローバル `BABYLON`、最新安定 v8 系）。
- 描画: WebGL2（`new BABYLON.Engine(canvas, true, {antialias:true}, true)`）。

## シャドウマップ設定（このテーマの肝）

- **解像度 1024**: `new BABYLON.ShadowGenerator(1024, light)` を光源ごとに 1 つ作る。
- **複数光源**: スポットライト N 個それぞれに `ShadowGenerator` を持たせる。N を変える
  たびに全 `ShadowGenerator` / `SpotLight` を `dispose()` してから作り直す（位相
  `φ_i = i·2π/N` が N に依存するため）。
- **caster / receiver**:
  - 柱 64 本を各 `ShadowGenerator` の `addShadowCaster(pillar)` で影を落とす対象に登録。
  - 地面・柱とも `mesh.receiveShadows = true`（Babylon は **複数形** プロパティ。
    three.js の `receiveShadow`（単数）と綴りが違うので要注意）。
- **ソフト影**: `usePercentageCloserFiltering = true`（+ `filteringQuality = QUALITY_MEDIUM`）。
  three.js の `PCFSoftShadowMap` 相当。`useBlurExponentialShadowMap` でも可。
- **シャドウカメラ範囲**: スポットライトのシャドウは `light.shadowMinZ / shadowMaxZ`
  （= three.js の `shadow.camera.near/far` の 5 / 90）で制御。`bias = 0.0005`。

## つまずきメモ

- **座標系**: Babylon の既定は左手系。three.js（右手系・Y-up）と柱グリッド・光源周回
  `pos=(22cos, 30, 22sin)` をビット一致させるため `scene.useRightHandedSystem = true` に
  している。これを忘れると Z が反転して周回方向が逆になる。
- **スポット角の定義差**: three.js の `SpotLight` 第4引数は **半角**（リファレンスは
  `50°/2`）。Babylon の `SpotLight` の `angle` は **全角（円錐の開き全体）** なので、
  そのまま `50° = 50*Math.PI/180` を渡すと SPEC の「スポット角 ≈ 50°」に一致する。
- **`receiveShadow` vs `receiveShadows`**: Babylon は複数形。単数で書くと無効になり影が
  受からない。
- **HSV 色相の単位**: `BABYLON.Color3.FromHSV(h, s, v)` の `h` は **度（0〜360）**。
  three.js の `setHSL` は 0〜1 なので `hue=i/N` を `360*i/N` に換算している。
- **N 変更時のリーク**: `ShadowGenerator` は内部に RenderTarget（シャドウマップ）を持つ。
  作り直し時は `sg.dispose()` を先に呼んでから `light.dispose()` する。

## Draws がシャドウパスをどうカウントするか

HUD の `Draws` は `BABYLON.SceneInstrumentation` の `drawCallsCounter.current`。
**Babylon はシャドウマップ生成パス（光源ごとに 1 パス、caster を描画）も drawCalls に
計上する**ため、メインパスのみを数える three.js の `renderer.info.render.calls` よりも
大きい値になる。具体的には N を増やすと「シャドウパス × N」分の描画呼び出しが上乗せされる。
そのため `Draws` の絶対値はエンジン間で意味がずれる（SPEC の注記どおり）。
**影コストの主指標は FPS**：N を増やすとシャドウマップ生成が増えて FPS が落ちる。
`Tris` は概算値（地面 2 + 柱 12 面 × 64）で注記つき。

## AI 生成所感

three.js 版とロジック構造（定数・mulberry32・光源周回式・HUD 更新間隔）をそのまま写経でき、
描画レイヤだけ Babylon の `ShadowGenerator` へ差し替える形で素直に移植できた。罠は主に
「座標系（右手系）」「スポット角の半角/全角の定義差」「`receiveShadows` の複数形」「HSV の
度数表記」の 4 点。いずれも値の換算・綴りの問題で、ロジックの作り替えは不要だった。
影の見た目（柔らかさ・濃さ）はエンジンのフィルタ実装差で完全一致はしないが、SPEC の
パラメータ（1024・PCF・near/far・bias）を対応付けることで実用上同等にできている。
