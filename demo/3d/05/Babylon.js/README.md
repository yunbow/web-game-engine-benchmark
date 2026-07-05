# 3D テーマ5（T2） ― 広域地形 + フラスタムカリング / LOD / 描画距離（Babylon.js 版）

`../SPEC.md` を唯一の正として、three.js リファレンス実装（`../three.js/`）を Babylon.js v8 へ「同一挙動」で移植したもの。比較主軸は **広域シーンの可視範囲のみ描画（フラスタムカリング）＋距離LOD＋描画距離**。

## 起動方法

`file://` 直開きは不可（CORS）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/05
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

画像/GLB は不使用（プリミティブのみ）なので、サーバ無しでも動くが、他エンジンと手順を揃えるため上記で起動推奨。

## 操作

- `+` / `-`（`]` / `[`）: 描画距離 drawDist を ±40（最小 40 / 最大 360）。**比較の主軸**。
- `R`: 描画距離を初期値 120 に戻す。
- カメラは自動周回飛行（無人ベンチ可）。

## 使用バージョン

- **Babylon.js**: CDN `https://cdn.babylonjs.com/babylon.js`（UMD グローバル `BABYLON`、最新安定版 v8 系）
- レンダラ: **WebGL2**（Babylon 既定。WebGPU は不使用）

## 実装メモ ― カリング / LOD / 距離カリング

### 木の表現: 元メッシュ + InstancedMesh（採用方式）
- `trunkSrc`（幹・Cylinder 6分割）/ `foliageSrc`（葉・Cone 8分割）/ `lowSrc`（LOD1 低コーン 4分割）の
  **3 つの元メッシュを 1 度だけ生成**し、`setEnabled(false)` で本体は非表示にする。
- 各木（10000 本）は、その 3 メッシュの **`mesh.createInstance()`**（= `InstancedMesh`）として作る。
  つまりジオメトリは完全共有、木 1 本につきトランク/葉/低コーンの 3 インスタンスを持つ。
- **なぜ thinInstance ではなく InstancedMesh か**: `thinInstance` はルートメッシュの単一境界で
  一括フラスタム判定されるため、フィールド全体に散る 10000 本では「視錐台外を個別に除外」できない
  （= カリングが効かず、Draws が InRange より小さくならない）。`InstancedMesh` は**インスタンス単位で
  自動フラスタムカリング**されるので、SPEC の「Draws < InRange」を観測できる。SPEC 指定どおりの選択。
- `clone` でも共有ジオメトリは保てるが、`createInstance` の方が描画バッチが効きメモリ・draw call とも軽い。

### pivot（three.js geo.translate との一致）
- three.js は `geo.translate` で頂点を底合わせしている。Babylon の Cylinder/Cone は中心原点なので、
  `bakeTransformIntoVertices(Matrix.Translation(0, dy, 0))` で頂点を同じだけ持ち上げて一致させた:
  trunk +1（h2 → 底 y=0）/ foliage +4（幹頂上）/ lowCone +3（h6 → 底 y=0）。
- Cone は `diameterTop:0` の Cylinder で表現。three.js `ConeGeometry(1.7,…)`（半径1.7）→ 直径 3.4。

### 個体差（PRNG 消費順を厳守）
- mulberry32（seed=`0x9e3779b9`）で **`hf`（高さ係数 0.8〜1.4）を先、`ry`（Y回転）を後**に消費。
  three.js 版と同順序なので各木の値がビット一致する。`scaling.y = hf` で高さだけスケール。
- 木は静的なので各インスタンスに **`freezeWorldMatrix()`**。これでワールド行列再計算の CPU を削減。
  freeze 後も `setEnabled()` の表示切替・フラスタムカリング（境界は固定行列から 1 度算出）は正常動作する。

### 距離カリング + LOD（毎フレーム・アプリ側）
- カメラと各木の**水平距離 d**（平方距離 `d2` で比較）を計算:
  - `d2 > drawDist²` → 3 インスタンスとも `setEnabled(false)`（描画距離外・非表示）。
  - `d2 ≤ (drawDist*0.5)²` → **LOD0**: trunk + foliage を enable、low を disable。
  - その間 → **LOD1**: low を enable、trunk/foliage を disable。
- `setEnabled(false)` のメッシュは描画されず、`setEnabled(true)` でも視錐台外は Babylon が自動除外。
  → HUD の **Draws < Objects(InRange)** となり、フラスタムカリングの効きが観測できる。

### カメラ
- `FreeCamera` を手動更新（`attachControl` を呼ばない）。`fov = 60*π/180` は**垂直 FOV**
  （Babylon 既定 `FOVMODE_VERTICAL_FIXED`）で three.js の `PerspectiveCamera(60,…)` と一致。`minZ=0.5 / maxZ=1200`。
- 毎フレーム周回飛行: `θ=t*0.15`、`pos=(140cosθ, 26, 140sinθ)`、`setTarget(56cosθ, 2, 56sinθ)`。
- 座標系は `scene.useRightHandedSystem = true`（three.js と同じ右手系・Y 上）で揃える。

### fog / 背景 / 地面
- `scene.clearColor = #8fb8e6`、fog は `FOGMODE_LINEAR`・`fogStart=80 / fogEnd=400`・色 `#8fb8e6`
  （three.js `Fog(0x8fb8e6, 80, 400)` 相当）。
- 地面は `CreateGround(900×900)`、暗緑 `#24402a`。ライトは Hemispheric（`#bcc8d8` 強度0.8）+ Directional（白 強度1.0）。

### HUD / 計測
- HUD は HTML オーバーレイ（three.js 版と同一構造・CSS）。5 行（FPS/Objects/DrawDist/Draws/Tris）。数フレームに1回更新。
- **Objects** = InRange（drawDist 内の木の本数、距離カリング後）。
- **Draws** = `BABYLON.SceneInstrumentation` の `drawCallsCounter.current`（フラスタムカリング後の実 draw call）。
- **Tris** = 概算（注記）。距離内の近距離本数×(幹+葉) + 中距離本数×低コーン + 地面の三角形数を積算。
  視錐台カリング前の InRange ベースなので上限寄りの概算（正確な集計 API がないため）。

## つまずき / 罠

- **thinInstance を選ぶとカリングが効かない**: ルート 1 境界で一括判定され、10000 本のうち視錐台外を
  個別除外できない。SPEC の「Draws < InRange」を満たすには **InstancedMesh（個別フラスタムカリング）** が必須。
  ここが本テーマで一番効く設計判断。
- **freeze と enable の関係**: `freezeWorldMatrix()` した静的インスタンスでも `setEnabled()` の切替・
  フラスタムカリングは効く（freeze はワールド行列再計算のみを止める）。距離 LOD のための enable 切替と両立する。
- **pivot ずれ**: Babylon プリミティブは中心原点。three.js の `geo.translate` を `bakeTransformIntoVertices` で
  再現しないと木が地面に半分埋まる/浮く。trunk/foliage/lowCone それぞれの底合わせを忘れない。
- **Cone API**: Babylon に Cone 専用ビルダーは無く `CreateCylinder(diameterTop:0,…)` で代用。tessellation で
  分割数（LOD0 葉=8、LOD1=4）を合わせる。

## AI コーディング生成のしやすさ所感

- 「元メッシュ + createInstance + 個別 enable/距離 LOD」は three.js の「共有ジオメトリ + Group 可視切替」を
  ほぼ機械的に置換でき、移植コストは低い。`setEnabled` ベースの距離カリングは API が直感的。
- 唯一の判断所が **thinInstance vs InstancedMesh**。AI は大量描画と聞くと thinInstance を選びがちだが、
  本テーマは「個別フラスタムカリングを観測する」のが目的なので InstancedMesh が正解。SPEC に方式を明記しておくと安全。
- 垂直 fov・freeze 後の enable 動作など Babylon の既定挙動が three.js と素直に噛み合い、座標系（右手系）と
  pivot さえ押さえれば挙動を一致させやすかった。
