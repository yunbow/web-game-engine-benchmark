# テーマ12 フォーリングサンド / セルオートマトン ― Phaser 4 版

砂・水・壁のセルが落下・堆積・流動する「フォーリングサンド」型のセルオートマトン。
`COLS×ROWS` のセル格子を毎フレーム CPU で更新し、**全セルの RGBA を 1 枚の RGBA バッファ
(ImageData) に書き込んで GPU テクスチャへアップロード** し、960x540 へニアレストネイバーで
拡大表示する。テーマ1〜11 が誰も計測していなかった **「毎フレーム全面テクスチャ書き換え + 転送」**
のスループットを測る比較用サンプル。

## 起動方法

ブラウザのセキュリティ制約(file:// での CORS)を避けるため、簡易 HTTP サーバ経由を推奨します。

```bash
# このフォルダ (12/Phaser4/) で
python -m http.server 8000
# → http://localhost:8000/ をブラウザで開く
```

または任意の静的サーバ(`npx serve` など)でも可。**本テーマはアセット不要**(セルの色は
コードで定義し毎フレーム生成するため、`assets/` は `.gitkeep` のみ)。

## 使用バージョン

- Phaser **4**(CDN: `https://cdn.jsdelivr.net/npm/phaser@4/dist/phaser.min.js`)
- 追加ライブラリなし。`index.html` + `game.js` のみ。
- 物理エンジン非使用(セルオートマトンの落下/流動を自前実装)。

## 操作

| 入力 | 動作 |
|---|---|
| 左ドラッグ | 現在のブラシ素材を描き込む(半径 3 セルの円形ブラシ) |
| 右ドラッグ | 消去(空気で塗る。コンテキストメニューは無効化済み) |
| `1` / `2` / `3` | ブラシ素材を 砂 / 水 / 壁 に切替 |
| `+` / `-`(テンキー可) | グリッド解像度 COLS を ±40 増減(性能比較の主軸) |
| `C` | 全消去(エミッタは残す) |
| `R` | リセット(決定的初期状態・解像度初期値へ) |

無入力でも上部の**決定的エミッタ 5 個**(砂3・水2)が毎フレーム少量を供給するため、
ベンチは常に動き続ける。

## 仕様数値表(全エンジン共通)

| 項目 | 値 |
|---|---|
| 画面 | 960 x 540(固定) |
| グリッド | COLS 列 × ROWS 行(`ROWS = round(COLS*540/960)`、表示は 960x540 へ拡大) |
| COLS 初期 / 増減 / 範囲 | 160(→ROWS 90, 14400 セル) / ±40 / 80〜640 |
| 上限 640 | → ROWS 360, 230400 セル(セル ≒1.5px 相当) |
| 素材 | 0=空気 / 1=砂 / 2=水 / 3=壁(不動) |
| 色 | 砂≈`#d9c067`(決定的濃淡16段) / 水≈`#3a7bd5` / 壁≈`#888` / 空気=`#0b0d12` |
| ブラシ半径 | 3 セル |
| シミュ | 固定 1 ステップ/フレーム |

## HUD

`setScrollFactor(0)` で固定し左上に常時表示(SPEC 指定の行を厳密に):

- `FPS`(実測・移動平均 30 サンプル)
- `Grid`(`COLS x ROWS = cells`)
- `Active`(空気以外のセル数)
- `Brush`(現在のブラシ素材 sand/water/wall)
- `Upload`(使ったテクスチャ更新機構 = `ImageData -> CanvasTexture`)
- 画面下に操作ヒント行。

## 実装メモ

### テクスチャ更新機構(本テーマの核): ImageData → CanvasTexture

- `this.textures.createCanvas('grid', COLS, ROWS)` で **CanvasTexture**(裏に `COLS×ROWS` の
  `<canvas>`)を生成。CPU 側ピクセルバッファは `ctx.createImageData(COLS, ROWS)` の
  `Uint8ClampedArray`(RGBA)。アルファは構築時に 255 で埋め、以後フレーム毎は RGB のみ更新。
- **毎フレーム** `uploadTexture()` で全セル(`cellCount` 個)を走査して `imageData.data` に
  RGB を書き込み、`texCtx.putImageData(imageData, 0, 0)` → `canvasTexture.refresh()` で
  GPU へ再アップロードする。`refresh()` がテクスチャの再アップロード(WebGL の
  texSubImage 相当)を担う。
- 表示は `this.add.image(...).setTexture('grid').setDisplaySize(960,540)` で全面拡大。
  ピクセル補間は **ニアレスト**:`canvasTexture.setFilter(Phaser.Textures.FilterMode.NEAREST)`
  を明示し、加えて game config の `pixelArt:true` でも既定フィルタを NEAREST にしている。
- **このループ(全セル RGBA 書き込み + putImageData + refresh)が計測対象のコスト**。
  解像度を 160→640 へ上げると、セル更新コストと転送量(`COLS×ROWS×4` バイト)の双方が
  線形〜超線形に効き、FPS が顕著に落ちる。160(14400 セル)→640(230400 セル)で
  セル数は 16 倍。

### セルオートマトン規則(決定的)

- 格子は **flat な `Uint8Array`**(素材 0..3)。砂の濃淡も別の `Uint8Array`(0..15)に flat 保持。
  オブジェクト配列を避け、走査とピクセル展開をキャッシュ効率良く回す。
- **走査順は決定的**:下の行から上へ。各行は `(行 + フレーム) のパリティ`で左右交互スキャンにし、
  片側に寄る偏りを抑える。`Math.random` は不使用。乱択が要る箇所(砂濃淡・エミッタ揺らぎ)は
  すべて `mulberry32` 製の決定的 PRNG。
- **砂**: 真下が空なら落下。真下が水なら入れ替え(砂が沈む)。塞がれていれば左下・右下へ
  (`(列+フレーム)` パリティで優先方向を決定的に切替)、その先が水なら入れ替え。
- **水**: 真下が空なら落下。塞がれていれば左下・右下、それも塞がれていれば左右へ広がる(決定的順)。
- **壁**: 不動。**グリッド外は壁扱い**(落下が下端で止まる)。
- **エミッタ**: 上部に相対位置固定の 5 個。毎フレーム上端直下に少量供給し、決定的 PRNG で
  ±1 セルだけ揺らして詰まりを緩和。砂エミッタは水の上にも積める(沈降を見せる)。

### 解像度変更・リセット(決定的に作り直し)

- `+`/`-` での COLS 変更時は `buildGrid()` を呼び直し、`Uint8Array` と CanvasTexture・ImageData を
  作り直す。エミッタは**列比率で再配置**するため解像度に依らず同じ相対位置に並ぶ。
- `C`(クリア)は `grid.fill(EMPTY)` のみでエミッタ定義は残す。`R`(リセット)は解像度初期値で
  `buildGrid()` を呼び直し、決定的初期状態へ戻す。

## Codex 生成所感(動的テクスチャ書き換えの実装しやすさ)

- **CanvasTexture が素直な選択**: Phaser には `createCanvas` → `getContext()` →
  `putImageData` → `refresh()` という明快な経路があり、「ImageData を毎フレーム全面差し替えて
  GPU 転送する」本テーマの要求にそのまま乗る。RawTexture 直叩きのような低レベル API を使わずに
  済むのが利点で、迷いなく実装できた。
- **NEAREST 拡大**: `pixelArt:true` に加えてテクスチャ個別に `setFilter(NEAREST)` を明示すれば
  ドットがくっきり拡大される。Image の `setDisplaySize(960,540)` で全面拡大も 1 行。
- **計測軸としての素直さ**: 計測したい「全セル書き込み + putImageData + refresh」が
  `uploadTexture()` 1 箇所に閉じており、Phaser 側の他処理(シーン描画は全面 Image 1 枚のみ)が
  ほぼゼロなので、CPU ピクセル生成 + 転送のコストが FPS にそのまま反映される。比較用途と好相性。
- **flat 配列**: セル格子・砂濃淡ともに `Uint8Array` で持ち、走査もインデックス計算のみ。
  Phaser の GameObject を 1 個(表示 Image)しか使わないため、エンジン側オーバーヘッドは最小。
- **入力**: `disableContextMenu()` + `pointerdown` の `rightButtonDown()` 判定で左=描画/右=消去を
  分離。`pointermove` でドラッグ追従し、画面座標→セル比率の換算 1 行で塗れる。
- 総じて Phaser 4 は「動的に生成したピクセルバッファを毎フレーム 1 枚のテクスチャへ流し込む」
  用途を、安定した API 名(createCanvas / putImageData / refresh / setFilter)で素直に書けた。
