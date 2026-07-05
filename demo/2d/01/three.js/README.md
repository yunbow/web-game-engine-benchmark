# 弾幕STG — three.js 版

テーマ1共通仕様（縦スクロール弾幕STG・性能比較用）の **three.js** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`1/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 1
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- 移動: 矢印キー / WASD（8方向・画面内クランプ）
- 発射: オート連射（150ms ごと、上方向 600px/s）
- `+` / `-`（テンキー +/- も可）: 同時最大敵数を ±10（上限300）

## 実装メモ
- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、原点左下・Y上向き）。
- ゲームロジックは**画面座標（Y 下向き・他エンジンと同一定数）のまま**保持し、描画同期時のみ `worldY = H - gameY` に変換。これでテクスチャの上下が崩れない。
- スプライトは **`THREE.Sprite`（常にカメラを向く板）**。重ね順は `renderOrder`（bg<enemy<bullet<fx<player）、`depthTest:false` で z-fight 回避。
- アセットは `TextureLoader.loadAsync` を個別 try/catch。失敗時は 2D canvas に図形を描いて `CanvasTexture` 化（`NearestFilter`）。
- 背景は `THREE.Points` のスターフィールド、bg画像があれば 2 枚の Plane を縦ループ。
- ループは `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発を抑制）。
- 当たり判定は SPEC 準拠の自前円判定（平方距離比較）。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- 訓練データは最大級で、three.js 自体の API は AI が安定して書ける。3D の素直なサンプルは特に強い。
- 罠は **「2D ゲームとしての足場」**: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転・カリング欠落）。② r150 前後以降の **ESM 化 / importmap 必須**（旧 `THREE.` UMD グローバル前提のコードを書きがち）。③ 大量スプライトでは `material`/`texture` の `dispose()` を怠るとリーク。これらを明示しないと AI は古い書き方に流れやすい。
