# 3D T3 箱タワー崩し — PlayCanvas + ammo.js(Bullet)

3Dテーマ2（箱タワー崩し）の **PlayCanvas（エンジンのみ・CDN）＋ ammo.js(Bullet) 物理** 実装。
仕様は `../SPEC.md` が唯一の正。数値・レイアウト・カメラ・HUD は three.js + Rapier の参照実装に一致させている。
**物理は ammo.js(Bullet) を必ず使用**（自前物理は不可。物理エンジン統合の相性が比較の主軸）。

> headless Chromium（WebGL2/SwiftShader）で起動・物理進行・HUD更新・タワー積層を確認済み。

## 起動方法

`file://` 直開きは不可（CDN/WASM 都合）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/02
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

操作:
- `+` / `-`（`]` / `[`）: 箱（剛体）数を ±50（最小 20 / 最大 1500）→ タワー再構築。**比較の主軸**。
- `Space`: 砲弾を即発射。
- `R`: タワー再構築（リセット）。

砲弾は 2.0 秒ごとに自動発射されるので、放置でも無人ベンチとして観測できる。

## 使用バージョン / 入手元

| ライブラリ | 入手元（CDN） |
|---|---|
| PlayCanvas エンジン | `https://code.playcanvas.com/playcanvas-stable.min.js`（グローバル `pc` / UMD, 実測 v2.7.4） |
| ammo.js(Bullet) | `https://cdn.jsdelivr.net/gh/MozillaReality/ammo.js@8bbc0ea/builds/`（`ammo.wasm.js` + `ammo.wasm.wasm` + asm.js フォールバック `ammo.js`） |

### ammo ビルドの選定理由（ここを間違えると動かない）
- PlayCanvas の `rigidbody`/`collision` は内部で **グローバル `Ammo`（Bullet の Emscripten ビルド）** を参照する。
- **`ammojs-typed` は不可**: `btTransform.getOrigin()` 等の API 形が PlayCanvas の期待と異なり、`createBody` 内の
  `_getEntityTransform`（`getOrigin().setValue(...)`）で `Cannot read properties of undefined (reading 'setValue')` で落ちる。
- **PlayCanvas が歴史的に対応してきた MozillaReality 製 ammo** を採用し、**公式の `pc.WasmModule` 経由**でロードする（下記）。

## 物理統合の手順とつまずき（PlayCanvas + ammo）― 実際に踏んだ順

1. **ammo は `pc.WasmModule` 経由でロードする（最重要）**
   ```js
   pc.WasmModule.setConfig("Ammo", { glueUrl, wasmUrl, fallbackUrl });   // new pc.Application より前
   pc.WasmModule.getInstance("Ammo", (instance) => { window.Ammo = instance; start(); });
   ```
   - `<script src=ammo>` を直書きして手動 `window.Ammo = lib` するだけでは **PlayCanvas v2 の `onLibraryLoaded` が発火せず**、
     物理一時オブジェクトも dynamicsWorld も作られない。必ず WasmModule に載せる。

2. **`onLibraryLoaded` を明示的に叩く（v2・エンジンのみ構成の罠）**
   - v2 stable では Ammo ロード完了後の `onLibraryLoaded` が**自動では走らない**ことがあり、その状態で剛体を作ると
     `createBody → _getEntityTransform` が内部 ammo 一時オブジェクト（`_ammoVec1`/`_ammoQuat` 等）未生成で落ちる。
   - グローバル `Ammo` 確定後・剛体生成前に、**collision → RigidBodyComponent(静的) → rigidbody system** の順で明示呼び出し:
     ```js
     app.systems.collision.onLibraryLoaded();      // ammo 衝突形状の生成基盤
     pc.RigidBodyComponent.onLibraryLoaded();        // 内部 ammo 一時オブジェクト生成（静的メソッド）
     app.systems.rigidbody.onLibraryLoaded();        // dynamicsWorld 生成
     ```
   - collision を初期化しないと床/箱の shape が作られず、描画時に `body.impl` 不整合エラーになる。

3. **位置は「rigidbody コンポーネント追加より前」に確定する（無症状バグ）**
   - `createBody` は entity の transform を読んで剛体を生成する。`addComponent('rigidbody')` の**後**に `setPosition` すると、
     dynamic 剛体は body→entity 同期で原点に戻され、**全箱が原点に重なって即崩壊**（Score が一気に最大化）する。
   - 正解: `new Entity` → **`setPosition(x,y,z)`** → `addComponent(render/collision/rigidbody)` → `addChild`。床・砲弾も同様。
   - 初速は body 生成後（`addChild` 後）に `entity.rigidbody.linearVelocity = new pc.Vec3(0,2,-55)`。

4. **共有メッシュは参照カウントを +1 して永続化（描画 'impl' クラッシュ対策）**
   - `pc.MeshInstance(mesh, mat)` は mesh の refCount を増減し、**0 で GPU バッファを破棄**する。
     砲弾の FIFO `destroy()` や箱の rebuild `destroy()` で共有 mesh のインスタンスが全滅すると mesh バッファが破棄され、
     次に同じ mesh で MeshInstance を作ると破棄済みバッファ参照で **`drawInstance` が `reading 'impl'` で落ちる**。
   - 対策: 共有 `boxMesh`/`ballMesh` を生成直後に **`mesh.incRefCount()`** して常に refCount ≥ 1 に保つ。

5. **重力**: `app.systems.rigidbody.gravity = new pc.Vec3(0, -20, 0)`（dynamicsWorld 生成後に設定）。

6. **1 剛体 = 1 Entity（render + rigidbody）で draw call が増える**
   - PlayCanvas の素直な統合として **1 剛体 = 1 Entity** とし、描画も各 Entity の `render` に任せた
     （rigidbody が各 Entity のトランスフォームを更新するので three.js 版のような行列同期コードは不要）。
   - 代償として **箱数だけ draw call が増える**（非インスタンシング）。参照実装の three.js は InstancedMesh で Draws ほぼ一定なので、
     **Draws の絶対値はライブラリ間で意味が異なる**点に注意（描画スループット軸は T1 で別途比較）。

## HUD / 統計
左上 HTML オーバーレイ: `FPS`（移動平均）/ `Objects`（箱N + アクティブ砲弾数）/ `Score` / `Bodies`（箱数設定値 N）/ `Draws` / `Tris`。
- `Draws` は `app.stats.drawCalls.total`。
- `Tris` は非インスタンシングのため自前概算（箱メッシュ面数 × 箱数 + 砲弾面数 × 砲弾数 + 床）。

## スコア
箱の中心 `entity.getPosition().y < 0.5`（崩れ落ちた）に初めて達したら +10（1 箱 1 回）。

## AI 生成所感
- 「Entity に collision + rigidbody を足すだけ」という**コンポーネント指向の素直さ**は4ライブラリ中でも随一で、
  自前 step も描画同期も要らない。**動きさえすれば**記述量は最小。
- ただし**「動かすまで」のハマりが深い**。AI が素直に書いた初版（ammojs-typed を `<script>` 直読み + 手動 `window.Ammo` +
  `setPosition` を rigidbody 後）は、(a) ammo ビルド非互換で `setValue` 落ち、(b) onLibraryLoaded 未発火で `impl` 落ち、
  (c) 位置確定順で全箱原点重なり、(d) 共有メッシュ破棄で描画 `impl` 落ち、と**4段の罠**を順に踏んだ。
  いずれも「ブラウザで実行して初めて分かる」種類で、静的生成だけでは到達しづらい。→ **PlayCanvas 物理はその場実行検証がほぼ必須**。
- ソルバが Bullet のため Rapier（three.js 版）と崩れ方の軌道は一致しない（SPEC 想定どおり）。初期レイアウト・数値は一致。
