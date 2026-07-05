# 2D/3Dゲームエンジン OSS調査 ― ブラウザ実行 × Codexコーディング × 画像生成 相性評価

---

## 1. 調査基準

| # | 基準 | 内容 |
|---|---|---|
| 1 | **2D/3Dゲームエンジン** | ノーコードは問わない（コードベースでも可） |
| 2 | **ブラウザ実行** | Webネイティブ動作、またはWebAssembly等でWeb書き出し可 |
| 3 | **完全OSS** | MIT / Apache-2.0 / BSD / (L)GPL など自由に利用・改変・再配布可能 |
| 4 | **Codexコーディング相性**（追加） | OpenAI Codex / Claude Code 等のAIコーディングエージェントでコード生成・改修しやすいか |
| 5 | **画像生成との相性**（追加） | AI画像生成（Stable Diffusion / DALL·E / Midjourney等）で作った素材を取り込みやすいか |

### 評価軸4「Codex相性」の判断ポイント
- **言語の学習データ量**: JS/TS は最大手LLMの訓練データに豊富。Rust/Go/GDScriptは相対的に少ない。
- **コードファースト**かGUI依存か（エージェントはテキストでプロジェクト全体を生成・編集できる方が有利）。
- **API安定性・ドキュメント量・コミュニティ規模**。
- テキストベースのシーン/アセット形式（LLMが直接編集できる）。

### 評価軸5「画像生成相性」の判断ポイント
- **2Dスプライト/タイル/テクスチャ**はAI画像生成と直結（PNG出力→即利用）。透過背景・固定サイズ(32x32等)指定で扱いやすい。
- **3Dはモデルが必要**なため画像生成だけでは完結しにくい（ただしテクスチャ、スカイボックス、HD-2D風ビルボードには有効）。
- → 一般に **2Dエンジンほど画像生成と好相性**。

---

## 2. 総合評価マトリクス

凡例: ◎=非常に良い / ○=良い / △=条件付き / ×=不可・弱い

| エンジン | 種別 | ブラウザ | ライセンス | Codex相性 | 画像生成相性 | 総合 |
|---|---|---|---|---|---|---|
| **Phaser 4** | 2D | ◎ ネイティブ | ◎ MIT | ◎ 最有力(LLM訓練データ豊富) | ◎ スプライト/タイル直結 | ★★★★★ |
| **Babylon.js** | 3D | ◎ ネイティブ | ◎ Apache-2.0 | ◎ ドキュ厚い/全部入り | ○ テクスチャ/HD-2D | ★★★★☆ |
| **three.js** | 3D(描画ライブラリ) | ◎ ネイティブ | ◎ MIT | ◎ 訓練データ最大級 | ○ テクスチャ/billboard | ★★★★☆ |
| **A-Frame** | 3D/VR | ◎ ネイティブ(HTML宣言的) | ◎ MIT | ◎ HTMLでLLM編集容易 | ○ テクスチャ/パネル | ★★★★☆ |
| **PixiJS** | 2D(描画) | ◎ ネイティブ | ◎ MIT | ○ 描画特化(ゲーム機能は自作) | ◎ スプライト直結 | ★★★☆☆ |
| **KAPLAY (旧Kaboom)** | 2D | ◎ ネイティブ | ◎ MIT | ◎ シンプルAPIでLLM向き | ◎ スプライト直結 | ★★★★☆ |
| **Excalibur.js** | 2D | ◎ ネイティブ | ◎ BSD | ○ TS型でAI補完◎ | ◎ スプライト直結 | ★★★☆☆ |
| **LittleJS** | 2D | ◎ ネイティブ | ◎ MIT | ○ 単一ファイルで文脈収まる | ◎ スプライト直結 | ★★★☆☆ |
| **melonJS** | 2D | ◎ ネイティブ | ◎ MIT | ○ Tiled連携 | ◎ スプライト/タイル | ★★★☆☆ |
| **Godot** | 2D/3D | ○ WASM書き出し | ◎ MIT | △ GDScriptは訓練データ少/GUI依存 | ○ エディタ取込容易 | ★★★☆☆ |
| **Bevy** | 2D/3D | ○ WASM書き出し | ◎ MIT/Apache | △ RustはLLM難度高/Web書き出し荒い | ○ テクスチャ | ★★☆☆☆ |
| **Ebitengine** | 2D | ○ WASM書き出し | ◎ Apache-2.0 | △ GoはLLM中程度 | ◎ スプライト直結 | ★★☆☆☆ |
| PlayCanvas | 3D | ◎ ネイティブ | △ エンジンのみOSS/エディタ非OSS | ○ | ○ | 参考 |

---

## 3. エンジン別詳細

### ◎ 最有力グループ

#### Phaser 4（2D / MIT）★最推奨
- HTML5の2Dゲームフレームワーク。完全無料・OSS（MIT）、商用可。Phaser 4（2026年4月）でWebGLレンダラを刷新。
- **ブラウザネイティブ**。最大級のコミュニティと「全部入り」設計。
- **Codex相性◎**: 「Phaserは主要フロンティアLLMすべての訓練データに含まれ、Anthropic/OpenAI/Google等のモデルがAPIを深く理解。Claude Code・Cursor・**Codex**・Copilot等がゲーム一式をスキャフォールド可能」と明記されている。Phaser専用ファインチューンモデル(CodeGen等)も存在。
- **画像生成相性◎**: スプライトシート/タイルセットをPNGで取り込むだけ。AI画像生成（透過背景・32x32等指定）と最も直結。
- https://phaser.io/ / https://github.com/phaserjs/phaser

#### Babylon.js（3D / Apache-2.0）
- ブラウザ向けの本格3Dエンジン。PBR・物理・VR/AR・エディタ/ツール群が充実。
- **Codex相性◎**: ドキュメント・Playgroundが厚く、LLMが生成しやすい。
- **画像生成相性○**: 3Dモデルは別途必要だが、テクスチャ/スカイボックス/HD-2D風ビルボードはAI画像生成が有効。
- https://www.babylonjs.com/ / https://github.com/BabylonJS/Babylon.js

#### three.js（3D描画ライブラリ / MIT）
- Web 3Dの定番・軽量ライブラリ。ゲーム機能は自前 or 補助ライブラリ要。
- **Codex相性◎**: 訓練データ最大級、ChatGPT/Codexでの3Dコード生成事例が多数。
- **画像生成相性○**: テクスチャ/billboard中心。
- https://threejs.org/ / https://github.com/mrdoob/three.js

#### A-Frame（3D/VR / MIT）
- three.js上の宣言的フレームワーク。**HTMLタグでシーン記述**（entity-component）。
- **Codex相性◎**: HTML宣言的なのでLLMが構造を生成・編集しやすい。
- https://aframe.io/

#### KAPLAY（旧Kaboom）（2D / MIT）
- 軽量でシンプルなJS 2Dライブラリ。ミニマルAPIで学習コスト低い。
- **Codex相性◎**: API小さく、LLMが完結したゲームを一発生成しやすい（プロトタイプ/ゲームジャム向き）。
- **画像生成相性◎**: スプライト直結。
- https://kaplayjs.com/

---

### ○ 2D系の有力候補

#### PixiJS（2D描画 / MIT）
- 高速2Dレンダラ。ゲーム機能は自作だが描画は最強クラス。スプライト中心で**画像生成相性◎**。
- https://pixijs.com/

#### Excalibur.js（2D / BSD）
- TypeScript製。**型情報でAIコード補完が効きやすい**。Tiledマップ対応。
- https://excaliburjs.com/

#### LittleJS（2D / MIT）
- 超軽量・**単一ファイル**級。文脈がLLMコンテキストに収まりやすく、AIエージェントと相性良。
- https://github.com/KilledByAPixel/LittleJS

#### melonJS（2D / MIT）/ Ebitengine（Go/2D/Apache-2.0, WASM）
- melonJSはTiled連携が強くスプライト/タイル素材を扱いやすい。
- EbitengineはGo製でWASM書き出し可、スプライト直結だがLLMのGo習熟は中程度。

---

### △ WASM書き出し系（エディタGUI中心・言語面で相性に注意）

#### Godot（2D/3D / MIT）
- 完全OSS（MIT）。Web/WASMに**ワンクリック書き出し**、2D/3D両対応の本命デスクトップエンジン。
- **Codex相性△**: GDScriptはJS/Pythonより訓練データが少なく、ゲームロジックが**エディタGUI/シーンツリー**に依存するためテキストのみのエージェント編集と相性が落ちる。ただしGodot 4.7+向けのAIアシスタントモジュール/プラグイン（AI Assistant Hub, Ziva等）でGDScript・C#生成、スプライト/3Dモデル生成まで対応するものが登場している。
- **Web書き出し注意点**: COOP/COEPヘッダ要件・初期ロードサイズ・スレッド制約などブラウザ実行は設定がやや煩雑。
- https://godotengine.org/ / https://github.com/godotengine/godot

#### Bevy（2D/3D / MIT・Apache）
- Rust製ECSエンジン。完全OSS。WASM/Web対応は進行中だが書き出し・最適化はまだ荒い。
- **Codex相性△**: RustはLLMにとって難度が高め（借用検査等）でエラー往復が増えやすい。
- https://bevyengine.org/

---

## 4. 用途別おすすめ（Codex × 画像生成 前提）

| 狙い | 推奨 | 理由 |
|---|---|---|
| **2D + AIで素早く量産** | **Phaser 4** | LLM相性◎(Codex明記)＋スプライト直結。本命 |
| 2D超軽量・プロト/ジャム | **KAPLAY / LittleJS** | 小API・小ファイルでLLMが一発生成しやすい |
| **3D Webゲーム** | **Babylon.js / three.js** | 訓練データ豊富でCodex生成しやすい |
| 3D/VRをHTML的に記述 | **A-Frame** | 宣言的HTMLでAI編集が容易 |
| 2D/3D両対応・将来の本格化 | **Godot** | 完全OSS・両対応だがCodex相性は工夫要 |

### 結論
- **コードベース×AIコーディング×画像生成**を最重視するなら、**Phaser 4（2D）** が総合トップ。Codex等での生成事例が公式に言及され、AI画像生成のスプライトをそのまま使える。
- 3Dが必要なら **Babylon.js / three.js**。LLM訓練データが厚く、Codexでの実装が現実的。3D素材はモデルが要るため画像生成は「テクスチャ/HD-2D風ビルボード」用途で併用。
- 元プロジェクト(RPG-Cobo)のような**HD-2D/ボクセル風3D**を狙うなら、three.js/Babylon.js上で板ポリ(billboard)＋AI生成スプライトという構成が、画像生成相性とCodec相性を両立しやすい。
- **Godot/Bevy**は完全OSS・高機能だが、GUI依存(Godot)やRust難度(Bevy)でCodexエージェントとの相性は一段落ちる点に留意。

---

## 参考リンク（Sources）

- [Best JavaScript and HTML5 game engines (LogRocket, 2025)](https://blog.logrocket.com/best-javascript-html5-game-engines-2025/)
- [Phaser.js game development 2026 (LLM相性の記述)](https://www.seeles.ai/resources/blogs/phaser-js-game-development-2026)
- [Phaser (GitHub)](https://github.com/phaserjs/phaser)
- [Babylon.js (Wikipedia / 公式)](https://en.wikipedia.org/wiki/Babylon.js)
- [three.js vs Babylon.js (LogRocket)](https://blog.logrocket.com/three-js-vs-babylon-js/)
- [Exploring 3D Graphics on the Web: Three.js, A-Frame, Babylon.js](https://blog.cubed.run/exploring-3d-graphics-on-the-web-three-js-a-frame-and-babylon-js-c1da4892be54)
- [Godot Engine (GitHub)](https://github.com/godotengine/godot)
- [Bevy (GamingOnLinux)](https://www.gamingonlinux.com/2020/09/bevy-seems-like-an-impressive-upcoming-free-and-open-source-game-engine-made-with-rust/)
- [OpenGame: Open Agentic Coding for Games (arXiv)](https://arxiv.org/html/2604.18394v1)
- [2D Asset Generation: AI for Game Development (HuggingFace)](https://huggingface.co/blog/ml-for-games-4)
- [AI Game Asset Generation Guide (Spritesheets.ai)](https://www.spritesheets.ai/blog/ai-game-asset-generation-guide)
- [Best AI Tools for Godot 2026 (Ziva)](https://ziva.sh/blogs/best-ai-tools-for-godot-2026)
