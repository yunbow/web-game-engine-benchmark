# パーティクル / 魔法エフェクトdemo — A-Frame 版

テーマ8共通仕様（パーティクル/魔法エフェクトデモ・性能比較用）の **A-Frame** 実装。
画像アセットが無くても放射状グロー（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`8/`)をルートに HTTP サーバを立てて開く。

```bash
cd 8
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（グローフォールバックでは起動する）。

## 操作
- マウス移動: カーソル追従トレイル（連続噴出）
- 左クリック: その地点で爆発バースト（120〜200個を放射状に放出）
- `Space`: オート花火トグル（ON 中・0.5s 間隔・決定的位置にバースト）
- `B`: ブレンド切替（加算 ⇄ 通常）
- `+` / `-`（テンキー +/- も可）: 目標同時パーティクル数 ±2000（500〜50000）
- `R`: リセット

## 使用したパーティクル機構（重要）
- **THREE.Points + BufferGeometry（GPU 寄り）を `fx-game` コンポーネント内で直接構築**。
  - A-Frame は three.js 上の宣言的（entity-component）フレームワークだが、**5万個のパーティクルを
    「1 個 = 1 `<a-entity>`」で作ると DOM/コンポーネント生成コストで即破綻**する。そこで動的描画は
    **コンポーネント内で `AFRAME.THREE` の `Points` を 1 個生成**し、位置/色/サイズを TypedArray
    attribute に詰めて毎フレーム更新 → **GPU が単一 draw call でまとめて描く**（three.js 版と同一機構）。
  - 物理更新（位置/寿命）は CPU の TypedArray ループ。つまり **「GPU 描画 + CPU 更新」**。
    CPU(KAPLAY) 方式より高い目標数まで FPS が伸びる（＝比較結果）。
- **加算ブレンド**: `PointsMaterial.blending = THREE.AdditiveBlending`。`B` で `NormalBlending` 切替
  （`needsUpdate` 必須）。`depthWrite:false`。
- **per-particle サイズ**: `material.onBeforeCompile` で `attribute float aSize` を頂点シェーダへ注入し
  `gl_PointSize = aSize;` に置換 → GPU 側で寿命の **大→小** を計算。
- 色は `vertexColors` で暖色→寒色。**alpha は加算のため色の明るさに焼き込み**（1→0 フェード）。

## 実装メモ（設計判断つき）
- **シーンは `index.html` に `<a-scene embedded>` として宣言**し、ゲーム本体は登録した
  **`fx-game` コンポーネント**が駆動（A-Frame の renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断（重要）**: 大量パーティクルは `<a-entity>` 化せず **`this.el.object3D` に THREE.Points を
  1 個 add** して管理。これが A-Frame で大量2Dパーティクルを扱う際の現実的な定石。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0,-1000,1000)`** に維持
  （A-Frame 既定の perspective を上書き）。座標は `worldY = H - gameY` 変換。
- `renderer.setPixelRatio(1)` で DPR=1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。
- `tick(time, dtMs)` の **dt は ms 単位**。決定的擬似乱数 `mulberry32` で軌道・バーストを再現可能に。
- アセットは `TextureLoader`、失敗時は canvas 放射グロー → `CanvasTexture`。
- HUD は HTML オーバーレイに FPS / Particles(live) / Target / Emitters / Blend / Mode(GPU) を表示。

## Codex / AI コーディング所感
- HTML 宣言的なのでシーンの骨格は AI が書きやすいが、本テーマは **非宣言的な大量パーティクル**が主役で
  ミスマッチが出やすい。
- 罠: ① パーティクルを素直に `<a-entity>` で作ると破綻 → **THREE.Points 直管理を明示指示**するのが鍵。
  ② 2D 用 ortho カメラは A-Frame に既定がなく `sceneEl.camera` 差し替えの定石が要る。
  ③ `PointsMaterial` の per-particle サイズは `onBeforeCompile` のシェーダ注入が必要。
  ④ `tick` の dt は ms 単位（秒と取り違えやすい）。
