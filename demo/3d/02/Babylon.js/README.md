# 3D T3 箱タワー崩し — Babylon.js v8 + Havok 物理

three.js + Rapier 参照実装（`../three.js/`）と**同一仕様**（数値・ルール・カメラ・HUD は `../SPEC.md` が唯一の正）を、Babylon.js v8 + 公式 Havok 物理プラグインへ移植したもの。
比較の主軸は「本物の 3D 剛体物理エンジン統合」。本テーマだけは自前物理を使わず、必ず Havok を使う。

## 起動方法

画像/GLB は不使用（プリミティブのみ）だが、`game.js` を相対参照で読むため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/02
python -m http.server 8000
# → http://localhost:8000/Babylon.js/
```

960x540 固定。起動直後は Havok の WASM 読み込み中 HUD に `loading Havok…` と表示され、初期化完了後にタワーが構築されてシミュレーションが始まる。

## 操作

- `+` / `-`（`]` / `[`）: 箱（剛体）数を ±50 → タワー再構築（最小 20 / 最大 1500）。**比較の主軸**。
- `Space`: 砲弾を即発射（任意）。
- `R`: タワー再構築（リセット）。
- 自機操作なし（無人で物理が進行＝オートベンチ可能）。

## 使用バージョン / CDN

`index.html` で 2 本の `<script>` を読み込む（どちらもグローバルを生やす UMD）:

- Babylon.js 本体: `https://cdn.babylonjs.com/babylon.js` → グローバル `BABYLON`（v8 系・最新）。
- Havok 物理: `https://cdn.babylonjs.com/havok/HavokPhysics_umd.js` → グローバル関数 `HavokPhysics()`（Promise で WASM インスタンスを返す）。

いずれも CDN 実在を確認済み（200 / 実 JS）。npm 版は `@babylonjs/core` + `@babylonjs/havok` に対応。

WebGL2（Babylon 既定。WebGPU は使わない）。

## Havok 統合の手順とつまずき

### 初期化（公式どおりの 3 ステップ）

```js
const hk = await HavokPhysics();                  // ① WASM インスタンス（Promise）
const plugin = new BABYLON.HavokPlugin(true, hk); // ② プラグイン（第1引数 true = delta 駆動の内部ステップ）
scene.enablePhysics(new BABYLON.Vector3(0, -20, 0), plugin); // ③ 重力を渡して有効化
```

- `HavokPhysics()` は `<script>` で読み込んだグローバル関数。`await` で WASM のロード完了を待つ必要があり、**完了前は剛体を生成できない**ので、初期化完了まで HUD を `loading Havok…` のままにし、`engine.runRenderLoop()` も初期化後に開始する（three.js 版が `RAPIER.init().then(...)` で待つのと同じ流儀）。
- `enablePhysics` を一度呼べば、以降は **`scene.render()` の中で物理が自動ステップ**される（明示的な `world.step()` 呼び出しは不要）。Rapier 版が毎フレーム手動で `world.step()` していたのと対照的で、Babylon 側はレンダーループに統合済み。

### PhysicsAggregate vs PhysicsBody

- `PhysicsAggregate(mesh, shapeType, {mass, restitution, friction}, scene)` は **PhysicsShape + PhysicsBody + マテリアルをまとめて作る高レベル API**。形状サイズはメッシュのバウンディング情報から自動算出されるため、寸法を別途渡す必要がない（2x2x2 box / 半径 1.5 球はメッシュ形状がそのまま反映される）。本実装は素直さ優先でこちらを採用。
- 低レベルの `new BABYLON.PhysicsBody(mesh, PhysicsMotionType.DYNAMIC, false, scene)` + `PhysicsShape*` 直結や、thin instance ごとの個別 body も可能だが、ジオメトリと body の対応・スケール同期が崩れやすく、確実性で劣る。
- ステップ後、プラグインが各 body の姿勢を **`mesh.position` と `mesh.rotationQuaternion`** へ書き戻して同期する。そのため各メッシュに **`rotationQuaternion` を必ず初期化**しておく（未設定だと回転が反映されない／Euler 経路に落ちる）。本実装は箱・砲弾とも生成時に `Quaternion.Identity()` を入れている。
- 数値マッピングは SPEC に厳密一致: 箱 `{mass:1, restitution:0.1, friction:0.6}` / 砲弾 `{mass:8, restitution:0.2, friction:0.4}` / 床 `{mass:0, restitution:0.1, friction:0.8}`。Rapier 版が density 指定で質量を逆算していた（box density 0.125 → mass 1 等）のに対し、**Havok/PhysicsAggregate は mass を直接指定できる**ので素直。

### 描画方式と draw call への影響（thin instance との両立可否）

- SPEC ノートは「Havok と thin instance の自動同期が不確実なら、確実に動く個別 mesh + PhysicsAggregate を優先」としている。実際 Havok プラグインの transform 同期は**通常の `TransformNode`（= 1 body 1 ノード）を前提**にしており、thin instance（1 メッシュ内の多数インスタンスを行列バッファで描く方式）に各インスタンス独立の body をぶら下げて毎フレーム同期させるのは追加実装が要る。比較の前提（正しく動くこと最優先）から、**thin instance は採用せず**。
- 代わりに **ルート箱メッシュを 1 つ作り、各箱を `boxRoot.createInstance()` の `InstancedMesh` として生成**し、その `InstancedMesh`（`TransformNode` 派生なのでプラグインの標準同期パスに乗る）に `PhysicsAggregate` を付ける方式を採用。砲弾も同様にルート球の `InstancedMesh`。
  - これにより **ジオメトリ/マテリアルは共有**され GPU 側でハードウェアインスタンシング描画にまとまるため、箱が数百〜千個でも **draw call は箱で実質 1（+ 床 1 + 砲弾 1）程度**に抑えられる。full mesh を箱数ぶん複製する素朴な方式（draw call が箱数ぶん増える）よりベンチに有利。
  - ただし three.js 版の `InstancedMesh`（1 つの行列バッファに全インスタンスを書き、frustumCulled=false で常時描画）とは仕組みが違い、Babylon の `InstancedMesh` は**各インスタンスが独立ノード**である点に注意（だからこそ PhysicsAggregate を 1 個ずつ付けられる）。Draws は `SceneInstrumentation.drawCallsCounter.current` で実測。
- N 変更（`+`/`-`/`R`）時は全 `InstancedMesh` と `PhysicsAggregate` を `dispose()` してから作り直す（剛体・砲弾を完全クリアして再構築）。

### HUD

- `FPS`（移動平均）/ `Objects`（箱 N + アクティブ砲弾）/ `Score` / `Bodies`（設定値 N）/ `Draws`（SceneInstrumentation 実測）/ `Tris`（概算: 箱 12 三角 × 箱数 + 砲弾 ≈512 三角 × 発数）。数フレームに 1 回だけ更新して計測の邪魔をしない。
- スコアは箱中心 `y < 0.5` 初到達で +10（1 箱 1 回）。砲弾は `z < -60` または `y < -20` で `dispose`（最大 8 発プール）。

## AI 生成所感

- Havok の初期化は公式の 3 ステップ（`await HavokPhysics()` → `new HavokPlugin(true, hk)` → `enablePhysics`）が完全に定型で、Rapier の `await RAPIER.init()` と発想がそっくり。一度この型を知っていれば AI でも迷わない。WASM ロード待ちのガード（初期化前の入力/ループ抑止）を忘れないことが唯一の落とし穴。
- 最大の判断は「thin instance を使うか」。SPEC・公式の同期実装ともに**通常ノード前提**なので、`InstancedMesh`（ノード派生）に PhysicsAggregate を 1 対 1 で付ける折衷案が「素直さ × draw call の少なさ × 確実な同期」のバランスで最良だった。AI は放っておくと thin instance に飛びつきがちだが、ここでは確実性を取った。
- mass を直接指定できる（density 逆算が不要な）点は Rapier より素直で、SPEC 数値の転記ミスが起きにくい。`rotationQuaternion` の事前初期化だけは Babylon 特有の暗黙要件で、知らないと「回転が反映されない」沼にはまりやすい。
