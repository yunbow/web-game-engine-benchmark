# マッチ3パズル — A-Frame 版

テーマ10共通仕様（マッチ3パズル・ロジック主体＋大量トゥイーン・性能比較用）の
**A-Frame** 実装。NxN 盤面の宝石を隣と入れ替え、3つ以上揃うと消え、上から落ちて
補充され連鎖する。描画は軽いが、**マッチ判定・連鎖・状態管理のロジック**と
**落下/消滅で同時多発するセル単位トゥイーン**が主役の性能比較デモ。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`10/`)をルートに HTTP サーバを立てて開く。

```bash
cd 10
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- クリック2回: 隣接2セルを選択して手動スワップ（隣接のみ有効。マッチしなければ自動で元に戻る）
- `Space`: オートプレイ切替（初期 **ON**）
- `+` / `-`（テンキー +/- も可）: 盤面サイズ N を ±2（初期12・下限6・上限40）
- `R`: 盤面リセット（決定的に再生成。スコア・手数もリセット）

## 仕様数値（全エンジン共通）
- キャンバス **960×540**（固定）、盤面は中央の正方領域。セル1辺 = `floor(min(520/N, 56))` px。
- 宝石 **6種**。初期盤面・補充・シャッフルはすべて固定シード `mulberry32` で**決定的生成**（`Math.random` 不使用）。
- 状態機械 **IDLE / SWAP(0.15s) / CLEAR(0.2s, 縮小+フェード) / FALL(0.2s/セル)**。
- `Score += 消去数 × 10 × 連鎖係数`（連鎖段数）。

## 使用したトゥイーン機構（裏テーマ）
- A-Frame には宣言的な **`animation` コンポーネント**があるが、これは **entity 単位**で
  動かす仕組みで、本テーマの「数百〜千本のセル単位トゥイーン」には不向き（1セル=1entity
  にすると DOM/コンポーネント生成で破綻する）。
- そこで three.js 版と**完全に同一の自前マネージャ `makeTweenManager`** をコンポーネント内に
  実装。進行中トゥイーンを配列で保持し、毎フレーム `tick` の `dt` でイージング補間する
  （`{ target, props:{from,to}, dur, ease, onComplete }`）。トゥイーンは論理 gem の
  `{x, y, size, alpha}` を動かし、毎フレーム末にそれを `THREE.Sprite` へ反映。
  Pixi/Babylon/LittleJS/three.js と同一機構で条件を揃えてある。
  HUD の `Active tweens` がマネージャの保持本数＝負荷指標。
- イージング: スワップ=`easeOutQuad` / 消滅・落下=`easeInQuad`（three.js 版とタイミング一致）。

## 実装メモ（設計判断つき）
- A-Frame は three.js 上の宣言的（entity-component）フレームワーク。**シーンは `index.html` に
  `<a-scene>` として宣言**し、ゲーム本体は登録した **`match3-game` コンポーネント**が `tick` で駆動。
- **設計判断（重要）**: 盤面は最大 40x40 = 1600 セル。「1セル = 1 `<a-entity>`」だと DOM/
  コンポーネント生成コストで FPS が破綻するため、**宝石はコンポーネント内で `THREE.Sprite` を
  直接生成・プールして再利用**する（`this.el.object3D` に add）。これは A-Frame で大量2Dオブジェクトを
  扱う際の現実的な定石。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0, W, H, 0, -1000, 1000)`** に維持
  （A-Frame の既定パースペクティブカメラを上書き）。座標は three.js 版と同じく `worldY = H - gameY` 変換。
- `renderer.setPixelRatio(1)` で DPR を 1 固定。`<a-scene>` は `embedded`・`vr-mode-ui:false`。
- アセットは `TextureLoader` を個別ハンドラ、失敗時は canvas 図形 → `CanvasTexture` フォールバック。
  マッチ判定/落下/補充/オートプレイのロジックは three.js 版と厳密一致（決定的）。
- `tick(time, dtMs)` の `dt` は **ms 単位**（上限 50ms にクランプしてタブ復帰時の暴発を抑制）。
- HUD は HTML オーバーレイ（`#hud`）に FPS / Board / Active tweens / State / Chain / Score / Moves / Auto を表示。

## Codex / AI コーディング所感
- **HTML 宣言的**なのでシーンの骨格は AI が書きやすいが、本テーマは**宣言的フレームワークで
  非宣言的な「ロジック主体＋大量トゥイーン」を書く**ミスマッチが罠。
- 具体的な罠: ① 大量セルを素直に `<a-entity>` で作ると破綻（上記のとおり THREE 直管理＋プールが必要）。
  ② 2D 用 ortho カメラは A-Frame に既定がなく、`sceneEl.camera` 差し替えという定石を知らないと
  perspective のまま実装しがち。③ `tick(time, dtMs)` の dt が **ms 単位**。④ 組込み `animation` に
  頼ると entity 単位で大量トゥイーンが破綻するため、**自前マネージャ前提**を明示指示する必要がある。
  ⑤ N=40（≒1600 セル）では落下時の同時トゥイーンが数百本、マッチ走査 O(N²) と合わせて破綻点が出る。
