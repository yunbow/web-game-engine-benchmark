# 弾幕STG ― Phaser 4 版

テーマ1 共通仕様（`../SPEC.md`）の縦スクロール弾幕STGを Phaser 4 で実装したもの。
性能比較（FPS / 表示オブジェクト数）が目的。

## 起動方法

1. このフォルダの `index.html` をブラウザで開く（ダブルクリック可）。
   - `index.html` と `game.js` が同フォルダにあれば動作する完全自己完結。
   - Phaser 4 は CDN から読み込む: `https://cdn.jsdelivr.net/npm/phaser@4/dist/phaser.min.js`（グローバル `Phaser`）。
2. アセットは `../assets/`（= `1/assets/`）から `SPEC.md` のファイル名で読み込む。
   - **画像が無くても必ず起動する**。ロード失敗時は `Graphics` で単色図形テクスチャを生成してフォールバックする
     （自機=水色三角、小型敵=赤丸、大型敵=濃赤丸、自機弾=黄楕円、敵弾=橙丸、爆発=橙白丸、背景=暗色）。
   - `file://` で画像が CORS/未存在になってもフォールバックで起動するので、ローカルサーバは必須ではない。
     （ただし実画像で確認したい場合は `python -m http.server` 等で配信推奨。）

## 使用バージョン

- Phaser **4**（CDN: `phaser@4/dist/phaser.min.js`、`Phaser.AUTO` レンダラ = WebGL 優先）
- 物理エンジンは未使用（Arcade等は使わず、位置更新と円判定を自前実装）。

## 操作

- 移動: 矢印キー / WASD（8方向、画面内クランプ）
- 発射: オート連射（150ms間隔、上方向）
- `+` / `-`: 同時最大敵数を ±10（下限10・上限300）

## 仕様の数値（SPEC厳守）

| 項目 | 値 |
|---|---|
| 画面 | 960 x 540 固定 |
| 自機弾速 | 600 px/s（上） |
| 連射間隔 | 150 ms |
| 敵降下速度 | 80〜140 px/s |
| 敵弾速 | 200 px/s（自機方向へ） |
| 初期最大敵数 | 40（±10、上限300） |
| 当たり判定 | 円判定（自機弾×敵 / 敵弾×自機 / 敵×自機） |
| HP / スコア | 初期HP3、撃破+10 |

## HUD（左上・常時表示）

- `FPS`（直近30フレームの移動平均）
- `Objects`（自機弾 + 敵 + 敵弾 + エフェクトのアクティブ合計）
- `Score` / `HP`
- `MaxEnemies`（現在の最大敵数 / 上限300）

## 実装メモ

- **更新はデルタタイム基準**（`update(time, delta)` の `delta/1000` 秒で全移動を計算）。
- **オブジェクトプール**: `Phaser.GameObjects.Group` + `getFirstDead(false)` で弾・敵・エフェクトを再利用し、
  GC負荷とインスタンス生成コストを抑制（高負荷=最大300体時の比較を意図）。
- 撃破/被弾時に `explosion` を一瞬表示（プールから再利用、フェードアウト）。
- 敵は常に `maxEnemies` を満たすよう毎フレーム補充（`fillEnemies`）。画面下に抜けた敵は消去して再スポーン。
- 背景は `tileSprite` の縦スクロール + 簡易星フィールド（`Graphics`、80個）。
- フォールバックテクスチャは `BootScene` で `loaderror` を捕捉 → `Graphics.generateTexture` で生成。
- 被弾後は約1.5秒の無敵（点滅）。HP0でGAME OVER → クリックで `scene.restart()`。

## Codex / AI コーディングでの生成しやすさ所感

- **API の素直さ**: かなり高い。`this.add.image` / `Group` / `getFirstDead` / `Graphics.generateTexture` /
  `input.keyboard.createCursorKeys` など命名が直感的で、Phaser 3 の知識がほぼそのまま通用する。
  シーンライフサイクル（`preload`/`create`/`update`）が明確なので、AI が雛形を出しやすい。
- **つまずきやすい点**:
  1. **キーコード**: `+`/`-` は `KeyCodes.PLUS`(187='='/'+'キー) / `MINUS`(189='-'キー)。
     名前から `Shift++` を連想しがちだが、実際は物理キーで Shift 無関係に発火する。テンキーは別途
     `NUMPAD_ADD` / `NUMPAD_SUBTRACT`。AI は `keydown` で `event.key==='+'` を併用しがちで二重発火を招く
     （本実装では `keydown-PLUS` 等のみに統一して回避）。
  2. **フォールバック生成**: 「画像無しでも起動」を満たすには `load.on('loaderror')` で失敗キーを集め、
     `make.graphics({add:false}).generateTexture(key,w,h)` で差し替える必要がある。AI は
     `this.add.graphics()`（表示用）と `this.make.graphics()`（生成用・非表示）を混同しやすい。
  3. **物理を使うか否か**: 大量オブジェクトの性能比較では Arcade Physics を使うとオーバーヘッドが乗るため、
     位置更新と円判定を自前にした。AI はデフォルトで物理を使いたがるので、性能目的では明示的に外す指示が有効。
  4. **Phaser 4 固有**: 本実装が使う範囲（GameObjects/Group/Graphics/Input/Scale/Math）は Phaser 3 と
     互換で、CDN 版もグローバル `Phaser` で同じ。バージョン差でハマる箇所はほぼ無かった。
- **必要だった調整**: 二重キー発火の排除、フォールバックテクスチャの上書き管理（既存削除→再生成）、
  プール再利用時の `setActive(true).setVisible(true)` 復帰漏れ防止。いずれも定型で、AI 生成後の軽微な修正で済む。
