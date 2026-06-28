'use strict';

/* =========================================================================
 * 双手 AR 维度裂隙 —— 核心逻辑（多风格 3D 浮雕 Riso 与手绘雕刻滤镜优化版）
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
    currentMinCutoff = 2.6 - 2.25 * s; // 范围约 [0.35, 2.6]
    currentBeta = 0.02 - 0.012 * s;
  }

  /* ---------- 工具函数 ---------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function hexToRgb(hex) {
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    hex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 128, g: 128, b: 128 };
  }

  /* =====================================================================
   * 多种艺术滤镜风格配置库
   * ===================================================================== */
  const FILTER_STYLES = [
    {
      name: "经典双色 (Riso Duo)",
      id: "riso_classic",
      bg: "#f8f5ee",
      layerA: { color: "#08238c", angle: 15, ink: "#08238c" }, // 钴蓝
      layerB: { color: "#ff4e91", angle: 75, ink: "#ff4e91" }, // 荧光桃红
      grainAmt: 20
    },
    {
      name: "赛博霓虹 (Cyber Neon)",
      id: "cyberpunk",
      bg: "#090912",
      layerA: { color: "#00f0ff", angle: 30, ink: "#00f0ff" }, // 极光青
      layerB: { color: "#ff007f", angle: 105, ink: "#ff007f" }, // 霓虹粉红
      grainAmt: 25
    },
    {
      name: "复古卡通 (Retro Cartoon)",
      id: "cartoon",
      bg: "#fffcf5",
      layerA: { color: "#e32d56", angle: 0, ink: "#e32d56" }, // 艳红
      layerB: { color: "#ffb400", angle: 0, ink: "#ffb400" }, // 鲜黄
      grainAmt: 10
    },
    {
      name: "硬币雕刻 (Metallic Cameo)",
      id: "cameo",
      bg: "#e2e8f0",
      layerA: { color: "#1e293b", angle: 0, ink: "#1e293b" }, // 深灰蓝
      layerB: { color: "#f8fafc", angle: 0, ink: "#f8fafc" }, // 白金亮部
      grainAmt: 12
    },
    {
      name: "复古漫画 (Retro Manga)",
      id: "manga",
      bg: "#faf4eb",
      layerA: { color: "#222222", angle: 45, ink: "#111111" }, // 炭黑
      layerB: { color: "#caa782", angle: 90, ink: "#917050" }, // 泥金/牛皮纸色
      grainAmt: 38
    },
    {
      name: "极光森林 (Aurora Forest)",
      id: "aurora",
      bg: "#051314",
      layerA: { color: "#00ffcc", angle: 15, ink: "#00ffcc" }, // 薄荷绿
      layerB: { color: "#7a00ff", angle: 75, ink: "#7a00ff" }, // 极光紫
      grainAmt: 15
    },
    {
      name: "青铜锈蚀 (Copper Patina)",
      id: "patina",
      bg: "#fbf6ef",
      layerA: { color: "#1b4d3e", angle: 25, ink: "#1b4d3e" }, // 铜绿
      layerB: { color: "#c86432", angle: 85, ink: "#c86432" }, // 铁锈橙
      grainAmt: 30
    },
    {
      name: "迷幻波普 (Psychedelic Pop)",
      id: "pop_art",
      bg: "#fff0f5",
      layerA: { color: "#ffea00", angle: 0, ink: "#ffea00" }, // 荧光黄
      layerB: { color: "#9d00ff", angle: 60, ink: "#9d00ff" }, // 波普紫
      grainAmt: 22
    }
  ];

  let currentStyleIdx = 0;

  /* =====================================================================
   * 程序化纹理生成（风格切换时重绘）
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

  /* Riso 半色调网点：均匀网格，点大小一致 */
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

  /* 油墨颗粒（白色 + 黑色微噪点，模拟印刷不均匀） */
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

  /* 自适应动态网屏纹理生成器 */
  function makeDynamicTex(bgColor, dotColor, grainAmt) {
    var S = 512, c = newTexCanvas(S), x = c.getContext('2d');
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
    x.fillStyle = bgColor;
    x.fillRect(0, 0, S, S);
    risoDots(x, S, dotColor, 7);
    risoGrain(x, S);
    addGrain(x, S, S, grainAmt, 0);
    return c;
  }

  /* 初始化动态网屏 */
  let texA, texB;
  function updateTextures() {
    const s = FILTER_STYLES[currentStyleIdx];
    texA = makeDynamicTex(s.bg, s.layerA.color, s.grainAmt);
    texB = makeDynamicTex(s.bg, s.layerB.color, s.grainAmt);
  }

  updateTextures();

  /* =====================================================================
   * 实时立体 Riso 3D 浮雕网点人像渲染
   * ===================================================================== */
  var htCanvas = document.createElement('canvas');   // 采样用小画布
  var htCtx = htCanvas.getContext('2d', { willReadFrequently: true });
  var HT_W = 240, HT_H = 180;
  htCanvas.width = HT_W;
  htCanvas.height = HT_H;

  /**
   * 旋转网格立体 Riso 渲染器
   * 采用光影高度场梯度偏移 + 各向异性网点流动
   */
  function drawRisoPortrait3D(targetCtx, ink, dotStep, offsetX, offsetY, angleDegrees) {
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

    var angleRad = (angleDegrees || 0) * Math.PI / 180;
    var cosA = Math.cos(angleRad);
    var sinA = Math.sin(angleRad);

    var diag = Math.hypot(W, H);
    var cx = W / 2;
    var cy = H / 2;

    var startI = Math.floor(-diag / 2 / dotStep);
    var endI = Math.ceil(diag / 2 / dotStep);
    var startJ = Math.floor(-diag / 2 / dotStep);
    var endJ = Math.ceil(diag / 2 / dotStep);

    // 在旋转空间中生成网格，防止重现单调的横平竖直数字网点
    for (var j = startJ; j <= endJ; j++) {
      var yRot = j * dotStep;
      for (var i = startI; i <= endI; i++) {
        var xRot = i * dotStep;

        var sx = xRot * cosA - yRot * sinA + cx;
        var sy = xRot * sinA + yRot * cosA + cy;

        if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;

        var u = (sx / W) * HT_W;
        var v = (sy / H) * HT_H;

        var p = getPixel(u, v);
        if (p.a < 35) continue;

        // 3D 高度场重建：计算索贝尔（Sobel）邻域亮度梯度
        var pl = getPixel(u - 1, v);
        var pr = getPixel(u + 1, v);
        var pt = getPixel(u, v - 1);
        var pb = getPixel(u, v + 1);

        var gx = (pr.lum - pl.lum) * 0.5;
        var gy = (pb.lum - pt.lum) * 0.5;
        var gradMag = Math.hypot(gx, gy);

        // 立体厚涂油墨偏移（Chiaroscuro Relief Offset）
        var shiftStrength = dotStep * 0.45;
        var shiftX = -gx * shiftStrength;
        var shiftY = -gy * shiftStrength;

        var finalX = sx + shiftX + offsetX;
        var finalY = sy + shiftY + offsetY;

        // 强化明暗对比度（非线性网点增益）
        var density = Math.pow(1.0 - p.lum, 1.4) * (p.a / 255);
        var maxRadius = dotStep * 0.72;
        var r = maxRadius * Math.sqrt(density);

        if (r < 0.4) continue;

        // 各向异性网点流动 (Anisotropic Contour Flow)
        targetCtx.beginPath();
        if (gradMag > 0.025) {
          var contourAngle = Math.atan2(gx, -gy);
          var stretch = 1.0 + gradMag * 1.8;
          stretch = Math.min(stretch, 2.3);

          var rX = r * stretch;
          var rY = r / stretch;

          targetCtx.ellipse(finalX, finalY, rX, rY, contourAngle, 0, Math.PI * 2);
        } else {
          targetCtx.arc(finalX, finalY, r, 0, Math.PI * 2);
        }
        targetCtx.fill();
      }
    }
  }

  /**
   * 移植算法①：复古手绘卡通风格滤镜 (Cartoon Filter)
   * 采用高饱和色彩平滑量化 + 自适应邻域均值描边
   */
  function drawCartoonPortrait(targetCtx, offsetX, offsetY, scheme) {
    htCtx.clearRect(0, 0, HT_W, HT_H);
    htCtx.drawImage(personCanvas, 0, 0, HT_W, HT_H);
    var imgData = htCtx.getImageData(0, 0, HT_W, HT_H);
    var d = imgData.data;
    var outData = htCtx.createImageData(HT_W, HT_H);
    var out = outData.data;

    // 预计算亮度缓存以用于边缘检测
    var lum = new Uint8Array(HT_W * HT_H);
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 35) {
        lum[i / 4] = 255;
        continue;
      }
      lum[i / 4] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }

    var colorA = hexToRgb(scheme.layerA.color);
    var colorB = hexToRgb(scheme.layerB.color);
    var radius = 2; // 模拟 Python 中 blockSize=5 的邻域

    for (var y = 0; y < HT_H; y++) {
      for (var x = 0; x < HT_W; x++) {
        var idx = (y * HT_W + x) * 4;
        if (d[idx + 3] < 35) {
          out[idx + 3] = 0;
          continue;
        }

        // 1. 自适应阈值求取均值 (Adaptive Mean Threshold)
        var sum = 0, count = 0;
        for (var ky = -radius; ky <= radius; ky++) {
          var ny = y + ky;
          if (ny < 0 || ny >= HT_H) continue;
          for (var kx = -radius; kx <= radius; kx++) {
            var nx = x + kx;
            if (nx < 0 || nx >= HT_W) continue;
            sum += lum[ny * HT_W + nx];
            count++;
          }
        }
        var mean = sum / count;
        var currentLum = lum[y * HT_W + x];

        // 判定边缘 (若当前点亮度明显低于邻域均值，即为暗轮廓线)
        var isEdge = currentLum < (mean - 7); // C=7 偏置

        if (isEdge) {
          // 浓郁的漫画描边 (硬黑/暗灰色)
          out[idx] = 18;
          out[idx + 1] = 18;
          out[idx + 2] = 26;
          out[idx + 3] = 255;
        } else {
          // 2. 双边平滑色彩量化 (Cel-shading)
          var normL = currentLum / 255;
          // 分级量化为四个色彩层级，形成强烈的块面卡通阴影
          var cellL = Math.floor(normL * 4) / 3;

          out[idx] = lerp(colorB.r, colorA.r, cellL);
          out[idx + 1] = lerp(colorB.g, colorA.g, cellL);
          out[idx + 2] = lerp(colorB.b, colorA.b, cellL);
          out[idx + 3] = 255;
        }
      }
    }

    htCtx.putImageData(outData, 0, 0);
    // 高清绘制缩放到面片容器内
    targetCtx.drawImage(htCanvas, offsetX, offsetY, W, H);
  }

  /**
   * 移植算法②：硬币浮雕徽章滤镜 (Cameo Relief Filter)
   * 采用方向性像素亮度差分 + 180 中灰度偏移 + 专属双色金属光影着色
   */
  function drawCameoPortrait(targetCtx, offsetX, offsetY, scheme) {
    htCtx.clearRect(0, 0, HT_W, HT_H);
    htCtx.drawImage(personCanvas, 0, 0, HT_W, HT_H);
    var imgData = htCtx.getImageData(0, 0, HT_W, HT_H);
    var d = imgData.data;
    var outData = htCtx.createImageData(HT_W, HT_H);
    var out = outData.data;

    // 计算灰度矩阵
    var gray = new Uint8Array(HT_W * HT_H);
    for (var i = 0; i < d.length; i += 4) {
      gray[i / 4] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }

    var colorA = hexToRgb(scheme.layerA.color);
    var colorB = hexToRgb(scheme.layerB.color);

    for (var y = 0; y < HT_H; y++) {
      for (var x = 0; x < HT_W; x++) {
        var idx = (y * HT_W + x) * 4;
        if (d[idx + 3] < 35) {
          out[idx + 3] = 0;
          continue;
        }

        // 差分相邻像素 (P0 - P1 + 180 偏移) 模拟雕刻凹凸立体
        var nextX = x < HT_W - 1 ? x + 1 : x;
        var P0 = gray[y * HT_W + x];
        var P1 = gray[y * HT_W + nextX];

        var P = P0 - P1 + 180;
        P = clamp(P, 0, 255);

        // 将差分高度场 P (0-255) 映射为自适应金属双色调
        var ratio = P / 255;

        out[idx] = lerp(colorA.r, colorB.r, ratio);
        out[idx + 1] = lerp(colorA.g, colorB.g, ratio);
        out[idx + 2] = lerp(colorA.b, colorB.b, ratio);
        out[idx + 3] = 255;
      }
    }

    htCtx.putImageData(outData, 0, 0);
    targetCtx.drawImage(htCanvas, offsetX, offsetY, W, H);
  }

  /* =====================================================================
   * 仿射纹理三角形
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
          const edge = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
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
   * ===================================================================== */
  function drawLayer(c2d, tex, corners, style, time) {
    var p0 = corners.tl, p1 = corners.bl, p2 = corners.br, p3 = corners.tr;
    var bnd = quadBounds(p0, p1, p2, p3);
    var diag = Math.hypot(bnd.w, bnd.h);
    var distort = diag * 0.03;

    var lc = layerCtx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1.0;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);

    // 获取当前激活的滤镜参数
    var scheme = FILTER_STYLES[currentStyleIdx];

    // ① 四边形填充对应风格纸底
    quadPath(lc, p0, p3, p2, p1);
    lc.fillStyle = scheme.bg;
    lc.fill();

    // ② 在四边形内叠加背景网格纹理
    lc.save();
    lc.globalCompositeOperation = 'source-atop';
    lc.globalAlpha = 0.7;
    drawTexturedQuad(lc, tex, p0, p1, p2, p3, time, distort);
    lc.globalAlpha = 1.0;
    lc.restore();

    // ③ 3D 肖像核心渲染 (包含 Riso 网点 / 移植卡通 / 移植浮雕)
    if (mode === 'camera' && videoReady && latestMask) {
      var mproc = processMask(latestMask);
      if (mproc) {
        personCtx.setTransform(1, 0, 0, 1, 0, 0);
        personCtx.clearRect(0, 0, W, H);
        personCtx.globalCompositeOperation = 'source-over';
        blitCoverMirror(personCtx, mproc);
        personCtx.globalCompositeOperation = 'source-in';
        blitCoverMirror(personCtx, video);
        personCtx.globalCompositeOperation = 'source-over';

        lc.save();
        lc.globalCompositeOperation = 'source-atop';
        
        var ink = style === 'A' ? scheme.layerA.ink : scheme.layerB.ink;
        var offAmt = 2.5; 
        var ox = style === 'A' ? -offAmt : offAmt;
        var oy = style === 'A' ? offAmt : -offAmt;
        var screenAngle = style === 'A' ? scheme.layerA.angle : scheme.layerB.angle;
        var dynamicDotStep = Math.max(7, Math.min(W, H) / 95);

        // 根据当前的滤镜方案进行渲染派发
        if (scheme.id === 'cartoon') {
          drawCartoonPortrait(lc, ox, oy, scheme);
        } else if (scheme.id === 'cameo') {
          drawCameoPortrait(lc, ox, oy, scheme);
        } else {
          drawRisoPortrait3D(lc, ink, dynamicDotStep, ox, oy, screenAngle);
        }
        
        lc.restore();
      }
    }

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
      [pts.left.thumb, '255,100,100'], [pts.left.index, '100,220,255'],
      [pts.left.middle, '150,255,150'],
      [pts.right.thumb, '255,100,100'], [pts.right.index, '100,220,255'],
      [pts.right.middle, '150,255,150'],
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
    return { x: W - X, y: Y };
  }

  function blitCoverMirror(c2d, img) {
    c2d.save();
    c2d.translate(W, 0);
    c2d.scale(-1, 1);
    c2d.drawImage(img, offX, offY, drawW, drawH);
    c2d.restore();
  }

  /* =====================================================================
   * 取得当前双手关键点
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

  function buildCorners(h) {
    const L = h.left, R = h.right;
    return {
      A: { tl: L.thumb, bl: L.index, br: R.index, tr: R.thumb },
      B: { tl: L.index, bl: L.middle, br: R.middle, tr: R.index },
    };
  }

  /* =====================================================================
   * 人物前景（真实分割）
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
      const a = d[i];
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = a;
    }
    maskCtx.putImageData(im, 0, 0);
    return maskCanvas;
  }

  function drawDarkBg(t) {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    g.addColorStop(0, '#11141d');
    g.addColorStop(0.7, '#080a10');
    g.addColorStop(1, '#040406');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

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

  function drawDemoForeground(t) {
    const cx = W * (0.5 + 0.16 * Math.sin(t * 0.5));
    const cy = H * 0.62;
    const u = Math.min(W, H);
    ctx.save();
    ctx.fillStyle = '#0b0d12';
    ctx.beginPath();
    ctx.moveTo(cx - u * 0.16, H);
    ctx.quadraticCurveTo(cx - u * 0.2, cy, cx - u * 0.1, cy - u * 0.05);
    ctx.lineTo(cx + u * 0.1, cy - u * 0.05);
    ctx.quadraticCurveTo(cx + u * 0.2, cy, cx + u * 0.16, H);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy - u * 0.14, u * 0.085, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(120,160,200,0.25)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy - u * 0.14, u * 0.085, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* =====================================================================
   * 主渲染循环
   * ===================================================================== */
  function render(now) {
    const t = now * 0.001;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (mode === 'camera' && videoReady) {
      blitCoverMirror(ctx, video);
    } else {
      drawDarkBg(t);
      if (mode === 'demo') drawDemoForeground(t);
    }

    let h = null;
    if (mode === 'camera') h = getCameraHands(t);
    else if (mode === 'demo') h = getDemoHands(t);

    if (h) {
      const corners = buildCorners(h);
      drawLayer(ctx, texB, corners.B, 'B', t); 
      drawLayer(ctx, texA, corners.A, 'A', t); 
      drawFingerGlow(h, t);
    }

    updateStatus();

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
    } catch (e) {}
    busy = false;
  }

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
   * 动态流式注入风格选择 UI
   * ===================================================================== */
  function injectFilterSelectorUI() {
    // 注入全局 CSS 保证切换按钮的动画顺滑
    const styleTag = document.createElement('style');
    styleTag.textContent = `
      .riso-style-btn {
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.65);
        border: 1px solid rgba(255, 255, 255, 0.05);
        padding: 6px 14px;
        font-size: 12px;
        font-family: inherit;
        font-weight: 500;
        border-radius: 20px;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        white-space: nowrap;
        outline: none;
      }
      .riso-style-btn:hover {
        background: rgba(255, 255, 255, 0.16);
        color: #ffffff;
        transform: translateY(-1px);
      }
      .riso-style-btn.active {
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
        transform: scale(1.04);
      }
    `;
    document.head.appendChild(styleTag);

    const dock = document.createElement('div');
    dock.id = 'riso-style-selector';
    dock.style.cssText = `
      position: absolute;
      bottom: 84px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 10px;
      background: rgba(12, 15, 24, 0.72);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      padding: 8px 12px;
      border-radius: 50px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      z-index: 9999;
      box-shadow: 0 10px 35px rgba(0, 0, 0, 0.6);
      max-width: 90%;
      overflow-x: auto;
    `;
    // 隐藏滚动条
    dock.style.scrollbarWidth = 'none';
    dock.style.msOverflowStyle = 'none';

    FILTER_STYLES.forEach((scheme, idx) => {
      const btn = document.createElement('button');
      btn.className = 'riso-style-btn';
      btn.textContent = scheme.name;

      if (idx === currentStyleIdx) {
        applyActiveStyle(btn, scheme);
      }

      btn.addEventListener('click', () => {
        currentStyleIdx = idx;
        document.querySelectorAll('.riso-style-btn').forEach((b) => {
          b.classList.remove('active');
          b.style.background = 'rgba(255, 255, 255, 0.08)';
          b.style.color = 'rgba(255, 255, 255, 0.65)';
          b.style.borderColor = 'rgba(255, 255, 255, 0.05)';
        });
        applyActiveStyle(btn, scheme);
        updateTextures();
      });

      dock.appendChild(btn);
    });

    document.body.appendChild(dock);
  }

  function applyActiveStyle(btn, scheme) {
    btn.classList.add('active');
    btn.style.background = `linear-gradient(135deg, ${scheme.layerA.color}, ${scheme.layerB.color})`;
    btn.style.color = '#ffffff';
    btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
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
  injectFilterSelectorUI();
  requestAnimationFrame(render);
})();