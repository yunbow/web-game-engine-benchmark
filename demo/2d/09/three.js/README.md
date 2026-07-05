# アイソメトリック都市/農場 — three.js 版

テーマ9共通仕様（アイソメトリック都市/農場・深度ソート性能比較用）の **three.js** 実装。
画像アセットが無くても canvas 図形（菱形タイル等）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`9/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 9
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- スクロール: 矢印キー / WASD（カメラをワールド内でクランプ）
- `+` / `-`（テンキー +/- も可）: 歩き回るユニット数を ±20（初期60・下限0・上限2000）
- `G`: グリッド線表示トグル
- `R`: リセット（マップ再生成・ユニット数を初期化）

## 画面・HUD
- キャンバス: **960 x 540**（固定、`setPixelRatio(1)` で DPR=1 固定）。
- HUD（HTML オーバーレイ）: `FPS` / `Tiles drawn`（可視地面タイル数）/ `Objects sorted`（深度ソートした可視オブジェクト＋ユニット数）/ `Units`（現在 / 設定値）/ カメラ中心ワールド座標 `(gx, gy)` / 操作ヒント。

## ★ 深度ソートの実現方法（three.js = THREE.Sprite.renderOrder）
three.js の自然な z-order 機構 **`Object3D.renderOrder`** を使います:

- 各オブジェクト/ユニットは `THREE.Sprite`。マテリアルは **`depthTest:false`**。これにより深度バッファに依らず、レンダラが **`renderOrder` の昇順で描画**する。
- 毎フレーム、可視ぶんの各スプライトへ **`sprite.renderOrder = 1 + (gx + gy)`** を代入する。リファレンス PixiJS の深度キー `depth = gx + gy` をそのまま renderOrder に写すことで、three.js 内部のレンダリングソートが「奥→手前」のアイソメ深度ソートになる（手動 `sort` は不要）。
- 地面は高さ0で重ならないため `renderOrder = 0` 固定（ソート対象外）。`renderOrder` 帯を 地面=0 / オブジェクト・ユニット=`1 + depth` と分けることで 2 層方式（SPEC 推奨）を表現。
- ユニットは連続座標のため `gx+gy` が毎フレーム変化 → 毎フレーム renderOrder を更新（比較の核）。

## 実装メモ
- 2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px・原点左下・Y上向き）。ゲームロジックは画面座標（Y 下向き）で保持し、描画同期時に `worldY = H - screenY` 変換（テクスチャ上下が崩れない）。
- アイソメ投影は SPEC の式: `screenX=(gx-gy)*32`, `screenY=(gx+gy)*16`。
- スプライトは足元基準: 地面タイルは `center=(0.5, 1)`（上頂点基準）、木/家/ユニットは `center=(0.5, 0)`（下端中央＝足元基準）。
- マップは `mulberry32` 固定シードで決定的生成（リファレンス PixiJS と同一手順）。`Math.random` 不使用。
- スプライトはプール再利用（地面 2200 枚 / オブジェクト・ユニットは可変プール）。`material.map` を張り替えて使い回す。
- カリング: 画面四隅をグリッド座標へ逆投影し、外接矩形のタイル/オブジェクトのみ可視化。
- アセットは `TextureLoader.loadAsync` を個別 try/catch、失敗時は 2D canvas に菱形等を描いて `CanvasTexture` 化（`NearestFilter`）。

## Codex / AI コーディング所感
- 訓練データが最大級で API は安定。`renderOrder` + `depthTest:false` の組み合わせは「2D スプライトの重ね順」を素直に表現でき、本テーマの深度ソートと相性が良い。
- 罠: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転）。② r150 前後以降は **ESM / importmap 必須**。③ `depthTest` を切り忘れると半透明スプライトが z-fight する。④ 大量スプライトで `material`/`texture` を都度生成するとリーク → プール＋ `map` 張替で回避。
