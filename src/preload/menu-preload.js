/**
 * 右键菜单窗口预加载脚本
 * 安全地暴露主进程 API 到渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuAPI', {
  // 主进程通知：菜单要展开了（此时才渲染菜单项，保证显示的是最新内容）
  onShow: (callback) => {
    ipcRenderer.on('menu-show', () => callback());
  },
  // 渲染完成后把菜单内容尺寸报给主进程，由主进程调整窗口大小与位置
  reportSize: (size) => ipcRenderer.send('menu-size', size),
  // 选中某项（本体动作或插件命令）后交给主进程 → 桌宠执行
  select: (payload) => ipcRenderer.send('menu-select', payload),
  // 请求收起菜单（Esc / 空白处点击）
  close: () => ipcRenderer.send('menu-close'),

  // 插件贡献的桌宠右键菜单项（插件系统不可用时返回空数组）
  getPluginMenuItems: () => ipcRenderer.invoke('plugins:get-pet-menu')
});
