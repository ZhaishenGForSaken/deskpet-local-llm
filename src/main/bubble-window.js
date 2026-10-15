/**
 * 气泡悬浮窗口
 *
 * 为什么单独开一个窗口：
 *   宠物窗口会按「窗口裁剪」收紧到只剩动画主体，窗口很小；
 *   气泡放在宠物窗口里就会又小又挡住宠物。
 *   所以气泡用独立的透明置顶窗口，可以任意大小、任意位置，并且鼠标完全穿透。
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { getBubbleConfig } = require('../shared/store');
const { getPetWindow } = require('./pet-window');

let bubbleWindow = null;
/** 气泡内容尺寸（由气泡渲染进程测量后回传） */
let contentSize = { width: 280, height: 90 };
/** 是否有待显示的内容（等尺寸回传后再显示，避免闪一下） */
let pendingShow = false;
/** 当前气泡被点击时的回调（只有插件传了 onClick 的气泡才可点击） */
let clickHandler = null;

const isMac = process.platform === 'darwin';

/** 创建（或复用）气泡窗口 */
function createBubbleWindow() {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) return bubbleWindow;

  bubbleWindow = new BrowserWindow({
    width: contentSize.width,
    height: contentSize.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 不抢焦点：气泡是纯展示，绝不能打断用户正在做的事
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  bubbleWindow.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'floating');
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认鼠标穿透，气泡不会挡住点击 / 拖拽宠物；
  // forward 让渲染进程仍能收到 mousemove，可点击的气泡在鼠标悬停时才临时接收点击
  bubbleWindow.setIgnoreMouseEvents(true, { forward: true });

  bubbleWindow.loadFile(path.join(__dirname, '..', 'renderer', 'bubble', 'bubble.html'));

  bubbleWindow.on('closed', () => { bubbleWindow = null; });

  return bubbleWindow;
}

function getBubbleWindow() {
  return bubbleWindow && !bubbleWindow.isDestroyed() ? bubbleWindow : null;
}

/**
 * 把气泡窗口摆到宠物正上方（可按设置偏移），并限制在屏幕内
 */
function positionBubble() {
  const win = getBubbleWindow();
  const pet = getPetWindow();
  if (!win || !pet || pet.isDestroyed()) return;

  const cfg = getBubbleConfig();
  const [petX, petY] = pet.getPosition();
  const [petW, petH] = pet.getSize();
  const { width: bw, height: bh } = contentSize;

  const display = screen.getDisplayNearestPoint({ x: petX, y: petY });
  const area = display.workArea;

  // 默认：气泡底边贴着宠物顶边，水平居中对齐宠物
  let x = Math.round(petX + petW / 2 - bw / 2 + (Number(cfg.offsetX) || 0));
  let y = Math.round(petY - bh + (Number(cfg.offsetY) || 0));

  // 上方放不下就贴着宠物顶部（而不是跑出屏幕）
  if (y < area.y + 4) y = Math.max(area.y + 4, petY + 4);

  x = Math.min(Math.max(x, area.x + 4), area.x + area.width - bw - 4);
  y = Math.min(Math.max(y, area.y + 4), area.y + area.height - bh - 4);

  win.setBounds({ x, y, width: bw, height: bh });
}

/**
 * 显示气泡
 * @param {Object} payload { kind: 'text'|'status', text, data, duration, onClick? }
 *   onClick（仅主进程内可传）：气泡被点击时的回调，传了才可点击
 */
function showBubble(payload) {
  // 宠物被隐藏时不弹气泡（例如托盘里点了「隐藏桌宠」）
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed() || !pet.isVisible()) {
    return { success: false, reason: 'pet-hidden' };
  }

  const win = createBubbleWindow();
  const cfg = getBubbleConfig();
  clickHandler = typeof payload.onClick === 'function' ? payload.onClick : null;
  setBubbleInteractive(false);
  const message = {
    kind: payload.kind || 'text',
    text: payload.text || '',
    data: payload.data || null,
    duration: Number(payload.duration) || 2500,
    scale: Number(cfg.scale) || 1,
    clickable: !!clickHandler
  };

  const dispatch = () => {
    if (!win || win.isDestroyed()) return;
    pendingShow = true;
    win.webContents.send('bubble-show', message);
    // 兜底：渲染进程万一没回报尺寸，也要把气泡显示出来
    setTimeout(() => {
      if (pendingShow) {
        pendingShow = false;
        if (getBubbleWindow()) {
          positionBubble();
          getBubbleWindow().showInactive();
        }
      }
    }, 200);
  };

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }
  return { success: true };
}

/** 隐藏气泡 */
function hideBubble() {
  pendingShow = false;
  clickHandler = null;
  setBubbleInteractive(false);
  const win = getBubbleWindow();
  if (win && win.isVisible()) win.hide();
}

/** 鼠标悬停在可点击气泡上时接收点击，离开后恢复穿透 */
function setBubbleInteractive(interactive) {
  const win = getBubbleWindow();
  if (!win) return;
  const on = !!interactive && !!clickHandler;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

/** 气泡被点击：执行回调并收起气泡 */
function clickBubble() {
  const handler = clickHandler;
  hideBubble();
  if (handler) {
    try { handler(); } catch (e) { console.warn('气泡点击回调异常:', e.message); }
  }
}

/**
 * 气泡渲染进程回报内容尺寸 → 调整窗口大小并重新定位
 * @param {{width:number,height:number}} size
 */
function applyBubbleSize(size) {
  const width = Math.min(460, Math.max(80, Math.round(Number(size && size.width) || 0)));
  const height = Math.min(340, Math.max(40, Math.round(Number(size && size.height) || 0)));
  contentSize = { width, height };

  const win = getBubbleWindow();
  if (!win) return;
  win.setSize(width, height);
  positionBubble();

  if (pendingShow) {
    pendingShow = false;
    win.showInactive();
  }
}

module.exports = {
  createBubbleWindow,
  getBubbleWindow,
  showBubble,
  hideBubble,
  positionBubble,
  applyBubbleSize,
  setBubbleInteractive,
  clickBubble
};
