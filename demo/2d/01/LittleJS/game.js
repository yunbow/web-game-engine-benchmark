'use strict';

/*
  弾幕STG (縦スクロールシューティング) - LittleJS 実装
  仕様書: ../SPEC.md に厳密準拠。

  座標系メモ:
    LittleJS のワールドは Y が上向き。
    cameraScale = 1 (1 ワールド単位 = 1px), camera 中心 = (480, 270)。
    よって可視範囲は x:[0,960], y:[0,540]。
    画面下 = Y 小、画面上 = Y 大。
      - 自機は下部 (Y 小)
      - 敵は上 (Y 大) から出現し下方向 (Y 減少) へ移動
*/

// ---- 画面・定数 (SPEC) ----
const SCREEN_W = 960;
const SCREEN_H = 540;

const PLAYER_SPEED = 300;          // 自機移動 px/s (8方向)
const PLAYER_BULLET_SPEED = 600;   // 自機弾速 px/s 上方向
const FIRE_INTERVAL = 0.150;       // 連射間隔 150ms
const ENEMY_BULLET_SPEED = 200;    // 敵弾速 px/s
const ENEMY_SPEED_MIN = 80;        // 敵 下方向 速度
const ENEMY_SPEED_MAX = 140;
const ENEMY_FIRE_MIN = 1.2;        // 敵の発射間隔(秒)レンジ
const ENEMY_FIRE_MAX = 2.6;

const PLAYER_RADIUS = 14;
const PLAYER_BULLET_RADIUS = 6;
const ENEMY_SMALL_RADIUS = 18;
const ENEMY_BIG_RADIUS = 38;
const ENEMY_BULLET_RADIUS = 7;

const START_HP = 3;
const SCORE_PER_KILL = 10;

let maxEnemies = 40;               // 同時最大敵数 (初期40)
const MAX_ENEMY_CAP = 300;
const ENEMY_STEP = 10;

// ---- 状態 ----
let player;
let playerBullets = [];
let enemies = [];
let enemyBullets = [];
let explosions = [];

let score = 0;
let hp = START_HP;
let fireTimer = 0;
let invuln = 0;                    // 被弾後の無敵時間

// ---- タイトル/アトラクト状態 (false=デモ中・操作無効・デモAIが自機を駆動) ----
let started = false;
let blinkT = 0;
let autoT = 0;
const titleEl = () => document.getElementById('title');

// アセット有無フラグ (imageSources の読み込み結果で判定)
let useSprites = false;

// HUD 用 FPS 移動平均
let fpsAvg = 60;
const hudEl = () => document.getElementById('hud');

// ---- アセット ----
// SPEC のファイル名に厳密一致。../assets/ から読み込む。
// 画像が無くても起動するよう、tile index を後で安全に参照する。
const imageSources = [
  '../assets/player_ship.png',  // 0
  '../assets/enemy_small.png',  // 1
  '../assets/enemy_big.png',    // 2
  '../assets/bullet_player.png',// 3
  '../assets/bullet_enemy.png', // 4
  '../assets/explosion.png',    // 5
  '../assets/bg_space.png',     // 6
];
const TEX = {
  player: 0, enemySmall: 1, enemyBig: 2,
  bulletPlayer: 3, bulletEnemy: 4, explosion: 5, bg: 6,
};

// ---- ヘルパ ----
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function rand(a, b) { return a + Math.random() * (b - a); }

// テクスチャが実際に読み込めたか (幅>0) を判定。失敗時は矩形/円フォールバック。
function spriteReady(texIndex) {
  if (!useSprites) return false;
  const list = (typeof textureInfos !== 'undefined') ? textureInfos : null;
  if (!list || !list[texIndex]) return false;
  const ti = list[texIndex];
  return !!(ti && ti.size && ti.size.x > 1 && ti.size.y > 1);
}

// 円判定
function circleHit(ax, ay, ar, bx, by, br) {
  const dx = ax - bx, dy = ay - by, r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

// ---- エンティティ ----
function spawnEnemy() {
  const big = Math.random() < 0.25;
  enemies.push({
    x: rand(40, SCREEN_W - 40),
    y: SCREEN_H + rand(20, 120),   // 画面上 (Y 大) から
    vy: -rand(ENEMY_SPEED_MIN, ENEMY_SPEED_MAX), // 下方向 = Y 減少
    big,
    r: big ? ENEMY_BIG_RADIUS : ENEMY_SMALL_RADIUS,
    hpUnit: big ? 3 : 1,
    fireTimer: rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX),
  });
}

function enemyShoot(e) {
  // 自機方向へ
  const dx = player.x - e.x, dy = player.y - e.y;
  const len = Math.hypot(dx, dy) || 1;
  enemyBullets.push({
    x: e.x, y: e.y,
    vx: dx / len * ENEMY_BULLET_SPEED,
    vy: dy / len * ENEMY_BULLET_SPEED,
  });
}

function addExplosion(x, y, big) {
  explosions.push({ x, y, t: 0, life: 0.35, r: big ? 48 : 28 });
}

// ===================================================================
//  LittleJS コールバック
// ===================================================================
function gameInit() {
  // 固定キャンバス 960x540（表示も960x540に固定して他エンジンと揃える。
  // 既定ではウィンドウ全体に拡大表示されるため maxSize を 960x540 に制限）
  setCanvasMaxSize(vec2(SCREEN_W, SCREEN_H));
  setCanvasFixedSize(vec2(SCREEN_W, SCREEN_H));
  setCameraScale(1);
  setCameraPos(vec2(SCREEN_W / 2, SCREEN_H / 2));
  setGravity(vec2(0, 0));

  // どれか1つでもテクスチャが正常に読めていればスプライトを使う
  useSprites = false;
  if (typeof textureInfos !== 'undefined' && textureInfos.length) {
    for (let i = 0; i < imageSources.length; i++) {
      const ti = textureInfos[i];
      if (ti && ti.size && ti.size.x > 1 && ti.size.y > 1) { useSprites = true; break; }
    }
  }

  player = { x: SCREEN_W / 2, y: 70, r: PLAYER_RADIUS };
  playerBullets = []; enemies = []; enemyBullets = []; explosions = [];
  score = 0; hp = START_HP; fireTimer = 0; invuln = 0;
}

// Enter でデモ→プレイ開始: ゲームを新規リセットして操作を有効化、タイトルを消す
function resetGame() {
  player = { x: SCREEN_W / 2, y: 70, r: PLAYER_RADIUS };
  playerBullets = []; enemies = []; enemyBullets = []; explosions = [];
  score = 0; hp = START_HP; fireTimer = 0; invuln = 0;
  maxEnemies = 40;
}
function startGame() {
  started = true;
  resetGame();
  const el = titleEl();
  if (el) el.style.display = 'none';
}

function gameUpdate() {
  const dt = timeDelta;             // デルタタイム基準

  // Enter でデモ→プレイ開始
  if (!started && keyWasPressed('Enter')) startGame();

  if (hp <= 0) {                    // 被弾死
    if (!started) {                 // アトラクト中はデモをループ再開 (GAME OVER 表示なし)
      resetGame();
    } else {                        // 通常プレイ: R で再開
      if (keyWasPressed('KeyR')) { resetGame(); }
      handleEnemyCountKeys();
      return;
    }
  }

  // --- 最大敵数調整 ---
  handleEnemyCountKeys();

  // --- 自機移動 (8方向 + 画面内クランプ) ---
  let mx = 0, my = 0;
  if (!started) {
    // デモAI: 累積時間の sin で緩やかに左右＋上下移動 (決定的・Math.random 不使用)
    autoT += dt;
    mx = Math.cos(autoT * 0.8);
    my = 0;
  } else {
    if (keyIsDown('ArrowLeft') || keyIsDown('KeyA')) mx -= 1;
    if (keyIsDown('ArrowRight') || keyIsDown('KeyD')) mx += 1;
    if (keyIsDown('ArrowDown') || keyIsDown('KeyS')) my -= 1; // 画面下 = Y 減
    if (keyIsDown('ArrowUp') || keyIsDown('KeyW')) my += 1;   // 画面上 = Y 増
  }
  if (mx && my) { const n = Math.SQRT1_2; mx *= n; my *= n; }
  player.x = clamp(player.x + mx * PLAYER_SPEED * dt, player.r, SCREEN_W - player.r);
  player.y = clamp(player.y + my * PLAYER_SPEED * dt, player.r, SCREEN_H - player.r);

  // --- オート連射 (150ms) ---
  fireTimer -= dt;
  if (fireTimer <= 0) {
    fireTimer += FIRE_INTERVAL;
    playerBullets.push({ x: player.x, y: player.y + player.r, vy: PLAYER_BULLET_SPEED });
  }

  // --- スポーン (同時最大数まで補充) ---
  while (enemies.length < maxEnemies) spawnEnemy();

  // --- 自機弾更新 ---
  for (let i = playerBullets.length - 1; i >= 0; i--) {
    const b = playerBullets[i];
    b.y += b.vy * dt;
    if (b.y > SCREEN_H + 20) playerBullets.splice(i, 1);
  }

  // --- 敵更新 + 敵弾発射 ---
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    e.y += e.vy * dt;
    e.fireTimer -= dt;
    if (e.fireTimer <= 0) { enemyShoot(e); e.fireTimer = rand(ENEMY_FIRE_MIN, ENEMY_FIRE_MAX); }
    if (e.y < -e.r - 40) enemies.splice(i, 1); // 画面下に抜けた
  }

  // --- 敵弾更新 ---
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.x < -20 || b.x > SCREEN_W + 20 || b.y < -20 || b.y > SCREEN_H + 20)
      enemyBullets.splice(i, 1);
  }

  // --- 当たり判定: 自機弾 × 敵 ---
  for (let i = playerBullets.length - 1; i >= 0; i--) {
    const b = playerBullets[i];
    let hit = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (circleHit(b.x, b.y, PLAYER_BULLET_RADIUS, e.x, e.y, e.r)) {
        hit = true;
        e.hpUnit -= 1;
        if (e.hpUnit <= 0) {
          addExplosion(e.x, e.y, e.big);
          enemies.splice(j, 1);
          score += SCORE_PER_KILL;
        }
        break;
      }
    }
    if (hit) playerBullets.splice(i, 1);
  }

  if (invuln > 0) invuln -= dt;

  // --- 当たり判定: 敵弾 × 自機 ---
  if (invuln <= 0) {
    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i];
      if (circleHit(b.x, b.y, ENEMY_BULLET_RADIUS, player.x, player.y, player.r)) {
        enemyBullets.splice(i, 1);
        damagePlayer();
        break;
      }
    }
  }
  // --- 当たり判定: 敵 × 自機 ---
  if (invuln <= 0) {
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (circleHit(e.x, e.y, e.r, player.x, player.y, player.r)) {
        addExplosion(e.x, e.y, e.big);
        enemies.splice(j, 1);
        damagePlayer();
        break;
      }
    }
  }

  // --- エフェクト更新 ---
  for (let i = explosions.length - 1; i >= 0; i--) {
    const ex = explosions[i];
    ex.t += dt;
    if (ex.t >= ex.life) explosions.splice(i, 1);
  }
}

function damagePlayer() {
  hp -= 1;
  invuln = 1.0; // 1秒無敵
  addExplosion(player.x, player.y, false);
}

function handleEnemyCountKeys() {
  // '+' は通常 Shift+'=' なので Equal / NumpadAdd 両対応
  if (keyWasPressed('Equal') || keyWasPressed('NumpadAdd'))
    maxEnemies = clamp(maxEnemies + ENEMY_STEP, 0, MAX_ENEMY_CAP);
  if (keyWasPressed('Minus') || keyWasPressed('NumpadSubtract'))
    maxEnemies = clamp(maxEnemies - ENEMY_STEP, 0, MAX_ENEMY_CAP);
}

function gameUpdatePost() {}

// ===================================================================
//  描画 (ワールド空間)
// ===================================================================
function gameRender() {
  // 背景: bg_space.png があればタイル、無ければ暗色矩形
  if (spriteReady(TEX.bg)) {
    drawTile(vec2(SCREEN_W / 2, SCREEN_H / 2), vec2(SCREEN_W, SCREEN_H), tile(0, 512, TEX.bg));
  } else {
    drawRect(vec2(SCREEN_W / 2, SCREEN_H / 2), vec2(SCREEN_W, SCREEN_H), new Color(0.03, 0.03, 0.09));
    // 簡易星
    drawStars();
  }

  // 敵
  for (const e of enemies) {
    const tex = e.big ? TEX.enemyBig : TEX.enemySmall;
    if (spriteReady(tex)) {
      const px = e.big ? 96 : 48;
      drawTile(vec2(e.x, e.y), vec2(px, px), tile(0, px, tex));
    } else {
      drawCircle(vec2(e.x, e.y), e.r, e.big ? new Color(1, 0.4, 0.2) : new Color(1, 0.25, 0.25));
    }
  }

  // 自機弾
  for (const b of playerBullets) {
    if (spriteReady(TEX.bulletPlayer)) {
      drawTile(vec2(b.x, b.y), vec2(16, 24), tile(0, vec2(16, 24), TEX.bulletPlayer));
    } else {
      drawCircle(vec2(b.x, b.y), PLAYER_BULLET_RADIUS, new Color(1, 1, 0.3));
    }
  }

  // 敵弾
  for (const b of enemyBullets) {
    if (spriteReady(TEX.bulletEnemy)) {
      drawTile(vec2(b.x, b.y), vec2(16, 16), tile(0, 16, TEX.bulletEnemy));
    } else {
      drawCircle(vec2(b.x, b.y), ENEMY_BULLET_RADIUS, new Color(1, 0.5, 1));
    }
  }

  // 自機 (無敵中は点滅)
  const blink = invuln > 0 && (Math.floor(invuln * 20) % 2 === 0);
  if (!blink) {
    if (spriteReady(TEX.player)) {
      drawTile(vec2(player.x, player.y), vec2(64, 64), tile(0, 64, TEX.player));
    } else {
      drawPlayerTriangle();
    }
  }

  // 爆発
  for (const ex of explosions) {
    const k = ex.t / ex.life;
    if (spriteReady(TEX.explosion)) {
      const c = new Color(1, 1, 1, 1 - k);
      drawTile(vec2(ex.x, ex.y), vec2(ex.r * 2, ex.r * 2), tile(0, 64, TEX.explosion), c);
    } else {
      drawCircle(vec2(ex.x, ex.y), ex.r * (0.4 + k), new Color(1, 0.7, 0.2, 1 - k));
    }
  }

  // ゲームオーバー (通常プレイ時のみ。アトラクト中はデモをループ再開するため非表示)
  if (hp <= 0 && started) {
    drawRect(vec2(SCREEN_W / 2, SCREEN_H / 2), vec2(SCREEN_W, SCREEN_H), new Color(0, 0, 0, 0.55));
    drawText('GAME OVER', vec2(SCREEN_W / 2, SCREEN_H / 2 + 30), 48, new Color(1, 0.3, 0.3));
    drawText('Press R to restart', vec2(SCREEN_W / 2, SCREEN_H / 2 - 30), 22, new Color(1, 1, 1));
  }
}

// 水色三角 (上向き) フォールバック
function drawPlayerTriangle() {
  const x = player.x, y = player.y, r = player.r;
  const c = new Color(0.4, 0.9, 1);
  // 三角を3本線で
  const top = vec2(x, y + r * 1.3);
  const bl = vec2(x - r, y - r);
  const br = vec2(x + r, y - r);
  drawLine(top, bl, 3, c);
  drawLine(top, br, 3, c);
  drawLine(bl, br, 3, c);
}

// 星(フォールバック背景)。フレーム非依存の静的レイアウト。
let _stars = null;
function drawStars() {
  if (!_stars) {
    _stars = [];
    for (let i = 0; i < 80; i++)
      _stars.push({ x: Math.random() * SCREEN_W, y: Math.random() * SCREEN_H, s: rand(1, 2.5) });
  }
  const c = new Color(0.7, 0.7, 0.8, 0.8);
  for (const st of _stars) drawRect(vec2(st.x, st.y), vec2(st.s, st.s), c);
}

function gameRenderPost() {
  // FPS 移動平均
  const inst = frameRate || (timeDelta > 0 ? 1 / timeDelta : 60);
  fpsAvg += (inst - fpsAvg) * 0.1;

  const pb = playerBullets.length, eb = enemyBullets.length;
  const en = enemies.length, fx = explosions.length;
  const objCount = pb + eb + en + fx;
  const el = hudEl();
  if (el) {
    // 表示内容は three.js に統一
    el.textContent =
      'FPS     : ' + fpsAvg.toFixed(1) + '\n' +
      'Objects : ' + objCount + '  (bul ' + (pb + eb) + ' / ene ' + en + ' / fx ' + fx + ')\n' +
      'Score   : ' + score + '\n' +
      'HP      : ' + (hp > 0 ? '♥'.repeat(hp) + ' (' + hp + ')' : 'GAME OVER') + '\n' +
      'MaxEnemy: ' + maxEnemies + '  (+/- to change, cap ' + MAX_ENEMY_CAP + ')';
  }

  // --- タイトル点滅 (約0.45秒周期) ---
  const tEl = titleEl();
  if (!started && tEl) {
    blinkT += timeDelta;
    tEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden';
  }
}

// ===================================================================
//  起動: engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources, rootElement)
//  第7引数に #game-container を渡し、960x540 の固定枠内に canvas を生成させて
//  他エンジンと表示サイズ・位置を揃える（既定の document.body 全画面拡大を回避）。
// ===================================================================
engineInit(gameInit, gameUpdate, gameUpdatePost, gameRender, gameRenderPost, imageSources,
  document.getElementById('game-container'));
