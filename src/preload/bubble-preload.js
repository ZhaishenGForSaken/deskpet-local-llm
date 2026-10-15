/**
 * 气泡窗口预加载脚本
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleAPI', {
  // 主进程下发气泡内容
  onShow: (callback) => {
    ipcRenderer.on('bubble-show', (event, payload) => callback(payload));
  },
  // 回报内容尺寸（主进程据此调整窗口大小与位置）
  reportSize: (size) => ipcRenderer.send('bubble-size', size),
  // 展示结束，通知主进程隐藏气泡窗口
  hide: () => ipcRenderer.send('bubble-hide'),
  // 可点击气泡：鼠标悬停时接收点击、离开时恢复穿透
  setInteractive: (interactive) => ipcRenderer.send('bubble-interactive', !!interactive),
  // 可点击气泡被点击
  click: () => ipcRenderer.send('bubble-click')
});
