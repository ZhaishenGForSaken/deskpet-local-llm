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
  hide: () => ipcRenderer.send('bubble-hide')
});
