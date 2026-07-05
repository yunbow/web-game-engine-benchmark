# トップダウンRPG探索 — A-Frame 版

テーマ3共通仕様（見下ろし型RPG探索・大マップスクロール描画の性能比較用）の **A-Frame** 実装。
画像アセットが無くても単色タイル/図形（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`3/`)をルートに HTTP サーバを立てて開く。

```bash
cd 3
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- 移動: WASD / 矢印キー（4方向、速度 160px/s。壁/水/木に衝突）
- `Shift`: ダッシュ（2倍速）
- `+` / `-`（テンキー +/- も可）: 画面上のエンティティ（NPC+敵スライム）数を ±10

## 画面・基本設定
- キャンバス **960 x 540**（固定）、タイル **32x32**、マップ **100 x 100 タイル**（3200x3200px）。
- マップは固定シード mulberry32 で決定的生成。PixiJS 正準実装と同じ手順・同じ見た目。

## 実装メモ（設計判断つき）
- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に `<a-scene>` として宣言**し、ゲーム本体は登録した **`rpg-game` コンポーネント**が駆動（A-Frame の renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断（重要）**: 広大マップは 100×100＝1万タイル。「1タイル = 1 `<a-entity>`」だと DOM/コンポーネント生成で破綻するため、**動的オブジェクトはコンポーネント内で `THREE.Sprite` を直接生成・管理**し（`this.el.object3D` に add）、可視範囲ぶんのプールを再利用する。これは A-Frame で大量2Dオブジェクトを扱う際の現実的な定石。
- **カリング（本テーマの肝）**: 可視範囲ぶん（`ceil(W/32)+2` × `ceil(H/32)+2` ≒ 32×19 枚）の `THREE.Sprite` をプール確保し、毎フレーム可視タイルへ `material.map`（テクスチャ）と座標 `tile*32 - cam` を割り当てて再利用。**可視タイルのみ描画**（PixiJS 正準実装と同一戦略）。HUD に当該フレームの描画タイル数を出す。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0,-1000,1000)`** に維持（A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく `worldY = H - gameY` 変換、`Sprite.center=(0,1)` で左上アンカー。木（32x48）は地面（草）の上に重ねて `renderOrder` で深度ソート。
- `renderer.setPixelRatio(1)` で DPR を 1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。
- アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形 → `CanvasTexture`。当たり判定は SPEC 準拠の自前タイル矩形判定。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- **HTML 宣言的**なのでシーンの骨格は AI が書きやすい。VR/3D の entity 配置サンプルは豊富。
- 罠は **「宣言的フレームワークで非宣言的な 2D 大マップを書く」**ミスマッチ: ① 1万タイルを素直に `<a-entity>` で作ると破綻（上記のとおり THREE 直管理＋可視プールが必要）。② 2D 用 ortho カメラは A-Frame に既定がなく、`sceneEl.camera` 差し替えという定石を知らないと perspective のまま実装しがち。③ `tick(time, dtMs)` の dt が **ms 単位**。AI を素直に走らせると全タイルを a-entity 化して FPS を落としやすいので、**THREE 直描画＋可視カリングの方針を明示指示**するのが鍵。
