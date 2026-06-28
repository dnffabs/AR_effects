import { LM, FILTER_STYLES } from './config.js';
import { state, dom, offscreen } from './state.js';
import { lerp } from './utils.js';
import { euro } from './filter.js';
import { drawTexturedQuad, quadPath, quadBounds, toScreen, blitCoverMirror } from './geometry.js';
import { drawRisoPortrait3D, drawCartoonPortrait, drawCameoPortrait } from './renderers.js';

function processMask(mask) {
  const mw = mask.width, mh = mask.height;
  if (!mw || !mh) return null;
  const { maskCanvas, maskCtx } = offscreen;
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

export function drawLayer(c2d, tex, corners, style, time) {
  const { W, H, mode, videoReady, latestMask } = state;
  const { personCanvas, personCtx, layerCanvas, layerCtx } = offscreen;
  const p0 = corners.tl, p1 = corners.bl, p2 = corners.br, p3 = corners.tr;
  const bnd = quadBounds(p0, p1, p2, p3);
  const diag = Math.hypot(bnd.w, bnd.h);
  const distort = diag * 0.03;

  const lc = layerCtx;
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalAlpha = 1.0;
  lc.globalCompositeOperation = 'source-over';
  lc.clearRect(0, 0, W, H);

  const scheme = FILTER_STYLES[state.currentStyleIdx];

  quadPath(lc, p0, p3, p2, p1);
  lc.fillStyle = scheme.bg;
  lc.fill();

  lc.save();
  lc.globalCompositeOperation = 'source-atop';
  lc.globalAlpha = 0.7;
  drawTexturedQuad(lc, tex, p0, p1, p2, p3, time, distort);
  lc.globalAlpha = 1.0;
  lc.restore();

  if (mode === 'camera' && videoReady && latestMask) {
    const mproc = processMask(latestMask);
    if (mproc) {
      personCtx.setTransform(1, 0, 0, 1, 0, 0);
      personCtx.clearRect(0, 0, W, H);
      personCtx.globalCompositeOperation = 'source-over';
      blitCoverMirror(personCtx, mproc);
      personCtx.globalCompositeOperation = 'source-in';
      blitCoverMirror(personCtx, dom.video);
      personCtx.globalCompositeOperation = 'source-over';

      lc.save();
      lc.globalCompositeOperation = 'source-atop';

      const ink = style === 'A' ? scheme.layerA.ink : scheme.layerB.ink;
      const offAmt = 2.5;
      const ox = style === 'A' ? -offAmt : offAmt;
      const oy = style === 'A' ? offAmt : -offAmt;
      const screenAngle = style === 'A' ? scheme.layerA.angle : scheme.layerB.angle;
      const dynamicDotStep = Math.max(7, Math.min(W, H) / 95);

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

export function drawFingerGlow(pts, time) {
  const ctx = dom.ctx;
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

export function drawDarkBg(t) {
  const { W, H } = state;
  const ctx = dom.ctx;
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

export function drawDemoForeground(t) {
  const { W, H } = state;
  const ctx = dom.ctx;
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

function avgScreenX(lm) {
  const p = lm[LM.INDEX] || lm[0];
  return toScreen(p.x, p.y).x;
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

export function getCameraHands(t) {
  const lms = state.latestHands;
  state.noHand = !lms || lms.length === 0;
  state.oneHandOnly = lms && lms.length === 1;
  if (!lms || lms.length < 2) return null;

  const a = lms[0], b = lms[1];
  let leftLm, rightLm;
  if (avgScreenX(a) <= avgScreenX(b)) { leftLm = a; rightLm = b; }
  else { leftLm = b; rightLm = a; }

  return { left: filterHand('L', leftLm, t), right: filterHand('R', rightLm, t) };
}

export function getDemoHands(t) {
  state.noHand = false;
  state.oneHandOnly = false;

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

export function buildCorners(h) {
  const L = h.left, R = h.right;
  return {
    A: { tl: L.thumb, bl: L.index, br: R.index, tr: R.thumb },
    B: { tl: L.index, bl: L.middle, br: R.middle, tr: R.index },
  };
}
