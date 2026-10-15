/**
 * 桌宠渲染进程逻辑
 * 拖拽移动、点击反应、双击气泡（本地模型状态 / 自定义语句），以及插件贡献的右键菜单（独立菜单窗口）
 */

// ====== 状态管理 ======
const state = {
  currentIdleFile: null,
  currentClickFile: null,
  isPlayingClick: false,
  isPlayingDrag: false,       // 是否正在播放拖拽动画

  idlePool: [],
  clickPool: [],
  dragAnimPath: null,          // 拖拽动画路径

  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  hasMoved: false,
  dragAnimTriggered: false,    // 是否已触发拖拽动画
  lastClickAt: 0,              // 上一次单击时间，用于判定双击

  autoIdleTimer: null,
  balanceTimer: null,
  placeholderAnimId: null,

  balance: {
    enabled: true,
    intervalMinutes: 0,
    customPhrases: [],         // 关闭状态气泡后，双击随机展示的自定义语句
    fetching: false,           // 是否正在检测模型服务
    lastText: '',              // 最近一次成功的状态文案
    lastData: null,            // 最近一次成功的状态数据（用于冷却期内重绘卡片）
    lastError: '',             // 最近一次失败文案
    lastOk: false,             // 最近一次是否成功
    lastFetchAt: 0             // 最近一次请求时间（用于避免连续点击刷接口）
  },

  config: {
    opacity: 1.0,
    scale: 1.0,
    idleInterval: 15000,
    crop: 0.55,
    cropOffsetX: 0,
    cropOffsetY: 0
  },

  appPath: { assets: '', projectRoot: '' }
};

/** 状态气泡自动展示的初始延迟（毫秒） */
const BALANCE_FIRST_DELAY = 3000;
/** 手动点击触发状态检测的最小间隔（毫秒），避免连点刷接口 */
const BALANCE_MANUAL_COOLDOWN = 5000;
/** 拖拽专用动画的文件名特征 */
const DRAG_ANIM_PATTERN = /被鼠标拖拽|拖拽悬空/i;
/** 双击判定阈值（毫秒）：拿不到系统点击次数时，两次单击间隔小于它算一次双击 */
const DOUBLE_CLICK_MS = 400;

/** 没有自定义语句时使用的内置问候语 */
const DEFAULT_PHRASES = ['戳我干嘛~', '嘿嘿 😊', '🐾 嗷呜~嗷呜~', '我在呢！', '❤️❤️❤️❤️❤️', '💭', '偷偷告诉你，双击我会说话哦', '🤗🤗🤗', '喵~喵~喵~', '右键我可以让我说句话哦', '好困 zZZ', '吃白饭🍚🍚🍚'];

// ====== DOM 元素 ======
const elements = {
  container: document.getElementById('pet-container'),
  video: document.getElementById('pet-video')
};

// ====== 初始化 ======
async function init() {
  await loadConfig();
  applyCrop();
  await loadAnimations();
  findDragAnimation();
  setupEventListeners();
  setupDropSafetyGuard();
  setupIpcListeners();
  startIdleAnimation();
  startBalanceTimer();

  // 启动后稍作延迟展示一次模型状态，让用户确认本地模型服务是否已启动
  if (state.balance.enabled) {
    setTimeout(() => showBalance({ silent: true }), BALANCE_FIRST_DELAY);
  }

  console.log('🐾 DeskPet 就绪',
    `闲置:${state.idlePool.length} 点击:${state.clickPool.length} 拖拽:${state.dragAnimPath ? '✓' : '✗'}`,
    `窗口裁剪:${Math.round((Number(state.config.crop) || 0.55) * 100)}%`,
    `自定义语句:${state.balance.customPhrases.length}`);
}

async function loadConfig() {
  try {
    const [petConfig, animConfig, balanceConfig, appPath] = await Promise.all([
      window.petAPI.getPetConfig(),
      window.petAPI.getAnimationConfig(),
      window.petAPI.getBalanceConfig(),
      window.petAPI.getAppPath()
    ]);
    state.config = { ...state.config, ...petConfig };
    state.appPath = appPath;
    state._savedIdlePool = animConfig.idlePool || [];
    state._savedClickPool = animConfig.clickPool || [];
    applyBalanceConfig(balanceConfig);
  } catch (e) { console.error('加载配置失败:', e); }
}

/**
 * 应用「窗口裁剪」设置
 * 动画本身保持原大小（视频尺寸 = 窗口 / 裁剪比例），窗口变小后只显示中间一块，
 * 周围不重要的背景被裁掉；偏移用来选择显示动画的哪个区域
 */
function applyCrop() {
  const crop = clampNumber(state.config.crop, 0.25, 1, 0.55);
  const offsetX = clampNumber(state.config.cropOffsetX, -50, 50, 0);
  const offsetY = clampNumber(state.config.cropOffsetY, -50, 50, 0);
  const container = elements.container;
  if (!container) return;
  container.style.setProperty('--pet-crop', String(crop));
  container.style.setProperty('--pet-offset-x', `${offsetX}%`);
  container.style.setProperty('--pet-offset-y', `${offsetY}%`);
}

/** 数值裁剪，非法值回退默认值 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

async function loadAnimations() {
  try {
    const animations = await window.petAPI.getAvailableAnimations();
    const allIdle = animations.idle || [];
    const allClick = animations.click || [];
    const savedIdle = state._savedIdlePool || [];
    const savedClick = state._savedClickPool || [];

    state.idlePool = (savedIdle.length > 0) ? allIdle.filter(a => savedIdle.includes(a.name)) : allIdle;
    state.clickPool = (savedClick.length > 0) ? allClick.filter(a => savedClick.includes(a.name)) : allClick;
    if (state.idlePool.length === 0) state.idlePool = allIdle;
    if (state.clickPool.length === 0) state.clickPool = allClick;

    // 重新查找拖拽动画
    findDragAnimation();

    delete state._savedIdlePool;
    delete state._savedClickPool;
  } catch (e) { console.error('加载动画列表失败:', e); }
}

/**
 * 查找拖拽专用动画（被鼠标拖拽悬空反馈.webm）
 */
function findDragAnimation() {
  // 在所有动画中查找拖拽动画
  const allAnims = [...state.idlePool, ...state.clickPool];
  const dragAnim = allAnims.find(a => DRAG_ANIM_PATTERN.test(a.name));
  if (dragAnim) {
    state.dragAnimPath = dragAnim.path;
  } else {
    // 如果扫描结果中没有，尝试直接构造路径
    state.dragAnimPath = 'assets/thumb/被鼠标拖拽悬空反馈.webm';
  }
}

/**
 * 应用模型状态气泡配置并重启定时器
 */
function applyBalanceConfig(config) {
  if (!config) return;
  if (config.enabled !== undefined) state.balance.enabled = !!config.enabled;
  if (config.intervalMinutes !== undefined) {
    const minutes = Number(config.intervalMinutes);
    state.balance.intervalMinutes = Number.isFinite(minutes) ? Math.max(0, minutes) : 30;
  }
  if (config.customPhrases !== undefined) {
    state.balance.customPhrases = normalizePhrases(config.customPhrases);
  }
  startBalanceTimer();
}

/** 自定义语句：只保留非空字符串（主进程写盘前已清洗过一次，这里再兜一层） */
function normalizePhrases(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((phrase) => typeof phrase === 'string' && phrase.trim())
    .map((phrase) => phrase.trim());
}

function setupIpcListeners() {
  window.petAPI.onReloadAnimations(async (animConfig) => {
    console.log('🔄 动画配置变更，实时重载');
    state._savedIdlePool = animConfig.idlePool || [];
    state._savedClickPool = animConfig.clickPool || [];
    await loadAnimations();
    if (!state.isPlayingClick && !state.isPlayingDrag) playRandomIdle();
  });

  window.petAPI.onConfigChanged((config) => {
    if (config.scale !== undefined) state.config.scale = config.scale;
    if (config.opacity !== undefined) state.config.opacity = config.opacity;
    if (config.crop !== undefined) state.config.crop = config.crop;
    if (config.cropOffsetX !== undefined) state.config.cropOffsetX = config.cropOffsetX;
    if (config.cropOffsetY !== undefined) state.config.cropOffsetY = config.cropOffsetY;
    applyCrop();
  });

  // 模型状态配置变更（设置页面保存后立即生效）
  window.petAPI.onBalanceConfigChanged((config) => {
    applyBalanceConfig(config);
    // 配置刚被修改，顺手刷新一次让用户看到效果（未启用时忽略）
    if (state.balance.enabled) showBalance();
  });

  // 托盘菜单：立即查看模型状态
  window.petAPI.onShowBalance(() => {
    showBalance({ force: true });
  });

  // 右键菜单选中了某一项（菜单在独立窗口里，选中后由主进程回传）
  if (typeof window.petAPI.onMenuAction === 'function') {
    window.petAPI.onMenuAction((payload) => {
      if (!payload) return;
      if (payload.pluginId) runPluginCommand(payload.pluginId, payload.command);
      else handleMenuAction(payload.action);
    });
  }

  window.petAPI.onThemeChanged((theme) => {
    document.body.setAttribute('data-theme', theme);
  });
}

function setupEventListeners() {
  const { container } = elements;

  container.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  container.addEventListener('contextmenu', onContextMenu);

  elements.video.addEventListener('error', onVideoError);
  document.addEventListener('keydown', onKeyDown);
}

// ====== 拖拽处理 ======

function onMouseDown(e) {
  if (e.button !== 0) return;
  state.isDragging = true;
  state.hasMoved = false;
  state.dragAnimTriggered = false;
  state.dragStartX = e.screenX;
  state.dragStartY = e.screenY;
  e.preventDefault();
}

function onMouseMove(e) {
  if (!state.isDragging) return;
  const deltaX = e.screenX - state.dragStartX;
  const deltaY = e.screenY - state.dragStartY;

  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
    // 进入拖拽模式
    if (!state.hasMoved) {
      state.hasMoved = true;
      // 触发拖拽动画
      triggerDragAnimation();
    }
    window.petAPI.moveWindow({ deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) });
    state.dragStartX = e.screenX;
    state.dragStartY = e.screenY;
  }
}

function onMouseUp(e) {
  if (!state.isDragging) return;
  state.isDragging = false;

  if (state.hasMoved) {
    // 拖拽结束
    state.isPlayingDrag = false;
    // 恢复闲置动画
    if (!state.isPlayingClick) playRandomIdle();
  } else {
    // 没有移动 → 单击 / 双击
    handlePetClick(e);
  }
}

// ====== 拖拽动画 ======

function triggerDragAnimation() {
  if (state.isPlayingDrag) return;
  state.isPlayingDrag = true;
  state.dragAnimTriggered = true;

  // 如果正在播放点击动画，优先拖拽动画
  state.isPlayingClick = false;
  // 取消正在播放 / 等待中的闲置动作动画，拖拽结束后会回到待机
  state.idleActionToken = (state.idleActionToken || 0) + 1;
  if (state.autoIdleTimer) { clearTimeout(state.autoIdleTimer); state.autoIdleTimer = null; }

  const animPath = state.dragAnimPath;
  if (animPath) {
    const video = elements.video;
    // 移除之前所有的 ended 监听器
    video.onended = null;
    playVideoOnce(animPath, () => {
      // 拖拽动画结束后循环播放
      if (state.isPlayingDrag) {
        playVideoOnce(animPath, () => {
          if (state.isPlayingDrag) playVideo(animPath, true);
        });
      }
    });
  }
}

// ====== 交互处理 ======

/**
 * 单击 / 双击分发
 * 单击：只播放点击反应动画（不再弹气泡）
 * 双击：弹气泡 —— 启用模型状态时展示模型状态，否则随机展示一句自定义语句
 *
 * 双击优先用浏览器给的点击次数（跟系统双击速度设置一致），
 * 拿不到时退回到时间间隔判断
 * @param {MouseEvent} [e] mouseup 事件
 */
function handlePetClick(e) {
  const now = Date.now();
  const isDoubleClick = Number(e && e.detail) === 2 || (now - state.lastClickAt <= DOUBLE_CLICK_MS);
  // 双击后清零，避免连点三下被判定成两次双击
  state.lastClickAt = isDoubleClick ? 0 : now;

  if (isDoubleClick) {
    triggerBubble();
  } else {
    playClickReaction();
  }
}

/** 单击反应：播放点击动画（没有点击动画时抖一下） */
function playClickReaction() {
  if (state.isPlayingClick || state.isPlayingDrag) return;
  if (state.clickPool.length > 0) {
    playClickAnimation();
  } else {
    shakePet();
  }
}

/** 双击触发的气泡：模型状态气泡（启用时）或自定义语句气泡 */
function triggerBubble() {
  if (state.balance.enabled) {
    showBalance();
  } else {
    showRandomBubble();
  }
}

function shakePet() {
  const c = elements.container;
  c.style.transition = 'transform 0.1s ease';
  c.style.transform = 'translateX(-5px)';
  setTimeout(() => { c.style.transform = 'translateX(5px)'; }, 100);
  setTimeout(() => { c.style.transform = 'translateX(-3px)'; }, 200);
  setTimeout(() => { c.style.transform = 'translateX(0)'; }, 300);
}

function onContextMenu(e) {
  e.preventDefault();
  // 菜单放在独立的透明窗口里：宠物窗口太小，菜单放在窗口内会被裁掉
  if (typeof window.petAPI.openPetMenu !== 'function') return;
  window.petAPI.openPetMenu({ x: e.clientX, y: e.clientY }).catch((err) => {
    console.warn('右键菜单打开失败:', err && err.message);
  });
}

function handleMenuAction(action) {
  switch (action) {
    case 'balance': showBalance({ force: true }); break;
    case 'settings': window.petAPI.openSettings(); showBubble('⚙️ 打开设置', 1500); break;
    case 'hide': window.petAPI.hidePet(); break;
    case 'quit': showBubble('👋 再见！', 1000); setTimeout(() => window.petAPI.quitApp(), 800); break;
  }
}

function onKeyDown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
    e.preventDefault(); window.petAPI.hidePet();
  }
}

// ====== 本地模型状态气泡 ======

/**
 * 启动/重启状态定时展示
 * intervalMinutes = 0 表示不自动展示，仅点击触发
 */
function startBalanceTimer() {
  if (state.balanceTimer) {
    clearInterval(state.balanceTimer);
    state.balanceTimer = null;
  }
  if (!state.balance.enabled) return;
  if (!(state.balance.intervalMinutes > 0)) return;

  const intervalMs = state.balance.intervalMinutes * 60 * 1000;
  state.balanceTimer = setInterval(() => {
    // 正在拖拽宠物时不打扰
    if (state.isDragging) return;
    showBalance({ silent: true });
  }, intervalMs);
}

/**
 * 展示本地模型状态气泡
 * @param {Object} [options]
 * @param {boolean} [options.force] 忽略冷却时间（右键菜单/托盘触发）
 * @param {boolean} [options.silent] 定时触发时，失败不打扰用户
 * @returns {Promise<boolean>} 模型服务是否在线
 */
async function showBalance(options = {}) {
  const { force = false, silent = false } = options;
  if (state.balance.fetching) return false;

  // 冷却期内复用最近一次结果（成功或失败），避免连续点击频繁请求接口
  if (!force && state.balance.lastFetchAt &&
      Date.now() - state.balance.lastFetchAt < BALANCE_MANUAL_COOLDOWN) {
    if (state.balance.lastOk && state.balance.lastData) {
      showBalanceCard(state.balance.lastData);
      return true;
    }
    const cached = state.balance.lastOk ? state.balance.lastText : state.balance.lastError;
    if (cached) {
      showBubble(cached, 5000);
      return state.balance.lastOk;
    }
  }

  state.balance.fetching = true;
  if (!state.balance.lastText) showBubble('🔍 正在连接本地模型...', 8000);

  let result = null;
  try {
    result = await window.petAPI.getApiBalance();
  } catch (e) {
    result = { success: false, error: e.message };
  } finally {
    state.balance.fetching = false;
  }

  state.balance.lastFetchAt = Date.now();

  if (result && result.success) {
    state.balance.lastOk = true;
    state.balance.lastError = '';
    state.balance.lastText = result.text || '🟢 本地模型在线';
    state.balance.lastData = result.data || null;
    if (result.data) {
      showBalanceCard(result.data);
    } else {
      showBubble(state.balance.lastText, 5000);
    }
    console.log('🧠 模型状态已更新:', state.balance.lastText.replace(/\n/g, ' '));
    return true;
  }

  const errorText = `🔌 本地模型离线\n${(result && result.error) || '未知错误'}`;
  state.balance.lastOk = false;
  state.balance.lastError = errorText;
  if (silent) {
    // 定时展示失败时只在控制台提示，避免频繁打扰
    console.warn(errorText);
  } else {
    showBubble(errorText, 5000);
  }
  return false;
}

// ====== 插件贡献的右键菜单 ======

/** 触发插件命令（例如打开插件窗口） */
async function runPluginCommand(pluginId, command) {
  if (typeof window.petAPI.runPluginCommand !== 'function') return;
  try {
    const result = await window.petAPI.runPluginCommand(pluginId, command, { source: 'pet-menu' });
    if (result && result.success === false) {
      showBubble(`⚠️ 插件执行失败：${result.error || '未知错误'}`, 3000);
    }
  } catch (e) {
    showBubble(`⚠️ 插件执行失败：${e.message}`, 3000);
  }
}

// ====== 拖拽安全兜底 ======
// 文件拖入功能已移除；这里只阻止窗口被浏览器默认行为导航到被拖入的文件，
// 不做任何文件操作，保证桌宠窗口始终停留在 pet.html。
function setupDropSafetyGuard() {
  const block = (e) => { e.preventDefault(); };
  window.addEventListener('dragover', block, true);
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showBubble('🐾 我暂时不接收文件哦', 2000);
  }, true);
}

// ====== 动画控制 ======

/**
 * 闲置节奏：平时循环播放「常驻待机」动画，隔一段随机时间穿插一个「动作」动画，
 * 动作动画完整播放一遍后再回到待机 —— 不会在播放中途被切走
 */
const BASE_IDLE_PATTERN = /待机|呼吸|东张西望/;
/** 两次动作动画之间的随机间隔（毫秒） */
const IDLE_ACTION_GAP_MIN = 20000;
const IDLE_ACTION_GAP_MAX = 45000;
/** 动作动画的兜底时长：万一没收到 ended 事件，也会回到待机 */
const IDLE_ACTION_MAX_MS = 20000;

function startIdleAnimation() {
  playRandomIdle();
}

/** 把闲置池分成常驻待机与动作两组；没有匹配的待机动画时，用第一个闲置动画当待机 */
function splitIdlePool() {
  const base = state.idlePool.filter((a) => BASE_IDLE_PATTERN.test(a.name));
  const actions = state.idlePool.filter((a) => !BASE_IDLE_PATTERN.test(a.name));
  if (base.length > 0) return { base, actions };
  return { base: state.idlePool.slice(0, 1), actions: state.idlePool.slice(1) };
}

/** 随机挑一个，尽量不和当前正在播的重复 */
function pickAnimation(list) {
  if (list.length === 1) return list[0];
  const candidates = list.filter((a) => a.name !== state.currentIdleFile);
  const pool = candidates.length > 0 ? candidates : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 回到闲置状态：循环播放常驻待机动画，并安排下一次动作动画 */
function playRandomIdle() {
  if (state.autoIdleTimer) { clearTimeout(state.autoIdleTimer); state.autoIdleTimer = null; }
  state.idleActionToken = (state.idleActionToken || 0) + 1;
  if (state.idlePool.length === 0) { createPlaceholderAnimation(); return; }

  const { base, actions } = splitIdlePool();
  const anim = pickAnimation(base);
  if (anim.name !== state.currentIdleFile || elements.video.loop !== true) {
    state.currentIdleFile = anim.name;
    playVideo(anim.path, true);
  }
  if (actions.length > 0) scheduleIdleAction(actions);
}

function scheduleIdleAction(actions) {
  const gap = IDLE_ACTION_GAP_MIN + Math.random() * (IDLE_ACTION_GAP_MAX - IDLE_ACTION_GAP_MIN);
  state.autoIdleTimer = setTimeout(() => {
    state.autoIdleTimer = null;
    // 正在点击 / 拖拽时不打断，稍后再试
    if (state.isPlayingClick || state.isPlayingDrag || state.isDragging) {
      scheduleIdleAction(actions);
      return;
    }
    playIdleAction(pickAnimation(actions));
  }, gap);
}

/** 完整播放一遍动作动画，结束后回到待机（被点击 / 拖拽打断时由它们负责回到待机） */
function playIdleAction(anim) {
  const token = (state.idleActionToken || 0) + 1;
  state.idleActionToken = token;
  state.currentIdleFile = anim.name;
  playVideo(anim.path, false);

  const video = elements.video;
  const finish = () => {
    video.removeEventListener('ended', finish);
    clearTimeout(guard);
    if (state.idleActionToken !== token) return;
    playRandomIdle();
  };
  const guard = setTimeout(finish, IDLE_ACTION_MAX_MS);
  video.addEventListener('ended', finish);
}

function playClickAnimation() {
  if (state.clickPool.length === 0) return;
  state.isPlayingClick = true;
  // 打断正在播放的动作动画：点击动画结束后由这里回到待机
  state.idleActionToken = (state.idleActionToken || 0) + 1;
  if (state.autoIdleTimer) { clearTimeout(state.autoIdleTimer); state.autoIdleTimer = null; }

  // 拖拽专用动画只在拖拽时播放，不参与单击随机
  const reactions = state.clickPool.filter((a) => !DRAG_ANIM_PATTERN.test(a.name));
  const pool = reactions.length > 0 ? reactions : state.clickPool;
  const anim = pool[Math.floor(Math.random() * pool.length)];
  state.currentClickFile = anim.name;
  playVideo(anim.path, false);

  const video = elements.video;
  const onEnded = () => {
    state.isPlayingClick = false;
    video.removeEventListener('ended', onEnded);
    if (!state.isPlayingDrag) playRandomIdle();
  };
  video.addEventListener('ended', onEnded);

  setTimeout(() => {
    if (state.isPlayingClick) {
      state.isPlayingClick = false;
      video.removeEventListener('ended', onEnded);
      if (!state.isPlayingDrag) playRandomIdle();
    }
  }, 12000);
}

/**
 * 播放视频（循环或单次）
 */
function playVideo(filePath, loop = true) {
  const video = elements.video;
  video.style.display = '';
  const canvas = document.getElementById('placeholder-canvas');
  if (canvas) canvas.style.display = 'none';
  if (state.placeholderAnimId) { cancelAnimationFrame(state.placeholderAnimId); state.placeholderAnimId = null; }

  video.classList.add('switching');
  const fullPath = getAssetPath(filePath);
  video.loop = loop;
  video.src = fullPath;

  video.play().then(() => {
    setTimeout(() => video.classList.remove('switching'), 200);
  }).catch((e) => {
    console.warn('视频播放失败:', filePath, e.message);
    video.classList.remove('switching');
  });
}

/**
 * 播放视频（单次，带回调）- 用于拖拽动画
 */
function playVideoOnce(filePath, onEnded) {
  const video = elements.video;
  video.style.display = '';
  const canvas = document.getElementById('placeholder-canvas');
  if (canvas) canvas.style.display = 'none';
  if (state.placeholderAnimId) { cancelAnimationFrame(state.placeholderAnimId); state.placeholderAnimId = null; }

  video.loop = false;
  const fullPath = getAssetPath(filePath);
  video.src = fullPath;

  const handler = () => {
    video.removeEventListener('ended', handler);
    if (onEnded) onEnded();
  };
  video.addEventListener('ended', handler);

  video.play().catch((e) => {
    console.warn('拖拽动画播放失败:', e.message);
    video.removeEventListener('ended', handler);
    if (onEnded) onEnded();
  });
}

/**
 * 获取 file:// URL（正确处理中文文件名）
 */
function getAssetPath(relativePath) {
  const projectRoot = state.appPath.projectRoot || '';
  const cleanPath = relativePath.replace(/\\/g, '/');
  const lastSlash = cleanPath.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? cleanPath.substring(0, lastSlash) : '';
  const filePart = lastSlash >= 0 ? cleanPath.substring(lastSlash + 1) : cleanPath;
  const encodedFile = encodeURIComponent(filePart);
  return `file://${projectRoot}/${dirPart}/${encodedFile}`;
}

function onVideoError(e) {
  const video = elements.video;
  const src = video.src || '';
  console.warn('视频加载错误:', decodeURIComponent(src.substring(src.lastIndexOf('/') + 1)));
  if (!src || src === 'file:///' || src === 'file://') {
    createPlaceholderAnimation();
  }
}

// ====== Canvas 占位动画 ======

function createPlaceholderAnimation() {
  const video = elements.video;
  const container = elements.container;
  video.style.display = 'none';

  let canvas = document.getElementById('placeholder-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'placeholder-canvas';
    canvas.width = 200; canvas.height = 200;
    canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;';
    container.insertBefore(canvas, video);
  }
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  let frame = 0;
  if (state.placeholderAnimId) cancelAnimationFrame(state.placeholderAnimId);

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const bounce = Math.sin(frame * 0.1) * 10;
    const bodyY = cy + bounce;
    ctx.fillStyle = '#8a2be2';
    ctx.beginPath(); ctx.arc(cx, bodyY, 50, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx - 15, bodyY - 10, 12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 15, bodyY - 10, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath(); ctx.arc(cx - 15, bodyY - 10, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 15, bodyY - 10, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, bodyY + 5, 20, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
    ctx.fillStyle = '#7b2d8e';
    ctx.beginPath(); ctx.arc(cx - 30, bodyY - 45, 15, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 30, bodyY - 45, 15, 0, Math.PI * 2); ctx.fill();
    frame++;
    state.placeholderAnimId = requestAnimationFrame(animate);
  }
  animate();
}

// ====== 气泡（交给独立的气泡窗口显示） ======

/**
 * 显示普通文字气泡
 * @param {string} text 支持 \n 换行的多行文案
 * @param {number} [duration] 展示时长（毫秒）
 */
function showBubble(text, duration = 2000) {
  try {
    window.petAPI.showBubble({ kind: 'text', text: String(text), duration });
  } catch (e) {
    console.warn('气泡显示失败:', e.message);
  }
}

/**
 * 显示模型状态卡片（由气泡窗口渲染，比文字气泡更大更醒目）
 * @param {Object} data - 主进程返回的状态数据
 * @param {number} [duration] 展示时长（毫秒），默认 6 秒
 */
function showBalanceCard(data, duration = 6000) {
  try {
    window.petAPI.showBubble({ kind: 'status', data, duration });
  } catch (e) {
    console.warn('状态气泡显示失败:', e.message);
    showBubble(formatBalancePlain(data), duration);
  }
}

/** 卡片不可用时的纯文本兜底 */
function formatBalancePlain(data) {
  if (!data) return '🟢 本地模型在线';
  const models = Array.isArray(data.models) ? data.models : [];
  return `🟢 ${data.providerName || '本地模型'} 在线\n${data.model || '尚未选择模型'}\n共 ${models.length} 个模型`;
}

/**
 * 随机展示一句自定义语句（没配置时用内置问候语）
 * 只在关闭状态气泡后由双击触发
 */
function showRandomBubble() {
  const custom = state.balance.customPhrases;
  const phrases = custom.length > 0 ? custom : DEFAULT_PHRASES;
  showBubble(phrases[Math.floor(Math.random() * phrases.length)], 2500);
}

// ====== 启动 ======
document.addEventListener('DOMContentLoaded', init);
window.petState = state;
