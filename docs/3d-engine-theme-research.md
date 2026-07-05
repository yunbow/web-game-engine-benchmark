# 3D版ベンチ ― ライブラリ候補 × 比較テーマ 調査

調査日: 2026-06-16
目的: `2d/`（13テーマ×5エンジン=65本）と同じ方法論を **3D** に拡張するための、
**(A) 3Dライブラリ候補** と **(B) 3D特有の比較テーマ** の選定。実装先は `3d/`。

評価軸は2Dと同じ4軸を踏襲する: **ブラウザ実行 × AIコーディング相性 × （3D）アセット生成相性 × 実行性能**。
ただし「画像生成相性」は3Dでは意味が変わる（後述 §3）。

---

## 1. ライブラリ候補（ブラウザ × OSS × AI相性）

凡例: ◎ 非常に良い / ○ 良い / △ 条件付き / × 弱い

| ライブラリ | 種別 | ライセンス | ブラウザ | AIコーディング相性 | 物理 | 2Dでの対応役 | 総合 |
|---|---|---|---|---|---|---|---|
| **three.js** (r184) | 低レベル描画 | ◎ MIT | ◎ WebGL+WebGPU両対応 | ◎ 訓練データ最大級。ただしゲーム機構は自前 | 外部(Rapier/cannon-es) | PixiJS的（描画は最強・機構は自作） | ★★★★★ |
| **Babylon.js** (8.x) | フル3Dエンジン | ◎ Apache-2.0 | ◎ ネイティブ | ◎ ドキュ厚・全部入りでLLMが迷いにくい | 内蔵(Havok/Cannon) | Babylon（2Dと同一・3Dが本来の土俵） | ★★★★★ |
| **PlayCanvas engine** | フル3Dエンジン | ◎ MIT | ◎ WebGPU先行・WebGL2維持 | ○ TS型定義完備。エディタ前提の例が多くコードのみ生成はやや情報少 | 内蔵(Bullet/ammo) | 新規枠（WebGPU/Bullet/ECS） | ★★★★☆ |
| **A-Frame** (three.js上) | 宣言的ECS | ◎ MIT | ◎ HTMLタグ記述でLLMが構造を生成・編集しやすい | 拡張(cannon/ammo) | 新規枠（宣言的・VR/AR） | ★★★★☆ |
| **Godot 4.6** (3D) | フルエンジン | ◎ MIT | △ GDScript訓練データ少・`.tscn`生成が壊れやすい | 内蔵(Jolt/GodotPhysics3D) | Godot（2Dと同一・3Dが本領） | ★★★☆☆ |
| react-three-fiber / Threlte | three.jsの宣言的ラッパ | ◎ MIT | ◎ ただしReact/Svelte前提 | three.js準拠 | （6本目の任意枠・DX軸） | 参考 |
| Needle Engine | three.js上の統合 | 一部非OSS | ◎ | ○ | 拡張 | 参考（OSS基準で要注意） | 

**推奨コア5本**: `three.js / Babylon.js / PlayCanvas / A-Frame / Godot`。
- 2Dの5本（Phaser4/Babylon/PixiJS/LittleJS/Godot）に対し、**Babylonとgodotは横断で同一**、three.jsはPixiJS的な「描画特化・機構自作」役、PlayCanvasとA-Frameが3D新規軸（WebGPUフル機能 / 宣言的）。
- r3f・Threlte は「three.jsを宣言的に書く DX 軸」なので、**6本目の任意比較**として一部テーマだけに足すのが妥当（フレームワーク前提が比較の独立性を崩すため）。

### 1.1 three.js の重要事実（2026）
- **r184**（2026-04時点の安定版）。**WebGPURenderer が r171 以降 production-ready**、WebGL2自動フォールバック。`WebGLRenderer→WebGPURenderer` はほぼ1行で切替可能。
- **compute shader** が使えるため、GPUパーティクル・大量インスタンス更新・衝突判定をGPU側に寄せられる（テーマ設計の主役になりうる）。

### 1.2 物理エンジン選択（テーマ「3D剛体」用）
- **three.js / A-Frame**: 外部統合が必要。本命は **Rapier**(Rust→WASM, 高速・多スレッド設計)、軽量なら cannon-es、Babylon系の **Havok WASM** も three から利用可。
- **Babylon.js**: **Havok 内蔵プラグイン**（公式・最速）または Cannon。
- **PlayCanvas**: **ammo.js(Bullet) 内蔵**。
- **Godot**: 4.x は **Jolt** が既定の3D物理（旧 GodotPhysics3D も選択可）。
- → 2Dテーマ7（matter-js横並び）に対応する「3D剛体エンジン統合の横並び」が作れる。

---

## 2. 比較テーマ候補（3D特有の負荷軸を1本ずつ分離）

2Dの設計思想（**1テーマ=1負荷軸 / 全ライブラリ同一仕様 / `+`-`で主軸を増減 / アセット欠落でも図形フォールバック / 決定的生成**）をそのまま踏襲。
3Dでしか測れない軸を優先する。★は実装推奨度（コスパと比較価値）。

| # | テーマ | 比較の主軸（`+`/`-`で増減） | 2D対応 | 3D新規性 | ★ |
|---|---|---|---|---|---|
| **T1** | **インスタンス描画**（小惑星/弾の大群） | 同一メッシュの描画数（→10万） | 1/2 描画スループット | InstancedMesh / thin instances / GPU instancing の横比較 | ★★★★★ |
| **T2** | **広域地形 + カリング/LOD**（飛行） | 描画距離・プロップ密度 | 3 大マップ・カリング | 視錐台カリング＋**LOD切替**＋draw distance | ★★★★☆ |
| **T3** | **3D剛体物理**（箱積み/3D Angry Birds） | 剛体数 | 7 物理エンジン統合 | Rapier/Havok/Bullet/Jolt の**3D**横並び | ★★★★★ |
| **T4** | **スキンドキャラ大群**（glTF＋アニメ） | 同時アニメキャラ数 | （無）スプライトのコマ送りと別物 | glTF読込＋AnimationMixer/スケルトン・インスタンシング | ★★★★★ |
| **T5** | **動的シャドウ光源** | 影付きライト数・影解像度 | 11 ライティング/影 | リアルな**シャドウマップ**の枚数/解像度スケール | ★★★★☆ |
| **T6** | **GPUパーティクル**（魔法/煙） | パーティクル数（→100万） | 8 GPUパーティクルFX | WebGPU compute / GPUParticleSystem / GPUParticles3D | ★★★★☆ |
| **T7** | **ボクセルチャンク再生成**（Minecraft風） | 描画距離・チャンク数 | 12 フォーリングサンド（動的転送） | **頂点バッファの毎回再構築/再アップロード**＋greedy meshing | ★★★★☆ |
| **T8** | **PBR + ポストプロセス** | オブジェクト数・ポスト段数 | （無） | PBRマテリアル数＋bloom/SSAO/FXAA等の合成段 | ★★★☆☆ |
| **T9** | **3D ナビメッシュ/群衆経路探索** | エージェント数 | 6 TD（A*） | 3Dナビ＋ステアリング群衆 | ★★★☆☆ |
| **T10** | **レイキャスト/ピッキング大量** | レイ数・対象数 | （無） | 物理レイ/BVH ピッキングのスケール | ★★☆☆☆ |

### 共通HUD（2D踏襲・必須）
左上に `FPS`(移動平均) / `Objects`(描画中メッシュ/インスタンス/剛体の合計) / `Score` 等のテーマ値 / `HP`（該当時）/ **現在の主軸負荷値** / （任意で）`Draw calls`・`Triangles`。
3Dでは **draw call 数と三角形数** が比較で効くため、可能なら HUD に追加する。

---

## 3. 「画像生成相性」は3Dでどう変わるか
- 2Dは PNG スプライト直結が強み。3Dは **メッシュ（glTF/GLB）が必要** なため、純粋な画像生成だけでは完結しない。
- 3Dでのアセット生成相性は二系統:
  1. **テクスチャ/スカイボックス/法線マップ/HD-2Dビルボード** ← 既存の画像生成（gptimage2等）がそのまま有効。
  2. **メッシュ本体** ← **text-to-3D（Tripo / Meshy / Hunyuan3D / Copilot 3D 等）で GLB 生成**。GLB は three/Babylon/PlayCanvas/Godot が**ネイティブ読込**。
- → 3D版では IMAGE_PROMPTS.md 相当を **「ASSET_PROMPTS.md（テクスチャ画像 + text-to-3D の GLB プロンプト）」** に拡張するのが自然。図形フォールバック（box/sphere/cone のプリミティブ）は2D同様に必須維持。

---

## 4. 推奨の進め方
1. **コアライブラリ5本**（three.js / Babylon.js / PlayCanvas / A-Frame / Godot）で開始。r3f/Threlte は一部テーマの任意6本目。
2. **第1バッチ＝T1 インスタンス描画 / T3 3D剛体 / T4 スキンドキャラ / T6 GPUパーティクル**（3D固有の比較価値が最大かつ2D設計を流用しやすい）。
3. ディレクトリは2Dと同型: `3d/<番号>/SPEC.md + <Library>/index.html + game.js + README.md`（Godotのみプロジェクト一式）。CDNで各ライブラリ読込。
4. 各テーマ SPEC.md に数値（速度/数量上限/当たり判定方式/カメラ設定/座標系）を固定し、5本で完全一致させる。

---

## 参考（Sources）
- [three.js 2026 / WebGPU の現状（utsubo）](https://www.utsubo.com/blog/threejs-2026-what-changed)
- [three.js (Wikipedia)](https://en.wikipedia.org/wiki/Three.js)
- [Three.js vs Babylon.js vs PlayCanvas 比較（utsubo, 2026）](https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison)
- [Babylon.js vs Three.js（Slant, 2026）](https://www.slant.co/versus/11077/11348/~babylon-js_vs_three-js)
- [PlayCanvas Engine（MIT・WebGPU/Bullet）](https://playcanvas.com/products/engine)
- [9 Best JavaScript 3D frameworks（Slant, 2026）](https://www.slant.co/topics/3658/~best-javascript-3d-frameworks)
- [Web Game Dev — Physics（Rapier/Havok/ammo比較）](https://www.webgamedev.com/physics)
- [Rapier 物理エンジン（Dimforge）](https://www.dimforge.com/blog/2020/08/25/announcing-the-rapier-physics-engine/)
- [Tripo: text-to-glTF AI 3D（2026）](https://www.tripo3d.ai/content/en/guide/the-best-text-to-gltf-ai-3d-model-converter)
- [Meshy vs Tripo（2026）](https://www.meshy.ai/compare/meshy-vs-tripo)
