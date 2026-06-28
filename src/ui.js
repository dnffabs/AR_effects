import { FILTER_STYLES } from './config.js';
import { state, dom } from './state.js';
import { updateTextures } from './textures.js';

let lastStatus = '';

export function setStatus(s) {
  if (s === lastStatus) return;
  lastStatus = s;
  dom.statusEl.textContent = s;
}

export function updateStatus() {
  if (state.mode === 'idle') {
    setStatus('点击「摄像头」或「演示模式」开始');
    return;
  }
  if (state.mode === 'demo') {
    setStatus('演示模式运行中');
    return;
  }
  if (state.noHand) setStatus('请伸开双手进入画面');
  else if (state.oneHandOnly) setStatus('仅检测到一只手，请伸出双手');
  else setStatus('双手已锁定 · 移动手指拉出维度裂隙');
}

export function showError(msg) {
  dom.errorEl.textContent = msg;
  dom.errorEl.classList.remove('hidden');
}

export function hideError() {
  dom.errorEl.classList.add('hidden');
}

export function setActive(btn, on) {
  if (on) btn.classList.add('active');
  else btn.classList.remove('active');
}

function applyActiveFilterBtn(btn, scheme) {
  btn.classList.add('active');
  btn.style.background = `linear-gradient(135deg, ${scheme.layerA.color}, ${scheme.layerB.color})`;
  btn.style.color = '#ffffff';
  btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
}

function resetFilterBtn(btn) {
  btn.classList.remove('active');
  btn.style.background = '';
  btn.style.color = '';
  btn.style.borderColor = '';
}

export function injectFilterSelectorUI() {
  const container = dom.filterSelector;
  if (!container) return;
  container.innerHTML = '';

  FILTER_STYLES.forEach((scheme, idx) => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.textContent = scheme.name;
    btn.type = 'button';

    if (idx === state.currentStyleIdx) {
      applyActiveFilterBtn(btn, scheme);
    }

    btn.addEventListener('click', () => {
      state.currentStyleIdx = idx;
      container.querySelectorAll('.filter-btn').forEach(resetFilterBtn);
      applyActiveFilterBtn(btn, scheme);
      updateTextures();
    });

    container.appendChild(btn);
  });
}
