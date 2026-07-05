# 3D T10 大量レイキャスト（LIDAR スキャナ）― A-Frame

中心スキャナから毎フレーム **N 本のレイ**を全方位へ放ち、`THREE.Raycaster` で M=120 個の
ターゲット（`THREE.InstancedMesh` のボックス）との**最近交差**を求め、当たり点を小球（InstancedMesh）で
描画する LIDAR 可視化。比較の主軸は**毎フレームの大量レイキャストのスループット**。仕様は `../SPEC.md` が唯一の正。

## 起動方法

`file://` 直開きは不可（A-Frame の WebGL 初期化・将来のアセット読込のため HTTP 経由が安全）。
テーマフォルダをルートに HTTP サーバを立てる:

```bash
cd 3d/10
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 使用バージョン

- A-Frame `1.7.0`（CDN: `https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は A-Frame 同梱のものを `const THREE = AFRAME.THREE;` で使用（別途読み込まない）

## 操作

- `+` / `-`（`]` / `[`）: レイ数 N の増減（±1500、最小 500 / 最大 15000）。**比較の主軸**
- `R`: レイ数を初期値 1500 に戻す
- カメラ自動周回・スキャナ自動（無人ベンチ可）

## 実装メモ ― THREE.Raycaster をカスタムコンポーネントで使う

A-Frame は宣言的フレームワークだが、`THREE.Raycaster`・`THREE.InstancedMesh` のような
命令的・大量処理は宣言タグでは表現できない。そこでカスタムコンポーネント `lidar` を `<a-scene>` に付け、
その `init`/`tick` の中で **three.js リファレンス実装をほぼそのまま移植**した。

- **ターゲット**: `THREE.InstancedMesh`（一辺 4 の軸整列ボックス、M=120）を半径 28 の球殻上にフィボナッチ分布で配置。
  `el.object3D`（= `<a-scene>` の object3D）に `add`。
- **レイキャスト**: `init` で `THREE.Raycaster`（`far = 200`）を1つ生成。`tick` で毎フレーム
  フィボナッチ球 N 方向（Y 回転 `t*0.1` 適用）について `ray.set(origin, dir)` →
  `ray.intersectObject(targets, false)` の最近交差 `hit[0].point` を採用。
- **当たり点**: `THREE.InstancedMesh`（半径 0.4 の小球、容量 N_MAX）を `DynamicDrawUsage`・`frustumCulled=false` で確保し、
  当たった本数だけ `setMatrixAt` → `count` を当たり数に設定。スキャナ原点は自発光小球（`MeshBasicMaterial`）。
- **HUD**: `<a-scene>` 外の HTML オーバーレイ。Draws/Tris は `this.el.sceneEl.renderer.info.render`（`calls`/`triangles`）から取得し、
  数フレームに1回（`hudT % 6`）更新。

### つまずき・カメラ罠

- **Group lookAt 罠（最重要）**: A-Frame のカメラエンティティ `#rig` の `object3D` は `THREE.Group`。
  `Group.lookAt` は **+Z** を対象へ向ける（非カメラ分岐）ため、子の `PerspectiveCamera`（-Z を見る）が
  真逆を向いてしまう。対策として `cameraEl.getObject3D("camera")` で **`PerspectiveCamera` 本体**を取得し、
  そこに直接 `position`/`lookAt` を適用する（`isCamera` 分岐 → -Z が対象を向く＝正しい）。
  `#rig` は `position="0 0 0"` の単位変換に固定しているので、camera 本体の local=world として扱える。
- `look-controls`/`wasd-controls` は `enabled: false` にして自前のカメラ制御と競合させない。
- `embedded` + CSS の `!important` で `<a-scene>` のキャンバスを #wrap(960x540) に収める（全画面化を抑止）。
- `dt` は `tick(time, timeDelta)` の `timeDelta`(ms) を秒へ変換し `min(0.05, max(0, dt))` でクランプ（three.js 版と一致。下限は 0）。

## AI 生成所感

three.js 参照実装が `THREE.Raycaster` + `InstancedMesh` というほぼ素の three API だったため、
A-Frame への移植は「ループ本体を `tick` に、初期化を `init` に移す」だけで済み、ロジック改変はほぼゼロだった。
A-Frame 固有の難所は描画処理ではなく **カメラの Group/Camera 二層構造**で、ここだけは
T1 と同じく `getObject3D('camera')` 直接制御で回避する定石が効く。`renderer.info` も
`sceneEl.renderer` 経由でそのまま使え、HUD の Draws/Tris は four ライブラリで素直に揃う。
