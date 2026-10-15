/**
 * 设置窗口预加载脚本
 * 安全地暴露主进程 API 到渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  // 获取所有配置
  getAllConfig: () => ipcRenderer.invoke('get-all-config'),
  // 获取 / 更新本地模型服务配置
  getLLMConfig: () => ipcRenderer.invoke('get-llm-config'),
  setLLMConfig: (config) => ipcRenderer.invoke('set-llm-config', config),
  // 预设的本地推理服务（Ollama / LM Studio / ...）
  getLLMProviders: () => ipcRenderer.invoke('get-llm-providers'),
  // 读取模型列表（可传入未保存的表单值）
  listLocalModels: (config) => ipcRenderer.invoke('list-local-models', config),
  // 检测本地模型服务状态（同时用于测试连接）
  getApiBalance: () => ipcRenderer.invoke('get-api-balance'),
  // 获取 / 更新状态气泡配置
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
