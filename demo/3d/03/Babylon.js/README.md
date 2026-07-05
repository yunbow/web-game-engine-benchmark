# 3D テーマ3（T4）― スキンドキャラ大群（Babylon.js 版）

`../SPEC.md` を唯一の正として、three.js リファレンス実装（`../three.js/`）を Babylon.js v8 へ「同一挙動」で移植したもの。比較主軸は **スキンドメッシュ（スケルタルアニメ）の大量再生スループット**。共有 glTF（`../assets/CesiumMan.glb`）を N 体複製し、各個体が独立したスケルトンと AnimationGroup を毎フレーム評価する負荷を測る。

## 起動方法

`file://` 直開きは不可（GLB の CORS 読込ができない）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/03
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

GLB が読めない場合でも、図形（カプセル）フォールバックで必ず起動する（HUD の Chars に `(fallback: no skin)` を表示）。

## 操作

- `+` / `-`（`=` / `_`、`]` / `[`）: キャラ数 N を ±25（最小 10 / 最大 1000）→ 群衆を再構築
- `R`: 再構築（リセット）
- 入力なしでもアニメは進行（無人ベンチ可）

初期 50 体。全個体 +Z 同一向き・その場歩行（前進しない）。

## 使用バージョン

- **Babylon.js（コア）**: CDN `https://cdn.babylonjs.com/babylon.js`（UMD グローバル `BABYLON`、最新安定版 v8 系）
- **glTF/GLB ローダ**: CDN `https://cdn.babylonjs.com/loaders/babylonjs.loaders.min.js`
  - これは `@babylonjs/loaders` 全部入りの minified バンドル（glTF/OBJ/STL/FBX/BVH を含む）。読込時に `BABYLON.GLTFFileLoader` を登録し、`.glb`/`.gltf` を `SceneLoader` で扱えるようにする。**コアより後に読み込む**こと。
- レンダラ: **WebGL2**（Babylon 既定。WebGPU は不使用）。スキニングは頂点シェーダ（GPU スキニング）。

## 実装メモ（スキンド複製とアニメ駆動）

### AssetContainer で 1 回ロード → 個体ごとに独立複製（負荷の主役）
- `BABYLON.SceneLoader.LoadAssetContainer(rootUrl, fileName, scene, onSuccess, onProgress, onError)` で GLB を **1 回だけ** `AssetContainer` に読み込む。`LoadAssetContainer` は既定でシーンに add しない（複製元のグラフとして保持）。
- 各キャラは `container.instantiateModelsToScene(nameFn, cloneMaterials)` で複製する。返り値 `{ rootNodes, skeletons, animationGroups }` が示すとおり、**メッシュ・スケルトン・AnimationGroup が個体ごとに独立に新規生成される**。これが three.js 版の `SkeletonUtils.clone()` + 個別 `AnimationMixer` に対応する負荷の正体（N 体ぶんのスケルトン更新が毎フレーム走る）。
  - `cloneMaterials=false`（既定）でマテリアルは共有。スキニングのコストを比較したいので、マテリアル複製は不要。
- 通常の `mesh.clone()` ではスキンが正しく複製されない点は three.js（普通の `clone` 不可で `SkeletonUtils.clone` が要る）と同じ事情で、Babylon では `instantiateModelsToScene` がその役割を担う。

### speedRatio（timeScale）と開始位相の与え方
- 個体の再生速度 `timeScale ∈ [0.8,1.2]` は `AnimationGroup.start(loop, speedRatio, from, to)` の **speedRatio** に渡す（`start(true, speed, g.from, g.to)`）。
- 開始位相 `phase ∈ [0,1)` は、クリップのフレーム範囲 `g.from`〜`g.to` に対し `f = g.from + (g.to - g.from) * phase` を計算し、`start` 後に `g.goToFrame(f)` で移動する（ベストエフォート）。three.js 版の `action.time = phase * clip.duration` に相当。
- アニメの進行は `scene.render()` 内で AnimationGroup が自動で行う（手動 update 不要）。three.js 版が毎フレーム `mixer.update(dt)` を回すのに対し、Babylon は AnimationGroup 駆動なのでメインループ側にアニメ更新コードは無い。

### bounding box から統一スケール＋接地オフセット
- ロード後、`container.meshes` の各メッシュの `getBoundingInfo().boundingBox`（`minimumWorld`/`maximumWorld`）を集約して全体の min/max を求め、身長 `h = max.y - min.y` を算出。
- `modelScale = TARGET_H / h`（TARGET_H=1.7）で統一スケール、`footOffset = -min.y * modelScale` で接地オフセット。three.js 版の `Box3.setFromObject` → `TARGET_H / h` → `-box.min.y * scale` と同じ算出。
- スケールは各個体の `rootNode.scaling` に適用、Y 位置は `footOffset` を使う。

### カメラ / ライト / 地面 / 座標系
- `FreeCamera` 固定。位置 `(0,12,26)`、`setTarget(0,1.5,0)`、`fov = 50*Math.PI/180`（垂直 FOV）、`minZ=0.1 / maxZ=2000`。`attachControl` は呼ばない。
- ライト: `HemisphericLight`（diffuse `#8899bb` / 強度 0.8）+ `DirectionalLight`（方向 `(-0.4,-1,-0.6)` 正規化・白・強度 1.1）。影なし。
- 地面: `MeshBuilder.CreateGround({width:400,height:400})`、暗色 `#1b2030`、y=0。背景 `#10131a`。
- **座標系は Babylon 既定の左手系のまま**にした。本テーマは前後移動が無くその場歩行のみ・全個体 +Z 同一向き・固定カメラ正面という見え方を一致させればよいため、T1（小惑星が -Z→+Z に流れる）で必要だった `useRightHandedSystem` は不要。左手系のまま `(0,12,26)` から原点を見れば three.js と同じ「正面やや上から見下ろす群衆」になる。

### 配置・決定性
- グリッド: `cols=ceil(sqrt(N))`, `rows=ceil(N/cols)`, 間隔 2.2, 中心揃え。`x=(c-(cols-1)/2)*2.2`, `z=(r-(rows-1)/2)*2.2`, `y=footOffset`。three.js 版と同一式。
- PRNG は mulberry32（seed=`0x9e3779b9`）。three.js 版とビット単位で同一、消費順序も同一（speed→phase）。`Math.random` 不使用＝決定的。

### フォールバック
- GLB 読込失敗（`onError`）時は `fallback=true`、`footOffset=1.0` とし、各キャラを `MeshBuilder.CreateCapsule`（radius 0.4 / height 1.8）に置換。同数・同配置で `y = baseY + max(0, sin(t*speed+phase)) * 0.4` の上下バウンドをアニメ（スキニングは再現しない）。HUD の Chars に `(fallback: no skin)` を表示。

### HUD / draw call / Tris
- HUD は HTML オーバーレイ（three.js 版と同一構造・CSS）。5 行（FPS/Objects/Chars/Draws/Tris）。数フレームに 1 回（6 フレームごと）更新。
- **Draws**: `BABYLON.SceneInstrumentation` の `drawCallsCounter.current`（ベストエフォート）。
- **Tris**: 概算（ロード時に集計したキャラ 1 体の三角形数 × N + 地面 2 三角）。Babylon に正確な毎フレーム集計 API がないため近似値（コメントに明記）。three.js 版は `renderer.info.render.triangles` の実測なので、ここは値が厳密一致しないことがある（概算は SPEC 注記で許容）。

## AI コーディング生成のしやすさ所感

- スキンドキャラの大量複製は Babylon では `AssetContainer.instantiateModelsToScene` という専用 API があり、「独立スケルトン＋独立 AnimationGroup を一発で複製」できる。three.js が `SkeletonUtils.clone` + `AnimationMixer` を手で組むのに比べ、移植は素直だった。
- 詰まりやすい点は (1) **ローダの読込順序**（コア → loaders の順でないと `SceneLoader` が glb を認識しない）、(2) **`LoadAssetContainer` が自動でシーンに add しない**こと（複製元をシーンに出さないのは正しい挙動だが、`Append`/`ImportMesh` と混同しやすい）、(3) **アニメ更新が AnimationGroup 任せ**で three.js の `mixer.update(dt)` のような明示ループが無いこと。
- 位相合わせは `goToFrame` が「フレーム単位」なので、three.js の「秒（time）単位」とは指定の粒度が違う。クリップのフレーム範囲 `from..to` に phase を掛けるという読み替えが要る（ベストエフォート）。
- 座標系は本テーマでは左手系のままで一致させられるので、T1 のような Z 反転の罠は出ない。AI が素直に書いても破綻しにくいテーマだった。
