# 大量動的テキスト / UI描画 — three.js 版

テーマ13共通仕様（大量テキスト・動的グリフ描画の性能比較用）の **three.js** 実装。
外部フォントアセットは不要で、システム/既定フォントだけで必ず起動します。

使用バージョン: **three.js r184**（CDN: `unpkg.com/three@0.184.0/build/three.module.js`、importmap で `three` を解決）。レンダラは **WebGLRenderer**。

## 起動方法
**ESM（importmap + `<script type="module">`）なので `file://` 直開きは不可**。
テーマフォルダ(`13/`)をルートに HTTP サーバを立てて開く。

```bash
cd 13
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- `+` / `-`（テンキー +/- も可）: テキストアイテム数を ±100（下限0 / 上限5000、初期200）
- `U`: 動的更新 ON/OFF（ON=毎フレーム全アイテムの文字列を作り直す / OFF=位置のみ動かす）
- `B`: テキスト機構の切替（CanvasTexture(fillText) ⇄ GlyphAtlas(drawImage)）
- `R`: リセット

## 使ったテキスト機構と崩れ始める点（テーマ13の核）
**three.js には「ネイティブのテキスト」が無い ＝ ワークアラウンドが必須**、が肝。three.js は 3D 描画ライブラリで、文字列を直接描く API を持たない（troika-three-text 等の外部依存は本プロジェクトが使っていないため導入しない）。そこで PIXI.Text の「Canvas でラスタライズ → テクスチャ化」の発想を 2 経路で実装し、`B` で切替えて崖を比較する。**全テキストを 1枚の `CanvasTexture` に焼き、画面いっぱいの正射影 quad に貼って毎フレーム1回だけ GPU アップロード**する点は共通:

1. **CanvasTexture 方式（既定 / B=OFF）＝ Canvas Text(PIXI.Text) 相当**: 960x540 のオフスクリーン 2D canvas に毎フレーム `ctx.fillText` を **N 回**叩いて全テキストを描く。崖は **「fillText を N 回ラスタライズ + テクスチャ全面再アップロード」**。Update ON で N が増えるほど急激に重くなる。
2. **GlyphAtlas 方式（B=ON）＝ BitmapText 相当**: ASCII 可視グリフ(32〜126)を1枚のアトラスへ**初回1回だけ**ベイク。各文字は `drawImage` でアトラス矩形を 2D canvas にブリットするだけで、フォントのラスタライズは初回のみ。`.text` 変更コストが桁違いに小さく、崖を後ろへ倒せる（CanvasTexture の再アップロードは残るので完全には消えない）。

**崩れ始める目安**: CanvasTexture(fillText) は Update=dynamic で N≈1000〜1500 から fillText のラスタライズが支配的になり FPS が落ち始める。GlyphAtlas はブリットが軽く N=5000 でも明確に有利。canvas を毎フレーム描き直すため、Update=static でも完全キャッシュは効かない（位置が動くので毎フレーム再描画が要る）。

## 実装メモ
- 2D 化の肝は **`OrthographicCamera(0, W, H, 0, -1000, 1000)`**（1ワールド単位=1px）。テキストを焼く quad は中央 `(W/2, H/2)` に置く。
- テクスチャは `flipY=false` で 2D canvas(y-down) の上下を `PlaneGeometry` の uv（左下原点）に合わせる。`NearestFilter` / `generateMipmaps=false`。
- `renderer.setPixelRatio(1)` で性能比較の DPR を 1 固定。`renderer.setAnimationLoop` + `THREE.Clock`（dt 上限 0.05s でタブ復帰時の暴発を抑制）。
- 乱数は決定的 **mulberry32（固定シード 20250613）**のみ。`Math.random` 不使用。位置・速度・色・サイズ・基準番号を決定的に割当 → 無入力でも同じ流れを再現。
- 文字列は `"OBJ#0042 v=137"` 風（8〜20 文字）。数値部 `v` は `frame` と `i` から決定的に算出し、Update ON で毎フレーム変わる。GlyphAtlas はパレット8色 + 統計パネル色ぶんを事前ベイク。
- HUD は他エンジンと同一の HTML オーバーレイ（`#hud` / `#help`）。FPS / Texts / Chars / Render / Update を表示。
- 本テーマはアセット不要（`assets/.gitkeep` のみ）。外部ビットマップフォントは使わず、GlyphAtlas もシステム monospace から動的ベイクする。

## Codex / AI コーディング所感
- 訓練データは最大級で API 自体は安定して書けるが、**「テキストをどう出すか」は three.js 最大の罠**。AI は素直に `<canvas>` 別レイヤや DOM テキストへ逃げたり、troika 等の外部依存を引きたがる。本プロジェクトの方針（**canvas → CanvasTexture を1枚の quad に貼る**）を明示しないと比較条件が揃わない。
- ortho カメラの引数順・Y 向き（上下反転）、r150 以降の **ESM/importmap 必須**、`CanvasTexture` の `flipY`/`needsUpdate`/`colorSpace` まわりは AI が古い書き方に流れやすい。GlyphAtlas（事前ベイク→ブリット）は概念は書けるが、等幅の進み幅やセル寸法など見た目合わせの係数は試行が要る。
