/**
 * 可视化设置窗口管理
 * 提供 LLM API、动画素材、宠物行为的可视化配置
 * 根据平台自动选择标题栏样式
 */

const { BrowserWindow } = require('electron');
const path = require('path');

let settingsWindow = null;

/** 当前平台 */
const isMac = process.platform === 'darwin';

/**
 * 创建设置窗口
 */
function createSettingsWindow() {
  // 如果已存在，则聚焦
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const windowOpts = {
    width: 700,
    height: 650,
    minWidth: 600,
    minHeight: 500,
    title: 'DeskLLMPet - 设置',
    backgroundColor: '#1a1a2e',
    skipTaskbar: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  if (isMac) {
    // macOS: 使用 hiddenInset 标题栏，红绿灯自动浮在左上角
    windowOpts.titleBarStyle = 'hiddenInset';
    windowOpts.frame = true;
    windowOpts.vibrancy = 'under-window';
    windowOpts.visualEffectState = 'active';
    windowOpts.trafficLightPosition = { x: 12, y: 12 };
  } else {
    // Windows: 完全自定义标题栏
    windowOpts.frame = false;
    windowOpts.titleBarStyle = 'hidden';
  }

  settingsWindow = new BrowserWindow(windowOpts);

  // 加载设置页面
  const settingsHtmlPath = path.join(__dirname, '..', 'renderer', 'settings', 'settings.html');
  settingsWindow.loadFile(settingsHtmlPath);

  // 传递平台信息
  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('platform-info', { isMac });
  });

  // 窗口关闭时释放引用
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

/**
 * 获取设置窗口实例
 */
function getSettingsWindow() {
  return settingsWindow;
}

module.exports = {
  createSettingsWindow,
  getSettingsWindow
};