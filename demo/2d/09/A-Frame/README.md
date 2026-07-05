# アイソメトリック都市/農場 — A-Frame 版

テーマ9共通仕様（アイソメトリック都市/農場・深度ソート性能比較用）の **A-Frame** 実装。
画像アセットが無くても canvas 図形（菱形タイル等）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`9/`)をルートに HTTP サーバを立てて開く。

```bash
cd 9
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- スクロール: 矢印キー / WASD（カメラをワールド内でクランプ）
- `+` / `-`（テンキー +/- も可）: 歩き回るユニット数を ±20（初期60・下限0・上限2000）
- `G`: グリッド線表示トグル
- `R`: リセット（マップ再生成・ユニット数を初期化）

## 画面・HUD
- キャンバス: **960 x 540**（固定、`setPixelRatio(1)` で DPR=1 固定）。
- HUD（HTML オーバーレイ）: `FPS` / `Tiles drawn`（可視地面タイル数）/ `Objects sorted`（深度ソートした可視オブジェクト＋ユニット数）/ `Units`（現在 / 設定値）/ カメラ中心ワールド座標 `(gx, gy)` / 操作ヒント。

## ★ 深度ソートの実現方法（A-Frame = THREE.Sprite.renderOrder）
A-Frame は three.js 上の宣言的フレームワークなので、深度機構は three.js 版と同じ **`Object3D.renderOrder`** を、登録コンポーネント内で使います:

- 各オブジェクト/ユニットを `THREE.Sprite`（マテリアル `depthTest:false`）で表現。
- 登録コンポーネント `iso-game` の **`tick` 内**で、可視ぶんの各スプライトへ **`sprite.renderOrder = 1 + (gx + gy)`** を毎フレーム代入。A-Frame 内蔵レンダラが renderOrder 昇順で描画し、「奥→手前」のアイソメ深度ソートになる（手動 `sort` 不要）。
- 地面は `renderOrder = 0` 固定（ソート対象外）。renderOrder 帯を 地面=0 / オブジェクト・ユニット=`1 + depth` で分け、2 層方式（SPEC 推奨）を表現。
- ユニットは連続座標のため `gx+gy` が毎フレーム変化 → 毎フレーム renderOrder を更新（比較の核）。

## 実装メモ（設計判断つき）
- **設計判断（重要）**: タイル/オブジェクト/ユニットは数百〜数千規模になり得る。「1 タイル = 1 `<a-entity>`」だと DOM/コンポーネント生成コストで FPS が破綻するため、**動的描画はコンポーネント内で `THREE.Sprite` を直接生成・プール管理**する（`this.el.object3D` に add）。`<a-entity>` はシーン宣言とコンポーネント登録の足場としてのみ使う。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0,-1000,1000)`** に維持（A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく `worldY = H - screenY` 変換。
- アイソメ投影は SPEC の式: `screenX=(gx-gy)*32`, `screenY=(gx+gy)*16`。スプライトは足元基準（地面 `center=(0.5,1)` / 木・家・ユニット `center=(0.5,0)`）。
- マップは `mulberry32` 固定シードで決定的生成（リファレンス PixiJS と同一手順）。`Math.random` 不使用。スプライトはプール再利用、`material.map` を張替。
- カリング: 画面四隅をグリッド座標へ逆投影し、外接矩形のタイル/オブジェクトのみ可視化。`tick(time, dtMs)` の dt は **ms 単位**。
- アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形 → `CanvasTexture`。

## Codex / AI コーディング所感
- HTML 宣言的なのでシーンの骨格は書きやすい一方、本テーマのような「大量2D・毎フレーム再ソート」は宣言的モデルと相性が悪い。
- 罠: ① 大量オブジェクトを素直に `<a-entity>` 化すると破綻（上記のとおり THREE 直管理が必要）。② 2D 用 ortho カメラは A-Frame 既定になく `sceneEl.camera` 差し替えという定石が要る。③ `tick` の dt は ms。④ 深度は three.js と同じ `renderOrder` + `depthTest:false` で実現できることを把握していないと、perspective カメラ前提で z 位置を弄りがち。
