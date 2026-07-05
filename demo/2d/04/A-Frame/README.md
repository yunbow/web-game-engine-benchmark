# ブロック崩し(マルチボール) — A-Frame 版

テーマ4共通仕様（ブロック崩し・マルチボール・性能比較用）の **A-Frame** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`4/`)をルートに HTTP サーバを立てて開く。

```bash
cd 4
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 画面・操作
- キャンバス: **960 × 540**（16:9 固定）。
- パドル移動: 矢印 `←`/`→` または `A`/`D`（水平のみ・画面内クランプ、600px/s）。
- ボール: **自動発射**（手動ロックなし。負荷を一定に保つためゲームオーバーにしない）。
- `+` / `-`（テンキー +/- も可）: **同時ボール数を ±5**（下限1・上限500）。初期3個。

## ルール / 数値（全エンジン共通）
- ボール: 半径8・速さ380px/s（一定）。発射は上方向 ±60°。下端を抜けたら `Lost` をカウントしパドル上から再発射。
- ブロック: **15列 × 9行 = 135個**（56×20 + 間隔4、上オフセット60）。上3行=HP3(赤) / 中3行=HP2(橙) / 下3行=HP1(緑)。HP0 で破壊し Score +10、`hit_spark` を一瞬表示。
- 当たり判定は **AABB(矩形) × 円(最近点)**。重なりの浅い軸で反射面を決め、左右面=vx反転 / 上下面=vy反転。1ボール1フレーム1ブロックまで。反射後は速さを 380 に正規化。
- 全ブロック破壊で盤面を再生成（ベンチ継続）。
- **ボール同士の衝突は行わない**（性能・簡潔さのため省略）。物理エンジンは不使用。

## 実装メモ（設計判断つき）
- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に `<a-scene>` として宣言**し、ゲーム本体は登録した **`breakout-game` コンポーネント**が駆動（A-Frame の renderer / `tick` ループ / カメラ管理を利用）。
- **設計判断（重要）**: ボール・ブロックは数百規模になり得る。「1個 = 1 `<a-entity>`」だと DOM/コンポーネント生成コストで FPS が破綻するため、**動的オブジェクトはコンポーネント内で `THREE.Sprite` を直接生成・管理**する（`this.el.object3D` に add）。これは A-Frame で大量2Dオブジェクトを扱う際の現実的な定石。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0,W,H,0,-1000,1000)`** に維持（A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく `worldY = H - gameY` 変換。スプライトは中心基準なのでブロックは左上→中心へオフセット。
- ブロックの HP 色は `SpriteMaterial.color` を明色テクスチャに乗算（tint）して表現。
- `renderer.setPixelRatio(1)` で性能比較の DPR を 1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。
- アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形 → `CanvasTexture`。当たり判定は SPEC 準拠の自前 AABB×円。HUD は HTML オーバーレイに FPS / Objects(=ball+brick+fx) / Score / Balls(現在/設定) / Bricks / Lost を表示。

## Codex / AI コーディング所感
- **HTML 宣言的**なのでシーンの骨格は AI が書きやすい。VR/3D の entity 配置サンプルは豊富。
- 罠は **「宣言的フレームワークで非宣言的な 2D アーケードを書く」**ミスマッチ: ① 大量オブジェクトを素直に `<a-entity>` で作ると破綻（上記のとおり THREE 直管理が必要）。② 2D 用 ortho カメラは A-Frame に既定がなく、`sceneEl.camera` 差し替えという定石を知らないと AI は perspective のまま実装しがち。③ `tick(time, dtMs)` の dt が **ms 単位**。AI を素直に走らせると「各ボール/ブロックを a-entity 化」して FPS を落としやすいので、**THREE 直描画の方針を明示指示**するのが鍵。
