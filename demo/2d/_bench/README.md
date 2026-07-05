# Bench Harness — 自動FPS計測

13テーマ × 7 JSエンジン（Phaser4 / PixiJS / Babylon.js / LittleJS / three.js / KAPLAY / A-Frame）の
**同一負荷でのFPSを無人で自動巡回計測**し、CSVに出すツール。Godot は別系統（Web書き出し）のため対象外。

## 仕組み（なぜゲーム本体を改変しないか）

- 各ゲームを `<iframe>` で順に起動。
- **FPSはハーネスが iframe内の `requestAnimationFrame` を直接駆動して実測**する。各ゲームの自己申告HUDに依存しないため、HUDの有無・形式（Phaser4はcanvas描画でDOMに無い等）に関係なく全エンジンを同条件で測れる。
- 負荷は **合成キーイベントで "+" を送る**（`key:'+' / code:'Equal' / keyCode:187 / which:187` を window・document・canvas に dispatch）。この1種で7エンジン全ての増加判定（`e.key==='+'` / `e.code==='Equal'` / Phaserの `keyCode 187`）を満たす。
- `Objects`（HUDがDOMにあるエンジンのみ）・初期転送量・初期化時間も併せて収集。

## 前提：`js/` をルートに配信すること

テーマをまたいで巡回するため、**単一オリジン**が必要。`js/` をHTTPルートにする
（ゲームの `../assets/` 参照は `js/<テーマ>/<engine>/` から見て `js/<テーマ>/assets/` に解決されるので、このルートで全テーマ整合する）。

```bash
cd js
python -m http.server 8000
# → http://localhost:8000/_bench/ を Chrome で開く
```

> 従来の「テーマ単体配信（`cd 01`）」ではハーネスから他テーマへ辿れない。計測時は必ず `js/` ルートで。

## 使い方

1. 上記サーバを起動し `http://localhost:8000/_bench/` を **Chrome** で開く。
2. テーマ／エンジン／負荷レベル／タイミングを設定して **「▶ 計測開始」**。
3. 終了後 **「⤓ CSVダウンロード」**（`bench_results.csv`）。

### パラメータ

| 項目 | 既定 | 意味 |
|---|---|---|
| 負荷レベル | `0,10,25` | デフォルト状態から累積で "+" を送る回数。SPECのSTEPは全エンジン共通なので同レベル＝同負荷設定。 |
| boot | 3500ms | iframe `load` 後の起動安定待ち。重いテーマ（A-Frame/Babylon、12のセル大量）は伸ばす。 |
| settle | 1500ms | 負荷変更後の整定待ち（スポーン充填）。 |
| sample | 8000ms | FPSサンプリング長。 |
| keyGap | 40ms | "+" 連打の間隔。 |

### 出力CSV列

`theme, engine, level, fps_avg, fps_1pct_low, objects, transferKB, initMs, frames, error`

- `fps_avg` … サンプル区間の平均フレームレート。
- `fps_1pct_low` … フレーム時間の99パーセンタイルから算出した1%ロー（カクつきの指標）。
- `objects` … HUD(DOM)があるエンジンのみ。Phaser4は `null`（HUDをcanvas描画のため）。
- `transferKB` / `initMs` … 初期転送量・DOMContentLoadedまでの時間。

## 注意・既知の制約

- **このタブを前面に置いたまま放置**すること。背面タブはブラウザが rAF を絞るため計測が無効になる。
- **FPSはモニタのリフレッシュレートで頭打ち**（60/120/144Hz）。エンジン間の相対比較や「FPSが落ち始める負荷」は有効だが、上限値そのものは表示依存。固定リフレッシュ環境で計測すること。
- 公平性のため、**同一マシン・同一ブラウザ・canvas 960×540・DPR=1・AC電源/冷却済み**で1セッション通し計測する。
- テーマ1〜5は無入力だと自機が被弾しうるが、被弾後オートリスポーンで計測は継続する（負荷=スポーン量は維持される）。
- 起動失敗・タイムアウトは該当行の `error` 列に記録される（boot を伸ばして再試行）。
- 派生指標「60fps維持の最大負荷 / 30fpsまで落ちる負荷」を出したい場合は、レベル段階を細かくして CSV から読み取る（将来、二分探索モードを追加予定）。
