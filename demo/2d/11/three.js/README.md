# テーマ11 2Dダイナミックライティング / 影 ― three.js 版

暗いトップダウンの部屋を、プレイヤーの灯りと多数の動的な色付き光源が照らし、矩形の柱（オクルーダ）が**影**を落とす
ライティングベンチ。**多数の動的光源 ＋ ライトマップ合成（加算→乗算）＋ 影生成**を同時に回し、
「同時光源数」と「影 ON/OFF の描画コスト差」を測る。テーマ8（加算ブレンドのパーティクル発光）とは別軸の、
**光のボリューム・遮蔽影・ブレンド経路**の比較。

## 起動方法

画像を `../assets/` から読むため、テーマフォルダ(`11/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 11
python -m http.server 8000
# → http://localhost:8000/three.js/
```

`../assets/` が空でもフォールバック描画で必ず起動します。

## 使用バージョン / CDN

- three.js **r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。
- レンダラは **WebGLRenderer**（DPR=1 固定）。追加ライブラリなし。

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

### 2D 化の足場

- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、
  原点左下・Y上向き）。ゲームロジックは**画面座標（Y 下向き・他エンジンと同一定数）のまま**保持し、描画同期時のみ
  `worldY = H - gameY` に変換する。
- 床は `RepeatWrapping` の `PlaneGeometry`、柱は柱テクスチャの Plane、プレイヤーは `THREE.Sprite`。
- `renderer.autoClear = false` にして、ライトマップ生成（複数の RenderTarget 描画）とメインシーン描画を手動制御する。

### ライトマップ合成（描画の核・エンジン自然な機構）

three.js では**オフスクリーンの `WebGLRenderTarget` へ加算合成で光を積み、結果を乗算合成の全画面 quad で重ねる**。

1. **`lightRT`**（`WebGLRenderTarget`）を **ambient(0.10) のグレー**でクリア（`setClearColor` + `clear`）。
2. 各光源の寄与を積む。グローは **`THREE.Sprite` ＋ `AdditiveBlending`**（中心白→外周透明の放射テクスチャ。
   色は `material.color` で付ける）。
   - **影 OFF**: 全グロー Sprite を 1 つの専用シーン（`lightScene`）にまとめ、`autoClear=false` の lightRT へ
     **一括加算描画**（バッファ往復なし＝軽い）。
   - **影 ON**: 光源ごとに別 RenderTarget **`scratchRT`** へ「グロー1枚 → **黒の影ポリゴン**（`MeshBasicMaterial`
     color:0x000000・通常合成）」を描いて光を削り、その `scratchRT.texture` を貼った **AdditiveBlending の
     全画面 quad** 経由で lightRT へ加算する。**光源数ぶんのバッファ往復＋影ジオメトリ生成**が「影 ON」のコスト。
3. **`lightRT.texture`** を **`MultiplyBlending`** の全画面 quad（`overlayQuad`）にしてメインシーンへ重ねる。
   → 照らされた所だけ見え、影/未照は ambient まで暗く沈む。

→「加算で積む」「乗算で合成」という2段が、three.js の Blending（`AdditiveBlending` / `MultiplyBlending`）で
そのまま表現できる。これが three.js でのエンジン自然なライトマップ機構。

### 影（ハードシャドウ）

光源から見た矩形オクルーダの**シルエット辺**（外向き法線が光源と逆を向く辺）の2端点を、光源から遠ざかる方向へ
`SHADOW_PROJECT=2000` 延長して影台形を作る。複数矩形・複数辺の三角を**1つの動的 `BufferGeometry`**
（`shadowPos` を毎フレーム書き換え `setDrawRange`）にまとめ、黒メッシュとして scratchRT に描いて光を削る。
座標はワールド（Y上）で直接生成。光源が矩形内部なら影なし。

### 決定的生成 / フォールバック

- 柱配置・光源軌道・色は `mulberry32` の決定的乱数（`Math.random` 不使用）。`hsv2rgb` で色付き光源を決定的に割当。
- アセットは `TextureLoader.loadAsync` を個別 try/catch。失敗時は 2D canvas に図形/放射グラデを描いて
  `CanvasTexture` 化。`light_glow.png` が無くても放射グローを生成するので必ず点灯する。

## Codex / AI コーディング所感

- three.js 自体の API は AI が安定して書けるが、**「ライトマップを RenderTarget で組む」足回りは罠が多い**。
  ① `autoClear=false` にして手動 `setRenderTarget`/`clear`/`render` を正しい順で並べないと、ambient が消えたり
  ライトが画面へ直接漏れる。② グローの `AdditiveBlending` と最終の `MultiplyBlending` を取り違えると絵が破綻する。
  ③ Multiply quad はメイン描画の**最後**に重ねる必要があり、`renderOrder` と `depthTest:false` の指定が要。
- 影 ON パスの **scratchRT 往復**（1光源ごとに別 RT へ描いて加算）は PixiJS 版の「スクラッチ RT プール」と
  まったく同じ勘所。three.js では「scratchRT.texture を貼った Additive quad を compositeScene として使い回す」
  形に落とし込むのが綺麗だった。
- 影ジオメトリは矩形ごと辺ごとに Mesh を作ると即破綻するため、**1つの動的 `BufferGeometry` を `setDrawRange`
  で書き換える**設計を明示。これを明示しないと AI は「辺ごとに `new Mesh`」と書きがち。
