# テーマ11 2Dダイナミックライティング / 影 ― KAPLAY 版

暗いトップダウンの部屋を、プレイヤーの灯りと多数の動的な色付き光源が照らし、矩形の柱（オクルーダ）が**影**を落とす
ライティングベンチ。**多数の動的光源 ＋ ライトマップ合成（加算→乗算）＋ 影生成**を同時に回し、
「同時光源数」と「影 ON/OFF の描画コスト差」を測る。テーマ8（加算ブレンドのパーティクル発光）とは別軸の、
**光のボリューム・遮蔽影・ブレンド経路**の比較。

## 起動方法

```bash
# テーマフォルダ (11/) をルートに HTTP サーバを立てる
cd 11
python -m http.server 8000
# → http://localhost:8000/KAPLAY/
```

`../assets/` が空でもフォールバック描画で必ず起動します（`file://` 直開きは画像が CORS で読めないため HTTP 推奨）。

## 使用バージョン / CDN

- KAPLAY **3001.0.19**（CDN: `https://unpkg.com/kaplay@3001.0.19/dist/kaplay.js`）
- `kaplay({ global: false })` で名前空間 `k.*` を明示利用。`canvas` に `#game-canvas` を割り当て。
- 追加ライブラリなし。ライティングは**自前のライトマップ合成**（オフスクリーン 2D canvas の加算 → CSS `mix-blend-mode: multiply` で乗算合成）。

## 操作

| キー | 動作 |
|---|---|
| `W`/`A`/`S`/`D` または 矢印 | プレイヤー（＝白色光源 半径240）を移動（220 px/s, 壁/柱で停止）|
| `+` / `-` | 動的光源の数を 6 ずつ増減（性能比較の主軸）|
| `L` | 影 ON / OFF 切替 |
| `R` | リセット |

## 仕様数値（全エンジン共通）

| 項目 | 値 |
|---|---|
| キャンバス / タイル | 960 x 540 / 32px（部屋 30 x 17）|
| ambient | 0.10 |
| プレイヤー光源 半径 / 速度 | 240 / 220 px/s |
| 動的光源 半径 / 速度 | 160 / ~120 px/s 相当の決定的軌道 |
| オクルーダ | 矩形・約16個 + 外周壁 |
| 動的光源数 | 初期 12・±6・下限 0・上限 120 |

## HUD（HTML `<pre id="hud">` overlay・左上固定）

- `FPS`（実測・移動平均）/ `Lights`（現在 / 上限・＋プレイヤー）/ `Occluders` / `Shadows`(ON/OFF) /
  `Mode`(`Lightmap(canvas add → CSS multiply)`) / `Ambient`(0.10)。
- 画面下に操作ヒント行（HTML 側 `#help`）。

## 実装メモ

### ライトマップ合成（描画の核）

KAPLAY は「全部入り」の 2D ゲームライブラリ。床/柱/プレイヤーの描画・ゲームループ・入力・AABB は
すべて KAPLAY 機構（`k.add` / `k.onUpdate` / `k.onDraw` / `k.isKeyDown`）で組む。
一方ライトマップ生成は **per-light のバッファ往復**（光源ごとにスクラッチへ放射グローを描き、影ポリゴン(黒)で
光を削り、全体バッファへ加算）が核で、これは中間バッファ（オフスクリーン RenderTexture）と
`destination-out`/`lighter` 系の合成を要する。

- **KAPLAY が表現しづらい点**: KAPLAY の宣言的な `onDraw` 経路だけでは「中間バッファへ描いて読み戻し、
  別バッファへ加算する」というスクラッチ往復を素直に書けない（KAPLAY は RenderTarget をピンポンする
  ローレベル API を公開していない）。
- **近似 / 実装方針**: ライトマップ**生成段**は ★オフスクリーンの 2D canvas★ で「正直に」実装する。
  1. `lightmap` canvas を ambient(0.10) の灰でクリア。
  2. 各光源について `scratch` canvas をクリア → 放射グラデ描画 → 影 ON なら影ポリゴン(黒)を `source-over`
     で塗って光を削る → `scratch` を `lightmap` へ **`'lighter'`（加算）** 合成。
  3. 完成した `lightmap` canvas を、KAPLAY キャンバス（`#game-canvas`）の**真上に DOM オーバーレイ**として
     重ねる（`#game-canvas` の直後・HUD より下に挿入）。canvas 要素は表示と描画を兼ねるので毎フレームの
     焼き直しは不要。
- **合成段は CSS multiply**: オーバーレイした `lightmap` canvas に `mix-blend-mode: multiply` を指定し、
  ブラウザネイティブの乗算で背後の KAPLAY シーン（床＋柱＋プレイヤー）へ重ねる。→「加算でライトマップ生成」は
  2D canvas、「乗算でシーンへ合成」は CSS、と役割を分担する。
  - **なぜ KAPLAY-native でないか**: KAPLAY **3001.0.19** は乗算ブレンド（`BlendMode.Multiply` / `drawSprite` の
    `blend`）を公開していない（`k.BlendMode` 自体が `undefined`）。乗算合成だけは CSS に逃がした。

### 影（ハードシャドウ）

光源から見た矩形オクルーダの**シルエット辺**（外向き法線が光源と逆を向く辺）の2端点を、光源から遠ざかる
方向へ `SHADOW_FAR = W+H` 延長して影ポリゴン(四角形)を作り、`scratch` canvas に黒で塗って光を削る。
光源が矩形内部にある場合は影なし。仕上げに柱本体も黒で塗り内部を照らさない。光源数ぶんのバッファ往復が
「影 ON」のコスト＝比較対象。`L` で OFF にすると放射光のみの加算で軽くなる。

### 決定的生成 / フォールバック

- 柱配置・光源軌道・色は `mulberry32` の決定的乱数（`Math.random` 不使用）。`hsv2rgb` で色付き光源を決定的に割当。
- アセットは `k.loadSprite` を個別 try/catch。失敗時は KAPLAY の `k.rect`/`drawRect` 等の図形フォールバックへ切替。
  放射グローは canvas の `createRadialGradient` で生成するため `light_glow.png` が無くても必ず点灯する。

## Codex / AI コーディング所感

- KAPLAY は床/柱/プレイヤーの宣言・入力・ループは非常に素直で、AI も安定して書ける（テーマ1系と同じ勘所）。
- 罠は**「中間バッファを使うライトマップ」と「乗算ブレンドの欠如」**。KAPLAY は RenderTarget をピンポンする
  ローレベル API を素直に公開しておらず、さらに **3001.0.19 は乗算ブレンドを持たない**（`k.BlendMode` が
  `undefined`、`drawSprite({ blend: ... })` に Multiply 相当が無い）。AI が「`BlendMode.Multiply` で重ねる」と
  書くと `Cannot read properties of undefined (reading 'Multiply')` で起動ごと落ちる（実際にこの罠を踏んだ）。
- 本実装は **「生成は 2D canvas、乗算合成は CSS `mix-blend-mode: multiply` のオーバーレイ」** という割り切りで、
  KAPLAY にはシーン（床/柱/プレイヤー）描画・ループ・入力・AABB を担わせつつ、正しい絵を出した。
  ここを明示しないと AI は「全部 KAPLAY の描画 API で」と無理をして詰まりやすい。
- 入力の罠: KAPLAY の `onKeyPress` のキー名は `event.key` ベース。`'kpadd'`/`'minus'` といった独自名は
  発火しない。`'='`/`'+'`（増）・`'-'`（減）で受ける（`'+'` は Shift+`=` とテンキー + の両方が届く）。
