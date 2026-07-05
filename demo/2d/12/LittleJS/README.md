# テーマ12 フォーリングサンド / セルオートマトン ― LittleJS 版

砂・水・壁のセルが落下・堆積・流動する「フォーリングサンド」型セルオートマトンを
**LittleJS** で実装したもの。`COLS x ROWS` のフラット格子を毎フレーム決定的に更新し、
**全セルの RGBA を ImageData へ書き込み → オフスクリーン canvas → `mainContext` へ拡大 blit**
することで、「**格子シミュレーション更新 ＋ 毎フレーム全面テクスチャ書き換え/アップロード**」の
スループットを測る。テーマ1〜11 では誰も計測していなかった「動的テクスチャ生成・転送」軸を埋める。

## 起動方法

CDN 読込のため `file://` で直接開いても動くが、ブラウザのキャッシュ挙動を安定させるため
簡易 HTTP サーバ経由を推奨。

```bash
# このフォルダ (12/LittleJS) で
python -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く
```

本テーマは**アセット不要**（セルの色はコードで定義し、毎フレーム生成する）。`../assets/` は空でよい。

## 使用バージョン / CDN

- **LittleJS**（`@latest` 解決時点 / classic global build）
- 主URL: `https://unpkg.com/littlejsengine`
  失敗時フォールバック: `https://cdn.jsdelivr.net/npm/littlejsengine/dist/littlejs.min.js`
- 素の unpkg は classic global build（グローバル `engineInit` 等を生やす版）を解決するため
  `<script>` 直読みできる。読込失敗時のみ `error` イベントを捕捉して jsDelivr ミラーへ切替。

## 操作

- **左ドラッグ**: 現在のブラシ素材を描き込む（ブラシ半径 3 セル）。
- **右ドラッグ**: 消去（empty で塗る。右クリックメニューは抑制）。
- **1 / 2 / 3**: ブラシ素材を 砂 / 水 / 壁 に切替。
- **+ / -**（メイン行 or テンキー）: グリッド解像度 `COLS` を ±40 増減（**性能比較の主軸**）。
- **C**: 全消去（器の壁・エミッタは残す）。 **R**: 決定的初期状態へリセット。

## 仕様数値（全エンジン共通）

| 項目 | 値 |
|---|---|
| キャンバス | 960 x 540 固定 |
| グリッド | COLS x ROWS（`ROWS = round(COLS*540/960)`）|
| COLS 初期 / 刻み / 範囲 | 160（ROWS=90, 14400 セル）/ ±40 / 80..640 |
| セル素材 | 0=空気 / 1=砂 / 2=水 / 3=壁(不動) |
| 走査順 | 下の行→上、行ごと＋フレームごとに左右交互（決定的・`Math.random` 不使用）|
| 砂 | 真下が空/水で落下（水と入替＝砂が沈む）、塞がれば左下/右下（決定的）|
| 水 | 真下が空で落下、塞がれば左下/右下、さらに塞がれば左右へ拡散（決定的順）|
| 壁 | 不動。場外（グリッド外）は壁扱い |
| エミッタ | 上部に列比率固定で 5 個（砂/水交互）。無入力でも常時供給 |
| 色 | 砂 `#d9c067`系の濃淡 / 水 `#3a7bd5`系 / 壁 `#888` / 空気 `#0b0d12` |

## HUD（常時表示・左上, HTML `#hud` overlay）

- `FPS`: 実測の移動平均（エンジン `frameRate` を指数移動平均で平滑化）。
- `Grid`: `COLS x ROWS = セル数`。
- `Active`: 空気以外のセル数（括弧内に当該フレームで移動したセル数 `moved`）。
- `Brush`: 現在のブラシ素材（sand / water / wall）。
- `Upload`: 使ったテクスチャ更新機構 = `ImageData→offscreen canvas→drawImage(mainContext, nearest)`。

## 実装メモ

### テクスチャ更新機構（＝計測の核・LittleJS の素直な選択）
LittleJS は薄い 2D/WebGL エンジンで、tile アトラス機構はあるが「毎フレーム全面を書き換える
動的テクスチャ」には**オフスクリーン canvas を直に blit する**のが最も素直。本実装はこの経路を採った。

1. **ImageData 全画素書き込み** (`writeTexture`): `COLS×ROWS` の `ImageData`（`Uint8ClampedArray`）
   へ全セルの RGBA を毎フレーム書く。alpha は不透明固定で RGB のみ更新。
   砂/水は別バッファ `tint`（決定的ノイズ）で濃淡を付ける。これが**主コスト**（セル数に比例）。
2. **オフスクリーン canvas へ putImageData**: サイズ `COLS×ROWS` の `<canvas>` に `putImageData`。
   このオフスクリーン canvas が「1 枚の動的テクスチャ」の実体。
3. **`mainContext` へ拡大 blit** (`gameRenderPost`): `mainContext.drawImage(offCanvas, 0,0,COLS,ROWS, 0,0,960,540)`
   で 960x540 へニアレスト拡大（`imageSmoothingEnabled = false`）。`mainContext` が無い版では
   `overlayContext` にフォールバック。**world 座標を一切経由せず canvas ピクセル左上原点に直描き**する。

機構ラベルは HUD の `Upload` 行・`game.js` 冒頭コメントにも明記している。

### 座標系 / Y軸（最重要・LittleJS の罠）
LittleJS の**ワールドは Y軸が上向き**だが、本シムは混乱を避けるため
**スクリーン空間ピクセル（左上原点・y 下向き）で完結**させた。

- 格子 `row 0 = 画面上端`、`row 増 = 下方向`。**重力は row 増方向**。
- 描画も `mainContext` へ直 blit するため world 座標を経由しない（canvas 左上原点）。
- **唯一 world 座標に触れるのがマウス位置**。これが main gotcha。
  - LittleJS の `mousePos` は **world 座標（y-up）**。そのまま row 添字にすると上下が反転する。
  - そこで **`mousePosScreen`（canvas ピクセル・左上原点・y 下向き＝本シムと同系）を優先**して使い、
    表示倍率 `VIEW_W/COLS`・`VIEW_H/ROWS` で割ってセル添字へ落とす（`mouseCell`）。
  - 古い版で `mousePosScreen` が無い場合に備え、`world(y-up) → screen(y-down)` の手動逆変換
    （`sy = VIEW_H/2 - (mousePos.y - cam.y)*scale`）をフォールバックで用意した。

### グリッド / シミュレーション
- **フラット `Uint8Array`**（`grid`, `idx = r*COLS + c`）で素材を保持。`moved` 同サイズで
  当該フレームの二重移動を防止。場外アクセスは `getCell` が `WALL` を返す（落下が下端で止まる）。
- **走査は決定的**: 下の行から上へ。各行は「フレームごと＋行ごとに左右反転」する交互スキャンで
  片寄りを抑える（`scanLeftToRight` をフレーム末でトグル）。`Math.random` は不使用。
- **砂**: 真下が空/水で落下（水とは `swap` ＝ 砂が沈む）。塞がれば `(c+r)` の偶奇で左下/右下を
  決定的に優先選択。**水**: 真下が空で落下→左下/右下→左右拡散の順（同じく決定的優先）。
- `swap` は素材と濃淡 `tint` を交換し、両セルを `moved` 済みにする。`movedCount` を HUD へ。

### エミッタ（無入力でもベンチが回る）
上部に**列比率固定**で 5 個（砂・水交互）。解像度変更時は比率で再配置（`buildEmitters`）。
吐き出し半幅は `COLS` に比例。毎フレーム空セルへ素材を供給するので、マウス無しでも常にセルが動き
ベンチが安定する。位置・素材は完全に決定的（シード・比率固定）。

### 解像度変更（負荷の主軸）
`+`/`-` で `COLS` を ±40。`rebuildGrid` が `ROWS = round(COLS*540/960)` を再計算し、
全バッファ・オフスクリーン canvas・`ImageData` を作り直し、`tint`・初期配置・エミッタを
**固定シードで決定的に再生成**する。上限 640（ROWS=360, 230400 セル）まで上げると、
**セル更新コスト**と**毎フレームのテクスチャ転送（COLS×ROWS×4 バイト）**の双方が効く。

### 決定的生成
`mulberry32`（`tint` は `0x12ABCD ^ COLS`、棚配置は `0x5EED ^ COLS` シード）。
`COLS` を含めてシードを作るので、各解像度ごとに見た目が再現可能。

## Codex 生成所感（動的テクスチャ書き換えを軽量エンジンで書く所感・罠）

- **LittleJS は「動的テクスチャ」用の薄い専用 API を持たない**ので、逆に
  `mainContext.drawImage(offscreenCanvas, ...)` という**最も素直な 2D 経路**がそのまま正解になった。
  Phaser の `CanvasTexture.refresh()` や Babylon の `RawTexture.update()` のような専用機構と違い、
  「ImageData→canvas→drawImage」の素の Canvas2D パイプラインがコスト構造として一番見通しが良い。
- **最大の罠は Y軸**。LittleJS ワールドは y-up なので、シムまで world に乗せると重力・落下・
  マウス描画の符号がすべて反転リスクを抱える。**シムをスクリーン空間（y-down）に閉じ込め、
  world に触れるのをマウス変換だけにした**ことで罠を 1 箇所へ局所化できた。`mousePosScreen`
  が使えるならそれを使い、無ければ world→screen を手動逆変換する二段構えにしている。
- **`gameRender` を空にして `gameRenderPost` で全面 blit** する構成が安定。`gameRender`（world 空間）
  に何も置かず、`gameRenderPost` で canvas ピクセル直描きするので、LittleJS の WebGL レイヤと
  競合せず HUD（HTML overlay）とも干渉しない。`imageSmoothingEnabled=false` を毎フレーム
  立て直すのを忘れるとドットがぼやけるので明示している。
- **コストの所在が HUD にそのまま出る**のがベンチ題材として良い。`Active`/`moved` でシム側の
  動き、`Grid` のセル数で転送量が見え、`COLS` を 160→640 へ上げると FPS が素直に下がる。
  セル更新（CPU 走査）とテクスチャ転送（ImageData 書込＋putImageData＋drawImage）の両方が
  セル数に比例するため、「動的テクスチャ書き換えスループット」を一軸で観測できる。
- **決定的性の維持**は他テーマ同様に重要。`Math.random` を排し、走査向き・エミッタ・濃淡・棚を
  すべて固定シード（COLS 込み）にしたので、解像度を変えても同じ初期状態から比較できる。
