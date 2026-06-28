import { lerp } from './utils.js';
import { GRID } from './config.js';
import { state, dom } from './state.js';

export function setCoverForVideo() {
  const vw = dom.video.videoWidth || 1280;
  const vh = dom.video.videoHeight || 720;
  const scale = Math.max(state.W / vw, state.H / vh);
  state.drawW = vw * scale;
  state.drawH = vh * scale;
  state.offX = (state.W - state.drawW) / 2;
  state.offY = (state.H - state.drawH) / 2;
}

export function setCoverForDemo() {
  state.offX = 0;
  state.offY = 0;
  state.drawW = state.W;
  state.drawH = state.H;
}

export function toScreen(lx, ly) {
  const X = state.offX + lx * state.drawW;
  const Y = state.offY + ly * state.drawH;
  return { x: state.W - X, y: Y };
}

export function blitCoverMirror(c2d, img) {
  c2d.save();
  c2d.translate(state.W, 0);
  c2d.scale(-1, 1);
  c2d.drawImage(img, state.offX, state.offY, state.drawW, state.drawH);
  c2d.restore();
}

export function drawTriangle(c2d, img, t0, t1, t2) {
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

export function drawTexturedQuad(c2d, tex, p0, p1, p2, p3, time, distort) {
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

export function quadPath(c2d, p0, p3, p2, p1) {
  c2d.beginPath();
  c2d.moveTo(p0.x, p0.y);
  c2d.lineTo(p3.x, p3.y);
  c2d.lineTo(p2.x, p2.y);
  c2d.lineTo(p1.x, p1.y);
  c2d.closePath();
}

export function quadBounds(p0, p1, p2, p3) {
  const xs = [p0.x, p1.x, p2.x, p3.x];
  const ys = [p0.y, p1.y, p2.y, p3.y];
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}
