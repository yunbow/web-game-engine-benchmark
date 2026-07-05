# 3D テーマ4（T6）GPUパーティクル — Babylon.js 版

three.js リファレンス実装を Babylon.js の **GPUParticleSystem** へ「同一仕様」で移植したもの。
噴水状に大量のパーティクルを上方へ噴き上げ、重力で落とす加算発光エフェクト。
比較の主軸は **パーティクル機構のスループット（粒子数スケール）と加算ブレンド描画**。

## 起動方法

`file://` 直開きは不可（CDN/canvas の都合）。テーマフォルダをルートに HTTP サーバを立てる:

```bash
cd 3d/04
python -m http.server 8000
# → http://localhost:8000/Babylon.js/ を開く
```

## 使用バージョン

- Babylon.js: CDN `https://cdn.babylonjs.com/babylon.js`（グローバル `BABYLON`、最新安定版 v8 系）
- 描画バックエンド: **WebGL2**（Babylon 既定。WebGPU 不使用）

## 操作

- `+` / `-`（`]` / `[`）: 目標粒子数 N の増減（±20000、最小 5000 / 最大 500000）。**比較の主軸**。
- `R`: リセット（N=20000 に戻す）。
- 入力なしで噴出は継続（無人ベンチ可）。

## HUD（画面左上）

- `FPS`（実測・移動平均）
- `Objects`（描画中パーティクル数 = N）
- `Particles`（目標粒子数設定 N）
- `Draws`（draw call 数。`SceneInstrumentation.drawCallsCounter.current`）
- `Points`（描画点数 = `activeParticleCount` = N。点描画なので Tris は無意味なため Points を表示）
- `Mode`（`GPU` または `CPU(fallback)`。下記参照）

## GPUParticleSystem の設定と加算ブレンドの手順 / つまずき

### IsSupported の確認とフォールバック

GPUParticleSystem は WebGL2 の **transform feedback** を必要とする。起動時に
`BABYLON.GPUParticleSystem.IsSupported` を確認し、

- 対応: `new BABYLON.GPUParticleSystem("p", { capacity: 500000 }, scene)`
- 非対応: CPU の `new BABYLON.ParticleSystem("p", 500000, scene)` にフォールバック

を選ぶ。HUD の `Mode` 行と本 README に明記している。CPU フォールバック時は大粒子数で
極端に重くなる点に注意（あくまで起動保証用）。

### activeParticleCount と emitRate（再生成不要のスケール）

- `capacity` は **最大数（500000）ぶん**確保しておく。表示数は
  **`system.activeParticleCount = N`** で制御する（GPU 版のみ有効なプロパティ）。
  これにより `+`/`-` で N を変えても**システムの再生成は不要**。
- ただし `activeParticleCount` だけでは「寿命中に何個まで充填するか」が決まらないので、
  `emitRate = N / LIFE` を同時に更新する。寿命 3.0s の間に N 個を吐き切る定常噴水になる。
- `setCount()` で両者を必ずセットで更新している。

### エミッタ（コーン）と初速

- `system.emitter = BABYLON.Vector3.Zero()`（原点）。
- `system.createPointEmitter(direction1, direction2)` で +Y 中心の広めコーン
  （水平成分 ±0.7 / Y=1.0 → 仰角おおむね 35〜90°相当）。
- `minEmitPower=4 / maxEmitPower=10`（速さ域）、`gravity=(0,-9,0)`、
  `minLifeTime=maxLifeTime=3.0`。

### 色グラデ（加算）と BLENDMODE_ADD

- `addColorGradient(t, Color4)` で 黄 `#fff1a8`(a=1) → 橙 `#ff8a3d` → 赤紫 `#8c1f59`(a=0)。
  末端でアルファ 0 にすることで寿命末にフェードアウトする。
- `system.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD`（加算発光）。
  GPUParticleSystem も同じ `blendMode` 定数を使う。深度書き込みは既定で OFF なので
  粒子が重なるほど明るく加算される。

### サイズグラデ

- `minSize/maxSize` でベースサイズを与え、`addSizeGradient(0,1.0)→(1,0.2)` で
  誕生時大→寿命末で縮小。透視による遠近の縮小は Babylon が自動で処理する。

### パーティクルテクスチャをコード生成

画像ファイルは使わず、`BABYLON.DynamicTexture` の 2D canvas に
放射状グラデ（中心白→端 0）を描いて `system.particleTexture` に設定する。
ソフトエッジの円形スプライトが得られ、加算と相性が良い。

## 決定的生成について

SPEC の「決定的（`Math.random` 不使用）」は four-lib 共通の挙動性質を指す。
**Babylon の GPUParticleSystem はエンジン内部で乱数を使う**ため、粒子の個々の軌道は
他ライブラリと完全一致しない（SPEC 注記どおりの前提）。ゲームロジック側では
`Math.random` を新たに使っていない（N の増減・リセットのみ）。

## AI 生成所感

- three.js 版は「頂点シェーダで時間から位置を計算する自作 Points」だったが、Babylon は
  `GPUParticleSystem` という高レベル機構があるため、シェーダを書かずに噴水・加算・色寿命を
  宣言的に構築できた。移植は数値（速さ域・重力・寿命・色・N）の対応付けが中心。
- 最大のつまずきは「N のスケールをどう再生成なしで実現するか」。`capacity` を最大で確保し
  `activeParticleCount` + `emitRate` の2点を更新する、が GPU 版の定石。`activeParticleCount` は
  GPU 版限定プロパティなのでフォールバック時は emitRate だけで近似する。
- `IsSupported` 確認とフォールバックは、環境差（古い GPU/ドライバ）で transform feedback が
  使えないケースを想定した安全策。比較ベンチとしては GPU 経路が本命。
