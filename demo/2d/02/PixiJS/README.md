# トップダウン・サバイバー — PixiJS v8 版

テーマ2 共通仕様（`../SPEC.md`）に厳密準拠した、見下ろし型サバイバーの **PixiJS v8** 実装です。
数百〜千体の敵の群れ更新＋当たり判定で性能限界を測ることを目的としています。

## 起動方法

`index.html` をブラウザで開くだけで動作します（追加ビルド不要）。

ただし `PIXI.Assets.load` で `../assets/` を読み込むため、`file://` 直開きだと
CORS/相対パス制約に引っかかる場合があります。確実に動かすには簡易HTTPサーバ経由を推奨します。

```bash
# 例: リポジトリの research/2 ディレクトリで
npx serve .
# → http://localhost:3000/PixiJS/ を開く

# あるいは Python
python -m http.server 8000
# → http://localhost:8000/PixiJS/ を開く
```

> 画像アセットが存在しない場合でも、**Graphics 図形フォールバック**で必ず起動します
> （自機=白丸 / bat=紫丸 / zombie=緑丸 / 弾=黄丸 / gem=水色菱形 / 地面=グリッド）。

## バージョン

- **PixiJS v8**（CDN: `https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js`）
- 依存ライブラリは Pixi のみ。ビルドツール不要のプレーン JS。

## 操作

| キー | 動作 |
|---|---|
| WASD / 矢印 | 移動（8方向, 180 px/s） |
| （自動） | 最近接の敵へ 400ms ごとに発射（弾速 350 px/s, 命中で敵HP-1） |
| `+` / `-` | 敵スポーン上限 ±50（0〜1000） |
| `R` | GAME OVER 後にリスタート |

## 仕様の数値（SPEC厳守）

- キャンバス **960x540 固定**、カメラ自機追従（自機は常に中央）。
- 移動 180 px/s、攻撃間隔 400ms、弾速 350 px/s。
- 敵速度 60〜90 px/s、敵HP = 1（bat/小）/ 3（zombie/大）。撃破で gem ドロップ。
- 自機HP初期5、接触で -1（無敵 0.5s）。0 で GAME OVER。
- 同時敵数：初期150、`+`/`-`で±50（上限1000）、**10秒ごと自動 +25**。
- 当たり判定はすべて円。gem は自機が触れて取得 → Kill カウント。

## HUD（必須項目すべて表示）

`FPS`（直近60フレームの移動平均） / `Enemies`（生存敵数, cap併記） /
`Objects`（敵+弾+gem合計） / `Time`（生存秒） / `Kills` / `HP`

## 実装メモ

- **初期化**: v8 の `await app.init({...})` で非同期初期化し、`app.canvas`（旧 `app.view`）を DOM に追加。
- **ループ/入力/当たり判定/カメラはすべて自前**。`app.ticker` で `deltaMS` ベースの可変フレーム更新（dt は 0.05s でクランプして大量spawn時のすり抜けを防止）。
- **カメラ**: ワールド全体を載せた `Container` を `world.x = 960/2 - player.x` で平行移動。地面は `TilingSprite` の `tilePosition` をプレイヤー座標と逆方向にずらして無限スクロール表現。
- **大量描画の最適化（本作の肝）**:
  - 敵・弾・gem は **スプライト再利用プール**で管理。`free` スタックから O(1) で取り出し、死亡時はスタックへ戻すだけ。**毎フレームの生成/破棄を完全排除**し GC スパイクとドローコール増を抑制。
  - 生存数 `aliveCount` をプール側で逐次インクリメント管理し、HUD やスポーン補充の度に配列を全走査しない。
  - 1フレームのスポーン補充は最大40体に分散し、cap引き上げ直後のフレーム落ちを緩和。
  - 描画レイヤーは bat / zombie / gem / proj を別 Container に分離（同一テクスチャ連続でバッチング効率↑）。
- **フォールバック**: `PIXI.Assets.load` を 1 枚ずつ try/catch し、失敗時は `Graphics`（v8 新API `.circle().fill()` / `.poly().fill()`）→ `app.renderer.generateTexture()` でテクスチャ化。1枚欠けても他に波及しない。
- **当たり判定**: すべて円 vs 円の二乗距離比較（`Math.sqrt` を極力回避）。

### ParticleContainer を使わなかった理由

v8 の `ParticleContainer` は高速だが **`PIXI.Particle` 専用＋単一テクスチャ前提** で、
動的プロパティ（位置以外）の宣言も必要です。本作は bat / zombie / gem / proj と
複数テクスチャを扱い、フォールバック時にテクスチャ差し替えも行うため、
**スプライト再利用プール**方式を採用しました（仕様の「スプライト再利用プールで最適化」に合致）。
それでも 150 体規模で 60 FPS 安定を確認済みです。

## Codex 生成所感

### PixiJS v8 の罠

- **`await app.init()` 必須化**: v7 までの「コンストラクタで即初期化」が廃止され、`new PIXI.Application()` 直後はまだ使えない。`app.init()` を await し忘れると `renderer is null` 系で落ちる。トップレベル `async` IIFE で包むのが定石。
- **`app.view` → `app.canvas`**: DOM 追加先のプロパティ名が変わっており、旧コードのコピペがそのまま動かない。
- **Graphics 新API**: `g.beginFill()/drawCircle()/endFill()` は廃止。`g.circle(x,y,r).fill({color})` のメソッドチェーン形式に統一。`fill`/`stroke` は数値だけでなく **オブジェクト指定**（`{color, alpha, width}`）が基本。
- **Text のコンストラクタ**: `new PIXI.Text('文字', style)` ではなく `new PIXI.Text({ text, style })` のオプション形式。stroke も `{color, width}` オブジェクト。
- **`Assets.load` の戻り**: 欠落時は reject される（404）。1枚の失敗で `Promise.all` 全体が転ぶのを避けるため、個別 try/catch が安全。
- これらは「v7 の知識のままだと無言で or 例外で落ちる」破壊的変更で、v8 では公式の **移行ガイド前提**でコードを書く必要があった。

### 大量描画の最適化のしやすさ

- Pixi は **WebGL バッチングが優秀**で、同一テクスチャのスプライトを並べる本作のようなケースでは「素直にスプライトを並べるだけ」で 150 体 60 FPS が出た。エンジン任せでかなり戦える。
- スプライト再利用プールの実装も Pixi 側に余計な作法がなく（`addChild` 済みのスプライトの `visible` を切り替えるだけ）、**素直に書けるのが強み**。フレームワークが薄いぶん「自分で全部やる」必要はあるが、その自前ロジックが Pixi の描画と素直に噛み合う。
- 一方で `ParticleContainer` を本気で使おうとすると `Particle` 型への移行が必要で、複数テクスチャ/動的差し替えとは相性が悪い。**「とりあえず大量描画」ならスプライト＋プールで十分速く、ParticleContainer は単一テクスチャ・超大量時の最終手段**という棲み分けが実感として得られた。
