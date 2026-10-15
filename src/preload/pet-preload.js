/**
 * 桌宠窗口预加载脚本
 * 安全地暴露主进程 API 到渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  // 获取配置
  getAnimationConfig: () => ipcRenderer.invoke('get-animation-config'),
  getAvailableAnimations: () => ipcRenderer.invoke('get-available-animations'),
  getPetConfig: () => ipcRenderer.invoke('get-pet-config'),
  getBalanceConfig: () => ipcRenderer.invoke('get-balance-config'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // 本地模型状态
  getApiBalance: () => ipcRenderer.invoke('get-api-balance'),

  // 气泡（由独立的气泡窗口显示）
  showBubble: (payload) => ipcRenderer.invoke('pet-show-bubble', payload),

  // 窗口操作
  moveWindow: (payload) => ipcRenderer.send('move-pet-window', payload),
  openSettings: () => ipcRenderer.invoke('open-settings-window'),
  hidePet: () => ipcRenderer.invoke('hide-pet'),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // 右键菜单：请求在鼠标位置展开独立菜单窗口
  openPetMenu: (position) => ipcRenderer.invoke('open-pet-menu', position),
  // 菜单选中某一项后由主进程回传（本体动作 / 插件命令）
  onMenuAction: (callback) => {
    ipcRenderer.on('pet-menu-action', (event, payload) => callback(payload));
  },

  // ====== 插件扩展点 ======
  // 触发插件命令（例如打开插件的窗口）
  runPluginCommand: (pluginId, command, payload) =>
    ipcRenderer.invoke('plugins:run-command', pluginId, command, payload),

  // 监听：动画配置变更（设置页面保存后实时生效）
  onReloadAnimations: (callback) => {
    ipcRenderer.on('reload-animations', (event, config) => callback(config));
  },
  // 监听：宠物配置变更
  onConfigChanged: (callback) => {
    ipcRenderer.on('config-changed', (event, config) => callback(config));
  },
  // 监听：模型状态配置变更
  onBalanceConfigChanged: (callback) => {
    ipcRenderer.on('balance-config-changed', (event, config) => callback(config));
  },
  // 监听：手动触发模型状态展示（托盘菜单）
  onShowBalance: (callback) => {
    ipcRenderer.on('show-balance', () => callback());
  },
  // 监听：窗口移动
  onWindowMoved: (callback) => {
    ipcRenderer.on('window-moved', (event, pos) => callback(pos));
  },
  // 监听：主题变化
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (event, theme) => callback(theme));
  }
});
