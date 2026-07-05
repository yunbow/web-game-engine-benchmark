/* =========================================================================
 * テーマ6 タワーディフェンス（経路探索 × 多数ユニット追従）― PixiJS v8 実装
 * 仕様: SPEC.md (960x540, タイル32x32, グリッド30x17, A*経路探索, 自前ロジック)
 *
 * 本テーマの主軸は「描画」ではなく CPU 側 AI ロジック:
 *   - グリッド A* 経路探索 (4方向 / コスト1 / マンハッタン距離ヒューリスティック)
 *   - 多数ユニット (creep) の経路追従更新
 *   - タワー射撃 (射程内の最進行度敵を狙い projectile 発射)
 *
 * PixiJS は描画ライブラリのため、以下はすべて自前実装:
 *   - ゲームループ (PIXI.Ticker の deltaMS でデルタタイム駆動)
 *   - A* 経路探索 / 経路追従 / 弾の直進 / 距離ベース当たり判定
 *   - マウス入力 (app.canvas の pointerdown, event.button で左右判別)
 *   - creep / projectile / spark スプライトのプール再利用
 *   - 決定的擬似乱数 (mulberry32, Math.random は使わない)
 * =========================================================================*/

// ---- 定数 (SPEC) ----------------------------------------------------------
const TILE = 32;
const GRID_W = 30;            // 30 タイル
const GRID_H = 17;            // 17 タイル
const VIEW_W = 960;
const VIEW_H = 540;           // 960 x 540 (グリッドは 960 x 544 だが下4pxは画面外)

// グリッドのスタート / ゴール (左端中央 / 右端中央)
const START_TX = 0, START_TY = 8;   // 左端中央 (開口部)
const GOAL_TX = GRID_W - 1, GOAL_TY = 8; // 右端中央

// タイル種別: 0=通路(path/buildable), 1=壁(wall, 配置・通行不可)
const T_PATH = 0, T_WALL = 1;

// creep (敵)
const CREEP_R = 10;           // 半径10 (描画直径 ~24)
const CREEP_SPEED = 70;       // 70 px/s
const CREEP_HP = 30;          // HP 30
const SPAWN_INTERVAL = 0.5;   // 0.5s ごとにスポーン

// タワー
const TOWER_COST = 25;        // 設置 25 Gold
const TOWER_RANGE = 96;       // 射程 96 px
const TOWER_FIRE_CD = 0.6;    // 連射間隔 0.6 s
const PROJ_DMG = 10;          // 弾ダメージ 10
const PROJ_SPEED = 320;       // 弾速 320 px/s
const PROJ_R = 6;             // 弾半径 6

// 敵数 (負荷)
const CAP_INIT = 30;
const CAP_STEP = 10;
const CAP_MIN = 10;
const CAP_MAX = 500;

// 資源
const GOLD_INIT = 120;
const LIVES_INIT = 20;
const GOLD_KILL = 5;          // 撃破で +5 Gold
const SCORE_KILL = 10;        // 撃破で +10 Score

// フォールバック色 (画像が無い場合の単色図形)
const COLORS = {
  creep: 0xe2402e,   // 敵 = 赤丸
  tower: 0x3f7fd8,   // タワー = 青矩形
  proj:  0xf2d33c,   // 弾 = 黄丸
  path:  0x2a2f3a,   // 通路 = 濃灰
  wall:  0x6b7280,   // 壁 = 灰
  base:  0x3fc463,   // ゴール = 緑
  spark: 0xffffff,   // spark = 白丸
  bg:    0x14181f,
};

// ---- 決定的擬似乱数 (mulberry32) -----------------------------------------
// Math.random は使わない。全エンジン共通の決定的マップ生成のため。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const idx = (tx, ty) => ty * GRID_W + tx;

// ---- マップ決定的生成 ------------------------------------------------------
// 固定シードで全エンジン共通の見た目を狙う。
//   外周を壁で囲み (スタート/ゴールの開口部のみ空ける) + 内部に散らした壁ブロック。
//   スタート→ゴールが必ず通れるよう、生成後に A* で疎通確認し、塞いだ壁を除去する。
function generateMap() {
  const rnd = mulberry32(20250615);
  const map = new Uint8Array(GRID_W * GRID_H); // 既定 0 = 通路

  // --- 外周を壁に ---
  for (let x = 0; x < GRID_W; x++) {
    map[idx(x, 0)] = T_WALL;
    map[idx(x, GRID_H - 1)] = T_WALL;
  }
  for (let y = 0; y < GRID_H; y++) {
    map[idx(0, y)] = T_WALL;
    map[idx(GRID_W - 1, y)] = T_WALL;
  }
  // スタート / ゴールの開口部を空ける (左端中央 / 右端中央)
  map[idx(START_TX, START_TY)] = T_PATH;
  map[idx(GOAL_TX, GOAL_TY)] = T_PATH;

  // --- 内部に決定的な壁ブロックを散らす ---
  // 縦長・横長の小ブロックを撒いて迷路っぽくする。スタート/ゴール周辺は空けておく。
  const blocks = 26;
  for (let i = 0; i < blocks; i++) {
    const bx = 2 + Math.floor(rnd() * (GRID_W - 4));
    const by = 2 + Math.floor(rnd() * (GRID_H - 4));
    const vertical = rnd() < 0.5;
    const len = 2 + Math.floor(rnd() * 4); // 長さ2〜5
    for (let k = 0; k < len; k++) {
      const wx = vertical ? bx : bx + k;
      const wy = vertical ? by + k : by;
      if (wx <= 1 || wx >= GRID_W - 2 || wy <= 1 || wy >= GRID_H - 2) continue;
      // スタート/ゴール開口部の正面は空けておく (詰みを減らす)
      if (wy === START_TY && (wx <= 2 || wx >= GRID_W - 3)) continue;
      map[idx(wx, wy)] = T_WALL;
    }
  }

  // --- 疎通保証: スタート→ゴールが通れるまで、経路を塞ぐ壁を取り除く ---
  // A* が解を返すまで「経路の邪魔になりうる壁」を決定的に間引く素朴ループ。
  let guard = 0;
  while (!aStar(map, START_TX, START_TY, GOAL_TX, GOAL_TY) && guard < 4000) {
    guard++;
    // 中央水平ラインの壁を1つ通路に変える (決定的に左から)
    let removed = false;
    for (let x = 1; x < GRID_W - 1 && !removed; x++) {
      if (map[idx(x, START_TY)] === T_WALL) {
        map[idx(x, START_TY)] = T_PATH;
        removed = true;
      }
    }
    if (!removed) break; // これ以上消せる壁が無い (理論上到達しない)
  }

  return map;
}

// ---- A* 経路探索 -----------------------------------------------------------
// 4方向 (上下左右), コスト1, マンハッタン距離ヒューリスティック。
// blocked(tx,ty) が true のセルは通行不可。壁とタワーの両方を塞ぐために
// 追加の blocked セット (タワー) を渡せるようにしている。
// 返り値: タイル列 [{tx,ty}, ...] (start→goal を含む) / 到達不能なら null。
//
// グリッドが 30x17=510 セルと小さいので、優先度付きキューは
// 「配列を都度 minを線形探索」する素朴版でも十分軽い。性能比較の主眼は
// 「全 creep が一斉に再計算する回数 × セル数」であり、ここを自前で持つことに意味がある。
function aStar(map, sx, sy, gx, gy, towerBlocked) {
  if (map[idx(gx, gy)] === T_WALL) return null;
  const N = GRID_W * GRID_H;
  const came = new Int32Array(N).fill(-1);
  const gScore = new Float32Array(N).fill(Infinity);
  const fScore = new Float32Array(N).fill(Infinity);
  const inOpen = new Uint8Array(N);
  const closed = new Uint8Array(N);

  const startId = idx(sx, sy);
  const goalId = idx(gx, gy);
  const h = (tx, ty) => Math.abs(tx - gx) + Math.abs(ty - gy); // マンハッタン

  gScore[startId] = 0;
  fScore[startId] = h(sx, sy);
  // open リスト (セルID の配列。最小 fScore を線形探索で取り出す)
  const open = [startId];
  inOpen[startId] = 1;

  const isBlocked = (tx, ty) => {
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return true;
    if (map[idx(tx, ty)] === T_WALL) return true;
    if (towerBlocked && towerBlocked.has(idx(tx, ty))) return true;
    return false;
  };

  const DX = [1, -1, 0, 0];
  const DY = [0, 0, 1, -1];

  while (open.length > 0) {
    // open から最小 fScore を取り出す (線形探索 + スワップ削除)
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestI]]) bestI = i;
    }
    const current = open[bestI];
    open[bestI] = open[open.length - 1];
    open.pop();
    inOpen[current] = 0;

    if (current === goalId) {
      // 経路復元
      const path = [];
      let c = current;
      while (c !== -1) {
        path.push({ tx: c % GRID_W, ty: Math.floor(c / GRID_W) });
        c = came[c];
      }
      path.reverse();
      return path;
    }
    closed[current] = 1;
    const cx = current % GRID_W;
    const cy = Math.floor(current / GRID_W);

    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (isBlocked(nx, ny)) continue;
      const nId = idx(nx, ny);
      if (closed[nId]) continue;
      const tentative = gScore[current] + 1;
      if (tentative < gScore[nId]) {
        came[nId] = current;
        gScore[nId] = tentative;
        fScore[nId] = tentative + h(nx, ny);
        if (!inOpen[nId]) { open.push(nId); inOpen[nId] = 1; }
      }
    }
  }
  return null; // 到達不能
}

// ---- フォールバックテクスチャ生成 (Graphics→Texture) ----------------------
// 生成テクスチャはキャッシュして全スプライトで再利用する (v8: generateTexture)。
function makeFallbackTextures(app) {
  const tex = {};
  const g = (w, h, draw) => {
    const gr = new PIXI.Graphics();
    draw(gr);
    const t = app.renderer.generateTexture({ target: gr, width: w, height: h, resolution: 1 });
    gr.destroy();
    return t;
  };

  // 通路タイル: 濃灰 + 薄い枠
  tex.tile_path = g(TILE, TILE, (gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.path);
    gr.rect(0, 0, TILE, TILE).stroke({ width: 1, color: 0x3a4150, alpha: 0.7 });
  });
  // 壁タイル: 灰 + ブロック目地
  tex.tile_wall = g(TILE, TILE, (gr) => {
    gr.rect(0, 0, TILE, TILE).fill(COLORS.wall);
    gr.rect(0, 0, TILE, TILE).stroke({ width: 2, color: 0x4a505c });
    gr.moveTo(0, 16).lineTo(TILE, 16).stroke({ width: 1, color: 0x515866 });
    gr.moveTo(16, 0).lineTo(16, 16).stroke({ width: 1, color: 0x515866 });
    gr.moveTo(8, 16).lineTo(8, 32).stroke({ width: 1, color: 0x515866 });
    gr.moveTo(24, 16).lineTo(24, 32).stroke({ width: 1, color: 0x515866 });
  });
  // 敵 (creep): 24x24 の赤丸
  tex.creep = g(24, 24, (gr) => {
    gr.circle(12, 12, 10).fill(COLORS.creep);
    gr.circle(12, 12, 10).stroke({ width: 2, color: 0x8a1810 });
    gr.circle(8, 9, 2.4).fill(0xffffff);
    gr.circle(16, 9, 2.4).fill(0xffffff);
  });
  // タワー: 32x32 の青矩形 (砲身つき)
  tex.tower = g(TILE, TILE, (gr) => {
    gr.roundRect(4, 4, TILE - 8, TILE - 8, 4).fill(COLORS.tower);
    gr.roundRect(4, 4, TILE - 8, TILE - 8, 4).stroke({ width: 2, color: 0x1c4e9c });
    gr.circle(16, 16, 5).fill(0xcfe2ff);
    gr.rect(15, 2, 2, 10).fill(0x1c4e9c);
  });
  // 弾 (projectile): 12x12 の黄丸
  tex.projectile = g(12, 12, (gr) => {
    gr.circle(6, 6, 5).fill(COLORS.proj);
    gr.circle(6, 6, 5).stroke({ width: 1, color: 0xc9a51e });
  });
  // ゴール (base): 32x32 の緑旗
  tex.base = g(TILE, TILE, (gr) => {
    gr.rect(0, 0, TILE, TILE).fill({ color: COLORS.base, alpha: 0.25 });
    gr.rect(8, 4, 2, 24).fill(0xdfeee0);          // 旗竿
    gr.poly([10, 5, 26, 9, 10, 14]).fill(COLORS.base); // 旗
    gr.rect(0, 0, TILE, TILE).stroke({ width: 2, color: COLORS.base, alpha: 0.8 });
  });
  // spark (撃破エフェクト): 16x16 の白星
  tex.hit_spark = g(16, 16, (gr) => {
    gr.star(8, 8, 5, 7, 3).fill(COLORS.spark);
  });
  return tex;
}

// ---- アセット読込 (失敗時フォールバック) ----------------------------------
// ../assets/ の各画像を PIXI.Assets.load で試行。失敗 (欠落 / CORS) は figure へ。
async function loadTextures(app) {
  const fallback = makeFallbackTextures(app);
  const files = {
    creep:      '../assets/creep.png',
    tower:      '../assets/tower.png',
    projectile: '../assets/projectile.png',
    tile_path:  '../assets/tile_path.png',
    tile_wall:  '../assets/tile_wall.png',
    base:       '../assets/base.png',
    hit_spark:  '../assets/hit_spark.png',
  };
  const tex = { ...fallback };
  for (const [key, url] of Object.entries(files)) {
    try {
      const t = await PIXI.Assets.load(url);
      tex[key] = (t && t.source) ? t : fallback[key];
    } catch (e) {
      tex[key] = fallback[key]; // 画像欠落 → 図形フォールバック
    }
  }
  return tex;
}

// =========================================================================
// メイン
// =========================================================================
(async () => {
  // v8: new Application() 後に await app.init() が必須。
  const app = new PIXI.Application();
  await app.init({
    width: VIEW_W,
    height: VIEW_H,
    background: COLORS.bg,
    antialias: false,
    resolution: 1,     // 性能比較用途のため解像度は 1 固定。
    autoDensity: false,
  });
  // v8: app.view → app.canvas
  document.getElementById('game').appendChild(app.canvas);

  const tex = await loadTextures(app);

  // ---- world: カメラ用コンテナ (本テーマはスクロールしないが慣習に合わせ平行移動可) ----
  const world = new PIXI.Container();
  app.stage.addChild(world);

  // レイヤ (奥→手前): タイル → 経路ハイライト → タワー → creep → 弾 → fx
  const tileLayer = new PIXI.Container();
  const pathLayer = new PIXI.Container();   // 現在経路を薄く重ねる Graphics
  const towerLayer = new PIXI.Container();
  const creepLayer = new PIXI.Container();
  const projLayer = new PIXI.Container();
  const fxLayer = new PIXI.Container();
  world.addChild(tileLayer, pathLayer, towerLayer, creepLayer, projLayer, fxLayer);

  // 経路ハイライト用 Graphics (毎フレーム再描画ではなく経路更新時のみ再描画)
  const pathGfx = new PIXI.Graphics();
  pathLayer.addChild(pathGfx);

  // =====================================================================
  // ゲーム状態 (R リスタートで丸ごと再構築する塊)
  // =====================================================================
  let map;                 // Uint8Array (壁/通路)
  let towers;              // [{tx,ty,cd,sprite,rangeGfx}]
  let towerBlocked;        // Set<cellId> (タワーが塞ぐセル)
  let creeps;              // [{x,y,hp,path,wp,alive,sprite}]
  let projectiles;         // [{x,y,vx,vy,target,alive,sprite}]
  let sparks;              // [{x,y,life,max,sprite}]
  let currentPath;         // 現在のスタート→ゴール経路 (タイル列)
  let pathRecalcs;         // 経路再計算の累計回数 (HUD)
  let gold, lives, score;
  let enemyCap;            // 同時出現上限 (負荷)
  let spawnTimer;          // スポーン間隔タイマ
  let gameOver;

  // ---- タイトル/アトラクト状態 (started=false=デモ中・操作無効) ----
  let started = false, blinkT = 0;
  // デモAI: 決定的な固定座標へ数基自動配置して防衛デモにする (Math.random 不使用)
  const DEMO_TOWERS = [
    [5, 7], [8, 9], [11, 7], [14, 9], [17, 7], [20, 9], [23, 7], [26, 9],
    [5, 9], [8, 7], [11, 9], [14, 7], [17, 9], [20, 7], [23, 9], [26, 7],
  ];
  let demoIdx = 0, demoTimer = 0;
  const titleEl = document.getElementById('title');
  function startGame() { started = true; reset(); titleEl.style.display = 'none'; }
  function demoTick(dt) {
    // 一定間隔で次の候補タイルへタワーを試行設置 (placeTower が不正配置を弾く)
    demoTimer += dt;
    if (demoTimer >= 0.8 && demoIdx < DEMO_TOWERS.length && gold >= TOWER_COST) {
      demoTimer = 0;
      const [tx, ty] = DEMO_TOWERS[demoIdx++];
      placeTower(tx, ty);
    }
  }

  // ---- スプライトプール (creep / projectile / spark は破棄せず再利用) ----
  const creepPool = [];
  const projPool = [];
  const sparkPool = [];

  // タイル描画 (固定。30x17 全タイルをスプライト化して再利用。最大 510 枚)
  const tilePool = [];
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const s = new PIXI.Sprite(tex.tile_path);
    s.width = TILE; s.height = TILE;
    tilePool.push(s);
    tileLayer.addChild(s);
  }
  // ゴール (base) スプライト (固定)
  const baseSprite = new PIXI.Sprite(tex.base);
  baseSprite.width = TILE; baseSprite.height = TILE;
  baseSprite.x = GOAL_TX * TILE; baseSprite.y = GOAL_TY * TILE;
  fxLayer.addChild(baseSprite);

  // タイル種別に応じてテクスチャを貼り直す (マップ生成後 / 壁→不要だが将来用)
  function refreshTiles() {
    for (let ty = 0; ty < GRID_H; ty++) {
      for (let tx = 0; tx < GRID_W; tx++) {
        const s = tilePool[idx(tx, ty)];
        s.texture = (map[idx(tx, ty)] === T_WALL) ? tex.tile_wall : tex.tile_path;
        s.x = tx * TILE; s.y = ty * TILE;
        s.visible = true;
      }
    }
  }

  // ---- プールからの取得ヘルパ ----
  function getCreepSprite() {
    let s = creepPool.pop();
    if (!s) { s = new PIXI.Sprite(tex.creep); s.anchor.set(0.5); s.width = 24; s.height = 24; creepLayer.addChild(s); }
    s.visible = true; s.alpha = 1;
    return s;
  }
  function getProjSprite() {
    let s = projPool.pop();
    if (!s) { s = new PIXI.Sprite(tex.projectile); s.anchor.set(0.5); s.width = 12; s.height = 12; projLayer.addChild(s); }
    s.visible = true;
    return s;
  }
  function getSparkSprite() {
    let s = sparkPool.pop();
    if (!s) { s = new PIXI.Sprite(tex.hit_spark); s.anchor.set(0.5); s.width = 16; s.height = 16; fxLayer.addChild(s); }
    s.visible = true; s.alpha = 1; s.scale.set(1);
    return s;
  }

  // ---- 経路の再計算 (壁 + 全タワーを通行不可として A*) ----
  // 戻り値: 成功なら新経路, 失敗 (到達不能) なら null。
  function computePath() {
    return aStar(map, START_TX, START_TY, GOAL_TX, GOAL_TY, towerBlocked);
  }

  // 経路ハイライトの再描画 (タイル中心を結ぶ薄い線 + 各セルに薄い塗り)
  function redrawPath() {
    pathGfx.clear();
    if (!currentPath || currentPath.length === 0) return;
    // セルを薄く塗る
    for (const c of currentPath) {
      pathGfx.rect(c.tx * TILE + 4, c.ty * TILE + 4, TILE - 8, TILE - 8)
             .fill({ color: 0x5fa8ff, alpha: 0.10 });
    }
    // 中心線
    pathGfx.moveTo(currentPath[0].tx * TILE + TILE / 2, currentPath[0].ty * TILE + TILE / 2);
    for (let i = 1; i < currentPath.length; i++) {
      pathGfx.lineTo(currentPath[i].tx * TILE + TILE / 2, currentPath[i].ty * TILE + TILE / 2);
    }
    pathGfx.stroke({ width: 3, color: 0x5fa8ff, alpha: 0.35 });
  }

  // タイル中心の px 座標
  const cellCenterX = (tx) => tx * TILE + TILE / 2;
  const cellCenterY = (ty) => ty * TILE + TILE / 2;

  // ---- creep を現在地のセルから再経路付け ----
  // タワー設置/撤去で経路が変わった際、各 creep を「いま居るセル」から A* し直す。
  // 経路再計算カウンタを +1。
  function repathCreep(c) {
    const ctx = clamp(Math.floor(c.x / TILE), 0, GRID_W - 1);
    const cty = clamp(Math.floor(c.y / TILE), 0, GRID_H - 1);
    const p = aStar(map, ctx, cty, GOAL_TX, GOAL_TY, towerBlocked);
    pathRecalcs++;
    if (p && p.length > 0) {
      c.path = p;
      // 現在地より先のウェイポイントから追従 (先頭=現在セル中心なので 1 から)
      c.wp = p.length > 1 ? 1 : 0;
    }
    // p が null (理論上は設置拒否済みなので来ない) の場合は既存経路を維持。
  }

  // ---- creep スポーン (スタート地点) ----
  function spawnCreep() {
    if (!currentPath || currentPath.length === 0) return;
    const s = getCreepSprite();
    const c = {
      x: cellCenterX(START_TX),
      y: cellCenterY(START_TY),
      hp: CREEP_HP,
      maxHp: CREEP_HP,
      path: currentPath,
      wp: currentPath.length > 1 ? 1 : 0, // 次に向かうウェイポイント index
      alive: true,
      sprite: s,
    };
    creeps.push(c);
  }

  // ---- creep を殺して回収 (撃破 or ゴール到達) ----
  function killCreep(i, byTower) {
    const c = creeps[i];
    c.alive = false;
    c.sprite.visible = false;
    creepPool.push(c.sprite);
    creeps[i] = creeps[creeps.length - 1];
    creeps.pop();
    if (byTower) {
      gold += GOLD_KILL;
      score += SCORE_KILL;
      spawnSpark(c.x, c.y);
    }
  }

  function spawnSpark(x, y) {
    const s = getSparkSprite();
    s.x = x; s.y = y;
    sparks.push({ x, y, life: 0.3, max: 0.3, sprite: s });
  }

  // ---- タワー設置 (左クリック) ----
  // 通路タイル / Gold 足りる / 経路を塞がない ことを確認して設置。
  function placeTower(tx, ty) {
    if (gameOver) return false;
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
    if (map[idx(tx, ty)] === T_WALL) return false;          // 壁には置けない
    if (towerBlocked.has(idx(tx, ty))) return false;        // 既にタワー
    // スタート/ゴール セルには置かせない (詰み防止)
    if ((tx === START_TX && ty === START_TY) || (tx === GOAL_TX && ty === GOAL_TY)) return false;
    if (gold < TOWER_COST) return false;                    // Gold 不足

    // 仮設置して経路が残るか検証 (塞ぐ配置は拒否)
    towerBlocked.add(idx(tx, ty));
    const newPath = computePath();
    if (!newPath) {
      towerBlocked.delete(idx(tx, ty)); // ロールバック
      return false;
    }

    // 確定: Gold 消費 + スプライト生成
    gold -= TOWER_COST;
    const sprite = new PIXI.Sprite(tex.tower);
    sprite.width = TILE; sprite.height = TILE;
    sprite.x = tx * TILE; sprite.y = ty * TILE;
    towerLayer.addChild(sprite);
    towers.push({ tx, ty, cd: 0, sprite });

    // 経路更新 + 全 creep 再経路付け
    currentPath = newPath;
    pathRecalcs++; // 経路自体の再計算
    redrawPath();
    for (const c of creeps) repathCreep(c);
    return true;
  }

  // ---- タワー撤去 (右クリック) ----
  function removeTower(tx, ty) {
    const i = towers.findIndex((t) => t.tx === tx && t.ty === ty);
    if (i < 0) return false;
    const t = towers[i];
    t.sprite.destroy();
    towers.splice(i, 1);
    towerBlocked.delete(idx(tx, ty));
    // 経路更新 (撤去で必ず解はある) + 全 creep 再経路付け
    currentPath = computePath();
    pathRecalcs++;
    redrawPath();
    for (const c of creeps) repathCreep(c);
    return true;
  }

  // =====================================================================
  // 初期化 / リスタート
  // =====================================================================
  function reset() {
    // 既存スプライトをプールへ退避 (creep / proj / spark / tower)
    if (creeps) for (const c of creeps) { c.sprite.visible = false; creepPool.push(c.sprite); }
    if (projectiles) for (const p of projectiles) { p.sprite.visible = false; projPool.push(p.sprite); }
    if (sparks) for (const sp of sparks) { sp.sprite.visible = false; sparkPool.push(sp.sprite); }
    if (towers) for (const t of towers) t.sprite.destroy();

    map = generateMap();
    refreshTiles();

    towers = [];
    towerBlocked = new Set();
    creeps = [];
    projectiles = [];
    sparks = [];
    pathRecalcs = 0;
    gold = GOLD_INIT;
    lives = LIVES_INIT;
    score = 0;
    enemyCap = CAP_INIT;
    spawnTimer = 0;
    gameOver = false;
    demoIdx = 0; demoTimer = 0;   // デモAIの自動配置進捗もリセット

    currentPath = computePath();
    pathRecalcs++; // 初回計算もカウント
    redrawPath();
  }
  reset();

  // =====================================================================
  // 入力
  // =====================================================================
  // 右クリックメニュー抑止 (SPEC 指定: contextmenu を preventDefault)
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // キャンバス座標 → タイル座標 (CSS スケールを考慮)
  function eventToTile(event) {
    const rect = app.canvas.getBoundingClientRect();
    const sx = VIEW_W / rect.width;   // 表示スケールの逆数
    const sy = VIEW_H / rect.height;
    const px = (event.clientX - rect.left) * sx - world.x;
    const py = (event.clientY - rect.top) * sy - world.y;
    return { tx: Math.floor(px / TILE), ty: Math.floor(py / TILE) };
  }

  // pointerdown: event.button で 0=左 / 2=右 を判別
  app.canvas.addEventListener('pointerdown', (event) => {
    if (!started) return;       // アトラクト中はプレイヤー操作を無効化
    const { tx, ty } = eventToTile(event);
    if (event.button === 0) {
      placeTower(tx, ty);       // 左クリック = 設置
    } else if (event.button === 2) {
      removeTower(tx, ty);      // 右クリック = 撤去
    }
  });

  // キーボード: +/- 敵数上限, R リスタート
  window.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') {
      enemyCap = clamp(enemyCap + CAP_STEP, CAP_MIN, CAP_MAX);
      e.preventDefault();
    } else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      enemyCap = clamp(enemyCap - CAP_STEP, CAP_MIN, CAP_MAX);
      e.preventDefault();
    } else if (e.code === 'KeyR') {
      reset();
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!started) startGame();
    }
  });

  // =====================================================================
  // HUD
  // =====================================================================
  const hudEl = document.getElementById('hud');
  let hudTimer = 0;
  const fpsSamples = [];
  let fpsAvg = 60;

  // =====================================================================
  // メインループ (deltaMS デルタタイム駆動)
  // =====================================================================
  app.ticker.add((ticker) => {
    const dtMs = ticker.deltaMS;
    const dt = Math.min(dtMs / 1000, 0.05); // スパイク抑制

    // --- FPS 移動平均 (直近60フレーム) ---
    const inst = 1000 / Math.max(dtMs, 0.0001);
    fpsSamples.push(inst);
    if (fpsSamples.length > 60) fpsSamples.shift();
    fpsAvg = fpsSamples.reduce((s, v) => s + v, 0) / fpsSamples.length;

    // アトラクト中の敗北はデモをループ再開 (GAME OVER 表示は出さない)
    if (gameOver && !started) reset();
    // アトラクト中はデモAIが決定的にタワーを自動配置して防衛する
    if (!started) demoTick(dt);

    if (!gameOver) {
      // ================================================================
      // 1) スポーン (0.5s ごと / 生存数が上限未満のときのみ供給)
      // ================================================================
      spawnTimer += dt;
      while (spawnTimer >= SPAWN_INTERVAL) {
        spawnTimer -= SPAWN_INTERVAL;
        if (creeps.length < enemyCap) spawnCreep();
      }

      // ================================================================
      // 2) creep 経路追従 (ウェイポイントへ線形移動)
      // ================================================================
      for (let i = creeps.length - 1; i >= 0; i--) {
        const c = creeps[i];
        let remain = CREEP_SPEED * dt;
        // 残り移動量を、現在のウェイポイントへ向けて消費
        while (remain > 0 && c.wp < c.path.length) {
          const wpx = cellCenterX(c.path[c.wp].tx);
          const wpy = cellCenterY(c.path[c.wp].ty);
          const dx = wpx - c.x, dy = wpy - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= remain) {
            // ウェイポイントに到達 → 次へ
            c.x = wpx; c.y = wpy;
            remain -= dist;
            c.wp++;
          } else {
            c.x += (dx / dist) * remain;
            c.y += (dy / dist) * remain;
            remain = 0;
          }
        }
        // ゴール到達 (最終ウェイポイントを消化) → Lives-1 + 消滅
        if (c.wp >= c.path.length) {
          lives -= 1;
          killCreep(i, false);
          if (lives <= 0) { lives = 0; gameOver = true; }
        }
      }

      // ================================================================
      // 3) タワー射撃 (射程内の最進行度敵を狙う)
      // ================================================================
      for (const t of towers) {
        t.cd -= dt;
        if (t.cd > 0) continue;
        const tcx = cellCenterX(t.tx), tcy = cellCenterY(t.ty);
        // 射程内で最もゴールに近い (= path 残り wp が大きい→進行度高い) creep を選ぶ
        let best = null, bestProgress = -1;
        for (const c of creeps) {
          if (!c.alive) continue;
          const dx = c.x - tcx, dy = c.y - tcy;
          if (dx * dx + dy * dy > TOWER_RANGE * TOWER_RANGE) continue;
          // 進行度 = 消化済みウェイポイント数 (大きいほどゴールに近い)
          const progress = c.wp;
          if (progress > bestProgress) { bestProgress = progress; best = c; }
        }
        if (best) {
          // 発射: 弾を best へ向けて直進させる
          const dx = best.x - tcx, dy = best.y - tcy;
          const d = Math.hypot(dx, dy) || 1;
          const s = getProjSprite();
          s.x = tcx; s.y = tcy;
          projectiles.push({
            x: tcx, y: tcy,
            vx: (dx / d) * PROJ_SPEED,
            vy: (dy / d) * PROJ_SPEED,
            target: best,
            alive: true,
            sprite: s,
          });
          t.cd = TOWER_FIRE_CD;
        }
      }

      // ================================================================
      // 4) 弾の直進 + 当たり判定 (距離 < 敵半径 + 弾半径)
      // ================================================================
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        let hit = false;
        // 画面外で消滅
        if (p.x < -20 || p.x > VIEW_W + 20 || p.y < -20 || p.y > GRID_H * TILE + 20) {
          hit = true;
        } else {
          // ターゲットが生存していれば優先判定、それ以外も近接した敵に当てる
          for (let j = 0; j < creeps.length; j++) {
            const c = creeps[j];
            if (!c.alive) continue;
            const dx = c.x - p.x, dy = c.y - p.y;
            const rr = CREEP_R + PROJ_R;
            if (dx * dx + dy * dy <= rr * rr) {
              c.hp -= PROJ_DMG;
              hit = true;
              if (c.hp <= 0) killCreep(j, true);
              break;
            }
          }
        }
        if (hit) {
          p.alive = false;
          p.sprite.visible = false;
          projPool.push(p.sprite);
          projectiles[i] = projectiles[projectiles.length - 1];
          projectiles.pop();
        }
      }
    } // !gameOver

    // ====================================================================
    // 5) スプライト位置反映
    // ====================================================================
    for (const c of creeps) {
      c.sprite.x = c.x; c.sprite.y = c.y;
    }
    for (const p of projectiles) {
      p.sprite.x = p.x; p.sprite.y = p.y;
    }
    // spark (寿命で縮小フェード)
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life -= dt;
      const t = sp.life / sp.max;
      sp.sprite.alpha = clamp(t, 0, 1);
      sp.sprite.scale.set(1 + (1 - t) * 0.8);
      if (sp.life <= 0) {
        sp.sprite.visible = false;
        sparkPool.push(sp.sprite);
        sparks[i] = sparks[sparks.length - 1];
        sparks.pop();
      }
    }

    // ====================================================================
    // 6) HUD (約120msごと更新)
    // ====================================================================
    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const pathLen = currentPath ? currentPath.length : 0;
      hudEl.textContent =
        `FPS          : ${fpsAvg.toFixed(1)}\n` +
        `Enemies      : ${creeps.length} / ${enemyCap}   (+/- で増減, 上限 ${CAP_MAX})\n` +
        `Towers       : ${towers.length}   Projectiles : ${projectiles.length}\n` +
        `Path recalcs : ${pathRecalcs}   Path len : ${pathLen}\n` +
        `Gold : ${gold}   Lives : ${lives}   Score : ${score}` +
        (gameOver && started ? `\n--- GAME OVER ---  R で再開` : ``);
    }

    // タイトル点滅 (約0.45秒周期)
    if (!started) {
      blinkT += dt;
      titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
    }
  });

  // three.js 版と同じく、キャンバスは 960x540 固定で表示する(ウィンドウ追従の
  // 縮小スケーリングはしない)。#game-container 側で上端・横中央に配置される。
  app.canvas.style.width = VIEW_W + 'px';
  app.canvas.style.height = VIEW_H + 'px';

  console.log('[PixiJS v8] theme6 tower-defense init ok. renderer =', app.renderer.type);
})();
