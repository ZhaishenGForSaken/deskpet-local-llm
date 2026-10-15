/**
 * 对话窗口管理（插件私有）
 * 窗口通过宿主 ctx.createWindow 创建：宿主统一注入 preload、上下文隔离与导航兜底
 */

const path = require('path');

const isMac = process.platform === 'darwin';

/** 单例窗口引用 */
let chatWindow = null;

/**
 * 创建 / 聚焦对话窗口
 * @param {Object} ctx 插件上下文
 * @returns {Object} BrowserWindow
 */
function createChatWindow(ctx) {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  const windowOptions = {
    width: 880,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    title: 'DeskPet - AI 对话',
    backgroundColor: '#1a1a2e',
    skipTaskbar: false,
    resizable: true,
    show: false
  };

  if (isMac) {
    // macOS：保留原生红绿灯，标题栏内嵌
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 12, y: 12 };
    windowOptions.vibrancy = 'under-window';
    windowOptions.visualEffectState = 'active';
  } else {
    // Windows / Linux：完全自定义标题栏
    windowOptions.frame = false;
    windowOptions.titleBarStyle = 'hidden';
  }

  const win = ctx.createWindow(windowOptions);
  win.loadFile(path.join(ctx.dir, 'renderer', 'chat.html'));

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (chatWindow === win) chatWindow = null;
  });

  chatWindow = win;
  return win;
}

/** 当前窗口（可能为 null） */
function getChatWindow() {
  if (chatWindow && chatWindow.isDestroyed()) chatWindow = null;
  return chatWindow;
}

module.exports = { createChatWindow, getChatWindow };
