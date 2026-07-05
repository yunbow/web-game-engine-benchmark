# テーマ3 トップダウンRPG探索 ― LittleJS 版

見下ろし型RPGの探索パート（マップ歩行）を **LittleJS** で実装したもの。
100x100 タイル（3200x3200px）の決定的マップを、可視範囲のみカリング描画し、
カメラを自機追従させて広大なマップのスクロール描画性能を測る。

## 起動方法

CDN 読込のため、ローカルファイルを `file://` で直接開いても動くが、
`../assets/` の相対参照とブラウザのキャッシュ挙動を安定させるため
簡易HTTPサーバ経由を推奨。

```bash
# このフォルダ (3/LittleJS) で
python -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く
```

`assets/` フォルダは空でも起動する（画像欠落時は図形フォールバック）。
SPEC のアセット（`tile_grass.png` 等）を `../assets/` に置けば自動で使用される。

## 操作

- **WASD / 矢印キー**: 移動（4方向, 160px/s）。壁/水/木に衝突。
- **Shift**: ダッシュ（2倍速）。
- **+ / -**（メイン行 or テンキー）: 画面に配置する敵/NPC 数を 20 ずつ増減。

## HUD（常時表示・左上）

- `FPS`: 実測の移動平均（`performance.now()` 差分から自前算出）。
- `Tiles drawn`: そのフレームで実際に描画したタイル数（カリング後）。
- `Entities`: NPC+敵スライム+木 の合計。
- `Player tile (x, y)`: 自機のタイル座標。

## CDN / バージョン

- **LittleJS `1.18.19`**（`@latest` 解決時点）
- 読込URL:
  `https://cdn.jsdelivr.net/npm/littlejsengine@latest/dist/littlejs.min.js`
- **classic global build (`dist/littlejs.min.js`) を使うこと。**
  素の `https://unpkg.com/littlejsengine` は ESM（`export` 文付き）を返し、
  classic `<script>` で読むと `Unexpected token 'export'` で即死する。

## 実装メモ

- **起動**: `engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)`。
  `gameInit` で `setCanvasFixedSize(vec2(960,540))` と `setCameraScale(32)`、
  毎フレーム `gameUpdate` 末尾で `setCameraPos(player.pos)` してカメラ追従。
- **WebGL 無効化**: `engineInit` 前に `glEnable=false`（+ 念のため `setGLEnable(false)`）。
  WebGL を切ると `glCanvas` が消えて `mainCanvas` 一本になり、HUD（2D描画）が
  WebGL レイヤに隠される問題を根本回避できる。HUD は `gameRenderPost` 内で
  `mainContext` に直接描画（このタイミングで context 変換は単位行列に戻っている）。
- **座標系 / Y軸**: LittleJS は **Y軸が上向き**。タイル配列 row 0 を画面上に出すため、
  ワールドY = `(MAP_H-1 - ty)` としてマップを上下反転配置。
  入力も「上キー = +Y」に合わせている。1ワールド単位 = 1タイル。
- **マップ生成**: `mulberry32` の決定的乱数（固定シード 1337）。
  外周は壁、格子状の道（10タイル間隔）、散在する木/水＋円形の池。
  全エンジンで同じ見た目を狙う。`0=草 1=道 2=水 3=壁 4=木`、水/壁/木は進入不可。
- **カリング**: `gameRender` でカメラ中心 ± 画面半分（+余白）からタイル範囲を算出し、
  その矩形内のタイルだけ `drawTile`/`drawRect` する。木は高さ方向に余白を足して
  上端の見切れを防止。描画枚数を `Tiles drawn` に集計。
- **テクスチャ判定 / フォールバック**: `textureInfos[i].size.x > 0` で読込済みを判定。
  読込済みなら `tile(0, textureInfos[i].size, i)`（画像全体を1タイル参照）で `drawTile`、
  未読込なら `drawRect`（草=緑/道=茶/水=青/壁=灰/自機=白/NPC=黄/slime=緑）で描画。
  これで画像が1枚も無くても必ず起動する。
- **FPS 移動平均**: `gameRenderPost` で前フレームからの `performance.now()` 差分の
  逆数を指数移動平均（係数 0.92）。エンジン内蔵の FPS ではなく自前算出。
- **エンティティ**: 初期 60 体（スライム6割 / NPC4割）。各個体は数秒ごとに方向転換する
  簡易ランダム徘徊。壁にぶつかると反転。自機に接近するとノックバックを与える。
  `+`/`-` で目標数を変え、`syncEntityCount` で生成/破棄。

## Codex 生成所感（軽量エンジンでタイルマップ/カリングを書く所感・罠）

- **配布形態の罠が最大の関門**。LittleJS は ESM 版と classic global 版が同居しており、
  unpkg の素URLは ESM が返るため `<script>` 直読みで `Unexpected token 'export'`。
  README 通り `dist/littlejs.min.js` を明示しないと「ライブラリは正しいのに起動しない」
  という分かりにくい失敗をする。最初に必ずここを固定すべき。
- **WebGL レイヤと HUD の重なり**。LittleJS は既定で WebGL canvas を主描画に使い、
  その上に 2D canvas が乗る構成。自前 HUD を素朴に描くと WebGL 側に隠れて「FPS が出ない」。
  `glEnable=false` で 2D 一本化すると、描画パスが `drawCanvas2D` に切り替わり、
  HUD も `mainContext` に普通に描けるようになって一気に素直になる。
  軽量エンジンは「全部入り」ではない分、レイヤ構成を自分で理解して潰す必要がある。
- **Y軸上向きが地味に効く**。タイルマップは配列 row 0 を上に出すのが直感的だが、
  LittleJS は +Y が上。`worldY = (MAP_H-1) - ty` の反転を一箇所に閉じ込めて、
  入力・カメラ・カリング・座標表示すべてを同じ規約で通すのが事故防止のコツ。
  ここを混ぜると「上を押すと下に進む」「カリング範囲が片側だけ欠ける」が起きる。
- **カリングは自分で書く前提**。Phaser のような TilemapLayer の自動カリングは無い。
  逆に言えば「カメラ矩形→タイル範囲→二重ループで drawRect」と素直に書けるので、
  何枚描いているかを完全に把握できる（`Tiles drawn` がそのまま実描画数）。
  軽量エンジンは抽象が薄い分、性能の所在が見えやすいのが利点。
- **図形フォールバックが書きやすい**。`drawTile` と `drawRect` がほぼ同じ引数体系
  （pos/size/color or tile）なので、画像有無で分岐しても見通しが良い。
  `textureInfos[i].size` での読込判定は素直で、アセットゼロでも確実に起動できた。
- 総じて、LittleJS は「薄い API を正しく組む」タイプ。罠は engine 内部ではなく
  配布形態とレイヤ構成という“周辺”に集中しており、そこさえ越えれば
  タイルマップ＋カリングの実装自体は最短距離で書ける。
