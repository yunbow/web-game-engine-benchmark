# テーマ11 2Dダイナミックライティング / 影 ― A-Frame 版

暗いトップダウンの部屋を、プレイヤーの灯りと多数の動的な色付き光源が照らし、矩形の柱（オクルーダ）が**影**を落とす
ライティングベンチ。**多数の動的光源 ＋ ライトマップ合成（加算→乗算）＋ 影生成**を同時に回し、
「同時光源数」と「影 ON/OFF の描画コスト差」を測る。テーマ8（加算ブレンドのパーティクル発光）とは別軸の、
**光のボリューム・遮蔽影・ブレンド経路**の比較。

## 起動方法

画像を `../assets/` から読むため、テーマフォルダ(`11/`)をルートに HTTP サーバを立てて開く。
`file://` 直開きは画像が CORS で読めないため HTTP 推奨。

```bash
cd 11
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```

`../assets/` が空でもフォールバック描画で必ず起動します。

## 使用バージョン / CDN

- A-Frame **1.7.0**（CDN: `https://aframe.io/releases/1.7.0/aframe.min.js`）。内包する three.js を `AFRAME.THREE` で利用。
- `<a-scene embedded vr-mode-ui="enabled: false">`。ゲーム本体は登録コンポーネント `lighting-game` が駆動。

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
  `Mode`(`Lightmap(RenderTarget add → Multiply quad)`) / `Ambient`(0.10)。

## 実装メモ

### A-Frame の足場（2D 化）

- シーンは `index.html` に `<a-scene>` として宣言し、ゲーム本体は登録した **`lighting-game` コンポーネント**が
  `init` / `tick` で駆動する（A-Frame の renderer / tick ループを利用）。
- 床/柱/プレイヤー/ライトマップ overlay は、コンポーネント内で **`AFRAME.THREE`** の Mesh/Sprite を直接生成し
  `this.el.object3D`（= group）へ足す。これで **A-Frame の自動描画**にそのまま乗る。
- 2D 用に **`OrthographicCamera(0, W, H, 0, -1000, 1000)`** を生成し、`tick` 内で `sceneEl.camera` に維持
  （A-Frame が別カメラを差し込んでも上書き）。`renderer.setPixelRatio(1)` で DPR=1 固定。
- ロジックは**画面座標（Y 下向き・他エンジンと同一定数）のまま**保持し、描画同期時のみ `worldY = H - gameY` 変換。

### ライトマップ合成（描画の核・three.js 版と同一の機構）

A-Frame でも three.js と同じく**オフスクリーン `WebGLRenderTarget` へ加算合成で光を積み、結果を乗算合成の
全画面 quad で重ねる**。`tick` の中で `sceneEl.renderer` を借りて、A-Frame 本描画の**前に**オフスクリーン描画を行う。

1. **`lightRT`**（`WebGLRenderTarget`）を **ambient(0.10) のグレー**でクリア。
2. 各光源の寄与を積む。グローは **Sprite ＋ `AdditiveBlending`**（中心白→外周透明の放射テクスチャ・色は
   `material.color`）。
   - **影 OFF**: 全グローを 1 つの専用シーン `lightScene` にまとめ、`autoClear=false` の lightRT へ一括加算（軽い）。
   - **影 ON**: 光源ごとに別 RT **`scratchRT`** へ「グロー → **黒影ポリゴン**」を描いて光を削り、`scratchRT.texture`
     を貼った **Additive quad**（`compositeScene`）経由で lightRT へ加算。**光源数ぶんのバッファ往復＋影生成**が
     「影 ON」のコスト。
3. **`lightRT.texture`** を **`MultiplyBlending` の overlay quad**（`overlayQuad`, `renderOrder=999`）として group に
   常駐させ、A-Frame の通常描画で床＋柱＋プレイヤーの上へ**乗算合成**する。

→ A-Frame 自身は宣言的フレームワークだが、ライティングのような**マルチパス描画は内包 three.js の生 API
（RenderTarget・Blending）**へ降りて組む。これが A-Frame でのエンジン自然なライトマップ機構。

### 影（ハードシャドウ）

光源から見た矩形オクルーダのシルエット辺（外向き法線が光源と逆を向く辺）の2端点を、光源から遠ざかる方向へ
`SHADOW_PROJECT=2000` 延長して影台形を作る。全矩形・全辺の三角を**1つの動的 `BufferGeometry`**
（`setDrawRange` で毎フレーム書き換え）の黒メッシュにまとめ、scratchRT に描いて光を削る。光源が矩形内部なら影なし。

### 決定的生成 / フォールバック

- 柱配置・光源軌道・色は `mulberry32` の決定的乱数（`Math.random` 不使用）。`hsv2rgb` で色付き光源を決定的に割当。
- アセットは `TextureLoader.load` の失敗コールバックで `null` 化し、2D canvas 図形/放射グラデへフォールバック。
  `light_glow.png` が無くても放射グローを生成するので必ず点灯する。

## Codex / AI コーディング所感

- A-Frame の宣言的部分（`<a-scene>` / コンポーネント登録 / `tick`）は AI が素直に書ける。
- 罠は **「A-Frame の render ループにオフスクリーン・マルチパスを割り込ませる」**こと。`tick` で
  `sceneEl.renderer` を借りて RenderTarget へ描き、`autoClear`/`setRenderTarget` を**退避→復元**しないと
  A-Frame 本来の描画(カメラ/クリア)を壊す。overlay quad を group に常駐させ「本描画で最後に乗算合成させる」
  設計（自前で `renderer.render(scene,camera)` を呼ばない）にすると A-Frame の流儀と衝突しにくい。
- もう一つは **2D カメラ問題**: A-Frame は既定の透視カメラを差し込むため、`tick` 毎に `sceneEl.camera` を
  自前の Ortho へ上書きし続ける必要がある。これを忘れると「真っ黒/透視で歪む」になりやすい。
- ライトマップ自体の機構は three.js 版とまったく同一に保ち、エンジン比較として「同じライトマップを A-Frame の
  tick/renderer 経由で回した時のコスト」が見えるようにした。
