# テーマ8: パーティクル / 魔法エフェクトデモ ― Babylon.js 版

多数のエミッタが**加算合成**のパーティクル（火花・魔法）を噴き出すエフェクトデモを
**Babylon.js** で実装したもの。2Dデモだが Babylon は3Dエンジンのため、**正射影
(Orthographic)カメラ**で 2D スクリーン座標を再現し、その平面上にパーティクルを噴く。
「**Babylon 推奨のパーティクル機構（できれば GPU）と加算ブレンドの描画スループット**」を
測るのが主眼。性能比較の核は **画面上の生存パーティクル総数**（`Σ system.getActiveCount()`）。

## 起動方法

`../assets/` を相対パスで読むため、ローカルHTTPサーバ経由で開く（file:// でも起動はするが
画像が読めず DynamicTexture のグローにフォールバックする）。

```bash
# このフォルダ (8/Babylon.js) の1つ上 (8/) で実行すると ../assets も配信される
cd c:/work/claude/local-works/web-game/8
python -m http.server 8000
# ブラウザで http://localhost:8000/Babylon.js/ を開く
```

または VS Code の Live Server などでも可。
画像アセットが無い環境でも **DynamicTexture で放射状グローを生成**して必ず起動する。

## 使用バージョン

- Babylon.js: CDN 最新版 (`https://cdn.babylonjs.com/babylon.js`)
- 追加ビルド・依存なし。`index.html` + `game.js` の2ファイルのみ。

## 操作

| 操作 | 動作 |
|---|---|
| マウス移動 | カーソル追従トレイルエミッタ（画面外では停止） |
| 左クリック | 着弾点で **120〜200 個**の放射バースト |
| `Space` | オート花火トグル（ON 中 **0.5s 間隔**で決定的位置にバースト, マウス不要） |
| `B` | ブレンド切替（**加算 ADD ⇄ 通常 NORMAL**） |
| `+` / `-` | 目標同時パーティクル上限を **±2000**（下限 500・上限 50000） |
| `R` | リセット |

## 使用したパーティクル機構（GPU / CPU）

- **`GPUParticleSystem.IsSupported` が `true` なら `BABYLON.GPUParticleSystem` を優先採用**。
  WebGL2 と Transform Feedback が無い環境では `IsSupported === false` になるので、その場合は
  **`BABYLON.ParticleSystem`（CPU）に自動フォールバック**する。どちらを使ったかは HUD の
  `Mode`（GPU / CPU）に表示する。
- どちらの実装も同一の `createSystem()` ファクトリで生成し、見た目（テクスチャ・寿命・色/
  サイズグラデ・ブレンド）を共通設定 `applyCommonLook()` で揃えてあるため、GPU/CPU の差は
  **更新コストと描画スループットだけ**になり、横並び比較がしやすい。
- **加算合成**は全システムで `blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD`。`B` キーで
  `BLENDMODE_STANDARD`（通常アルファ）と相互切替し、描画コスト/見た目を比較できる。

### エミッタ構成

| システム | 種別 | 役割 |
|---|---|---|
| `orb0..3` | PointEmitter（連続） | 決定的軌道で周回する **4 個の発光オーブ**。連続スパーク噴出 |
| `trail`   | PointEmitter（連続） | マウス追従トレイル（`mouse.inside` が false の間 `emitRate=0`） |
| `burst`   | SphereEmitter（バースト） | クリック/オート花火の放射爆発。`manualEmitCount` で一括放出 |

## 仕様準拠（数値）

- キャンバス **960x540** 固定。背景クリアカラー **#08080f**（暗色, 発光が映える）。
- 時間はデルタタイム基準（`engine.getDeltaTime()/1000`, 上限 0.05s でクランプ）。
- 周回オーブの軌道は固定シード mulberry32（`0x0B12`）の楕円＋正弦ゆらぎで**決定的**。
  マウス無しでも常にパーティクルが流れる（ベンチ安定）。
- 各パーティクル: 寿命 **0.6〜1.4s**、初速はランダム方向（決定的 PRNG）、軽い重力（下向き
  120 px/s²）。寿命に沿って **size: 大→小**（`addSizeGradient`）、**alpha: 1→0** ＋
  **色: 暖色（白〜橙）→ 寒色（青紫）→ 透明**（`addColorGradient`）。加算合成で重なるほど明るい。
- 常設オーブは**連続レート噴出**、クリック/オート花火は**一度に 120〜200 個**の放射バースト。
- 目標同時パーティクル上限 初期 **2000**、`+`/`-` で **±2000**（下限 **500**・上限 **50000**）。
- オート花火: `Space` で ON/OFF。ON 中 **0.5s 間隔**で固定シード（`0xF17E`）の決定的位置に爆発。

## 目標数 → emitRate / capacity の制御

性能比較の主軸（SPEC）は「`Particles` 実測値が**目標上限付近で安定**する」こと。本実装は
emitRate と capacity の両輪で目標値に寄せる。

- **emitRate（生成レート）**：連続噴出系の定常生存数は概ね `live ≒ Σ(emitRate) × 平均寿命`。
  平均寿命 ≈ 1.0s なので `Σ(emitRate) ≈ 目標` を狙い、目標の **約 85%** を連続噴出（オーブ
  75% ＋ トレイル 25%）に配分する（残り 15% はバースト分の余地）。`applyTargetCap()` で実装。
- **capacity（最大同時数）**：`ParticleSystem`/`GPUParticleSystem` の `capacity` は**生成時固定**で
  後から変更できない。そのため目標を大きく上げて capacity が不足する場合は、設定を引き継いで
  **システムを作り直す**（`rebuildSystemCapacity()`）。再生成の頻発を避けるため目標を 2000 刻みの
  tier に量子化し、tier が上がったときだけ確保し直す。

## HUD（HTMLオーバーレイ, 約0.1s更新）

- `FPS`（指数移動平均）
- `Particles`（現在生存しているパーティクル総数 = `Σ system.getActiveCount()`）/ `Target`（目標上限）
- `Emitters`（常設オーブ数 + トレイル + アクティブバースト）
- `Blend`（ADD / NORMAL）/ `Mode`（GPU / CPU いずれを使ったか）
- `Texture`（`particle_spark.png` 読込成功 / `DynamicTexture(glow)` フォールバック）
- 画面下に操作ヒント行。

## アセット / フォールバック

`../assets/` から `particle_spark.png`（火花・中心白の放射状グロー前提）を読み込む。
**画像が無い場合**は `BABYLON.DynamicTexture` に `createRadialGradient` で中心=白(不透明)→
外周=透明 のグローを描いて代替する（加算合成前提）。起動時に `new Image()` で URL を試し
（`checkImage()`）、成否で切替える。`particle_smoke.png` / `orb.png` / `bg_dark.png` は
本実装では未使用（オーブ本体は描かずパーティクルのみで発光感を出す方針）。

## 実装メモ ― Babylon パーティクルで加算ブレンド大量描画

- **正射影カメラで 2D スクリーンを再現**：`orthoLeft/Right/Top/Bottom` を `0..960 / 0..540` に
  設定し（`orthoTop < orthoBottom` で y 下向き）、エミッタ座標 = 画面 px を 1:1 で対応させた。
  パーティクルは `z=0` 平面に噴くので奥行きは使わない。重力は y 下向き（+y）の純 2D。
- **GPU 優先 + CPU フォールバック**：`GPUParticleSystem.IsSupported` を boot 時に1回判定し、
  `createSystem()` がどちらを new するかを切り替える。API（`emitRate` / `manualEmitCount` /
  `addColorGradient` / `addSizeGradient` / `blendMode` / `getActiveCount`）はほぼ共通なので、
  本デモのロジックは GPU/CPU を区別せず書ける。これが Babylon の素直な選択。
- **バーストは `manualEmitCount`**：連続噴出（`emitRate`）とは別に、`start()` 済みのシステムへ
  `manualEmitCount` を加算すると次フレームでその数を一括放出する。1 個のバーストシステムを
  使い回し、放出地点（`emitter`）だけ動かして 120〜200 個を出す＝**プール再利用**に相当し
  生成/破棄の GC を避ける。同フレームに複数爆発しても加算で取りこぼさない。
- **`capacity` 生成時固定の壁**：emitRate はいつでも変えられるが capacity は変えられない。
  目標 50000 まで対応するには大きめに確保するか作り直すしかない。本実装は tier 化して必要時
  だけ再生成する折衷にした。常時 50000 確保しっぱなしにしないことでメモリ/初期化コストを抑える。
- **加算合成のチューニング**：`BLENDMODE_ADD` ＋ 中心白グローのテクスチャだと、重なった領域が
  白飛びして「魔法・火花」らしい発光になる。色グラデは alpha を 1→0 で落とすことで、加算でも
  寿命末に自然消滅する（加算は通常 alpha で隠れないため、テクスチャ側の減衰と色 alpha の両方で
  フェードさせるのがコツ）。

## Codex 生成所感 ― Babylon でパーティクルベンチを書く

- **「推奨機構をそのまま使う」のが一番効く題材**。テーマ5（自前物理）と違い、本テーマは
  Babylon の `ParticleSystem` / `GPUParticleSystem` がほぼ要件をカバーする。エミッタ形状
  （Point/Sphere）・寿命・色/サイズグラデ・重力・ブレンドが宣言的に揃っており、自前で
  パーティクル配列を回す必要がない。GPU 版は更新が GPU 側に乗るので、CPU 版との `FPS` の
  落ち方の差が大量時にそのまま比較対象になる。
- **GPU/CPU を 1 ファクトリに隠せるのが Babylon の強み**。`IsSupported` ゲートさえ通せば
  あとは同じ API。比較ベンチとして「実装差を最小化して描画パスだけ替える」が容易だった。
- **詰まったのは capacity が後から変えられない点**。目標数を動的に増やす UI（`+`/`-`）と
  capacity 固定の相性が悪く、再生成（設定引き継ぎ）で回避した。emitRate だけで「生存数を目標に
  寄せる」のは `live ≒ emitRate × 寿命` の近似で十分実用になった（HUD で実測が目標付近に収束）。
- **加算ブレンドのフェード**は最初ハマりやすい。加算は alpha で「隠れない」ので、色グラデの
  alpha を落とすだけでなくテクスチャ自体を放射減衰グローにして、寿命末に発光が薄れるよう
  両面でコントロールした。DynamicTexture フォールバックでも同じ見え方を維持している。
