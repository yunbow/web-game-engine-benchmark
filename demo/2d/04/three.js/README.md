# ブロック崩し(マルチボール) — three.js 版

テーマ4共通仕様（ブロック崩し・マルチボール・性能比較用）の **three.js** 実装。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`4/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 4
python -m http.server 8000
# → http://localhost:8000/three.js/
```

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

## 実装メモ
- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、原点左下・Y上向き）。
- ゲームロジックは**画面座標（Y 下向き・他エンジンと同一定数）のまま**保持し、描画同期時のみ `worldY = H - gameY` に変換。スプライトは中心基準なので、ブロックは左上(x,y)から中心へオフセットして配置。
- スプライトは **`THREE.Sprite`**。重ね順は `renderOrder`（bg<brick<ball<fx<paddle）、`depthTest:false` で z-fight 回避。ブロックの HP 色は `SpriteMaterial.color` を明色テクスチャに乗算（tint）して表現。
- アセットは `TextureLoader.loadAsync` を個別 try/catch。失敗時は 2D canvas に図形を描いて `CanvasTexture` 化（`NearestFilter`）。
- ループは `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発を抑制）。
- 当たり判定は SPEC 準拠の自前 **AABB×円（最近点）**。HUD は HTML オーバーレイに FPS / Objects(=ball+brick+fx) / Score / Balls(現在/設定) / Bricks / Lost を表示。

## Codex / AI コーディング所感
- 訓練データは最大級で、three.js 自体の API は AI が安定して書ける。3D の素直なサンプルは特に強い。
- 罠は **「2D ゲームとしての足場」**: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転・カリング欠落）。② r150 前後以降の **ESM 化 / importmap 必須**（旧 `THREE.` UMD グローバル前提のコードを書きがち）。③ 大量スプライトでは `material`/`texture` の `dispose()` を怠るとリーク。④ `THREE.Sprite` が中心基準なので、矩形(左上基準)のブロックは中心オフセット変換を忘れると配置がずれる。これらを明示しないと AI は古い書き方に流れやすい。
