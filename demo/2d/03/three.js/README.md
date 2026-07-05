# トップダウンRPG探索 — three.js 版

テーマ3共通仕様（見下ろし型RPG探索・大マップスクロール描画の性能比較用）の **three.js** 実装。
画像アセットが無くても単色タイル/図形（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`3/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 3
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- 移動: WASD / 矢印キー（4方向、速度 160px/s。壁/水/木に衝突）
- `Shift`: ダッシュ（2倍速）
- `+` / `-`（テンキー +/- も可）: 画面上のエンティティ（NPC+敵スライム）数を ±10

## 画面・基本設定
- キャンバス **960 x 540**（固定）、タイル **32x32**、マップ **100 x 100 タイル**（3200x3200px）。
- マップは固定シード mulberry32 で決定的生成。PixiJS 正準実装と同じ手順・同じ見た目。

## 実装メモ
- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、原点左下・Y上向き）。
- ゲームロジックは**画面座標（Y 下向き・PixiJS と同一定数）のまま**保持し、描画同期時のみ `worldY = H - gameY` に変換。`THREE.Sprite` の `center` を `(0,1)` に設定して左上アンカー扱いにする。
- **カリング（本テーマの肝）**: マップは 100×100＝1万タイル。全部 add すると破綻するため、**可視範囲ぶん（`ceil(W/32)+2` × `ceil(H/32)+2` ≒ 32×19 枚）の `THREE.Sprite` をプール確保**し、毎フレーム可視タイルへ `material.map`（テクスチャ）と座標 `tile*32 - cam` を割り当てて再利用。**可視タイルのみ描画**（PixiJS 正準実装と同一戦略）。HUD に当該フレームの描画タイル数を出す。
- 木（32x48）は別プールで地面（草）の上に重ね、`renderOrder` を `タイルY座標` で微調整して自機/エンティティと深度ソート。重ね順は `depthTest:false` + `renderOrder`。
- アセットは `TextureLoader.loadAsync` を個別 try/catch、失敗時は 2D canvas に図形を描いて `CanvasTexture` 化（`NearestFilter`）。`renderer.setPixelRatio(1)` で DPR 固定。
- 当たり判定は SPEC 準拠の自前タイル矩形判定（軸分離移動）。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- 訓練データは最大級で three.js 自体の API は安定して書ける。
- 罠は **「2D ゲームとしての足場」**: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転）。② r150 前後以降の **ESM 化 / importmap 必須**。③ `THREE.Sprite` の `center` を知らないと中心アンカーのまま 16px ズレる。④ **広大マップで全タイルを Mesh/Sprite 化するとドローコール爆発**。本実装は「可視枚数だけプール再利用」を明示採用。AI を素直に走らせると全タイル生成に流れやすく、カリング方針の明示指示が鍵。
