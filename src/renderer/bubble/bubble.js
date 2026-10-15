/**
 * 气泡窗口渲染逻辑
 * 只负责显示内容、按设置缩放、回报尺寸，展示时长结束后通知主进程隐藏
 */

const elements = {
  root: document.getElementById('bubble-root'),
  card: document.getElementById('bubble-card'),
  title: document.getElementById('balance-title'),
  badge: document.getElementById('balance-badge'),
  value: document.getElementById('balance-value'),
  sub: document.getElementById('balance-sub'),
  text: document.getElementById('bubble-text')
};

let hideTimer = null;

/** 字节数 -> 1.2 GB */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

/** 渲染普通文字气泡 */
function renderText(text) {
  elements.card.classList.add('hidden');
  elements.text.classList.remove('hidden');
  elements.text.textContent = text;
}

/** 渲染本地模型状态卡片 */
function renderCard(data) {
  const models = (data && Array.isArray(data.models)) ? data.models : [];
  const hasModel = !!(data && data.model);

  elements.text.classList.add('hidden');
  elements.card.classList.remove('hidden');

  elements.value.innerHTML = '';
  elements.value.classList.add('model-name');
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const nameEl = document.createElement('span');
  nameEl.className = 'amount';
  nameEl.textContent = hasModel ? data.model : '还没有模型';
  elements.value.appendChild(dot);
  elements.value.appendChild(nameEl);

  elements.sub.innerHTML = '';
  const items = [`共 ${models.length} 个模型`];
  if (Number.isFinite(Number(data && data.latencyMs))) items.push(`${data.latencyMs} ms`);
  if (data && Array.isArray(data.loaded)) {
    items.push(data.loaded.length
      ? `已加载 ${data.loaded.map((m) => `${m.name}${formatBytes(m.sizeVram) ? ` (${formatBytes(m.sizeVram)})` : ''}`).join('、')}`
      : '暂未加载到显存');
  }
  if (hasModel && data.modelAvailable === false) items.push('⚠️ 服务上找不到该模型');
  for (const item of items) {
    const span = document.createElement('span');
    span.className = 'item';
    span.textContent = item;
    elements.sub.appendChild(span);
  }
  elements.sub.style.display = items.length ? '' : 'none';

  const ok = hasModel && data.modelAvailable !== false;
  elements.title.textContent = '本地模型在线';
  elements.badge.textContent = (data && data.providerName) || '本地';
  elements.card.classList.toggle('warn', !ok);
}

/** 测量并回报内容尺寸（主进程据此调整窗口大小与位置） */
function reportSize() {
  const rect = elements.root.getBoundingClientRect();
  const style = getComputedStyle(document.body);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  // 尾巴与阴影已经在 body 的 padding 里预留
  window.bubbleAPI.reportSize({
    width: Math.ceil(rect.width + padX + 2),
    height: Math.ceil(rect.height + padY + 2)
  });
}

/** 收到主进程的气泡内容 */
window.bubbleAPI.onShow((payload) => {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  const scale = Number(payload.scale) > 0 ? Number(payload.scale) : 1;
  document.documentElement.style.setProperty('--bubble-scale', String(scale));

  if (payload.kind === 'status' && payload.data) {
    renderCard(payload.data);
  } else {
    renderText(payload.text || '');
  }

  elements.root.classList.remove('hidden');
  // 先测量（此时窗口还隐藏着），主进程拿到尺寸后定位再显示
  requestAnimationFrame(() => {
    reportSize();
    const duration = Number(payload.duration) || 2500;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      elements.root.classList.add('hidden');
      window.bubbleAPI.hide();
    }, duration);
  });
});

// 窗口尺寸变化（例如用户改了气泡大小设置后重现）时重新测量
window.addEventListener('resize', () => {
  if (!elements.root.classList.contains('hidden')) reportSize();
});
