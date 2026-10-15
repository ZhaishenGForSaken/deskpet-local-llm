/**
 * 右键菜单窗口渲染逻辑
 * 只负责渲染菜单项（本体 + 插件）、测量内容尺寸、回报选中项；
 * 窗口大小 / 位置 / 收起全部由主进程（menu-window.js）决定
 */

// ====== DOM 元素 ======
const elements = {
  menu: document.getElementById('menu'),
  pluginHost: document.getElementById('plugin-menu-items')
};

/**
 * 测量菜单内容尺寸并回报主进程
 * 关键：先量「内容原始尺寸」——菜单项数量不固定，窗口必须按内容自适应；
 * 临时去掉 CSS 的尺寸上限，避免量到的是上一次窗口尺寸限制后的结果（越缩越小）
 */
function reportSize() {
  const menu = elements.menu;
  if (!menu) return;

  const style = getComputedStyle(document.body);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  const prevMaxWidth = menu.style.maxWidth;
  const prevMaxHeight = menu.style.maxHeight;
  menu.style.maxWidth = 'none';
  menu.style.maxHeight = 'none';
  const width = Math.ceil(menu.scrollWidth + padX);
  const height = Math.ceil(menu.scrollHeight + padY);
  menu.style.maxWidth = prevMaxWidth;
  menu.style.maxHeight = prevMaxHeight;

  window.menuAPI.reportSize({ width, height });
}

/** 拉取插件贡献的菜单项（插件系统不可用 / 没有插件时返回空数组） */
async function loadPluginItems() {
  if (typeof window.menuAPI.getPluginMenuItems !== 'function') return [];
  try {
    const items = await window.menuAPI.getPluginMenuItems();
    return Array.isArray(items) ? items : [];
  } catch (e) {
    console.warn('插件菜单加载失败（不影响本体菜单）:', e && e.message);
    return [];
  }
}

/**
 * 渲染插件菜单项
 * @param {Array<{pluginId: string, command: string, label: string, icon?: string}>} items
 */
function renderPluginItems(items) {
  const host = elements.pluginHost;
  if (!host) return;

  if (items.length === 0) {
    host.innerHTML = '';
    host.classList.add('hidden');
    return;
  }

  host.innerHTML = items.map((item) => {
    const icon = escapeHtml(item.icon || '🧩');
    const label = escapeHtml(item.label || item.command || '插件功能');
    return `<div class="menu-item" data-plugin-id="${escapeAttr(item.pluginId)}" data-command="${escapeAttr(item.command)}">` +
      `<span class="menu-icon">${icon}</span><span class="menu-label">${label}</span></div>`;
  }).join('');
  host.classList.remove('hidden');
}

/** 展开菜单：渲染最新内容 → 量尺寸 → 回报主进程 */
async function showMenu() {
  renderPluginItems(await loadPluginItems());

  // 重新播放入场动画
  const menu = elements.menu;
  if (menu) {
    menu.classList.remove('menu-in');
    void menu.offsetWidth;
    menu.classList.add('menu-in');
  }

  // 等这一帧布局完成后再测量
  requestAnimationFrame(() => reportSize());
}

// ====== 事件 ======

// 选中某一项：本体动作交给 pet.js 里的 handleMenuAction，插件命令交给插件系统
elements.menu.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  if (item.dataset.pluginId) {
    window.menuAPI.select({ pluginId: item.dataset.pluginId, command: item.dataset.command || '' });
  } else {
    window.menuAPI.select({ action: item.dataset.action || '' });
  }
});

// Esc 收起菜单
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.menuAPI.close();
});

// 右键菜单窗口里不弹浏览器自带菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 主进程通知展开
if (window.menuAPI && typeof window.menuAPI.onShow === 'function') {
  window.menuAPI.onShow(() => { showMenu(); });
}

// ====== 工具函数 ======

/** HTML 转义 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HTML 属性转义（用于 data-* 属性） */
function escapeAttr(text) {
  return escapeHtml(text);
}
