# マッチ3パズル — three.js 版

テーマ10共通仕様（マッチ3パズル・ロジック主体＋大量トゥイーン・性能比較用）の
**three.js** 実装。NxN 盤面の宝石を隣と入れ替え、3つ以上揃うと消え、上から落ちて
補充され連鎖する。描画は軽いが、**マッチ判定・連鎖・状態管理のロジック**と
**落下/消滅で同時多発するセル単位トゥイーン**が主役の性能比較デモ。
画像アセットが無くても単色図形（canvas）フォールバックで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`10/`)をルートに HTTP サーバを立てて開く。
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**（モジュール/CORS）。

```bash
cd 10
python -m http.server 8000
# → http://localhost:8000/three.js/
```

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
- three.js には**組込みトゥイーンが無い**（公式は別パッケージ `three/addons` の tween 等）。
- **本実装では自前マネージャ `makeTweenManager` を実装**。進行中トゥイーンを配列で保持し、
  毎フレーム `dt` でイージング補間（`{ target, props:{from,to}, dur, ease, onComplete }`）。
  トゥイーンは論理 gem の `{x, y, size, alpha}` を動かし、毎フレーム末にそれを `THREE.Sprite`
  へ反映する。Pixi/Babylon/LittleJS/A-Frame と同一機構で条件を揃えてある。
  HUD の `Active tweens` がマネージャの保持本数＝負荷指標。
- イージング: スワップ=`easeOutQuad` / 消滅・落下=`easeInQuad`。

## 実装メモ
- three.js は 3D 描画ライブラリ。2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px、原点左下・Y上向き）。
- ゲームロジックは**画面座標（Y 下向き）のまま**保持し、描画同期時のみ `worldY = H - gameY` に変換。
- 宝石は **`THREE.Sprite`**（常にカメラを向く板）。重ね順は `renderOrder`（board < sel < gem）、`depthTest:false`。
- 盤面は最大 1600 セル → スプライトを**プールして再利用**（毎フレーム再生成しない）。`renderer.setPixelRatio(1)` で DPR を 1 固定。
- アセットは `TextureLoader.loadAsync` を個別 try/catch、失敗時は 2D canvas に図形を描いて `CanvasTexture` 化。
- ループは `renderer.setAnimationLoop` + `THREE.Clock`（`dt` 上限 0.05s でタブ復帰時の暴発を抑制）。
- HUD は HTML オーバーレイ（`#hud`）に FPS / Board / Active tweens / State / Chain / Score / Moves / Auto を表示。

## Codex / AI コーディング所感
- 訓練データは最大級で three.js API は AI が安定して書ける。スプライト+ortho の 2D 化も定石化している。
- 罠: ① ortho カメラの引数順と Y 向き（素直に書くと上下反転）。② r150 前後以降の **ESM / importmap 必須**。
  ③ 組込みトゥイーンが無いので**自前マネージャ前提**を明示指示しないと別パッケージに流れやすい。
  ④ N=40（≒1600 セル）では落下時の同時トゥイーンが数百本、マッチ走査 O(N²) と合わせて破綻点が出る。
