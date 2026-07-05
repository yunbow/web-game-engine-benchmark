# テーマ8 パーティクル / 魔法エフェクトデモ ― PixiJS v8 版

多数のエミッタが**加算合成**のパーティクルを噴き出す魔法エフェクトデモを **PixiJS v8** で実装。
画面を決定的な軌道で周回する 4 個の発光オーブが火花を連続噴出し、マウス移動でトレイル、
左クリックで放射状の爆発バーストが出る。性能比較の核は「**画面上の生存パーティクル総数**」で、
**ParticleContainer + 加算ブレンド + 自前 CPU 更新**のスループットを測る。

## 起動方法

ローカルにHTTPサーバを立ててブラウザで開く（`PIXI.Assets.load` が `file://` では CORS で失敗するため）。

```bash
# このフォルダ(8/PixiJS/)の1つ上(8/)で実行すると ../assets/ も解決できる
cd c:/work/claude/local-works/web-game/8
python -m http.server 8000
# → http://localhost:8000/PixiJS/ を開く
```

`../assets/` に画像が無くても **Canvas 生成の放射グローテクスチャ**で必ず起動する（現状アセットは未配置）。

## 使用パーティクル機構（GPU / CPU の別）

- **機構: PixiJS v8 `ParticleContainer` + `Particle`**（`Sprite` の `Container` ではなく専用コンテナ）。
- **更新は CPU 自前（GPU パーティクルではない）**。v8 の ParticleContainer は「位置・スケール・回転・色のみ」
  を持つ軽量パーティクル専用の描画コンテナで、**位置/alpha/size/色の毎フレーム更新は JS（CPU）で行う**。
  GPU 側で寿命シミュレーションする Babylon の `GPUParticleSystem` や Godot の `GPUParticles2D` とは対照的。
  本デモの比較軸はこの「**CPU 更新 + 加算ブレンドのバッチ描画**」のスループット。
- **なぜ ParticleContainer か**: 通常の `Container` に大量の `Sprite` を入れるより、属性を
  詰めた専用バッファで一括アップロードするため、数万個の描画スループットで有利（＝テーマの比較目的に合致）。
- **HUD の `Mode` は `CPU (manual update) / ParticleContainer`** と表示する。

## 操作

| 入力 | 動作 |
|---|---|
| マウス移動 | カーソル位置に追従トレイル（連続噴出） |
| 左クリック | クリック地点で爆発バースト（一度に 120〜200 個を放射） |
| `Space` | オート花火トグル（ON 中 0.5s 間隔で決定的位置に爆発・マウス無しでベンチ可） |
| `B` | ブレンド切替（**加算 ADD ⇄ 通常 NORMAL**） |
| `+` / `-`（テンキー可） | 目標パーティクル数を ±2000（初期 2000・下限 500・上限 50000） |
| `R` | リセット（パーティクル全消去・目標 2000・乱数再シード・オーブ再構築） |

## 仕様数値（全エンジン共通）

- キャンバス **960×540**（固定）、背景は暗色 **`#08080f`**（発光が映える）。時間はデルタタイム基準。
- パーティクル: 寿命 **0.6〜1.4s**、初速はランダム方向（決定的PRNG）、軽い重力（90 px/s²）＋減速。
  寿命に沿って **size: 大(1.4)→小(0.15)、alpha: 1→0、色: 暖色→寒色**。**加算合成**で重なるほど明るく。
- 常設エミッタ: **決定的軌道で周回する発光オーブ 4 個**（正弦合成のリサージュ風軌道・固定シード）が
  火花を**連続レート噴出**。マウス無しでも常にパーティクルが流れる＝ベンチ安定。
- 爆発バースト（クリック / オート花火）: **一度に 120〜200 個**を全方位へ放射。
- 目標同時数: 初期 **2000**、`+/-` で **±2000**（下限 **500**・上限 **50000**）。
  **エミッションレートを目標に合わせて動的調整**し、生存数（`Particles`）を上限付近で安定させる。
- パーティクルは**プール再利用**（生成/破棄の GC を避ける）。寿命終了で待機列へ返し再利用。
- スコア/ライフは無し（デモのため）。代わりにパーティクル統計を HUD に出す。

## HUD（HTMLオーバーレイ `#hud`・約120msごと更新）

- `FPS`（直近60フレームの移動平均）
- `Particles`（現在生存しているパーティクル数）
- `Target`（目標上限）
- `Emitters`（常設オーブ 4 + アクティブバースト数 + トレイル）
- `Blend`（ADD / NORMAL）
- `Mode`（CPU manual update / ParticleContainer）
- 画面下に操作ヒント行（クリック=爆発 / Space=オート / B=ブレンド / +/-=量 / R=リセット）。

HUD はキャンバス外の HTML `<pre>` 要素で描画。Pixi の描画負荷と切り離して計測できる。

## 使用バージョン

- PixiJS **v8**（CDN: `https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js`）
- 追加ライブラリなし。`index.html` + `game.js` の2ファイル構成。

## 実装メモ

- **ParticleContainer 構築**: `dynamicProperties` で「毎フレーム変わる属性」を宣言する。
  本デモは `{ position:true, scale:true, color:true, rotation:false }`。
  - `position` … 位置更新（必須）。`scale` … 大→小。`color` … **tint と alpha は color パイプライン**
    なので alpha フェードに必須。`rotation:false` … 回転は使わず、無駄なアップロードを省いて軽量化。
  - `texture` に**全パーティクル共通の 1 枚**（spark グロー）を指定してバッチを最大化。
- **加算ブレンドはコンテナ単位**: v8 の `Particle` は個別 `blendMode` を持てない。`particles.blendMode = 'add'`
  をコンテナに設定。`B` 切替は `particles.blendMode` を `'add' ⇄ 'normal'` に差し替えるだけ（オーブ層も同様）。
- **プール再利用（GC回避）**: `Particle` は `addParticle` で**常駐**させ、待機中は `alpha=0` + 画面外へ退避する。
  毎フレーム `addParticle/removeParticle` を叩くより、属性更新だけで生死を切り替える方が速い。
  `free`（待機 index スタック）から取り出して `emit`、寿命終了で押し戻す。プールは目標に応じ上限まで拡張。
- **レート自動調整（負荷の主軸）**: 噴出レートを「目標に対する不足分（headroom）」と `Target` 比でスケールし、
  `liveCount >= targetCap` で打ち止め。これで生存数が上限近くで安定し、`+/-` による負荷比較が取れる。
- **決定的（Math.random 不使用）**: `mulberry32` 固定シードでオーブ軌道・初速方向・バースト数・オート花火の
  着弾位置を生成。マウス無し（オート花火）でも毎回同じ動き＝ベンチ再現性を確保。`R` で乱数を再シード。
- **CPU 更新ループ**: 各生存パーティクルに重力＋減速を適用し、寿命進行 `t = 1 - life/maxLife` で
  `scale = lerp(big, small, t)` / `alpha = 1 - t²`（終盤で急に消える）/ `tint = 暖色→寒色` を毎フレーム書き換える。
- **オーブ軌道**: 中心 + 2 つの正弦（周波数・位相を固定シードで散らす）のリサージュ風。瞬間速度の逆向きを
  少し混ぜて火花が尾を引くようにした。
- **フォールバック**: `particle_spark/smoke/orb/bg_dark.png` を `PIXI.Assets.load` で試行し、失敗時は
  **Canvas の放射グラデ**（中心白→外周透明）で生成したグローテクスチャに差し替え。図形フォールバックでも
  **加算合成は維持**（白基調テクスチャ × tint で暖色〜寒色を表現）。現状アセット未配置のため常にフォールバック起動。

## Codex 生成所感（v8 で大量パーティクル × 加算ブレンドを組む観点）

- **v8 初期化の罠（再掲）**: `new PIXI.Application(opts)` は無視され `app.canvas` が生えない。
  必ず `new PIXI.Application()` → `await app.init(opts)` の2段階。`app.view` も `app.canvas` に改名。
- **ParticleContainer は v8 で API が刷新**: v7 までの「Sprite を入れる ParticleContainer」とは別物で、
  専用の `Particle` オブジェクトを `addParticle` する。`Particle` のプロパティ名は `scaleX/scaleY`・`tint`・
  `alpha`・`anchorX/anchorY`（`scale.set()` や `anchor` オブジェクトは無い）。ここが最大のつまずき。
- **alpha は color に含まれる**: alpha をフェードさせたいのに `dynamicProperties.color` を false にすると
  反映されない。alpha=色パイプラインという点を見落とすと「フェードしない」バグになる。
- **blendMode はコンテナ単位**: パーティクル個別に ADD を指定できないため、ADD/NORMAL 切替は
  コンテナ丸ごとの差し替えになる。要件（`B` 切替）とは綺麗に噛み合うが、「一部だけ加算」はできない。
- **CPU 更新がボトルネック**: 描画自体はバッチで速い一方、数万個になると JS 側の属性書き換えループが
  主負荷になる。`Particle` を常駐させ alpha/座標退避で生死を切り替える（addParticle を毎フレーム叩かない）
  プール戦略が効いた。GPU パーティクル（Babylon/Godot）との `FPS` の落ち方の差が比較の見どころ。
- **HUD を HTML オーバーレイにした利点**: Pixi の `Text` で出すと更新も GPU 負荷に乗るが、HTML `<pre>` を
  被せれば描画計測（FPS / Particles）と HUD 更新が独立する。120ms 間引きで十分滑らか。
- 総じて v8 は「専用 ParticleContainer で描画は軽い・寿命シミュは完全 CPU 自前」という分担が明快で、
  **CPU 更新スループット**を測るベンチ題材として素直だった。GPU パーティクル機構を持たないぶん、
  数万個で CPU 律速になる挙動がそのまま比較軸として出る。
