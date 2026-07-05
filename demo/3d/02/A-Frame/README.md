# 3D T3 箱タワー崩し — A-Frame + aframe-physics-system

three.js + Rapier の参照実装（`../three.js/`）を **A-Frame ＋ aframe-physics-system** へ「同一仕様」で移植したもの。
比較の主軸は **本物の3D剛体物理エンジン統合と剛体数スケール**。物理は自前実装せず、物理システム（ammo driver = Bullet/WASM）に委ねている。

## 起動方法

画像は使わないが、CDN/モジュール読込のため `file://` 直開きではなく HTTP サーバ経由で開く。

```bash
cd 3d/02
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

## 操作

- `+` / `-`（`]` / `[`）: 箱（剛体）数 N を ±50（最小20 / 最大1500）→ タワー再構築。**比較の主軸**。
- `Space`: 砲弾を即発射（任意）。自動でも 2 秒ごとに発射される。
- `R`: タワー再構築（リセット）。

HUD（左上, HTML オーバーレイ）: `FPS` / `Objects`(箱N+アクティブ砲弾) / `Score` / `Bodies`(設定値N) / `Draws` / `Tris`。

## 使用バージョン

| 要素 | バージョン / URL |
| --- | --- |
| A-Frame | `1.7.0`（`https://aframe.io/releases/1.7.0/aframe.min.js`） |
| 物理システム | `@c-frame/aframe-physics-system@4.2.2`（現代A-Frame対応の保守fork、`dist/aframe-physics-system.js`） |
| ammo.js | MozillaReality/ammo.js `@8bbc0ea`（`builds/ammo.wasm.js`, Bullet の WASM ポート） |
| **採用 driver** | **ammo**（`<a-scene physics="driver: ammo; gravity: 0 -20 0">`） |

three.js は別途読み込まず、A-Frame 同梱の `AFRAME.THREE` を使う（HUD の `renderer.info`、カメラ手動制御もそれ経由）。

## 物理統合の手順とつまずき

### 1. physics コンポーネントの宣言と driver 選定
`<a-scene physics="driver: ammo; gravity: 0 -20 0">` で世界を作る。重力は three.js/Rapier 版と同じ `(0,-20,0)`。

driver は **ammo（Bullet/WASM）と local（cannon-es）** の 2 択。**ammo を採用**した理由:
- SPEC は箱・砲弾・床それぞれに別の restitution/friction を要求する。**cannon(local) driver は摩擦/反発が「シーン全体で1値」**（`physics="friction: …; restitution: …"`）で、per-body に分けるには CANNON の contactMaterial を自前で組む必要があり、宣言的に書けない。
- ammo は per-body の restitution に加え、`btRigidBody.setFriction()` で per-body 摩擦も設定できるため SPEC 値を厳密に再現できる。

cannon(local) へ切り替える場合は `dist/aframe-physics-system.min.js`（cannon-es 同梱・ammo.js 不要）に差し替え、`physics="driver: local; gravity: -20"`、各剛体を `dynamic-body="shape: box; mass: 1"` / 床を `static-body` にする（ただし摩擦/反発はシーン共通値になる）。

### 2. ammo.js は別途読込（最初のつまずき）
aframe-physics-system は **ammo.js をバンドルしない**。`<script src=".../ammo.wasm.js">` を physics-system より**前**に読み込む必要がある。さらに ammo は WASM の非同期初期化で、`window.Ammo` は最初 *関数*、初期化後に `btVector3` 等が生えた *オブジェクト* になる。
→ `game.js` は `typeof Ammo.btVector3 === "function"` を 100ms 間隔でポーリングし、**初期化完了を待ってから**タワーを構築する。

### 3. 剛体の宣言（box / sphere）
- 箱: `<a-box>` に `ammo-body="type: dynamic; mass: 1; restitution: 0.1"` + `ammo-shape="type: box; fit: manual; halfExtents: 1 1 1"`。
- 砲弾: `<a-sphere>` に `ammo-body="type: dynamic; mass: 8; restitution: 0.2"` + `ammo-shape="type: sphere; fit: manual; sphereRadius: 1.5"`。
- 床: `<a-box depth/height/width=400/2/400>`（上面 y=0）に `ammo-body="type: static"` + 大判 box shape。

ammo は **mass>0 と shape を与えれば慣性テンソルを自動計算**する。Rapier 版で density から質量を逆算していた箇所（箱 density 0.125、球 0.566）は不要で、**mass を直接指定**するだけで SPEC の質量（箱1 / 砲弾8）に一致する。

### 4. friction が宣言で書けない（最大のつまずき）
`ammo-body` にも `ammo-shape` にも **friction プロパティが存在しない**（restitution は ammo-body にあるが、内部的に初期化後は更新不可）。
→ SPEC の摩擦/反発は **`body-loaded` イベント後に `el.body`（=`Ammo.btRigidBody`）へ `setFriction()`/`setRestitution()` を直接呼んで**付与する。床=0.8、箱=0.6、砲弾=0.4。

### 5. body-loaded 待ちと初速付与
剛体は `<a-*>` を DOM 追加した時点では即座に `el.body` ができない。**`body-loaded` を待ってから** btRigidBody を操作する（既に `el.body` があれば即実行のフォールバックも用意）。
砲弾の初速 `(0,2,-55)` は `el.body.setLinearVelocity(new Ammo.btVector3(...))` で付与（`Ammo.destroy(v)` でテンポラリを解放）。

### 6. 位置同期とスコア判定
ammo driver は毎 tick、btRigidBody の transform を A-Frame エンティティの `object3D` へ書き戻す（親がシーンなら world、子なら `worldToLocal` で local）。
スコア（箱 world-y < 0.5 初到達）と砲弾の寿命（world z<-60 / y<-20）は `object3D.getWorldPosition()` で親に依存せず world 座標で判定している。

### 7. カメラの罠（T1 で踏んだもの）
`<a-entity id="rig" camera look-controls="enabled:false" wasd-controls="enabled:false">` で固定カメラにし、`look/wasd-controls` を無効化。
**`cameraEl.object3D` は Group**なので `lookAt` の分岐が逆になる（Group は +Z を対象へ向ける）。`cameraEl.getObject3D("camera")`（PerspectiveCamera 本体）を取得し、それに `position.set(0,14,56)` / `lookAt(0,10,0)` する（isCamera 分岐で -Z が対象を向く＝正しい）。

### 8. 再構築（rebuild）
`+/-/R` では全箱要素 (`#tower` の子) と全砲弾要素 (`#proj` の子) を `removeChild` で破棄 → 物理 body も破棄され、SPEC レイアウト（cols=20, x=(c-(cols-1)/2)*2.05, y=1+r*2.02, z=0）で再生成する。

## SPEC 数値の対応

| 項目 | 値 |
| --- | --- |
| 重力 | (0, -20, 0) |
| 箱 | 2×2×2 / mass 1 / rest 0.1 / fric 0.6 |
| 砲弾 | 半径 1.5 / mass 8 / rest 0.2 / fric 0.4 |
| 床 | 静的 大判box（上面 y=0）/ rest 0.1 / fric 0.8 |
| N | 初期200 / ±50 / 20〜1500 |
| 配置 | cols=20, x=(c-(cols-1)/2)*2.05, y=1+r*2.02, z=0 |
| 発射 | 2.0秒ごと / pos(0,10,40) / vel(0,2,-55) / 最大8発 |
| カメラ | pos(0,14,56) → lookAt(0,10,0), fov50/near0.1/far2000 |
| スコア | 箱中心 y<0.5 初到達で +10 |

## AI 生成所感

- A-Frame の宣言的タグと物理コンポーネントの相性は「**剛体の生成は楽、物理パラメータの細指定は苦手**」とくっきり分かれる。box/sphere に `ammo-body`/`ammo-shape` を付けるだけで剛体になるのは Rapier の手続き的な collider 生成より直感的。一方、**friction が属性で書けず btRigidBody を直叩きする**点、**ammo.js を別途・順序依存で読み込む**点、**WASM 非同期初期化を自前で待つ**点は、ドキュメントを読まないと AI も素直に踏み抜く罠だった。
- mass 直指定で質量が決まる（density 逆算不要）のは Rapier 版より簡潔。
- `body-loaded` を待たずに `el.body` を触ると null 参照になるのが最頻出のミス。生成直後に速度を入れたい砲弾でとくに効く。
- driver 選定（ammo vs cannon）は「per-body 物性が要るか」で決まる。本 SPEC のように箱/砲弾/床で物性を分けたい場合は ammo 一択になった。
