# 大量動的テキスト / UI描画 — A-Frame 版

テーマ13共通仕様（大量テキスト・動的グリフ描画の性能比較用）の **A-Frame** 実装。
外部フォントアセットは不要で、システム/既定フォントだけで必ず起動します。

使用バージョン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）。内部 three.js は `AFRAME.THREE`。

## 起動方法
ESM ではないので `file://` 直開きでも動きますが、他エンジンと揃えるなら
テーマフォルダ(`13/`)をルートに HTTP サーバを立てて開くのが確実です。

```bash
cd 13
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```

## 操作
- `+` / `-`（テンキー +/- も可）: テキストアイテム数を ±100（下限0 / 上限5000、初期200）
- `U`: 動的更新 ON/OFF（ON=毎フレーム全アイテムの文字列を作り直す / OFF=位置のみ動かす）
- `B`: テキスト機構の切替（CanvasTexture(fillText) ⇄ GlyphAtlas(drawImage)）
- `R`: リセット

## 使ったテキスト機構と崩れ始める点（テーマ13の核）
**A-Frame ＝ three.js なので「ネイティブのテキスト」が無い**、が肝。

- A-Frame 標準の `<a-text>` は SDF フォント1枚を共有する。しかし **「1ラベル = 1 `<a-text>` エンティティ」を N=数千個並べると DOM/コンポーネント/メッシュ生成で破綻**する（テーマ1の「1弾=1エンティティ」と同じ崖）。スケールしないため本テーマでは採用しない。
- そこで `../three.js/game.js` と**全く同じテキスト機構をミラー**し、両方を `B` で切替えて崖を比較する。最終的に**全テキストを 1枚の `CanvasTexture` に焼き、正射影 quad 1枚に貼って毎フレーム1回だけ GPU アップロード**する点は共通:
  1. **CanvasTexture 方式（既定 / B=OFF）＝ Canvas Text 相当**: 960x540 のオフスクリーン 2D canvas に毎フレーム `ctx.fillText` を **N 回**叩いて全テキストを描く。崖は **「fillText を N 回ラスタライズ + テクスチャ全面再アップロード」**。Update ON では N が増えるほど急激に重くなる。
  2. **GlyphAtlas 方式（B=ON）＝ BitmapText 相当**: ASCII 可視グリフ(32〜126)を1枚のアトラスへ**初回1回だけ**ベイク。各文字は `drawImage` でアトラス矩形を 2D canvas にブリットするだけで、フォントのラスタライズは初回のみ。`.text` 変更コストが桁違いに小さく、崖を大きく後ろへ倒せる（CanvasTexture の再アップロードは残るので完全には消えない）。
- **崩れ始める目安**: CanvasTexture(fillText) は Update=dynamic で N≈1000〜1500 あたりから fillText のラスタライズが支配的になり FPS が落ち始める。GlyphAtlas はブリットが軽く N=5000 でも CanvasTexture 方式より明確に有利。Update=static にすると（毎フレーム文字列を作り直さないので）どちらも軽くなるが、本方式は canvas を毎フレーム描き直すため three.js 同様に完全キャッシュは効かない。

## 実装メモ（設計判断つき）
- シーンは `index.html` に `<a-scene embedded vr-mode-ui="enabled:false" ...>` として宣言し、ゲーム本体は登録した **`textui-game` コンポーネント**が `tick` で全駆動（描画・ループ・入力・HUD）。
- 2D 化のため `tick` で `sceneEl.camera` を **`OrthographicCamera(0, W, H, 0, -1000, 1000)`** に維持（A-Frame の既定 perspective カメラを上書き）。`renderer.setPixelRatio(1)` で DPR を 1 固定。
- quad は中央 `(W/2, H/2)` に置き、テクスチャは `flipY=false` で 2D canvas(y-down) の上下を quad uv に合わせる。`NearestFilter` / `generateMipmaps=false`。
- 乱数は決定的 **mulberry32（固定シード 20250613）**のみ。`Math.random` 不使用。初期位置・速度・色・サイズ・基準番号はすべて決定的に割当 → 無入力でも同じ流れを再現。
- 文字列は `"OBJ#0042 v=137"` 風（8〜20 文字）。数値部 `v` は `frame` と `i` から決定的に算出し、Update ON で毎フレーム変わる。
- HUD は他エンジンと同一の HTML オーバーレイ（`#hud` / `#help`）。FPS（移動平均）/ Texts（現在/上限）/ Chars（概算総グリフ数）/ Render（使った機構）/ Update（dynamic/static）を表示。
- 本テーマはアセット不要（`assets/.gitkeep` のみ）。外部ビットマップフォントは使わず、GlyphAtlas もシステム monospace から動的ベイクする。

## Codex / AI コーディング所感
- A-Frame は宣言的フレームワークなので、AI は素直に書くと **テキストを `<a-text>` で1ラベルずつ並べてしまい**、本テーマの「大量・動的」要件で即破綻する。**「テキストは canvas → CanvasTexture に焼く」方針を明示指示**するのが鍵（three.js 版と同じワークアラウンド）。
- 2D 用 ortho カメラは A-Frame に既定がなく、`sceneEl.camera` 差し替え＋`tick` 維持という定石を知らないと perspective のまま実装しがち。`tick(time, dtMs)` の dt が **ms 単位**な点も three.js の `Clock`(秒) と混同しやすい。
- GlyphAtlas は概念自体（事前ベイク→ブリット）は AI も書けるが、等幅の進み幅やセル寸法など「見た目を合わせる」係数は試行が要る。本実装は three.js 版と数値を完全一致させて比較条件を揃えている。
