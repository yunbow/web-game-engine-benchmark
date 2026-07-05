# トップダウン・サバイバー — LittleJS 版

テーマ2共通仕様（`../SPEC.md`）の **LittleJS** 実装。全エンジンで同一ゲームを実装し性能を横並び比較するための1本。

## 起動方法

`index.html` と `game.js` の2ファイル構成。CDN から LittleJS を読み込むだけで動く。

- 静的サーバ経由で開くのが確実（`fetch`/画像読込のCORS回避のため）。例:
  - Python: `python -m http.server` → ブラウザで `http://localhost:8000/LittleJS/index.html`
  - VS Code Live Server 等でも可
- `index.html` をダブルクリック（`file://`）でも、アセット未配置なら図形フォールバックで起動する。

### 操作

- 移動: `WASD` / 矢印キー（8方向、速度 180 px/s）
- 攻撃: **自動**（最も近い敵へ 400ms ごとに弾を発射、弾速 350 px/s、命中で敵HP-1）
- `+` / `-`（または `[` / `]`、テンキー `+`/`-`）: 敵スポーン上限を ±50
- `GAME OVER` 後: `R` キー または 画面クリックでリスタート

## CDN / バージョン

- **LittleJS v1.18.19**
- 読込URL（primary, 動作確認済）:
  `https://unpkg.com/littlejsengine/dist/littlejs.min.js`
- フォールバック（同一ファイル・同サイズで動作確認済）:
  `https://cdn.jsdelivr.net/npm/littlejsengine/dist/littlejs.min.js`

### 重要: CDN URL の罠

仕様の推奨は素の `https://unpkg.com/littlejsengine` だが、これは package.json の
`main: dist/littlejs.esm.js` に解決され、**ES Module（末尾に `export {...}`）** が返る。
クラシックな `<script src=...>` で読むと `Unexpected token 'export'` で落ちる。
`engineInit(...)` をグローバル関数として呼ぶ本実装では **classic global build**
`/dist/littlejs.min.js`（`export` を含まない、約 180 KB）を使う必要がある。
両CDNとも当該パスは同一バイト列を返すことを確認済み。

## 起動エントリ

```js
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources);
```

## アセット

`imageSources` に `../assets/` の SPEC 名で指定（`player.png` / `enemy_bat.png` /
`enemy_zombie.png` / `projectile.png` / `xp_gem.png` / `ground_tile.png`）。
読込判定は `textureInfos[i].size` を見て行い、**未配置/読込失敗なら図形フォールバック**:

| 種類 | 図形フォールバック |
|---|---|
| 自機 | 白丸 |
| bat（小・速） | 紫丸 |
| zombie（大・遅・HP高） | 緑丸 |
| 弾 | 黄丸 |
| gem | 水色の菱形（45°回転矩形） |
| 地面 | 単色 + 薄いグリッド |

assets フォルダが空でも必ず起動する。

## HUD（必須項目すべて表示）

`FPS`（実測・移動平均）/ `Enemies`（生存敵数＋現在の上限）/ `Objects`（敵+弾+gem 合計）/
`Time`（生存秒）/ `Kills` / `HP`。画面左上に常時表示。

## 実装メモ

- **座標系**: LittleJS は Y軸が上向き（数学系）。`W`/上キーで +Y、スポーン位置・移動ベクトル計算もこれを前提。
- **表示固定**: `setCanvasFixedSize(vec2(960,540))` + `setCameraScale(1)`（1 world unit = 1px）。
  カメラは毎フレーム `setCameraPos(player)` で自機追従。
- **大量エンティティのプール再利用**: `EngineObject` は使わず、フラットな配列＋
  `active` フラグの自前 `Pool` で敵・弾・gem を管理。撃破/消滅はフラグを倒すだけ（GC負荷を抑制）。
  当たり判定は全て円（半径和の二乗比較）。
- **数値はSPEC厳密準拠**: 移動180 / 攻撃400ms・弾350 / 敵60〜90 / 接触で自機HP-1・無敵0.5s /
  自機HP5 / 初期150・±50・上限1000・10秒ごと+25。スポーンは毎フレーム少数ずつ補充して
  目標同時数を維持。
- **WebGL を無効化（`glEnable = false`）**: これが最大のハマりどころ（下記所感）。
- **FPS は自前で実測**: `timeDelta` は固定タイムステップ（1/60）なので `1/timeDelta` は常に60で
  実測にならない。エンジンの `averageFPS` は `debug` 有効時しか更新されない。よって
  `gameRenderPost`（実フレームごとに1回）で `performance.now()` の差分から移動平均を取る。

## Codex 生成所感（軽量エンジンで大量エンティティを書く所感・罠）

- **「軽量＝何でも自分で書ける」が強みで罠でもある**。LittleJS は `EngineObject` という
  気の利いた基底クラスを持つが、数百〜千体規模では1体ごとのオブジェクト生成・配列ソート・
  物理ソルバが効いてくる。今回は割り切って `EngineObject` を捨て、プレーンな構造体＋プールで
  自前ループにした。ロジックが透明になり、当たり判定も「円の半径和²」一発で済む。
  軽量エンジンはこの「降りる自由」が利く一方、降りた分だけ自分で正しく書く責任が増える。

- **最大の罠は描画パイプラインと HUD の前後関係**。LittleJS は WebGL 有効時、`mainCanvas`(2D)
  の "上" に別DOMの `glCanvas` を重ねて合成する。スプライト（`drawTile`/`drawCircle`）は
  glCanvas に出るが、`gameRenderPost` で `mainContext` に描いた 2D の HUD はその裏に隠れて
  **見えなくなる**。さらに現行版には `overlayCanvas`/`overlayContext` というグローバルが存在せず
  （古い記事のAPIを真似ると `ReferenceError`）、ここで素直にハマる。
  解決は `glEnable = false`：全描画を `mainContext` の 2D に1枚で順序通り出すことで HUD が
  最前面に来る。1000体規模でも Canvas2D バッチで実用域に収まる。性能比較目的なら
  WebGL有効のまま HUD を WebGLパイプライン側で描く選択もあるが、確実性を優先した。

- **CDN の解決先という罠**。`https://unpkg.com/littlejsengine` は ESM に解決され、
  クラシック `<script>` だと `export` で即死する。classic global build の
  `/dist/littlejs.min.js` を明示する必要がある。「とりあえずパッケージ名でCDN」は通用しない。

- **固定タイムステップと FPS 表示**。`timeDelta` は常に 1/60 の定数。これを FPS と勘違いすると
  「常に60固定」の嘘メーターになる。実測は `performance.now()` を自前で回す。決定論的更新は
  挙動の再現性には嬉しいが、計測系は自分で用意する前提。

- **グローバルスコープ前提**。エンジンもゲームも `type=module` でない classic script として読み、
  同一グローバルスコープを共有する設計。だから `glEnable = false` の代入や `engineInit(...)`
  直呼びが効く。逆に ESM 化すると一気に壊れる（＝上記CDN罠と地続き）。

- **総じて**: 軽量エンジンは「薄いラッパ＋自前ループ」で大量エンティティを素直に書け、
  Codex 的にもロジックが追いやすい。ただしエンジン任せにできない分、描画レイヤ合成・固定ステップ・
  CDN/モジュール形態という"足元"の罠を最初に踏み抜きやすい。ここさえ押さえれば実装は短く済む。
