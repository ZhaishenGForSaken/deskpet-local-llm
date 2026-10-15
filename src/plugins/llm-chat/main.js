/**
 * AI 对话插件（主进程入口）
 * ============================================================================
 * 通过宿主 ctx 获得全部能力（IPC / 存储 / 窗口 / 设置），
 * 不直接依赖本体的任何模块，删除本目录即可完全下线该功能。
 *
 * 面向本地部署的大模型（Ollama / LM Studio / llama.cpp / vLLM 等）：
 *   - 未指定模型时自动使用服务端的第一个可对话模型
 *   - 对话窗口内可直接切换模型
 *   - 推理模型的思考过程单独保存、可折叠展示
 *   - 桌宠闲聊：让模型生成一句话，用桌宠的气泡说出来
 */

const { requestChat, testConnection, listModels, resolveChatEndpoint } = require('./chat-client');
const { createConversationStore } = require('./conversations');
const { createChatWindow, getChatWindow } = require('./chat-window');
const { createMiniWindow, resizeMini, closeMini, isMiniVisible } = require('./mini-window');

/** 默认系统提示词 */
const DEFAULT_SYSTEM_PROMPT =
  '你是住在用户电脑桌面上的宠物助手，名字叫「小肥鱼」。回答简洁、友好、有条理；能用列表就用列表。';

/** 桌宠闲聊默认提示词 */
const DEFAULT_CHATTER_PROMPT =
  '你是住在用户电脑桌面上的小宠物。请用一句不超过 30 个字的中文，对主人说一句俏皮、温暖的话（可以提醒喝水、休息、夸夸主人等），只输出这句话本身。';

/** 闲聊气泡最长字数 */
const CHATTER_MAX_LENGTH = 80;

/** 对话各阶段桌宠播放的动画（找不到的动画会被桌宠忽略） */
const PET_ACTIVITY = {
  waiting: { id: 'chat-waiting', loop: ['工作状态-思考冒泡'], priority: 10 },
  reasoning: { id: 'chat-reasoning', loop: ['深度思考碎碎念'], priority: 10 },
  typing: { id: 'chat-typing', loop: ['工作状态-忙碌点按', '写代码'], priority: 10 },
  done: { id: 'chat-done', once: '工作状态-雀跃庆祝', priority: 10 },
  error: { id: 'chat-error', once: '工作状态-垂头叹气冒汗', priority: 10 }
};

/** 回复同步到桌宠气泡时最多展示的字数 */
const REPLY_PREVIEW_LENGTH = 60;

/** requestId -> { cancel } */
const pending = new Map();

/** 闲聊定时器与进行中的标记 */
let chatterTimer = null;
let chatterBusy = false;

// ============================================================================
// 配置解析
// ============================================================================

/** 读取本体共享配置（只读，作为缺省回退；拿不到就返回空对象） */
function sharedConfig(ctx) {
  try {
    const shared = ctx.host && typeof ctx.host.getSharedLLMConfig === 'function' ? ctx.host.getSharedLLMConfig() : null;
    return shared && typeof shared === 'object' ? shared : {};
  } catch (e) {
    return {};
  }
}

/**
 * 合并插件自身设置与本体共享配置，得到一次请求所需的完整配置
 * @param {Object} ctx 插件上下文
 * @param {Object} [override] 覆盖值（设置页未保存的表单值）
 */
function buildConfig(ctx, override) {
  const stored = ctx.settings.get() || {};
  const shared = sharedConfig(ctx);
  const merged = { ...stored, ...(override && typeof override === 'object' ? override : {}) };

  const apiEndpoint = String(merged.apiEndpoint || shared.apiEndpoint || '').trim();
  const apiKey = String(merged.apiKey || shared.apiKey || '').trim();
  const model = String(merged.model || shared.model || '').trim();
  const systemPrompt = String(merged.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;

  return {
    apiEndpoint,
    apiKey,
    model,
    providerName: String(shared.providerName || '本地模型'),
    maxTokens: merged.maxTokens,
    temperature: merged.temperature,
    stream: merged.stream !== false,
    showThinking: merged.showThinking !== false,
    petReact: merged.petReact !== false,
    syncReply: merged.syncReply !== false,
    systemPrompt,
    chatterUseScene: merged.chatterUseScene !== false,
    chatterMinutes: Number(merged.chatterMinutes) || 0,
    chatterPrompt: String(merged.chatterPrompt || '').trim() || DEFAULT_CHATTER_PROMPT
  };
}

/**
 * 没有指定模型时，自动使用服务端的第一个可对话模型
 * @returns {Promise<Object>} 补全了 model 的配置
 */
async function withModel(config) {
  if (config.model) return config;
  const models = await listModels(config);
  const model = models.find((m) => !/embed/i.test(m)) || models[0] || '';
  if (!model) throw new Error('本地模型服务上还没有可用模型，请先下载（如 ollama pull qwen2.5:7b）');
  return { ...config, model };
}

/** 让桌宠进入对话的某个阶段（关闭「桌宠跟随对话」时只负责收尾，不再触发新动画） */
function petActivity(ctx, stage, config) {
  const fn = ctx.host && ctx.host.setPetActivity;
  if (typeof fn !== 'function') return;
  if (!stage) { fn(null); return; }
  if (config && config.petReact === false) return;
  fn(PET_ACTIVITY[stage] || null);
}

/** 把回复整理成气泡里的一两句话（去掉代码块与 Markdown 记号） */
function replyPreview(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[#>*`_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > REPLY_PREVIEW_LENGTH ? `${plain.slice(0, REPLY_PREVIEW_LENGTH)}…` : plain;
}

/** 对话窗口与小对话窗都不在眼前时，把回复同步成桌宠气泡，点一下打开对话窗口 */
function syncReplyToPet(ctx, config, content) {
  if (!config.syncReply) return;
  const win = getChatWindow();
  const inFront = (win && win.isVisible() && !win.isMinimized() && win.isFocused()) || isMiniVisible();
  if (inFront) return;
  const preview = replyPreview(content);
  const fn = ctx.host && ctx.host.showPetBubble;
  if (!preview || typeof fn !== 'function') return;
  fn({
    text: `💬 ${preview}\n（点我查看完整回复）`,
    duration: Math.min(15000, 5000 + preview.length * 120),
    onClick: () => createChatWindow(ctx)
  });
}

/** 暴露给渲染进程的配置（不含 API Key 明文） */
function publicConfig(ctx) {
  const stored = ctx.settings.get() || {};
  const shared = sharedConfig(ctx);
  const cfg = buildConfig(ctx);

  let endpoint = cfg.apiEndpoint;
  try {
    endpoint = resolveChatEndpoint(cfg.apiEndpoint);
  } catch (e) { /* 地址非法时原样展示，便于用户排查 */ }

  const modelFrom = String(stored.model || '').trim()
    ? 'plugin'
    : (String(shared.model || '').trim() ? 'host' : 'auto');

  return {
    model: cfg.model,
    modelFrom,
    providerName: cfg.providerName,
    endpoint,
    stream: cfg.stream,
    showThinking: cfg.showThinking,
    hasApiKey: !!cfg.apiKey
  };
}

/** 会话摘要（不含消息体，用于侧边栏） */
function summaryOf(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0
  };
}

function windowOf(ctx, event) {
  const BW = ctx.host && ctx.host.BrowserWindow;
  try {
    return BW && typeof BW.fromWebContents === 'function' ? BW.fromWebContents(event.sender) : null;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// 激活 / 卸载
// ============================================================================

let conversations = null;

module.exports = {
  activate(ctx) {
    conversations = createConversationStore(ctx.createStore('data', {
      conversations: [],
      activeConversationId: null
    }));

    // ---------- 菜单命令（来自桌宠右键菜单 / 托盘菜单） ----------
    ctx.onCommand((command) => {
      if (command === 'open-chat') {
        createChatWindow(ctx);
        return;
      }
      if (command === 'pet-talk') {
        return petTalk(ctx, { manual: true });
      }
      if (command === 'mini-chat') {
        createMiniWindow(ctx);
        return;
      }
      ctx.warn(`未知命令: ${command}`);
    });

    // ---------- 渲染进程：读取配置 ----------
    ctx.ipc.handle('get-config', () => publicConfig(ctx));

    // ---------- 渲染进程：模型列表 / 切换模型 ----------
    ctx.ipc.handle('list-models', async () => {
      const config = buildConfig(ctx);
      try {
        const models = await listModels(config);
        return { success: true, models, current: config.model };
      } catch (e) {
        return { success: false, error: e.message, models: [], current: config.model };
      }
    });

    ctx.ipc.handle('set-model', (event, model) => {
      ctx.settings.set({ ...(ctx.settings.get() || {}), model: String(model || '').trim() });
      const config = publicConfig(ctx);
      ctx.ipc.send('config-changed', config);
      return config;
    });

    // ---------- 渲染进程：会话管理 ----------
    ctx.ipc.handle('list-conversations', () => conversations.list());

    ctx.ipc.handle('get-active-conversation', () => {
      const active = conversations.getActive();
      if (active) return active;
      const first = conversations.list()[0];
      return first ? conversations.get(first.id) : null;
    });

    ctx.ipc.handle('create-conversation', (event, title) => {
      const conversation = conversations.create(typeof title === 'string' ? title : '新对话');
      return { conversation, list: conversations.list() };
    });

    ctx.ipc.handle('delete-conversation', (event, id) => {
      const list = conversations.remove(String(id || ''));
      const active = conversations.getActive() || (list.length ? conversations.get(list[0].id) : null);
      return { list, conversation: active };
    });

    ctx.ipc.handle('rename-conversation', (event, payload) => {
      const id = String((payload && payload.id) || '');
      const title = String((payload && payload.title) || '');
      conversations.rename(id, title);
      return { list: conversations.list() };
    });

    ctx.ipc.handle('set-active-conversation', (event, id) => {
      conversations.setActive(id ? String(id) : null);
      return conversations.getActive();
    });

    ctx.ipc.handle('clear-conversation', (event, id) => {
      const conversation = conversations.clearMessages(String(id || ''));
      return { conversation, list: conversations.list() };
    });

    // ---------- 渲染进程：发送消息（单向 + 事件回推） ----------
    ctx.ipc.on('send-message', (event, payload) => {
      handleSendMessage(ctx, payload).catch((e) => {
        ctx.warn('send-message 处理异常:', e.message);
        const requestId = String((payload && payload.requestId) || '');
        if (requestId) ctx.ipc.send('stream-error', { requestId, error: e.message });
      });
    });

    ctx.ipc.on('cancel-stream', (event, payload) => {
      const requestId = String((payload && payload.requestId) || '');
      const handle = pending.get(requestId);
      if (handle) handle.cancel();
    });

    // ---------- 渲染进程：窗口控制 ----------
    ctx.ipc.handle('minimize-window', (event) => {
      const win = windowOf(ctx, event);
      if (win) win.minimize();
      return { success: !!win };
    });

    ctx.ipc.handle('close-window', (event) => {
      const win = windowOf(ctx, event);
      if (win) win.close();
      return { success: !!win };
    });

    // ---------- 桌面小对话窗 ----------
    ctx.ipc.on('mini-resize', (event, height) => resizeMini(ctx, height));
    ctx.ipc.handle('mini-close', () => { closeMini(); return { success: true }; });
    // 展开：打开完整对话窗口（同一个活跃会话），并收起小窗
    ctx.ipc.handle('mini-expand', () => {
      createChatWindow(ctx);
      closeMini();
      return { success: true };
    });

    // ---------- 渲染进程：打开本体设置页 ----------
    ctx.ipc.handle('open-host-settings', () => {
      try {
        if (ctx.host && typeof ctx.host.openSettings === 'function') {
          ctx.host.openSettings();
          return { success: true };
        }
      } catch (e) { /* 忽略 */ }
      return { success: false, error: '当前宿主不支持打开设置页' };
    });

    // ---------- 设置页动作：获取模型列表 / 测试连接 / 让桌宠说句话 ----------
    ctx.onSettingsAction(async (actionId, values) => {
      const config = buildConfig(ctx, values);
      if (actionId === 'models') {
        try {
          const models = await listModels(config);
          if (!models.length) return { success: true, message: '服务在线，但还没有任何模型（Ollama 可执行 ollama pull qwen2.5:7b）' };
          return { success: true, message: `📋 共 ${models.length} 个模型：${models.join('、')}` };
        } catch (e) {
          return { success: false, error: `❌ 获取失败：${e.message}` };
        }
      }
      if (actionId === 'test') {
        try {
          const resolved = await withModel(config);
          const reply = await testConnection(resolved);
          return { success: true, message: `✅ 连接成功（${resolved.model}），模型回复：${reply || '(空回复)'}` };
        } catch (e) {
          return { success: false, error: `❌ 连接失败：${e.message}` };
        }
      }
      if (actionId === 'talk') {
        const result = await petTalk(ctx, { manual: true, override: values });
        return result.success
          ? { success: true, message: `🗨️ ${result.text}` }
          : { success: false, error: `❌ ${result.error}` };
      }
      return { success: false, error: `未实现的动作: ${actionId}` };
    });

    // ---------- 设置变更：同步给已打开的对话窗口，并重设闲聊定时器 ----------
    ctx.onSettingsChanged(() => {
      ctx.ipc.send('config-changed', publicConfig(ctx));
      startChatterTimer(ctx);
    });

    startChatterTimer(ctx);

    // ---------- 行为感知（另一个插件）发来的久坐提醒：用本地模型说一句 ----------
    if (ctx.bus) {
      ctx.bus.subscribe('activity.milestone', (data) => {
        handleMilestone(ctx, data).catch(() => { /* 已在内部兜底 */ });
      });
    }

    // ---------- 卸载清理 ----------
    ctx.onDeactivate(() => {
      cancelAllPending();
      stopChatterTimer();
    });

    ctx.log('已就绪（对话窗口按需创建）');
  },

  deactivate() {
    cancelAllPending();
    stopChatterTimer();
  }
};

/** 取消所有进行中的请求 */
function cancelAllPending() {
  for (const handle of pending.values()) {
    try { handle.cancel(); } catch (e) { /* 忽略 */ }
  }
  pending.clear();
}

/**
 * 处理一次发送消息：落库 -> 组装上下文 -> 请求 -> 事件回推
 */
async function handleSendMessage(ctx, payload) {
  const requestId = String((payload && payload.requestId) || '');
  const content = String((payload && payload.content) || '').trim();
  const requestedId = String((payload && payload.conversationId) || '');

  if (!requestId) throw new Error('缺少 requestId');
  if (!content) {
    ctx.ipc.send('stream-error', { requestId, error: '消息内容为空' });
    return;
  }

  let conversation = requestedId ? conversations.get(requestedId) : null;
  if (!conversation) conversation = conversations.create('新对话');
  conversations.setActive(conversation.id);

  // 保存用户消息
  const saved = conversations.addMessage(conversation.id, { role: 'user', content });
  ctx.ipc.send('conversation-updated', {
    conversationId: conversation.id,
    conversation: summaryOf(saved.conversation)
  });

  let config;
  try {
    config = await withModel(buildConfig(ctx));
  } catch (e) {
    ctx.ipc.send('stream-error', { requestId, conversationId: conversation.id, error: e.message });
    return;
  }

  // 组装请求上下文：系统提示词 + 该会话全部历史（思考过程不回传给模型）
  const history = conversations.get(conversation.id);
  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...((history && history.messages) || []).map((m) => ({ role: m.role, content: m.content }))
  ];

  // 桌宠跟随对话：等待 → 思考 → 输出 → 完成 / 出错
  let stage = 'waiting';
  petActivity(ctx, stage, config);
  const handle = requestChat(config, messages, {
    stream: config.stream,
    onChunk: (chunk, kind) => {
      ctx.ipc.send('stream-chunk', { requestId, chunk, kind });
      const next = kind === 'reasoning' ? 'reasoning' : 'typing';
      if (next !== stage) { stage = next; petActivity(ctx, stage, config); }
    }
  });
  pending.set(requestId, handle);

  try {
    const full = await handle.promise;
    petActivity(ctx, 'done', config);
    syncReplyToPet(ctx, config, full.content);
    const done = conversations.addMessage(conversation.id, {
      role: 'assistant',
      content: full.content.trim(),
      reasoning: full.reasoning.trim(),
      model: config.model
    });
    ctx.ipc.send('stream-done', {
      requestId,
      conversationId: conversation.id,
      message: done.message,
      conversation: summaryOf(done.conversation)
    });
  } catch (e) {
    if (e && e.canceled) {
      petActivity(ctx, null);
      ctx.ipc.send('stream-done', { requestId, conversationId: conversation.id, canceled: true });
    } else {
      petActivity(ctx, 'error', config);
      ctx.ipc.send('stream-error', {
        requestId,
        conversationId: conversation.id,
        error: (e && e.message) || '未知错误'
      });
    }
  } finally {
    pending.delete(requestId);
  }
}

// ============================================================================
// 桌宠闲聊：让本地模型生成一句话，用桌宠的气泡说出来
// ============================================================================

function stopChatterTimer() {
  if (chatterTimer) clearInterval(chatterTimer);
  chatterTimer = null;
}

function startChatterTimer(ctx) {
  stopChatterTimer();
  const minutes = Math.min(1440, Math.max(0, buildConfig(ctx).chatterMinutes));
  if (!(minutes > 0)) return;
  chatterTimer = setInterval(() => {
    petTalk(ctx, { manual: false }).catch(() => { /* 定时闲聊失败静默跳过 */ });
  }, minutes * 60 * 1000);
}

/** 「已持续 N 分钟」的口语化描述 */
function durationText(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/**
 * 给闲聊模型的场景描述：只用行为感知插件发布的场景名与持续时间（不含程序名 / 窗口标题）
 * 行为感知插件不存在或关闭时返回空字符串
 */
function sceneContext(ctx, config) {
  if (!config.chatterUseScene || !ctx.bus) return '';
  const scene = ctx.bus.latest('activity.scene');
  if (!scene || !scene.scene || !scene.label) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - Number(scene.since || Date.now())) / 60000));
  return `主人现在的状态：${scene.label}（已持续 ${durationText(minutes)}）。`;
}

/** 久坐提醒：让模型生成一句提醒；模型不可用或关闭了结合场景时用内置文案 */
async function handleMilestone(ctx, data) {
  const label = String((data && data.label) || '专注');
  const minutes = Number(data && data.minutes) || 0;
  const fallback = `已经「${label}」${durationText(minutes)}了，起来活动一下、喝口水吧 🧘`;
  const config = buildConfig(ctx);
  if (!config.chatterUseScene) {
    const fn = ctx.host && ctx.host.showPetBubble;
    if (typeof fn === 'function') fn({ text: fallback, duration: 7000 });
    return;
  }
  const result = await petTalk(ctx, {
    manual: false,
    instruction: `主人已经连续「${label}」${durationText(minutes)}了。请用一句不超过 30 个字的中文，俏皮又温暖地提醒主人休息一下（喝水、起身活动、看看远处等），只输出这句话本身。`
  });
  if (!result.success) {
    const fn = ctx.host && ctx.host.showPetBubble;
    if (typeof fn === 'function') fn({ text: fallback, duration: 7000 });
  }
}

/** 把模型输出整理成适合气泡展示的一句话 */
function tidyChatter(text) {
  const line = String(text || '')
    .replace(/^["'“”「」\s]+|["'“”「」\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > CHATTER_MAX_LENGTH ? `${line.slice(0, CHATTER_MAX_LENGTH)}…` : line;
}

/**
 * 让桌宠说一句话
 * @param {Object} ctx
 * @param {{ manual?: boolean, override?: Object, instruction?: string }} options
 *   manual 为 true 时失败也会用气泡提示；instruction 为这次额外的要求（例如久坐提醒）
 * @returns {Promise<{ success: boolean, text?: string, error?: string }>}
 */
async function petTalk(ctx, options = {}) {
  const show = (text, duration) => {
    const fn = ctx.host && ctx.host.showPetBubble;
    if (typeof fn === 'function') fn({ text, duration });
  };
  if (chatterBusy) return { success: false, error: '正在想上一句…' };
  chatterBusy = true;
  if (options.manual) show('🤔 让我想想…', 15000);
  try {
    const config = await withModel(buildConfig(ctx, options.override));
    petActivity(ctx, 'waiting', config);
    // 推理模型会先输出很长的思考过程，给足 token 余量
    const handle = requestChat({ ...config, maxTokens: 1024, temperature: 0.9 }, [
      { role: 'system', content: config.chatterPrompt },
      {
        role: 'user',
        content: (() => {
          const context = sceneContext(ctx, config);
          return `现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。${context}` +
            (options.instruction || (context ? '说一句吧，可以结合主人现在的状态。' : '说一句吧。'));
        })()
      }
    ], { stream: false });
    pending.set('pet-talk', handle);
    const result = await handle.promise;
    const text = tidyChatter(result.content);
    if (!text) throw new Error('模型没有返回内容');
    show(text, Math.min(12000, 3000 + text.length * 180));
    return { success: true, text };
  } catch (e) {
    const error = (e && e.message) || '未知错误';
    if (options.manual) show(`😵 ${error}`, 5000);
    return { success: false, error };
  } finally {
    petActivity(ctx, null);
    pending.delete('pet-talk');
    chatterBusy = false;
  }
}
