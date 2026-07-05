# 3D テーマ9 ― ナビ群衆 A*（A-Frame 実装）

three.js リファレンス実装（`../three.js/`）を A-Frame に「同一挙動」で移植したもの。
仕様の唯一の正は `../SPEC.md`。グリッド・障害物・A* 方式・エージェント数・ゴール挙動・カメラ・HUD はすべて SPEC / three.js 版と一致させている。

障害物のあるグリッド地面（40×40・セル 2u）を、多数のエージェント（円錐）が**共通ゴールへ自前 A* で経路探索**して移動する。**ゴールが 4 秒ごとに移動**すると**全エージェントが一斉に再計算**する（CPU 負荷のバースト）。`+`/`-` でエージェント数を増減して性能を比較する。

## 起動方法

画像/GLB は使わない（プリミティブのみ）が、CDN 読込のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/09
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- `+` / `-`（および `]` / `[`）: エージェント数を ±50（最小 20 / 最大 1000）。**比較の主軸**。
- `R`: エージェント数を初期値 150 に戻す（再配置）。
- 入力なしでゴールは自動で 4 秒ごとに移動する（無人ベンチ可）。

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- three.js は **A-Frame 同梱版を `AFRAME.THREE` 経由で利用**（別途 three は読み込まない）。正確なリビジョンは実行時に `AFRAME.THREE.REVISION` で確認できる。

## 実装メモ（自前 A* ＋ InstancedMesh 追従）

- **宣言的 `<a-scene>` ＋ ロジックはカスタムコンポーネントでラップ**:
  - 背景色・カメラは `<a-scene background>` / `<a-entity id="rig" camera>` で宣言的に記述。
  - グリッド/障害物の生成・自前 A*・エージェントのインスタンス描画・経路追従は宣言タグでは表現できないため、カスタムコンポーネント `crowd` の `init()` 内で `AFRAME.THREE` を直接叩いて生成し、`this.el.object3D`（= `<a-scene>` の object3D）に `add` している。
- **グリッド / 障害物（決定的）**: `mulberry32(seed=0x9e3779b9)` で各セルを約 18%（`rnd()<0.18`）の確率で壁にする。`Math.random` は不使用。壁は高さ 3 のボックスを `InstancedMesh` で一括描画。地面は暗色の大判平面。
- **自前 A***: 4 近傍（上下左右）・マンハッタン距離ヒューリスティック・自前バイナリヒープ。壁セルは展開しない。経路が無ければその場待機。three.js 版とビット単位で同じワークバッファ（`gScore`/`came`）とヒープ実装を移植しているので、同じグリッドで同じ経路になる。
- **エージェント**: `InstancedMesh`（円錐・底 y=0／先端 y=2 に直立、`geometry.translate(0,1,0)`）。状態は SoA（`ax`/`az`/`acell`/`paths`/`pidx`）。各フレームで次セル中心へ向かって `SPEED=6 u/s` で進み、到達でインデックス前進。`setMatrixAt` → `instanceMatrix.needsUpdate` → `count` 設定まで three.js 版 `frame()` と同一。
- **ゴールと一斉再計算**: `GOAL_MS=4000` ごとに次の自由セルへ移動（PRNG 続き）。移動時に全エージェントが現在セル→ゴールの A* を再計算し、`Repaths` に `+N` する。
- **メインループは `tick(time, timeDelta)`**: three.js 版 `frame()` 相当。

## つまずき / 罠

- **カメラの Group lookAt 罠（最重要）**: `<a-entity camera>` の `object3D` は **Group** であり、`Group.lookAt` は「+Z を対象へ向ける」非カメラ分岐になる。子の `PerspectiveCamera`（-Z を見る）が真後ろを向いてしまうため、**`cameraEl.getObject3D('camera')` で取得した THREE.Camera 本体に対して** `position.set(0,70,60)` と `lookAt(0,0,0)` を**一度だけ**適用する（isCamera 分岐で -Z が正しく対象を向く）。`look-controls` / `wasd-controls` は `enabled: false` で無効化しないと手動設定が打ち消される。camera 本体は `init` 時点で未生成のことがあるため、`tick` 側からも生成され次第 1 回だけ設定する再試行を入れている。
- **dt 下限 0 ＋ 0 除算ガード（NaN 化回避）**: `tick` の `timeDelta`(ms) を秒へ変換し `dt = Math.min(0.05, Math.max(0, dt))` でクランプ。**下限 0 が必須**（初回 `timeDelta` が負/未定義のとき負 dt で座標が NaN 化しうる）。移動の正規化除算も `if (dist < 1e-6) { 到達処理 }` で 0 除算を回避。これを怠ると全エージェントが NaN 座標で不可視になる（three.js 版で実際に踏んだ罠。修正済みの three.js 版に倣っている）。
- **`AFRAME.THREE` 利用**: 冒頭で `const THREE = AFRAME.THREE;` とし、別途 three を import しない。これにより A* もインスタンス描画も three.js 版とほぼ同一コードで書ける。
- **InstancedMesh のカリング無効化**: `agents.frustumCulled = false`。バウンディングが初期インスタンス基準で計算されるため、移動するエージェントが誤カリングされるのを防ぐ。
- **HUD は `renderer.info`**: `sceneEl.renderer.info.render.calls / triangles` から Draws / Tris を取得（数フレームに 1 回更新）。HUD / help / note は `<a-scene>` 外の HTML オーバーレイで three.js 版と同じ構造・CSS（960×540、項目 FPS/Objects/Agents/Repaths/Draws/Tris、note は `crowd A*: self-written grid A* + instanced agents`）。`<a-scene embedded>` で `#wrap`（960×540）内に収めている。

## AI コーディング生成のしやすさ所感

- A-Frame の「宣言的タグ」と「自前 A* ＋ 大量インスタンス追従」は本来相性が悪く、AI に素直に書かせると `<a-entity>` を 150 個並べたり、経路探索をライブラリ任せにしがち。**`crowd` カスタムコンポーネント内で AFRAME.THREE を直接叩き、A* も自前で持つ**方針を明示すると、`init()`/`tick()` が three.js のセットアップ/ループに 1:1 対応するため、移植自体は機械的で容易だった。
- 最大の罠は前述の **camera 本体 vs Group の lookAt** で、A-Frame 固有の落とし穴。これと **dt 下限 0 / 0 除算ガード**を押さえれば three.js 版とほぼ等価な挙動になる。A* やヒープのロジックは three.js と同一 API（`AFRAME.THREE`）なので移植は素直。総じて「three.js を知っていれば書けるが、宣言性と CPU ロジックの橋渡し＋カメラ罠に最初の設計判断が要る」という所感。
