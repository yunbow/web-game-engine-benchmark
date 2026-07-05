# 3D テーマ10（T10）大量レイキャスト（LIDAR スキャナ）— PlayCanvas（エンジンのみ・CDN）

中心スキャナから毎フレーム **N 本のレイ**を全方位へ放ち、半径 28 の球殻上に並ぶ
**M=120 個の軸整列ボックス**との最近交差を求め、当たり点に小球を表示する。
比較の主軸は **N×M のレイキャスト（レイ-AABB 交差）＋当たり点描画のスループット**。

three.js リファレンス実装（`../three.js/`）と **同一仕様**。数値は `../SPEC.md` が唯一の正。

## 起動方法

`file://` 直開きは不可。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/10
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/
```

操作:

- `+` / `-`（`]` / `[`）: レイ数 N の増減（±1500 / 最小 500・最大 15000）
- `R`: レイ数を初期値 1500 に戻す
- カメラ自動周回・スキャナ自動（無人ベンチ可）

## 使用バージョン

- PlayCanvas: `https://code.playcanvas.com/playcanvas-stable.min.js`（stable・UMD グローバル `pc`）
- WebGL2 を明示（`deviceTypes: [pc.DEVICETYPE_WEBGL2]`）。WebGPU は使わない。
- 画像 / GLB 不使用。`createBox` / `createSphere` のプリミティブのみ。

## レイ-メッシュ交差の実装（各エンジンの機構）

SPEC では「レイ-メッシュ交差は各エンジンの機構を使う」とあるが、
**PlayCanvas には three の `Raycaster` / Babylon の `Ray.intersectsMesh` のような
レイ-メッシュ（任意ジオメトリ）交差の組み込みが無い**。
（`pc.Ray` と `pc.BoundingBox.intersectsRay` 等の AABB ユーティリティはあるが、
レイキャストAPIとしての一括メッシュピックは無く、`RigidBodyComponentSystem.raycast`
は物理エンジン（ammo）依存でこのテーマの趣旨に合わない。）

そこで **自前のレイ-AABB（スラブ法）** を実装した。ターゲットは全エンジン共通で
**軸整列（無回転）ボックス**なので、AABB = `center ± BOX/2`（= center ± 2）で正確に表せる。

- 各ターゲットの中心 `(cx,cy,cz)` を `Float32Array` に保持。
- 各レイ `origin → dir`（`dir` はフィボナッチ球の単位ベクトル＋Y回転）について、
  方向成分の逆数 `1/dx, 1/dy, 1/dz` を一度だけ計算し、X/Y/Z の各スラブで
  `tmin = max(min(t1,t2))`, `tmax = min(max(t1,t2))` を更新。
  `tmax >= max(tmin, 0)` なら交差、入口 `t`（origin が箱内なら 0）を返す。
- 全 M 個を走査して **最小 t**（最も近い当たり）を採用。`t` は `[0, FAR=200]` でクランプ。
- 当たり点 = `origin + dir * t`。three の `Raycaster.intersectObject(targets)` が返す
  `hit[0].point` と同じ「最近交差点」になる。

`dir` 成分が 0 のときは `1/0 = ±Infinity` となるが、スラブ法は IEEE754 の
無限大演算でそのまま正しく動く（軸に平行なレイ → そのスラブは常に交差扱い）ので
特別扱いは不要。

## つまずき / 既知の罠

- **【最重要】IIFE 隔離**: PlayCanvas は classic script（UMD）で読み込むため、`game.js`
  はモジュールスコープを持たない。トップレベルの `const W` 等がグローバルに漏れ、
  他テーマ・複数読み込み時にグローバル衝突を起こしうる。そこで **`game.js` 全体を
  `(function(){ ... })();` の IIFE で包んで**ローカルスコープに閉じた。
- **インスタンス描画は T1 方式**: `pc.VertexFormat.getDefaultInstancingFormat` の
  動的 `VertexBuffer`（float32×16 行列）を `MeshInstance.setInstancing` で割り当て、
  毎フレーム `vb.setData()` ＋ `meshInstance.instancingCount = hits` で当たり点数だけ描く。
  ターゲット（M 固定）も同方式の hardware instancing。
- **Draws/Tris はベストエフォート**: Draws は `app.stats.drawCalls.total`
  （v2 系は `device.stats` ではなくこちら）。Tris はインスタンシングのため統計に
  正確な合計が出ないので、`boxTris × M + hitTris × hitCount` の自前概算とした。
- **ライト方向の差**: three の `DirectionalLight` は position→target（原点）方向に照らす。
  PlayCanvas の directional はエンティティ forward(-Z) が光の進行方向。
  そこで `lookAt(-(0.4,1,0.5))` 相当で進行方向を合わせた。
- **当たり点・スキャナ・ターゲット色**は three 版と同色（`#ffd54a` / `#6cff9a` / `0x6d8db0`）。
  マーカー類は `useLighting=false` ＋ `emissive` で three の `MeshBasicMaterial` 相当に。
- **dt は `app.on('update', dt)` の dt** をそのまま `min(0.05, max(0, dt))` でクランプ
  （three 版 `requestAnimationFrame` の自前 dt と同条件）。

## AI 生成所感

- レイ-AABB はスラブ法の定石どおりで、軸整列ボックス前提なら three の Raycaster と
  数値的にほぼ一致する当たり点が得られる（誤差は浮動小数のみ）。レイ-メッシュ組み込みが
  無い PlayCanvas でも、ターゲット形状を AABB に限定する SPEC の設計のおかげで素直に移植できた。
- 性能の主役は **N×M の二重ループ**（最大 15000×120 = 180万回/フレーム）。逆数の事前計算と
  早期 `Math.min/max` だけで、JS 単スレッドとしては素直なホットパス。描画は当たり点の
  インスタンス更新（`setData`）が主コスト。three の `InstancedMesh` 更新と構造的に等価。
- 三角形数が概算になる点と、レイキャストが GPU でなく CPU 実装である点が、他エンジンとの
  「同一機構ではない」差分。SPEC が明示的に「PlayCanvas は自前 ray-AABB」と許容している。
