# 弾幕STG ― PixiJS v8 版

共通仕様 `../SPEC.md`（縦スクロール弾幕STG／性能比較用）の PixiJS 実装です。

## 起動方法

### 方法A: ダブルクリック
`index.html` をブラウザで開くだけで起動します（CDN から PixiJS を読み込みます）。

ただし `PIXI.Assets.load` が `file://` で画像を読む際、ブラウザによっては CORS/プロトコル制限で画像取得に失敗することがあります。その場合でも **単色図形フォールバックで必ず起動します**（仕様要件）。画像を確実に出したい場合は方法Bを推奨。

### 方法B: ローカルサーバ（推奨）
このフォルダの **1つ上**（`research/1/`）をルートにしてサーバを立てると、`../assets/` 参照が正しく解決します。

```bash
# research/1/ で実行
python -m http.server 8000
# → http://localhost:8000/PixiJS/index.html
```

## 操作
- 移動: 矢印キー / WASD（8方向、画面内クランプ）
- 発射: 常時オート連射（150ms間隔）
- `+` / `-`: 敵の最大同時出現数を ±10（上限300）

## 使用バージョン / 技術
- PixiJS **v8**（CDN: `https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js`、グローバル `PIXI`）
- 追加ライブラリなし。`index.html` + `game.js` のみで自己完結。
- 画面 **960x540 固定**、`resolution:1 / autoDensity:false`（DPR の影響を排し性能比較を素直に）。

## アセット
`../assets/` から SPEC のファイル名で読み込み（`player_ship.png` / `enemy_small.png` / `enemy_big.png` / `bullet_player.png` / `bullet_enemy.png` / `explosion.png` / `bg_space.png`）。
各ファイルを個別に `try/catch` し、**無いものだけ** `PIXI.Graphics` 由来のフォールバックテクスチャ（自機=水色三角／小型敵=赤丸／大型敵=赤紫二重丸／自機弾=黄角丸／敵弾=橙丸／爆発=黄白丸／背景=星空）に差し替えます。

## HUD（必須・性能比較の要）
HTML オーバーレイ（左上）で常時表示：
- **FPS**（直近60フレームの移動平均）
- **Objects**（自機弾＋敵弾＋敵＋エフェクトの合計。内訳も併記）
- **Score** / **HP**
- **MaxEnemy**（現在の最大敵数設定）

HUD は `requestAnimationFrame` ごとではなく約120msごとに DOM 更新し、文字列生成コストがベンチを汚さないようにしています。

## 実装メモ
- **ゲームループ**: `app.ticker` の `deltaMS` を使い、移動・弾速・タイマすべてデルタタイム基準。
- **入力**: `keydown/keyup` で `keys{}` を保持する自前実装。`+`/`-` はテンキー・`=`・`-` 各コードに対応。
- **当たり判定**: 円判定を自前で総当たり（自機弾×敵／敵弾×自機／敵×自機）。負荷を素直に上げるため空間分割はあえて未導入。
- **エンティティ**: 各要素は `{ sprite, ...state }`。除去は配列末尾とのスワップ＋ `sprite.destroy()` で O(1)。
- **フォールバックテクスチャ**は `renderer.generateTexture()` で一度だけ生成しキャッシュ → 大量 Sprite が同一テクスチャを共有しバッチング。
- 大型敵（HP3）を約18%混在。被弾で HP-1、HP0で一時 GAME OVER 後に自動リスポーン（ベンチ継続のため）。被弾後は1.5秒無敵＋点滅。
- 背景は `bg_space.png` があれば `TilingSprite` で縦スクロール、無ければ自前スターフィールド。

## Codex / AI コーディングでの生成しやすさ所感

**v8 新API の罠**
- 初期化が `new PIXI.Application(opts)` ではなく **`new PIXI.Application()` → `await app.init(opts)`** の2段階。AI は v7 以前の記憶で `new PIXI.Application({...})` を出しがちで、これだと v8 では描画されず（黙って失敗）ハマる典型ポイント。`app.view` も v8 では **`app.canvas`** に改名されている。
- `PIXI.Graphics` の API が **メソッドチェーン式**（`.circle(...).fill(0x..)` / `.rect(...).fill(...)`）に刷新。旧 `beginFill()/drawCircle()/endFill()` は廃止。AI が旧式を混ぜると無言で図形が出ない。
- テクスチャ化は `renderer.generateTexture({ target: g })` で、引数がオブジェクト形式に変わっている。
- `TilingSprite` も `new PIXI.TilingSprite({ texture, width, height })` のオブジェクト引数形式。
- レンダラが WebGPU 優先のため、`autoDensity`/`resolution` を明示しないと環境ごとに見た目・性能がブレやすい。性能比較では固定推奨。

**描画ライブラリゆえの自前実装量**
- Pixi は「描く」だけなので、**ゲームループ・入力・当たり判定・スポーン・プール・HUD のすべてが自前**。Phaser のような Arcade Physics / 入力ヘルパ / シーン管理が無い分、コード量は Phaser 版より明確に多くなる（本実装で約300行）。
- 逆に言うと AI にとっては「素の JS でゲームを書く」のと同じで、ライブラリ固有の作法依存が少なく**ロジック部分の生成は安定**。詰まるのは前述の v8 初期化・Graphics 新APIのバージョン差異がほぼすべて。
- 総じて：**ロジックは書きやすいが、v8 の新APIを正しく指示しないと AI は v7 系コードを出す**。プロンプトで「Pixi v8、`app.init()` 必須、`app.canvas`、Graphics は新チェーンAPI」と明示するのが成功の鍵。
