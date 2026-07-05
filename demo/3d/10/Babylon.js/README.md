# 3D T10 大量レイキャスト（LIDAR スキャナ） — Babylon.js 版

中心スキャナから毎フレーム N 本のレイを全方位へ放ち、半径28の球殻に並んだ M=120 個の
ターゲットボックスとの**最近交差**を `BABYLON.Ray.intersectsMeshes` で求め、当たり点に
小球（thin instances）を表示する LIDAR 可視化。比較の主軸は**毎フレームの大量レイキャスト
（レイ×ターゲットメッシュ交差）のスループット**。仕様は `../SPEC.md` が唯一の正。

## 起動方法

`file://` 直開きは不可（HTTP サーバ必須）。テーマフォルダをルートにサーバを立てる:

```bash
cd 3d/10
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

## 操作

- `+` / `-`（`]` / `[`）: レイ数 N の増減（±1500、最小500 / 最大15000）。**比較の主軸**。
- `R`: レイ数を初期値 1500 に戻す。
- カメラ自動周回・スキャナ自動（無人ベンチ可）。

## 使用バージョン

- Babylon.js（CDN: `https://cdn.babylonjs.com/babylon.js`、最新安定 = v8 系）。
- WebGL2。画像 / GLB 不使用・プリミティブ（box / sphere）のみ。

## レイ-メッシュ交差の実装（採用方式とつまずき）

### 採用方式: 個別 mesh + `Ray.intersectsMeshes([...], false)`

ターゲット M=120 を**個別の `Mesh`（CreateBox）**として生成し、毎フレーム
`ray.intersectsMeshes(targets, false)` で全ターゲットとの交差を評価、距離ソート済み配列の
`[0]`（最近交差）の `pickedPoint` を当たり点に採用する。

- **描画は 120 ドロー**になる（thin instances 化していない）。ただし当たり点マーカーは
  thin instances 1 ドローにまとめている。比較主軸はレイキャスト負荷なので、ターゲット側の
  120 ドローは許容（HUD の Draws もこれを反映）。
- thin instances + `thinInstanceEnablePicking` 方式も検討したが、**最近の thin instance の
  交差「点」を安定して取得しにくい**（picking はメッシュ単位、サブインスタンスの最近判定に
  追加処理が要る）ため、確実に最近交差点が取れる個別 mesh 方式を選んだ。

### つまずきどころ

1. **`fastCheck` の意味が直感と逆**。`intersectsMeshes(meshes, fastCheck)` の第2引数を
   `true` にすると「**最初に当たったメッシュ**で即打ち切り」になり、最近交差にならない。
   結果配列は距離ソートされるが、打ち切ると候補が揃わないため `[0]` が最近とは限らない。
   **全メッシュを評価して最近を出すには `false` が必須**。ここを取り違えると当たり点が
   ターゲット背面に飛ぶ等のズレが出る。
2. **`ray.length` が far 上限**。`new BABYLON.Ray(origin, dir, FAR)` の第3引数が長さ。
   毎フレーム origin/direction を更新するので、念のため `ray.length = FAR` を都度セット。
   交差判定（`intersectsTriangle`）は `distance > length` を弾くため far=200 が効く。
3. **右手系必須**。Babylon 既定は左手系。`scene.useRightHandedSystem = true` にして
   ようやく three.js のフィボナッチ球座標式（Y 上・原点中央）がそのまま一致する。
   ここを忘れると Z 反転でターゲット配置・交差結果が three.js とズレる。
4. **静的ターゲットは `freezeWorldMatrix()`**。配置後に凍結しても picking は機能する
   （`intersectsMesh` は world 逆行列でレイを local 空間へ変換するだけ）。毎フレームの
   ワールド行列再計算を省ける。
5. **GC 圧**。`intersectsMeshes` はメッシュごとに `PickingInfo` を新規生成するため、
   N×M（最大 15000×120）で大量のオブジェクトが生まれる。これは「同一負荷での FPS」を
   測る比較対象そのものなので最適化せず素直に実装している。

## AI 生成所感

three.js 版は `InstancedMesh` 1 個を `Raycaster.intersectObject` に渡すだけで最近交差点が
取れるのに対し、Babylon は「最近交差を取る API 形（`fastCheck=false`）」と「個別 mesh 配列」を
正しく選ばないと結果がズレる点が最大の差異だった。右手系切り替えと `fastCheck` の意味を
押さえれば移植自体は素直。当たり点は thin instances でまとめられるが、ターゲットを個別 mesh に
した分のドロー数（120）は three.js 版（1 ドロー）より多く、Draws 比較ではここを念頭に置く。
