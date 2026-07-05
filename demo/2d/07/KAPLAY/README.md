# 物理パズル (投擲物理) — KAPLAY + Matter.js 版

テーマ7共通仕様（物理パズル・**本物の2D剛体物理エンジンを使う**・性能比較用）の
**KAPLAY** 実装。画像アセットが無くても単色図形フォールバックで必ず起動します。

使用バージョン:
- 描画/ループ/入力: **KAPLAY 3001.0.19**（CDN: `unpkg.com/kaplay@3001.0.19/dist/kaplay.js`）
- 物理（剛体）: **matter-js 0.19.0**（CDN: `cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js`）
  — PixiJS / Babylon.js / LittleJS と**同一バージョン**を併用。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`7/`)をルートに HTTP サーバを立てて開く。

```bash
cd 7
python -m http.server 8000
# → http://localhost:8000/KAPLAY/
```
`file://` 直開きは画像が CORS で読めない（図形フォールバックでは起動する）。

## 操作
- 左ドラッグ&リリース: スリングショット発射（ドラッグの逆向きに距離比例の初速）
- クリックのみ: クリック地点へ固定初速で発射
- `Space`: オートショット（0.8s 間隔で決定的角度/初速、マウス無しでベンチ可）
- `+` / `-`（テンキー +/- も可）: 箱（剛体）数を ±20（下限20・上限600）
- `R`: 構造物・スコアを決定的に再構築

## 使用した物理エンジンと統合方法（本テーマの比較点）
KAPLAY は「全部入り」2Dライブラリだが、**本物の2D剛体物理エンジンは内蔵しない**
（`body()`/`area()` は簡易な重力・AABB 衝突のみ）。テーマ4/5 の「物理エンジン**不使用**・
自前AABB」の**対**として、本テーマは本物の剛体ソルバ（接触・スタック・反発・摩擦・
スリープ）を比較するのが主題のため、物理は **matter-js に完全委譲**した。

- **物理は matter-js**: `Matter.Engine` / `World` / `Bodies` / `Body`。床・左右壁は
  `isStatic`、箱は矩形剛体、発射体は円剛体。毎フレーム `Matter.Engine.update(engine, dtMs)`
  を1回呼ぶ（`dtMs` はスパイク対策で 32ms にクランプ）。
- **描画は KAPLAY**: 箱=`k.sprite`/`k.rect`、発射体=`k.sprite`/`k.circle`。
  毎フレーム、各 Matter ボディの `position` / `angle` を読み、対応する KAPLAY
  ゲームオブジェクトの `obj.pos` / `obj.angle` へ書き込むだけ（物理→描画の一方向同期）。
- **Y軸**: KAPLAY の座標系は **Y 下向き・原点左上 = Matter の座標系（Y下）とそのまま一致**。
  three.js / A-Frame と違い **Y 反転が不要**で最も素直。`angle` は KAPLAY が degree のため
  `body.angle (rad) * 180/π` の変換のみ行う。
- **スリープ**: `engine.enableSleeping = true`。HUD の `Active`（覚醒剛体数）が安定後に
  落ち着くかで Matter のソルバ/スリープ実装が見える（全エンジン共通の比較軸）。
- **加点**: 箱の重心が初期位置から 64px 以上動いたら「崩した」と判定し1回だけ加点
  （通常 +10 / ターゲット +50）。場外でスリープした剛体は除去（剛体数の暴走防止）。

## HUD（共通仕様）
`FPS`（移動平均）/ `Bodies`（箱数 / 設定値, total 剛体数）/ `Active`（覚醒剛体数）/
`Shots`（生存 / 発射累計）/ `Score` / `Engine: Matter (CDN)`。

## Codex / AI コーディング所感
- KAPLAY 側は弾幕STG(テーマ1)同様ミニマルで生成しやすい。本テーマの肝は「KAPLAY の物理を
  使わず matter-js を載せる」判断で、ここは明示指示が要る（放っておくと `body()` を使いがち）。
- 罠: ① KAPLAY の `angle` は **degree**（Matter は radian）。② Y 反転が不要なのは
  KAPLAY/Matter の座標規約が一致するため（three/Babylon は反転が必要で対照的）。
- 結果として「物理は matter、描画は各エンジン」という統合形が、座標規約の差を最も素直に
  吸収できるのが KAPLAY、という比較結果になった。
