/**
 * グラグラ・タワービルダー (Wobbly Tower Builder)
 * かまた祭展示用 コアゲームロジック
 * 物理演算: Matter.js
 * レンダリング: Custom HTML5 Canvas (レスポンシブ・カメラ追従・パーティクル)
 */

(function() {
  'use strict';

  // --- 定数と設定 ---
  const CONFIG = {
    // 仮想解像度
    VIEW_WIDTH: 480,
    VIEW_HEIGHT: 800,
    
    // 土台
    BASE_WIDTH: 220,
    BASE_HEIGHT: 50,
    BASE_Y: 700,
    
    // ブロック基本寸法
    INITIAL_BLOCK_WIDTH: 150,
    MIN_BLOCK_WIDTH: 75,
    BLOCK_HEIGHT: 36,
    
    // スピードと難易度
    INITIAL_SPEED: 3.2,
    SPEED_INCREMENT: 0.38, // 1段ごとの速度上昇率
    MAX_SPEED: 14.0,
    
    // 物理パラメータ
    BLOCK_FRICTION: 0.75,
    BLOCK_FRICTION_STATIC: 0.95,
    BLOCK_RESTITUTION: 0.08, // 弾みすぎず適度に滑る
    BLOCK_DENSITY: 0.0025,
    GRAVITY_Y: 1.35,

    // クレーンロープ長さ（タワー頂上からの相対距離）
    CRANE_DROP_DISTANCE: 260
  };

  // カラーパレット（サイバーポップ・高校生ウケするグラデーション）
  const COLOR_PALETTES = [
    { fill: '#00f2fe', stroke: '#4facfe', shadow: 'rgba(0, 242, 254, 0.5)' }, // シアン
    { fill: '#ff2a85', stroke: '#ff7396', shadow: 'rgba(255, 42, 133, 0.5)' }, // ピンク
    { fill: '#ffd000', stroke: '#ffe066', shadow: 'rgba(255, 208, 0, 0.5)' },  // イエロー
    { fill: '#00ff88', stroke: '#69ffb4', shadow: 'rgba(0, 255, 136, 0.5)' },  // エメラルド
    { fill: '#b537f2', stroke: '#d47aff', shadow: 'rgba(181, 55, 242, 0.5)' },  // パープル
    { fill: '#ff6b35', stroke: '#ff9068', shadow: 'rgba(255, 107, 53, 0.5)' },  // オレンジ
  ];

  // --- ゲームステート ---
  const state = {
    score: 0,
    bestScore: 0,
    heightMeters: 0,
    gameState: 'ready', // 'ready', 'playing', 'gameover'
    
    // スイング・移動ブロック
    mover: {
      x: CONFIG.VIEW_WIDTH / 2,
      y: CONFIG.BASE_Y - CONFIG.CRANE_DROP_DISTANCE,
      width: CONFIG.INITIAL_BLOCK_WIDTH,
      height: CONFIG.BLOCK_HEIGHT,
      speed: CONFIG.INITIAL_SPEED,
      dir: 1, // 1: 右, -1: 左
      minX: 70,
      maxX: CONFIG.VIEW_WIDTH - 70,
      colorIndex: 0
    },
    
    // 現在落下中のブロック
    fallingBlock: null,
    canDrop: true,

    // カメラ
    cameraY: 0,
    targetCameraY: 0,

    // 画面揺れ（カメラシェイク）
    screenShake: 0,

    // 積み上げ済みブロックのリスト（Body参照）
    stackedBlocks: [],

    // パーティクル & フローティングテキスト
    particles: [],
    popups: [],

    // 安定度評価
    stability: 'stable', // 'stable', 'wobbly', 'danger'
    wobbleIntensity: 0
  };

  // --- DOM要素 ---
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const scoreDisplay = document.getElementById('score-display');
  const heightDisplay = document.getElementById('height-display');
  const bestDisplay = document.getElementById('best-display');
  const balanceBadge = document.getElementById('balance-badge');
  const instructionGuide = document.getElementById('instruction-guide');
  const gameoverModal = document.getElementById('gameover-modal');
  const resultScore = document.getElementById('result-score');
  const resultHeight = document.getElementById('result-height');
  const resultRank = document.getElementById('result-rank');
  const btnRetry = document.getElementById('btn-retry');
  const btnSound = document.getElementById('btn-sound');
  const btnReset = document.getElementById('btn-reset');

  // --- Matter.js モジュール ---
  const { Engine, Bodies, Composite, Events, Body, Vector } = Matter;
  let engine;
  let groundBody;

  // --- ハイスコア初期化 ---
  try {
    const saved = localStorage.getItem('kamata_tower_best');
    if (saved) {
      state.bestScore = parseInt(saved, 10) || 0;
      bestDisplay.textContent = state.bestScore;
    }
  } catch (e) {
    console.warn('LocalStorage not available');
  }

  // --- リサイズ処理（高DPI対応） ---
  let scale = 1;
  function handleResize() {
    const container = document.getElementById('game-container');
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    scale = (rect.width * dpr) / CONFIG.VIEW_WIDTH;
  }
  window.addEventListener('resize', handleResize);

  // --- 物理エンジンの初期化 ---
  function initPhysics() {
    if (engine) {
      Composite.clear(engine.world);
      Engine.clear(engine);
    }

    engine = Engine.create({
      gravity: { x: 0, y: CONFIG.GRAVITY_Y, scale: 0.001 }
    });

    // 土台（動かない静止ブロック）
    groundBody = Bodies.rectangle(
      CONFIG.VIEW_WIDTH / 2,
      CONFIG.BASE_Y,
      CONFIG.BASE_WIDTH,
      CONFIG.BASE_HEIGHT,
      {
        isStatic: true,
        chamfer: { radius: 8 },
        friction: 0.9,
        frictionStatic: 1.0,
        render: { fillStyle: '#2d3748' }
      }
    );
    groundBody.isGround = true;

    Composite.add(engine.world, [groundBody]);

    // 衝突イベント監視
    Events.on(engine, 'collisionStart', handleCollisions);
  }

  // 衝突検知
  function handleCollisions(event) {
    if (state.gameState === 'gameover') return;

    const pairs = event.pairs;
    for (let i = 0; i < pairs.length; i++) {
      const { bodyA, bodyB } = pairs[i];
      const falling = state.fallingBlock;

      if (!falling) continue;

      // 落下中のブロックが何か（土台または既に積まれたブロック）と衝突した場合
      if (bodyA === falling.body || bodyB === falling.body) {
        if (!falling.landed) {
          falling.landed = true;
          const otherBody = (bodyA === falling.body) ? bodyB : bodyA;
          
          // 着地衝撃音
          const impact = Math.abs(falling.body.velocity.y);
          if (window.soundCtrl) window.soundCtrl.playLand(impact);

          // 衝突地点にパーティクル発生
          createSparks(falling.body.position.x, falling.body.position.y + 15, 12, '#00f2fe');

          // 着地判定処理
          onBlockLand(falling, otherBody);
        }
      }
    }
  }

  // ブロック着地時のスコア・ボーナス処理
  function onBlockLand(falling, otherBody) {
    // わずかに物理が落ち着くまで待機してスコア確定
    setTimeout(() => {
      if (state.gameState === 'gameover') return;

      // 奈落に落ちていないか確認
      if (falling.body.position.y > CONFIG.BASE_Y + 100) return;

      // スコア加算
      state.score++;
      scoreDisplay.textContent = state.score;
      if (state.score > state.bestScore) {
        state.bestScore = state.score;
        bestDisplay.textContent = state.bestScore;
        try { localStorage.setItem('kamata_tower_best', state.bestScore); } catch (e) {}
      }

      // 中心ズレ（アライメント）判定
      const centerDist = Math.abs(falling.body.position.x - otherBody.position.x);
      let bonusText = '';
      let pitchMult = 1.0;

      if (centerDist < 6) {
        bonusText = '🌟 PERFECT!!';
        pitchMult = 1.3;
        createFloatingText(bonusText, falling.body.position.x, falling.body.position.y - 20, '#ffd000', 24);
        createSparks(falling.body.position.x, falling.body.position.y, 25, '#ffd000');
        triggerScreenShake(3);
      } else if (centerDist < 16) {
        bonusText = '✨ GREAT!';
        pitchMult = 1.1;
        createFloatingText(bonusText, falling.body.position.x, falling.body.position.y - 20, '#00f2fe', 20);
        createSparks(falling.body.position.x, falling.body.position.y, 15, '#00f2fe');
      } else if (centerDist > 45) {
        // 危ない！
        createFloatingText('⚠️ WOBBLY!', falling.body.position.x, falling.body.position.y - 20, '#ff3860', 18);
        triggerScreenShake(5);
        if (window.soundCtrl) window.soundCtrl.playWobbleWarning();
      }

      if (window.soundCtrl) window.soundCtrl.playSuccess(pitchMult);

      // 積み上げ済みリストへ
      state.stackedBlocks.push(falling.body);
      state.fallingBlock = null;

      // 高さ更新（メートル計算）
      updateHeightAndCamera();

      // 次のブロックの準備
      prepareNextMover();
      state.canDrop = true;
    }, 180);
  }

  // 高さの計算とカメラターゲットの更新
  function updateHeightAndCamera() {
    let topY = CONFIG.BASE_Y;
    state.stackedBlocks.forEach(b => {
      if (b.position.y < topY) {
        topY = b.position.y;
      }
    });

    const pixelHeight = (CONFIG.BASE_Y - topY);
    state.heightMeters = Math.max(0, (pixelHeight / 25).toFixed(1));
    heightDisplay.textContent = `${state.heightMeters}m`;

    // カメラのターゲットY（タワーが高くなるほど上へスクロール）
    // 土台からどれだけ高くなったか
    const elevation = (CONFIG.BASE_Y - topY);
    if (elevation > 150) {
      state.targetCameraY = -(elevation - 150);
    } else {
      state.targetCameraY = 0;
    }

    // クレーンの基準Y位置を頂上から上に配置
    state.mover.y = topY - CONFIG.CRANE_DROP_DISTANCE;
  }

  // 次の投下ブロックのパラメータ決定（難易度エスカレーション）
  function prepareNextMover() {
    // スピード上昇（青天井）
    const newSpeed = Math.min(
      CONFIG.MAX_SPEED,
      CONFIG.INITIAL_SPEED + state.score * CONFIG.SPEED_INCREMENT
    );
    state.mover.speed = newSpeed;

    // ブロック幅の縮小（段数が増えるほど徐々に狭くなる）
    const shrink = Math.min(state.score * 2.5, CONFIG.INITIAL_BLOCK_WIDTH - CONFIG.MIN_BLOCK_WIDTH);
    state.mover.width = CONFIG.INITIAL_BLOCK_WIDTH - shrink;

    // カラーローテーション
    state.mover.colorIndex = state.score % COLOR_PALETTES.length;

    // ガイドをフェードアウト
    if (state.score === 1 && instructionGuide) {
      instructionGuide.classList.add('fade-out');
    }
  }

  // ブロック投下
  function dropBlock() {
    if (state.gameState === 'gameover' || !state.canDrop) return;
    
    // サウンド
    if (window.soundCtrl) {
      window.soundCtrl.init();
      window.soundCtrl.playDrop();
    }

    state.canDrop = false;
    const m = state.mover;
    const palette = COLOR_PALETTES[m.colorIndex];

    // Matter.js 剛体ブロック生成
    const blockBody = Bodies.rectangle(
      m.x,
      m.y,
      m.width,
      m.height,
      {
        chamfer: { radius: 4 },
        friction: CONFIG.BLOCK_FRICTION,
        frictionStatic: CONFIG.BLOCK_FRICTION_STATIC,
        restitution: CONFIG.BLOCK_RESTITUTION,
        density: CONFIG.BLOCK_DENSITY,
        // 横移動の初速を少し引き継がせる（リアルな慣性）
        velocity: { x: m.dir * (m.speed * 0.12), y: 0 }
      }
    );

    blockBody.customColor = palette;
    blockBody.initialWidth = m.width;
    blockBody.initialHeight = m.height;
    blockBody.stackedIndex = state.score + 1;

    Composite.add(engine.world, [blockBody]);

    state.fallingBlock = {
      body: blockBody,
      landed: false,
      dropTime: Date.now()
    };
  }

  // --- ゲームオーバー判定と処理 ---
  function checkGameOverCondition() {
    if (state.gameState === 'gameover') return;

    let collapsed = false;
    const fallThreshold = CONFIG.BASE_Y + 70; // 土台より下へ滑り落ちたらアウト

    // 1. 落下中のブロックが直接画面外・奈落へ落ちた場合
    if (state.fallingBlock) {
      if (state.fallingBlock.body.position.y > fallThreshold) {
        collapsed = true;
      }
    }

    // 2. 既に積まれたタワーのブロックが崩れて落ちた場合
    for (let i = 0; i < state.stackedBlocks.length; i++) {
      const b = state.stackedBlocks[i];
      if (b.position.y > fallThreshold) {
        collapsed = true;
        break;
      }
    }

    if (collapsed) {
      triggerGameOver();
    }
  }

  // ゲームオーバー発火
  function triggerGameOver() {
    if (state.gameState === 'gameover') return;
    state.gameState = 'gameover';

    // 激しいカメラシェイク
    triggerScreenShake(20);

    // 崩壊サウンド
    if (window.soundCtrl) window.soundCtrl.playGameOver();

    // 崩壊パーティクル
    for (let i = 0; i < 40; i++) {
      createSparks(
        CONFIG.VIEW_WIDTH / 2 + (Math.random() - 0.5) * 200,
        CONFIG.BASE_Y + (Math.random() - 0.5) * 50,
        1,
        '#ff2a85'
      );
    }

    // スローモーション演出
    engine.timing.timeScale = 0.4;

    // リザルトモーダル表示
    setTimeout(() => {
      engine.timing.timeScale = 1.0;
      showResultModal();
    }, 600);
  }

  // リザルトモーダルの表示と称号判定
  function showResultModal() {
    resultScore.textContent = state.score;
    resultHeight.textContent = `${state.heightMeters}m`;

    // 高校生向け称号システム
    let rank = '見習いビルダー';
    if (state.score >= 20) {
      rank = '👑 物理演算の神（レジェンド）';
    } else if (state.score >= 15) {
      rank = '🏆 かまたの巨匠アーキテクト';
    } else if (state.score >= 10) {
      rank = '⚡ 重力マスター建築士';
    } else if (state.score >= 6) {
      rank = '🔨 一人前タワー職人';
    } else if (state.score >= 3) {
      rank = '🔰 日曜大工ビルダー';
    } else {
      rank = '🌱 地面とお友達（ビギナー）';
    }
    resultRank.textContent = rank;

    gameoverModal.classList.add('active');
  }

  // ゲームのリセット・再開
  function resetGame() {
    gameoverModal.classList.remove('active');
    state.score = 0;
    state.heightMeters = 0;
    state.gameState = 'playing';
    state.canDrop = true;
    state.fallingBlock = null;
    state.stackedBlocks = [];
    state.particles = [];
    state.popups = [];
    state.cameraY = 0;
    state.targetCameraY = 0;
    state.screenShake = 0;
    state.stability = 'stable';

    scoreDisplay.textContent = '0';
    heightDisplay.textContent = '0.0m';
    updateBalanceBadge('stable', true);

    // スイングパラメータリセット
    state.mover.x = CONFIG.VIEW_WIDTH / 2;
    state.mover.y = CONFIG.BASE_Y - CONFIG.CRANE_DROP_DISTANCE;
    state.mover.width = CONFIG.INITIAL_BLOCK_WIDTH;
    state.mover.speed = CONFIG.INITIAL_SPEED;
    state.mover.dir = 1;
    state.mover.colorIndex = 0;

    initPhysics();
  }

  // --- タワー安定度（グラグラ度）の監視 ---
  function monitorStability() {
    // ゲームオーバー時は更新しない
    if (state.gameState === 'gameover') return;

    // 積み上げブロックがない場合は常にSTABLE
    if (state.stackedBlocks.length === 0) {
      updateBalanceBadge('stable');
      return;
    }

    let maxAngle = 0;
    let maxAngularSpeed = 0;
    let maxOffset = 0;
    const baseCenterX = CONFIG.VIEW_WIDTH / 2;

    // 土台の上にある（落下していない）ブロックのみを対象に評価
    const activeBlocks = state.stackedBlocks.filter(b => b.position.y <= CONFIG.BASE_Y + 10);
    if (activeBlocks.length === 0) {
      updateBalanceBadge('stable');
      return;
    }

    activeBlocks.forEach(b => {
      // 傾き角度（ラジアン）
      const ang = Math.abs(b.angle);
      if (ang > maxAngle) maxAngle = ang;

      // 角速度（回転の揺れ）
      const angSpeed = Math.abs(b.angularVelocity);
      if (angSpeed > maxAngularSpeed) maxAngularSpeed = angSpeed;

      // 土台中心からのズレ
      const offset = Math.abs(b.position.x - baseCenterX);
      if (offset > maxOffset) maxOffset = offset;
    });

    // 判定基準（視覚的直感に合わせた自然な閾値）
    // 傾き約12度以上 or 激しい揺れ or タワーが極端に傾斜
    if (maxAngle > 0.22 || maxAngularSpeed > 0.08 || maxOffset > 100) {
      updateBalanceBadge('danger');
    } else if (maxAngle > 0.09 || maxAngularSpeed > 0.03 || maxOffset > 55) {
      updateBalanceBadge('wobbly');
    } else {
      updateBalanceBadge('stable');
    }

    // 高段数時の微細な風（揺れ演出）
    if (state.score >= 12 && state.gameState === 'playing') {
      const windForce = Math.sin(Date.now() * 0.002) * 0.00008 * Math.min(state.score * 0.1, 1.5);
      state.stackedBlocks.forEach((b, idx) => {
        // 上層ほど風を受けやすい
        if (idx > 5) {
          Body.applyForce(b, b.position, { x: windForce, y: 0 });
        }
      });
    }
  }

  function updateBalanceBadge(status, force = false) {
    if (!force && state.stability === status) return;
    state.stability = status;

    balanceBadge.className = `stability-badge ${status}`;
    if (status === 'stable') {
      balanceBadge.textContent = 'STABLE';
    } else if (status === 'wobbly') {
      balanceBadge.textContent = 'WOBBLY!';
    } else if (status === 'danger') {
      balanceBadge.textContent = 'DANGER!!';
    }
  }

  // --- エフェクト系（パーティクル＆ポップアップ） ---
  function createSparks(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 2;
      state.particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5,
        radius: Math.random() * 3 + 1.5,
        color: color,
        alpha: 1.0,
        decay: Math.random() * 0.03 + 0.02
      });
    }
  }

  function createFloatingText(text, x, y, color, size) {
    state.popups.push({
      text: text,
      x: x,
      y: y,
      color: color,
      size: size,
      alpha: 1.0,
      vy: -1.2,
      scale: 1.3
    });
  }

  function triggerScreenShake(amount) {
    state.screenShake = amount;
  }

  // --- 更新ループ ---
  let lastTime = performance.now();
  function gameLoop(currentTime) {
    requestAnimationFrame(gameLoop);

    const dt = Math.min((currentTime - lastTime) / 1000, 0.1);
    lastTime = currentTime;

    // 物理シミュレーションステップ
    Engine.update(engine, 1000 / 60);

    // カメラのLerp追従
    state.cameraY += (state.targetCameraY - state.cameraY) * 0.08;

    // スクリーンシェイクの減衰
    if (state.screenShake > 0) {
      state.screenShake *= 0.88;
      if (state.screenShake < 0.2) state.screenShake = 0;
    }

    // スイングブロックの移動更新
    if (state.canDrop && state.gameState !== 'gameover') {
      const m = state.mover;
      m.x += m.speed * m.dir;
      if (m.x >= m.maxX) {
        m.x = m.maxX;
        m.dir = -1;
      } else if (m.x <= m.minX) {
        m.x = m.minX;
        m.dir = 1;
      }
    }

    // 崩壊・安定度のチェック
    checkGameOverCondition();
    monitorStability();

    // パーティクルの更新
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // 重力
      p.alpha -= p.decay;
      if (p.alpha <= 0) {
        state.particles.splice(i, 1);
      }
    }

    // ポップアップテキストの更新
    for (let i = state.popups.length - 1; i >= 0; i--) {
      const pop = state.popups[i];
      pop.y += pop.vy;
      pop.alpha -= 0.02;
      if (pop.scale > 1.0) pop.scale -= 0.04;
      if (pop.alpha <= 0) {
        state.popups.splice(i, 1);
      }
    }

    // 描画実行
    render();
  }

  // --- 描画レンダラー ---
  function render() {
    ctx.save();

    // 画面クリア
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 高DPI & 仮想解像度スケーリング
    ctx.scale(scale, scale);

    // カメラトランスフォーム（Y方向パン + シェイク）
    let shakeX = 0;
    let shakeY = 0;
    if (state.screenShake > 0) {
      shakeX = (Math.random() - 0.5) * state.screenShake;
      shakeY = (Math.random() - 0.5) * state.screenShake;
    }
    ctx.translate(shakeX, -state.cameraY + shakeY);

    // 1. 背景グリッド・目盛りの描画
    drawBackground();

    // 2. 土台の描画
    drawGround();

    // 3. 積み上げ済み剛体ブロックの描画
    drawBodies();

    // 4. 投下ガイドラインとクレーンレール
    if (state.canDrop && state.gameState !== 'gameover') {
      drawCraneAndGuide();
    }

    // 5. パーティクルの描画
    drawParticles();

    // 6. フローティングテキストの描画
    drawPopups();

    ctx.restore();
  }

  // 背景描画（サイバー方眼・高度インジケーター）
  function drawBackground() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;

    // 水平グリッド＆高度ライン
    const startY = Math.floor((state.cameraY - 200) / 50) * 50;
    const endY = startY + CONFIG.VIEW_HEIGHT + 400;

    for (let y = startY; y <= endY; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CONFIG.VIEW_WIDTH, y);
      ctx.stroke();

      // 100pxごとの高度ラベル（土台基準）
      const heightVal = Math.max(0, Math.round((CONFIG.BASE_Y - y) / 25));
      if (y < CONFIG.BASE_Y && (CONFIG.BASE_Y - y) % 100 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${heightVal}m`, CONFIG.VIEW_WIDTH - 12, y - 4);
      }
    }
  }

  // 土台の描画
  function drawGround() {
    const gb = groundBody;
    ctx.save();
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;

    // 角丸長方形の描画
    const x = gb.position.x - CONFIG.BASE_WIDTH / 2;
    const y = gb.position.y - CONFIG.BASE_HEIGHT / 2;
    roundRect(ctx, x, y, CONFIG.BASE_WIDTH, CONFIG.BASE_HEIGHT, 8, true, true);

    // 土台上の警告ストライプ
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255, 208, 0, 0.25)';
    ctx.lineWidth = 6;
    for (let sx = -CONFIG.BASE_WIDTH; sx < CONFIG.BASE_WIDTH * 2; sx += 20) {
      ctx.beginPath();
      ctx.moveTo(x + sx, y);
      ctx.lineTo(x + sx + 20, y + CONFIG.BASE_HEIGHT);
      ctx.stroke();
    }
    ctx.restore();

    // 土台中央マーカー
    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gb.position.x, y - 6);
    ctx.lineTo(gb.position.x, y + 6);
    ctx.stroke();

    ctx.restore();
  }

  // Matter.js 剛体ブロック描画
  function drawBodies() {
    const allBodies = Composite.allBodies(engine.world);

    allBodies.forEach(b => {
      if (b.isGround) return;

      const palette = b.customColor || COLOR_PALETTES[0];
      const vertices = b.vertices;

      ctx.save();

      // ネオンシャドウ
      ctx.shadowColor = palette.shadow;
      ctx.shadowBlur = 12;

      // 剛体ポリゴン描画
      ctx.beginPath();
      ctx.moveTo(vertices[0].x, vertices[0].y);
      for (let j = 1; j < vertices.length; j++) {
        ctx.lineTo(vertices[j].x, vertices[j].y);
      }
      ctx.closePath();

      // グラデーション塗りつぶし
      const grad = ctx.createLinearGradient(
        b.position.x - 50, b.position.y - 20,
        b.position.x + 50, b.position.y + 20
      );
      grad.addColorStop(0, palette.fill);
      grad.addColorStop(1, palette.stroke);

      ctx.fillStyle = grad;
      ctx.fill();

      // 輪郭線
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // ブロック中央の段数番号
      if (b.stackedIndex) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${b.stackedIndex}`, b.position.x, b.position.y);
      }

      ctx.restore();
    });
  }

  // クレーンレール、ワイヤー、移動中ブロック、投下ガイド
  function drawCraneAndGuide() {
    const m = state.mover;
    const palette = COLOR_PALETTES[m.colorIndex];

    ctx.save();

    // 1. クレーンレール（天井バー）
    const railY = m.y - 70;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(20, railY);
    ctx.lineTo(CONFIG.VIEW_WIDTH - 20, railY);
    ctx.stroke();

    // レール上のスライダー
    ctx.fillStyle = '#00f2fe';
    ctx.fillRect(m.x - 16, railY - 6, 32, 12);

    // 2. 吊り下げワイヤー
    ctx.strokeStyle = 'rgba(0, 242, 254, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.x, railY + 6);
    ctx.lineTo(m.x, m.y - m.height / 2);
    ctx.stroke();

    // 3. 投下予測ガイドライン（点線）
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(0, 242, 254, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y + m.height / 2);
    ctx.lineTo(m.x, m.y + 350);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4. 移動ブロック本体の描画
    ctx.shadowColor = palette.shadow;
    ctx.shadowBlur = 15;

    const bx = m.x - m.width / 2;
    const by = m.y - m.height / 2;
    const grad = ctx.createLinearGradient(bx, by, bx + m.width, by + m.height);
    grad.addColorStop(0, palette.fill);
    grad.addColorStop(1, palette.stroke);

    ctx.fillStyle = grad;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, m.width, m.height, 4, true, true);

    // 次の段数予告
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${state.score + 1}`, m.x, m.y);

    ctx.restore();
  }

  // パーティクル描画
  function drawParticles() {
    state.particles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // ポップアップテキスト描画
  function drawPopups() {
    state.popups.forEach(pop => {
      ctx.save();
      ctx.globalAlpha = pop.alpha;
      ctx.fillStyle = pop.color;
      ctx.font = `900 ${pop.size * pop.scale}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.shadowColor = pop.color;
      ctx.shadowBlur = 10;
      ctx.fillText(pop.text, pop.x, pop.y);
      ctx.restore();
    });
  }

  // ユーティリティ: 角丸長方形パス
  function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  // --- 入力イベントリスナー ---
  function handleActionInput() {
    if (state.gameState === 'gameover') {
      resetGame();
    } else {
      dropBlock();
    }
  }

  // クリック・タップ
  window.addEventListener('pointerdown', (e) => {
    // ボタンのクリック時は除外
    if (e.target.closest('.hud-controls') || e.target.closest('#btn-retry')) {
      return;
    }
    handleActionInput();
  });

  // キーボード（スペースキー、Enter）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      handleActionInput();
    }
  });

  // サウンドボタン
  btnSound.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.soundCtrl) {
      const isMuted = window.soundCtrl.toggleMute();
      btnSound.textContent = isMuted ? '🔇' : '🔊';
    }
  });

  // リセットボタン
  btnReset.addEventListener('click', (e) => {
    e.stopPropagation();
    resetGame();
  });

  // リトライボタン
  btnRetry.addEventListener('click', (e) => {
    e.stopPropagation();
    resetGame();
  });

  // --- 初期化起動 ---
  handleResize();
  initPhysics();
  state.gameState = 'playing';
  requestAnimationFrame(gameLoop);

  // 外部/自動テスト連携用
  window.__gameInstance = {
    state,
    dropBlock,
    resetGame,
    triggerGameOver
  };

})();
