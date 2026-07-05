/* =========================================================================
 * テーマ7 物理パズル (投擲物理) ― three.js (r184) + Matter.js 実装
 * 仕様: SPEC.md (960x540, 34x34 箱スタック, スリングショット発射, 剛体数スケール)
 *
 * three.js は3D描画ライブラリで、2D剛体物理は内蔵しない。テーマ4/5 の "対" として
 * 本物の剛体ソルバ (接触・スタック・反発・摩擦・スリープ) を比較するのが主題なので、
 * 物理は **matter-js (CDN, PixiJS/Babylon/LittleJS と同一 0.19.0)** に完全委譲する。
 *   - 物理: Matter.Engine (World/Bodies/Body, Matter.Engine.update)
 *   - 描画: OrthographicCamera(0,W,H,0) + THREE.Sprite (renderOrder / depthTest:false)
 *
 * ★ Y軸の扱い (最重要):
 *   - Matter の座標は Y 下向き (画面下が +y / 重力 +y で箱は y 増加方向＝下へ落ちる)。
 *   - three.js の Ortho カメラ(0,W,H,0)は Y 上向き (上端 y=H / 下端 y=0)。
 *   → 描画同期で worldY = H - bodyY に変換する (Matter y が増えると画面では下へ動く)。
 *   → 回転も座標系の向きが逆なので material.rotation = -body.angle と符号反転する。
 *   これで「箱が画面下へ落ちる」「衝突で時計回り/反時計回りが見た目どおり」になる。
 *
 * 毎フレーム: Matter.Engine.update → 各ボディ position/angle を Sprite へ反映。
 * 自前 AABB は一切書かない。
 * =========================================================================*/

import * as THREE from 'three';

// ---- Matter.js モジュール取り出し -----------------------------------------
const { Engine, Bodies, Body, Composite } = Matter;

// ---- 定数 (SPEC) — 他エンジンと同一値 --------------------------------------
const W = 960, H = 540;

const GROUND_H = 48;
const GROUND_TOP_Y = H - GROUND_H;    // 地面上面の Matter y (= 492)
const WALL_T = 40;

const BOX = 34;
const BALL_R = 12;

const GRAVITY_Y = 1.0;
const GRAVITY_SCALE = 0.001;
const BOX_DENSITY = 0.0018;
const BALL_DENSITY = 0.004;
const BOX_FRICTION = 0.6;
const BOX_RESTITUTION = 0.05;
const BALL_RESTITUTION = 0.25;

const SLING_X = 90;
const SLING_Y = GROUND_TOP_Y - 70;    // Matter y
const DRAG_TO_VEL = 0.22;
const MAX_LAUNCH_SPEED = 26;
const CLICK_SPEED = 18;
const MAX_SHOTS = 8;
const AUTO_INTERVAL = 0.8;            // s

const DISPLACE_DIST = 64;
const SCORE_NORMAL = 10;
const SCORE_TARGET = 50;

const BOX_INIT = 60;
const BOX_STEP = 20;
const BOX_MIN = 20;
const BOX_MAX = 600;

const KILL_MARGIN = 200;

const RO = { bg: -10, ground: -5, box: 1, ball: 2 };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Matter y (下向き) → three world y (上向き)
const worldY = (matterY) => H - matterY;

// ---- 決定的擬似乱数 (mulberry32) -----------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASSET_DEFS = {
  box:        '../assets/box.png',
  box_target: '../assets/box_target.png',
  ball:       '../assets/ball.png',
  ground:     '../assets/ground.png',
  slingshot:  '../assets/slingshot.png',
  bg_sky:     '../assets/bg_sky.png',
};

// === シーン/カメラ/レンダラ =================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7ec0ff); // 空色
const camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
camera.position.z = 10;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);            // 性能比較のため DPR=1 固定
renderer.setSize(W, H);
document.getElementById('game-container').appendChild(renderer.domElement);

// === テクスチャ (画像 or canvas フォールバック) =============================
const loader = new THREE.TextureLoader();
const tex = {};
const fbCache = {};

function canvasTexture(name, w, h, drawFn) {
  if (fbCache[name]) return fbCache[name];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  fbCache[name] = t;
  return t;
}
function fbBox() {
  return canvasTexture('box', BOX, BOX, (g) => {
    g.fillStyle = '#b5793a'; g.fillRect(0, 0, BOX, BOX);
    g.strokeStyle = '#7a4e21'; g.lineWidth = 2; g.strokeRect(1, 1, BOX - 2, BOX - 2);
    g.beginPath(); g.moveTo(0, BOX / 2); g.lineTo(BOX, BOX / 2);
    g.moveTo(BOX / 2, 0); g.lineTo(BOX / 2, BOX); g.stroke();
  });
}
function fbBoxTarget() {
  return canvasTexture('boxt', BOX, BOX, (g) => {
    g.fillStyle = '#ff8c1a'; g.fillRect(0, 0, BOX, BOX);
    g.strokeStyle = '#c25e00'; g.lineWidth = 2; g.strokeRect(1, 1, BOX - 2, BOX - 2);
    g.fillStyle = '#fff2a8'; g.beginPath(); g.arc(BOX / 2, BOX / 2, 7, 0, 7); g.fill();
  });
}
function fbBall() {
  return canvasTexture('ball', BALL_R * 2, BALL_R * 2, (g) => {
    g.fillStyle = '#e23b2e'; g.beginPath(); g.arc(BALL_R, BALL_R, BALL_R - 1, 0, 7); g.fill();
    g.strokeStyle = '#8a1810'; g.lineWidth = 2; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.arc(BALL_R - 3, BALL_R - 3, 3, 0, 7); g.fill();
  });
}
function fbGround() {
  return canvasTexture('ground', 64, 64, (g) => {
    g.fillStyle = '#6b8f3a'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#8fbf52'; g.fillRect(0, 0, 64, 8);
  });
}
function fbSling() {
  return canvasTexture('sling', 48, 64, (g) => {
    g.fillStyle = '#8a8f98';
    g.fillRect(20, 24, 8, 40);
    g.lineWidth = 6; g.strokeStyle = '#8a8f98';
    g.beginPath(); g.moveTo(24, 26); g.lineTo(8, 2);
    g.moveTo(24, 26); g.lineTo(40, 2); g.stroke();
  });
}

function makeSprite(texture, w, h, renderOrder) {
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(w, h, 1);
  s.renderOrder = renderOrder;
  return s;
}

(async function main() {
  await Promise.all(Object.entries(ASSET_DEFS).map(async ([key, url]) => {
    try {
      const t = await loader.loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      tex[key] = t;
    } catch (e) { tex[key] = null; console.warn(`[asset] ${url} -> canvas fallback`); }
  }));
  start();
})();

function start() {
  // ====================================================================
  // Matter.js エンジン / ワールド (物理を完全委譲)
  // ====================================================================
  const engine = Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = GRAVITY_Y;
  engine.gravity.scale = GRAVITY_SCALE;
  engine.enableSleeping = true;
  const world = engine.world;

  const staticOpts = { isStatic: true, friction: 0.8, restitution: 0.0, label: 'static' };
  const groundBody = Bodies.rectangle(W / 2, GROUND_TOP_Y + GROUND_H / 2, W, GROUND_H, staticOpts);
  const wallL = Bodies.rectangle(-WALL_T / 2, H / 2, WALL_T, H * 2, staticOpts);
  const wallR = Bodies.rectangle(W + WALL_T / 2, H / 2, WALL_T, H * 2, staticOpts);
  Composite.add(world, [groundBody, wallL, wallR]);

  // ---- 静的な表示 (背景 / 地面 / 発射台) ----
  if (tex.bg_sky) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ map: tex.bg_sky, depthTest: false }));
    m.position.set(W / 2, H / 2, 0); m.renderOrder = RO.bg; scene.add(m);
  }
  {
    const g = makeSprite(tex.ground || fbGround(), W, GROUND_H, RO.ground);
    // 地面の見た目領域: 画面下端から上 GROUND_H。中心 Matter y = GROUND_TOP_Y + GROUND_H/2
    g.position.set(W / 2, worldY(GROUND_TOP_Y + GROUND_H / 2), 0.01); scene.add(g);
  }
  {
    const s = makeSprite(tex.slingshot || fbSling(), 48, 64, RO.ground);
    // anchor 中心。発射台の底を地面上面に合わせる: 中心 Matter y = GROUND_TOP_Y - 32
    s.position.set(SLING_X, worldY(GROUND_TOP_Y - 32), 0.02); scene.add(s);
  }

  // ====================================================================
  // 箱 (剛体スタック)
  // ====================================================================
  const boxes = [];
  let boxSet = 0;

  function computeStackLayout(n) {
    const baseCenterX = 690;
    const gap = 1;
    const step = BOX + gap;
    let baseW = 1;
    while (true) {
      let total = 0;
      for (let w = baseW; w >= 1; w--) total += w;
      if (total >= n || baseW >= 26) break;
      baseW++;
    }
    const positions = [];
    let placed = 0, rowW = baseW, row = 0;
    while (placed < n && rowW >= 1) {
      const rowCount = Math.min(rowW, n - placed);
      const left = baseCenterX - (rowCount * step) / 2 + step / 2;
      const cy = GROUND_TOP_Y - BOX / 2 - row * step;
      for (let c = 0; c < rowCount; c++) { positions.push({ x: left + c * step, y: cy }); placed++; }
      rowW--; row++;
      if (rowW < 1 && placed < n) { rowW = baseW; row = 0; }
    }
    return positions;
  }
  function pickTargets(positions) {
    const rnd = mulberry32(0xA117);
    const targets = new Set();
    if (positions.length === 0) return targets;
    const sorted = positions.map((p, i) => ({ i, y: p.y })).sort((a, b) => a.y - b.y);
    const topPool = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.25)));
    const count = clamp(2 + Math.floor(positions.length / 120), 2, 6);
    for (let k = 0; k < count && topPool.length > 0; k++) {
      const idx = Math.floor(rnd() * topPool.length);
      targets.add(topPool[idx].i); topPool.splice(idx, 1);
    }
    return targets;
  }

  function buildStack(n) {
    for (const b of boxes) { Composite.remove(world, b.body); scene.remove(b.sprite); b.sprite.material.dispose(); }
    boxes.length = 0;
    const positions = computeStackLayout(n);
    const targets = pickTargets(positions);
    const rnd = mulberry32(0x5EED);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const isTarget = targets.has(i);
      const cx = p.x + (rnd() - 0.5) * 0.6;
      const cy = p.y;
      const body = Bodies.rectangle(cx, cy, BOX, BOX, {
        density: BOX_DENSITY, friction: BOX_FRICTION, frictionStatic: 0.8,
        restitution: BOX_RESTITUTION, label: isTarget ? 'target' : 'box', sleepThreshold: 30,
      });
      Composite.add(world, body);
      const sprite = makeSprite(isTarget ? (tex.box_target || fbBoxTarget()) : (tex.box || fbBox()), BOX, BOX, RO.box);
      scene.add(sprite);
      boxes.push({ body, sprite, isTarget, scored: false, x0: cx, y0: cy });
    }
    boxSet = n;
  }
  function setBoxCount(n) { buildStack(clamp(n, BOX_MIN, BOX_MAX)); }

  // ====================================================================
  // 発射体 (プール)
  // ====================================================================
  const balls = [];
  let shotsFired = 0;

  function spawnBall(x, y, vx, vy) {
    if (balls.length >= MAX_SHOTS) {
      const old = balls.shift();
      Composite.remove(world, old.body); scene.remove(old.sprite); old.sprite.material.dispose();
    }
    const body = Bodies.circle(x, y, BALL_R, {
      density: BALL_DENSITY, friction: 0.4, frictionAir: 0.001,
      restitution: BALL_RESTITUTION, label: 'ball', sleepThreshold: 30,
    });
    Body.setVelocity(body, { x: vx, y: vy });
    Composite.add(world, body);
    const sprite = makeSprite(tex.ball || fbBall(), BALL_R * 2, BALL_R * 2, RO.ball);
    scene.add(sprite);
    balls.push({ body, sprite });
    shotsFired++;
  }
  function clearBalls() {
    for (const b of balls) { Composite.remove(world, b.body); scene.remove(b.sprite); b.sprite.material.dispose(); }
    balls.length = 0;
  }

  // ====================================================================
  // スコア / 崩し判定 / 除去
  // ====================================================================
  let score = 0;
  function resetScore() { score = 0; shotsFired = 0; }

  function scanDisplacement() {
    for (const b of boxes) {
      if (b.scored) continue;
      const dx = b.body.position.x - b.x0;
      const dy = b.body.position.y - b.y0;
      if ((dx * dx + dy * dy) >= DISPLACE_DIST * DISPLACE_DIST) {
        b.scored = true; score += b.isTarget ? SCORE_TARGET : SCORE_NORMAL;
      }
    }
  }
  function reapOffWorld() {
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i]; const p = b.body.position;
      const off = p.y > H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > W + KILL_MARGIN;
      if (off && b.body.isSleeping) {
        Composite.remove(world, b.body); scene.remove(b.sprite); b.sprite.material.dispose(); boxes.splice(i, 1);
      }
    }
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i]; const p = b.body.position;
      const off = p.y > H + KILL_MARGIN || p.x < -KILL_MARGIN || p.x > W + KILL_MARGIN;
      if (off) { Composite.remove(world, b.body); scene.remove(b.sprite); b.sprite.material.dispose(); balls.splice(i, 1); }
    }
  }
  function countActive() {
    const all = Composite.allBodies(world);
    let awake = 0;
    for (const b of all) { if (b.isStatic) continue; if (!b.isSleeping) awake++; }
    return awake;
  }

  // ====================================================================
  // タイトル / アトラクト状態
  // ====================================================================
  // started=false … タイトル/デモ中。ユーザー発射操作は無効、デモAIが自動発射。
  // started=true  … 通常プレイ。発射操作が有効。
  let started = false, blinkT = 0;
  let demoT = 0, demoSeq = 0;          // デモ自動発射の累積時間/発射回数 (決定的)
  const DEMO_INTERVAL = 2.0;           // 約2秒ごとにデモ発射
  const titleEl = document.getElementById('title');
  // Enter でデモ→プレイ開始: 新規リセット (R 相当) して操作を有効化、タイトルを消す。
  function startGame() {
    started = true;
    setBoxCount(boxSet); clearBalls(); resetScore();
    titleEl.style.display = 'none';
  }
  // デモAI: 約2秒ごとに角度・強さを変えながら発射体を撃つ (累積時間ベース・決定的)。
  function demoFire(dt) {
    demoT += dt;
    while (demoT >= DEMO_INTERVAL) {
      demoT -= DEMO_INTERVAL;
      const s = demoSeq++;
      const ang = (-58 + 22 * Math.sin(s * 0.9)) * Math.PI / 180; // Matter 座標で上向き右
      const spd = 19 + 5 * Math.sin(s * 1.7);
      spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
    }
  }

  // ====================================================================
  // 入力
  // ====================================================================
  let dragging = false;
  let dragStart = { x: 0, y: 0 };  // Matter 座標 (Y下)
  let dragNow = { x: 0, y: 0 };

  // クライアント座標 → Matter 座標 (Y下・原点左上)。CSS スケール吸収。
  function toMatter(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const sx = W / rect.width, sy = H / rect.height;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (ev) => { dragging = true; dragStart = toMatter(ev); dragNow = { ...dragStart }; });
  window.addEventListener('pointermove', (ev) => { if (dragging) dragNow = toMatter(ev); });
  window.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    if (!started) return;            // アトラクト中はユーザー発射を無効化 (デモAIのみ)
    const end = toMatter(ev);
    const dx = end.x - dragStart.x, dy = end.y - dragStart.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) {
      const ax = end.x - SLING_X, ay = end.y - SLING_Y, a = Math.hypot(ax, ay) || 1;
      spawnBall(SLING_X, SLING_Y, (ax / a) * CLICK_SPEED, (ay / a) * CLICK_SPEED);
    } else {
      let vx = -dx * DRAG_TO_VEL, vy = -dy * DRAG_TO_VEL;
      const sp = Math.hypot(vx, vy);
      if (sp > MAX_LAUNCH_SPEED) { vx = vx / sp * MAX_LAUNCH_SPEED; vy = vy / sp * MAX_LAUNCH_SPEED; }
      spawnBall(SLING_X, SLING_Y, vx, vy);
    }
  });

  let autoShot = false;
  let autoTimer = 0;
  const autoRnd = mulberry32(0xAA70);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && !started) { startGame(); e.preventDefault(); }
    else if (e.code === 'Space') { autoShot = !autoShot; autoTimer = AUTO_INTERVAL; e.preventDefault(); }
    else if (e.key === '+' || e.code === 'NumpadAdd' || e.code === 'Equal') { setBoxCount(boxSet + BOX_STEP); resetScore(); e.preventDefault(); }
    else if (e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus') { setBoxCount(boxSet - BOX_STEP); resetScore(); e.preventDefault(); }
    else if (e.code === 'KeyR') { setBoxCount(boxSet); clearBalls(); resetScore(); e.preventDefault(); }
  });

  // ---- 初期構築 ----
  setBoxCount(BOX_INIT);

  // ====================================================================
  // メインループ
  // ====================================================================
  const hudEl = document.getElementById('hud');
  const clock = new THREE.Clock();
  const fpsSamples = [];
  let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const dtMs = dt * 1000;
    const inst = 1 / Math.max(dt, 1e-4);
    fpsSamples.push(inst); if (fpsSamples.length > 60) fpsSamples.shift();
    const fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;

    // デモAI: アトラクト中 (!started) は約2秒ごとに自動発射して物理デモを見せる
    if (!started) demoFire(dt);

    // オートショット
    if (started && autoShot) {
      autoTimer += dt;
      while (autoTimer >= AUTO_INTERVAL) {
        autoTimer -= AUTO_INTERVAL;
        const t = autoRnd();
        const ang = (-55 + t * 40) * Math.PI / 180; // Matter 座標で上向き右 (vy<0 ＝ 画面上)
        const spd = 18 + autoRnd() * 6;
        spawnBall(SLING_X, SLING_Y, Math.cos(ang) * spd, Math.sin(ang) * spd);
      }
    }

    // 物理1ステップ (Matter に完全委譲)
    Engine.update(engine, Math.min(dtMs, 32));

    scanDisplacement();
    reapOffWorld();

    // Matter ボディ → THREE.Sprite 同期。
    // 位置: worldY = H - bodyY (Matter Y下 → three Y上)。
    // 回転: material.rotation = -body.angle (座標系の向きが逆なので符号反転)。
    for (const b of boxes) {
      const p = b.body.position;
      b.sprite.position.set(p.x, worldY(p.y), b.sprite.renderOrder * 0.001);
      b.sprite.material.rotation = -b.body.angle;
      b.sprite.material.opacity = b.scored ? 0.7 : 1.0;
    }
    for (const b of balls) {
      const p = b.body.position;
      b.sprite.position.set(p.x, worldY(p.y), b.sprite.renderOrder * 0.001);
      b.sprite.material.rotation = -b.body.angle;
    }

    hudTimer += dtMs;
    if (hudTimer >= 120) {
      hudTimer = 0;
      const totalBodies = Composite.allBodies(world).length;
      const active = countActive();
      hudEl.textContent =
        `FPS    : ${fpsAvg.toFixed(1)}\n` +
        `Bodies : ${boxes.length} / ${boxSet}  (total ${totalBodies}, +balls/walls)\n` +
        `Active : ${active}  (awake bodies)\n` +
        `Shots  : ${balls.length} live / ${shotsFired} fired  (max ${MAX_SHOTS})\n` +
        `Score  : ${score}\n` +
        `Engine : Matter (CDN)   Auto: ${autoShot ? 'ON' : 'off'}`;
    }

    renderer.render(scene, camera);

    // タイトル点滅 (約0.45s 周期)
    if (!started) { blinkT += dt; titleEl.style.visibility = (Math.floor(blinkT / 0.45) % 2 === 0) ? 'visible' : 'hidden'; }
  });

  console.log('[three.js + Matter.js] theme7 physics puzzle init ok.');
}
