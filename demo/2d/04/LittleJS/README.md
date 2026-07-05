# ブロック崩し (マルチボール Breakout) ― LittleJS 版

テーマ4共通仕様 (`../SPEC.md`) に準拠した LittleJS 実装。多数のボール × 多数の
ブロックの反射・当たり判定を毎フレーム回す、性能比較用のベンチ的ブロック崩し。

## 起動方法

### 1) ダブルクリック (ローカルファイル)
`index.html` をブラウザにドラッグ&ドロップ、またはダブルクリックで開けます。
CDN からエンジンを読み込むためインターネット接続が必要です。

> 注意: `file://` で開くと、ブラウザによっては CDN や画像の CORS が制限される
> 場合があります。うまく動かない場合は下記のローカルサーバ起動を使ってください。

### 2) ローカルサーバ (推奨)
このフォルダ (`LittleJS/`) で:

```bash
# Python 3
python -m http.server 8000
# あるいは Node
npx serve .
```

ブラウザで `http://localhost:8000/` を開く。
画像アセットは `../assets/` を参照するため、リポジトリの `4/` 階層を
保ったまま配信する必要があります (サーバはこのフォルダの親が見えるよう
`4/` で起動してもOK。その場合 URL は `/LittleJS/`)。

## 使用バージョン / CDN

- エンジン: **LittleJS** (最新, バージョン固定なし)
- 採用 CDN (primary): `https://unpkg.com/littlejsengine`
  - `index.html` 内で primary の読み込みに失敗した場合、
    `https://cdn.jsdelivr.net/npm/littlejsengine/dist/littlejs.min.js`
    へ自動フォールバックする仕組みを入れてあります。
  - どちらも非モジュール (UMD/グローバル) ビルドで、`engineInit` / `vec2` /
    `drawTile` などが **window グローバル** に生えます。

## ファイル構成

- `index.html` … CDN 読み込み + HUD オーバーレイ + フォールバック CDN ロジック。
- `game.js`   … ゲーム本体 (全ロジック)。
- `README.md` … 本ファイル。

アセット (任意, あれば自動使用):
`../assets/` に SPEC のファイル名で配置すると自動的にスプライト描画になります。
`paddle.png` / `ball.png` / `brick.png` / `hit_spark.png` / `bg_breakout.png`
(現状 `assets/` は空なので、図形フォールバックで起動します)。

## 操作

- パドル移動: 矢印 `←` / `→` または `A` / `D` (水平のみ・画面内クランプ)。
- ボール: **自動発射** (手動ロックなし。負荷を一定に保つため常時プレイ継続)。
- `+` (= `Equal` / `NumpadAdd`) / `-` (= `Minus` / `NumpadSubtract`):
  同時ボール数 (負荷) を ±5 増減。

## 仕様数値 (SPEC 準拠)

- 画面: 960 × 540 固定。`setCanvasFixedSize(vec2(960,540))`。
- パドル: 幅 **96** × 高さ **18**、中心 y=**510** 固定、移動速度 **600 px/s**、左右クランプ。
- ボール: 半径 **8**、速さ **380 px/s** (一定)。発射は上方向へ ±60° のランダム角。
  - 反射: 左右壁・天井で反射。パドルは当たった位置のオフセット (中心からの -1..1)
    で反射角を変え、端ほど横に鋭く・常に上方向・速さ 380 に再正規化。
  - 下端 (y > 540 + r) を抜けたら **ロスト → パドル上から再発射** (同時数は維持。
    ゲームオーバーにしない)。`Lost` をカウント。
- ブロック: **15列 × 9行 = 135個**。56 × 20 + 間隔 4、上オフセット 60、中央寄せ。
  - 行 HP: 上3行=HP3 / 中3行=HP2 / 下3行=HP1。
  - 表示色は HP で変化 (**HP3=赤 / HP2=橙 / HP1=緑**)。`brick.png` がある場合は明色
    テクスチャを HP 色で乗算 tint。無い場合は HP 色の矩形。
- 当たり判定: ボール×ブロックは **AABB(矩形)×円(最近点)**。当たった面で速度反転
  (左右面=vx反転 / 上下面=vy反転)、HP-1、HP0 で破壊し **Score +10** + `hit_spark` 一瞬表示。
  - 1ボールにつき1フレーム1ブロックまで (最初の命中で break)。
- **全ブロック破壊で盤面を再生成** (ベンチ継続)。
- 同時ボール数: 初期 **3**、`+`/`-` で **±5** (下限 **1** / 上限 **500**)。
- 物理エンジンは未使用。位置更新・反射・円/矩形判定はすべて自前。

## HUD

画面左上の HTML オーバーレイ (`#hud`) を毎フレーム `gameRenderPost` で更新:

- `FPS` … 実測の指数移動平均。
- `Objects` … ボール + 残ブロック + エフェクトの合計数。
- `Score`
- `Balls` … 現在の同時ボール数 / 設定値 (`Lost` 累計も併記)。
- `Bricks` … 残ブロック数。
- 末尾に `[sprites]` / `[shapes fallback]` を表示。

## 実装メモ

- 起動: `engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)`。
- 表示: `setCanvasFixedSize(vec2(960,540))` + `setCameraScale(1)` +
  `setCameraPos(vec2(480,270))` + `setGravity(vec2(0,0))` で
  「1 ワールド単位 = 1px」「可視範囲 x:[0,960] y:[0,540]」に揃え、SPEC の px 数値を
  そのまま使用。更新は `timeDelta` (デルタタイム) 基準。

- **座標系の罠 (Y軸注意)**: LittleJS のワールドは **Y が上向き**。本実装は
  ゲームロジックを「画面座標 (左上原点・y 下向き)」の内部モデルで一貫して持ち、
  描画の瞬間だけ Y を反転する:
  ```
  worldY = SCREEN_H - screenY        // toWorld(sx, sy) に集約
  ```
  - 当たり判定・反射・速度・クランプはすべて **y 下向きの画面座標** で計算。
    パドルは下部 (screenY=510)、ブロックは上部 (screenY=60〜)、ボールは下端
    (screenY > 540 + r) を抜けたらロスト、という SPEC の直感どおりに書ける。
  - `drawTile` / `drawRect` / `drawCircle` / `drawLine` に渡す座標だけ `toWorld()`
    を通すので、変換漏れが起きにくい (描画関数の引数に絞って一点変換)。

- **画像が無くても必ず起動**: LittleJS は画像 404 でも `onerror→resolve` で
  エンジンを起動する。さらに本実装は `textureInfos[i].size.x > 1` を見て、実際に
  読めたテクスチャだけスプライト描画し、未読込なら `drawRect` / `drawCircle` /
  `drawLine` の図形フォールバックに切り替える (`spriteReady()`)。
  - パドル = 白角丸 (矩形)、ボール = 白丸、ブロック = HP色矩形 (赤/橙/緑)、
    spark = 黄バースト (放射状の線)、背景 = 暗色。
  - 現状 `assets/` は空なので、起動すると `[shapes fallback]` 表示になる。

- **ボール同士の衝突は行わない**: SPEC どおり、性能/簡潔さのため省略。
  ボール×ブロック / ボール×パドル / ボール×壁 のみを処理する。

- 負荷調整: `+` は Shift 併用が多いので `Equal` でも検出。設定値を下げた直後は
  `refillBalls()` が末尾から間引き、上げた直後はパドル上から補充する。

## Codex / AI コーディングでの生成しやすさ所感 (LittleJS 固有)

**良い点 (単一ファイル軽量エンジン)**

- 依存が CDN の 1 ファイルだけでビルド工程ゼロ。`index.html` + `game.js` で完結し、
  AI が「全体像を 1 度に把握→生成」しやすい。`drawRect` / `drawCircle` / `drawLine`
  を直接呼べるので、画像アセット無しの図形フォールバックが書きやすく、
  「ボール数を増やして衝突スループットを測る」ベンチ用途と相性が良い。
- `engineInit(...)` の 5 コールバック構成 (init/update/updatePost/render/renderPost)
  が固定で、ループの書き場所を AI が迷いにくい。

**罠 / 注意点 (LittleJS 特有)**

- **Y 軸が上向き**。ブロック崩しは「上にブロック・下にパドル・下に落ちたらロスト」と
  いう y 下向きの直感が強く、ワールドが y 上向きだと AI 生成で上下が反転しがち。
  本実装はロジックを画面座標で統一し、描画引数だけ `toWorld()` で反転して切り分けた。
  特にパドル反射の「常に上方向」は、画面座標で `vy = -cos(a)*speed` (y 減少)、
  ワールドでは逆という二重反転に注意。
- **`textureInfos` の読込判定**。LittleJS は画像が無くても起動するが、未読込
  テクスチャを `drawTile` すると空描画になる。`textureInfos[i].size.x > 1` で
  読込判定して図形フォールバックする処理は AI が自発的に書かないことが多く、明示が必要。
- **CDN の ESM / classic 混同**。npm の `littlejsengine` は ESM だが、CDN の dist は
  グローバル (classic) 版。`import` を書くと `<script type=module>` が必要になり、
  さらに ESM では `textureInfos` 等の内部グローバルに触れない。
  「非モジュール CDN + window グローバル参照」で統一すること。
- **`canvasFixedSize` / `cameraScale` / `cameraPos` の 3 点セット**を設定しないと
  座標がワールド単位 (画面中心原点・小スケール) になり、SPEC の px 数値が合わない。
  scale=1 + camera 中心 (480,270) + fixed size (960,540) でようやく px 等倍になる。
- **`drawTile` の tint 引数**。ブロックの HP 色は `drawTile(pos, size, tile, color)` の
  第4引数 color で乗算 tint する。明色テクスチャ前提なので、暗い brick.png を使うと
  色が出ない点に注意。図形フォールバック側は HP 色の矩形を直接描く。
- HUD は LittleJS の `debug` オーバーレイより、HTML 要素 (`#hud`) を自前で
  `gameRenderPost` から更新する方が確実で見栄えも安定。
