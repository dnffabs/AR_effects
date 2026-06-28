import { HT_W, HT_H } from './config.js';

export const state = {
  W: 0, H: 0, dpr: 1,
  mode: 'idle',
  videoReady: false,
  stream: null,
  busy: false,
  hands: null,
  selfie: null,
  latestHands: [],
  latestMask: null,
  oneHandOnly: false,
  noHand: false,
  offX: 0, offY: 0, drawW: 0, drawH: 0,
  currentStyleIdx: 0,
  texA: null,
  texB: null,
};

export const dom = {
  video: null,
  stage: null,
  ctx: null,
  btnCamera: null,
  btnDemo: null,
  btnReset: null,
  smoothSlider: null,
  statusEl: null,
  errorEl: null,
  filterSelector: null,
};

export const offscreen = {
  personCanvas: null,
  personCtx: null,
  maskCanvas: null,
  maskCtx: null,
  layerCanvas: null,
  layerCtx: null,
  htCanvas: null,
  htCtx: null,
};

export function initDOM() {
  dom.video = document.getElementById('cam');
  dom.stage = document.getElementById('stage');
  dom.ctx = dom.stage.getContext('2d');
  dom.btnCamera = document.getElementById('btnCamera');
  dom.btnDemo = document.getElementById('btnDemo');
  dom.btnReset = document.getElementById('btnReset');
  dom.smoothSlider = document.getElementById('smooth');
  dom.statusEl = document.getElementById('status');
  dom.errorEl = document.getElementById('error');
  dom.filterSelector = document.getElementById('filter-selector');
}

export function initOffscreen() {
  offscreen.personCanvas = document.createElement('canvas');
  offscreen.personCtx = offscreen.personCanvas.getContext('2d');
  offscreen.maskCanvas = document.createElement('canvas');
  offscreen.maskCtx = offscreen.maskCanvas.getContext('2d', { willReadFrequently: true });
  offscreen.layerCanvas = document.createElement('canvas');
  offscreen.layerCtx = offscreen.layerCanvas.getContext('2d');
  offscreen.htCanvas = document.createElement('canvas');
  offscreen.htCtx = offscreen.htCanvas.getContext('2d', { willReadFrequently: true });
  offscreen.htCanvas.width = HT_W;
  offscreen.htCanvas.height = HT_H;
}
