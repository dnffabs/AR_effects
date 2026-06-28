import { state, dom } from './state.js';
import { setCoverForVideo, setCoverForDemo } from './geometry.js';
import { showError, hideError, setActive, setStatus } from './ui.js';
import { clearFilters } from './filter.js';

function mpAvailable() {
  return typeof window.Hands === 'function' && typeof window.SelfieSegmentation === 'function';
}

async function initMediaPipe() {
  if (state.hands && state.selfie) return true;

  state.hands = new window.Hands({
    locateFile: (file) =>
      'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/' + file,
  });
  state.hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  state.hands.onResults((r) => {
    state.latestHands = r.multiHandLandmarks || [];
  });

  state.selfie = new window.SelfieSegmentation({
    locateFile: (file) =>
      'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/' + file,
  });
  state.selfie.setOptions({ modelSelection: 1 });
  state.selfie.onResults((r) => {
    state.latestMask = r.segmentationMask;
  });

  return true;
}

function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((tr) => tr.stop());
    state.stream = null;
  }
  if (dom.video) {
    try { dom.video.pause(); } catch (_) { /* ignored */ }
    dom.video.srcObject = null;
  }
}

function handleCameraError(e) {
  const name = e && e.name ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    showError('摄像头权限被拒绝，请在浏览器地址栏允许摄像头权限后重试。');
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    showError('未检测到摄像头，请连接摄像头设备后重试。');
  } else if (name === 'NotReadableError' || name === 'TrackStartError') {
    showError('摄像头被占用，请关闭其他正在使用摄像头的程序后重试。');
  } else {
    showError('摄像头启动失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

export async function startCamera() {
  hideError();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.requestAnimationFrame) {
    showError('当前浏览器不支持所需 API，请使用最新版 Chrome / Edge。');
    return;
  }
  if (window.__mpLoadError || !mpAvailable()) {
    showError('MediaPipe 模型加载失败，请检查网络连接后刷新重试。');
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    handleCameraError(e);
    return;
  }

  try {
    dom.video.srcObject = state.stream;
    await dom.video.play();
  } catch (_) {
    showError('摄像头画面无法播放，请刷新页面重试。');
    return;
  }

  try {
    await initMediaPipe();
  } catch (_) {
    showError('MediaPipe 模型初始化失败，请检查网络后刷新重试。');
    stopStream();
    return;
  }

  setCoverForVideo();
  state.videoReady = true;
  state.mode = 'camera';
  state.latestHands = [];
  state.latestMask = null;
  setActive(dom.btnCamera, true);
  setActive(dom.btnDemo, false);
  setStatus('摄像头已启动，正在加载模型…');
}

export function startDemo() {
  hideError();
  stopStream();
  state.videoReady = false;
  state.latestHands = [];
  state.latestMask = null;
  state.mode = 'demo';
  setCoverForDemo();
  setActive(dom.btnDemo, true);
  setActive(dom.btnCamera, false);
}

export function resetAll() {
  hideError();
  stopStream();
  state.videoReady = false;
  state.latestHands = [];
  state.latestMask = null;
  clearFilters();
  state.mode = 'idle';
  setActive(dom.btnDemo, false);
  setActive(dom.btnCamera, false);
  dom.ctx.setTransform(1, 0, 0, 1, 0, 0);
  dom.ctx.clearRect(0, 0, state.W, state.H);
}

export async function pump() {
  if (state.busy || !state.videoReady || !state.hands || !state.selfie) return;
  if (dom.video.readyState < 2) return;
  state.busy = true;
  try {
    await state.hands.send({ image: dom.video });
    await state.selfie.send({ image: dom.video });
  } catch (_) { /* ignored */ }
  state.busy = false;
}
