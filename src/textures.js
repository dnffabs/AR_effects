import { clamp } from './utils.js';
import { FILTER_STYLES } from './config.js';
import { state } from './state.js';

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

function risoDots(cx, S, color, step) {
  const r = step * 0.32;
  cx.fillStyle = color;
  for (let y = step * 0.5; y < S; y += step) {
    for (let x = step * 0.5; x < S; x += step) {
      cx.beginPath();
      cx.arc(x, y, r, 0, Math.PI * 2);
      cx.fill();
    }
  }
}

function risoGrain(cx, S) {
  for (let i = 0; i < 6000; i++) {
    cx.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.05).toFixed(3) + ')';
    cx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  for (let j = 0; j < 3000; j++) {
    cx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.03).toFixed(3) + ')';
    cx.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
}

function makeDynamicTex(bgColor, dotColor, grainAmt) {
  const S = 512;
  const c = newTexCanvas(S);
  const x = c.getContext('2d');
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.fillStyle = bgColor;
  x.fillRect(0, 0, S, S);
  risoDots(x, S, dotColor, 7);
  risoGrain(x, S);
  addGrain(x, S, S, grainAmt, 0);
  return c;
}

export function updateTextures() {
  const s = FILTER_STYLES[state.currentStyleIdx];
  state.texA = makeDynamicTex(s.bg, s.layerA.color, s.grainAmt);
  state.texB = makeDynamicTex(s.bg, s.layerB.color, s.grainAmt);
}
