# 3D T2 広域地形 + カリング/LOD/描画距離 — PlayCanvas（エンジンのみ・CDN）

three.js リファレンス実装（`../three.js/`）の同一仕様移植。`../SPEC.md` が唯一の正。
10000本の木をグリッド配置し、上空を周回するカメラから「距離カリング＋2段LOD＋
エンジンの自動フラスタムカリング」で可視ぶんのみ描画する性能比較ベンチ。

## 起動方法

`file://` 直開きは不可（CDN/モジュール読込のため）。テーマフォルダをルートに HTTP サーバを立てる。

```bash
cd 3d/05
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

`+` / `-`（`]` / `[`）で描画距離 ±40（min40 / max360・初期120）、`R` で初期化。カメラは自動周回飛行（無人ベンチ可）。

## 使用バージョン

- PlayCanvas: `https://code.playcanvas.com/playcanvas-stable.min.js`（stable・UMD グローバル `pc`）
- WebGL2 明示（`graphicsDeviceOptions.deviceTypes: [pc.DEVICETYPE_WEBGL2]`）。960x540 固定（`RESOLUTION_FIXED`）。

## カリング / LOD / 距離カリングの実装

3 段の「描かない/簡略化する」仕組みを重ねている。

1. **距離カリング（アプリ側・毎フレーム）**
   各木 Entity とカメラの水平距離 d を平方距離（`dx*dx+dz*dz`）で比較し、
   `d > drawDist` の木は **`obj.enabled = false`**。enabled=false の Entity は子ごと
   レンダリング対象から外れる（three.js版の `visible=false` 相当）。HUD の `Objects` は
   この距離カリング後の本数（InRange）。

2. **2 段 LOD（アプリ側・毎フレーム）**
   `lodDist = drawDist*0.5`。`d ≤ lodDist` → 子 **LOD0**（幹 `createCylinder` + 葉
   `createCone` の 2 メッシュ）を enabled、`lodDist < d ≤ drawDist` → 子 **LOD1**
   （4 分割の単一低ポリ円錐）を enabled。LOD0/LOD1 の Entity の enabled を切り替えるだけで
   切り替える（生成はしない）。

3. **自動フラスタムカリング（エンジン側）**
   各 `MeshInstance.cull`（既定 true）により、視錐台外の MeshInstance は描画されない。
   結果 `Draws`（= `app.stats.drawCalls.total`）は InRange より小さくなる（カリングが効いている証拠）。

### 性能設計（10000 Entity 対策）

- **共有メッシュ**: 幹 / 葉 / 低ポリ円錐の `pc.Mesh` を **各 1 個だけ**生成し、全 10000 本の
  `MeshInstance` に同じ Mesh を渡す。頂点バッファは 3 個で済む。
- **共有メッシュの永続化（`incRefCount`）**: PlayCanvas は MeshInstance / Entity 破棄時に
  Mesh の参照カウントが 0 になると頂点バッファごと破棄する。木 Entity を 1 本でも消すと
  共有 Mesh が巻き添えで破棄され、他 9999 本が壊れる（T3 で実際に踏んだバグ）。生成直後に
  `mesh.incRefCount()` で refCount ≥ 1 を保ち、Entity 破棄に巻き込まれないようにした。
  本実装では木 Entity は破棄せず enabled 切替のみだが、保険として永続化している。
- 木の親 Entity は 10000 個常駐。毎フレーム触るのは平方距離計算と enabled フラグのみで、
  オブジェクト生成・行列再計算は発生しない。

### 個体差の決定性

`mulberry32(0x9e3779b9)` を three.js版と**同じ消費順**（高さ係数 → Y回転）で回し、高さ係数
0.8〜1.4 を親の Y スケール、Y回転を親の Y オイラー角に適用。`Math.random` 不使用で完全決定的
（無人ベンチで全エンジン同一配置）。

### ジオメトリの底合わせ

three.js は `geometry.translate()` でメッシュ原点を動かせるが、PlayCanvas の
`createCylinder`/`createCone` は**原点中心生成**で後から平行移動できない。そこで各 LOD メッシュを
**子 Entity** に載せ、子のローカル Y 位置でずらして「幹底 y=0」を作る:
幹（中心 h2）→ +1、葉（中心 h4）→ +4（底 y2・頂 y6）、低ポリ円錐（中心 h6）→ +3（底 y0・頂 y6）。
これで three.js版の見た目（translate(0,1)/(0,4)/(0,3)）と一致する。

## つまずき

- **共有メッシュの破棄連鎖**（最重要）: 上記 `incRefCount`。AI は three.js の「ジオメトリ共有」を
  そのまま書きがちだが、PlayCanvas は参照カウント GC があるため明示しないと巻き添え破棄が起きる。
- **円錐/円柱の中心生成**: three.js の translate 前提コードをそのまま移すと木が地面にめり込む。
  子 Entity でのオフセットが必須。
- **fog API**: three.js は `scene.fog = new Fog(...)`。PlayCanvas は `app.scene.fog = pc.FOG_LINEAR`
  ＋ `fogColor` / `fogStart` / `fogEnd` を個別設定（オブジェクトではなく定数＋プロパティ）。
- **directional の向き**: PlayCanvas の平行光は「Entity の forward(-Z) = 光の進む向き」。
  three.js の `light.position` とは意味が違うので、`lookAt(進行方向)` で向ける。
- **Tris は概算**: 距離分布で LOD0/LOD1 の内訳が毎フレーム変わり、エンジン統計に LOD 別の正確な
  三角形数は出ない。HUD では InRange 全数を LOD0（幹+葉）とみなす**上限概算**を表示（実値はこれ以下）。
- **`+` キー検出**: Shift+`=` 環境差を吸収するため `+`/`=`/`]` を OR で受ける（three.js版と同じ）。

## AI 生成所感

- `createCylinder`/`createCone` などの簡便ヘルパが stable でも健在で、three.js のプリミティブ志向
  コードと素直に対応が取れる。一方「メッシュ原点中心生成」「参照カウント破棄」という PlayCanvas
  固有の落とし穴は、three.js 知識のまま移植すると確実に踏むため、SPEC とテーマ間の知見
  （T3 の共有メッシュ破棄バグ）が効いた。
- enabled による距離カリングは Entity 階層と相性が良く、`visible` フラグ方式の three.js から
  ほぼ 1:1 で移植できた。自動フラスタムカリングも MeshInstance 既定 true で追加実装不要。
