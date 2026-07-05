# 3D T7 ボクセルチャンク再生成 — Babylon.js 版

毎フレーム、全チャンクのブロック地形メッシュを作り直して GPU に再アップロードする負荷を測るベンチ。
比較の主軸は **チャンク数 NC×NC**。three.js 参照実装（`../three.js/`）と**同一仕様**（波・チャンク/セル構成・カメラ・HUD）で、描画レイヤだけを Babylon の updatable Mesh + `updateVerticesData` に置き換えている。

## 起動方法

`file://` 直開きは不可（このテーマはアセット不使用だが、流儀を全テーマで揃えるため）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/07
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

## 操作

- `+` / `-`（`]` / `[`）: チャンク数 NC の増減（最小2 / 最大8 / 初期4）。**比較の主軸**。
- `R`: NC を初期値（4）に戻す。
- カメラ固定・波は自動進行（無人ベンチ可）。

## 使用バージョン

- Babylon.js: `https://cdn.babylonjs.com/babylon.js`（最新安定版・グローバル `BABYLON`）。WebGL2。
- 画像/GLB 不使用・コード生成ジオメトリのみ。

## 動的メッシュ再構築/再アップロードの実装

three.js は `BufferGeometry` の属性を書き換えて `needsUpdate=true`。Babylon では次のように対応させた。

1. **事前確保バッファ**: チャンクごとに `pos`（`Float32Array(VPC*3)`）/ `nor`（同）/ `col`（**`VPC*4`**）を一度だけ確保。`VPC = 144セル × 30頂点 = 4320`。再アロケートはしない（毎フレーム中身だけ書き換え）。
2. **インデックス必須**: three.js は非インデックスでよいが、**Babylon の `VertexData` にはインデックスが要る**。全頂点ユニーク（非インデックス相当）なので固定配列 `[0,1,2,…,VPC-1]` を一度だけ作って全チャンクで共有。VPC=4320 < 65536 なので `Uint16Array` で足りる。
3. **updatable で適用**: 初期化時に `vertexData.applyToMesh(mesh, true)`（第2引数 `updatable=true`）。
4. **毎フレーム再アップロード**: `pos/nor/col` を書き換えたあと、
   `mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos)` / `NormalKind` / `ColorKind` で中身だけ GPU へ再転送。

## つまずき

- **ColorKind は RGBA（4成分）**: three.js の color 属性は RGB(3) だが、Babylon の `ColorKind` は **RGBA(4)**。色配列は `VPC*4` で確保し、alpha は最初に 1 を埋めておき、再構築時は r/g/b のみ書き換える（`col[c+3]` は触らない）。3成分のまま渡すと頂点数がずれて崩れる。
- **VertexData にインデックスが要る**: `positions` だけ与えて `indices` を省くと描画されない。固定インデックスを必ず付ける。
- **右手系**: `scene.useRightHandedSystem = true`。Babylon 既定は左手系で、放置すると Z 反転＋クアッドの巻き順が裏返り、上面/側面が消える。three.js と同じ右手系・同じ頂点順にすることで表裏が一致する（`backFaceCulling=true` のままで正しく表が出る）。
- **フラスタムカリング**: 毎フレーム形状が変わり境界が動くため、`mesh.alwaysSelectAsActiveMesh = true` でカリング判定（境界再計算）を回避。
- **頂点カラー有効化**: `StandardMaterial.useVertexColor = true` を立てないと `ColorKind` が描画に反映されない。
- **Draws**: `SceneInstrumentation` の `drawCallsCounter.current` から取得（ベストエフォート）。チャンク数ぶんのドローコールになるはず。Tris は SPEC 注記どおり `NC×NC × 144 × 10` の概算。

## AI 生成所感

three.js 参照のメッシュ生成（5クアッド/セルの頂点座標・法線・巻き順）はそのまま移植でき、ロジック差分は描画 API だけに局所化できた。Babylon 固有の罠は (1) ColorKind の RGBA、(2) VertexData のインデックス必須、(3) 右手系設定の3点に集約され、いずれも「明示しないと壊れる」典型。`updateVerticesData` は内部で同サイズ前提に GPU バッファを再アップロードするため、事前確保バッファの中身書き換えだけで再アロケートを避けられ、three.js の `needsUpdate` 方式と素直に対応した。
