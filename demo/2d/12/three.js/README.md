# テーマ12 フォーリングサンド / セルオートマトン ― three.js 版

砂・水・壁のセルが落下・堆積・流動する「フォーリングサンド」型のセルオートマトンを
**three.js (r184)** で実装。`COLS×ROWS` の格子をセル単位で更新し、**毎フレーム全面の RGBA
ピクセルバッファを生成して 1 枚のテクスチャへアップロード**、960×540 へニアレスト拡大表示する。
ベンチの核は「**グリッド解像度（セル数）＝ 1 フレームあたりのセル更新数 ＋ テクスチャ転送量**」。

正準リファレンスは `../PixiJS/game.js`。シミュレーション規則・定数・色は全エンジンで同一。

## 起動方法

画像は使わないが、**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**。
ローカルに HTTP サーバを立てて開く。

```bash
# このフォルダ(12/three.js/)の1つ上(12/)で実行
cd c:/work/claude/local-works/web-game/12
python -m http.server 8000
# → http://localhost:8000/three.js/ を開く
```

**アセットは不要**（セルの色はコードで定義し、毎フレーム生成する）。

## 使用バージョン

- three.js **r184**（CDN: `https://unpkg.com/three@0.184.0/build/three.module.js`、
  `index.html` の importmap で `three` を解決）。レンダラは **WebGLRenderer**。
- `index.html` + `game.js`（`type="module"`）の2ファイル構成。

## 使ったテクスチャ更新機構（本テーマの肝）

**`DataTexture + needsUpdate`**

1. グリッドサイズ `COLS×ROWS` の **`THREE.DataTexture`（RGBA・`UnsignedByteType`）** を 1 枚用意。
   バッキングは `Uint8Array(COLS×ROWS×4)`。
2. 毎フレーム、その **`image.data`（= `texture.image.data` の `Uint8Array`）** へ全セルの色を
   直書きする（砂色/水色/壁色/背景色 ＋ 決定的な濃淡）。
3. **`texture.needsUpdate = true`** をセットすると、次の描画時に three.js が `texImage2D` で
   GPU へ再アップロードする（測定対象）。
4. フィルタは `magFilter / minFilter = NearestFilter`、`generateMipmaps = false`（拡大時に
   ドットがくっきり）。
5. 全画面の `PlaneGeometry(960, 540)` にこのテクスチャを `MeshBasicMaterial.map` で貼り、
   `OrthographicCamera(0, W, H, 0)` でちょうど画面いっぱいに拡大表示する。

→ 「**`COLS×ROWS×4` バイトの RGBA を毎フレーム生成 ＋ GPU 転送**」が、まさに測られるコスト。
HUD の `Upload` 行に機構名と 1 フレームあたりの転送量（KB）を表示している。

**座標系の注意**: `DataTexture` は最下行が UV の `v=0`（下端）に対応する。本シムは「行 y=0 が
上端」なので、書き込み時に**行を上下反転**して画面の上下とシムの上下を一致させている。

## 操作

| 入力 | 動作 |
|---|---|
| 左ドラッグ | 現在のブラシ素材を描き込む（円形・半径3セル） |
| 右ドラッグ | 消去（empty で塗る・`contextmenu` は抑止） |
| `1` / `2` / `3` | ブラシ素材を 砂 / 水 / 壁 に切替 |
| `+` / `-`（テンキー可） | グリッド解像度 `COLS` を ±40（下限80・上限640・決定的に再構築） |
| `C` | 全消去（構造を消す。エミッタは毎フレーム供給され続ける） |
| `R` | リセット（決定的初期状態へ） |

## 仕様数値（全エンジン共通）

- キャンバス **960×540** 固定。グリッド **COLS×ROWS**（`ROWS = round(COLS×540/960)`）。
- `COLS` 初期 **160**（→ ROWS=90, 14400 セル）。`+/-` で **±40**（**80**〜**640**）。
- セル素材: `0=空気 / 1=砂 / 2=水 / 3=壁`。**場外は壁扱い**（落下が端で止まる）。
- 素材色（SPEC 基準）: 砂 `#d9c067` 系・水 `#3a7bd5` 系・壁 `#888`・空気 `#0b0d12`。
- 時間はデルタタイム基準だが、**シミュレーションは固定タイムステップ**（毎フレーム1ステップ）。

## シミュレーション規則（決定的・`Math.random` 不使用）

- **走査順**: 下の行から上へ。各行は左右交互スキャン（行の偶奇 ＋ フレーム位相で反転）。
  乱択は **`mulberry32`** で決定的に行う。
- **砂(sand)**: 真下が空なら落下。真下が水なら入れ替えて沈む。塞がれていれば左下・右下。
- **水(water)**: 真下が空なら落下。塞がれていれば左下・右下、それも塞がれていれば左右へ広がる。
- **壁(wall)** / **空気(empty)**: 不動。
- **エミッタ**: 上部に4個（砂2・水2）を COLS への比率で決定的配置し、毎フレーム少量供給する。

## HUD（HTMLオーバーレイ `#hud`・約120msごと更新）

- `FPS`（直近60フレームの移動平均）
- `Grid`（`COLS x ROWS = セル数`）
- `Active`（空気以外のセル数）＋ `moved/frame`
- `Brush`（sand/water/wall）
- `Upload`（`DataTexture + needsUpdate` ＋ 転送量 KB/frame）

## 実装メモ

- **2D 化の肝**: `OrthographicCamera(0, W, H, 0, -1000, 1000)`（1ワールド単位=1px、原点左下）。
  板は画面中央 `(W/2, H/2)` に置く。`renderer.setPixelRatio(1)` で DPR=1 固定（性能比較用）。
- **グリッド表現**: 素材は flat な `Uint8Array`、濃淡は `Int8Array tint[]`。移動時に素材と一緒に運ぶ。
- **解像度変更**: `setSize(cols)` で状態を決定的に再構築し、`DataTexture` を作り直して
  `material.map` を差し替える（旧テクスチャは `dispose()`）。
- **ループ**: `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発を抑制）。
- **入力**: `renderer.domElement` の pointer events。`getBoundingClientRect()` で CSS 縮小ぶんを
  比率換算してセル座標へ。ドラッグは線分補間。右ボタンは消去、`contextmenu` は抑止。

## Codex 生成所感

- three.js 自体の API は AI が安定して書けるが、本テーマの肝は **動的テクスチャ**。`DataTexture`
  にバッキング `Uint8Array` を渡し、毎フレーム中身を書き換えて `needsUpdate = true` を立てる、
  という最小経路が最も率直。Pixi の `source.update()` 相当が three.js では `needsUpdate` フラグ。
- 罠は ① `DataTexture` の **上下（v=0 が下端）** で、素直に書くと砂が天井から湧くように見える
  （本実装は書き込み時に行を反転）。② **ESM / importmap 必須**（r150 以降の UMD グローバル廃止）。
  ③ ニアレスト拡大には `magFilter`/`minFilter` の両方を `NearestFilter` にし `generateMipmaps`
  を切る必要がある。これらを明示しないと AI は古い書き方やデフォルトの線形補間に流れやすい。
- コストの所在は「`image.data` への RGBA 直書きループ」＋「`needsUpdate` 時の `texImage2D` 転送」。
  ドローコールは板 1 枚ぶんで、描画より「生成＋転送」が律速になる点は他エンジンと同様。
