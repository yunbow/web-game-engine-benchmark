# 3D テーマ6（T5）動的シャドウ光源 — PlayCanvas（エンジンのみ・CDN）

`../SPEC.md` を唯一の正として、three.js リファレンス実装を PlayCanvas へ同一仕様で移植したもの。
柱 8×8=64 本の上を N 個のスポットライトが周回し、各光源が 1024×1024 のシャドウマップを生成する。
**比較の主軸 = 影を落とすリアルタイム光源の数（シャドウマップ枚数）**。

## 起動方法

`file://` 直開きは不可（一部ブラウザで WebGL/モジュール周りの制約に当たる）。テーマフォルダをルートに HTTP サーバを立てる:

```bash
cd 3d/06
python -m http.server 8000
# → http://localhost:8000/PlayCanvas/ を開く
```

## 操作

- `+` / `-`（`]` / `[`）: 影付き光源数 N を ±2（最小 1 / 最大 12）。**比較の主軸**。
- `R`: 光源数を初期値（4）に戻す。
- カメラ固定・光源は自動周回（無人ベンチ可）。

## 使用バージョン

- PlayCanvas エンジン: `https://code.playcanvas.com/playcanvas-stable.min.js`（実体 **2.7.4**、UMD グローバル `pc`）。
- WebGL2 を明示（`deviceTypes: [pc.DEVICETYPE_WEBGL2]`、WebGPU は使わない）。
- 画像 / GLB 不使用・プリミティブ（box）のみ。

## シャドウマップ設定（このテーマの肝）

- **複数光源の影**: スポットライトを `pc.Entity` + `light` コンポーネントで N 個生成。各光源が独立した
  シャドウマップを持つため、N を増やすほどシャドウ生成パスが増えて FPS が落ちる（＝比較の主軸）。
- 各 spot light の影設定:
  - `castShadows: true`
  - `shadowResolution: 1024`（SPEC 共通の 1024×1024）
  - `shadowType: pc.SHADOW_PCF3`（PCF ソフト影。2.7.4 では `SHADOW_PCF3_32F` の後方互換エイリアス）
  - `shadowBias: 0.02` / `normalOffsetBias: 0.05`（ピーターパン/アクネのバランス調整）
  - `range: 120` / `innerConeAngle: 40` / `outerConeAngle: 50` / `intensity: 1.0`
- **receiveShadows**: 地面と柱の `render` コンポーネントで `receiveShadows: true`。柱はさらに `castShadows: true`。
  地面は `castShadows: false`（影を受けるだけ）。
- 光源は forward(-Z) が照射方向。毎フレーム `setPosition(22cos a, 30, 22sin a)` → `lookAt(0,1,0)` で中心を指す。
  位相 `φ_i = i·2π/N`、角速度 0.4 rad/s。色は色相 `i/N`（HSL→RGB を自前変換、three.js の `Color.setHSL` と同式）。
- N 変更時は light entity を `destroy()` → 再生成（プールを作り直し、φ_i を新しい N で再配置）。

## つまずき・実装メモ

- **【最重要】game.js 全体を IIFE `(function(){…})();` で隔離する。**
  PlayCanvas を classic `<script>`（非 module）で読むと、`game.js` のトップレベル `let`/`const` は
  エンジンの minified グローバルと同じレキシカルスコープを共有する。three.js 由来の mulberry32 などには
  トップレベル相当の単一文字 `let t` が出てきやすく、`Identifier 't' has already been declared` で**起動失敗**する
  （3d/05 PlayCanvas で実際に発生）。`node --check` では検出できずブラウザでのみ出るため、IIFE で必ず隔離した。
- **`shadowDistance` は spot に存在しない**（directional 専用）。three.js の `shadow.camera.far=90` 相当を
  そのまま移植しようとすると無視される/エラー要因になるため指定していない。spot のシャドウ視錐台 near/far は
  `range` とコーン角から自動算出される。
- **コーン角の意味の差**: PlayCanvas の `outerConeAngle` は「半角（中心軸からの角度）」。three.js は
  `SpotLight(..., angle)` も半角だが、リファレンスでは `50°/2 = 25°` を渡している。本移植はプロンプト指定どおり
  `outerConeAngle: 50`（広めの照射）を採用し、SPEC の「スポット角 ≈ 50°」の許容範囲（ペナンブラ/ソフトネスは
  各エンジン近似可）として扱った。影の有無・枚数という比較主軸は完全一致している。
- **共有メッシュは `incRefCount()` で永続化**。柱 64 本と地面は単一メッシュを共有するが、Entity 破棄時に
  参照カウントで GPU バッファが解放されると以後の描画が壊れるため、共有メッシュは明示的に永続化した。
- 地面は plane ではなく薄い大判 box を採用（法線・receiveShadows が安定）。柱は単位 box（高さ1）を
  `localScale.y = h` で伸ばし、`position.y = h/2` で底面を y=0 に揃える（three.js の scale.y 運用と同じ）。

## HUD

左上に HTML オーバーレイで `FPS`（移動平均）/ `Objects`(=64) / `Lights`(=N) / `Draws` / `Tris`。

- `Draws` は `app.stats.drawCalls.total`。**PlayCanvas はシャドウ生成パスのドローコールも計上され得る**ため、
  three.js の `renderer.info`（メインパスのみ）とは意味がずれる（SPEC 記載の既知差）。
- `Tris` はメインパス幾何の概算（柱 64 + 地面）。シャドウパス分は含めない近似値（注記）。
- **影コストの主指標は FPS**。光源数を増やすとシャドウマップ生成パスが増えて FPS が落ちる。
- HUD は数フレームに 1 回更新。`app.start()` はシーン構築をすべて終えてから最後に呼ぶ。

## AI 生成所感

- three.js → PlayCanvas の移植で最も実害が出るのは描画 API ではなく **classic script のグローバル汚染**。
  IIFE 隔離はプロンプトでも最重要指定されており、これを外すと無条件で起動失敗する。生成 AI は
  「動く three.js コードをそのまま classic script に貼る」挙動を取りがちなので、移植時の定石として固定したい。
- シャドウ関連プロパティはエンジンのメジャーバージョンで揺れる（`shadowDistance` の spot 非対応、
  `SHADOW_PCF3` vs `SHADOW_PCF3_32F` のエイリアス）。2.7.4 では後方互換名が生きているが、
  バージョン依存の罠なので使用バージョンを README に明記した。
- intensity は three.js（物理単位 600）と PlayCanvas（既定の非物理ライティングで ~1）でスケールが全く違う。
  数値そのものを一致させる意味はなく、「影の枚数 × FPS」という比較主軸が揃っていることが本質。
