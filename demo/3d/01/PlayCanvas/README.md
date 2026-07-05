# 3D テーマ1 ― インスタンス小惑星フィールド（PlayCanvas 版）

three.js リファレンス実装（`../three.js/`）を **PlayCanvas エンジンのみ**（エディタ不使用・CDN 読込）に「同一挙動」で移植したもの。数値・ルール・座標系・HUD はすべて `../SPEC.md` に準拠。

## 起動方法

`file://` 直開きは不可（このテーマはアセット非使用だが、他テーマと手順を統一）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/01
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

## 操作

- 移動: `WASD` / 矢印キー（x/y 平面・範囲クランプ・60 u/s）
- 発射: 常時オート連射（150ms ごと・弾速 400 u/s・-Z 方向）
- `+` / `-`（および `]` / `[`）: 小惑星の同時数を ±1000（最小 1000 / 最大 50000）
- `P`: オートプレイのトグル（決定的に左右往復・無人ベンチ用）
- `R`: 再開（ゲームオーバー後）

## 使用バージョン

- PlayCanvas Engine **v2.7.4**（CDN: `https://code.playcanvas.com/playcanvas-stable.min.js`、UMD グローバル `pc`）
- 描画バックエンド: **WebGL2 を明示**（`graphicsDeviceOptions.deviceTypes = [pc.DEVICETYPE_WEBGL2]`）。WebGPU は使わない（公平比較のため）。
- 解像度固定: `app.setCanvasResolution(pc.RESOLUTION_FIXED, 960, 540)` + `FILLMODE_NONE`。

## 実装メモ

### ハードウェアインスタンシング（本テーマの主軸・最重要）

PlayCanvas は per-instance の 4x4 行列を **頂点バッファ（インスタンス属性）**として渡す「hardware instancing」で実装する。手順:

1. メッシュ＋マテリアルから `pc.MeshInstance` を 1 個作る。
2. インスタンス行列用の頂点フォーマットを `pc.VertexFormat.getDefaultInstancingFormat(device)` で取得（= `float32x4 × 4` 本 = 4x4 行列 1 つ分）。
3. `new pc.VertexBuffer(device, format, maxCount, { usage: pc.BUFFER_DYNAMIC })` で動的頂点バッファを生成。
4. `meshInstance.setInstancing(vb)` で割り当て。
   - **注記**: `setInstancing(vb)` は第2引数 `cull` が既定 `false`。つまりインスタンスバッチは**自動的にフラスタムカリング対象外**になる。小惑星は z=-1200〜30 の広範囲に散るため、これは都合が良い（バッチ全体が誤ってカリングされない）。
5. 毎フレーム CPU 側の `Float32Array(maxCount * 16)` に各インスタンスの行列を `pc.Mat4.setTRS()` で書き込み、`vb.setData(data)` で GPU へアップロード。
6. 描画数は `meshInstance.instancingCount = activeCount` で指定（生存ぶんを配列先頭に詰める）。

弾も同方式（`MAX_BULLETS=64`、生存ぶんを詰めて `instancingCount` に反映）。

行列は `pc.Mat4.setTRS(pos, rotQuat, scale)` で生成し、`mat.data`（**列優先 Float32Array 16 要素**）を CPU バッファへコピーする。three.js の `Object3D.updateMatrix()`→`setMatrixAt()` と等価。

### メッシュ形状

- 小惑星: PlayCanvas に icosahedron プリミティブが無いため `pc.createSphere(device, { radius:1, latitudeBands:3, longitudeBands:4 })` の超低分割球（20 面前後の低ポリ）で代用。`pc.createSphere`/`pc.createCone` は v2 系でも `pc.Mesh` を返す簡便ヘルパとして健在（内部は `Mesh.fromGeometry(device, new SphereGeometry(opts))`）。
- 弾: 低分割小球。自発光（`emissive`）で常時黄色 `#ffe66d`（three.js の `MeshBasicMaterial` 相当）。
- 自機: `pc.createCone`（apex は +Y）。three.js の `rotation.x = -π/2` と同じく `setLocalEulerAngles(-90,0,0)` で apex を -Z へ向ける。

### 色ティントの省略（T1 の割り切り）

three.js リファレンスは小惑星をインスタンスごとに `setColorAt` で茶〜灰の色ティントしている。PlayCanvas のハードウェアインスタンシングで per-instance 色を付けるには、インスタンス頂点フォーマットの拡張＋シェーダ改造（カスタム attribute → シェーダで diffuse に乗算）が必要で T1 の比較主軸（行列インスタンシングのスループット）から外れるため、**T1 では小惑星を単色**（マテリアル `diffuse` の岩色）とした。
ただし**決定論は維持**: three.js 版が色用に消費する `rnd()` 2 回ぶんを初期化ループで空読みし、PRNG 系列（= 小惑星の位置・速度・半径・自転）を 4 ライブラリ完全一致させている。

### 当たり判定・ロジック

PRNG（mulberry32, seed=`0x9e3779b9`）・自前球判定（中心間平方距離 ≤ 半径和の2乗、z ゲートで早期 continue）・SoA 状態配列・奥へのリサイクル・入力処理（WASD/矢印, +/-/[/], P, R）・`FIRE_MS`・被弾後 1.0s 無敵などは three.js 版から**そのまま移植**。ゲームループは `app.on('update', dt => ...)`（dt は秒）で、three.js 版同様 `dt` を 0.05 にクランプ。

### draw call / 三角形数の取得

- `Draws`: `app.graphicsDevice.stats.drawCalls.total`（v2.7.4 の `drawCalls` は `{forward, depth, shadow, total, instanced, ...}` を持つ）から取得。インスタンシングなので小惑星バッチは 1 draw call にまとまる想定。
- `Tris`: インスタンシング時は `device.stats` に正確な合計が反映されないため、**自前で概算**（小惑星メッシュ面数 `astMesh.indexBuffer[0].numIndices/3 × activeCount` + 弾メッシュ面数 × 生存弾数）。three.js 版の `renderer.info.render.triangles` 相当の近似値。

### カメラ / ライト

- カメラ: `camera` コンポーネント、`fov=60`（垂直基準・度）/ `nearClip=0.1` / `farClip=2000`。毎フレーム `setPosition(px, py+6, pz+22)` → `lookAt(px, py+2, pz)`。クリアカラー `#05060a`。
- ライト: `app.scene.ambientLight`（環境光）+ directional 1 灯（白・強度 1.0）。directional は forward(-Z) が光の向きになるため、`lookAt((-0.5,-1,-0.3) 正規化)` で SPEC の方向に合わせた。

## AI コーディング生成のしやすさ所感

- 同 CDN 1 ファイルでエンジン全体が読め、`pc.Application` の初期化定石が短く、3D 2D 問わず素直に書ける。three.js と座標系（右手・Y上）が同じため、ロジック移植は機械的に進む。
- 最大の罠は**ハードウェアインスタンシングの周辺 API**。`getDefaultInstancingFormat` / `VertexBuffer(... , { usage })` / `setInstancing` / `instancingCount` / 列優先 `Mat4.data` の組み合わせは、AI が three.js の `InstancedMesh` 感覚で書くと取り違えやすい（特に `setInstancing` が暗黙にカリングを切る挙動、行列が頂点バッファ経由である点）。
- `pc.createSphere`/`pc.createCone` のような簡便ヘルパが v2 でも残っており、AI の旧知識（v1 系 API）と新 API（`SphereGeometry`）のどちらでも動く点は生成耐性が高い。
- `device.stats` は CDN 通常ビルドでも存在し draw call を拾える（Editor ビルド限定ではない）ため、HUD 実装が楽だった。
