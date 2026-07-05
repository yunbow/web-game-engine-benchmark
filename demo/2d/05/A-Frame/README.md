# 横スクロールアクション — A-Frame 版

テーマ5共通仕様（横スクロール・重力/AABB物理・広い横長マップのカリング・性能比較用）の **A-Frame** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 画面・マップ
- キャンバス **960 x 540**（固定）/ タイル **32x32**。
- マップ **200 x 17 タイル**（= **6400 x 544 px**）を固定シードで決定的生成。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`5/`)をルートに HTTP サーバを立てて開く。

```bash
cd 5
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- 移動: `←`/`→` または `A`/`D`
- ジャンプ: `Space` / `↑` / `W`（接地時のみ・可変ジャンプ）
- ダッシュ: `Shift` 押下中（1.6倍速）
- `+` / `-`（テンキー +/- も可）: 敵数を ±10（下限0・上限500）

## 実装メモ（設計判断つき）
- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に `<a-scene>` として宣言**し、ゲーム本体は登録した **`platformer-game` コンポーネント**が駆動（A-Frame の renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断（重要）**: タイル（可視〜510）・敵（最大500）・コインは大量になり得る。「1オブジェクト = 1 `<a-entity>`」だと DOM/コンポーネント生成コストで FPS が破綻するため、**動的オブジェクトはコンポーネント内で `THREE.Sprite` を直接生成・管理**する（`this.world`(`THREE.Group`) に add）。A-Frame で大量2Dオブジェクトを扱う際の現実的な定石。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0,-1000,1000)`** に維持（A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく **`worldY = WORLD_H - gameY`** 変換、Sprite は `center.set(0,0)`。
- **物理は SPEC 準拠の自前実装**: 重力 1800 / 可変ジャンプ / **AABB を軸分離（X→解決, Y→解決）** したタイル当たり（物理エンジン不使用）。
- **広い横長マップの水平スクロール**: ワールド全体を載せた **`THREE.Group` を `-camX, +camY` 平行移動**（= カメラ追従。`camX∈[0, 6400-960]` でクランプ）。背景 `bg_sky` は画面固定（world から分離して scene ルートに配置）。
- **タイルカリング**: 可視範囲ぶん（≈ 32x19）の **Sprite プール**を確保し、毎フレーム可視タイルへテクスチャ・座標を割り当てて再利用（描画数を `Tiles drawn` として HUD 表示）。
- `renderer.setPixelRatio(1)` で DPR 1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形（SPEC 既定色）→ `CanvasTexture`。HUD は HTML オーバーレイ。

## Codex / AI コーディング所感
- **HTML 宣言的**なのでシーンの骨格は AI が書きやすい。
- 罠は **「宣言的フレームワークで非宣言的な 2D 横スクロールを書く」**ミスマッチ: ① 大量タイル/敵を素直に `<a-entity>` で作ると破綻（上記のとおり THREE 直管理 + プールカリングが必要）。② 2D 用 ortho カメラは A-Frame に既定がなく、`sceneEl.camera` 差し替えという定石を知らないと perspective のまま実装しがち。③ `tick(time, dtMs)` の dt が **ms 単位**。④ 広いマップのスクロールは world Group の平行移動で実装し、`tick` 毎にカメラを再適用する点を明示指示するのが鍵。
