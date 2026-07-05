# テーマ13 大量動的テキスト / UI 描画 ― LittleJS 版

「システムログ / データダッシュボード」風に、**多数のテキストラベルが画面内を流れ、
各ラベルの数値が刻々と更新される**デモを **LittleJS** で実装したもの。
`N` 個のテキストアイテムを**毎フレーム `drawTextScreen` で immediate(即時)描画**し、
「画面上のテキスト数」と「毎フレーム文字列を作り直すか否か(動的更新)」のコスト差を測る。

## 起動方法

CDN 読込のため `file://` で直接開いても動くが、`game.js` の相対参照と
ブラウザのキャッシュ挙動を安定させるため簡易 HTTP サーバ経由を推奨。

```bash
# このフォルダ (13/LittleJS) で
python -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く
```

本テーマは**アセット不要**（既定のシステムフォント = canvas の `arial`）。`engineInit` に
渡す `imageSources` は空配列で、画像が 1 枚も無くても起動する。

## 使用バージョン / CDN

- **LittleJS**（classic global build）
- 主URL: `https://unpkg.com/littlejsengine/dist/littlejs.min.js`
  失敗時フォールバック: `https://cdn.jsdelivr.net/npm/littlejsengine/dist/littlejs.min.js`
- **注意（テーマ5 から変えた点）**: 素の `https://unpkg.com/littlejsengine` は現行
  `package.json` の `main` が **ESM ビルド（`export{...}`）**を指すため、グローバル
  `engineInit` 等を生やさない。classic global build を `<script>` 直読みする本構成では
  動かないので、**`dist/littlejs.min.js` を明示指定**した（unpkg 主 / jsDelivr 従、
  `error` イベント捕捉でミラー切替という二段構えはテーマ5 と同じ）。

## 操作

- **+ / -**（メイン行 or テンキー）: **テキストアイテム数を ±100**（負荷調整・性能比較の主軸）。
- **U**: 文字列の**毎フレーム更新 ON/OFF** 切替（動的更新 ⇄ 静的）。
- **B**: 標準テキスト ⇄ ビットマップ系の切替 ― **本エンジンは未対応**（後述）。押しても無効。
- **R**: リセット（テキスト数 200・動的更新 ON・フレーム番号 0 に戻す）。

## 仕様数値（全エンジン共通）

| 項目 | 値 |
|---|---|
| キャンバス | 960 x 540 固定 |
| 背景 | 暗色 `#0b0d16` 相当（`setCanvasClearColor`）|
| テキスト数 N | 初期 200・±100・下限 0・上限 5000（決定的生成）|
| 文字列 | `"OBJ#0042 v=137"` 風・8〜20 文字・数値部が毎フレーム更新 |
| 動き | 下方向スクロール + 左右バウンド・画面外でラップ（スクリーン空間）|
| 統計パネル | 右上に複数行・毎フレーム更新 |

## HUD（常時表示・左上, HTML `#hud` overlay）

- `FPS`: 実測の移動平均（エンジン `frameRate` を指数移動平均で平滑化）。
- `Texts`: 現在のテキスト数 / 上限（`N / 5000`）。
- `Chars`: そのフレームの概算総グリフ数（全アイテムの文字列長合計）。
- `Render`: 使ったテキスト機構 = `drawTextScreen (canvas)`。
- `Update`: `dynamic`（毎フレーム文字列更新）/ `static`（キャッシュ再利用）。
- 画面下に操作ヒント行（+/- / U / B / R）。

## 実装メモ

### テキスト機構 ― immediate-mode（保持オブジェクトが無い）が最大の論点
LittleJS のテキストは **`drawTextScreen(text, posScreen, size, color, ...)`** による
**immediate（即時）描画**で、内部的には overlay canvas の 2D `context.fillText` を
毎回叩く。**「テキストオブジェクト」という保持(retained)型は存在しない**。

- 結果として、PixiJS の `PIXI.Text` や Phaser の `Text` のような
  「テキストのラスタライズ結果をテクスチャにキャッシュし、**文字列が変わらなければ
  再ラスタライズしない**」最適化は効かない。
- そのため **`fillText` のラスタライズコストは Update ON/OFF に関わらず “常に” 毎フレーム
  支払う**。Update ON/OFF が変えるのは **「文字列を毎フレーム組み立て直すか
  （文字列ビルドコスト）」だけ**。
- 本エンジンでの Update の意味:
  - **Update ON（dynamic）**: 毎フレーム `it.val` を再計算し、`label + '#' + idStr + ' v=' + val`
    を **String 連結で作り直す**（文字列ビルド＋`fillText`）。
  - **Update OFF（static）**: アイテムごとにキャッシュした `it.str` をそのまま使う
    （`fillText` のみ。`val` の変化は画面に出ない）。
  - どちらのモードでも `fillText` は全アイテム分走るので、**Canvas テキストの
    「描画オブジェクト数」の崖は両モードで観測でき**、ON ではさらに文字列ビルド分が上乗せ。

これは「retained 型テキストを持つエンジン（Pixi/Phaser/Babylon GUI）」との対比として
重要で、それらは Update OFF で大きく軽くなりがちだが、LittleJS は OFF でも fillText は
全て走るため**落ち方の傾きが両モードでほぼ同じ**になる、という観測ができる。

### 座標系 / Y軸（罠回避の肝）
LittleJS の**ワールドは Y軸が上向き**だが、**`drawTextScreen` は “スクリーン座標”** を取り、
スクリーン座標は通常の 2D と同じく **Y軸下向き**（左上原点・下 = Y大）。

- テキストの**位置・速度・ラップ・統計パネルの座標はすべてスクリーン空間（px, y-down）
  で保持**し、ワールド↔スクリーンの y 反転を一切挟まない。
- ワールド版 `drawText` を使うと y-up になり、移動・ラップ・パネル座標が上下逆転して
  混乱するため、本テーマは**スクリーン空間に統一**した。テーマ5（横スクロール物理で
  y-up を一貫させた）とは逆に、本テーマは**「テキストは素直にスクリーン空間」**が正解。
- 背景の暗色は `drawRectScreen`（このビルドには存在しない）ではなく
  **`setCanvasClearColor(BG_COLOR)`** で塗る（描画コスト 0）。

### 決定的生成（プール）
`mulberry32` の決定的乱数（`Math.random` 不使用）。アイテム `i` ごとに
`BASE_SEED + i*2654435761` でシードを派生させ、初期位置・速度・色・サイズ・ラベル・ID を決定。

- アイテムは**フラットな配列にプール**し、`+/-` では `syncItemCount()` が
  **不足分だけ決定的に生成 / 余剰は末尾を切る**だけ。既存アイテムは作り直さないので、
  200→300→200 と往復しても先頭 200 個の並びは不変（**増減しても配置が決定的**）。
- 数値部 `it.val` は `(valBase + frameNo + i*7) % 1000` で算出し、無入力でも回り続ける。

### 描画ループ
`gameRenderPost`（overlay canvas が描かれる段）で全アイテムを `drawTextScreen` で
左寄せ描画し、文字列長を `Chars` に集計。続けて右上の**複数行ライブ統計パネル**
（frame / items / rebuild / glyphs / avglen / mode）を `drawTextScreen` で右寄せ描画する
（多行の動的テキスト再レイアウトも踏ませる）。`gameRender`（ワールド描画段）は背景を
clear color に任せるため空。

### `B`（機構切替）を未対応にした理由
LittleJS には**標準で immediate-mode の `drawTextScreen`/`drawText` しか無く**、
Pixi の `BitmapText` のような別系統の retained ビットマップテキストが API として存在しない
（`FontImage` でアトラス自前描画はできるが、外部/動的フォントアセット前提になり SPEC の
「アセット不要」「内蔵/動的生成の範囲」を超える）。よって `B` は**無効**とし、
`Render` は常に `drawTextScreen (canvas)` を表示する。

## Codex 生成所感（軽量エンジンで大量テキストを書く所感・罠）

- **「テキストオブジェクトが無い」ことが本テーマでは効く**。テーマ1〜12 で HUD を
  `#hud` div に流していたのと同じく、LittleJS のテキストは結局 canvas2D の `fillText`
  そのもの。保持型が無いぶん「Update OFF で軽くなる」効果が薄く、**`fillText` の素の
  スループット**が FPS に直結する。retained 型エンジンとの差が一番出るのがこの軸だと分かった。
- **`drawRectScreen` が無い**のは盲点だった。スクリーン空間の塗りは存在せず、背景は
  `setCanvasClearColor` に寄せるのが素直。CDN のソースを実際に grep して確認した
  （`draw*Screen` 系は `drawTextScreen` / `drawNineSliceScreen` / `drawThreeSliceScreen` のみ）。
- **unpkg のデフォルト解決が ESM に変わっていた**のも実装中に判明。テーマ5 の HTML を
  そのまま使うと `engineInit` グローバルが生えず `game.js` が走らない。`dist/littlejs.min.js`
  を明示指定して classic global を確実に拾うよう直した（README に明記）。
- **Y軸は “テキストはスクリーン空間で素直に” が答え**。テーマ5 は地形物理で y-up を
  一貫させるのが肝だったが、本テーマは逆に `drawTextScreen` のスクリーン座標（y-down）に
  全状態を寄せ、ワールド↔スクリーン変換を一切持たないのが事故を防ぐ最短路だった。
- **決定的プールで `+/-` を安定比較**。候補をシードから派生させ、増減は末尾の伸縮だけに
  したので、N を振っても先頭の並びが固定され、FPS の素直な比較ができる。
- 総じて LittleJS は「薄い API を正しく組む」エンジンらしく、テキストも特別扱いせず
  canvas2D を毎フレーム叩くだけ。性能の所在（fillText の数 vs 文字列ビルドの有無）が
  HUD にそのまま出るのは、ベンチ題材として扱いやすかった。
