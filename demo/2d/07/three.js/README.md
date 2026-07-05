# 物理パズル (投擲物理) — three.js + Matter.js 版

テーマ7共通仕様（物理パズル・**本物の2D剛体物理エンジンを使う**・性能比較用）の
**three.js (r184)** 実装。画像アセットが無くても canvas フォールバックで必ず起動します。

使用バージョン:
- 描画: **three.js 0.184.0**（importmap: `unpkg.com/three@0.184.0/build/three.module.js`）
- 物理（剛体）: **matter-js 0.19.0**（CDN: `cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js`）
  — PixiJS / Babylon.js / LittleJS / KAPLAY と**同一バージョン**を併用。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`7/`)をルートに HTTP サーバを立てて開く。
ES Modules + importmap を使うため `file://` 直開きは不可（HTTP 必須）。

```bash
cd 7
python -m http.server 8000
# → http://localhost:8000/three.js/
```

## 操作
- 左ドラッグ&リリース: スリングショット発射 / クリックのみ: クリック地点へ発射
- `Space`: オートショット（0.8s 間隔・決定的） / `+` `-`: 箱数 ±20（20〜600） / `R`: 再構築

## 使用した物理エンジンと統合方法（本テーマの比較点）
three.js は **3D描画ライブラリ**で 2D 剛体物理は内蔵しない。本テーマは本物の剛体ソルバ
（接触・スタック・反発・摩擦・スリープ）の比較が主題のため、物理は **matter-js に完全委譲**した。

- **物理は matter-js**: `Matter.Engine` / `World` / `Bodies` / `Body`。床・壁=`isStatic`、
  箱=矩形剛体、発射体=円剛体。毎フレーム `Matter.Engine.update(engine, dtMs)` を1回。
- **描画は three.js**: 2Dとして使うため `OrthographicCamera(0, W, H, 0, -1000, 1000)`
  （1ワールド単位 = 1px）。剛体の表示物は **`THREE.Sprite`**（常にカメラを向く板）を使い、
  `renderOrder` + `material.depthTest = false` で重ね順を制御（深度バッファに依存しない）。
- **同期**: 毎フレーム、各 Matter ボディの `position` / `angle` を読んで Sprite へ反映する
  一方向同期。背景=`PlaneGeometry`、地面/発射台=静的 Sprite。

### ★ Y軸の扱い（最重要・エンジン差が出る所）
- **Matter は Y 下向き**（重力 `+y`、箱は `y` 増加方向＝画面下へ落ちる）。
- **three.js の Ortho カメラ`(0,W,H,0)` は Y 上向き**（上端 `y=H` / 下端 `y=0`）。
- → 位置同期で **`worldY = H - body.position.y`** に変換（Matter の `y` が増えると画面では下へ）。
- → 回転も座標系の向きが逆なので **`sprite.material.rotation = -body.angle`** と符号反転。
- この2点で「箱が画面**下**へ落ちる」「衝突時の回り方が見た目どおり」になる。
  KAPLAY は座標規約が一致するため反転不要だったのと対照的（＝これ自体が比較点）。

- **スリープ**: `engine.enableSleeping = true`。HUD `Active`（覚醒剛体数）で Matter の
  スリープ挙動を観察。加点は重心移動64px、場外スリープ剛体は除去。

## HUD（共通仕様）
`FPS` / `Bodies`（箱数 / 設定値, total）/ `Active`（覚醒剛体数）/ `Shots` / `Score` /
`Engine: Matter (CDN)`。

## Codex / AI コーディング所感
- three.js 単体は描画のみで、物理は matter-js を別レイヤとして載せる構図が明快。
- 罠: ① **Y反転**を忘れると箱が画面上へ「落ちる」。位置 `H-y` と回転 `-angle` を必ずセットで。
  ② Sprite の重ね順は z だけでは不安定なので `renderOrder`+`depthTest:false` を併用。
  ③ DPR は性能比較のため `setPixelRatio(1)` 固定。
