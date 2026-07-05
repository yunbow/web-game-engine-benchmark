# 3D テーマ1 ― インスタンス小惑星フィールド（Babylon.js 版）

`../SPEC.md` を唯一の正として、three.js リファレンス実装（`../three.js/`）を Babylon.js v8 へ「同一挙動」で移植したもの。比較主軸は **同一メッシュの大量インスタンス描画スループット**。

## 起動方法

`file://` 直開きは不可（CORS）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/01
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

画像/GLB は不使用（プリミティブのみ）なので、サーバ無しでも動くが、他エンジンと手順を揃えるため上記で起動推奨。

## 操作

- 移動: 矢印キー / WASD（x/y 平面・60 u/s・範囲クランプ）
- 発射: オート連射（150ms ごと・弾速 400 u/s・-Z 方向）
- `+` / `-`（`]` / `[`）: 小惑星の同時数を ±1000（最小 1000 / 最大 50000）
- `P`: オートプレイ（決定的左右往復）トグル
- `R`: リスタート

## 使用バージョン

- **Babylon.js**: CDN `https://cdn.babylonjs.com/babylon.js`（UMD グローバル `BABYLON`、最新安定版 v8 系）
- レンダラ: **WebGL2**（Babylon 既定。WebGPU は不使用）

## 実装メモ

### 座標系（最重要トラップ）
- Babylon は **既定が左手系**。SPEC は右手系・Y 上・小惑星は -Z(奥)→+Z(手前) なので、
  `scene.useRightHandedSystem = true;` を**必ず**設定する。これを忘れると Z 方向が反転し、
  小惑星の流れ・カメラ追従・弾の進行方向がすべて逆になる（移植時に最初に踏む罠）。
- 右手系に統一したことで、自機コーンの向き（`rotation.x = -PI/2` で先端 -Z）やカメラ
  オフセット `(0, 6, 22)` も three.js とそのまま一致させられる。

### カメラ
- `FreeCamera` を手動更新。`attachControl` は呼ばず、デフォルトのマウス/キーボード操作を無効化。
- `camera.fov = 60 * Math.PI/180` は **垂直 FOV**（Babylon 既定 `FOVMODE_VERTICAL_FIXED`）。
  three.js の `PerspectiveCamera(60,...)` も垂直 fov なので一致。`minZ=0.1 / maxZ=2000`。
- 毎フレーム `camera.position = 自機+(0,6,22)`、`camera.setTarget(自機+(0,2,0))`。

### インスタンシング（thin instances）
- 小惑星: `MeshBuilder.CreateIcoSphere({radius:1, subdivisions:1, flat:true})`（20 面相当の低ポリ、
  three.js の `IcosahedronGeometry(1,0)` 相当）。
- 毎フレーム per-instance 行列を `BABYLON.Matrix.ComposeToRef(scale, quaternion, position, mtx)` で合成し、
  `mtx.copyToArray(buffer, i*16)` で 16 要素バッファへ詰め、`thinInstanceBufferUpdated("matrix")` で反映。
  `thinInstanceCount` に表示数を入れる（バッファは AST_MAX 分を確保し、生存ぶんだけ描画）。
- 色ティント: `thinInstanceSetBuffer("color", colorBuf, 4, true)` を初期化時に一度だけ。
  これを呼ぶと Babylon が自動で per-instance color を有効化するので、`StandardMaterial` 側に
  追加フラグは不要（`useVertexColor` は per-vertex 用なので使わない）。岩色は three.js の
  `Color.setHSL` と同式の HSL→RGB で決定的に生成。
- 弾も thin instances（`CreateSphere`、`MAX_BULLETS=64`、生存ぶんだけバッファに詰める）。
  `disableLighting=true` + `emissiveColor` で three.js の `MeshBasicMaterial` 相当。

### ライト
- `HemisphericLight`（diffuse/ground = `#6677aa`, 強度 0.7）+ `DirectionalLight`
  （方向 `(-0.5,-1,-0.3)` 正規化, 白, 強度 1.0）。three.js の Ambient+Directional に対応。

### HUD / draw call 取得
- HUD は HTML オーバーレイ（three.js 版と同一構造・CSS）。7 行（FPS/Objects/Score/HP/Asteroids/Draws/Tris）。
- **Draws**: `BABYLON.SceneInstrumentation` の `drawCallsCounter.current` から取得（ベストエフォート）。
- **Tris**: 概算で自前計算（小惑星 20 面 × 表示数 + 弾 1 個あたり ~96 三角 × 生存数）。
  正確な集計 API がないため近似値（コード内コメントに明記）。

### ロジックの同一性
- PRNG（mulberry32, seed=`0x9e3779b9`）・当たり判定（自前球・平方距離・z ゲート）・
  小惑星状態（SoA）・リサイクル・入力・発射・FIRE_MS 等は three.js 版から**そのまま移植**。
  数値は SPEC・three.js と完全一致（1 つも変えていない）。

## AI コーディング生成のしやすさ所感

- thin instances は API が素直（`thinInstanceSetBuffer` / `thinInstanceBufferUpdated` /
  `thinInstanceCount` の 3 点セット）で、SoA + 毎フレーム行列合成という three.js の
  `InstancedMesh.setMatrixAt` パターンをほぼ機械的に置換できた。
- 唯一の落とし穴は **左手/右手系**。AI は Babylon を素直に書くと左手系のまま生成しがちで、
  Z 反転に気付きにくい。`useRightHandedSystem = true` を仕様として明示しておくのが安全。
- 垂直 fov・per-instance color の自動有効化など「既定挙動が three.js と偶然一致する」点が多く、
  座標系さえ押さえれば移植コスト自体は低い。
