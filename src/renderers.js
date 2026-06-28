import { clamp, lerp, hexToRgb } from './utils.js';
import { HT_W, HT_H } from './config.js';
import { state, offscreen } from './state.js';

export function drawRisoPortrait3D(targetCtx, ink, dotStep, offsetX, offsetY, angleDegrees) {
  const { htCtx, personCanvas } = offscreen;
  const { W, H } = state;

  htCtx.clearRect(0, 0, HT_W, HT_H);
  htCtx.drawImage(personCanvas, 0, 0, HT_W, HT_H);
  const imgData = htCtx.getImageData(0, 0, HT_W, HT_H);
  const d = imgData.data;

  function getPixel(u, v) {
    const tu = Math.max(0, Math.min(HT_W - 1, Math.round(u)));
    const tv = Math.max(0, Math.min(HT_H - 1, Math.round(v)));
    const idx = (tv * HT_W + tu) * 4;
    return {
      a: d[idx + 3],
      lum: (d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114) / 255,
    };
  }

  targetCtx.fillStyle = ink;

  const angleRad = (angleDegrees || 0) * Math.PI / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const diag = Math.hypot(W, H);
  const cx = W / 2;
  const cy = H / 2;

  const startI = Math.floor(-diag / 2 / dotStep);
  const endI = Math.ceil(diag / 2 / dotStep);
  const startJ = Math.floor(-diag / 2 / dotStep);
  const endJ = Math.ceil(diag / 2 / dotStep);

  for (let j = startJ; j <= endJ; j++) {
    const yRot = j * dotStep;
    for (let i = startI; i <= endI; i++) {
      const xRot = i * dotStep;
      const sx = xRot * cosA - yRot * sinA + cx;
      const sy = xRot * sinA + yRot * cosA + cy;

      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;

      const u = (sx / W) * HT_W;
      const v = (sy / H) * HT_H;
      const p = getPixel(u, v);
      if (p.a < 35) continue;

      const pl = getPixel(u - 1, v);
      const pr = getPixel(u + 1, v);
      const pt = getPixel(u, v - 1);
      const pb = getPixel(u, v + 1);

      const gx = (pr.lum - pl.lum) * 0.5;
      const gy = (pb.lum - pt.lum) * 0.5;
      const gradMag = Math.hypot(gx, gy);

      const shiftStrength = dotStep * 0.45;
      const finalX = sx + (-gx * shiftStrength) + offsetX;
      const finalY = sy + (-gy * shiftStrength) + offsetY;

      const density = Math.pow(1.0 - p.lum, 1.4) * (p.a / 255);
      const maxRadius = dotStep * 0.72;
      const r = maxRadius * Math.sqrt(density);

      if (r < 0.4) continue;

      targetCtx.beginPath();
      if (gradMag > 0.025) {
        const contourAngle = Math.atan2(gx, -gy);
        const stretch = Math.min(1.0 + gradMag * 1.8, 2.3);
        targetCtx.ellipse(finalX, finalY, r * stretch, r / stretch, contourAngle, 0, Math.PI * 2);
      } else {
        targetCtx.arc(finalX, finalY, r, 0, Math.PI * 2);
      }
      targetCtx.fill();
    }
  }
}

export function drawCartoonPortrait(targetCtx, offsetX, offsetY, scheme) {
  const { htCtx, htCanvas, personCanvas } = offscreen;
  const { W, H } = state;

  htCtx.clearRect(0, 0, HT_W, HT_H);
  htCtx.drawImage(personCanvas, 0, 0, HT_W, HT_H);
  const imgData = htCtx.getImageData(0, 0, HT_W, HT_H);
  const d = imgData.data;
  const outData = htCtx.createImageData(HT_W, HT_H);
  const out = outData.data;

  const lum = new Uint8Array(HT_W * HT_H);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 35) { lum[i / 4] = 255; continue; }
    lum[i / 4] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }

  const colorA = hexToRgb(scheme.layerA.color);
  const colorB = hexToRgb(scheme.layerB.color);
  const radius = 2;

  for (let y = 0; y < HT_H; y++) {
    for (let x = 0; x < HT_W; x++) {
      const idx = (y * HT_W + x) * 4;
      if (d[idx + 3] < 35) { out[idx + 3] = 0; continue; }

      let sum = 0, count = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        const ny = y + ky;
        if (ny < 0 || ny >= HT_H) continue;
        for (let kx = -radius; kx <= radius; kx++) {
          const nx = x + kx;
          if (nx < 0 || nx >= HT_W) continue;
          sum += lum[ny * HT_W + nx];
          count++;
        }
      }
      const mean = sum / count;
      const currentLum = lum[y * HT_W + x];

      if (currentLum < mean - 7) {
        out[idx] = 18; out[idx + 1] = 18; out[idx + 2] = 26; out[idx + 3] = 255;
      } else {
        const cellL = Math.floor((currentLum / 255) * 4) / 3;
        out[idx] = lerp(colorB.r, colorA.r, cellL);
        out[idx + 1] = lerp(colorB.g, colorA.g, cellL);
        out[idx + 2] = lerp(colorB.b, colorA.b, cellL);
        out[idx + 3] = 255;
      }
    }
  }

  htCtx.putImageData(outData, 0, 0);
  targetCtx.drawImage(htCanvas, offsetX, offsetY, W, H);
}

export function drawCameoPortrait(targetCtx, offsetX, offsetY, scheme) {
  const { htCtx, htCanvas, personCanvas } = offscreen;
  const { W, H } = state;

  htCtx.clearRect(0, 0, HT_W, HT_H);
  htCtx.drawImage(personCanvas, 0, 0, HT_W, HT_H);
  const imgData = htCtx.getImageData(0, 0, HT_W, HT_H);
  const d = imgData.data;
  const outData = htCtx.createImageData(HT_W, HT_H);
  const out = outData.data;

  const gray = new Uint8Array(HT_W * HT_H);
  for (let i = 0; i < d.length; i += 4) {
    gray[i / 4] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }

  const colorA = hexToRgb(scheme.layerA.color);
  const colorB = hexToRgb(scheme.layerB.color);

  for (let y = 0; y < HT_H; y++) {
    for (let x = 0; x < HT_W; x++) {
      const idx = (y * HT_W + x) * 4;
      if (d[idx + 3] < 35) { out[idx + 3] = 0; continue; }

      const nextX = x < HT_W - 1 ? x + 1 : x;
      const P = clamp(gray[y * HT_W + x] - gray[y * HT_W + nextX] + 180, 0, 255);
      const ratio = P / 255;

      out[idx] = lerp(colorA.r, colorB.r, ratio);
      out[idx + 1] = lerp(colorA.g, colorB.g, ratio);
      out[idx + 2] = lerp(colorA.b, colorB.b, ratio);
      out[idx + 3] = 255;
    }
  }

  htCtx.putImageData(outData, 0, 0);
  targetCtx.drawImage(htCanvas, offsetX, offsetY, W, H);
}
