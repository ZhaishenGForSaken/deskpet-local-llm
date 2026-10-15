/**
 * 桌面小对话窗（插件私有）
 * 从桌宠右键菜单「快速提问」打开：一张浮在桌宠上方的小卡片，与完整对话窗口共用会话。
 * 卡片跟随桌宠移动；上方放不下时翻到桌宠下方；高度由渲染进程按内容回报。
 */

const path = require('path');

const isMac = process.platform === 'darwin';

const WIDTH = 380;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 560;
/** 跟随桌宠的检测间隔 */
const FOLLOW_MS = 300;
/** 卡片与桌宠之间的间距 */
const GAP = 6;

let miniWindow = null;
let followTimer = null;
let lastPetKey = '';
let height = 170;

function getMiniWindow() {
  if (miniWindow && miniWindow.isDestroyed()) miniWindow = null;
  return miniWindow;
}

/** 按桌宠位置摆放卡片：优先在桌宠正上方，放不下翻到下方，并限制在屏幕内 */
function positionMini(ctx) {
  const win = getMiniWindow();
  const fn = ctx.host && ctx.host.getPetBounds;
  const pet = typeof fn === 'function' ? fn() : null;
  if (!win || !pet) return;

  const area = pet.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  let x = Math.round(pet.x + pet.width / 2 - WIDTH / 2);
  let y = Math.round(pet.y - height - GAP);
  if (y < area.y + 4) y = Math.round(pet.y + pet.height + GAP);
  x = Math.min(Math.max(x, area.x + 4), area.x + area.width - WIDTH - 4);
  y = Math.min(Math.max(y, area.y + 4), area.y + area.height - height - 4);
  win.setBounds({ x, y, width: WIDTH, height });
}

function startFollowing(ctx) {
  stopFollowing();
  followTimer = setInterval(() => {
    const win = getMiniWindow();
    if (!win) { stopFollowing(); return; }
    if (!win.isVisible()) return;
    const fn = ctx.host && ctx.host.getPetBounds;
    const pet = typeof fn === 'function' ? fn() : null;
    const key = pet ? `${pet.x},${pet.y},${pet.width},${pet.height}` : '';
    if (key !== lastPetKey) {
      lastPetKey = key;
      positionMini(ctx);
    }
  }, FOLLOW_MS);
}

function stopFollowing() {
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
  lastPetKey = '';
}

/**
 * 打开 / 聚焦小对话窗
 * @param {Object} ctx 插件上下文
 */
function createMiniWindow(ctx) {
  const existing = getMiniWindow();
  if (existing) {
    positionMini(ctx);
    existing.show();
    existing.focus();
    existing.webContents.send(`plugin:${ctx.id}:mini-focus`);
    return existing;
  }

  const win = ctx.createWindow({
    width: WIDTH,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'DeskPet - 快速提问',
    backgroundColor: '#00000000'
  });
  win.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'floating');
  win.loadFile(path.join(ctx.dir, 'renderer', 'mini.html'));

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    positionMini(ctx);
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (miniWindow === win) miniWindow = null;
    stopFollowing();
  });

  miniWindow = win;
  startFollowing(ctx);
  return win;
}

/** 渲染进程回报内容高度 → 调整窗口高度并重新摆放 */
function resizeMini(ctx, requested) {
  const value = Math.round(Number(requested) || 0);
  if (!value) return;
  height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value));
  positionMini(ctx);
}

function closeMini() {
  const win = getMiniWindow();
  if (win) win.close();
}

/** 小对话窗是否正显示在桌面上（用来决定要不要把回复同步成桌宠气泡） */
function isMiniVisible() {
  const win = getMiniWindow();
  return !!win && win.isVisible();
}

module.exports = { createMiniWindow, getMiniWindow, resizeMini, closeMini, isMiniVisible };
