'use strict';

/*
  トップダウン・サバイバー — LittleJS 実装
  --------------------------------------------------------------------------
  SPEC.md（テーマ2）に厳密準拠。
  - 移動 180 px/s（8方向）
  - 自動攻撃: 最も近い敵へ 400ms ごと弾発射、弾速 350 px/s、命中で敵HP-1
  - 敵: 画面外周スポーン、自機へ直進 60〜90 px/s、接触で自機HP-1（無敵0.5s）
  - 敵HP=1（bat:小/速）/3（zombie:大/遅）、撃破で xp_gem ドロップ→取得でKill+1
  - 同時敵数: 初期150、+/-で±50（上限1000）、10秒ごと+25 自動増加
  - 自機HP初期5、0で GAME OVER（R/クリックでリスタート）
  - 当たり判定は円
  - 大量エンティティはプール再利用（EngineObjectは使わず軽量structで自前管理）

  注意: LittleJS は Y軸が「上向き」。ワールド座標は数学系（上が +Y）。
        スポーン/移動計算はそれを前提に行う。
*/

// ----------------------------------------------------------------------------
// 定数（SPEC数値を厳密再現）
// ----------------------------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;
let hudEl = null;   // HTML オーバーレイHUD（#hud）。gameInit で取得。

const PLAYER_SPEED   = 180;     // px/s
const PLAYER_RADIUS  = 18;      // 当たり半径(描画48px相当)
const PLAYER_HP_MAX  = 5;
const PLAYER_INVULN  = 0.5;     // 無敵秒

const ATTACK_INTERVAL = 0.400;  // 400ms
const PROJ_SPEED      = 350;     // px/s
const PROJ_RADIUS     = 8;
const PROJ_LIFETIME   = 3.0;     // 弾の生存秒(自動掃除)

const ENEMY_SPEED_MIN = 60;      // px/s
const ENEMY_SPEED_MAX = 90;      // px/s
const BAT_RADIUS      = 13;      // 32px
const ZOMBIE_RADIUS   = 17;      // 40px
const ZOMBIE_HP       = 3;
const BAT_HP          = 1;

const GEM_RADIUS      = 9;
const GEM_PICKUP_R    = 26;      // 取得半径(自機+gem)

const SPAWN_INIT      = 150;     // 初期同時敵数(目標)
const SPAWN_STEP      = 50;      // +/- 増減
const SPAWN_CAP       = 1000;    // 上限
const SPAWN_AUTO_INT  = 10.0;    // 10秒ごと
const SPAWN_AUTO_ADD  = 25;      // +25
const SPAWN_MARGIN    = 60;      // 画面外周からのスポーンマージン
const SPAWN_PER_FRAME = 12;      // 1フレームの最大スポーン投入(段階補充)

// スケール: ワールド1単位 = 1px とする（cameraScale=1）
const SCALE = 1;

// ----------------------------------------------------------------------------
// アセット定義（imageSources は ../assets/ のSPEC名で指定）
//   読込判定は textureInfos[i].size を見る。未配置/サイズ0なら図形フォールバック。
// ----------------------------------------------------------------------------
const TEX = {
  player: 0,
  bat:    1,
  zombie: 2,
  proj:   3,
  gem:    4,
  ground: 5,
};
const imageSources = [
  '../assets/player_walk.png',
  '../assets/enemy_bat_walk.png',
  '../assets/enemy_zombie_walk.png',
  '../assets/projectile.png',
  '../assets/xp_gem.png',
  '../assets/ground_tile.png',
];

// 各テクスチャが実際に読めたか
function texLoaded(i) {
  return typeof textureInfos !== 'undefined'
    && textureInfos[i]
    && textureInfos[i].size
    && textureInfos[i].size.x > 0
    && textureInfos[i].size.y > 0;
}

// ----------------------------------------------------------------------------
// 軽量エンティティ・プール
//   EngineObject を使わず、フラットな配列＋使用フラグで GC を抑制。
// ----------------------------------------------------------------------------
function makeEnemy() {
  return { active:false, x:0, y:0, vx:0, vy:0, r:BAT_RADIUS, hp:1, big:false, speed:60 };
}
function makeProj() {
  return { active:false, x:0, y:0, vx:0, vy:0, life:0 };
}
function makeGem() {
  return { active:false, x:0, y:0 };
}

class Pool {
  constructor(factory) {
    this.factory = factory;
    this.items = [];      // 全要素（active混在）
    this.count = 0;       // active数
  }
  spawn() {
    // 空きスロットを再利用、無ければ拡張
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      if (!items[i].active) {
        items[i].active = true;
        this.count++;
        return items[i];
      }
    }
    const obj = this.factory();
    obj.active = true;
    items.push(obj);
    this.count++;
    return obj;
  }
  kill(obj) {
    if (obj.active) {
      obj.active = false;
      this.count--;
    }
  }
  reset() {
    for (const o of this.items) o.active = false;
    this.count = 0;
  }
}

// ----------------------------------------------------------------------------
// ゲーム状態
// ----------------------------------------------------------------------------
const game = {
  player: { x:0, y:0, hp:PLAYER_HP_MAX, invuln:0, aimX:0, aimY:1 },
  enemies: new Pool(makeEnemy),
  projs:   new Pool(makeProj),
  gems:    new Pool(makeGem),
  attackTimer: 0,
  autoSpawnTimer: 0,
  spawnTarget: SPAWN_INIT,   // 維持したい同時敵数（上限の意味も兼ねる）
  time: 0,
  kills: 0,
  over: false,
  // タイトル/アトラクト状態（false=デモ中・操作無効）
  started: false,
  blinkT: 0,
  autoT: 0,
  // 実測FPS（移動平均）: timeDeltaは固定ステップなので performance.now() で実測する
  fpsAvg: 60,
  lastFrameMS: 0,
};

const titleEl = (typeof document !== 'undefined') ? document.getElementById('title') : null;

// Enter でデモ→プレイ開始: 新規リセットして操作を有効化、タイトルを消す
function startGame() {
  game.started = true;
  resetGame();
  if (titleEl) titleEl.style.display = 'none';
}

// ----------------------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------------------
function rand(a, b) { return a + Math.random() * (b - a); }

// 円判定（半径合計の二乗で比較）
function hitCircle(ax, ay, ar, bx, by, br) {
  const dx = ax - bx, dy = ay - by;
  const rr = ar + br;
  return dx*dx + dy*dy <= rr*rr;
}

function resetGame() {
  game.player.x = 0;
  game.player.y = 0;
  game.player.hp = PLAYER_HP_MAX;
  game.player.invuln = 0;
  game.player.aimX = 0;
  game.player.aimY = 1;
  game.enemies.reset();
  game.projs.reset();
  game.gems.reset();
  game.attackTimer = 0;
  game.autoSpawnTimer = 0;
  game.spawnTarget = SPAWN_INIT;
  game.time = 0;
  game.kills = 0;
  game.over = false;
  // FPS実測の基準はリセットしない（連続計測を維持）
}

// 画面外周（カメラ＝自機中心）にスポーン位置を求める
function spawnPosition() {
  const px = game.player.x, py = game.player.y;
  const hw = VIEW_W / 2 + SPAWN_MARGIN;
  const hh = VIEW_H / 2 + SPAWN_MARGIN;
  const side = (Math.random() * 4) | 0;
  let x, y;
  if (side === 0)      { x = px - hw; y = py + rand(-hh, hh); } // 左
  else if (side === 1) { x = px + hw; y = py + rand(-hh, hh); } // 右
  else if (side === 2) { x = px + rand(-hw, hw); y = py + hh; } // 上(+Y)
  else                 { x = px + rand(-hw, hw); y = py - hh; } // 下(-Y)
  return { x, y };
}

function spawnOneEnemy() {
  const e = game.enemies.spawn();
  const p = spawnPosition();
  e.x = p.x; e.y = p.y;
  e.big = Math.random() < 0.30;  // 3割を大型
  if (e.big) { e.r = ZOMBIE_RADIUS; e.hp = ZOMBIE_HP; e.speed = rand(ENEMY_SPEED_MIN, (ENEMY_SPEED_MIN+ENEMY_SPEED_MAX)/2); }
  else       { e.r = BAT_RADIUS;    e.hp = BAT_HP;    e.speed = rand((ENEMY_SPEED_MIN+ENEMY_SPEED_MAX)/2, ENEMY_SPEED_MAX); }
  e.vx = 0; e.vy = 0;
}

// ----------------------------------------------------------------------------
// LittleJS コールバック
// ----------------------------------------------------------------------------
function gameInit() {
  hudEl = document.getElementById('hud');
  // 表示サイズ固定（960x540）。既定の全画面拡大を抑止して他エンジンと揃える。
  setCanvasMaxSize(vec2(VIEW_W, VIEW_H));
  setCanvasFixedSize(vec2(VIEW_W, VIEW_H));
  setCameraScale(SCALE);         // 1px = 1 world unit
  setCameraPos(vec2(0, 0));
  // 入力: グリフキー(+/-)もLittleJSのkeyIsDownで拾う
  resetGame();
  // 初期敵をある程度撒いておく（段階補充だと最初がスカスカなので半分投入）
  for (let i = 0; i < SPAWN_INIT >> 1; i++) spawnOneEnemy();
}

function readMoveInput() {
  let dx = 0, dy = 0;
  // WASD / 矢印（LittleJSはY上向き → Wで +Y）
  if (keyIsDown('ArrowLeft')  || keyIsDown('KeyA')) dx -= 1;
  if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) dx += 1;
  if (keyIsDown('ArrowUp')    || keyIsDown('KeyW')) dy += 1;
  if (keyIsDown('ArrowDown')  || keyIsDown('KeyS')) dy -= 1;
  return cardinal(dx, dy);
}

function cardinal(dx, dy) {
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 };
  if (Math.abs(dx) >= Math.abs(dy)) return { dx: Math.sign(dx), dy: 0 };
  return { dx: 0, dy: Math.sign(dy) };
}

function dirFrame(dx, dy) {
  if (dy > 0) return 1;
  if (dx < 0) return 2;
  if (dx > 0) return 3;
  return 0;
}

function walkFrame(dx, dy, moving) {
  return dirFrame(dx, dy) * 4 + (moving ? Math.floor(game.time * 10) % 4 : 0);
}

function handleSpawnKeys() {
  // + : Equal/NumpadAdd（Shift+= も拾えるよう Equal で代用）
  // - : Minus/NumpadSubtract
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd') || keyWasPressed('BracketRight')) {
    game.spawnTarget = Math.min(SPAWN_CAP, game.spawnTarget + SPAWN_STEP);
  }
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract') || keyWasPressed('Slash')) {
    game.spawnTarget = Math.max(0, game.spawnTarget - SPAWN_STEP);
  }
}

function gameUpdate() {
  const dt = timeDelta; // LittleJS: 固定 1/60 のシミュレーションステップ秒

  // タイトル点滅（アトラクト中のみ）
  if (!game.started) {
    game.blinkT += dt;
    if (titleEl) titleEl.style.visibility = (Math.floor(game.blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
  }

  // Enter でデモ→プレイ開始
  if (!game.started && keyWasPressed('Enter')) startGame();

  if (game.over) {
    // アトラクト中の被弾死はデモをループ再開、プレイ中は R/クリックで復帰
    if (!game.started) { resetGame(); }
    else if (keyWasPressed('KeyR') || mouseWasPressed(0)) resetGame();
    return;
  }

  game.time += dt;
  handleSpawnKeys();

  const pl = game.player;

  // --- 移動 ---
  let mv;
  if (!game.started) {
    // デモAI: 累積時間ベースの sin で緩やかに徘徊（決定的）。Y上向き系。
    game.autoT += dt;
    const phase = Math.floor(game.autoT / 1.25) % 4;
    mv = phase === 0 ? { dx: 1, dy: 0 }
      : phase === 1 ? { dx: 0, dy: 1 }
      : phase === 2 ? { dx: -1, dy: 0 }
      : { dx: 0, dy: -1 };
  } else {
    mv = readMoveInput();
  }
  pl.x += mv.dx * PLAYER_SPEED * dt;
  pl.y += mv.dy * PLAYER_SPEED * dt;
  if (mv.dx !== 0 || mv.dy !== 0) { pl.aimX = mv.dx; pl.aimY = mv.dy; }
  if (pl.invuln > 0) pl.invuln -= dt;

  // カメラ追従
  setCameraPos(vec2(pl.x, pl.y));

  // --- 自動増加（10秒ごと +25, 上限まで） ---
  game.autoSpawnTimer += dt;
  if (game.autoSpawnTimer >= SPAWN_AUTO_INT) {
    game.autoSpawnTimer -= SPAWN_AUTO_INT;
    game.spawnTarget = Math.min(SPAWN_CAP, game.spawnTarget + SPAWN_AUTO_ADD);
  }

  // --- 敵スポーン（目標数まで段階補充） ---
  let need = game.spawnTarget - game.enemies.count;
  if (need > SPAWN_PER_FRAME) need = SPAWN_PER_FRAME;
  for (let i = 0; i < need; i++) spawnOneEnemy();

  // --- 敵更新（自機へ直進 + 接触判定） ---
  const enemies = game.enemies.items;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.active) continue;
    let dx = pl.x - e.x, dy = pl.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const ev = cardinal(dx, dy);
    e.x += ev.dx * e.speed * dt;
    e.y += ev.dy * e.speed * dt;
    e.dirX = ev.dx; e.dirY = ev.dy;
    // 自機接触
    if (pl.invuln <= 0 && hitCircle(e.x, e.y, e.r, pl.x, pl.y, PLAYER_RADIUS)) {
      pl.hp -= 1;
      pl.invuln = PLAYER_INVULN;
      if (pl.hp <= 0) { pl.hp = 0; game.over = true; }
    }
  }

  // --- 自動攻撃: 最も近い敵へ 400ms ごと発射 ---
  game.attackTimer -= dt;
  if (game.attackTimer <= 0 && game.enemies.count > 0) {
    // 最近接の敵を探索
    let best = null, bestD2 = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.active) continue;
      const dx = e.x - pl.x, dy = e.y - pl.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    if (best) {
      game.attackTimer = ATTACK_INTERVAL;
      const dx = best.x - pl.x, dy = best.y - pl.y;
      const d = Math.hypot(dx, dy) || 1;
      const p = game.projs.spawn();
      p.x = pl.x; p.y = pl.y;
      p.vx = (dx / d) * PROJ_SPEED;
      p.vy = (dy / d) * PROJ_SPEED;
      p.life = PROJ_LIFETIME;
    }
  }

  // --- 弾更新 + 命中判定 ---
  const projs = game.projs.items;
  for (let i = 0; i < projs.length; i++) {
    const p = projs[i];
    if (!p.active) continue;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) { game.projs.kill(p); continue; }
    // 敵との衝突（最初の1体に当たって消滅）
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (!e.active) continue;
      if (hitCircle(p.x, p.y, PROJ_RADIUS, e.x, e.y, e.r)) {
        e.hp -= 1;
        game.projs.kill(p);
        if (e.hp <= 0) {
          // gemドロップ
          const g = game.gems.spawn();
          g.x = e.x; g.y = e.y;
          game.enemies.kill(e);
        }
        break;
      }
    }
  }

  // --- gem取得 ---
  const gems = game.gems.items;
  for (let i = 0; i < gems.length; i++) {
    const g = gems[i];
    if (!g.active) continue;
    if (hitCircle(g.x, g.y, GEM_RADIUS, pl.x, pl.y, PLAYER_RADIUS + 4)) {
      game.gems.kill(g);
      game.kills += 1;
    }
  }
}

function gameUpdatePost() {}

// ----------------------------------------------------------------------------
// 描画
// ----------------------------------------------------------------------------
function drawGround() {
  // タイル敷き詰め（カメラ範囲のみ）。画像が無ければ単色。
  const pl = game.player;
  const tileSize = 64;
  if (texLoaded(TEX.ground)) {
    const startX = Math.floor((pl.x - VIEW_W/2) / tileSize) - 1;
    const endX   = Math.floor((pl.x + VIEW_W/2) / tileSize) + 1;
    const startY = Math.floor((pl.y - VIEW_H/2) / tileSize) - 1;
    const endY   = Math.floor((pl.y + VIEW_H/2) / tileSize) + 1;
    const ti = tile(0, vec2(tileSize), TEX.ground);
    for (let ty = startY; ty <= endY; ty++)
      for (let tx = startX; tx <= endX; tx++)
        drawTile(vec2(tx*tileSize + tileSize/2, ty*tileSize + tileSize/2), vec2(tileSize), ti);
  } else {
    // 単色背景 + 薄いグリッド（位置感の補助）
    drawRect(vec2(pl.x, pl.y), vec2(VIEW_W + 200, VIEW_H + 200), new Color(0.12, 0.13, 0.18));
    const gridSize = 64;
    const startX = Math.floor((pl.x - VIEW_W/2) / gridSize) - 1;
    const endX   = Math.floor((pl.x + VIEW_W/2) / gridSize) + 1;
    const startY = Math.floor((pl.y - VIEW_H/2) / gridSize) - 1;
    const endY   = Math.floor((pl.y + VIEW_H/2) / gridSize) + 1;
    const gcol = new Color(0.18, 0.19, 0.26);
    for (let tx = startX; tx <= endX; tx++)
      drawRect(vec2(tx*gridSize, pl.y), vec2(1, VIEW_H + 200), gcol);
    for (let ty = startY; ty <= endY; ty++)
      drawRect(vec2(pl.x, ty*gridSize), vec2(VIEW_W + 200, 1), gcol);
  }
}

function drawGem(g) {
  if (texLoaded(TEX.gem)) {
    drawTile(vec2(g.x, g.y), vec2(16), tile(0, vec2(16), TEX.gem));
  } else {
    // 水色菱形（45度回転の矩形）
    drawRect(vec2(g.x, g.y), vec2(GEM_RADIUS*1.4), new Color(0.3, 0.9, 1.0), Math.PI/4);
  }
}

function drawEnemy(e) {
  const frame = walkFrame(e.dirX || 0, e.dirY || 0, true);
  if (e.big) {
    if (texLoaded(TEX.zombie)) { drawTile(vec2(e.x, e.y), vec2(40), tile(frame, vec2(40), TEX.zombie)); return; }
    drawCircle(vec2(e.x, e.y), e.r, new Color(0.3, 0.85, 0.35)); // 緑丸
  } else {
    if (texLoaded(TEX.bat)) { drawTile(vec2(e.x, e.y), vec2(32), tile(frame, vec2(32), TEX.bat)); return; }
    drawCircle(vec2(e.x, e.y), e.r, new Color(0.7, 0.4, 0.95)); // 紫丸
  }
}

function gameRender() {
  drawGround();

  // gem（敵の下層）
  const gems = game.gems.items;
  for (let i = 0; i < gems.length; i++) if (gems[i].active) drawGem(gems[i]);

  // 敵
  const enemies = game.enemies.items;
  for (let i = 0; i < enemies.length; i++) if (enemies[i].active) drawEnemy(enemies[i]);

  // 弾
  const projs = game.projs.items;
  for (let i = 0; i < projs.length; i++) {
    const p = projs[i];
    if (!p.active) continue;
    if (texLoaded(TEX.proj)) drawTile(vec2(p.x, p.y), vec2(24), tile(0, vec2(24), TEX.proj));
    else drawCircle(vec2(p.x, p.y), PROJ_RADIUS, new Color(1.0, 0.95, 0.2)); // 黄
  }

  // 自機（無敵中は点滅）
  const pl = game.player;
  const blink = pl.invuln > 0 && (Math.floor(game.time * 20) % 2 === 0);
  if (!blink) {
    const moving = Math.abs(pl.aimX) + Math.abs(pl.aimY) > 0;
    const frame = walkFrame(pl.aimX, pl.aimY, moving);
    if (texLoaded(TEX.player)) drawTile(vec2(pl.x, pl.y), vec2(48), tile(frame, vec2(48), TEX.player));
    else drawCircle(vec2(pl.x, pl.y), PLAYER_RADIUS, new Color(1, 1, 1)); // 白丸
  }
}

// ----------------------------------------------------------------------------
// HUD（mainContext へ screen-space で直接2D描画）
//   現行LittleJSに overlayCanvas/overlayContext は無い。mainContext を使う。
// ----------------------------------------------------------------------------
function gameRenderPost() {
  // --- 実測FPS（移動平均）: 実フレーム間隔を performance.now() で測る ---
  const now = performance.now();
  if (game.lastFrameMS > 0) {
    const frameMS = now - game.lastFrameMS;
    if (frameMS > 0) {
      const inst = 1000 / frameMS;
      game.fpsAvg = game.fpsAvg * 0.9 + inst * 0.1;
    }
  }
  game.lastFrameMS = now;

  // HUD は他エンジンと同じく HTML オーバーレイ（#hud）。表示内容・書式は three.js に統一。
  const objects = game.enemies.count + game.projs.count + game.gems.count;
  const hp = game.player.hp;
  if (hudEl) hudEl.textContent =
    `FPS     : ${game.fpsAvg.toFixed(1)}\n` +
    `Enemies : ${game.enemies.count}  (cap ${game.spawnTarget})\n` +
    `Objects : ${objects}  (ene ${game.enemies.count} / proj ${game.projs.count} / gem ${game.gems.count})\n` +
    `Time    : ${game.time.toFixed(1)}s   Kills: ${game.kills}\n` +
    `HP      : ${(game.over && game.started) ? 'GAME OVER (R to restart)' : '♥'.repeat(hp) + ' (' + hp + ')'}`;
  // GAME OVER は HUD内に inline 表示（three.js と同様、別演出は持たない）。
}

// ----------------------------------------------------------------------------
// 起動
// ----------------------------------------------------------------------------
// 【重要】WebGL を無効化する。
//   現行LittleJS(1.18系)は WebGL有効時、別DOMの glCanvas を mainCanvas の
//   "上" に重ねて合成する。その場合 gameRenderPost で mainContext(2D) に描く
//   HUD が WebGL スプライトの裏に隠れてしまう。
//   WebGLを切ると全描画が mainContext(2D) に順序通り出るため、HUDが最前面に出る。
//   1000体規模でも Canvas2D バッチで実用域。glEnable は engineInit より前に設定。
glEnable = false;

// 第7引数に #game-container を渡し、960x540 の固定枠内に canvas を生成させて
// 他エンジンと表示サイズ・位置・HUD配置を揃える。
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
