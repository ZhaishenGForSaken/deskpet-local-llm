/**
 * 持久化存储模块
 * 使用 electron-store 管理应用配置
 */

const Store = require('electron-store');

const defaults = {
  // 本地大模型服务（OpenAI 兼容接口）
  llm: {
    provider: 'ollama',                         // ollama / lmstudio / llamacpp / vllm / custom
    apiEndpoint: 'http://127.0.0.1:11434/v1',
    apiKey: '',                                 // 本地服务一般不需要
    model: ''                                   // 留空则自动使用服务端第一个模型
  },
  animations: {
    idlePool: [],
    clickPool: [],
    currentIdleIndex: 0
  },
  // 模型状态气泡（沿用 balance 键名，便于兼容旧配置结构）
  balance: {
    enabled: true,
    intervalMinutes: 0,
    // 关闭状态气泡后，双击桌宠随机展示的自定义语句（每行一句）
    customPhrases: []
  },
  pet: {
    opacity: 1.0,
    scale: 1.0,
    autoStart: false,
    theme: 'dark',
    // 窗口裁剪：窗口 = 300 * scale * crop，动画本身保持原大小，只裁掉周围背景
    crop: 0.55,
    cropOffsetX: 0,
    cropOffsetY: 0
  },
  // 气泡（独立悬浮窗口）设置
  bubble: {
    scale: 1.0,      // 气泡整体大小倍率
    offsetX: 0,      // 相对宠物中心的水平偏移（像素）
    offsetY: 0       // 相对默认位置（宠物正上方）的垂直偏移（像素，负值更靠上）
  },
  windowPosition: { petX: null, petY: null },
  firstRun: true
};

let _store = null;

function getStore() {
  if (!_store) _store = new Store({ defaults });
  return _store;
}

// ====== 本地模型服务配置（状态气泡 + AI 对话插件共享） ======
function getLLMConfig() { return { ...defaults.llm, ...getStore().get('llm') }; }
function setLLMConfig(config) { getStore().set('llm', { ...getLLMConfig(), ...config }); }

// ====== 模型状态气泡配置 ======

/** 单条自定义语句的最大长度 */
const MAX_PHRASE_LENGTH = 200;
/** 自定义语句最多条数 */
const MAX_PHRASE_COUNT = 50;

/**
 * 清洗自定义语句：去掉空行、合并换行、去重、限长限量
 * 纯函数，写盘前统一用它，避免脏数据落到配置里
 */
function normalizeCustomPhrases(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PHRASE_LENGTH);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= MAX_PHRASE_COUNT) break;
  }
  return result;
}

function getBalanceConfig() { return { ...defaults.balance, ...getStore().get('balance') }; }

function setBalanceConfig(config) {
  const next = { ...getBalanceConfig(), ...config };
  if (config && config.customPhrases !== undefined) {
    next.customPhrases = normalizeCustomPhrases(config.customPhrases);
  }
  getStore().set('balance', next);
}

// ====== 动画配置 ======
function getAnimationConfig() { return { ...defaults.animations, ...getStore().get('animations') }; }
function setAnimationConfig(config) { getStore().set('animations', { ...getAnimationConfig(), ...config }); }

// ====== 宠物设置 ======
function getPetConfig() { return { ...defaults.pet, ...getStore().get('pet') }; }
function setPetConfig(config) { getStore().set('pet', { ...getPetConfig(), ...config }); }

// ====== 气泡设置 ======
function getBubbleConfig() { return { ...defaults.bubble, ...getStore().get('bubble') }; }
function setBubbleConfig(config) { getStore().set('bubble', { ...getBubbleConfig(), ...config }); }

// ====== 窗口位置 ======
function saveWindowPosition(x, y) { getStore().set('windowPosition', { petX: x, petY: y }); }
function getWindowPosition() { return getStore().get('windowPosition'); }

// ====== 所有配置 ======
function getAllConfig() {
  return {
    llm: getLLMConfig(),
    animations: getAnimationConfig(),
    balance: getBalanceConfig(),
    pet: getPetConfig(),
    bubble: getBubbleConfig()
  };
}

module.exports = {
  getLLMConfig, setLLMConfig,
  getBalanceConfig, setBalanceConfig,
  normalizeCustomPhrases, MAX_PHRASE_LENGTH, MAX_PHRASE_COUNT,
  getAnimationConfig, setAnimationConfig,
  getPetConfig, setPetConfig,
  getBubbleConfig, setBubbleConfig,
  saveWindowPosition, getWindowPosition,
  getAllConfig,
  getStore
};
