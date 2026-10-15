/**
 * 设置窗口逻辑
 * 处理本地模型服务配置、动画选择、宠物设置等的可视化配置
 * 插件设置面板（contributes.settings）由插件系统动态追加
 */

// ====== 状态管理 ======
const state = {
  config: {
    llm: {},
    animations: {},
    balance: {},
    pet: {}
  },
  availableAnimations: { idle: [], click: [] },
  selectedIdle: [],
  selectedClick: [],
  basePool: []          // 被设为「待机」的闲置动画（为空时按文件名自动判断）
};

// ====== DOM 元素 ======
const elements = {};

// ====== 初始化 ======
async function init() {
  // 平台检测
  const isMac = navigator.userAgent.includes('Mac');
  document.body.className = isMac ? 'platform-mac' : 'platform-win';

  cacheElements();
  await loadAllConfig();
  setupTabNavigation();
  setupEventListeners();
  populateForms();

  // 显示当前运行的代码目录与版本，方便确认「跑的是哪份代码」
  try {
    const paths = await window.settingsAPI.getAppPath();
    const el = document.getElementById('about-code-root');
    if (el && paths && paths.projectRoot) el.textContent = paths.projectRoot;
    const versionEl = document.querySelector('#tab-about .version');
    if (versionEl && paths && paths.version) versionEl.textContent = `v${paths.version}`;
  } catch (e) { /* 忽略 */ }

  // 插件设置面板（没有插件时什么都不做）
  await renderPluginSections();

  console.log('⚙️ 设置窗口已就绪');
}

/**
 * 缓存所有 DOM 元素
 */
function cacheElements() {
  elements.btnClose = document.getElementById('btn-close');

  // API 配置
  elements.apiEndpoint = document.getElementById('api-endpoint');
  elements.apiKey = document.getElementById('api-key');
  elements.llmProvider = document.getElementById('llm-provider');
  elements.llmModel = document.getElementById('llm-model');
  elements.llmModelList = document.getElementById('llm-model-list');
  elements.llmModelHint = document.getElementById('llm-model-hint');
  elements.btnRefreshModels = document.getElementById('btn-refresh-models');
  elements.toggleApiKey = document.getElementById('toggle-api-key');
  elements.btnTestApi = document.getElementById('btn-test-api');
  elements.btnSaveApi = document.getElementById('btn-save-api');
  elements.apiTestResult = document.getElementById('api-test-result');

  // 动画配置
  elements.idleAnimList = document.getElementById('idle-anim-list');
  elements.clickAnimList = document.getElementById('click-anim-list');
  elements.btnSelectAllIdle = document.getElementById('btn-select-all-idle');
  elements.btnSelectAllClick = document.getElementById('btn-select-all-click');
  elements.btnSaveAnimations = document.getElementById('btn-save-animations');
  elements.rhythmActionEnabled = document.getElementById('rhythm-action-enabled');
  elements.rhythmGapMin = document.getElementById('rhythm-gap-min');
  elements.rhythmGapMax = document.getElementById('rhythm-gap-max');
  elements.rhythmHint = document.getElementById('rhythm-hint');

  // 宠物设置
  elements.petOpacity = document.getElementById('pet-opacity');
  elements.opacityValue = document.getElementById('opacity-value');
  elements.petScale = document.getElementById('pet-scale');
  elements.scaleValue = document.getElementById('scale-value');
  elements.petAutoStart = document.getElementById('pet-auto-start');
  elements.btnSavePet = document.getElementById('btn-save-pet');

  // 窗口裁剪
  elements.crop = document.getElementById('pet-crop');
  elements.cropValue = document.getElementById('crop-value');
  elements.cropX = document.getElementById('pet-crop-x');
  elements.cropXValue = document.getElementById('crop-x-value');
  elements.cropY = document.getElementById('pet-crop-y');
  elements.cropYValue = document.getElementById('crop-y-value');
  elements.btnResetCrop = document.getElementById('btn-reset-crop');

  // 气泡
  elements.bubbleScale = document.getElementById('bubble-scale');
  elements.bubbleScaleValue = document.getElementById('bubble-scale-value');
  elements.bubbleOffsetX = document.getElementById('bubble-offset-x');
  elements.bubbleXValue = document.getElementById('bubble-x-value');
  elements.bubbleOffsetY = document.getElementById('bubble-offset-y');
  elements.bubbleYValue = document.getElementById('bubble-y-value');
  elements.btnPreviewBubble = document.getElementById('btn-preview-bubble');
  elements.btnResetBubble = document.getElementById('btn-reset-bubble');

  // 模型状态气泡
  elements.balanceEnabled = document.getElementById('balance-enabled');
  elements.balanceInterval = document.getElementById('balance-interval');
  elements.balancePhrases = document.getElementById('balance-phrases');
  elements.balancePhrasesHint = document.getElementById('balance-phrases-hint');
  elements.btnPreviewPhrase = document.getElementById('btn-preview-phrase');
}

/**
 * 加载所有配置
 */
async function loadAllConfig() {
  try {
    const [config, animations] = await Promise.all([
      window.settingsAPI.getAllConfig(),
      window.settingsAPI.getAvailableAnimations()
    ]);

    state.config = config;
    state.availableAnimations = animations;
    state.selectedIdle = config.animations.idlePool || [];
    state.selectedClick = config.animations.clickPool || [];
    state.basePool = config.animations.basePool || [];
  } catch (e) {
    console.error('加载配置失败:', e);
  }
}

/**
 * 设置标签导航
 * 用事件委托实现：插件可以在初始化后动态追加标签页，无需重新绑定
 */
function setupTabNavigation() {
  const nav = document.getElementById('tab-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn || !btn.dataset.tab) return;
    switchTab(btn.dataset.tab);
  });
}

/** 切换到指定标签页（tabName 与面板 id 的 tab- 前缀对应） */
function switchTab(tabName) {
  document.querySelectorAll('#tab-nav .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('#tab-content .tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

/**
 * 设置事件监听器
 */
function setupEventListeners() {
  // 标题栏
  elements.btnClose.addEventListener('click', () => window.settingsAPI.closeWindow());

  // 显示/隐藏 API Key
  elements.toggleApiKey.addEventListener('click', () => {
    const input = elements.apiKey;
    if (input.type === 'password') {
      input.type = 'text';
      elements.toggleApiKey.textContent = '🙈';
    } else {
      input.type = 'password';
      elements.toggleApiKey.textContent = '👁️';
    }
  });

  // 保存 API 配置
  elements.btnSaveApi.addEventListener('click', () => saveApiConfig(true));

  // 测试本地模型服务连接
  elements.btnTestApi.addEventListener('click', testApiConnection);

  // 切换服务类型：自动填入默认地址（自定义类型保留用户填写的地址）
  elements.llmProvider.addEventListener('change', async () => {
    const providers = await getProviders();
    const preset = providers[elements.llmProvider.value];
    if (preset && preset.baseUrl) elements.apiEndpoint.value = preset.baseUrl;
    elements.llmModelList.innerHTML = '';
    refreshModelList({ quiet: true });
  });

  // 从服务读取模型列表
  elements.btnRefreshModels.addEventListener('click', () => refreshModelList());

  // 宠物透明度
  elements.petOpacity.addEventListener('input', () => {
    elements.opacityValue.textContent = Math.round(elements.petOpacity.value * 100) + '%';
  });

  // 宠物大小
  elements.petScale.addEventListener('input', () => {
    elements.scaleValue.textContent = parseFloat(elements.petScale.value).toFixed(1) + 'x';
  });

  // 窗口裁剪：拖动即时预览（防抖写盘）
  elements.crop.addEventListener('input', () => {
    elements.cropValue.textContent = Math.round(parseFloat(elements.crop.value) * 100) + '%';
    queueCropPreview();
  });
  elements.cropX.addEventListener('input', () => {
    elements.cropXValue.textContent = Math.round(elements.cropX.value) + '%';
    queueCropPreview();
  });
  elements.cropY.addEventListener('input', () => {
    elements.cropYValue.textContent = Math.round(elements.cropY.value) + '%';
    queueCropPreview();
  });
  elements.btnResetCrop.addEventListener('click', () => {
    elements.crop.value = '0.55';
    elements.cropValue.textContent = '55%';
    elements.cropX.value = '0';
    elements.cropXValue.textContent = '0%';
    elements.cropY.value = '0';
    elements.cropYValue.textContent = '0%';
    queueCropPreview(0);
  });

  // 气泡大小 / 位置：即时生效（防抖写盘）
  elements.bubbleScale.addEventListener('input', () => {
    elements.bubbleScaleValue.textContent = parseFloat(elements.bubbleScale.value).toFixed(2) + 'x';
    queueBubblePreview();
  });
  elements.bubbleOffsetX.addEventListener('input', () => {
    elements.bubbleXValue.textContent = Math.round(elements.bubbleOffsetX.value) + 'px';
    queueBubblePreview();
  });
  elements.bubbleOffsetY.addEventListener('input', () => {
    elements.bubbleYValue.textContent = Math.round(elements.bubbleOffsetY.value) + 'px';
    queueBubblePreview();
  });
  elements.btnPreviewBubble.addEventListener('click', () => {
    window.settingsAPI.previewBubble();
  });
  elements.btnResetBubble.addEventListener('click', () => {
    elements.bubbleScale.value = '1';
    elements.bubbleScaleValue.textContent = '1.00x';
    elements.bubbleOffsetX.value = '0';
    elements.bubbleXValue.textContent = '0px';
    elements.bubbleOffsetY.value = '0';
    elements.bubbleYValue.textContent = '0px';
    queueBubblePreview(0);
  });

  // 保存宠物设置
  elements.btnSavePet.addEventListener('click', savePetConfig);

  // 双击自定义语句：开关联动提示 + 预览
  elements.balanceEnabled.addEventListener('change', updatePhraseHint);
  elements.btnPreviewPhrase.addEventListener('click', previewPhrase);

  // 关于页面 GitHub 链接
  const githubLink = document.getElementById('about-github-link');
  if (githubLink) {
    githubLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.settingsAPI.openExternal?.('https://github.com/isKage/desk-llm-pet');
    });
  }

  // 动画配置按钮
  elements.btnSaveAnimations.addEventListener('click', saveAnimationConfig);
  if (elements.btnSelectAllIdle) elements.btnSelectAllIdle.addEventListener('click', () => selectAllAnimations('idle'));
  if (elements.btnSelectAllClick) elements.btnSelectAllClick.addEventListener('click', () => selectAllAnimations('click'));
}

/**
 * 填充表单
 */
function populateForms() {
  const { llm = {}, balance = {}, pet = {} } = state.config || {};

  // 本地模型服务
  elements.llmProvider.value = llm.provider || 'ollama';
  elements.apiEndpoint.value = llm.apiEndpoint || '';
  elements.apiKey.value = llm.apiKey || '';
  elements.llmModel.value = llm.model || '';
  refreshModelList({ quiet: true });

  // 模型状态气泡
  elements.balanceEnabled.checked = balance.enabled !== false;
  elements.balanceInterval.value = Number.isFinite(Number(balance.intervalMinutes))
    ? Number(balance.intervalMinutes) : 0;
  // 双击自定义语句（每行一句）
  elements.balancePhrases.value = Array.isArray(balance.customPhrases)
    ? balance.customPhrases.join('\n')
    : '';
  updatePhraseHint();

  // 宠物设置
  elements.petOpacity.value = pet.opacity || 1;
  elements.opacityValue.textContent = Math.round((pet.opacity || 1) * 100) + '%';
  elements.petScale.value = pet.scale || 1;
  elements.scaleValue.textContent = (pet.scale || 1).toFixed(1) + 'x';
  elements.petAutoStart.checked = pet.autoStart === true;

  // 窗口裁剪
  const crop = Number.isFinite(Number(pet.crop)) ? Number(pet.crop) : 0.55;
  elements.crop.value = String(crop);
  elements.cropValue.textContent = Math.round(crop * 100) + '%';
  const offsetX = Number.isFinite(Number(pet.cropOffsetX)) ? Number(pet.cropOffsetX) : 0;
  elements.cropX.value = String(offsetX);
  elements.cropXValue.textContent = Math.round(offsetX) + '%';
  const offsetY = Number.isFinite(Number(pet.cropOffsetY)) ? Number(pet.cropOffsetY) : 0;
  elements.cropY.value = String(offsetY);
  elements.cropYValue.textContent = Math.round(offsetY) + '%';

  // 气泡
  const bubble = state.config.bubble || {};
  const bubbleScale = Number.isFinite(Number(bubble.scale)) ? Number(bubble.scale) : 1;
  elements.bubbleScale.value = String(bubbleScale);
  elements.bubbleScaleValue.textContent = bubbleScale.toFixed(2) + 'x';
  const bubbleX = Number.isFinite(Number(bubble.offsetX)) ? Number(bubble.offsetX) : 0;
  elements.bubbleOffsetX.value = String(bubbleX);
  elements.bubbleXValue.textContent = Math.round(bubbleX) + 'px';
  const bubbleY = Number.isFinite(Number(bubble.offsetY)) ? Number(bubble.offsetY) : 0;
  elements.bubbleOffsetY.value = String(bubbleY);
  elements.bubbleYValue.textContent = Math.round(bubbleY) + 'px';

  // 播放节奏
  const animations = state.config.animations || {};
  elements.rhythmActionEnabled.checked = animations.actionEnabled !== false;
  elements.rhythmGapMin.value = Number(animations.actionGapMin) || 20;
  elements.rhythmGapMax.value = Number(animations.actionGapMax) || 45;
  updateRhythmHint();

  // 动画列表
  renderAnimationList('idle');
  renderAnimationList('click');
}

/** 没有手动指定待机动画时，按文件名自动判断（与桌宠 pet.js 保持一致） */
const BASE_IDLE_PATTERN = /待机|呼吸|东张西望/;

/** 某个闲置动画当前是否为「待机」 */
function isBaseAnimation(name) {
  return state.basePool.length > 0 ? state.basePool.includes(name) : BASE_IDLE_PATTERN.test(name);
}

/** 节奏提示：统计当前待机 / 动作数量，并提醒没有待机动画的情况 */
function updateRhythmHint() {
  if (!elements.rhythmHint) return;
  const idle = (state.availableAnimations.idle || [])
    .filter((a) => state.selectedIdle.length === 0 || state.selectedIdle.includes(a.name));
  const base = idle.filter((a) => isBaseAnimation(a.name)).length;
  const actions = idle.length - base;
  const warn = base === 0 && idle.length > 0 ? '⚠️ 没有启用的待机动画，将用第一个闲置动画当待机。' : '';
  elements.rhythmHint.textContent =
    `${warn}当前启用：待机 ${base} 个 · 动作 ${actions} 个。间隔越短桌宠越活跃（3 ~ 3600 秒）`;
}

/**
 * 渲染动画列表
 */
function renderAnimationList(type) {
  const listEl = type === 'idle' ? elements.idleAnimList : elements.clickAnimList;
  const animations = state.availableAnimations[type] || [];
  const selected = type === 'idle' ? state.selectedIdle : state.selectedClick;

  if (animations.length === 0) {
    listEl.innerHTML = `<div class="anim-empty">
      📁 暂无动画文件<br>
      <small>请将 .webm 文件放入 assets/animations/${type}/ 目录</small>
    </div>`;
    return;
  }

  listEl.innerHTML = animations.map(anim => {
    const isChecked = selected.length === 0 || selected.includes(anim.name);
    const base = type === 'idle' && isBaseAnimation(anim.name);
    const role = type === 'idle'
      ? `<select class="anim-role ${base ? 'base' : ''}" data-name="${escapeAttr(anim.name)}" title="待机：循环常驻；动作：偶尔完整播放一次">
           <option value="base" ${base ? 'selected' : ''}>待机</option>
           <option value="action" ${base ? '' : 'selected'}>动作</option>
         </select>`
      : '';
    return `
      <div class="anim-item">
        <input type="checkbox"
               value="${escapeAttr(anim.name)}"
               data-type="${escapeAttr(type)}"
               ${isChecked ? 'checked' : ''}>
        <span class="anim-item-name">🎬 ${escapeHtml(anim.name)}</span>
        ${role}
        <button class="anim-item-preview" data-path="${escapeAttr(anim.path)}">预览</button>
      </div>
    `;
  }).join('');

  // 绑定复选框事件
  listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => updateSelectedAnimations(type));
  });

  // 待机 / 动作 角色切换：一旦手动改过，就把当前全部角色固化成名单
  listEl.querySelectorAll('select.anim-role').forEach((select) => {
    select.addEventListener('change', () => {
      state.basePool = Array.from(listEl.querySelectorAll('select.anim-role'))
        .filter((s) => s.value === 'base')
        .map((s) => s.dataset.name);
      select.classList.toggle('base', select.value === 'base');
      updateRhythmHint();
    });
  });
}

/**
 * 更新选中的动画列表
 */
function updateSelectedAnimations(type) {
  const listEl = type === 'idle' ? elements.idleAnimList : elements.clickAnimList;
  const checkboxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
  const selected = Array.from(checkboxes).map(cb => cb.value);

  if (type === 'idle') {
    state.selectedIdle = selected;
    updateRhythmHint();
  } else {
    state.selectedClick = selected;
  }
}

/**
 * 全选/取消全选
 */
function selectAllAnimations(type) {
  const listEl = type === 'idle' ? elements.idleAnimList : elements.clickAnimList;
  const checkboxes = listEl.querySelectorAll('input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);

  checkboxes.forEach(cb => {
    cb.checked = !allChecked;
  });

  updateSelectedAnimations(type);
}

/**
 * 添加动画文件
 */
async function addAnimationFile(type) {
  try {
    const result = await window.settingsAPI.selectAnimationFile();
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;

    // 这里只是通知用户需要手动复制文件
    alert(`请将选中的 .webm 文件复制到 assets/animations/${type}/ 目录下，然后刷新动画列表。`);
  } catch (e) {
    console.error('选择文件失败:', e);
  }
}

let providersCache = null;

/** 预设服务列表（主进程提供，缓存一份） */
async function getProviders() {
  if (!providersCache) {
    try { providersCache = (await window.settingsAPI.getLLMProviders()) || {}; } catch (e) { providersCache = {}; }
  }
  return providersCache;
}

/** 当前表单里的服务配置（未保存也能用来读取模型列表） */
function readLLMForm() {
  return {
    provider: elements.llmProvider.value,
    apiEndpoint: elements.apiEndpoint.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    model: elements.llmModel.value.trim()
  };
}

/**
 * 从服务读取模型列表，填进模型输入框的下拉建议
 * @param {{ quiet?: boolean }} [options] quiet 为 true 时失败不提示（例如打开设置页时服务还没启动）
 */
async function refreshModelList(options = {}) {
  const hint = elements.llmModelHint;
  if (!options.quiet) hint.textContent = '⏳ 正在读取模型列表...';
  try {
    const result = await window.settingsAPI.listLocalModels(readLLMForm());
    if (!result || !result.success) throw new Error((result && result.error) || '未知错误');
    const models = result.models || [];
    elements.llmModelList.innerHTML = '';
    for (const name of models) {
      const option = document.createElement('option');
      option.value = name;
      elements.llmModelList.appendChild(option);
    }
    if (!models.length) {
      hint.textContent = '服务在线，但还没有模型。Ollama 可在终端执行：ollama pull qwen2.5:7b';
    } else {
      hint.textContent = `✅ 读取到 ${models.length} 个模型，点击输入框可选择：${models.slice(0, 6).join('、')}${models.length > 6 ? ' …' : ''}`;
      // 还没选模型时，默认填入第一个可对话的模型
      if (!elements.llmModel.value.trim() && !options.quiet) {
        elements.llmModel.value = models.find((m) => !/embed/i.test(m)) || models[0];
      }
    }
  } catch (e) {
    hint.textContent = options.quiet
      ? '点 🔄 从服务读取已下载的模型，也可以直接输入模型名（如 qwen2.5:7b）'
      : `❌ 读取失败：${e.message}`;
  }
}

/**
 * 保存本地模型服务配置
 * @param {boolean} [notify] 是否弹出保存成功提示
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveApiConfig(notify = true) {
  const config = readLLMForm();

  try {
    await window.settingsAPI.setLLMConfig(config);
    if (notify) showToast('✅ 本地模型配置已保存');
    return true;
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message);
    return false;
  }
}

/**
 * 测试本地模型服务连接（读取模型列表并检查所选模型是否存在）
 */
async function testApiConnection() {
  const resultEl = elements.apiTestResult;
  resultEl.classList.remove('hidden', 'success', 'error');
  resultEl.textContent = '⏳ 正在测试连接...';
  resultEl.className = 'test-result';

  // 先保存配置，保证用最新参数测试
  const saved = await saveApiConfig(false);
  if (!saved) {
    resultEl.textContent = '❌ 保存配置失败，请重试';
    resultEl.className = 'test-result error';
    return;
  }

  try {
    const response = await window.settingsAPI.getApiBalance();
    if (response && response.success) {
      const data = response.data || {};
      const models = data.models || [];
      if (!data.model) {
        resultEl.textContent = `⚠️ 已连接 ${data.providerName}，但服务上还没有模型。请先下载一个模型（如 ollama pull qwen2.5:7b）`;
        resultEl.className = 'test-result error';
      } else if (data.modelAvailable === false) {
        resultEl.textContent = `⚠️ 已连接 ${data.providerName}（${data.latencyMs}ms），但找不到模型「${data.model}」。可用模型：${models.join('、')}`;
        resultEl.className = 'test-result error';
      } else {
        resultEl.textContent = `✅ 已连接 ${data.providerName}（${data.latencyMs}ms），将使用模型「${data.model}」，服务上共 ${models.length} 个模型`;
        resultEl.className = 'test-result success';
      }
      refreshModelList({ quiet: true });
    } else {
      resultEl.textContent = '❌ 连接失败: ' + ((response && response.error) || '未知错误');
      resultEl.className = 'test-result error';
    }
  } catch (e) {
    resultEl.textContent = '❌ 连接失败: ' + e.message;
    resultEl.className = 'test-result error';
  }
}

/**
 * 保存动画配置
 */
async function saveAnimationConfig() {
  let gapMin = Number(elements.rhythmGapMin.value);
  let gapMax = Number(elements.rhythmGapMax.value);
  if (!Number.isFinite(gapMin)) gapMin = 20;
  if (!Number.isFinite(gapMax)) gapMax = 45;
  const config = {
    idlePool: state.selectedIdle,
    clickPool: state.selectedClick,
    basePool: state.basePool,
    actionEnabled: elements.rhythmActionEnabled.checked,
    actionGapMin: gapMin,
    actionGapMax: gapMax
  };

  try {
    await window.settingsAPI.setAnimationConfig(config);
    // 回显主进程清洗后的值（例如超出范围、最短大于最长）
    const saved = await window.settingsAPI.getAnimationConfig();
    elements.rhythmGapMin.value = saved.actionGapMin;
    elements.rhythmGapMax.value = saved.actionGapMax;
    showToast('✅ 动画配置已保存，桌宠已按新节奏播放');
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message);
  }
}

/**
 * 画面裁剪即时预览（防抖，避免拖动滑块时频繁写盘）
 */
let cropPreviewTimer = null;
function queueCropPreview(delay = 120) {
  if (cropPreviewTimer) clearTimeout(cropPreviewTimer);
  cropPreviewTimer = setTimeout(async () => {
    cropPreviewTimer = null;
    try {
      await window.settingsAPI.setPetConfig(readCropConfig());
    } catch (e) {
      console.error('裁剪预览失败:', e);
    }
  }, delay);
}

/** 读取窗口裁剪表单值 */
function readCropConfig() {
  const crop = Math.min(1, Math.max(0.25, parseFloat(elements.crop.value) || 0.55));
  const offsetX = Math.min(40, Math.max(-40, parseFloat(elements.cropX.value) || 0));
  const offsetY = Math.min(40, Math.max(-40, parseFloat(elements.cropY.value) || 0));
  return { crop, cropOffsetX: offsetX, cropOffsetY: offsetY };
}

/**
 * 气泡大小 / 位置即时预览（防抖）
 */
let bubblePreviewTimer = null;
function queueBubblePreview(delay = 120) {
  if (bubblePreviewTimer) clearTimeout(bubblePreviewTimer);
  bubblePreviewTimer = setTimeout(async () => {
    bubblePreviewTimer = null;
    try {
      await window.settingsAPI.setBubbleConfig(readBubbleConfig());
    } catch (e) {
      console.error('气泡预览失败:', e);
    }
  }, delay);
}

/** 读取气泡表单值 */
function readBubbleConfig() {
  const scale = Math.min(1.6, Math.max(0.6, parseFloat(elements.bubbleScale.value) || 1));
  const offsetX = Math.min(200, Math.max(-200, parseFloat(elements.bubbleOffsetX.value) || 0));
  const offsetY = Math.min(200, Math.max(-120, parseFloat(elements.bubbleOffsetY.value) || 0));
  return { scale, offsetX, offsetY };
}

/**
 * 读取「双击自定义语句」输入框（每行一句，忽略空行）
 * @returns {string[]}
 */
function readCustomPhrases() {
  return String(elements.balancePhrases.value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 根据模型状态气泡开关更新自定义语句的提示与样式 */
function updatePhraseHint() {
  const enabled = elements.balanceEnabled.checked;
  elements.balancePhrases.classList.toggle('inactive', enabled);
  elements.balancePhrasesHint.textContent = enabled
    ? '当前启用了状态气泡：双击桌宠展示模型状态，这些语句暂不生效'
    : '未启用状态气泡：双击桌宠会从这里随机展示一句；留空则使用内置问候语';
}

/** 预览一句自定义语句（随机挑一句，未保存也能看效果） */
function previewPhrase() {
  const phrases = readCustomPhrases();
  if (phrases.length === 0) {
    showToast('先写一句自定义语句再预览吧');
    return;
  }
  const text = phrases[Math.floor(Math.random() * phrases.length)];
  window.settingsAPI.previewPhrase(text).then((result) => {
    if (result && result.success === false) {
      showToast(result.reason === 'pet-hidden' ? '桌宠已隐藏，先显示桌宠再预览' : '预览失败，请稍后再试');
    }
  }).catch(() => { /* 预览失败不影响保存 */ });
}

/**
 * 保存宠物设置 + 状态气泡设置
 */
async function savePetConfig() {
  const config = {
    opacity: parseFloat(elements.petOpacity.value),
    scale: parseFloat(elements.petScale.value),
    autoStart: elements.petAutoStart.checked,
    ...readCropConfig()
  };

  const rawInterval = Number(elements.balanceInterval.value);
  const intervalMinutes = Number.isFinite(rawInterval) ? Math.min(1440, Math.max(0, Math.round(rawInterval))) : 30;
  const balanceConfig = {
    enabled: elements.balanceEnabled.checked,
    intervalMinutes,
    customPhrases: readCustomPhrases()
  };

  try {
    await window.settingsAPI.setPetConfig(config);
    await window.settingsAPI.setBalanceConfig(balanceConfig);
    await window.settingsAPI.setBubbleConfig(readBubbleConfig());
    elements.balanceInterval.value = intervalMinutes;
    updatePhraseHint();
    showToast('✅ 宠物设置已保存');
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message);
  }
}

/**
 * 显示 Toast 提示
 */
function showToast(message) {
  // 移除已有的 toast
  const existing = document.querySelector('.settings-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'settings-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 20px;
    background: rgba(30, 30, 50, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e0e0e0;
    font-size: 13px;
    z-index: 1000;
    animation: toastIn 0.3s ease-out;
    backdrop-filter: blur(10px);
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/** HTML 属性转义（转义引号，避免拼进属性时逃逸） */
function escapeAttr(text) {
  return escapeHtml(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// 插件设置面板（contributes.settings）
// 插件通过在 plugin.json 里声明字段，由这里渲染成通用表单；
// 没有任何插件时，以下逻辑完全不执行，设置页与原来完全一致
// ============================================================================

const PLUGIN_FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'textarea', 'select'];

/** 字段 id：只包含安全字符，可直接用于 getElementById */
function pluginFieldId(pluginId, key) {
  return `plugin-${pluginId}-${key}`;
}

/** 拉取所有插件的设置面板并插入到标签栏 */
async function renderPluginSections() {
  if (typeof window.settingsAPI.getPluginSettingsSections !== 'function') return;

  let sections = [];
  try {
    sections = await window.settingsAPI.getPluginSettingsSections();
  } catch (e) {
    console.warn('插件设置加载失败（不影响本体）:', e.message);
    return;
  }
  if (!Array.isArray(sections) || sections.length === 0) return;

  const nav = document.getElementById('tab-nav');
  const content = document.getElementById('tab-content');
  if (!nav || !content) return;

  for (const section of sections) {
    if (!section || !section.pluginId) continue;
    const tabName = `plugin-${section.pluginId}`;

    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = tabName;
    btn.textContent = `${section.icon || '🧩'} ${section.title || section.pluginId}`;
    nav.appendChild(btn);

    const panel = document.createElement('section');
    panel.className = 'tab-panel';
    panel.id = `tab-${tabName}`;
    panel.innerHTML = buildPluginPanelHtml(section);
    content.appendChild(panel);

    try {
      await bindPluginPanel(section, panel);
    } catch (e) {
      console.warn(`插件设置面板初始化失败 [${section.pluginId}]:`, e.message);
    }
  }

  console.log(`🧩 已加载 ${sections.length} 个插件设置面板`);
}

/** 生成插件设置面板的 HTML */
function buildPluginPanelHtml(section) {
  const fields = (Array.isArray(section.fields) ? section.fields : [])
    .filter((field) => field && typeof field.key === 'string' && PLUGIN_FIELD_TYPES.includes(field.type))
    .map((field) => {
      const id = pluginFieldId(section.pluginId, field.key);
      const attrs = `id="${escapeAttr(id)}" data-field-key="${escapeAttr(field.key)}" data-field-type="${escapeAttr(field.type)}"`;
      const hint = field.hint ? `<span class="form-hint">${escapeHtml(field.hint)}</span>` : '';
      const placeholder = field.placeholder ? ` placeholder="${escapeAttr(field.placeholder)}"` : '';

      if (field.type === 'boolean') {
        return `<div class="form-group">
          <label class="switch-label">
            <span>${escapeHtml(field.label)}</span>
            <label class="switch">
              <input type="checkbox" ${attrs}>
              <span class="switch-slider"></span>
            </label>
          </label>
          ${hint}
        </div>`;
      }

      let control;
      switch (field.type) {
        case 'textarea':
          control = `<textarea ${attrs} rows="${Number.isFinite(Number(field.rows)) ? Number(field.rows) : 3}"${placeholder}></textarea>`;
          break;
        case 'select': {
          const options = (Array.isArray(field.options) ? field.options : [])
            .map((opt) => `<option value="${escapeAttr(opt.value)}">${escapeHtml(opt.label)}</option>`)
            .join('');
          control = `<select ${attrs}>${options}</select>`;
          break;
        }
        case 'number': {
          const min = Number.isFinite(Number(field.min)) ? ` min="${Number(field.min)}"` : '';
          const max = Number.isFinite(Number(field.max)) ? ` max="${Number(field.max)}"` : '';
          const step = Number.isFinite(Number(field.step)) ? ` step="${Number(field.step)}"` : '';
          control = `<input type="number" ${attrs}${min}${max}${step}${placeholder}>`;
          break;
        }
        case 'password':
          control = `<input type="password" ${attrs}${placeholder}>`;
          break;
        default:
          control = `<input type="text" ${attrs}${placeholder}>`;
      }

      return `<div class="form-group">
        <label for="${escapeAttr(id)}">${escapeHtml(field.label)}</label>
        ${control}
        ${hint}
      </div>`;
    })
    .join('');

  const actions = (Array.isArray(section.actions) ? section.actions : [])
    .map((action) => `<button class="btn ${action.style === 'primary' ? 'btn-primary' : 'btn-secondary'}" data-plugin-action="${escapeAttr(action.id)}">${escapeHtml(action.label)}</button>`)
    .join('');

  return `<div class="setting-group" data-plugin-id="${escapeAttr(section.pluginId)}">
    <h3>${escapeHtml(section.title || section.pluginId)}</h3>
    <p class="setting-desc">${escapeHtml(section.description || '')}</p>
    ${fields}
    <div class="form-actions">
      <button class="btn btn-primary" data-plugin-save="1">💾 保存</button>
      ${actions}
    </div>
    <div class="test-result hidden" data-plugin-result="1"></div>
  </div>`;
}

/** 填充已保存的值并绑定按钮 */
async function bindPluginPanel(section, panel) {
  let values = {};
  try {
    values = (await window.settingsAPI.getPluginSettings(section.pluginId)) || {};
  } catch (e) {
    console.warn(`读取插件设置失败 [${section.pluginId}]:`, e.message);
  }

  for (const field of section.fields || []) {
    const input = panel.querySelector(`[data-field-key="${field.key}"]`);
    if (!input) continue;
    if (field.type === 'boolean') {
      input.checked = values[field.key] === true;
    } else {
      const value = values[field.key];
      input.value = value === undefined || value === null ? '' : String(value);
    }
  }

  panel.querySelector('[data-plugin-save]')?.addEventListener('click', () => savePluginSettings(section, panel));
  panel.querySelectorAll('[data-plugin-action]').forEach((btn) => {
    btn.addEventListener('click', () => runPluginAction(section, panel, btn.dataset.pluginAction));
  });
}

/** 读取面板上的表单值 */
function collectPluginValues(section, panel) {
  const values = {};
  for (const field of section.fields || []) {
    const input = panel.querySelector(`[data-field-key="${field.key}"]`);
    if (!input) continue;
    if (field.type === 'boolean') {
      values[field.key] = input.checked;
    } else if (field.type === 'number') {
      const num = Number(input.value);
      if (Number.isFinite(num)) values[field.key] = num;
    } else {
      values[field.key] = input.value;
    }
  }
  return values;
}

async function savePluginSettings(section, panel) {
  try {
    const result = await window.settingsAPI.setPluginSettings(section.pluginId, collectPluginValues(section, panel));
    if (result && result.success) {
      showToast('✅ 插件设置已保存');
      showPluginResult(panel, true, '✅ 已保存');
    } else {
      showPluginResult(panel, false, `❌ 保存失败：${(result && result.error) || '未知错误'}`);
    }
  } catch (e) {
    showPluginResult(panel, false, `❌ 保存失败：${e.message}`);
  }
}

async function runPluginAction(section, panel, actionId) {
  showPluginResult(panel, true, '⏳ 执行中...');
  try {
    const result = await window.settingsAPI.runPluginSettingsAction(
      section.pluginId,
      actionId,
      collectPluginValues(section, panel)
    );
    const ok = !!(result && result.success);
    showPluginResult(panel, ok, (result && (result.message || result.error)) || (ok ? '✅ 完成' : '❌ 执行失败'));
  } catch (e) {
    showPluginResult(panel, false, `❌ 执行失败：${e.message}`);
  }
}

function showPluginResult(panel, ok, text) {
  const el = panel.querySelector('[data-plugin-result]');
  if (!el) return;
  el.className = `test-result ${ok ? 'success' : 'error'}`;
  el.textContent = text;
}

// 添加 toast 动画样式
const style = document.createElement('style');
style.textContent = `
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(-50%) translateY(10px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
`;
document.head.appendChild(style);

// ====== 应用启动 ======
document.addEventListener('DOMContentLoaded', init);