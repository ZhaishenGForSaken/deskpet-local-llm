/**
 * AI 对话插件 - 渲染进程预加载脚本
 *
 * 所有通道都由宿主命名空间化：plugin:llm-chat:*
 * 因此本插件不可能与本体或其它插件的通道冲突。
 */

const { contextBridge, ipcRenderer } = require('electron');

const PLUGIN_ID = 'llm-chat';
const channel = (name) => `plugin:${PLUGIN_ID}:${name}`;

contextBridge.exposeInMainWorld('chatAPI', {
  // 配置
  getConfig: () => ipcRenderer.invoke(channel('get-config')),

  // 模型
  listModels: () => ipcRenderer.invoke(channel('list-models')),
  setModel: (model) => ipcRenderer.invoke(channel('set-model'), model),

  // 会话
  listConversations: () => ipcRenderer.invoke(channel('list-conversations')),
  getActiveConversation: () => ipcRenderer.invoke(channel('get-active-conversation')),
  createConversation: (title) => ipcRenderer.invoke(channel('create-conversation'), title),
  deleteConversation: (id) => ipcRenderer.invoke(channel('delete-conversation'), id),
  renameConversation: (id, title) => ipcRenderer.invoke(channel('rename-conversation'), { id, title }),
  setActiveConversation: (id) => ipcRenderer.invoke(channel('set-active-conversation'), id),
  clearConversation: (id) => ipcRenderer.invoke(channel('clear-conversation'), id),

  // 发送 / 取消
  sendMessage: (payload) => ipcRenderer.send(channel('send-message'), payload),
  cancelStream: (requestId) => ipcRenderer.send(channel('cancel-stream'), { requestId }),

  // 窗口控制
  minimizeWindow: () => ipcRenderer.invoke(channel('minimize-window')),
  closeWindow: () => ipcRenderer.invoke(channel('close-window')),

  // 打开本体设置页
  openHostSettings: () => ipcRenderer.invoke(channel('open-host-settings')),

  // 事件
  onStreamChunk: (callback) => ipcRenderer.on(channel('stream-chunk'), (event, data) => callback(data)),
  onStreamDone: (callback) => ipcRenderer.on(channel('stream-done'), (event, data) => callback(data)),
  onStreamError: (callback) => ipcRenderer.on(channel('stream-error'), (event, data) => callback(data)),
  onConversationUpdated: (callback) => ipcRenderer.on(channel('conversation-updated'), (event, data) => callback(data)),
  onConfigChanged: (callback) => ipcRenderer.on(channel('config-changed'), (event, data) => callback(data))
});
