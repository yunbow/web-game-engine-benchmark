# 3D T9 ― ナビ群衆 A*（PlayCanvas エンジンのみ）

障害物グリッドを多数のエージェントが**自前グリッド A***で経路探索し、ゴール移動時に全エージェントが一斉再計算する。`+`/`-` でエージェント数を増減し、A* 計算＋経路追従＋移動メッシュ描画のコストで FPS を測る。仕様の唯一の正は `../SPEC.md`。

## 起動方法

`file://` 直開きは不可（PlayCanvas CDN は読めるが構成統一のため HTTP 配信する）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/09
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

## 操作

- `+` / `-`（`]` / `[`）: エージェント数を ±50（最小 20 / 最大 1000）。**比較の主軸**。
- `R`: エージェント数を初期値 150 に戻して再配置。
- 入力なしでもゴールは 4000ms ごとに自動移動（無人ベンチ可）。

## 使用バージョン

- PlayCanvas: `https://code.playcanvas.com/playcanvas-stable.min.js`（CDN・classic script / UMD グローバル `pc`）。
- WebGL2 を明示（`deviceTypes: [pc.DEVICETYPE_WEBGL2]`）。960x540 固定解像度。

## 実装の要点（自前 A* ＋ hardware-instancing 追従）

- **グリッド / 障害物 / mulberry32(seed=0x9e3779b9) / A* / ゴール移動 / 経路追従 / Repaths** は three.js リファレンス実装をそのまま移植。GW=40, CSZ=2, N=150（±50, 20..1000）, SPEED=6, WALL_P=0.18, GOAL_MS=4000。`Math.random` 不使用の決定的生成で、4ライブラリ同一の経路になる。
- **A***: 4近傍・マンハッタン距離ヒューリスティック・配列バイナリヒープ。壁セルは展開しない。経路なしはその場待機。
- **エージェント描画 = ハードウェアインスタンシング**: T1 と同方式。`pc.VertexFormat.getDefaultInstancingFormat` の per-instance 行列 VertexBuffer（`BUFFER_DYNAMIC`）を 1 本確保し、毎フレーム `Mat4.setTRS` で組んだ 16 float 行列を `Float32Array` へ書き、`vb.setData()` ＋ `meshInstance.instancingCount = count` で更新。円錐は進行方向（`atan2(dx,dz)`）へ向ける。
- **壁描画 = ハードウェアインスタンシング**: 高さ 3 のボックスを壁セル数ぶん 1 ドローで描画（静的なので初期化時に 1 度だけ `setData`）。
- **ゴール**: 単一円柱（`useLighting=false` の自発光黄色 #ffd54a）。
- **共有メッシュは `incRefCount()`**: エージェント／壁メッシュは Entity 破棄時の参照カウント0破棄を防ぐため参照カウントを永続化。
- **HUD**: FPS（移動平均）/ Objects / Agents / Repaths / Draws(`app.stats.drawCalls.total`) / Tris（エージェント概算）。

## つまずき（既知の罠）

- **IIFE 隔離（最重要）**: classic script では `let`/`const` がグローバルに漏れ、複数ファイルや再評価時に `Identifier 't' has already been declared` で全体が落ちる。**game.js 全体を `(function(){ ... })();` で包む**ことで解消。
- **0除算ガード（NaN化防止）**: 経路追従の移動ベクトル正規化で目標セルに既に到達していると `dist=0` となり、`dx/dist` が NaN になって per-instance 行列が NaN ＝**全エージェントが不可視になる**。`if (dist < 1e-6) { 到達処理 }` で先に弾く（three.js版に倣う）。
- **dt クランプ**: PlayCanvas の `app.on('update', dt)` の dt は常に非負だが、念のため `dt = min(0.05, max(0, dt))`。
- **円錐の原点中心問題**: `pc.createCone` は原点中心生成（y=-1..+1）。three.js は `geometry.translate(0,1,0)` で底を y=0 にしているため、per-instance 行列の位置 Y に **+1.0** を加えて底を地面に合わせる。
- **平面の向き**: `pc.createPlane` は既に XZ 平面（法線 +Y）なので three.js の `rotateX(-π/2)` 相当の回転は不要。
- **平行光の向き**: three.js は `position(0.4,1,0.5)` からの光（原点へ向かう）。PlayCanvas は Entity の forward(-Z) が光線方向なので `lookAt((-0.4,-1,-0.5) 正規化)` で同等にした。

## AI 生成所感

T1 の hardware-instancing 雛形がそのまま流用でき、エージェント追従ロジックは three.js版を SoA のまま移植するだけで動いた。PlayCanvas 固有の落とし穴（IIFE 隔離・プリミティブの原点中心・平面の既定向き・directional の向き付け）は他テーマと共通で、SPEC とリファレンス実装が明確なため移植の判断はほぼ機械的。0除算ガードは three.js版コメントが明示していたため確実に踏襲できた。Tris は壁＋地面＋ゴール分を含まないエージェント概算（インスタンシングは device 統計に正確な合計が出ないためベストエフォート）。
