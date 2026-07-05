# 3D テーマ1 ― インスタンス小惑星フィールド（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一挙動」で移植したもの。
仕様の唯一の正は `../SPEC.md`。数値・ルール・座標系・カメラ・HUD はすべて SPEC / three.js 版と一致させている。

## 起動方法

画像/GLB は使わないが、CDN 読込とローカル配信のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/01
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- 移動: 矢印キー / WASD（x/y 平面を8方向、範囲クランプ）
- 発射: 常時オート連射（150ms ごと）
- `+` / `-`（および `]` / `[`）: 小惑星の同時数を ±1000（最小 1000 / 最大 50000）
- `P`: オートプレイのトグル（決定的に左右往復）
- `R`: ゲームオーバー後の再開

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。
  - A-Frame 1.7.0 同梱の three.js はおおよそ **r173 系**（A-Frame のリリースに追従）。正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

## 実装メモ

- **宣言的 `<a-scene>` ＋ 大量描画はカスタムコンポーネントでラップ**:
  - 背景色・カメラ・ライトは `<a-scene background>` / `<a-entity camera>` / `<a-light>` で宣言的に記述（A-Frame らしさを維持）。
  - 大量インスタンス描画（小惑星 / 弾）は宣言タグでは表現できないため、カスタムコンポーネント `game-field` の `init()` 内で `AFRAME.THREE.InstancedMesh`（小惑星=icosahedron detail=0 の 20面、弾=低分割 sphere）を生成し、`this.el.object3D`（= `<a-scene>` の object3D）に `add` している。
  - メインループは `game-field` の `tick(time, timeDelta)` に実装。`timeDelta`（ms）を秒へ変換し 0.05 でクランプ。PRNG・小惑星更新・リサイクル・弾・自前球当たり判定・`setMatrixAt` / `instanceMatrix.needsUpdate` / `count` 設定まで three.js 版 `frame()` と同一ロジック。
- **カメラの手動制御**: `<a-entity camera>` に `look-controls="enabled: false"` / `wasd-controls="enabled: false"` を付けて A-Frame 既定の入力を無効化し、`tick` 内で `cameraEl.object3D.position.set(...)` と `lookAt(...)` を毎フレーム更新。自機後方やや上（自機 +(0,6,22)）に置き、自機 +(0,2,0) を注視。fov 60 / near 0.1 / far 2000 は camera コンポーネント属性で指定。
- **`AFRAME.THREE` 利用**: 冒頭で `const THREE = AFRAME.THREE;` とし、以降の three API 呼び出しを three.js 版とほぼ同一コードで記述。
- **HUD は `renderer.info`**: `this.el.sceneEl.renderer.info.render.calls / triangles` から Draws / Tris を取得（three.js 版と同じ）。HUD / help / over は `<a-scene>` の外側の HTML オーバーレイで、three.js 版と同じ構造・CSS（960x540、同じ7項目）。`<a-scene embedded>` で `#wrap`（960x540）内に収めている。
- **InstancedMesh のカリング無効化**: `frustumCulled = false` を設定。InstancedMesh のバウンディングは初期インスタンス基準で計算されるため、毎フレーム移動する小惑星が誤ってカリングされるのを防ぐ。
- **座標系**: A-Frame は three.js と同じ右手系・Y軸上向き。SPEC 通り小惑星は -Z（奥）から +Z（手前）へ流れる。

## AI コーディング生成のしやすさ所感

- A-Frame の「宣言的タグ」と「大量描画（インスタンシング）」は相性が悪く、AI に素直に書かせると `<a-entity>` を数千個並べる非現実的な実装になりがち。**カスタムコンポーネント内で AFRAME.THREE を直接叩く**という方針を明示する必要がある。一度その方針を与えれば、`init()`/`tick()` のライフサイクルが three.js のセットアップ/ループに綺麗に対応するため、three.js 版からの移植自体は機械的で容易。
- 罠は主に 2 点: (1) `look-controls`/`wasd-controls` を無効化しないとカメラ手動制御が打ち消される、(2) `<a-scene>` が独自に three.js を内包するため別途 three を import しない（`AFRAME.THREE` を使う）。この 2 点を押さえれば three.js 版とほぼ等価なコードになる。
- HUD の Draws/Tris も `sceneEl.renderer.info` で three.js と同一 API のため移植容易。総じて「three.js を知っていれば書ける」が、宣言性と大量描画の橋渡しに最初の設計判断が要る、という所感。
