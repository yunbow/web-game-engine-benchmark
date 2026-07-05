# テーマ13: 大量動的テキスト / UI 描画 ― Babylon.js 版

画面いっぱいに多数のテキストラベルが流れ、各ラベルの数値部分が刻々と更新される
「システムログ / データダッシュボード」風デモを **Babylon.js** で実装したもの。
測定軸は **(1) 画面上のテキストオブジェクト数 N** と **(2) 毎フレーム文字列を作り直すか否か (Update ON/OFF)**。
Babylon は3Dエンジンのため正射影(Orthographic)カメラで 960x540 の 2D 画面を再現し、
テキストは **GUI の `TextBlock`** と **`DynamicTexture` への自前 `fillText`** の2方式を実装して
`B` キーで切り替え、両者の「崖」を直接比較できるようにした。

## 起動方法

アセット不要・CDN 読込なので、`index.html` をブラウザで直接開くだけで動く
（`file://` でも CDN さえ取得できれば起動する）。確実に動かすならローカル HTTP サーバ経由を推奨。

```bash
cd c:/work/claude/local-works/web-game/13
python -m http.server 8000
# ブラウザで http://localhost:8000/Babylon.js/ を開く
```

または VS Code の Live Server などでも可。

## 使用バージョン

- Babylon.js: CDN 最新版 (`https://cdn.babylonjs.com/babylon.js`)
- Babylon.js GUI: `https://cdn.babylonjs.com/gui/babylon.gui.min.js`
  - **重要**: ベースの `babylon.js` バンドルには GUI モジュール (`BABYLON.GUI`) が**含まれない**。
    `TextBlock`/`AdvancedDynamicTexture` を使うには GUI スクリプトを追加で読み込む必要がある。
- 追加ビルド・依存・外部フォントアセットなし。`index.html` + `game.js` の2ファイルのみ。

## 操作

| キー | 動作 |
|---|---|
| `+` / `-` | テキストアイテム数を ±100（下限 0・上限 5000） |
| `U` | 文字列の毎フレーム更新 ON/OFF（dynamic ⇄ static） |
| `B` | テキスト機構の切替（**GUI TextBlock ⇄ Canvas DynamicTexture**） |
| `R` | リセット（N=200・dynamic・time/frame を初期化） |

## 仕様準拠（数値）

- キャンバス **960x540** 固定。背景は暗色 `#0b0d16`。デルタタイム基準（上限 0.05s でクランプ）。
- テキストアイテム数 `N`: 初期 **200**、`+`/`-` で **±100**、下限 **0**・上限 **5000**。
- 配置・動き・色・サイズ・基準文字列はすべて固定シード `mulberry32(0x13ABCD)` で**決定的**生成（`Math.random` 不使用）。
  無入力でも回り続け、`R` で必ず同じ初期状態に戻る。
- 各アイテムは画面内を決定的に流れる（半数が**下スクロール優勢**・半数が**左右バウンド優勢**）。
  画面外に出たら反対側から**ラップ**。フォント **11〜20px**、色は 10 色パレットから割当。
- 文字列は `"OBJ#0042 v=137"` 形式（**8〜20文字程度**）。`OBJ#` + 4桁通し番号が固定ラベル、
  `v=` の後ろが**毎フレーム再計算される数値**（位相をずらしたノコギリ波で 0..999）。
- **Update = ON（dynamic, 既定）**: 毎フレーム各アイテムの数値を再計算し文字列を作り直す（再レイアウト経路）。
- **Update = OFF（static）**: 文字列は据え置きで位置だけ動かす（各方式の内部キャッシュが効く）。
- 画面右上に**常時更新される複数行の統計パネル**（frame / time / texts / chars / mode / update）を1つ置き、
  多行の動的テキスト再レイアウトも踏ませる。採用中の方式と同じ機構で描画する。

## HUD（HTMLオーバーレイ, 約0.1s更新）

Babylon 側のテキスト描画コストと HUD 更新コストを分離するため、HUD は HTML オーバーレイ（キャンバス外）。

- `FPS`（指数移動平均）
- `Texts`（現在の N / 上限 5000）
- `Chars`（概算の総グリフ数 = 直近フレームで集計した全アイテム文字数の合計）
- `Render`（使ったテキスト機構: `GUI TextBlock` / `Canvas DynamicTexture`）
- `Update`（`dynamic` = 毎フレーム文字列更新 / `static`）
- 操作ヒント行

## 実装メモ ― 2つのテキスト機構と、その崖

Babylon でテキストを描く「素直な選択肢」は2つあり、本テーマはどちらも実装して `B` で比較できる。

### 方式1: GUI `TextBlock`（既定 / Babylon のイディオム）

- `BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI()` を1枚作り、`TextBlock` を
  **最大 5000 個までプール**（遅延生成）して `addControl`。`N` の増減は可視数 (`isVisible`) を
  変えるだけで、毎フレームの生成/破棄はしない。
- 各 TextBlock は `HORIZONTAL/VERTICAL_ALIGNMENT_LEFT/TOP` 固定で、`left`/`top` の px オフセットが
  そのまま画面 px に一致する（ADT が描画キャンバス 960x540 に 1:1 で張り付くため。
  `idealWidth/Height` は**あえて設定しない** ― 設定すると座標スケールがずれて配置が崩れる）。
- **崖**: `tb.text = ...` への代入は ADT を dirty にし、フレーム末に
  **ADT 全体が1枚のテクスチャへ再ラスタライズ**される。1個でも文字列が変われば、
  実質「全 TextBlock のレイアウト + グリフ描画」が走るに近い挙動になる。
  → **Update=ON ＆ N が大きいほど急速に重くなる**。これが GUI 方式の崖。
- **Update=OFF** のとき、`tb.text !== it.text` の場合のみ代入する（同値はスキップ）。
  文字列が変わらないので dirty が立たず、位置だけ動かす（`left`/`top` 変更）コストに落ちる。
  ただし座標変更も再ラスタライズ要因になり得るため、Canvas 方式ほどは軽くならない。

### 方式2: Canvas `DynamicTexture`（自前 `fillText`）

- **960x540 の `DynamicTexture` を1枚だけ**持ち、その 2D コンテキストに毎フレーム
  `clearRect` → 全アイテムを `fillText` で描画 → `dynTex.update()` で **GPU へ1回だけアップロード**。
- 表示は `BABYLON.Layer`（フルスクリーン前景レイヤー）にそのテクスチャを貼るだけ。
  カメラ/ジオメトリ非依存でスクリーン空間に 1:1 で出るため、板ポリの向き調整が要らず堅牢
  （DynamicTexture の canvas 左上原点が画面左上に一致して直立表示される）。
- **コスト構造**: 「`ctx.fillText` を N 回 ＋ テクスチャ転送1回」。GUI のような
  オブジェクト単位のレイアウト/dirty 伝播が無いぶん、**動的更新時に GUI より素直にスケール**する。
  font/fillStyle の切替を直前値と比較して減らす最適化を入れてある。
- **崖**: N が増えると単純に `fillText` 回数がボトルネック（CPU のラスタライズ）。
  さらに 960x540 テクスチャの GPU 転送が毎フレーム発生するので、巨大解像度では転送も効く。
  ただしテキストのキャッシュは持たないので **Update ON/OFF の差は GUI より小さい**
  （OFF でも結局 `fillText` を打ち直すため。OFF 時に静的テクスチャを1回だけ焼く最適化は未実装）。

### どちらが速いか（傾向）

- **Update=ON（動的・本テーマの主軸）**では、概ね **DynamicTexture 方式の方が高 N まで粘る**。
  GUI は「文字列が変わる→ADT 全体の再ラスタライズ」というオブジェクト指向のオーバーヘッドを毎フレーム払うため。
- **Update=OFF（静的）**では **GUI 方式が有利**になりやすい。文字列が変わらなければ ADT の
  テクスチャがキャッシュされ再ラスタライズが走らず、位置移動分のコストに収まるから。
  DynamicTexture 方式は静的でも `fillText` を毎フレーム打ち直すので軽くならない。
- N の崩れ始め（実機 GPU での目安。あくまで相対比較用）:
  - GUI TextBlock ＋ dynamic: 数百 (おおむね 300〜800) 個あたりから FPS が落ち始める。
  - DynamicTexture ＋ dynamic: 1000 個前後までは比較的粘り、その先は `fillText` の CPU コストで頭打ち。
  - static にすると GUI 側は大きく改善し、DynamicTexture 側はほぼ不変、という非対称が観測できる。
- （注意）ヘッドレス/ソフトウェア GL 環境では両者とも FPS が極端に低く出るため、
  方式間の優劣は**実 GPU のブラウザ**で比較すること。

## Codex 生成所感 ― Babylon で「大量動的テキスト」を書く

- **最初の落とし穴は「GUI モジュールが別ファイル」**。`babylon.js` だけ読み込んで `BABYLON.GUI` が
  `undefined` になるのは定番の罠で、`babylon.gui.min.js` の追加読込が必須（SPEC でも明示）。
- **テキストの“素直な選択”が1つに定まらない**のがこのエンジンの面白いところ。GUI `TextBlock` は
  イディオムだが「.text 代入→ADT 全面再ラスタライズ」という重い経路を持つ。一方
  DynamicTexture へ自前 `fillText` する方式は 2D Canvas をそのまま GPU に貼るだけで、
  大量・動的では往々にしてこちらが速い。**本テーマの比較軸はまさにこの差**なので両方実装した。
- **GUI の座標系でハマった**。`AdvancedDynamicTexture` に `idealWidth/Height` を設定すると
  座標がスケールされ配置が画面の一部に固まる。fullscreen ADT は描画キャンバスに 1:1 で
  張り付くので ideal を**指定しない**のが正解で、`LEFT/TOP` アライメントなら `left`/`top` の px が
  そのまま画面 px になる（中心補正を入れると下半分が画面外へ消える）。
- **DynamicTexture の上下反転問題は Layer で回避**。板ポリに貼ると ortho カメラ(y 下向き)と
  テクスチャ v 方向の食い違いで上下反転やミラーが起きやすい。`BABYLON.Layer` はスクリーン空間に
  テクスチャを直接貼るためカメラ/面の向きに依存せず直立表示でき、堅牢だった。
- **プールが効くのは GUI 側だけ**。GUI は TextBlock の生成/破棄が高コストなのでプール必須。
  DynamicTexture 方式は「描く対象データ」を持つだけでオブジェクトを作らないので、そもそも
  プールの概念が要らない（=これも軽さの一因）。
- 総じて、Babylon は「テキストをどう出すか」で性能特性が大きく変わるエンジンで、
  GUI の利便性と DynamicTexture の素の速さのトレードオフが、性能ベンチ題材として素直に効く。
