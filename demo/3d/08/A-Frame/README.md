# 3D T8 ― PBR マテリアル + ポストプロセス(Bloom) ／ A-Frame 実装

`../SPEC.md` が唯一の正。three.js リファレンス実装(`../three.js/`)と数値・挙動を完全一致させた A-Frame 移植。
多数の PBR 球を環境反射 + Bloom 付きで描画し、球数(N)を主軸に性能を横並び比較する。

## 起動方法

`file://` 直開きは不可（CORS で importmap の addon / 任意アセットが読めない）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/08
python -m http.server 8000
# → http://localhost:8000/A-Frame/ を開く
```

操作:
- `+` / `=` / `]` : PBR 球を +100
- `-` / `_` / `[` : PBR 球を -100
- `R` : 球数を初期値(200)に戻す
- カメラは自動周回（無人ベンチ可）

## 使用バージョン

- **A-Frame 1.7.0**（`https://aframe.io/releases/1.7.0/aframe.min.js`）
- **同梱 three（super-three）= r173（`super-three@0.173.4`）**
- ポストプロセス用 addon は **同一リビジョンの `super-three@0.173.4`** を jsDelivr から動的 import
  （`examples/jsm/postprocessing/*`, `environments/RoomEnvironment.js`）

## PBR 球の実装

- 共有 `THREE.SphereGeometry(0.7, 24, 16)` ＋ 各球 `THREE.MeshStandardMaterial`。
- `mulberry32(seed = 0x9e3779b9)` の決定的乱数で、`metalness`（半数は完全金属 1.0）・`roughness(0.05..1.0)`・
  HSL ベース色を生成。**約 15% の球は emissive**（自発光・強度高め）にして Bloom で光らせる。
- 配置は `k = ceil(cbrt(N))` の立方格子、間隔 2.2、中心揃え（three.js 版と同一順序・同一座標）。
- `AFRAME.THREE.Mesh` を `a-scene` の `object3D` に直接 add（宣言タグでは大量生成しづらいため）。

直接光・環境光・露出（ACES Filmic / exposure 1.0）・`environmentIntensity = 0.5` も three.js 版と同値。

## Bloom / ポスト処理の実現方法

**採用方式: 実 Bloom（EffectComposer + UnrealBloomPass）を第一候補、失敗時は擬似グローへ自動フォールバック。**

### つまずきの本質
`EffectComposer` / `RenderPass` / `UnrealBloomPass` / `OutputPass` / `RoomEnvironment` は **A-Frame の `AFRAME.THREE` には公開されていない**。
これらの addon は内部で `import ... from 'three'` を行うため、素のままでは「ベア指定子 `three` が解決できない」で失敗する。

### 解法
`index.html` の **importmap で `'three'` を A-Frame 同梱と同一リビジョンの `super-three@0.173.4` 本体へ解決**し、addon を `import()` で動的読込する。

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/super-three@0.173.4/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/super-three@0.173.4/examples/jsm/"
} }
</script>
```

- `EffectComposer` は **renderer インスタンスを直接使い**、内部の `instanceof` 判定は addon が自前 import する Pass 同士。
  シーン/カメラ/レンダラは A-Frame 側（`AFRAME.THREE`）のものを渡すが、**addon 側 three と同一バージョン(r173)なので
  `WebGLRenderTarget` 等の構造が一致し互換に動く**（バージョンが食い違うと壊れやすいので "同一 rev" が肝）。
- 描画の乗っ取り: addon ロード成功時に **`renderer.render` を no-op 化**し、`tick` 内で `composer.render()` を呼ぶ
  （A-Frame の自動描画と composer の二重描画を防ぐ）。`remove` で元に戻す。
- Bloom パラメータは three.js 版と同値: `strength 0.35 / radius 0.4 / threshold 0.9`（emissive 部のみ滲ませる）。
- `renderer.info.autoReset = false` ＋ 毎フレーム手動 `reset()` で、composer の全パスの draw call / triangle を HUD に集計。

### フォールバック（擬似グロー）
ブラウザの importmap 非対応や addon 取得失敗時は、捏造せずに **「emissive 球の自発光をさらに強め(3.5) ＋ ACES トーンマップ」**
の擬似グローへ自動で切り替える。この場合 EffectComposer は使わず A-Frame 標準描画のまま。
採用方式は **HUD の `Post`（`bloom` / `glow`）と画面下 note に明示**する。

## カメラの罠（A-Frame 固有）

`#rig` の `object3D` は **Group**。`Group.lookAt` は非カメラ分岐で **+Z を対象へ向ける**ため、子の
`PerspectiveCamera`（-Z を見る）は真後ろを向いてしまう。そこで `cameraEl.getObject3D('camera')` で
**THREE.Camera 本体を直接取得**し、`camera.lookAt(0,0,0)` の `isCamera` 分岐（-Z が対象を向く）を使う。
カメラは半径 30 / 高さ 8 / 角速度 0.2 rad/s で原点を注視しながら自動周回（決定的・時間ベース）。
`look-controls` / `wasd-controls` は無効化し、`rig` は `position="0 0 0"` の単位変換に固定（camera 本体 local = world）。

## HUD

画面左上に HTML オーバーレイ（scene 外）。`FPS`(移動平均) / `Objects`(=N) / `Spheres`(=N) /
`Draws`(`renderer.info.render.calls`) / `Tris`(`.triangles`) / `Post`(bloom or glow) を数フレームに1回更新。

## 環境（反射）

任意の `../assets/env_equirect.png`（2:1 equirectangular）があれば環境マップ＋背景に使用。
無ければ `RoomEnvironment` を PMREM 化して `scene.environment` に設定（addon 動的 import）。それも失敗時は
HemisphereLight による簡易環境へ。背景はフォールバック時 `#1a1f2a`。

## AI 生成所感

- 最大の難所は「postprocessing addon を A-Frame 同梱 three にどう繋ぐか」。AI は安易に
  `three@latest` の addon を import しがちだが、それだと **同梱 three と別バージョン/別インスタンス**になり、
  render target 共有や `instanceof` で壊れる。**同梱 rev(r173) に固定**するのが要点で、これは
  `AFRAME.THREE.REVISION` か package.json を実機/ソースで確認しないと外しやすい。
- `renderer.render` の乗っ取りは A-Frame のポストプロセス定石だが、二重描画・XR 経路に注意。
  本実装は `embedded`・非 VR 前提で no-op 化 + composer 駆動とした。
- 画像欠落・addon 取得失敗のどちらでも必ず起動するよう二段フォールバックを用意（PBR は単色マテリアルで成立、
  Bloom は擬似グローで成立）。SPEC の「画像必須にしない／必ず起動」を満たす。
