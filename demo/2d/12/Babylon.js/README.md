# テーマ12: フォーリングサンド / セルオートマトン（動的テクスチャ書き換え）― Babylon.js 版

砂・水・壁などのセルが落下・堆積・流動する「フォーリングサンド」型セルオートマトンを
**Babylon.js** で実装したもの。2Dエンジンではないため、**正射影(Orthographic)カメラ +
画面いっぱいの Plane + 毎フレーム更新する RawTexture** で 2D ピクセルシミュレーションを提示する。

本テーマの計測軸はテーマ1〜11と異なり「スプライト/図形を描く速度」ではなく、
**毎フレームの全面テクスチャ書き換え（CPU ピクセルバッファ生成 → GPU アップロード）＋
セル格子のシミュレーション更新**のスループット。Babylon は「2D ピクセルの提示係」に徹し、
`COLS×ROWS` のセル格子の RGBA を 1 本の `Uint8Array` に書いて **`RawTexture.update()`** で
丸ごと転送するコストがそのまま測定される。

## 起動方法

**本テーマはアセット不要**（セルの色はコードで定義し毎フレーム生成する）。
CDN を読むため、ローカルHTTPサーバ経由でもファイルを直接開いても起動する。

```bash
cd c:/work/claude/local-works/web-game/12
python -m http.server 8000
# ブラウザで http://localhost:8000/Babylon.js/ を開く
```

または VS Code の Live Server などでも可。`file://` で直接開いても CDN さえ届けば動く。

## 使用バージョン

- Babylon.js: CDN 最新版 (`https://cdn.babylonjs.com/babylon.js`)
- 追加ビルド・依存なし。`index.html` + `game.js` の2ファイルのみ。アセット無し。

## 操作

| 操作 | 動作 |
|---|---|
| 左ドラッグ | 現在のブラシ素材を描き込む（半径3セル） |
| 右ドラッグ | 消去（empty で塗る） |
| `1` / `2` / `3` | ブラシ素材を 砂 / 水 / 壁 に切替 |
| `+` / `-` | グリッド解像度 (COLS) を ±40（下限80・上限640） |
| `C` | 全消去（エミッタは残るので次フレームから再供給） |
| `R` | リセット（決定的初期状態へ） |

## 仕様準拠（数値）

- キャンバス **960x540** 固定。グリッドは **COLS 列 × ROWS 行**（`ROWS = round(COLS*540/960)`）。
- COLS 初期 **160**（→ ROWS=90, 14400 セル）。`+`/`-` で **±40**（下限 **80** / 上限 **640** → ROWS=360, 230400 セル）。
- セル素材: `0=空気(empty)` / `1=砂(sand)` / `2=水(water)` / `3=壁(wall, 不動)`。
- 色（SPEC 基準）: 空気 `#0b0d12` / 壁 `#888` / 砂 `#d9c067` 系の濃淡 / 水 `#3a7bd5` 系の濃淡。
  砂・水はセル毎に **決定的な濃淡**（固定シードの mulberry32 で生成した shade 値）を付ける。
- **シミュレーションは固定タイムステップ**（毎フレーム1ステップ更新）。`Math.random` 不使用。
- エミッタ: 上部に **5個**を比率位置（0.18 / 0.38 / 0.55 / 0.72 / 0.86）で決定的配置し、
  砂/水を毎フレーム少量供給。マウス無しでも常にセルが動くのでベンチが安定する。
- リセット時の決定的初期状態: 底に砂の堆積、中央に壁の棚＋左右の縦壁（固定シード）。

## シミュレーション規則（決定的）

- **走査順**: 下の行から上へ。各行は「行＋フレームパリティ」で**左右交互スキャン**にして偏りを抑える。
  左右どちらへ動くかの選択も `(c+r+frameParity)` のパリティで決定的に決める。
- **砂(sand)**: 真下が空/水なら落下。塞がれていれば左下・右下（決定的選択）。水とは入れ替わる（砂が沈む）。
- **水(water)**: 真下が空なら落下。塞がれていれば左下・右下、それも塞がれていれば左右へ広がる（決定的順）。
- **壁(wall)**: 不動。
- 場外（グリッド外）は壁扱い（落下が下端で止まる）。

## HUD（HTMLオーバーレイ, 約0.1s更新）

- `FPS`（指数移動平均）
- `Grid`（`COLS x ROWS = セル数`）
- `Active`（空気以外のセル数）
- `Brush`（現在のブラシ素材: sand / water / wall）
- `Upload`（使ったテクスチャ更新機構と転送量: `RawTexture.update (COLSxROWSx4 = N bytes/frame)`）

## 実装メモ ― RawTexture.update による全面アップロード + 正射影2D 提示

- **テクスチャ更新機構 = `BABYLON.RawTexture` + `update()`**。
  `new BABYLON.RawTexture(pixels, COLS, ROWS, BABYLON.Engine.TEXTUREFORMAT_RGBA, scene, false, false,
  BABYLON.Texture.NEAREST_SAMPLINGMODE)` で RGBA テクスチャを作り、毎フレーム
  `tex.update(pixels)` で **flat な `Uint8Array`（COLS×ROWS×4 バイト）を丸ごと GPU へ転送**する。
  この「全セル → RGBA バイト書き込み + 1回の `update`」が本テーマの計測対象コスト。
  `DynamicTexture`（`getContext().putImageData` + `update()`）でも実現できるが、ImageData/Canvas を
  経由せず**バイト列を直接アップロードできる** RawTexture の方が素直で速いため、こちらを採用した。
- **NEAREST サンプリング**でドットがくっきり拡大される（補間なし）。`image-rendering: pixelated` も併用。
- **正射影カメラで 2D 画面を再現**：`orthoLeft/Right/Top/Bottom` を `0..960 / 0..540`
  （`orthoTop < orthoBottom` で y 下向き）に設定し、画面 px = ワールド px を 1:1 対応させる。
  1x1 の `Plane` を 960x540 へ scaling し画面中央に置いて、テクスチャを **emissive**（`disableLighting=true`
  の unlit マテリアル）に貼って提示する。
- **UV の上下反転対応**：Babylon の Plane UV は下が 0 なので、ピクセル書き込み時に
  テクスチャ行を `texRow = ROWS-1-r` と反転して格納し「セル(0,0)=画面左上」に一致させている
  （`invertY=false` のまま書き込み側で吸収）。
- **recreate-on-resize**：`RawTexture` はサイズ固定なので、`+`/`-` で COLS/ROWS が変わるたびに
  旧テクスチャを `dispose()` し、新しいサイズで `cells / shade / pixels / RawTexture` をまとめて
  作り直す（`buildGrid()`）。エミッタは**比率位置**で再配置し、状態は決定的に作り直す。
- **データ構造**：`cells`（素材）/`shade`（濃淡）/`pixels`（RGBA）はいずれも **flat な
  `Uint8Array`**。セル入れ替えは `swapCells()` で素材と濃淡を同時に動かす。場外参照は `getCell()` が
  壁を返すので境界チェックが規則側に漏れない。

## Codex 生成所感 ― Babylon で動的テクスチャ書き換えベンチを書く

- **Babylon は 3D エンジンだが、本テーマでは「テクスチャ提示係」に徹するのが素直**。
  正射影 Plane + RawTexture という最小構成で、ロジックは終始 CPU 側の `Uint8Array` 操作に集約できた。
  スプライト/メッシュ描画ではなく `update()` 1本のアップロードに負荷が乗るので、エンジン間で
  「動的テクスチャ転送の素直な実装」を横並び比較できる。
- **RawTexture か DynamicTexture か**が選択の肝。DynamicTexture は 2D Canvas を内部に持ち
  `putImageData → update` という Canvas 経由になるが、RawTexture はバイト列を直接渡せる分
  中間コピーが少ない。SPEC も RawTexture を推しており、ベンチの主旨（CPU バッファ→GPU 転送の素の速度）
  にも合うため採用した。
- **サイズ固定テクスチャの作り直し**が解像度ベンチの所での注意点。COLS を変える＝テクスチャの寸法が
  変わるので、`dispose()`→新規生成が必須。Phaser の CanvasTexture を resize する場合と異なり、
  Babylon では明示的に作り直す。
- **UV の向き**だけ一手間。Plane のデフォルト UV は下原点なので、書き込み行を反転して
  「セル(0,0)=画面左上」を保った。`invertY=true` で生成しても良いが、書き込み側で吸収する方が
  ピクセルバッファのレイアウトを把握しやすかった。
- 総じて、Babylon は「正射影 Plane + RawTexture.update」で動的ピクセルベンチを素直に書けた。
  解像度を 640（230400 セル）まで上げると、セル更新コストと毎フレーム 920KB のテクスチャ転送が
  両方効いてきて、本テーマの計測軸（更新数＋転送量）がはっきり出る。
