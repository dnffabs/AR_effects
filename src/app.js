'use strict';

/* =========================================================================
 * 双手 AR 维度裂隙 —— 核心逻辑（立体 Riso 3D 雕刻滤镜优化版）
 * 技术栈：HTML5 / CSS3 / ES6+ / Canvas 2D / MediaPipe Hands / Selfie Segmentation
 * 渲染顺序：摄像头画面 → AR 三层面片 → 人物前景（人物永远遮挡面片）
 * ========================================================================= */

(function () {
  /* ---------- 关键点索引 ---------- */
  const LM = { THUMB: 4, INDEX: 8, MIDDLE: 12 };

  /* ---------- DOM ---------- */
  const video = document.getElementById('cam');
  const stage = document.getElementById('stage');
  const ctx = stage.getContext('2d');
  const btnCamera = document.getElementById('btnCamera');
  const btnDemo = document.getElementById('btnDemo');
  const btnReset = document.getElementById('btnReset');
  const smoothSlider = document.getElementById('smooth');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');

  /* ---------- 离屏画布 ---------- */
  const personCanvas = document.createElement('canvas');
  const personCtx = personCanvas.getContext('2d');
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  // 单层离屏画布（透明）：用于在不污染透明空隙的前提下叠加动态特效
  const layerCanvas = document.createElement('canvas');
  const layerCtx = layerCanvas.getContext('2d');

  /* ---------- 运行状态 ---------- */
  let W = 0, H = 0;            // 画布设备像素尺寸
  let dpr = 1;
  let mode = 'idle';          // 'idle' | 'camera' | 'demo'
  let videoReady = false;
  let stream = null;
  let hands = null;
  let selfie = null;
  let busy = false;
  let latestHands = [];       // 最新手部 landmark（数组，0~2 只手）
  let latestMask = null;      // 最新人物分割 mask
  let oneHandOnly = false;
  let noHand = false;

  /* 覆盖式（cover）映射参数：把视频铺满画布 */
  let offX = 0, offY = 0, drawW = 0, drawH = 0;

  /* ---------- 平滑滤波（One Euro Filter）---------- */
  let currentMinCutoff = 1.4;
  let currentBeta = 0.015;
  const DCUTOFF = 1.0;
  const filters = new Map();

  function OneEuro(minCutoff, beta, dcutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
  OneEuro.prototype.alpha = function (cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  OneEuro.prototype.filter = function (x, t) {
    if (this.tPrev === null) {
      this.tPrev = t;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    let dt = t - this.tPrev;
    if (dt <= 0) dt = 1 / 60;
    this.tPrev = t;
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dcutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  };

  function euro(key, value, t) {
    let f = filters.get(key);
    if (!f) {
      f = new OneEuro(currentMinCutoff, currentBeta, DCUTOFF);
      filters.set(key, f);
    }
    f.minCutoff = currentMinCutoff;
    f.beta = currentBeta;
    return f.filter(value, t);
  }

  function updateSmoothParams() {
    const s = clamp(Number(smoothSlider.value) / 100, 0, 1);
    // s 越大越平滑：minCutoff 越小
    currentMinCutoff = 2.6 - 2.25 * s; // 范围约 [0.35, 2.6]
    currentBeta = 0.02 - 0.012 * s;
  }

  /* ---------- 工具函数 ---------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* =====================================================================
   * 程序化纹理生成（每种风格预渲染一次）
   * ===================================================================== */
  function addGrain(c2d, w, h, amount, alpha) {
    const img = c2d.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amount;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
      if (alpha) d[i + 3] = clamp(d[i + 3] + (Math.random() - 0.5) * alpha, 0, 255);
    }
    c2d.putImageData(img, 0, 0);
  }

  function newTexCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  /* =====================================================================
   * Risograph 半色调肖像叠印风格纹理
   * ===================================================================== */

  // Riso 半色调网点：均匀网格，点大小一致
  function risoDots(cx, S, color, step) {
    var r = step * 0.32;
    cx.fillStyle = color;
    for (var y = step * 0.5; y < S; y += step) {
      for (var x = step * 0.5; x < S; x += step) {
        cx.beginPath();
        cx.arc(x, y, r, 0, Math.PI * 2);
        cx.fill();
      }
    }
  }

  // 油墨颗粒（白色 + 黑色微噪点，模拟印刷不均匀）
  function risoGrain(cx, S) {
    for (var i = 0; i < 6000; i++) {
      cx.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.05).toFixed(3) + ')';
      cx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
    }
    for (var j = 0; j < 3000; j++) {
      cx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.03).toFixed(3) + ')';
      cx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
    }
  }

  // 半透明暖白底膜
  function risoBase(cx, S) {
    cx.globalCompositeOperation = 'source-over';
    cx.globalAlpha = 1;
    cx.fillStyle = 'rgba(248,245,238,0.62)';
    cx.fillRect(0, 0, S, S);
  }

  /* Layer A —— 钴蓝均匀网点 */
  function makeTexA() {
    var S = 512, c = newTexCanvas(S), x = c.getContext('2d');
    risoBase(x, S);
    risoDots(x, S, '#08238c', 7);
    risoGrain(x, S);
    addGrain(x, S, S, 20, 0);
    return c;
  }

  /* Layer B —— 大红均匀网点 */
  function makeTexB() {
    var S = 512, c = newTexCanvas(S), x = c.getContext('2d');
    risoBase(x, S);
    risoDots(x, S, '#e40000', 7);
    risoGrain(x, S);
    addGrain(x, S, S, 20, 0);
    return c;
  }

  var texA = makeTexA();
  var texB = makeTexB();

  /* =====================================================================
   * 实时立体 Riso 3D 浮雕网点人像渲染
   * ===================================================================== */
  var htCanvas = document.createElement('canvas');   // 采样用小画布
  var htCtx = htCanvas.getContext('2d', { willReadFrequently: true });
  // 适当提高采样分辨率以精准捕捉明暗边缘与面部等高线
  var HT_W = 240, HT_H = 180;
  htCanvas.width = HT_W;
  htCanvas.height = HT_H;

  /**
   * 旋转网格立体 Riso 渲染器
   * 采用光影高度场梯度偏移 + 各向异性网点流动
   */
  function drawRisoPortrait3D(targetCtx, ink, dotStep, offsetX, offsetY, angleDegrees) {
    // 1) 把经过抠图的人物缩放到采样画布
    htCtx.clearRect(0, 0, HT_W, HT_H);
    htCtx.drawImage(personCanvas, 0, 0, HT_W, HT_H);
    var imgData = htCtx.getImageData(0, 0, HT_W, HT_H);
    var d = imgData.data;

    // 辅助像素采样函数（带安全边界处理）
    function getPixel(u, v) {
      var tu = Math.max(0, Math.min(HT_W - 1, Math.round(u)));
      var tv = Math.max(0, Math.min(HT_H - 1, Math.round(v)));
      var idx = (tv * HT_W + tu) * 4;
      var a = d[idx + 3];
      var lum = (d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114) / 255;
      return { a: a, lum: lum };
    }

    targetCtx.fillStyle = ink;

    // 2) 设置旋转网格参数
    var angleRad = (angleDegrees || 0) * Math.PI / 180;
    var cosA = Math.cos(angleRad);
    var sinA = Math.sin(angleRad);

    // 寻找覆盖全屏旋转矩阵的对角线安全跨度
    var diag = Math.hypot(W, H);
    var cx = W / 2;
    var cy = H / 2;

    var startI = Math.floor(-diag / 2 / dotStep);
    var endI = Math.ceil(diag / 2 / dotStep);
    var startJ = Math.floor(-diag / 2 / dotStep);
    var endJ = Math.ceil(diag / 2 / dotStep);

    // 3) 在旋转空间中生成网格，防止重现单调的横平竖直数字网点
    for (var j = startJ; j <= endJ; j++) {
      var yRot = j * dotStep;
      for (var i = startI; i <= endI; i++) {
        var xRot = i * dotStep;

        // 逆旋转变换至屏幕坐标系
        var sx = xRot * cosA - yRot * sinA + cx;
        var sy = xRot * sinA + yRot * cosA + cy;

        // 屏幕剪裁过滤
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;

        // 映射屏幕坐标至采样图坐标
        var u = (sx / W) * HT_W;
        var v = (sy / H) * HT_H;

        var p = getPixel(u, v);
        if (p.a < 35) continue; // 剔除背景噪声

        // 4) 3D 高度场重建：计算索贝尔（Sobel）邻域亮度梯度
        var pl = getPixel(u - 1, v);
        var pr = getPixel(u + 1, v);
        var pt = getPixel(u, v - 1);
        var pb = getPixel(u, v + 1);

        var gx = (pr.lum - pl.lum) * 0.5;
        var gy = (pb.lum - pt.lum) * 0.5;
        var gradMag = Math.hypot(gx, gy);

        // 5) 立体厚涂油墨偏移（Chiaroscuro Relief Offset）
        // 模仿厚重油墨在起伏表面发生的偏心堆叠，形成立体感
        var shiftStrength = dotStep * 0.45;
        var shiftX = -gx * shiftStrength;
        var shiftY = -gy * shiftStrength;

        var finalX = sx + shiftX + offsetX;
        var finalY = sy + shiftY + offsetY;

        // 6) 强化明暗对比度（非线性网点增益）
        // 采用二次方曲线，使亮部极其通透、暗部由于网点合并（Dot Gain）形成扎实的阴影面
        var density = Math.pow(1.0 - p.lum, 1.4) * (p.a / 255);
        var maxRadius = dotStep * 0.72; // 网点略微允许交织叠印
        var r = maxRadius * Math.sqrt(density);

        if (r < 0.4) continue;

        // 7) 各向异性网点流动 (Anisotropic Contour Flow)
        // 在边缘、凹凸褶皱处（梯度值高），将网点朝切线（等高线）方向拉伸，强化立体结构
        targetCtx.beginPath();
        if (gradMag > 0.025) {
          // 确定等高线切线角度（与明暗梯度正交）
          var contourAngle = Math.atan2(gx, -gy);
          
          // 根据梯度强度决定拉伸比率
          var stretch = 1.0 + gradMag * 1.8;
          stretch = Math.min(stretch, 2.3); // 限制过度拉伸导致画面过碎

          var rX = r * stretch;
          var rY = r / stretch;

          targetCtx.ellipse(finalX, finalY, rX, rY, contourAngle, 0, Math.PI * 2);
        } else {
          // 绝对平坦区域恢复为完美的饱满圆形，防止产生不自然的伪影
          targetCtx.arc(finalX, finalY, r, 0, Math.PI * 2);
        }
        targetCtx.fill();
      }
    }
  }

  /* =====================================================================
   * 仿射纹理三角形（带轻微外扩消除接缝）
   * ===================================================================== */
  function drawTriangle(c2d, img, t0, t1, t2) {
    const cx = (t0.x + t1.x + t2.x) / 3;
    const cy = (t0.y + t1.y + t2.y) / 3;
    const k = 1.03;
    const x0 = cx + (t0.x - cx) * k, y0 = cy + (t0.y - cy) * k;
    const x1 = cx + (t1.x - cx) * k, y1 = cy + (t1.y - cy) * k;
    const x2 = cx + (t2.x - cx) * k, y2 = cy + (t2.y - cy) * k;
    const u0 = t0.u, v0 = t0.v, u1 = t1.u, v1 = t1.v, u2 = t2.u, v2 = t2.v;

    const den = u0 * (v1 - v2) - u1 * (v0 - v2) + u2 * (v0 - v1);
    if (den === 0) return;
    const a = (x0 * (v1 - v2) - x1 * (v0 - v2) + x2 * (v0 - v1)) / den;
    const b = (y0 * (v1 - v2) - y1 * (v0 - v2) + y2 * (v0 - v1)) / den;
    const cc = (u0 * (x1 - x2) - u1 * (x0 - x2) + u2 * (x0 - x1)) / den;
    const d = (u0 * (y1 - y2) - u1 * (y0 - y2) + u2 * (y0 - y1)) / den;
    const e = (u0 * (v1 * x2 - v2 * x1) - u1 * (v0 * x2 - v2 * x0) + u2 * (v0 * x1 - v1 * x0)) / den;
    const f = (u0 * (v1 * y2 - v2 * y1) - u1 * (v0 * y2 - v2 * y0) + u2 * (v0 * y1 - v1 * y0)) / den;

    c2d.save();
    c2d.beginPath();
    c2d.moveTo(x0, y0);
    c2d.lineTo(x1, y1);
    c2d.lineTo(x2, y2);
    c2d.closePath();
    c2d.clip();
    c2d.setTransform(a, b, cc, d, e, f);
    c2d.drawImage(img, 0, 0);
    c2d.restore();
    c2d.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* 把纹理贴到四个顶点构成的四边形（带网格细分 + 时间扭曲）
   * 顶点映射： p0=左上(0,0) p1=左下(0,1) p2=右下(1,1) p3=右上(1,0) */
  const GRID = 6;
  function drawTexturedQuad(c2d, tex, p0, p1, p2, p3, time, distort) {
    const tw = tex.width, th = tex.height;
    const pts = [];
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const u = i / GRID, v = j / GRID;
        const ax = lerp(p0.x, p3.x, u), ay = lerp(p0.y, p3.y, u);
        const bx = lerp(p1.x, p2.x, u), by = lerp(p1.y, p2.y, u);
        let X = lerp(ax, bx, v);
        let Y = lerp(ay, by, v);
        if (distort > 0) {
          const edge = Math.sin(Math.PI * u) * Math.sin(Math.PI * v); // 中心强、边缘弱
          X += Math.sin(time * 1.7 + u * 6.2 + v * 3.1) * distort * edge;
          Y += Math.cos(time * 1.35 + v * 5.4 + u * 2.0) * distort * edge;
        }
        pts.push({ x: X, y: Y, u: u * tw, v: v * th });
      }
    }
    const row = GRID + 1;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = pts[j * row + i];
        const b = pts[j * row + i + 1];
        const cpt = pts[(j + 1) * row + i];
        const dpt = pts[(j + 1) * row + i + 1];
        drawTriangle(c2d, tex, a, b, cpt);
        drawTriangle(c2d, tex, b, dpt, cpt);
      }
    }
  }

  /* 四边形路径（用于裁剪叠加动态效果）*/
  function quadPath(c2d, p0, p3, p2, p1) {
    c2d.beginPath();
    c2d.moveTo(p0.x, p0.y);
    c2d.lineTo(p3.x, p3.y);
    c2d.lineTo(p2.x, p2.y);
    c2d.lineTo(p1.x, p1.y);
    c2d.closePath();
  }

  function quadBounds(p0, p1, p2, p3) {
    const xs = [p0.x, p1.x, p2.x, p3.x];
    const ys = [p0.y, p1.y, p2.y, p3.y];
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }

  /* =====================================================================
   * 单层面片绘制（纹理 + 风格化动态叠加 + 柔边）
   * corners: {tl,bl,br,tr}
   * ===================================================================== */
  function drawLayer(c2d, tex, corners, style, time) {
    var p0 = corners.tl, p1 = corners.bl, p2 = corners.br, p3 = corners.tr;
    var bnd = quadBounds(p0, p1, p2, p3);
    var diag = Math.hypot(bnd.w, bnd.h);
    var distort = diag * 0.03;

    // ===== 离屏画布构建 Riso 半色调面片 =====
    var lc = layerCtx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1.0;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);

    // ① 四边形填充暖白纸底（覆盖摄像头背景）
    quadPath(lc, p0, p3, p2, p1);
    lc.fillStyle = '#f5f0e6';
    lc.fill();

    // ② 在四边形内叠加背景网格纹理
    lc.save();
    lc.globalCompositeOperation = 'source-atop';
    lc.globalAlpha = 0.7;
    drawTexturedQuad(lc, tex, p0, p1, p2, p3, time, distort);
    lc.globalAlpha = 1.0;
    lc.restore();

    // ③ 人物 3D 立体 Riso 半色调肖像
    if (mode === 'camera' && videoReady && latestMask) {
      var mproc = processMask(latestMask);
      if (mproc) {
        // 在 personCanvas 上合成人物抠图
        personCtx.setTransform(1, 0, 0, 1, 0, 0);
        personCtx.clearRect(0, 0, W, H);
        personCtx.globalCompositeOperation = 'source-over';
        blitCoverMirror(personCtx, mproc);
        personCtx.globalCompositeOperation = 'source-in';
        blitCoverMirror(personCtx, video);
        personCtx.globalCompositeOperation = 'source-over';

        // 在四边形内画高立体度 Riso 半色调人像
        lc.save();
        lc.globalCompositeOperation = 'source-atop';
        var ink = style === 'A' ? '#08238c' : '#c82020';
        var offAmt = 2.5; // 轻微的套印错位
        var ox = style === 'A' ? -offAmt : offAmt;
        var oy = style === 'A' ? offAmt : -offAmt;

        // 为两张网屏分别赋予特定的旋转角度（例如 15° 和 75°）
        // 这样可以避免两层网点叠加时产生生硬的摩尔干涉条纹，反而形成经典的艺术叠印图案
        var screenAngle = style === 'A' ? 15 : 75;
        
        // 动态网点大小：根据屏幕高宽智能缩放网格跨度
        var dynamicDotStep = Math.max(7, Math.min(W, H) / 95);

        drawRisoPortrait3D(lc, ink, dynamicDotStep, ox, oy, screenAngle);
        lc.restore();
      }
    }

    // 合成到主画布
    c2d.save();
    c2d.globalAlpha = 0.94;
    c2d.globalCompositeOperation = 'source-over';
    c2d.setTransform(1, 0, 0, 1, 0, 0);
    c2d.drawImage(layerCanvas, 0, 0);
    c2d.restore();
  }

  /* 指尖能量光点 */
  function drawFingerGlow(pts, time) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const all = [
      [pts.left.thumb, '180,60,60'], [pts.left.index, '120,200,255'],
      [pts.left.middle, '150,220,160'],
      [pts.right.thumb, '180,60,60'], [pts.right.index, '120,200,255'],
      [pts.right.middle, '150,220,160'],
    ];
    const pulse = 0.6 + 0.4 * Math.sin(time * 4.0);
    for (let i = 0; i < all.length; i++) {
      const p = all[i][0], col = all[i][1];
      const r = 14 * (0.7 + 0.3 * pulse);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(' + col + ',0.55)');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* =====================================================================
   * 坐标映射（镜像 + cover）
   * ===================================================================== */
  function setCoverForVideo() {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.max(W / vw, H / vh);
    drawW = vw * scale;
    drawH = vh * scale;
    offX = (W - drawW) / 2;
    offY = (H - drawH) / 2;
  }
  function setCoverForDemo() {
    offX = 0; offY = 0; drawW = W; drawH = H;
  }

  function toScreen(lx, ly) {
    const X = offX + lx * drawW;
    const Y = offY + ly * drawH;
    return { x: W - X, y: Y }; // 水平镜像
  }

  /* 镜像 cover 方式把图像铺满目标上下文 */
  function blitCoverMirror(c2d, img) {
    c2d.save();
    c2d.translate(W, 0);
    c2d.scale(-1, 1);
    c2d.drawImage(img, offX, offY, drawW, drawH);
    c2d.restore();
  }

  /* =====================================================================
   * 取得当前双手关键点（带左右判定 + 滤波）
   * ===================================================================== */
  function avgScreenX(lm) {
    const p = lm[LM.INDEX] || lm[0];
    return toScreen(p.x, p.y).x;
  }

  function getCameraHands(t) {
    const lms = latestHands;
    noHand = !lms || lms.length === 0;
    oneHandOnly = lms && lms.length === 1;
    if (!lms || lms.length < 2) return null;

    // 取前两只手，按屏幕 x 判定左右（x 更小=左手）
    const a = lms[0], b = lms[1];
    let leftLm, rightLm;
    if (avgScreenX(a) <= avgScreenX(b)) { leftLm = a; rightLm = b; }
    else { leftLm = b; rightLm = a; }

    return {
      left: filterHand('L', leftLm, t),
      right: filterHand('R', rightLm, t),
    };
  }

  function filterHand(side, lm, t) {
    function pt(idx) {
      const p = lm[idx];
      const fx = euro(side + '_' + idx + '_x', p.x, t);
      const fy = euro(side + '_' + idx + '_y', p.y, t);
      return toScreen(fx, fy);
    }
    return { thumb: pt(LM.THUMB), index: pt(LM.INDEX), middle: pt(LM.MIDDLE) };
  }

  /* 演示模式：合成双手数据 */
  function getDemoHands(t) {
    noHand = false;
    oneHandOnly = false;

    function hand(side, baseX) {
      const sgn = side === 'L' ? 1 : -1;
      const bx = baseX + 0.035 * Math.sin(t * 0.7 + sgn);
      const by = 0.5 + 0.06 * Math.sin(t * 0.9 + sgn * 1.3);
      const spread = 0.085 + 0.03 * Math.sin(t * 1.3 + sgn);
      const tilt = 0.05 * Math.sin(t * 1.1 + sgn);

      function f(order, wig) {
        const nx = bx + sgn * (0.02 + 0.018 * Math.sin(t * 2.4 + wig)) + order * tilt;
        const ny = by + order * spread + 0.012 * Math.sin(t * 3.1 + wig);
        const fx = euro(side + '_d_' + wig + '_x', nx, t);
        const fy = euro(side + '_d_' + wig + '_y', ny, t);
        return toScreen(fx, fy);
      }
      return { thumb: f(1, 0), index: f(0, 1), middle: f(-1, 2) };
    }
    return { left: hand('L', 0.3), right: hand('R', 0.7) };
  }

  /* 由双手关键点构建三层四边形角点 */
  function buildCorners(h) {
    const L = h.left, R = h.right;
    return {
      A: { tl: L.thumb, bl: L.index, br: R.index, tr: R.thumb },
      B: { tl: L.index, bl: L.middle, br: R.middle, tr: R.index },
    };
  }

  /* =====================================================================
   * 人物前景（摄像头模式真实分割）
   * ===================================================================== */
  function processMask(mask) {
    const mw = mask.width, mh = mask.height;
    if (!mw || !mh) return null;
    if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw;
      maskCanvas.height = mh;
    }
    maskCtx.clearRect(0, 0, mw, mh);
    maskCtx.drawImage(mask, 0, 0, mw, mh);
    const im = maskCtx.getImageData(0, 0, mw, mh);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i]; // 灰度 ≈ R 通道，人物=亮
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = a;
    }
    maskCtx.putImageData(im, 0, 0);
    return maskCanvas;
  }

  function drawPersonForeground() {
    if (!latestMask) return;
    const mproc = processMask(latestMask);
    if (!mproc) return;
    personCtx.setTransform(1, 0, 0, 1, 0, 0);
    personCtx.clearRect(0, 0, W, H);
    personCtx.globalCompositeOperation = 'source-over';
    blitCoverMirror(personCtx, mproc);
    personCtx.globalCompositeOperation = 'source-in';
    blitCoverMirror(personCtx, video);
    personCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(personCanvas, 0, 0);
  }

  /* 演示模式：合成人物前景剪影（验证遮挡逻辑）*/
  function drawDemoForeground(t) {
    const cx = W * (0.5 + 0.16 * Math.sin(t * 0.5));
    const cy = H * 0.62;
    const u = Math.min(W, H);
    ctx.save();
    ctx.fillStyle = '#0b0d12';
    // 躯干
    ctx.beginPath();
    ctx.moveTo(cx - u * 0.16, H);
    ctx.quadraticCurveTo(cx - u * 0.2, cy, cx - u * 0.1, cy - u * 0.05);
    ctx.lineTo(cx + u * 0.1, cy - u * 0.05);
    ctx.quadraticCurveTo(cx + u * 0.2, cy, cx + u * 0.16, H);
    ctx.closePath();
    ctx.fill();
    // 头
    ctx.beginPath();
    ctx.arc(cx, cy - u * 0.14, u * 0.085, 0, Math.PI * 2);
    ctx.fill();
    // 边缘光
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(120,160,200,0.25)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy - u * 0.14, u * 0.085, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* =====================================================================
   * 背景绘制
   * ===================================================================== */
  function drawDarkBg(t) {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    g.addColorStop(0, '#11141d');
    g.addColorStop(0.7, '#080a10');
    g.addColorStop(1, '#040406');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 缓慢漂移的网格星点
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#9fb6d6';
    const step = Math.max(48, Math.min(W, H) / 14);
    const off = (t * 12) % step;
    for (let yy = -step; yy < H + step; yy += step) {
      for (let xx = -step; xx < W + step; xx += step) {
        ctx.fillRect(xx + off, yy + off, 1.4, 1.4);
      }
    }
    ctx.restore();
  }

  /* =====================================================================
   * 主渲染循环
   * ===================================================================== */
  function render(now) {
    const t = now * 0.001;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 1) 摄像头画面 / 背景（含人像，均作为背景层）
    if (mode === 'camera' && videoReady) {
      blitCoverMirror(ctx, video);
    } else {
      drawDarkBg(t);
      if (mode === 'demo') drawDemoForeground(t); // 演示人像作为背景，会被面片盖住
    }

    // 2) AR 三层面片 —— 渲染在最顶层，覆盖其后方的背景与人像
    let h = null;
    if (mode === 'camera') h = getCameraHands(t);
    else if (mode === 'demo') h = getDemoHands(t);

    if (h) {
      const corners = buildCorners(h);
      drawLayer(ctx, texB, corners.B, 'B', t); // 蓝（后）
      drawLayer(ctx, texA, corners.A, 'A', t); // 红（前）
      drawFingerGlow(h, t);
    }

    // 4) 状态提示
    updateStatus();

    // 5) 喂帧给 MediaPipe（摄像头模式）
    if (mode === 'camera') pump();

    requestAnimationFrame(render);
  }

  function updateStatus() {
    if (mode === 'idle') {
      setStatus('点击「启动摄像头」或「演示模式」开始');
      return;
    }
    if (mode === 'demo') {
      setStatus('演示模式运行中');
      return;
    }
    if (noHand) setStatus('请伸开双手进入画面');
    else if (oneHandOnly) setStatus('仅检测到一只手，请伸出双手');
    else setStatus('双手已锁定 · 移动手指拉出维度裂隙');
  }

  let lastStatus = '';
  function setStatus(s) {
    if (s === lastStatus) return;
    lastStatus = s;
    statusEl.textContent = s;
  }

  /* =====================================================================
   * MediaPipe 推理喂帧
   * ===================================================================== */
  async function pump() {
    if (busy || !videoReady || !hands || !selfie) return;
    if (video.readyState < 2) return;
    busy = true;
    try {
      await hands.send({ image: video });
      await selfie.send({ image: video });
    } catch (e) {
      /* 单帧失败忽略 */
    }
    busy = false;
  }

  /* =====================================================================
   * 摄像头 + MediaPipe 初始化
   * ===================================================================== */
  function mpAvailable() {
    return typeof window.Hands === 'function' && typeof window.SelfieSegmentation === 'function';
  }

  async function initMediaPipe() {
    if (hands && selfie) return true;
    hands = new window.Hands({
      locateFile: (file) =>
        'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/' + file,
    });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    hands.onResults((r) => { latestHands = r.multiHandLandmarks || []; });

    selfie = new window.SelfieSegmentation({
      locateFile: (file) =>
        'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/' + file,
    });
    selfie.setOptions({ modelSelection: 1 });
    selfie.onResults((r) => { latestMask = r.segmentationMask; });
    return true;
  }

  async function startCamera() {
    hideError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
        !window.requestAnimationFrame) {
      showError('当前浏览器不支持所需 API，请使用最新版 Chrome / Edge。');
      return;
    }
    if (window.__mpLoadError || !mpAvailable()) {
      showError('MediaPipe 模型加载失败，请检查网络连接后刷新重试。');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      handleCameraError(e);
      return;
    }

    try {
      video.srcObject = stream;
      await video.play();
    } catch (e) {
      showError('摄像头画面无法播放，请刷新页面重试。');
      return;
    }

    try {
      await initMediaPipe();
    } catch (e) {
      showError('MediaPipe 模型初始化失败，请检查网络后刷新重试。');
      stopStream();
      return;
    }

    setCoverForVideo();
    videoReady = true;
    mode = 'camera';
    latestHands = [];
    latestMask = null;
    setActive(btnCamera, true);
    setActive(btnDemo, false);
    setStatus('摄像头已启动，正在加载模型…');
  }

  function handleCameraError(e) {
    const name = e && e.name ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      showError('摄像头权限被拒绝，请在浏览器地址栏允许摄像头权限后重试。');
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError' ||
               name === 'DevicesNotFoundError') {
      showError('未检测到摄像头，请连接摄像头设备后重试。');
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      showError('摄像头被占用，请关闭其他正在使用摄像头的程序后重试。');
    } else {
      showError('摄像头启动失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  function startDemo() {
    hideError();
    stopStream();
    videoReady = false;
    latestHands = [];
    latestMask = null;
    mode = 'demo';
    setCoverForDemo();
    setActive(btnDemo, true);
    setActive(btnCamera, false);
  }

  function resetAll() {
    hideError();
    stopStream();
    videoReady = false;
    latestHands = [];
    latestMask = null;
    filters.clear();
    mode = 'idle';
    setActive(btnDemo, false);
    setActive(btnCamera, false);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((tr) => tr.stop());
      stream = null;
    }
    if (video) {
      try { video.pause(); } catch (e) {}
      video.srcObject = null;
    }
  }

  function setActive(btn, on) {
    if (on) btn.classList.add('active');
    else btn.classList.remove('active');
  }

  /* ---------- 错误提示 ---------- */
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }
  function hideError() {
    errorEl.classList.add('hidden');
  }

  /* =====================================================================
   * 尺寸 / DPI 自适应
   * ===================================================================== */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(window.innerWidth * dpr);
    H = Math.round(window.innerHeight * dpr);
    stage.width = W;
    stage.height = H;
    stage.style.width = window.innerWidth + 'px';
    stage.style.height = window.innerHeight + 'px';
    personCanvas.width = W;
    personCanvas.height = H;
    layerCanvas.width = W;
    layerCanvas.height = H;
    if (mode === 'demo' || mode === 'idle') setCoverForDemo();
    else setCoverForVideo();
  }

  /* =====================================================================
   * 事件绑定 / 启动
   * ===================================================================== */
  btnCamera.addEventListener('click', startCamera);
  btnDemo.addEventListener('click', startDemo);
  btnReset.addEventListener('click', resetAll);
  smoothSlider.addEventListener('input', updateSmoothParams);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  updateSmoothParams();
  resize();
  requestAnimationFrame(render);
})();