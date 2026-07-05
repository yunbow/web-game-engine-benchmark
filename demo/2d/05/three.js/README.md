# 横スクロールアクション — three.js 版

テーマ5共通仕様（横スクロール・重力/AABB物理・広い横長マップのカリング・性能比較用）の **three.js** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 画面・マップ
- キャンバス **960 x 540**（固定）/ タイル **32x32**。
- マップ **200 x 17 タイル**（= **6400 x 544 px**）を固定シードで決定的生成。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`5/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 5
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- 移動: `←`/`→` または `A`/`D`
- ジャンプ: `Space` / `↑` / `W`（接地時のみ・可変ジャンプ）
- ダッシュ: `Shift` 押下中（1.6倍速）
- `+` / `-`（テンキー +/- も可）: 敵数を ±10（下限0・上限500）

## 実装メモ
- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、原点左下・Y上向き）。
- ゲームロジックは**画面座標（Y 下向き・PixiJS 正準実装と同一定数）のまま**保持し、描画同期時のみ `worldY = WORLD_H - gameY` に変換。スプライトは `center.set(0,0)`（左下アンカー）で整合。
- スプライトは **`THREE.Sprite`**、重ね順は `renderOrder`（bg<tile<coin<enemy<player<fx）、`depthTest:false`。
- **物理は SPEC 準拠の自前実装**: 重力 1800 / 可変ジャンプ / **AABB を軸分離（X→解決, Y→解決）** したタイル当たり（物理エンジン不使用）。
- **広い横長マップの水平スクロール**: ワールド全体を載せた **`THREE.Group` を `-camX, +camY` 平行移動**して表現する（= カメラ追従。`camX∈[0, 6400-960]` でクランプ）。背景 `bg_sky` は画面固定の repeat Plane（`scene` 直下）として world から分離。
- **タイルカリング**: 可視範囲ぶん（`(ceil(960/32)+2) × (ceil(540/32)+2)` ≈ 32x19）の **Sprite プールを確保**し、毎フレーム可視タイルへテクスチャ・座標を割り当てて再利用する真のカリング（PixiJS と同方式。描画数を `Tiles drawn` として HUD 表示）。
- アセットは `TextureLoader.loadAsync` を個別 try/catch。失敗時は 2D canvas に SPEC 既定色で図形を描いて `CanvasTexture` 化（`NearestFilter`）。
- ループは `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発を抑制）。`setPixelRatio(1)` で DPR 固定。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- 訓練データは最大級で three.js 自体は安定して書けるが、**「2D 横スクロールの足場」**で罠が出る。
- 罠: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転・カリング欠落）。② 広いマップの**スクロールを「カメラを動かす」か「world Group を動かす」かの一貫性**。本実装は world Group を平行移動し、Sprite の `center` で worldY 変換と整合させた。③ 大量スプライトでは **プール再利用カリング**を明示しないと毎フレーム生成破棄でリーク/GC が出る。④ r150 前後以降の **ESM 化 / importmap 必須**。
