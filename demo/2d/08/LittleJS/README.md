# テーマ8 パーティクル / 魔法エフェクトデモ ― LittleJS 版

多数のエミッタが加算合成のパーティクル（火花・魔法）を噴き出すエフェクトデモを **LittleJS** で実装したもの。
画面内を決定的な軌道で周回する発光オーブ群を常設エミッタとし、マウスや自動花火で爆発バーストを足して、
**LittleJS 内蔵パーティクル機構（CPU）＋ 加算ブレンドの描画スループット**を測る。

## 起動方法

CDN 読込のため `file://` で直接開いても動くが、`../assets/` の相対参照と
ブラウザのキャッシュ挙動を安定させるため簡易HTTPサーバ経由を推奨。

```bash
# このフォルダ (8/LittleJS) で
python -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く
```

`../assets/` フォルダは空でも起動する（画像欠落時は内蔵タイル/図形グローでフォールバック）。
SPEC のアセット（`particle_spark.png` 等）を `../assets/` に置けば自動で使用される。

## 使用バージョン / CDN

- **LittleJS**（`@latest` 解決時点 / classic global build）
- 主URL: `https://unpkg.com/littlejsengine`
  失敗時フォールバック: `https://cdn.jsdelivr.net/npm/littlejsengine/dist/littlejs.min.js`
- 素の unpkg は classic global build（グローバル `engineInit` 等を生やす版）を解決するため
  `<script>` 直読みできる。読込失敗時のみ `error` イベントを捕捉して jsDelivr ミラーへ切替。

## 操作

| キー / 入力 | 動作 |
|---|---|
| マウス移動 | カーソル位置（`mousePos`）に追従するトレイルエミッタを噴出 |
| 左クリック | クリック地点で 120〜200 個の放射状バースト |
| `Space` | オート花火トグル（ON 中 0.5s 間隔で決定的位置に爆発バースト・マウス不要） |
| `B` | 加算 ⇄ 通常ブレンド切替 |
| `+` / `-`（メイン行 or テンキー） | 目標パーティクル上限を増減（負荷調整・性能比較の主軸） |
| `R` | リセット |

## 仕様数値（全エンジン共通）

| 項目 | 値 |
|---|---|
| キャンバス | 960 x 540 固定 |
| 背景 | 暗色（発光が映えるよう低輝度） |
| パーティクル寿命 | 0.6〜1.4s（基準 1.0s ± randomness 0.4） |
| 寿命変化 | サイズ 大→小（14px→1px）/ alpha 1→0 / 暖色→寒色グラデ |
| 合成 | 加算（additive。`B` で通常に切替可） |
| 常設エミッタ | 周回オーブ 4 個（決定的軌道で連続噴出） |
| バースト | クリック / オート花火で一度に 120〜200 個放射 |
| 目標上限 | 初期 2000・±2000・下限 500・上限 50000 |

## HUD（常時表示・左上, HTML `#hud` overlay）

- `FPS`: 実測の移動平均（エンジン `frameRate` を指数移動平均で平滑化）。
- `Particles`: 現在生存しているパーティクル総数（実測）。
- `Target`: 目標上限（`+`/`-` で変化）。
- `Emitters`: 常設オーブ数 + アクティブなバースト/トレイルエミッタ数。
- `Blend`: `ADD` / `NORMAL`。
- `Mode`: `CPU`（LittleJS パーティクルは CPU 更新 / Canvas・WebGL バッチ描画）。
- `[sprites]` / `[shapes fallback]`: 画像使用かフォールバックかを明示。

## 実装メモ

### パーティクル機構（本テーマの核）

- **LittleJS 内蔵の `ParticleEmitter` / `Particle`** を使用（自前のパーティクル更新は一切書かない）。
  色グラデ（`colorStart`→`colorEnd`）・サイズ（`sizeStart`→`sizeEnd`）・alpha フェード（`fadeRate`）・
  寿命（`particleTime`）・放出角度/速度はすべてコンストラクタ引数で表現する。
- `ParticleEmitter` は `EngineObject` を継承し、エンジンが自動で update/render する。一方
  生成された `Particle` は `EngineObject` では**なく**、各エミッタの `emitter.particles[]` 配列に
  保持される（global `engineObjects` には入らない）。
- したがって `Particles`（生存総数）は、**自分が生成した全エミッタの `particles.length` を合計**して数える
  （`countLiveParticles`）。エンジン全体の単純なオブジェクト数ではこの値は取れない点が LittleJS 特有。
- **加算合成**は `Particle.render()` が `emitter.additive` を毎フレーム参照して `setAdditiveBlendMode()` を
  掛ける仕組み。よって `B` キーでは各エミッタの `.additive` を書き換えるだけでよく、エミッタ再生成は不要。
- 描画は **CPU 更新 + バッチ描画**であり GPU パーティクル機構ではないため `Mode = CPU`。

### 目標上限への追従

- 周回オーブの `emitRate` と各バーストの放出個数を**目標上限に比例してスケール**し、
  実測 `Particles` が `Target` 付近で安定するよう調整する。寿命に幅があるため厳密一致ではなく上限近傍で揺れる。
- パーティクルはエミッタが寿命管理して再利用相当（GC 圧は LittleJS 側が吸収）。

### Y軸 / 座標系

- LittleJS は **Y軸が上向き**。本デモは中央配置の FX デモのため、`cameraScale=1`（1ワールド単位=1px）・
  カメラ中心を画面中央 `(W/2, H/2)` に固定し、「中央原点・px・Y上向き」の一貫モデルで全座標を保持する。
- 周回オーブの軌道は決定的な正弦/円運動。重力等の上下依存物理が無いため Y 符号の罠は最小。
  バーストは全方位放出なので Y 軸の向きに非依存。`mousePos`（Y上向き）をそのまま使うため
  カーソルと発生点が一致し変換不要。

### 決定的生成 / フォールバック

- 周回オーブの軌道パラメータ・オート花火の位置はすべて `mulberry32` の決定的乱数で定義（`Math.random` 不使用）。
- `particle_spark.png` が無くても、内蔵タイル/放射グローの図形で描画して必ず起動する。
  フォールバック時も**加算合成は維持**して発光感を保つ。

## Codex 生成所感（軽量エンジンのパーティクルを書く所感・罠）

- **「パーティクルを自前で書かない」のが LittleJS の強み**。`ParticleEmitter` のコンストラクタ引数だけで
  色/サイズ/寿命/放出角/重力/減衰/加算が全部表現でき、常設オーブ・トレイル・爆発バーストを
  同じ API で量産できる。Phaser/Babylon のような専用 DSL を覚えなくても、引数表を埋める感覚で書けた。
- **最大の罠は「生存数の数え方」**。`Particle` が `engineObjects` に入らないため、素朴に
  「オブジェクト総数」を出すと常に少なく見える。エミッタ配列の `particles.length` を合計する、と
  気づくまでが要点で、ここは LittleJS のソースを読まないと当てづらい（README に明記した）。
- **加算ブレンドのトグルが安い**。`emitter.additive` を毎フレーム参照する設計のおかげで、`B` キーは
  フラグ書き換えだけ。エミッタを作り直さずに ADD⇄NORMAL の描画コスト/見た目差を即比較できる。
- **GPU パーティクルではない**点は正直に CPU と表示した。Babylon の `GPUParticleSystem` や Godot の
  `GPUParticles2D` と並べると、上限を 50000 まで上げたときの FPS の落ち方で「CPU 更新の限界」が
  そのまま観測できるはずで、ベンチ題材としての対照性は良い。
- **HUD は HTML overlay が最も素直**。WebGL レイヤとの重なりを気にせず、行数の多い統計
  （FPS/Particles/Target/Emitters/Blend/Mode）を `white-space: pre` で整形できる。
- 総じて LittleJS は「薄い API を正しく組む」エンジンで、パーティクルに関しては内蔵機構が充実しており、
  自前更新ゼロで大量発光を出せる一方、計測（生存数の取得）はエンジン内部構造の理解が要る、という配分だった。
