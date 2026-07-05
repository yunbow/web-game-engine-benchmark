# 弾幕STG — KAPLAY 版

テーマ1共通仕様（縦スクロール弾幕STG・性能比較用）の **KAPLAY** 実装。
画像アセットが無くても単色図形フォールバックで必ず起動します。

使用バージョン: **KAPLAY 3001.0.19**（CDN: `unpkg.com/kaplay@3001.0.19/dist/kaplay.js`）。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`1/`)をルートに HTTP サーバを立てて開く。

```bash
cd 1
python -m http.server 8000
# → http://localhost:8000/KAPLAY/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- 移動: 矢印キー / WASD（8方向・画面内クランプ）
- 発射: オート連射（150ms ごと、上方向 600px/s）
- `+` / `-`（テンキー +/- も可）: 同時最大敵数を ±10（上限300）

## 実装メモ
- `kaplay({ canvas, width:960, height:540, global:false })` で初期化。名前空間 `k.*` を明示利用。
- KAPLAY の座標系は **Y 下向き・原点左上 = 画面座標と一致**するため、座標変換が不要（three/Babylon と違い最も素直）。
- 描画・ループ・入力は KAPLAY 機構（`add([...comps])` / `onUpdate` / `dt()` / `isKeyDown` / `onKeyPress`）。
- **当たり判定は SPEC 準拠の自前円判定（平方距離比較）**。KAPLAY の `area()` は AABB/多角形なので、他エンジンと負荷条件を揃えるため不使用。
- アセットは `loadSprite` を個別 try/catch し、失敗したものだけ図形コンポーネント（`circle`/`rect`/`polygon` + `color`）にフォールバック。
- HUD は他エンジンと同じ HTML オーバーレイ（`#hud`）に FPS / Objects / Score / HP / 最大敵数を表示。

## Codex / AI コーディング所感
- ミニマル API で「シーン構築〜ループ〜入力」を**一発生成しやすい**。LLM 訓練データも Kaboom 時代から一定量あり、素直に書ける部類。
- 罠: ① 旧 **Kaboom** との API 差（`kaplay()` 名称・コンポーネント名）で記憶が混ざる。② キー名が独自（`"left"`, `"kpadd"`, `"minus"`）で `e.code` ではない。③ `area()`/`onCollide` を使うと当たり判定方式が他エンジンと変わり比較がブレるため、本実装では意図的に自前円判定にした点は明示指示が要る。
