import { DCUTOFF } from './config.js';
import { dom } from './state.js';
import { clamp } from './utils.js';

let currentMinCutoff = 1.4;
let currentBeta = 0.015;
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

export function euro(key, value, t) {
  let f = filters.get(key);
  if (!f) {
    f = new OneEuro(currentMinCutoff, currentBeta, DCUTOFF);
    filters.set(key, f);
  }
  f.minCutoff = currentMinCutoff;
  f.beta = currentBeta;
  return f.filter(value, t);
}

export function updateSmoothParams() {
  const s = clamp(Number(dom.smoothSlider.value) / 100, 0, 1);
  currentMinCutoff = 2.6 - 2.25 * s;
  currentBeta = 0.02 - 0.012 * s;
}

export function clearFilters() {
  filters.clear();
}
