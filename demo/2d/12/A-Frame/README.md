# テーマ12 フォーリングサンド / セルオートマトン ― A-Frame 版

砂・水・壁のセルが落下・堆積・流動する「フォーリングサンド」型のセルオートマトンを
**A-Frame 1.7.0** で実装。`COLS×ROWS` の格子をセル単位で更新し、**毎フレーム全面の RGBA
ピクセルバッファを生成して 1 枚のテクスチャへアップロード**、960×540 へニアレスト拡大表示する。
ベンチの核は「**グリッド解像度（セル数）＝ 1 フレームあたりのセル更新数 ＋ テクスチャ転送量**」。

正準リファレンスは `../PixiJS/game.js`。シミュレーション規則・定数・色は全エンジンで同一。

## 起動方法

ローカルに HTTP サーバを立ててブラウザで開く（CDN 読込）。

```bash
# このフォルダ(12/A-Frame/)の1つ上(12/)で実行
cd c:/work/claude/local-works/web-game/12
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

**アセットは不要**（セルの色はコードで定義し、毎フレーム生成する）。

## 使用バージョン

- A-Frame **1.7.0**（CDN: `https://aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は
  **`AFRAME.THREE`**。
- シーンは `index.html` に `<a-scene embedded vr-mode-ui="enabled:false">` として宣言し、
  ゲーム本体は登録した **`sand-game` コンポーネント**が駆動する。

## 使ったテクスチャ更新機構（本テーマの肝）

**`DataTexture + needsUpdate`（`AFRAME.THREE` 経由）**

1. グリッドサイズ `COLS×ROWS` の **`THREE.DataTexture`（RGBA・`UnsignedByteType`）** を 1 枚用意。
   バッキングは `Uint8Array(COLS×ROWS×4)`。（`THREE` は `AFRAME.THREE` を使用）
2. 毎フレーム `tick` 内で、その **`image.data`** へ全セルの色を直書きする
   （砂色/水色/壁色/背景色 ＋ 決定的な濃淡）。
3. **`texture.needsUpdate = true`** をセットし、A-Frame（three.js）の描画時に GPU へ再アップロード。
4. フィルタは `magFilter / minFilter = NearestFilter`、`generateMipmaps = false`。
5. 全画面の `PlaneGeometry(960, 540)` にこのテクスチャを `MeshBasicMaterial.map` で貼り、
   2D 用 `OrthographicCamera(0, W, H, 0)` で画面いっぱいに拡大表示する。

→ 「**`COLS×ROWS×4` バイトの RGBA を毎フレーム生成 ＋ GPU 転送**」が、まさに測られるコスト。
HUD の `Upload` 行に機構名と 1 フレームあたりの転送量（KB）を表示している。

**座標系の注意**: `DataTexture` は最下行が UV の `v=0`（下端）に対応するため、書き込み時に
**行を上下反転**して画面の上下とシムの上下を一致させている。

## 操作

| 入力 | 動作 |
|---|---|
| 左ドラッグ | 現在のブラシ素材を描き込む（円形・半径3セル） |
| 右ドラッグ | 消去（empty で塗る・`contextmenu` は抑止） |
| `1` / `2` / `3` | ブラシ素材を 砂 / 水 / 壁 に切替 |
| `+` / `-`（テンキー可） | グリッド解像度 `COLS` を ±40（下限80・上限640・決定的に再構築） |
| `C` | 全消去（構造を消す。エミッタは毎フレーム供給され続ける） |
| `R` | リセット（決定的初期状態へ） |

## 仕様数値（全エンジン共通）

- キャンバス **960×540** 固定。グリッド **COLS×ROWS**（`ROWS = round(COLS×540/960)`）。
- `COLS` 初期 **160**（→ ROWS=90, 14400 セル）。`+/-` で **±40**（**80**〜**640**）。
- セル素材: `0=空気 / 1=砂 / 2=水 / 3=壁`。**場外は壁扱い**。
- 素材色（SPEC 基準）: 砂 `#d9c067` 系・水 `#3a7bd5` 系・壁 `#888`・空気 `#0b0d12`。
- **シミュレーションは固定タイムステップ**（毎フレーム1ステップ）。

## シミュレーション規則（決定的・`Math.random` 不使用）

- **走査順**: 下の行から上へ。各行は左右交互スキャン（行の偶奇 ＋ フレーム位相で反転）。
  乱択は **`mulberry32`** で決定的に行う。
- **砂(sand)**: 真下が空なら落下。真下が水なら入れ替えて沈む。塞がれていれば左下・右下。
- **水(water)**: 真下が空なら落下。塞がれていれば左下・右下、それも塞がれていれば左右へ広がる。
- **壁(wall)** / **空気(empty)**: 不動。
- **エミッタ**: 上部に4個（砂2・水2）を COLS への比率で決定的配置し、毎フレーム少量供給する。

## HUD（HTMLオーバーレイ `#hud`・約120msごと更新）

- `FPS`（直近60フレームの移動平均）
- `Grid`（`COLS x ROWS = セル数`）
- `Active`（空気以外のセル数）＋ `moved/frame`
- `Brush`（sand/water/wall）
- `Upload`（`DataTexture + needsUpdate` ＋ 転送量 KB/frame）

## 実装メモ（設計判断つき）

- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に
  `<a-scene>` として宣言**し、ゲーム本体は **`sand-game` コンポーネント**が駆動（A-Frame の
  renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断**: 本テーマは「大量の `<a-entity>`」ではなく **板 1 枚＋動的テクスチャ**。シム・
  アップローダ・板はすべてコンポーネント内で `THREE`（`AFRAME.THREE`）を直接使って生成し、
  `this.el.object3D` に add する。
- **2D 化**: `tick` で `sceneEl.camera` を `OrthographicCamera(0, W, H, 0)` に維持（A-Frame の
  既定パースペクティブカメラを上書き）。`renderer.setPixelRatio(1)` で DPR=1 固定。
  `<a-scene>` は `embedded`・`vr-mode-ui:false`。
- **更新ループ**: `tick(time, dtMs)` の `dt` は **ms 単位**（上限 50ms でタブ復帰時の暴発を抑制）。
  毎フレーム `sb.step()` → `uploader.upload(sb)` → HUD 更新。
- **入力**: `sceneEl.canvas`（生成が遅れる場合は `tick` で遅延バインド）の pointer events。
  `getBoundingClientRect()` で CSS 縮小ぶんを比率換算してセル座標へ。ドラッグは線分補間。
  右ボタンは消去、`contextmenu` は抑止。
- **解像度変更**: `setSize(cols)` で状態を決定的に再構築し、`DataTexture` を作り直して
  `material.map` を差し替える（旧テクスチャは `dispose()`）。

## Codex 生成所感

- HTML 宣言的なのでシーンの骨格は AI が書きやすい一方、本テーマは「宣言的フレームワークで
  **手続き的な動的テクスチャ更新**を書く」ミスマッチがある。素直に書くと「セル＝entity」に
  しがちだが、それは破綻するので **板1枚＋`DataTexture` 直更新**の方針を明示するのが鍵。
- three.js 版と機構は同一（`DataTexture` + `needsUpdate`）。A-Frame 固有の罠は ① 2D 用 ortho
  カメラが既定に無く、`sceneEl.camera` 差し替えという定石を知らないと perspective のままになる、
  ② `tick` の dt が ms 単位、③ `canvas` 生成タイミング（`loaded` 前に触ると null）。
- コストの所在は three.js 版と同じく「`image.data` への RGBA 直書き」＋「`needsUpdate` 時の
  GPU 転送」。ドローコールは板1枚で、描画より「生成＋転送」が律速になる。
