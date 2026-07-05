# トップダウン・サバイバー — three.js 版

テーマ2共通仕様（トップダウン・サバイバー・性能比較用）の **three.js** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`2/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 2
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- 移動: WASD / 矢印キー（8方向・速度 180px/s・正規化）
- 攻撃: **オート**（400ms ごとに最も近い敵へ弾速 350px/s で発射、命中で敵HP-1）
- `+` / `-`（テンキー +/- も可）: 敵スポーン上限を ±50（上限1000）
- GAME OVER 後: `R` でリスタート

## 実装メモ
- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、原点左下・Y上向き）。
- ゲームロジックは**画面座標（Y 下向き・他エンジンと同一定数）のまま**保持し、描画同期時のみ `worldY = H - gameY` に変換。これでテクスチャの上下が崩れない。
- **カメラ追従**: 自機を画面中央に固定するため毎フレーム `camera.position` を平行移動（ortho は position 移動で可視窓がスライド）。`camera.updateMatrixWorld()` を明示。
- **地面**: 1タイル=1メッシュにすると無限スクロールで破綻するため、`RepeatWrapping` の繰り返しテクスチャを貼った 1枚の大きな Plane を自機に追従させ、`texture.offset` でスクロール表現（ドローコール 1）。
- スプライトは **`THREE.Sprite`（常にカメラを向く板）**。重ね順は `renderOrder`（ground<gem<enemy<proj<player）、`depthTest:false` で z-fight 回避。
- 敵タイプ: 3割大型（zombie, HP3, r16）/ 7割小型（bat, HP1, r12）。撃破で gem ドロップ、自機接触で取得→Kill。自機HP初期5・無敵0.5s・0で GAME OVER。10秒ごと cap +25 自動増加。
- アセットは `TextureLoader.loadAsync` を個別 try/catch。失敗時は 2D canvas に図形を描いて `CanvasTexture` 化（`NearestFilter`）。gem は菱形ポリゴンで描画。
- ループは `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発を抑制）。敵・弾・gem は自前配列 + `rm()`（末尾スワップ + `material.dispose()`）。当たり判定は SPEC 準拠の自前円判定。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- 訓練データは最大級で three.js 自体の API は AI が安定して書ける。
- 罠は **「2D サバイバーとしての足場」**: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転）。② **カメラ追従**を `camera.position` スライドで実装する発想（3D 慣れだと lookAt に流れがち）。③ **無限スクロール地面**を `RepeatWrapping`+`offset` 1枚で済ませる定石（タイルを大量メッシュ化すると数百体の敵と並んで破綻）。④ r150 前後以降の **ESM 化 / importmap 必須**。⑤ 大量スプライトの `material`/`texture` `dispose()` 漏れによるリーク。
