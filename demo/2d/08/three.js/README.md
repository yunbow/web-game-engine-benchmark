# パーティクル / 魔法エフェクトdemo — three.js 版

テーマ8共通仕様（パーティクル/魔法エフェクトデモ・性能比較用）の **three.js** 実装。
画像アセットが無くても放射状グロー（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`8/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 8
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- マウス移動: カーソル追従トレイル（連続噴出）
- 左クリック: その地点で爆発バースト（120〜200個を放射状に放出）
- `Space`: オート花火トグル（ON 中・0.5s 間隔・決定的位置にバースト）
- `B`: ブレンド切替（加算 ⇄ 通常）
- `+` / `-`（テンキー +/- も可）: 目標同時パーティクル数 ±2000（500〜50000）
- `R`: リセット

## 使用したパーティクル機構（重要）
- **THREE.Points + BufferGeometry（GPU 寄り）**。
  - 全パーティクルを **1 個の `THREE.Points`（単一 draw call）**として描画する。位置 `position`、
    色 `color`、点サイズ `aSize` を **TypedArray（BufferGeometry の attribute, `DynamicDrawUsage`）**に
    詰め、毎フレーム CPU で書き換えて `needsUpdate = true` で GPU へアップロードする。
    描画自体は GPU が点スプライトをまとめて処理するため、Sprite を 1 個ずつ描く方式や
    CPU(KAPLAY) 方式よりはるかにスケールし、**50000 個でも 1 draw call**。
  - 物理更新（位置/速度/寿命）は CPU の TypedArray ループ。つまり本実装は **「GPU 描画 + CPU 更新」**。
    描画コールが 1 本に畳まれるぶん、CPU エンジンより高い目標数まで FPS が伸びる（＝比較結果）。
- **加算ブレンド**: `PointsMaterial.blending = THREE.AdditiveBlending`（重なるほど明るく）。
  `B` で `THREE.NormalBlending` に切替（`needsUpdate` 必須）。`depthWrite:false` で点同士の前後を無効化。
- **per-particle サイズ**: `PointsMaterial` は本来「全点同一サイズ」しか持てないため、
  `material.onBeforeCompile` で `attribute float aSize` を頂点シェーダへ注入し、
  `gl_PointSize = size;` → `gl_PointSize = aSize;` に置換。これで **サイズ計算を GPU 側**で行い、
  寿命に沿う **大(32×1.4)→小(32×0.15)** を実現する。
- 色は `vertexColors`（per-vertex color attribute）で **暖色→寒色**を表現。**alpha は加算合成のため
  色の明るさへ乗算**（`color *= 1 - t²`）して 1→0 のフェードを得る。

## 実装メモ
- 2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px・原点左下・Y上向き）。
- ゲーム座標は**画面座標（Y 下向き）のまま**保持し、attribute 書き込み時のみ `worldY = H - gameY` 変換。
- `renderer.setPixelRatio(1)` で DPR=1 固定（性能比較の条件をそろえる）。`points.frustumCulled = false`。
- 決定的擬似乱数 `mulberry32` で周回オーブ軌道・バースト方向を再現可能に。背景は暗色 Plane + 星 Points。
- ループは `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発抑制）。
- HUD は HTML オーバーレイに FPS / Particles(live) / Target / Emitters / Blend / Mode(GPU) を表示。

## Codex / AI コーディング所感
- three.js 自体の API は訓練データが豊富で安定して書ける。Points + attribute の素直なサンプルも強い。
- 罠: ① `PointsMaterial` の **per-particle サイズは標準では不可**で、`onBeforeCompile` のシェーダ注入か
  ShaderMaterial 自作が必要（AI は「size attribute を渡せば効く」と誤解しがち）。
  ② 加算合成下では alpha を直接効かせられないため **色に焼き込む**必要がある。
  ③ ortho カメラの引数順・Y 向き、ESM/importmap 必須、attribute の `needsUpdate` 忘れ。
