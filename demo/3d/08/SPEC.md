# 3D テーマ8（T8）共通仕様 ― PBR マテリアル + ポストプロセス（Bloom）

全ライブラリ（three.js / Babylon.js / PlayCanvas / A-Frame）で**同一仕様**を実装し、性能を横並び比較するための共通仕様。
**比較の主軸 = PBR マテリアルの描画数 ＋ ポストプロセス（Bloom）パイプラインのコスト**。2Dにはない3D固有の描画軸。

> この SPEC.md が唯一の正。球数・PBRパラメータ・ライト・トーンマップ・Bloom・カメラ・HUD を4ライブラリで揃える。
> ポスト処理（Bloom）の実装機構はエンジンごとに異なる（three=EffectComposer / Babylon=DefaultRenderingPipeline /
> PlayCanvas=posteffect / A-Frame=EffectComposer）。**統合の手間と同一負荷での FPS** が比較対象。

## ゲーム内容
- PBR（物理ベースレンダリング）の球を多数並べ、緩やかに回るシーンを **Bloom 付き**で描画。
- **目的は性能比較**: `+`/`-` で PBR 球の数を増減し、PBR シェーディング＋Bloom 合成のコストで FPS を測る。

## 描画バックエンド
- **全ライブラリ WebGL2 で統一**。トーンマッピングは **ACES Filmic**、Bloom を有効化。

## 画面・カメラ
- 描画サイズ **960 x 540（16:9 固定）**。**Y軸上向き**。
- カメラは**緩やかに自動周回**（決定的・時間ベース）: 半径 **30**、高さ **8**、角速度 **0.2 rad/s**、注視 **(0,0,0)**。fov 50° / near 0.1 / far 1000。

## 環境（反射）
- PBR 反射用の環境を設定する。**任意の生成アセット `../assets/env_equirect.png`（equirectangular 2:1）があれば**それを環境マップ＋背景に使用。
- **無ければ各エンジンの手続き的環境にフォールバック**（three=RoomEnvironment / Babylon=CreateDefaultEnvironment相当 / PlayCanvas=単色スカイ＋ambient / A-Frame=RoomEnvironment）。背景はフォールバック時 `#1a1f2a`。
- 直接光: 平行光2灯（白・暖色）＋弱い環境光。金属球にハイライトが出るようにする。

## PBR 球（決定的・`Math.random` 不使用）
- 球数 **N**: 初期 **200**。`+`/`-`（`]`/`[`）で **±100**（**最小 50 / 最大 2000**）。**比較の主軸**。
- 配置: 1辺 `k = ceil(cbrt(N))` の立方格子のうち先頭 N 個を使用。間隔 **2.2**、全体を中心揃え（y も中心化し原点中心の塊に）。
- 各球（シード付き乱数 mulberry32, seed=0x9e3779b9 で決定的）:
  - 半径 **0.7**（共有ジオメトリ）。
  - `metalness ∈ {0 か 1 を含む 0..1}`、`roughness ∈ 0.05..1.0`、ベース色 = 決定的な彩度高めの色。
  - **約 15% の球は emissive**（自発光・強度高め）にして **Bloom で光らせる**（発光色は明るい暖色/寒色）。
- 全球を1つの親に入れ、シーンを緩やかに自転（任意・カメラ周回で十分なら省略可）。

## ポストプロセス（Bloom・必須）
- **Bloom を有効化**（しきい値・強度・半径は各エンジンの近い値で。明るい/emissive 部分が滲んで光る）。
- トーンマッピング ACES Filmic、露出 1.0 程度。
- 可能なら FXAA も（必須ではない）。

## 操作
- `+` / `-`（`]` / `[`）: PBR 球数の増減。**比較の主軸**。
- `R`: 球数を初期値に戻す。
- カメラ自動周回（無人ベンチ可）。

## 共通HUD（必須）
画面左上にHTMLオーバーレイ:
- `FPS`（実測・移動平均）
- `Objects`（球数 = N）
- `Spheres`（現在の球数設定 N）
- `Draws`（draw call 数）/ `Tris`（三角形数）。
- `Bloom`（on/off の状態、または `Post: bloom`）。

## アセット
- **既定はプリミティブ＋単色PBR＋手続き的環境で起動**（画像不要）。`../assets/env_equirect.png` は**任意**（IMAGE_PROMPTS.md にプロンプトあり）。
  あれば反射・背景が向上、無ければフォールバック。

## 成果物 / ディレクトリ
```
3d/08/
├─ SPEC.md
├─ assets/                ← 任意。env_equirect.png を置けば反射に使われる
├─ three.js/    index.html + game.js + README.md   (EffectComposer + UnrealBloomPass)
├─ Babylon.js/  index.html + game.js + README.md   (DefaultRenderingPipeline)
├─ PlayCanvas/  index.html + game.js + README.md   (posteffect bloom)
└─ A-Frame/     index.html + game.js + README.md   (three EffectComposer custom)
```
各フォルダ `README.md` に 起動方法・使用バージョン・**PBR設定＋Bloom統合の手順とつまずき**・AI生成所感。
