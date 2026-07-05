# トップダウン・サバイバー — A-Frame 版

テーマ2共通仕様（トップダウン・サバイバー・性能比較用）の **A-Frame** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`2/`)をルートに HTTP サーバを立てて開く。

```bash
cd 2
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- 移動: WASD / 矢印キー（8方向・速度 180px/s・正規化）
- 攻撃: **オート**（400ms ごとに最も近い敵へ弾速 350px/s で発射、命中で敵HP-1）
- `+` / `-`（テンキー +/- も可）: 敵スポーン上限を ±50（上限1000）
- GAME OVER 後: `R` でリスタート

## 実装メモ（設計判断つき）
- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に `<a-scene>` として宣言**し、ゲーム本体は登録した **`survivor-game` コンポーネント**が駆動（A-Frame の renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断（重要）**: 敵・弾・gem は数百規模になり得る。「1体 = 1 `<a-entity>`」だと DOM/コンポーネント生成コストで FPS が破綻するため、**動的オブジェクトはコンポーネント内で `THREE.Sprite` を直接生成・管理**（`this.el.object3D` に add）。大量2Dオブジェクトを扱う際の現実的な定石。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0)`** に維持（A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく `worldY = H - gameY` 変換。
- **カメラ追従**: 毎フレーム `cam.position` を平行移動して自機を画面中央に固定（`updateMatrixWorld()` を明示）。
- **地面**: `RepeatWrapping` の繰り返しテクスチャを貼った 1枚の大きな Plane を自機追従させ `texture.offset` でスクロール（1タイル=1メッシュにすると破綻するためドローコール 1）。
- 敵タイプ: 3割大型（zombie, HP3, r16）/ 7割小型（bat, HP1, r12）。撃破で gem ドロップ、自機接触で取得→Kill。自機HP初期5・無敵0.5s・0で GAME OVER。10秒ごと cap +25 自動増加。
- `renderer.setPixelRatio(1)` で性能比較の DPR を 1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。
- アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形 → `CanvasTexture`（gem は菱形）。敵・弾・gem は自前配列 + `rm()`（末尾スワップ + `material.dispose()`）。当たり判定は SPEC 準拠の自前円判定。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- **HTML 宣言的**なのでシーンの骨格は AI が書きやすい。VR/3D の entity 配置サンプルは豊富。
- 罠は **「宣言的フレームワークで非宣言的な 2D サバイバーを書く」**ミスマッチ: ① 大量オブジェクトを素直に `<a-entity>` 化すると破綻（THREE 直管理が必要）。② 2D 用 ortho カメラは A-Frame に既定がなく `sceneEl.camera` 差し替えという定石が要る。③ **カメラ追従**は `cam.position` スライドで実装（A-Frame の wasd-controls には乗せない）。④ `tick(time, dtMs)` の dt が **ms 単位**で、本テーマのゲーム定数は秒なので `dt = dtMs/1000` 変換が要る。⑤ 無限スクロール地面は `RepeatWrapping`+`offset` で 1枚に倒すのが鍵。
