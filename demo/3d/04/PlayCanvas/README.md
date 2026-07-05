# 3D テーマ4(T6) GPUパーティクル（魔法/噴水） — PlayCanvas

`particlesystem` コンポーネント（GPU 加速パーティクル）で、原点から上方へ噴き上がり
重力で落ちる噴水状の加算発光パーティクルを実装。SPEC（`../SPEC.md`）が唯一の正で、
粒子数・寿命・色・カメラを他ライブラリ（three.js / Babylon.js / A-Frame）と揃えている。

## 起動方法
画像読込は無いが、CDN/相対参照のため HTTP サーバ経由で開く（`file://` 直開き不可）。
```bash
cd 3d/04
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/
```

## 使用バージョン
- PlayCanvas: `https://code.playcanvas.com/playcanvas-stable.min.js`（グローバル `pc` / UMD・stable 最新）
- WebGL2 を明示（`deviceTypes: [pc.DEVICETYPE_WEBGL2]`）。WebGPU 不使用。

## 操作
- `+` / `-`（`]` / `[`）: 目標粒子数 N の増減（±20000 / 最小 5000 / 最大 500000）。比較の主軸。
- `R`: リセット（N=20000）。
- 入力なしで噴出は継続（`preWarm: true` で起動直後から定常噴水。無人ベンチ可）。

## 粒子機構（particlesystem）の設定
SPEC 値に合わせた主なプロパティ:

| 項目 | 値 | 意味 |
|------|----|------|
| `numParticles` | N（初期 20000） | 同時生存粒子の最大数 |
| `lifetime` | 3.0 | 寿命 3.0s でループ |
| `rate` / `rate2` | `LIFE / N`（= 3/N） | 寿命中に N 個を定常充填する emit 間隔 |
| `emitterShape` | `EMITTERSHAPE_SPHERE` | 原点付近の小半径（`emitterRadius: 0.3`） |
| `initialVelocity` | 2 | 球状エミッタからの放射状初速（広がり寄与・小さめ） |
| `velocityGraph` (Y) | +7 → -20 | 重力 (0,-9,0) を時間で線形近似（上昇→落下の放物線） |
| `velocityGraph2` | XYZ 幅 | velocityGraph との範囲でランダム化＝上方コーンの広がり |
| `colorGraph` | 黄→橙→赤紫 | `#fff1a8`(1,0.945,0.659) → `#ff8a3d`(1,0.541,0.239) → 赤紫(0.55,0.12,0.35) |
| `alphaGraph` | 1 → 0 | 寿命でフェードアウト |
| `scaleGraph` | 0.6 → 0.15 | 誕生大→消滅小 |
| `blendType` | `BLEND_ADDITIVE` | 加算発光 |
| `depthWrite` | `false` | 深度書き込み OFF（重なりで発光が加算） |
| `colorMap` | canvas 生成テクスチャ | 放射状グラデのソフト円形スプライト（画像ファイル不使用） |
| `sort` | `PARTICLESORT_NONE` | ソート無効＝GPU モード維持（加算なので順不同で可） |

### 重力の表現
PlayCanvas の particlesystem には明示的な gravity プロパティが無いため、**`velocityGraph` の Y を
時間で線形に減少**（+7 → -20）させ、上がって落ちる放物線を近似した。v_y=0 となる t≈0.78s が頂点で、
寿命 3s 内に上昇→落下する SPEC の挙動を満たす。`localVelocityGraph` は使わずワールド `velocityGraph` を採用。

### パーティクルテクスチャ
小さな 64x64 canvas に放射状グラデ（中心白→外周透明）を描き `pc.Texture` 化して `colorMap` に設定。
画像ファイル不使用。加算ブレンドで中心ほど明るいソフト円形の発光になる。

## numParticles の上限・つまずき
- **実上限**: particlesystem は per-particle 状態を `sqrt(numParticles)` 四方のテクスチャに格納するため、
  実上限は `device.maxTextureSize^2`。SPEC の最大 500000 は約 708×708 で、通常の `maxTextureSize`
  （概ね 4096〜16384）に十分収まり**クランプは発生しない**見込み。安全のためコードでは
  `N_CAP = min(500000, maxTextureSize^2)` でクランプし、HUD/設定はこの範囲に収める。
- **numParticles 変更には再初期化が必要**: 実行時に `numParticles` を変えても即時反映されないため、
  `+`/`-`/`R` 操作時は **Entity ごと作り直す**（`emitter.destroy()` → `buildEmitter(N)`）。
  大きな N での再生成は一瞬コストがあるが、比較は定常状態の FPS で行うため許容。
- **GPU モード維持**: `sort` を `PARTICLESORT_NONE` にしないと CPU ソートに落ちて GPU パーティクルの
  利点が消える。加算ブレンドは描画順非依存なのでソート不要。
- **`initialVelocity` の罠**: 球状エミッタの `initialVelocity` は全方向放射のため、大きいと粒子が
  下方にも飛ぶ。噴水の上方軸は `velocityGraph`(Y) に任せ、`initialVelocity` は広がり用に小さく（2）した。

## HUD
- `FPS`（移動平均）/ `Objects`（描画粒子数 = N）/ `Particles`（目標 N）/
  `Draws`（`app.stats.drawCalls.total`）/ `Points`（= N。点描画相当の表示値）。
- HUD は HTML オーバーレイ。更新は 6 フレームに 1 回。

## 決定性についての注記
ゲームロジックでは `Math.random` を新規に使わない（決定性方針）。ただし **PlayCanvas の particlesystem は
内部乱数で各粒子の方向・寿命位相を決める**ため、粒子の軌道は他ライブラリ（mulberry32 シード固定）とは
完全一致しない。揃えているのは「粒子数・寿命・速度域・重力・色・加算発光・数値の意味」（SPEC 準拠）。

## AI生成所感
- particlesystem は宣言的にプロパティを並べるだけで GPU パーティクルが動くため、three.js の自作
  頂点シェーダ実装に比べコード量は少ない。一方で「重力」「上方コーン」を直接指定する API が無く、
  `velocityGraph` / `velocityGraph2` のカーブで物理を近似する発想が必要で、ここが移植の最難所だった。
- `numParticles` がテクスチャサイズ由来の上限を持つ点、変更に再初期化が要る点は、AI が見落としがちで
  実装時に明示的に押さえる必要があった。
- 色は `colorGraph`(RGB CurveSet) と `alphaGraph`(別 Curve) に分離されており、three.js のフラグメント
  シェーダで一括計算していた色＋アルファをカーブへ分解して移植した。
