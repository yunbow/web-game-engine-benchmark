# 3D テーマ9（T9）ナビ群衆 A* ― Babylon.js 版

障害物グリッドを多数エージェントが**自前グリッド A***で経路探索し、ゴールが
定期移動（GOAL_MS=4000ms）するたびに**全エージェントが一斉再計算**する。
比較の主軸は「A* 計算 ＋ 経路追従更新（CPU側 AI ロジック）＋ 移動メッシュ描画」。
仕様の唯一の正は `../SPEC.md`。

## 起動方法

`file://` 直開きは不可（CDN/将来のアセット読込のため）。テーマフォルダをルートに
HTTP サーバを立てて開く:

```bash
cd 3d/09
python -m http.server 8000
# → http://localhost:8000/Babylon.js/
```

## 使用バージョン

- Babylon.js: `https://cdn.babylonjs.com/babylon.js`（最新安定版 / グローバル `BABYLON`）
- WebGL2（`new BABYLON.Engine(canvas, true, {antialias:true}, true)`）

## 実装方針（A* ＋ thin-instance 追従）

- **A* / グリッド / 障害物 / PRNG(mulberry32) / ゴール移動 / 経路追従 / Repaths** は
  three.js リファレンス(`../three.js/game.js`)を**ビット単位で同一移植**。同一シード・
  同一アルゴリズム（4近傍マンハッタン・バイナリヒープ）なので**経路は4ライブラリで一致**する。
  描画レイヤだけを Babylon の thin instances に差し替えた。
- **エージェント = thin instances**（`CreateCylinder` の `diameterTop:0` で円錐）。
  毎フレーム各個体の `ax/az/向き` から行列を `Matrix.ComposeToRef` で合成し、
  `agentMatrices` バッファへ書き込んで `thinInstanceBufferUpdated("matrix")` で更新。
- **壁 = thin instances**（box・高さ3）。動かないので static バッファに一度だけ焼き込む。
- **ゴール = 単一円柱**（`emissiveColor` の無影マテリアルで明るい黄）。
- 座標一致のため `scene.useRightHandedSystem = true`。カメラは `FreeCamera`
  位置(0,70,60)・`setTarget(0,0,0)`・垂直 fov 55°・minZ0.5/maxZ600・`attachControl` なし（固定）。

## つまずき（0除算 / dt ガード）

- **dt の安全策**: three.js は `performance.now` 差分で初フレームが負になりうるが、
  Babylon は `engine.getDeltaTime()/1000`（常に非負・ms）を使う。それでも 0 や
  巨大スパイクに備え `dt = Math.min(0.05, Math.max(0, dt))` でクランプ。
  **負 dt / 巨大 dt はステップ量を壊し、移動が NaN 化して全エージェントが不可視になる**。
- **移動の 0 除算ガード**: 目標セルへの距離 `dist` が極小（`dist < 1e-6`）のとき方向ベクトル
  `dx/dist` が `0/0 = NaN` になる。three.js 版同様 `if(dist<1e-6){到達処理}` で先に
  到達扱いにし、除算を回避する。NaN 行列は thin instance 全体を消す原因になりやすい。
- **thin instance のカリング**: ルートメッシュの境界でフラスタムカリングされるため、
  盤面全体に散る個体が一括で消えうる。`alwaysSelectAsActiveMesh = true` で回避。
- **円錐の底合わせ**: Babylon の Cylinder は原点中心・+Y 向き。three.js が
  `geometry.translate(0,1,0)` で底 y=0 にしているのに合わせ、行列合成時に位置 y=+1 を与える。

## HUD

左上 HTML オーバーレイ。`FPS`(移動平均) / `Objects`(=N) / `Agents`(=N) /
`Repaths`(A* 累計回数、ゴール移動ごとに +N) / `Draws`(`SceneInstrumentation`
の `drawCallsCounter.current`) / `Tris`(概算注記)。数フレームに1回更新。

## 操作

- `+` / `-`（`]` / `[`）: エージェント数を ±50（最小20 / 最大1000）。比較の主軸。
- `R`: エージェント数を初期値 150 に戻す（再配置）。
- 入力なしでゴールは自動移動（無人ベンチ可）。

## AI 生成所感

ロジックが three.js と完全共有のため、移植の本質は「描画レイヤの置換」と
「座標系・カリング・dt/0除算の罠を踏まない」ことに集約された。Babylon は thin instance の
行列バッファを直接書き換えられるので three.js の `InstancedMesh.setMatrixAt` とほぼ
一対一で対応でき、移植は素直。右手系の明示と `alwaysSelectAsActiveMesh`、円錐の底合わせ
さえ押さえれば見た目も一致する。`getDeltaTime` が非負である分、初フレーム負 dt の罠は
three.js より軽いが、念のためのクランプと 0 除算ガードは残してある。
