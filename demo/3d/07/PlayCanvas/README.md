# 3D T7 ボクセルチャンク再生成 — PlayCanvas（エンジンのみ・CDN）

毎フレーム、全チャンクのブロック地形メッシュを作り直して GPU に再アップロードし、その
スループットを比較するベンチマーク。three.js リファレンス実装の「同一仕様」移植。
数値・挙動の唯一の正は `../SPEC.md`。

## 起動方法

`file://` 直開きは不可（CDN は読めるが他ライブラリと条件を揃えるため HTTP 配信推奨）。
テーマフォルダ `3d/07` をルートに HTTP サーバを立てて開く:

```bash
cd 3d/07
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/
```

操作:
- `+` / `-`（`]` / `[`）: チャンク数 NC の増減（最小2 / 最大8）。**比較の主軸**。
- `R`: NC を初期値(4)に戻す。
- カメラ固定・波は自動進行（無人ベンチ可）。

## 使用バージョン

- PlayCanvas エンジン: `https://code.playcanvas.com/playcanvas-stable.min.js`（`pc` グローバル / UMD）。
- WebGL2 を明示（`deviceTypes: [pc.DEVICETYPE_WEBGL2]`）。WebGPU は使わない。
- 描画サイズ 960x540 固定（`RESOLUTION_FIXED`）。背景 `#0b1016`。

## 動的メッシュ再構築 / 再アップロードの実装

比較の主軸は「毎フレームの頂点バッファ再構築＋GPU 再アップロード」。PlayCanvas では
`pc.Mesh` の **データ系セッタ → `mesh.update()`** がその機構にあたる。

- **チャンク = 各自独立の `pc.Mesh`(device 指定) + `pc.MeshInstance` + `Entity`(render)**。共有しない。
- 初期化（`makeChunk`）で **1回だけバッファを確保**:
  - `mesh.clear(true, false)`（頂点 dynamic / インデックス static）。
  - 事前確保した `Float32Array`（positions: VPC×3, normals: VPC×3, colors: VPC×4 = RGBA）。
  - `setPositions / setNormals / setColors(col, 4) / setIndices(固定[0..VPC-1])` → `update(pc.PRIMITIVE_TRIANGLES)`。
- **毎フレーム（`rebuildChunk`）**: 同じ事前確保配列に positions/normals/colors を**上書き**し、
  `setPositions / setNormals / setColors → mesh.update(pc.PRIMITIVE_TRIANGLES)` で再アップロード。
  配列は再アロケートしない（再アロケートは負荷比較を歪めるため）。
- インデックスは非インデックスメッシュ向けの固定列 `[0..VPC-1]`（VPC=4320）を1度だけ確保し使い回す。
- メッシュ生成は各セル=上面1+側面4の計5クアッド=30頂点。頂点座標・法線・巻き順は three.js版 `quad` と一致。
- 高さの波・高さ→色は three.js版 `heightAt` / `heightColor` と同式。
- NC 変更時はチャンク群を **destroy → 再生成**（各 mesh は独自なので破棄は安全。Entity を destroy し
  mesh も destroy してリークを防ぐ）。

## つまずき / 注意点

- **【最重要】game.js 全体を IIFE で隔離**。classic script はグローバルの let/const レキシカルスコープを
  共有するため、トップレベルの `let t` 等が PlayCanvas エンジンの minified 単一文字グローバルと衝突し
  `Identifier 't' has already been declared` でブラウザ起動が失敗する（`node --check` では検出されず、
  ブラウザでのみ発生。3d/05 PlayCanvas で実際に踏んだ）。`(function(){ ... })();` で必ず囲う。
- 頂点カラーは `StandardMaterial.diffuseVertexColor = true`。色は RGBA(4成分)で `setColors(col, 4)`。
- `mesh.clear(verticesDynamic, indicesDynamic)` の第1引数を true にして頂点バッファを動的扱いにする
  （毎フレーム更新前提のヒント）。
- HUD の `Draws` は `app.stats.drawCalls.total`（v2 系の正）。取れない環境向けにチャンク数へフォールバック。
  `Tris` は実測ではなく仕様上の概算（NC×NC×144×10）。
- フラスタムカリングは `meshInstance.cull = false` で無効化し、4ライブラリで「一律生成・一律描画」を揃える。

## AI 生成所感

- three.js の `BufferGeometry`（属性を `needsUpdate=true`）と PlayCanvas の `pc.Mesh`（セッタ→`update()`）は
  概念がほぼ1:1で対応し、移植は素直。頂点座標・法線・巻き順はリファレンスをそのまま写経できる。
- 罠は API ではなくスコープ衝突（IIFE）。これは静的解析で出ないため、過去テーマの教訓を明示的に踏襲する必要がある。
- 色を RGB(3) ではなく RGBA(4) にしておくと PlayCanvas の頂点カラーパイプラインと相性が良く安定する。
