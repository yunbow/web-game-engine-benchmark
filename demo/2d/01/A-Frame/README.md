# 弾幕STG — A-Frame 版

テーマ1共通仕様（縦スクロール弾幕STG・性能比較用）の **A-Frame** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`1/`)をルートに HTTP サーバを立てて開く。

```bash
cd 1
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- 移動: 矢印キー / WASD（8方向・画面内クランプ）
- 発射: オート連射（150ms ごと、上方向 600px/s）
- `+` / `-`（テンキー +/- も可）: 同時最大敵数を ±10（上限300）

## 実装メモ（設計判断つき）
- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に `<a-scene>` として宣言**し、ゲーム本体は登録した **`stg-game` コンポーネント**が駆動（A-Frame の renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断（重要）**: 弾・敵は数百規模になり得る。「1弾 = 1 `<a-entity>`」だと DOM/コンポーネント生成コストで FPS が破綻するため、**動的オブジェクトはコンポーネント内で `THREE.Sprite` を直接生成・管理**する（`this.el.object3D` に add）。これは A-Frame で大量2Dオブジェクトを扱う際の現実的な定石。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0)`** に維持（A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく `worldY = H - gameY` 変換。
- `renderer.setPixelRatio(1)` で性能比較の DPR を 1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。
- アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形 → `CanvasTexture`。当たり判定は SPEC 準拠の自前円判定。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- **HTML 宣言的**なのでシーンの骨格は AI が書きやすい。VR/3D の entity 配置サンプルは豊富。
- 罠は **「宣言的フレームワークで非宣言的な 2D アーケードを書く」**ミスマッチ: ① 大量オブジェクトを素直に `<a-entity>` で作ると破綻（上記のとおり THREE 直管理が必要）。② 2D 用 ortho カメラは A-Frame に既定がなく、`sceneEl.camera` 差し替えという定石を知らないと AI は perspective のまま実装しがち。③ `tick(time, dtMs)` の dt が **ms 単位**。AI を素直に走らせると「各弾を a-entity 化」して FPS を落としやすいので、**THREE 直描画の方針を明示指示**するのが鍵。
