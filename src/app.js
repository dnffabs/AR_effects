import { state, dom, offscreen, initDOM, initOffscreen } from './state.js';
import { updateSmoothParams } from './filter.js';
import { updateTextures } from './textures.js';
import { setCoverForVideo, setCoverForDemo, blitCoverMirror } from './geometry.js';
import {
  drawLayer, drawFingerGlow, drawDarkBg, drawDemoForeground,
  getCameraHands, getDemoHands, buildCorners,
} from './scene.js';
import { startCamera, startDemo, resetAll, pump } from './media.js';
import { updateStatus, injectFilterSelectorUI } from './ui.js';

/* ---------- 初始化 ---------- */
initDOM();
initOffscreen();

/* ---------- 窗口自适应 ---------- */
function resize() {
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.W = Math.round(window.innerWidth * state.dpr);
  state.H = Math.round(window.innerHeight * state.dpr);

  dom.stage.width = state.W;
  dom.stage.height = state.H;
  dom.stage.style.width = window.innerWidth + 'px';
  dom.stage.style.height = window.innerHeight + 'px';

  offscreen.personCanvas.width = state.W;
  offscreen.personCanvas.height = state.H;
  offscreen.layerCanvas.width = state.W;
  offscreen.layerCanvas.height = state.H;

  if (state.mode === 'demo' || state.mode === 'idle') setCoverForDemo();
  else setCoverForVideo();
}

/* ---------- 主渲染循环 ---------- */
function render(now) {
  const t = now * 0.001;
  const ctx = dom.ctx;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, state.W, state.H);

  if (state.mode === 'camera' && state.videoReady) {
    blitCoverMirror(ctx, dom.video);
  } else {
    drawDarkBg(t);
    if (state.mode === 'demo') drawDemoForeground(t);
  }

  let h = null;
  if (state.mode === 'camera') h = getCameraHands(t);
  else if (state.mode === 'demo') h = getDemoHands(t);

  if (h) {
    const corners = buildCorners(h);
    drawLayer(ctx, state.texB, corners.B, 'B', t);
    drawLayer(ctx, state.texA, corners.A, 'A', t);
    drawFingerGlow(h, t);
  }

  updateStatus();
  if (state.mode === 'camera') pump();

  requestAnimationFrame(render);
}

/* ---------- 事件绑定 ---------- */
dom.btnCamera.addEventListener('click', startCamera);
dom.btnDemo.addEventListener('click', startDemo);
dom.btnReset.addEventListener('click', resetAll);
dom.smoothSlider.addEventListener('input', updateSmoothParams);
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

/* ---------- 启动 ---------- */
updateSmoothParams();
resize();
updateTextures();
injectFilterSelectorUI();
requestAnimationFrame(render);
