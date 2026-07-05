# 物理パズル (投擲物理) — A-Frame + Matter.js 版

テーマ7共通仕様（物理パズル・**本物の2D剛体物理エンジンを使う**・性能比較用）の
**A-Frame (1.7.0)** 実装。画像アセットが無くても canvas フォールバックで必ず起動します。

使用バージョン:
- 描画/シーン: **A-Frame 1.7.0**（CDN: `aframe.io/releases/1.7.0/aframe.min.js`）
- 物理（剛体）: **matter-js 0.19.0**（CDN: `cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js`）
  — PixiJS / Babylon.js / LittleJS / KAPLAY / three.js と**同一バージョン**を併用。

## 起動方法
画像を `../assets/` から読むため、テーマフォルダ(`7/`)をルートに HTTP サーバを立てて開く。

```bash
cd 7
python -m http.server 8000
# → http://localhost:8000/A-Frame/
```

## 操作
- 左ドラッグ&リリース: スリングショット発射 / クリックのみ: クリック地点へ発射
- `Space`: オートショット（0.8s 間隔・決定的） / `+` `-`: 箱数 ±20（20〜600） / `R`: 再構築

## 使用した物理エンジンと統合方法（本テーマの比較点）
A-Frame は three.js 上の**宣言的 (entity-component) フレームワーク**で、2D 剛体物理は
内蔵しない（`aframe-physics-system` は 3D 前提）。本テーマは本物の剛体ソルバの比較が
主題のため、物理は **matter-js に完全委譲**した。

- **シーンは宣言的**: `index.html` に `<a-scene embedded>` を置き、`<a-entity physics-puzzle>`
  に登録した **`physics-puzzle` コンポーネント**がゲーム本体を駆動する（A-Frame の renderer /
  `tick` ループ / カメラ管理を利用）。
- **物理は matter-js**: コンポーネント `init` で `Matter.Engine` を作り、床・壁=`isStatic`、
  箱=矩形剛体、発射体=円剛体を `World` に追加。`tick` で `Matter.Engine.update(engine, dtMs)`
  を1回呼ぶ。
- **設計判断（重要）**: 箱は最大600個になり得る。「1箱 = 1 `<a-entity>`」だと DOM /
  コンポーネント生成コストで FPS が破綻するため、**剛体の表示物はコンポーネント内で
  `THREE.Sprite` を直接生成・管理**する（A-Frame 内包の `AFRAME.THREE` を使用）。
  弾幕STG(テーマ1)と同じ設計方針。
- **カメラ**: 2D 用に `OrthographicCamera(0, W, H, 0, -1000, 1000)` を自前生成し、`sceneEl.camera`
  へ差し替え。A-Frame が別カメラを差し込んでも `tick` で毎フレーム上書き維持。`setPixelRatio(1)` 固定。

### ★ Y軸の扱い（最重要・エンジン差が出る所）
- **Matter は Y 下向き**、**A-Frame/three.js の Ortho カメラ`(0,W,H,0)` は Y 上向き**。
- → 位置同期で **`worldY = H - body.position.y`**、回転は **`material.rotation = -body.angle`**
  と符号反転。これで「箱が画面**下**へ落ちる」「回転が見た目どおり」になる。

- **スリープ**: `engine.enableSleeping = true`。HUD `Active`（覚醒剛体数）で観察。
  加点は重心移動64px（通常+10/ターゲット+50）、場外スリープ剛体は除去。

## HUD（共通仕様）
`FPS` / `Bodies`（箱数 / 設定値, total）/ `Active`（覚醒剛体数）/ `Shots` / `Score` /
`Engine: Matter (CDN)`。

## Codex / AI コーディング所感
- A-Frame の「宣言的 DOM」と「数百剛体の動的生成」は相性が悪い。素直に書くと `<a-entity>`
  を量産して破綻するため、**動的オブジェクトは THREE.Sprite 直生成**へ倒すのが定石（要明示指示）。
- 罠: ① カメラ差し替えは `loaded` 後 + `tick` 維持が必要（放置すると A-Frame の既定カメラに戻る）。
  ② 入力の canvas 取得は `sceneEl.canvas` が `loaded` 後でないと取れない。
  ③ Y反転（位置 `H-y` / 回転 `-angle`）は three.js 版と同一。物理は matter、描画レイヤだけ
  A-Frame という構図で、座標規約の差を吸収している。
