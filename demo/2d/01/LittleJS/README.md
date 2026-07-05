# 弾幕STG (縦スクロールシューティング) ― LittleJS 版

テーマ1共通仕様 (`../SPEC.md`) に準拠した LittleJS 実装。性能比較用のベンチ的 STG。

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
画像アセットは `../assets/` を参照するため、リポジトリの `research/1/` 階層を
保ったまま配信する必要があります (サーバはこのフォルダの親が見えるよう
`research/1/` で起動してもOK。その場合 URL は `/LittleJS/`)。

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
`player_ship.png` / `enemy_small.png` / `enemy_big.png` / `bullet_player.png` /
`bullet_enemy.png` / `explosion.png` / `bg_space.png`

## 実装メモ

- 起動: `engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources)`。
- 表示: `setCanvasFixedSize(vec2(960,540))` + `setCameraScale(1)` +
  `setCameraPos(vec2(480,270))` で「1 ワールド単位 = 1px」「可視範囲 x:[0,960] y:[0,540]」
  に揃え、SPEC の px 数値をそのまま使用。
- **座標系の罠**: LittleJS のワールドは **Y が上向き**。本実装では
  「画面下 = Y 小 / 画面上 = Y 大」とし、自機は下部 (Y 小)、敵は上 (Y 大) から
  出現して下方向 (Y 減少) へ移動する。入力の上下も SPEC の見た目に合わせて反転。
- **画像が無くても必ず起動**: LittleJS は画像 404 でも `onerror→resolve` で
  エンジンを起動する。さらに本実装は `textureInfos[i].size` を見て、実際に
  読めたテクスチャだけスプライト描画し、未読込なら `drawCircle` / `drawRect` /
  `drawLine` の図形フォールバックに切り替える (`spriteReady()`)。
  - 自機 = 水色三角、敵 = 赤/橙の円、自機弾 = 黄円、敵弾 = 桃円、背景 = 暗色+星。
  - HUD に `[sprites]` / `[shapes fallback]` を表示。
- 数値 (SPEC 準拠): 自機弾速 600px/s・連射 150ms、敵 80〜140px/s 下降・敵弾 200px/s・
  自機方向へ発射、初期同時最大 40 体、HP3、撃破 +10。当たり判定はすべて円判定。
- HUD は HTML オーバーレイ (`#hud`) を毎フレーム `gameRenderPost` で更新。
  FPS (移動平均) / Objects (弾+敵+エフェクト合計) / Score / HP / 最大敵数 を常時表示。
- 負荷調整: `+`(=`Equal`/`NumpadAdd`) / `-`(=`Minus`/`NumpadSubtract`) で
  最大敵数 ±10 (上限 300, 下限 0)。`+` は Shift 併用が多いので Equal でも検出。
- 操作: 矢印 / WASD で 8 方向移動・画面内クランプ、発射はオート連射。
  ゲームオーバー後は `R` で再開。

## Codex / AI コーディングでの生成しやすさ所感

**良い点 (単一ファイル軽量エンジン)**

- 依存が CDN の 1 ファイルだけで、ビルド工程ゼロ。`index.html` + `game.js` で
  完結するので AI が「全体像を 1 度に把握→生成」しやすい。Phaser/Babylon の
  ようなシーン/プラグイン階層がなく、グローバル関数 (`drawRect` 等) を直接
  呼ぶ素朴な API なので、生成コードのハルシネーションが起きても破綻が局所的。
- `engineInit(...)` の 5 コールバック構成 (init/update/updatePost/render/renderPost)
  が固定で覚えやすく、「ループの書き場所」を AI が迷いにくい。
- `drawRect`/`drawCircle`/`drawLine`/`drawText` が即席フォールバックに使え、
  画像アセット無しでも動くデモを作りやすい (ベンチ用途と相性が良い)。

**罠 / 注意点 (engineInit 周り)**

- **コールバックの引数順** `engineInit(gameInit, gameUpdate, gameUpdatePost,
  gameRender, gameRenderPost, imageSources)` を AI が取り違えやすい
  (`gameRenderPost` と `gameUpdatePost` の位置や、`imageSources` が最後で配列、など)。
- **Y 軸が上向き**。多くの 2D STG 直感 (上が +Y はワールド、画面では下) と
  ズレるため、AI 生成だと自機/敵の上下や弾の進行方向が逆になりがち。
  本実装はワールド Y を「上=大」に固定して整理した。
- **モジュール vs グローバル**。npm の `littlejsengine` は ESM だが、CDN の dist は
  グローバル版。`import` を書いてしまうと `<script type=module>` が必要になり、
  さらに ESM だと `textureInfos` 等の内部グローバルに触れない。AI は両者を
  混同しやすいので「非モジュール CDN + グローバル参照」で統一した。
- **画像ロードの仕様**。LittleJS は画像が無くても起動するが、未読込テクスチャを
  そのまま `drawTile` すると空描画になる。`textureInfos[i].size` で読込判定して
  図形フォールバックする処理は AI が自発的に書かないことが多く、明示が必要。
- **`canvasFixedSize` / `cameraScale` / `cameraPos`** を設定しないと座標が
  ワールド単位 (~画面中心原点・小スケール) になり、SPEC の px 数値が合わない。
  「px をそのまま使う」には scale=1 + camera 中心 + fixed size の 3 点セットが要る。
- HUD は LittleJS の `debug` オーバーレイより、HTML 要素を自前で更新する方が
  確実で見栄えも安定 (本実装は `#hud`)。
