'use strict';

/* =========================================================================
 * 双手 AR 维度裂隙 —— 核心逻辑
 * 技术栈：HTML5 / CSS3 / ES6+ / Canvas 2D / MediaPipe Hands / Selfie Segmentation
 * 渲染顺序：摄像头画面 → AR 三层面片 → 人物前景（人物永远遮挡面片）
 * ========================================================================= */

(function () {
  /* ---------- 关键点索引 ---------- */
  const LM = { THUMB: 4, INDEX: 8, MIDDLE: 12, PINKY: 20 };

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

  /* 通用网点（halftone / 波点）纹理：网点之间为透明，可透出背景。
   * tint  : 极淡底色（rgba），保留一点色彩；可为 null 完全透明
   * ink   : 网点主色
   * core  : 较大网点的深色内核（增加层次，可为 null）
   * step  : 网点间距 */
  function makeHalftone(tint, ink, core, step) {
    const S = 512;
    const c = newTexCanvas(S);
    const x = c.getContext('2d');
    if (tint) {
      x.fillStyle = tint;
      x.fillRect(0, 0, S, S);
    }
    const st = step || 16;
    for (let yy = st * 0.5; yy < S + st; yy += st) {
      for (let xx = st * 0.5; xx < S + st; xx += st) {
        let v = 0.5
          + 0.30 * Math.sin(xx * 0.017 + yy * 0.011)
          + 0.26 * Math.sin(xx * 0.043 - yy * 0.029 + 1.2)
          + 0.16 * Math.sin((xx + yy) * 0.061);
        v += (Math.random() - 0.5) * 0.22;
        v = clamp(v, 0, 1);
        const r = st * 0.62 * Math.sqrt(v);
        if (r < 0.4) continue;
        x.fillStyle = ink;
        x.beginPath();
        x.arc(xx, yy, r, 0, Math.PI * 2);
        x.fill();
        if (core && r > st * 0.34) {
          x.fillStyle = core;
          x.beginPath();
          x.arc(xx, yy, r * 0.46, 0, Math.PI * 2);
          x.fill();
        }
      }
    }
    addGrain(x, S, S, 16, 0); // 仅扰动已有网点像素，透明空隙保持透明
    return c;
  }

  /* Layer A —— 深红网点 */
  function makeTexA() {
    return makeHalftone('rgba(70,14,16,0.12)', '#a8242a', '#2c0708', 16);
  }

  /* Layer B —— 蓝色网点 */
  function makeTexB() {
    return makeHalftone('rgba(16,38,68,0.12)', '#2a86b3', '#0a1f44', 15);
  }

  /* Layer C —— 绿色网点 */
  function makeTexC() {
    return makeHalftone('rgba(34,56,36,0.12)', '#4a8a50', '#123018', 17);
  }

  const texA = makeTexA();
  const texB = makeTexB();
  const texC = makeTexC();

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
    const p0 = corners.tl, p1 = corners.bl, p2 = corners.br, p3 = corners.tr;
    const bnd = quadBounds(p0, p1, p2, p3);
    const diag = Math.hypot(bnd.w, bnd.h);
    const distort = diag * 0.03;

    // 在透明离屏画布上构建本层：网点之间保持透明，叠加特效用 source-atop 只作用于网点
    const lc = layerCtx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1.0;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);

    drawTexturedQuad(lc, tex, p0, p1, p2, p3, time, distort);

    // 风格化动态叠加（裁剪到四边形内）
    lc.save();
    quadPath(lc, p0, p3, p2, p1);
    lc.clip();

    if (style === 'A') {
      // 仅作用在网点上（source-atop），不填满透明空隙
      lc.globalCompositeOperation = 'source-atop';
      const gy = bnd.minY + ((time * 22) % (bnd.h + 60)) - 30;
      const sweep = lc.createLinearGradient(0, gy - 40, 0, gy + 40);
      sweep.addColorStop(0, 'rgba(40,8,10,0)');
      sweep.addColorStop(0.5, 'rgba(40,8,10,0.35)');
      sweep.addColorStop(1, 'rgba(40,8,10,0)');
      lc.fillStyle = sweep;
      lc.fillRect(bnd.minX - 20, bnd.minY - 40, bnd.w + 40, bnd.h + 80);
    } else if (style === 'B') {
      // 移动亮扫描带 + 偶发故障，仅作用在网点上
      lc.globalCompositeOperation = 'source-atop';
      const by = bnd.minY + ((time * 120) % (bnd.h + 80)) - 40;
      const band = lc.createLinearGradient(0, by - 26, 0, by + 26);
      band.addColorStop(0, 'rgba(120,230,255,0)');
      band.addColorStop(0.5, 'rgba(150,240,255,0.28)');
      band.addColorStop(1, 'rgba(120,230,255,0)');
      lc.fillStyle = band;
      lc.fillRect(bnd.minX - 20, bnd.minY - 40, bnd.w + 40, bnd.h + 80);
      if (Math.sin(time * 7.0) > 0.86) {
        lc.fillStyle = 'rgba(255,40,70,0.16)';
        const gy2 = bnd.minY + Math.abs(Math.sin(time * 11.0)) * bnd.h;
        lc.fillRect(bnd.minX - 6, gy2, bnd.w + 12, 6);
        lc.fillStyle = 'rgba(40,255,200,0.16)';
        lc.fillRect(bnd.minX - 6 + 4, gy2 + 3, bnd.w + 12, 6);
      }
    } else {
      // 绿色微闪，仅作用在网点上
      lc.globalCompositeOperation = 'source-atop';
      const sx = Math.sin(time * 1.2) * 3;
      const sg = lc.createLinearGradient(bnd.minX, 0, bnd.minX + bnd.w, 0);
      sg.addColorStop(0, 'rgba(220,235,190,0.10)');
      sg.addColorStop(0.5 + sx * 0.01, 'rgba(160,190,140,0.04)');
      sg.addColorStop(1, 'rgba(30,55,36,0.12)');
      lc.fillStyle = sg;
      lc.fillRect(bnd.minX - 20, bnd.minY - 20, bnd.w + 40, bnd.h + 40);
    }
    lc.restore();

    // 柔和边缘：描边（source-atop 仅描在已有网点边缘，避免实心轮廓填满空隙）
    lc.save();
    lc.globalCompositeOperation = 'source-atop';
    quadPath(lc, p0, p3, p2, p1);
    lc.lineJoin = 'round';
    lc.lineWidth = Math.max(1.5, diag * 0.012);
    lc.strokeStyle =
      style === 'A' ? 'rgba(255,170,150,0.5)' :
      style === 'B' ? 'rgba(160,240,255,0.5)' :
      'rgba(190,225,170,0.45)';
    lc.stroke();
    lc.restore();

    // 把整层以半透明方式合成到主画布（透出一点背景），并保持在最顶层
    c2d.save();
    c2d.globalAlpha = 0.8;
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
      [pts.left.middle, '150,220,160'], [pts.left.pinky, '200,200,160'],
      [pts.right.thumb, '180,60,60'], [pts.right.index, '120,200,255'],
      [pts.right.middle, '150,220,160'], [pts.right.pinky, '200,200,160'],
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
    return { thumb: pt(LM.THUMB), index: pt(LM.INDEX), middle: pt(LM.MIDDLE), pinky: pt(LM.PINKY) };
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
        // order: 1.5(thumb) 0.5(index) -0.5(middle) -1.5(pinky)
        const nx = bx + sgn * (0.02 + 0.018 * Math.sin(t * 2.4 + wig)) + order * tilt;
        const ny = by + order * spread + 0.012 * Math.sin(t * 3.1 + wig);
        const fx = euro(side + '_d_' + wig + '_x', nx, t);
        const fy = euro(side + '_d_' + wig + '_y', ny, t);
        return toScreen(fx, fy);
      }
      return { thumb: f(1.5, 0), index: f(0.5, 1), middle: f(-0.5, 2), pinky: f(-1.5, 3) };
    }
    return { left: hand('L', 0.3), right: hand('R', 0.7) };
  }

  /* 由双手关键点构建三层四边形角点 */
  function buildCorners(h) {
    const L = h.left, R = h.right;
    return {
      A: { tl: L.thumb, bl: L.index, br: R.index, tr: R.thumb },
      B: { tl: L.index, bl: L.middle, br: R.middle, tr: R.index },
      C: { tl: L.middle, bl: L.pinky, br: R.pinky, tr: R.middle },
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
      drawLayer(ctx, texC, corners.C, 'C', t); // 绿
      drawLayer(ctx, texB, corners.B, 'B', t); // 蓝
      drawLayer(ctx, texA, corners.A, 'A', t); // 红
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
      // 面片渲染在最顶层、覆盖人像，故无需人物分割；仅运行手部检测
      await hands.send({ image: video });
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
