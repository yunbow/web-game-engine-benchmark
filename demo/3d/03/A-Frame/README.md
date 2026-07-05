# 3D テーマ3（T4）― スキンドキャラ大群（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一挙動」で移植したもの。
仕様の唯一の正は `../SPEC.md`。数値・配置・カメラ・ライト・HUD・アニメ設定はすべて SPEC / three.js 版と一致させている。

**比較の主軸 = スキンドメッシュ（スケルタルアニメ）の大量再生スループット。** 共有 glTF（`../assets/CesiumMan.glb`）を N 体複製し、各個体が独立した `AnimationMixer` でその場歩行ループを再生する。

## 起動方法

GLB 読込のため `file://` 直開きは不可（CORS）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/03
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

GLB 未配置でも図形フォールバック（弾むカプセル）で必ず起動する。

## 操作

- `+` / `-`（および `]` / `[`）: キャラ数 N を ±25（最小 10 / 最大 1000）→ 群衆を再構築
- `R`: 再構築（リセット）
- 入力なしでもアニメは進行（無人ベンチ可）

## 使用バージョン・採用方式

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。
  - A-Frame 1.7.0 の同梱 three は `super-three@0.173.4`（three **r173** 系のフォーク）。正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

### 採用方式 = 方式A（GLTFLoader 1回ロード → SkeletonUtils.clone → 個体ごと AnimationMixer）

- **glTF ロードは A-Frame 同梱の `gltf-model` コンポーネントに任せる**。隠しエンティティ `<a-entity id="loader" gltf-model="#man">` を置き、`<a-assets>` の `<a-asset-item id="man" src="../assets/CesiumMan.glb">` をプリロード。`model-loaded` イベントで `e.detail.model`（= `gltf.scene`）と `model.animations[0]`（歩行クリップ）を取得する。
  - **理由**: A-Frame 1.7.0 では GLTFLoader が ESM 内蔵で `THREE.GLTFLoader` として公開されない（ソース確認済み）。`new AFRAME.THREE.GLTFLoader()` は実行時に存在保証がないため、宣言的ロードを使うのが堅い。
- **複製は `SkeletonUtils.clone` 相当を自前インライン**（`game.js` 内 `skeletonClone()`）。three r173 の `examples/jsm/utils/SkeletonUtils.js` の `clone` 実装をそのまま移植した。
  - **外部 import しない理由**: three の `SkeletonUtils.js` は `import {...} from 'three'` のベア指定子を持ち、A-Frame は `'three'` をモジュールとして公開しないため、そのままでは読めない。CDN 版 `three@0.173.0/examples/jsm/...` を別 import するとバージョン不一致（super-three フォークとの差異）リスクがある。`clone` 実装は `source.clone()` / `skeleton.clone()` / `Map` のみで完結し THREE コンストラクタを使わないため、**`AFRAME.THREE` の世界の中で自動的に正しく動く**（version mismatch を原理的に回避）。
- **個体ごとに `new THREE.AnimationMixer(clone)`**。`clipAction(walkClip).play()` し、決定的乱数（mulberry32, seed=`0x9e3779b9`）で `timeScale ∈ [0.8,1.2]` と開始位相 `[0, clipDuration)` を与える。`tick` で全 mixer を `update(dt)`。N 体ぶんのスケルトン更新が毎フレーム走るのが負荷の主役。

### スキンドメッシュ複製の「つまずき」

- **通常の `Object3D.clone()` はスケルトンを共有して破綻する**。クローンが元のボーン配列を参照し続けるため、複数体が同じスケルトンを取り合い、アニメすると全員が暴れる/潰れる。**スキンドメッシュは `SkeletonUtils.clone`（= 親子をパラレル走査してボーン参照を張り替え、`skeleton.clone()` + `bind()` し直す）が必須**。
- **base モデルをシーンに残さない**: `gltf-model` は読み込んだ base を `setObject3D('mesh', model)` でシーンへ載せる。これはテンプレートとしてのみ使い、HUD の Draws/Tris に混ざらないよう `model.parent.remove(model)` してから複製している（three.js 版は base を add しない）。
- **ロード失敗の保険**: `model-error` に加え、preload が無言で失敗するケース用に 8 秒のセーフティタイマーを置き、未起動なら図形フォールバックへ切り替える。

### カメラの罠（T1 で踏んだもの）

- `<a-entity id="rig" camera="fov:50;near:0.1;far:2000" look-controls="enabled:false" wasd-controls="enabled:false">` で既定入力を無効化。
- **`rig.object3D`（Group）に `lookAt` すると逆を向く**（Group の `lookAt` は +Z を対象へ向ける非カメラ分岐に入り、子の `PerspectiveCamera`（-Z を見る）が真後ろを向く）。よって `cameraEl.getObject3D("camera")`（= `THREE.Camera` 本体、`isCamera` 分岐で -Z が対象を向く）に対して `position.set(0,12,26)` / `lookAt(0,1.5,0)` を設定している。rig は `position 0 0 0` 固定なので camera 本体の local = world。
- カメラ本体は `tick` 初回（camera object3D が生成されてから）に一度だけ設定する。

## 実装メモ

- 背景 `#10131a` / 環境光 + 平行光（`position 0.4 1 0.6`）/ 暗色地面（`<a-plane rotation="-90 0 0" 400x400 #1b2030">`）は宣言的タグで記述。大量複製・mixer 更新・HUD・入力はカスタムコンポーネント `crowd` の `init()`/`tick()` に実装。
- グリッド配置（`cols=ceil(sqrt(N))`, 間隔 2.2, 中心揃え, +Z 向き）・スケール（Box3 から身長 1.7 へ正規化＋接地オフセット）は three.js 版と同一。
- HUD は `this.el.sceneEl.renderer.info.render.calls/triangles` を 6 フレームに 1 回更新。項目は `FPS / Objects / Chars / Draws / Tris`。フォールバック時は `Chars` に `(fallback: no skin)` を付記。HUD/help/note は `<a-scene>` 外の HTML オーバーレイで three.js 版 T4 と同一構造・CSS（note は `skinned crowd: glTF + AnimationMixer`）。`<a-scene embedded>` で `#wrap`（960x540）内に収める。

## AI コーディング生成のしやすさ所感

- T4 の肝は「スキンド glTF を N 体に増やす」点で、ここは AI が**最も間違えやすい**。素直に `clone()` する実装を書きがちで、スケルトン共有で破綻する。`SkeletonUtils.clone` 必須という前提知識を明示しないと正解に辿り着けない。
- A-Frame 固有の難所は **GLTFLoader が `THREE.GLTFLoader` として公開されていない**こと。AI は three.js の癖で `new AFRAME.THREE.GLTFLoader()` を書きがちだが、1.7.0 では未公開。`gltf-model` コンポーネント＋`model-loaded` で受ける、という A-Frame 流の橋渡しが要る。
- SkeletonUtils を外部 CDN から import する案も成立しうるが、A-Frame は `super-three` フォークのため**バージョン整合の不確実性**が残る。`clone` 実装が THREE コンストラクタ非依存である点を見抜いて**自前インライン**するのが最も堅く、結果コードも素直になった。
- それ以外（`init`/`tick` ライフサイクル、`renderer.info` の HUD、カメラ手動制御の罠）は T1 と同じ要領で、three.js 版からの移植は機械的。総じて「three.js を知っていれば書けるが、スキンドクローンと GLTFLoader 公開有無の 2 点で設計判断が要る」という所感。
