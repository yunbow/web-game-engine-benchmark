# 3D テーマ5(T2) ― 広域地形 + カリング/LOD/描画距離（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一挙動」で移植したもの。
仕様の唯一の正は `../SPEC.md`。配置・距離・LOD閾値・カメラ・HUD はすべて SPEC / three.js 版と一致させている。

## 起動方法

画像/GLB は使わないが、CDN 読込とローカル配信のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/05
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- `+` / `-`（および `]` / `[`）: 描画距離 drawDist を ±40（初期 120 / 最小 40 / 最大 360）。**比較の主軸**。
- `R`: 描画距離を初期値（120）に戻す。
- カメラは自動周回飛行（無人ベンチ可）。

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。
  - 正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

## 実装メモ

### three.js ロジックのカスタムコンポーネント移植

- 背景色・カメラ・ライト・fog は `<a-scene background fog>` / `<a-entity camera>` / `<a-light>` で宣言的に記述し、A-Frame らしさを維持。
- 10000本の木の生成・距離カリング・2段LOD は宣言タグでは表現できないため、カスタムコンポーネント `forest` の `init()` 内で **`AFRAME.THREE` のジオメトリ/マテリアル/Group を直接生成**し、`this.el.object3D`（= `<a-scene>` の object3D）へ `add` している。
- 木は three.js 版と同一寸法・同一構造で生成:
  - 共有ジオメトリ: 幹 `CylinderGeometry(0.4,0.5,2,6).translate(0,1,0)` / 葉 `ConeGeometry(1.7,4,8).translate(0,4,0)` / LOD1低ポリ `ConeGeometry(1.7,6,4).translate(0,3,0)`。共有 `MeshLambertMaterial`（幹=茶 / 葉=緑 / 低ポリ=緑）。
  - 構造: `obj(Group)` ┬ `lod0(Group: 幹+葉)` └ `lod1(低ポリ円錐)`。GRID=100・間隔8で `x=(c-(GRID-1)/2)*SP, z=(r-(GRID-1)/2)*SP, y=0` に配置。
  - 個体差は `mulberry32(seed=0x9e3779b9)` を **three.js 版と同じ順序**で消費（高さ係数 0.8〜1.4 → Y回転）。決定的なので `Math.random` 不使用。
- メインループは `forest` の `tick(time, timeDelta)` に実装。`timeDelta`（ms）を秒へ変換し 0.05 でクランプ。三角形描画は A-Frame のレンダループが自動で行うため明示 `render()` は不要。

### カメラの罠（最重要）

- `<a-entity id="rig" camera>` に `look-controls="enabled: false"` / `wasd-controls="enabled: false"` を付けて A-Frame 既定の入力を無効化。
- カメラ周回（半径 R=140 / 高さ y=26 / 角速度 0.15、`θ=t*0.15`、`pos=(R cosθ,26,R sinθ)`、`lookAt(R*0.4 cosθ,2,R*0.4 sinθ)`）は `tick` 内で毎フレーム更新。
- **罠**: `cameraEl.object3D` は Group。`Group.lookAt` は **+Z を対象へ向ける**（非カメラ分岐）ため、子の `PerspectiveCamera`（-Z を見る）が**逆を向いてしまう**。そこで `cameraEl.getObject3D("camera")` で取得した **`THREE.Camera` 本体に対して `position.set` / `lookAt`** を行う（`isCamera` 分岐で -Z が正しく対象を向く）。`rig` は `position="0 0 0"` の単位変換なので camera 本体の local 座標 = world 座標。

### カリング / LOD / 距離カリング

- 毎フレーム、各木とカメラの**水平距離の平方** `d2 = dx*dx + dz*dz` を計算（平方比較で `sqrt` を回避）:
  - `d2 > drawDist²` → 木を**非表示**（`obj.visible = false`）。
  - `(drawDist*0.5)² < d2 ≤ drawDist²` → **LOD1**（`lod1.visible=true, lod0.visible=false`）。
  - `d2 ≤ (drawDist*0.5)²` → **LOD0**（詳細、`lod0.visible=true, lod1.visible=false`）。
- 表示中の木は **three（A-Frame 同梱）の自動フラスタムカリング**で視錐台外がさらに除外される。よって HUD の `Draws` は `Objects`(InRange) より小さくなり、カリングの効きが観測できる。
- HUD: `Objects` = 距離カリング後の InRange、`Draws` = `sceneEl.renderer.info.render.calls`、`Tris` = `.triangles`。数フレームに1回更新。`<a-scene>` 外の HTML オーバーレイで three.js 版 T2 と同一構造・CSS（FPS / Objects / DrawDist / Draws / Tris、note「culling + LOD: frustum(engine) + distance/LOD(app)」）。

## AI コーディング生成のしやすさ所感

- T2 は大量描画でも**個別 Object3D を 10000 個並べる**設計（インスタンシングではない）なので、`Group` の二段 LOD 構造をそのまま A-Frame の `init()` 内に移植でき、three.js 版とほぼ機械的に一致させられた。`init()`/`tick()` のライフサイクルが three.js のセットアップ/ループに綺麗に対応する。
- 最大の罠はやはり**カメラの lookAt**。AI に素直に書かせると `cameraEl.object3D.lookAt(...)` としてしまい、カメラが対象の真逆を向く。`getObject3D("camera")` 本体に対して行うこと、`look-controls`/`wasd-controls` を無効化することの 2 点を明示する必要がある。
- 別途 `three` を import せず `AFRAME.THREE` を使う点も AI が間違えやすい（importmap の癖で `import * as THREE from "three"` を書きがち）。
- 距離カリング/LOD のアプリ側ロジック自体は `visible` フラグの切り替えだけで、`renderer.info` も three.js と同一 API のため移植は容易。総じて「three.js を知っていれば書ける。宣言性とのギャップはカメラ制御に集中する」という所感。
