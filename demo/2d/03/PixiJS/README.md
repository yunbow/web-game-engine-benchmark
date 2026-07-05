# テーマ3 トップダウンRPG探索 ― PixiJS v8 版

見下ろし型RPGの探索パート（マップ歩行）を **PixiJS v8** で実装。
100×100 タイルの広大マップを、可視範囲のみカリング描画してカメラ追従する性能比較用デモ。

## 起動方法

ローカルにHTTPサーバを立ててブラウザで開く（`PIXI.Assets.load` が `file://` では CORS で失敗するため）。

```bash
# このフォルダ(3/PixiJS/)の1つ上(3/)で実行すると ../assets/ も解決できる
cd c:/work/claude/github/virtual_office/research/3
python -m http.server 8000
# → http://localhost:8000/PixiJS/ を開く
```

`../assets/` に画像が無くても **Graphics 図形フォールバック** で必ず起動する。

## バージョン

- PixiJS **v8**（CDN: `https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js`）
- 追加ライブラリなし。`index.html` + `game.js` の2ファイル構成。

## 操作

| 入力 | 動作 |
|---|---|
| WASD / 矢印 | 4方向移動（160 px/s） |
| Shift | ダッシュ（2倍速） |
| `+` / `-` | NPC+敵スライム数を ±10 増減（初期60体） |

## 実装メモ

- **マップ生成**: `mulberry32` 固定シード(1337) による決定的生成。草ベースに水池/林/壁を散布し、
  水平・垂直の道(幹線)を引き、外周を壁で囲む。タイル種別 0=草 / 1=道 / 2=水 / 3=壁 / 4=木。
- **カリング描画(本デモの核)**: 画面に収まる最大タイル数ぶん（`(960/32+2)×(540/32+2)`）の
  `Sprite` をプールし、毎フレーム可視範囲のタイルへテクスチャと座標を割り当てて**再利用**する。
  `TilingSprite` は使わず、スプライト再利用による真のカリングを実装。`Tiles drawn` で実数を表示。
- **木(4)**: 32×48 で地面(草)の上に別レイヤー重ね描画。木スプライトも可視範囲ぶんプールして再利用。
  `zIndex = y` による Y ソートで自機・スライムと前後関係を表現（`entityLayer.sortableChildren`）。
- **衝突**: タイル単位の AABB を軸分離（X→Y）で判定。水/壁/木が進入不可。
- **エンティティ**: NPC/敵スライムを簡易ランダム徘徊（一定間隔で方向再抽選、壁衝突で即再抽選）。
  スライム接触で自機にノックバック（中心方向ベクトルに減衰）。
- **カメラ**: 自機中心追従＋マップ端クランプ。`world` コンテナを `-cam` 平行移動。HUD は `stage` 直下で画面固定。
- **HUD**: FPS（指数移動平均）/ Tiles drawn / Entities(NPC+敵+木) / 自機タイル座標 を常時表示。
- **フォールバック**: 各アセットを `PIXI.Assets.load` で試行し、失敗時は `renderer.generateTexture` で
  生成した図形テクスチャに差し替え。画像欠落でも見た目を保って起動する。

## Codex 生成所感（v8 の罠・タイルマップ描画/カリングの実装しやすさ）

- **v8 初期化の罠**: `new PIXI.Application(opts)` ではなく **`const app = new PIXI.Application(); await app.init(opts)`**
  が必須。コンストラクタに渡しても無視され `app.canvas` が生成されず詰まりやすい。
- **canvas プロパティ名**: v7 の `app.view` は **`app.canvas`** に改名。DOM 追加で間違えやすい第一の罠。
- **新 Graphics API**: v8 は `gr.beginFill()/drawRect()/endFill()` を廃止し
  **`gr.rect(x,y,w,h).fill(color)`** / `.stroke({width,color})` のチェーン式に変更。`fill` は色 or
  `{color, alpha}` オブジェクトを取る。旧チュートリアルのコードはほぼ動かないので注意。
- **テクスチャ生成**: `renderer.generateTexture({ target: graphics })` で図形→テクスチャ化。
  フォールバックを「図形をそのまま大量に addChild」ではなく**テクスチャ化して Sprite 再利用**にできるため、
  カリングと相性が良く性能も安定する。
- **カリング実装のしやすさ**: ◎。Pixi は「Sprite を並べてコンテナを平行移動」という素直なモデルなので、
  可視タイルぶんの Sprite プールを使い回す方式が非常に書きやすい。`TilingSprite` に頼らずとも
  実描画タイル数を完全制御でき、`Tiles drawn` の実数表示も容易。100×100 マップでも描画は
  約 (32×19) ≒ 600 スプライト程度に抑えられ、広大マップを軽快にスクロールできる。
- **深度ソート**: `sortableChildren = true` + `zIndex` で Y ソートが標準対応。トップダウンの前後関係表現が楽。
- 総じて v8 はタイルマップ／カメラスクロール用途と相性が良く、初期化と新 Graphics API の2点さえ
  押さえれば、カリング描画は最も実装しやすい部類だった。
