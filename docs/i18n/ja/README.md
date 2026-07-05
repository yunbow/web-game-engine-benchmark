# Web Game Engine Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../../LICENSE)

OSS の Web ゲームエンジン / 3D ライブラリを、**同一仕様のミニゲームを全エンジンで実装して横並び比較**するベンチマーク集。

- **2D: 13テーマ × 7エンジン = 91本**（Phaser 4 / PixiJS v8 / Babylon.js / LittleJS / three.js / KAPLAY / A-Frame）
- **3D: 10テーマ × 4ライブラリ = 40本**（three.js / Babylon.js / PlayCanvas / A-Frame）

各テーマは「比較したい負荷軸」を1つだけ分離する設計（例: 描画スループット / 剛体物理 / GPUパーティクル / 深度ソート / 動的テクスチャ転送 …）。全実装が同じ仕様（`SPEC.md`）・同じ操作・同じHUDを持ち、`+` / `-` キーで負荷を増減して挙動とFPSを比較できる。

## 🎮 デモを遊ぶ（GitHub Pages）

**▶ デモポータル: <https://yunbow.github.io/web-game-engine-benchmark/demo/>**

全131本への入口。2D/3Dタブからテーマ×エンジンを選んで起動できる。

- 個別デモのURL例: [`demo/2d/01/Phaser4/`](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/01/Phaser4/index.html)（弾幕STG・Phaser 4版）
- 自動FPS計測: [2D ベンチハーネス](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D ベンチハーネス](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html)

> 画像アセット未配置でも全ゲームは単色図形フォールバックで起動する。

## テーマ一覧

### 2D（13テーマ × 7エンジン）

| # | ジャンル | 比較の主軸（`+`/`-` で増減する負荷） |
|---|---|---|
| 01 | 弾幕STG（縦シューティング） | 描画スループット（弾・敵の物量） |
| 02 | トップダウン・サバイバー | 大量エンティティの更新＋自前衝突 |
| 03 | トップダウンRPG探索 | 大マップ描画＋可視範囲カリング |
| 04 | ブロック崩し（マルチボール） | 多ボール×多ブロックの衝突解決 |
| 05 | 横スクロールアクション | 横長マップ描画＋重力/AABB物理 |
| 06 | タワーディフェンス | 経路探索(A*)＋多数ユニット追従 |
| 07 | 物理パズル（投擲物理） | 剛体物理エンジン統合と剛体数スケール |
| 08 | パーティクル/魔法エフェクト | GPU/パーティクル機構＋加算ブレンド |
| 09 | アイソメトリック都市/農場 | 深度ソート(z-order)＋タイル奥行き描画 |
| 10 | マッチ3パズル | ロジック主体・軽描画×大量トゥイーン |
| 11 | 2Dダイナミックライティング/影 | 多光源＋ライトマップ合成＋影生成 |
| 12 | フォーリングサンド/セルオートマトン | 格子セル更新＋毎フレーム全面テクスチャ書換 |
| 13 | 大量テキスト/UI描画 | 多数の動的テキスト＋グリフ再描画 |

### 3D（10テーマ × 4ライブラリ）

| # | テーマ | 比較の主軸（`+`/`-`） |
|---|---|---|
| 01 | インスタンス小惑星フィールド（3D STG） | 同一メッシュの大量インスタンス描画（最大50,000） |
| 02 | 箱タワー崩し（3D剛体物理） | 物理エンジン統合（Rapier/Havok/ammo）＋剛体数 |
| 03 | スキンドキャラ大群（glTF） | スキニング/スケルタルアニメ再生スループット |
| 04 | GPUパーティクル（魔法/噴水） | 粒子機構スループット＋加算発光（最大50万） |
| 05 | 広域地形カリング/LOD | 視錐台カリング＋距離LOD（描画距離） |
| 06 | 動的シャドウ光源 | リアルタイム影マップ枚数 |
| 07 | ボクセルチャンク再生成 | 毎フレームの頂点バッファ再構築/再アップロード |
| 08 | PBR + ポストプロセス(Bloom) | PBRシェーディング＋Bloom合成 |
| 09 | 3Dナビ群衆(A*) | グリッドA*経路探索＋多数追従 |
| 10 | 大量レイキャスト(LIDAR) | 毎フレームのレイ-メッシュ交差 |

バックエンド差を排除するため 3D は**全ライブラリ WebGL2 固定**（WebGPU不使用）。

## 📊 パフォーマンス計測（`_bench`）

`demo/2d/_bench/` と `demo/3d/_bench/` に**自動FPS計測ハーネス**を同梱。各ゲームを iframe で順次起動し、iframe 内の `requestAnimationFrame` をハーネスが直接カウントして FPS を実測する（ゲーム側は無改変・HUD表示に依存しない）。

- 負荷制御: 合成キーイベントで `+` を送り、負荷レベル `0 / 10 / 25` を全エンジン統一で適用
- 計測サイクル: 起動待ち 3.5s → 整定 1.5s → サンプリング 8s
- 出力CSV: `theme, engine, level, fps_avg, fps_1pct_low, objects, transferKB, initMs, frames, error`
  - `fps_1pct_low` = フレーム時間99パーセンタイルから算出した1%ロー（カクつき指標）
  - `transferKB` / `initMs` = 初期転送量・DOMContentLoaded までの時間

計測はブラウザで [2Dハーネス](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3Dハーネス](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html) を開いて実行（**Chrome推奨・計測中はタブを前面のまま**。背面タブは rAF が絞られ無効）。結果はCSVでダウンロードされる。

### 計測結果

> 📝 準備中 — 統一環境での全巡回計測後、ここに テーマ×エンジン の FPS 実測表（計測環境併記）を掲載する。

## ローカルでの実行

画像読込のため `file://` 直開きは不可（CORS）。`demo/` をルートに HTTP サーバを立てる:

```bash
cd demo
python -m http.server 8000
# → http://localhost:8000/            （ポータル）
# → http://localhost:8000/2d/01/Phaser4/   （個別デモ）
```

ベンチハーネスをローカルで回す場合は、2D は `demo/2d/`、3D は `demo/3d/` をルートに配信して `_bench/` を開く。

## ディレクトリ構成

```
├─ demo/
│  ├─ index.html        … デモポータル（全131本への入口）
│  ├─ 2d/
│  │  ├─ 01/ … 13/      … 2Dテーマ（各テーマ同型）
│  │  │  ├─ SPEC.md     … 全エンジン共通仕様（数値・ルールの唯一の正）
│  │  │  ├─ assets/     … 画像アセット（gptimage2生成）
│  │  │  ├─ Phaser4/    … index.html + game.js + README.md
│  │  │  ├─ PixiJS/  Babylon.js/  LittleJS/  three.js/  KAPLAY/  A-Frame/
│  │  └─ _bench/        … 2D自動FPS計測ハーネス
│  └─ 3d/
│     ├─ 01/ … 10/      … 3Dテーマ（three.js / Babylon.js / PlayCanvas / A-Frame）
│     └─ _bench/        … 3D自動FPS計測ハーネス
├─ docs/                … エンジン選定・テーマ設計の調査メモ
│  ├─ IMAGE_PROMPTS.md  … 画像アセット生成プロンプト集（gptimage2用）
│  └─ i18n/             … README多言語版（ja / zh-CN / ko / es）
└─ README.md
```

各エンジンフォルダの `README.md` に**起動方法・使用バージョン・実装メモ・AIコーディング所感**を記載。

## 全実装が守る共通仕様

- **`SPEC.md` が唯一の正**: 速度・HP・スポーン上限・当たり判定方式などの数値は同テーマ全エンジンで完全一致
- **共通HUD**: 画面左上に `FPS`（移動平均）/ `Objects` / `Score` / `HP` / 現在の負荷設定値
- **`+` / `-` キーで負荷増減**（テーマごとに主役の負荷軸が異なる）
- **画像欠落時は単色図形フォールバックで必ず起動**
- **物理エンジンは原則自前実装**（例外は 2d/07・3d/02 = 物理エンジン統合自体が比較対象）
- **決定的生成（`Math.random` 不使用）** — オートプレイで無人ベンチ可能

## 実装から得た知見（抜粋）

### 性能設計の共通定石（全エンジンで効いた最適化）

- **自前の円判定（平方距離比較）** — 大量当たり判定の決定打
- **オブジェクトプール再利用**（生成/破棄ゼロ化） — サバイバー系で数百〜千体に到達
- **可視範囲のみ描画（カリング）** — 100×100マップを実描画 ~600タイルに圧縮
- **軸分離AABB＋面ごと反射** — 多ボール衝突・横スクロール地形を物理エンジン無しで安定処理
- いずれも「AIに明示指示しないと省略されがち」な点が共通

### AIコーディング相性（★多いほど書きやすい）

| エンジン | 相性 | 要点 |
|---|---|---|
| **Phaser 4** | ★★★★★ | API安定・Phaser 3知識が流用可。大量最適化はプール化/物理不使用の明示指示が必要 |
| **PixiJS v8** | ★★★★☆ | ロジックは素のJS同然。最大の罠は**v8破壊的変更**（`await app.init()`・`app.canvas`・新Graphics API）で、v8明示が成功の鍵 |
| **LittleJS** | ★★★☆☆ | 単一CDN・全体把握が容易。ESM/classic取り違え・Y軸上向き・WebGL層とHUDの重なりに注意 |
| **Babylon.js** | ★★★☆☆ | 3Dエンジンで2Dを書く際の**座標系初期設定**（y上/原点中央）が最難所。SpriteManagerのバッチは大量スプライトに強い |

three.js / KAPLAY / A-Frame / PlayCanvas の所感は各エンジンフォルダの `README.md` を参照。

## 画像アセットについて

素材は [`IMAGE_PROMPTS.md`](../../IMAGE_PROMPTS.md) のプロンプトを画像生成AI（gptimage2）に投入して作成し、各テーマの `assets/` に配置している。画像が無くても全ゲームは図形フォールバックで起動するため、ロジック比較 → 後から画像差し替えが可能。

## 関連調査メモ

- [`docs/game-engine-oss-codex-research.md`](../../game-engine-oss-codex-research.md) — エンジン選定の前提調査（ライセンス・AI相性・性能の比較）
- [`docs/3d-engine-theme-research.md`](../../3d-engine-theme-research.md) — 3D版ベンチのライブラリ候補×比較テーマ調査

## ライセンス

[MIT](../../../LICENSE)

## コントリビューション

詳細は [CONTRIBUTING.md](../../../CONTRIBUTING.md) を参照。

---

Languages: [English](../../../README.md) | 日本語 | [简体中文](../zh-CN/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md)
