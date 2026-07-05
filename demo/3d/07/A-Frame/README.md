# 3D テーマ7 ― ボクセルチャンク再生成（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一挙動」で移植したもの。
仕様の唯一の正は `../SPEC.md`。チャンク/セル構成・波・色・カメラ・HUD はすべて SPEC / three.js 版と一致させている。
**比較の主軸 = 毎フレームの頂点バッファ再構築と GPU 再アップロードのスループット**。

## 起動方法

画像/GLB は使わない（コード生成ジオメトリのみ）が、CDN 読込のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/07
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- `+` / `-`（および `]` / `[`）: チャンク数 NC の増減（最小 2 = 4チャンク / 最大 8 = 64チャンク）。**比較の主軸**。
- `R`: NC を初期値（4 = 16チャンク）に戻す。
- カメラ固定・波は自動進行（無人ベンチ可）。

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。
  - 正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

## 実装メモ ― 動的 BufferGeometry 更新をカスタムコンポーネントで移植

- **宣言タグでは表現できない毎フレーム更新をカスタムコンポーネント `voxels` でラップ**:
  - 背景色は `<a-scene background>`、カメラは `<a-entity camera>` で宣言的に記述。
  - チャンクメッシュ群（ボクセル地形）とライト（環境光 + 平行光1灯）は `voxels` の `init()` 内で `AFRAME.THREE` から生成し、`this.el.object3D`（= `<a-scene>` の object3D）に `add` する。
  - メインループは `voxels` の `tick(time, timeDelta)` に実装。`timeDelta`（ms）を秒へ変換し 0.05 でクランプ（three.js 版 `frame()` と同一）。
- **事前確保バッファ + 毎フレーム再アップロード（テーマの主役）**:
  - `makeChunk()` で 1チャンク = 144セル × 30頂点 = 4320頂点ぶんの `position/normal/color` を `Float32Array` で**事前確保**し、`THREE.BufferAttribute(..., 3).setUsage(THREE.DynamicDrawUsage)` で属性に設定。`MeshLambertMaterial({ vertexColors: true })`、`frustumCulled = false`。
  - `rebuildChunk()` で各セル「上面1枚 + 側面4枚 = 5クアッド = 30頂点」を**配列の中身だけ書き換え**（再アロケートしない）、`attributes.position/normal/color.needsUpdate = true` で GPU へ再アップロード。隣接カリングはせず一律生成（4ライブラリで揃えるため）。
  - 高さは `heightAt(gx, gz, t)` の波（整数ステップでブロック感）、色は `heightColor(h)`（緑→茶→白）。`gx/gz` はチャンクをまたいで連続するグローバル列座標。
  - `tick` で毎フレーム全チャンクの `rebuildChunk` を呼ぶ。これが「毎フレーム全チャンク再構築＋再アップロード」の負荷の主役。
- **カメラの罠（最重要）**: `<a-entity camera>` に `look-controls="enabled: false"` / `wasd-controls="enabled: false"` を付けて A-Frame 既定の入力を無効化したうえで、`tick` 内で **`cameraEl.getObject3D("camera")`（= 実体の `THREE.PerspectiveCamera`）に対して** `position.set(0,60,95)` と `lookAt(0,4,0)` を一度だけ設定する。
  - `<a-entity>` の `object3D` は `THREE.Group` であり、`Group.lookAt` は **+Z** を対象へ向ける（非カメラ分岐）。一方 `PerspectiveCamera` は **-Z** を見るため、Group に lookAt すると**カメラが逆（真後ろ）を向く**。必ず `getObject3D("camera")` で取った camera 本体に lookAt する。
  - camera 本体は `init` 時には未生成のことがあるため、`tick` で「生成済みになったら一度だけ設定」というフラグ（`cameraSet`）でガードしている。カメラは固定なので毎フレーム更新は不要。
- **`AFRAME.THREE` 利用**: 冒頭で `const THREE = AFRAME.THREE;` とし、`makeChunk` / `rebuildChunk` / `heightColor` などを three.js 版とほぼ同一コードで記述。
- **HUD は `renderer.info`**: `this.el.sceneEl.renderer.info.render.calls / triangles` から Draws / Tris を取得（three.js 版と同じ）。HUD 5項目（FPS / Objects=NC×NC / Chunks=`NC×NC` / Draws / Tris）、help、note は `<a-scene>` の外側の HTML オーバーレイで three.js 版と同一構造・CSS（960x540）。`<a-scene embedded>` で `#wrap`（960x540）内に収めている。数フレームに1回 HUD 更新。
- **座標系**: A-Frame は three.js と同じ右手系・Y軸上向き。SPEC 通りブロック柱は底 y=0 〜 上面 y=h。

## AI コーディング生成のしやすさ所感

- A-Frame は「宣言的タグ」志向のため、AI に素直に書かせると `<a-box>` を大量に並べる実装になりがちで、テーマの主役である「毎フレームの BufferGeometry 再構築/再アップロード」がまったく再現できない。**カスタムコンポーネント内で `AFRAME.THREE` の `BufferGeometry` を直接叩き、事前確保配列を書き換える**という方針を最初に明示する必要がある。一度その方針を与えれば、`init()`/`tick()` が three.js のセットアップ/ループに綺麗に対応し、移植は機械的で容易。
- 罠は主に 2 点: (1) `look-controls`/`wasd-controls` を無効化しないとカメラ手動制御が打ち消される、(2) `<a-entity>` の `object3D`（Group）に lookAt するとカメラが逆を向く ― 必ず `getObject3D("camera")` の camera 本体に lookAt する。さらに camera 本体は init 時に未生成のことがあるため tick で一度だけ設定するガードが要る。
- 動的バッファ更新（`DynamicDrawUsage` + `needsUpdate`）も `renderer.info` も three.js と同一 API のため、その部分の移植コストはゼロに近い。総じて「three.js を知っていれば書ける」が、宣言性と毎フレーム手続き更新の橋渡し、およびカメラ本体の取得という最初の設計判断が要る、という所感。
