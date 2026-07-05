# テーマ11 2Dダイナミックライティング / 影 ― Phaser 4 版

暗いトップダウンの部屋を、プレイヤーの灯りと多数の動的な色付き光源が照らし、矩形の柱（オクルーダ）が**影**を落とす
ライティングベンチ。**多数の動的光源 ＋ ライトマップ合成（加算→乗算）＋ 影生成**を同時に回し、
「同時光源数」と「影 ON/OFF の描画コスト差」を測る。テーマ8（加算ブレンドのパーティクル発光）とは別軸の、
**光のボリューム・遮蔽影・ブレンド経路**の比較。

## 起動方法

```bash
# このフォルダ (11/Phaser4/) で
python -m http.server 8000
# → http://localhost:8000/ をブラウザで開く
```

アセット画像が無くてもフォールバック描画（床=暗灰タイル / 柱=灰矩形 / 光=放射グラデ生成 / プレイヤー=人型+灯り）で必ず起動します。

## 使用バージョン / CDN

- Phaser **4**（CDN: `https://cdn.jsdelivr.net/npm/phaser@4/dist/phaser.min.js`）
- 追加ライブラリなし。`index.html` + `game.js` のみ。
- ライティングは**自前のライトマップ合成**（オフスクリーン 2D canvas の加算 → `CanvasTexture` を `MULTIPLY` ブレンドの `Image` でシーンへ乗算。ライト専用プラグインは不使用）。

## 操作

| キー | 動作 |
|---|---|
| `W`/`A`/`S`/`D` または 矢印 | プレイヤー（＝白色光源 半径240）を移動（220 px/s, 壁/柱で停止）|
| `+` / `-`（テンキー可）| 動的光源の数を 6 ずつ増減（負荷調整・性能比較の主軸）|
| `L` | 影 ON / OFF 切替（影なし＝放射光のみで軽い）|
| `R` | リセット |

## 仕様数値（全エンジン共通）

| 項目 | 値 |
|---|---|
| キャンバス / タイル | 960 x 540 / 32px（部屋 30 x 17）|
| ambient（下地）| 0.10 |
| プレイヤー光源 半径 / 速度 | 240 / 220 px/s |
| 動的光源 半径 / 速度 | 160 / ~120 px/s 相当の決定的軌道 |
| オクルーダ（柱）| 矩形・約16個 + 外周壁（決定的配置）|
| 動的光源数 | 初期 12・±6・下限 0・上限 120 |

## HUD（左上, `setScrollFactor(0)` 固定）

- `FPS`（実測・移動平均）
- `Lights`（動的光源数 現在 / 上限。＋プレイヤー光源を別表記）
- `Occluders`（影を落とす柱の数）
- `Shadows`（ON / OFF）
- `Mode`（`Lightmap(canvas add → CanvasTexture Multiply)`）
- `Ambient`（0.10）
- 画面下に操作ヒント行。

## 実装メモ

### ライトマップ合成（描画の核）

> **Phaser 4.2 の注意**: `RenderTexture` / `DynamicTexture` の **オフスクリーン `draw()`・`stamp()` が機能しない**
> （描いても空テクスチャになる）。そのため当初の「sceneRT / lightRT / scratchRT を RT で往復」する実装は
> 床も光も出ず真っ黒になる。本実装は **ライトマップ生成を 2D canvas に逃がし、合成だけ Phaser の表示ブレンド**で行う。

1. **シーン**（暗い床タイル＋柱＋外周壁）を Phaser の通常 `Image`（`depth 0/1`）として置く。
2. **ライトマップ本体**＝オフスクリーン **2D canvas**（`lmCanvas`）を `ambient`（0.10 の灰）でクリア。
3. **光源ごと**に、使い回す **scratch 2D canvas**（`scCanvas`）で:
   - クリア → `createRadialGradient` の放射グローを色付きで描く。
   - **影 ON なら**、その光源から見た各矩形オクルーダの**シルエット辺**の端点を光源から遠方へ延長した**影ポリゴン**を
     **黒**で塗り、光を削る（ハードシャドウ）＋柱本体も黒で塗る。
   - scratch を `lmCanvas` へ **`'lighter'`（加算）** で積む。
4. 完成した `lmCanvas` を **`CanvasTexture`**（`textures.addCanvas` → 毎フレーム `refresh()`）化し、
   それを **`BlendModes.MULTIPLY` の `Image`（`depth 5`）** としてシーン（`depth 0/1`）とプレイヤー（`depth 2`）の上に
   重ねて**乗算合成**する。HUD（`depth 1000`）は乗算の上なので影響を受けない。照らされた所だけ床/柱が見え、影/未照は沈む。

→ **光源数ぶんの scratch 往復＋影ポリゴン生成**が「影 ON」のコストで、これが比較の主軸。`L` で影を切ると
放射光の加算のみになり軽くなる。`shadowPolyCount` で生成した影ポリゴン数を把握できる。

### 決定的生成 / フォールバック

- 柱配置・動的光源の軌道・色はすべて `mulberry32` の決定的乱数（`Math.random` 不使用）。
- 放射グローは scratch canvas の `createRadialGradient` で毎回生成するため `light_glow.png` は不要（光は必ず点灯）。
  床/柱/プレイヤーのテクスチャは欠落時に `Graphics.generateTexture` の図形フォールバックへ切替。

## Codex 生成所感（自前ライトマップを描画ライブラリ上で組む所感）

- **最大の罠は Phaser 4.2 の `RenderTexture`/`DynamicTexture` のオフスクリーン描画が機能しない点**。AI は素直に
  「sceneRT に焼く → scratchRT で光を作る → lightRT に ADD → MULTIPLY で表示」と Phaser 3 流の RT パイプラインを
  書くが、4.2 では `draw()`/`stamp()` が空テクスチャになり**床も光も出ず真っ黒**になる（実際にこの罠を踏んだ）。
  さらに別の罠として、`RenderTexture.draw(entries, x, y, alpha, tint)` の第5引数は **tint** であり、ここに
  `BlendModes.ADD`(=1) を渡すと黒 tint で塗り潰す。ブレンドはソースオブジェクト側に `setBlendMode` するのが正。
- **回避策＝「生成は 2D canvas、合成だけ Phaser」**。ライトマップを 2D canvas で正直に組み（`'lighter'` 加算・影は
  黒ポリゴン）、完成画像を `CanvasTexture`（`refresh()`）化して `MULTIPLY` の `Image` で重ねる。`CanvasTexture` の表示・
  `MULTIPLY` 表示ブレンド・毎フレーム `refresh()` は 4.2 でも正しく動く（検証済み）。
- **コストの所在が HUD に出しやすい**。光源数ぶんの scratch 往復が支配的なので、`+/-` と `L` で FPS が素直に動き、
  「ネイティブ2Dライト（Godot）」と「自前ライトマップ（Phaser/Pixi/LittleJS/Babylon）」の差を観測する題材として扱いやすい。
- Phaser には Light2D パイプライン（法線マップ対応）もあるが、本テーマは「影込みのライトマップ合成コスト」を
  全エンジンで揃えて比較したいので、あえて自前ライトマップにした。Light2D を使うと影（遮蔽）の表現が別物になり、
  Godot のネイティブ影との比較がしやすい一方、Phaser 同士の他テーマとの一貫性は自前の方が保てた。
