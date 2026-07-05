# 3D テーマ3（T4） ― スキンドキャラ大群（PlayCanvas 版）

three.js リファレンス実装（`../three.js/`）を **PlayCanvas エンジンのみ**（エディタ不使用・CDN 読込）に「同一挙動」で移植したもの。数値・配置・カメラ・HUD・アニメ設定はすべて `../SPEC.md` に準拠。
**比較の主軸 = スキンドメッシュ（スケルタルアニメ）の大量再生スループット**。

## 起動方法

画像/GLB 読込のため `file://` 直開きは不可（CORS で assets が読めない）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/03
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

共有 glTF は `../assets/CesiumMan.glb`（Khronos サンプル・リギング済み・歩行アニメ1本同梱・約438KB）。

## 操作

- `+` / `-`（および `]` / `[`）: キャラ数を ±25（最小 10 / 最大 1000）→ 群衆を**全破棄して再構築**。
- `R`: 現在数で再構築（リセット）。
- 入力なしでアニメは進行（無人ベンチ可）。

## 使用バージョン

- PlayCanvas Engine（CDN: `https://code.playcanvas.com/playcanvas-stable.min.js`、UMD グローバル `pc`）。
- 描画バックエンド: **WebGL2 を明示**（`graphicsDeviceOptions.deviceTypes = [pc.DEVICETYPE_WEBGL2]`）。WebGPU は使わない（公平比較のため）。
- 解像度固定: `app.setCanvasResolution(pc.RESOLUTION_FIXED, 960, 540)` + `FILLMODE_NONE`。

## 実装メモ（本テーマの主軸: glb コンテナ読込・複製・anim 駆動）

### 1. GLB を container として読み込む

```js
app.assets.loadFromUrl(GLB_URL, "container", (err, asset) => {
  const container = asset.resource;        // ContainerResource
  const anims = container.animations;      // Asset 配列（各 .resource が AnimTrack）
  ...
});
```

- `loadFromUrl(url, 'container', cb)` は **非同期**。コールバック `cb(err, asset)` で完了する。
- glb 同梱アニメは `container.animations` から取得。**配列要素は AnimTrack そのものではなく Asset** で、`anims[0].resource` が `pc.AnimTrack`。本実装は「Asset なら `.resource`、そうでなければ要素自体」を見て吸収している（バージョン差吸収）。クリップ長は `walkTrack.duration`。
- **起動順序が肝**: container ロードは非同期コールバックなので、`app.start()` は**ロード完了 → スケール算出 → 初回 `buildCrowd()` の後**で呼ぶ。`pc.Application` は Editor 製アプリと違いスタンドアロンでは `start()` を**手動呼び出し**しないとメインループが回らない。

### 2. キャラの複製（スキン独立クローン）

```js
const entity = container.instantiateRenderEntity(); // render コンポーネント付き階層を複製
```

- `instantiateRenderEntity()` は **render コンポーネントを持つエンティティ階層**（スキン/スケルトンを含む）を返す。three.js の `SkeletonUtils.clone()`（通常 clone ではスキンが共有されて壊れる問題への対処）に相当する役割をエンジンが内蔵しているイメージ。
- **共有リソースと破棄**: `instantiateRenderEntity()` はメッシュ・マテリアル・AnimTrack 等のリソースを `container` と**共有**する。複製エンティティの `entity.destroy()` は、その複製階層と anim インスタンス状態だけを破棄し、共有元の `container` リソースは破棄しない。よって `+`/`-`/`R` で `crowd` を全 destroy → 再 `instantiateRenderEntity()` しても、`container` を保持し続ける限り再生成は安全（T3 で踏んだ「複製 destroy で共有メッシュが壊れる」問題は、container を破棄しない設計で回避）。**`container`/`walkTrack` は決して破棄しない**。

### 3. 各個体を独立アニメ再生（anim コンポーネント）

```js
entity.addComponent("anim", { activate: true });
entity.anim.assignAnimation("Walk", walkTrack, undefined, speed, true); // name, track, layer, speed, loop
entity.anim.speed = speed;                       // 個体ごとの timeScale [0.8,1.2]
entity.anim.baseLayer.activeStateCurrentTime = phase * walkDuration; // 開始位相をずらす
```

- `assignAnimation(nodePath, animTrack, layerName, speed, loop)`: **状態グラフが無ければ自動生成**し、`activate:true` なら割当完了後に**自動再生開始**する。state graph を手で書かずに「1 トラックをループ再生」できる最短経路。`loop=true` でループ。
- 個体差は **`anim.speed`（再生速度倍率）** と **`baseLayer.activeStateCurrentTime`（開始位相）** で与える。`activeStateCurrentTime` は現在再生中ステートの再生位置（秒）の getter/setter。phase をここに書き込むことで群衆が同期しない。
- スケルトン更新（スキニング行列計算）は **anim コンポーネントが app の update で各個体ぶん自動進行**する。これが本テーマの負荷の主役なので、自前で `mixer.update` 相当を回す必要はない。

### 4. スケール統一と接地（aabb から算出）

- 1 体だけ実体化して（probe）`findComponents("render")` → 各 `MeshInstance.aabb`（world 空間・スキン考慮）を集計し、身長 `h = max.y - min.y` を求める。`modelScale = 1.7 / h`、接地オフセット `footOffset = -min.y * modelScale`。three.js 版の `Box3.setFromObject` と同じ狙い。
- `MeshInstance.aabb` が null/非有限のときは `mesh.aabb`（object 空間）で代替し、`h<=0` 等の異常値はガード（`h=1`）。probe は計測後に `destroy()`。

### 配置・決定論

- グリッド: `cols=ceil(sqrt(N))`, `rows=ceil(N/cols)`, 間隔 2.2, 中心揃え, y=footOffset, 向きは全個体同一（+Z 既定）。SPEC の式どおり。
- 決定的疑似乱数 **mulberry32(seed=0x9e3779b9)**。個体ごとに `speed`→`phase` の順で 2 回引く（three.js 版と**同一の消費順序**）ため、4 ライブラリで個体ごとの速度・位相が一致する。`Math.random` は不使用。

### GLB 読込失敗時フォールバック

- container ロード失敗、またはアニメ取得/セットアップ失敗時は `fallback=true` に切替。各キャラを **capsule プリミティブ**（青 `#8ab4ff`）で同数・同配置に置換し、上下バウンス（`y = footOffset + max(0, sin(t*speed*3 + phase*2π))*0.4`、three.js 版と同式）でアニメする。HUD の `Chars` に **`(fallback: no skin)`** を表示（スキニングは再現されない旨）。

### HUD

- `Draws`: `app.stats.drawCalls.total`（CDN 通常ビルドでも存在）。スキンドメッシュはインスタンシング非対応なので **draw call ≒ キャラ数 × メッシュ数** になり、これ自体が比較指標になる。
- `Tris`: スキンドメッシュの正確な合計は統計に出にくいため `app.stats.frame.triangles` をベストエフォートで拾う（**概算**・注記）。
- 数フレームに 1 回（`hudT % 6`）だけ更新。`FPS` は移動平均。

## AI コーディング生成のしやすさ所感

- glb を 1 行（`loadFromUrl(url,'container',cb)`）で読み、`instantiateRenderEntity()` で複製、`assignAnimation()` で 1 トラックを即ループ再生 ― という**高レベル API が揃っている**ため、three.js の `GLTFLoader`+`SkeletonUtils.clone`+`AnimationMixer` の三点セットより記述量は少ない。座標系も右手・Y上で three.js と同じ。
- 最大の不確実性は **anim コンポーネント周辺**。`assignAnimation` の引数順（`name, track, layerName, speed, loop`）、状態グラフ自動生成の挙動、`baseLayer.activeStateCurrentTime` での位相制御は AI の旧知識（旧 `animation` コンポーネントや editor 前提の state graph JSON）と混同しやすい。本実装はエンジンソース/ API リファレンスで引数順と `activeStateCurrentTime` を確認して確定させた。
- もう一つの罠は **非同期ロードと `app.start()` の順序**。container ロードはコールバックなので、`start()` をトップレベルで先に呼ぶと未構築のまま走る。ロード完了後に構築 → start の順にする必要がある。
- **destroy 時の共有リソース**: `instantiateRenderEntity` 由来の複製を destroy しても container 側は無傷、という前提（container を保持する設計）でリビルドを安全にしている。container 自体を破棄するとメッシュ/スケルトン共有が壊れるため、再構築では container は触らない。
