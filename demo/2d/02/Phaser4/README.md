# トップダウン・サバイバー — Phaser 4 版

テーマ2「トップダウン・サバイバー」の Phaser 4 実装。`../SPEC.md` に厳密準拠。
数百〜千体規模の敵の群れ更新＋当たり判定で性能限界を測る比較用デモ。

## 起動方法

ローカルファイルを直接 `file://` で開くと CORS の都合で `../assets/` の画像読込がブロックされる場合があるため、簡易HTTPサーバ経由を推奨。

```bash
# このフォルダ(2/Phaser4)の1つ上(2/)で起動するとアセット相対パスが通る
cd c:/work/claude/github/virtual_office/research/2
python -m http.server 8000
# ブラウザで http://localhost:8000/Phaser4/index.html
```

Node 派なら `npx serve` でも可。

- **アセットが無くても起動します**（画像欠落を検知し単色図形へ自動フォールバック）。
- Phaser 4 は CDN から読込: `https://cdn.jsdelivr.net/npm/phaser@4/dist/phaser.min.js`

## 操作

| 操作 | キー |
|---|---|
| 移動(8方向) | WASD / 矢印キー |
| 攻撃 | 自動（最近接敵へ400msごと） |
| 敵スポーン上限 ±50 | `+` / `-`（テンキー可） |
| リスタート | `R`（GAME OVER後） |

## バージョン / 環境

- **Phaser 4**（CDN `@4` の最新 dist を読込）
- 純粋な `index.html` + `game.js` の自己完結。ビルド不要。
- 画面 960x540 固定。カメラは自機追従。

## 実装メモ（SPEC数値の対応）

| 項目 | 値 | 実装箇所 |
|---|---|---|
| 自機移動 | 180 px/s（正規化8方向） | `PLAYER_SPEED` / `updatePlayer` |
| オート攻撃 | 400ms間隔 / 弾速350 / 命中で敵HP-1 | `FIRE_INTERVAL` `PROJECTILE_SPEED` / `updateAutoFire` `updateProjectiles` |
| 敵速度 | 60〜90 px/s | `ENEMY_SPEED_MIN/MAX` / `spawnEnemyAt` |
| 敵HP | 小(bat)=1 / 大(zombie)=3 | `BAT_HP` `ZOMBIE_HP` |
| 接触ダメージ | 自機HP-1 / 無敵0.5s | `PLAYER_INVULN` / `damagePlayer` |
| 自機HP | 初期5 / 0でGAME OVER | `PLAYER_HP_MAX` / `triggerGameOver` |
| 同時敵数 | 初期150 / ±50 / 上限1000 | `SPAWN_INITIAL` `SPAWN_STEP` `SPAWN_MAX` |
| 自動増加 | 10秒ごと +25 | `SPAWN_AUTO_INTERVAL` `SPAWN_AUTO_AMOUNT` |
| ドロップ | 撃破でxp_gem / 接触取得でKill+1 | `spawnGem` / `updateGems` |
| 当たり判定 | すべて円 | 距離二乗比較（sqrt回避） |

### 大量エンティティ最適化

- **オブジェクトプール**: 敵(1100)・弾(256)・gem(1200) を起動時に `add.image` で全確保し、
  `setActive/setVisible(false)` で待機。生成/破棄せず**フラグ切替で再利用**（GC圧を回避）。
- ロジックは **Plain Object の構造体配列**（`{active,x,y,vx,vy,...}`）で持ち、
  表示用 `Image` は座標同期のみ。Phaser の Arcade Physics は使わず**自前の固定step積分**。
- 当たり判定は**距離の二乗比較**で `Math.sqrt` を回避。弾×敵は弾側ループで早期 break。
- スポーンは1フレーム最大6体ずつ補充し、初期150は起動時に一括投入してスパイクを抑制。
- 背景は `TileSprite` 1枚＋`tilePosition` スクロールで無限地面を擬似表現（ドローコール最小）。
- FPSは直近60フレームの**移動平均**で表示。

### HUD（必須項目すべて表示）

`FPS`(移動平均) / `Enemies`(生存敵数, capも併記) / `Objects`(敵+弾+gem合計) /
`Time`(生存秒) / `Kills` / `HP` を左上にカメラ固定で常時表示。

## Codex / AIコーディングでの生成しやすさ所感

- **総じて生成しやすい部類**。Phaser は API が安定・ドキュメント豊富で学習データが厚く、
  Scene 構成（preload/create/update）・入力・カメラ追従・TileSprite 等の「定番」は
  AIがほぼ正しく一発で出せる。`Phaser.Game(config)` のボイラープレートも定型で迷いが少ない。
- **大量エンティティ最適化はAI任せだと詰まりやすい**。素直に生成させると
  `this.add.image()` を毎フレーム生成したり Arcade Physics の Group を多用しがちで、
  数百体規模で破綻する。今回は「**プール化・構造体配列・物理エンジン不使用・距離二乗判定**」を
  明示的に指示する必要があった。AIは"動く実装"は得意だが"千体で60fps"の制約は
  プロンプト側で最適化方針を与えないと到達しにくい。
- Phaser 3→4 の差分は本デモ範囲（2Dスプライト/Scene/Loader/Input）ではほぼ無く、
  AIが持つ Phaser 3 知識がそのまま流用でき、移植コストは小さい。
- フォールバック（画像欠落時の図形生成）は `make.graphics().generateTexture()` という
  Phaser定番パターンで、AIにも実装させやすかった。
- **結論**: 定番ゲーム骨格の生成速度は非常に速い一方、性能要件(大量更新)は人間が
  最適化制約を明示することで初めて満たせる。比較対象の軽量系(LittleJS/PixiJS手書き)より
  抽象度が高いぶん、最適化の自由度は一手間かかる。
