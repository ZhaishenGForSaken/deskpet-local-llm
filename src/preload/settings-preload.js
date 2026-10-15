/**
 * 设置窗口预加载脚本
 * 安全地暴露主进程 API 到渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  // 获取所有配置
  getAllConfig: () => ipcRenderer.invoke('get-all-config'),
  // 获取 / 更新 API 配置（仅用于余额查询）
  getLLMConfig: () => ipcRenderer.invoke('get-llm-config'),
  setLLMConfig: (config) => ipcRenderer.invoke('set-llm-config', config),
  // 查询 API 余额（同时用于测试 API Key 是否可用）
  getApiBalance: () => ipcRenderer.invoke('get-api-balance'),
  // 获取 / 更新余额气泡配置
  getBalanceConfig: () => ipcRenderer.invoke('get-balance-config'),
  setBalanceConfig: (config) => ipcRenderer.invoke('set-balance-config', config),
  // 气泡窗口的大小 / 位置
  getBubbleConfig: () => ipcRenderer.invoke('get-bubble-config'),
  setBubbleConfig: (config) => ipcRenderer.invoke('set-bubble-config', config),
  // 预览气泡
  previewBubble: () => ipcRenderer.invoke('preview-bubble'),
  // 预览双击自定义语句
  previewPhrase: (text) => ipcRenderer.invoke('preview-phrase', { text }),
  // 获取动画配置
  getAnimationConfig: () => ipcRenderer.invoke('get-animation-config'),
  // 更新动画配置
  setAnimationConfig: (config) => ipcRenderer.invoke('set-animation-config', config),
  // 获取可用动画列表
  getAvailableAnimations: () => ipcRenderer.invoke('get-available-animations'),
  // 获取宠物设置
  getPetConfig: () => ipcRenderer.invoke('get-pet-config'),
  // 更新宠物设置
  setPetConfig: (config) => ipcRenderer.invoke('set-pet-config', config),
  // 选择动画文件
  selectAnimationFile: () => ipcRenderer.invoke('select-animation-file'),
  // 获取应用路径
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // 窗口控制
  closeWindow: () => ipcRenderer.invoke('close-settings-window'),

  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ====== 插件扩展点 ======
  // 已加载的插件列表
  getPlugins: () => ipcRenderer.invoke('plugins:list'),
  // 插件声明的设置面板（title / fields / actions）
  getPluginSettingsSections: () => ipcRenderer.invoke('plugins:get-settings-sections'),
  // 读取 / 保存某个插件的设置
  getPluginSettings: (pluginId) => ipcRenderer.invoke('plugins:get-settings', pluginId),
  setPluginSettings: (pluginId, values) => ipcRenderer.invoke('plugins:set-settings', pluginId, values),
  // 触发插件设置页上的动作按钮（例如「测试连接」）
  runPluginSettingsAction: (pluginId, actionId, values) =>
    ipcRenderer.invoke('plugins:run-settings-action', pluginId, actionId, values)
});
