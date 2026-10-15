/**
 * AI 对话插件（主进程入口）
 * ============================================================================
 * 通过宿主 ctx 获得全部能力（IPC / 存储 / 窗口 / 设置），
 * 不直接依赖本体的任何模块，删除本目录即可完全下线该功能。
 */

const { requestChat, testConnection, resolveChatEndpoint } = require('./chat-client');
const { createConversationStore } = require('./conversations');
const { createChatWindow } = require('./chat-window');

/** 默认系统提示词 */
const DEFAULT_SYSTEM_PROMPT =
  '你是 DeskLLMPet 的桌面宠物助手，名字叫「大肥鱼」。回答简洁、友好、有条理；能用列表就用列表。';

/** requestId -> { cancel } */
const pending = new Map();

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
  const model = String(merged.model || 'deepseek-chat').trim() || 'deepseek-chat';
  const systemPrompt = String(merged.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;

  return {
    apiEndpoint,
    apiKey,
    model,
    maxTokens: merged.maxTokens,
    temperature: merged.temperature,
    stream: merged.stream !== false,
    systemPrompt
  };
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

  const keyFrom = String(stored.apiKey || '').trim()
    ? 'plugin'
    : (String(shared.apiKey || '').trim() ? 'host' : 'none');

  return {
    model: cfg.model,
    endpoint,
    stream: cfg.stream,
    hasApiKey: !!cfg.apiKey,
    keyFrom
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

    // ---------- 打开窗口（来自桌宠右键菜单 / 托盘菜单） ----------
    ctx.onCommand((command) => {
      if (command === 'open-chat') {
        createChatWindow(ctx);
        return;
      }
      ctx.warn(`未知命令: ${command}`);
    });

    // ---------- 渲染进程：读取配置 ----------
    ctx.ipc.handle('get-config', () => publicConfig(ctx));

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

    // ---------- 设置页动作：测试连接 ----------
    ctx.onSettingsAction(async (actionId, values) => {
      if (actionId !== 'test') return { success: false, error: `未实现的动作: ${actionId}` };
      const config = buildConfig(ctx, values);
      if (!config.apiKey) return { success: false, error: '请先填写 API Key' };
      try {
        const reply = await testConnection(config);
        return { success: true, message: `✅ 连接成功，模型回复：${reply || '(空回复)'}` };
      } catch (e) {
        return { success: false, error: `❌ 连接失败：${e.message}` };
      }
    });

    // ---------- 设置变更：同步给已打开的对话窗口 ----------
    ctx.onSettingsChanged(() => {
      ctx.ipc.send('config-changed', publicConfig(ctx));
    });

    // ---------- 卸载清理 ----------
    ctx.onDeactivate(() => cancelAllPending());

    ctx.log('已就绪（对话窗口按需创建）');
  },

  deactivate() {
    cancelAllPending();
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

  const config = buildConfig(ctx);
  if (!config.apiKey) {
    ctx.ipc.send('stream-error', {
      requestId,
      conversationId: conversation.id,
      error: '尚未配置 API Key，请在「设置 → AI 对话」中填写'
    });
    return;
  }

  // 组装请求上下文：系统提示词 + 该会话全部历史
  const history = conversations.get(conversation.id);
  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...((history && history.messages) || []).map((m) => ({ role: m.role, content: m.content }))
  ];

  const handle = requestChat(config, messages, {
    stream: config.stream,
    onChunk: (chunk) => ctx.ipc.send('stream-chunk', { requestId, chunk })
  });
  pending.set(requestId, handle);

  try {
    const full = await handle.promise;
    const done = conversations.addMessage(conversation.id, { role: 'assistant', content: full });
    ctx.ipc.send('stream-done', {
      requestId,
      conversationId: conversation.id,
      message: done.message,
      conversation: summaryOf(done.conversation)
    });
  } catch (e) {
    if (e && e.canceled) {
      ctx.ipc.send('stream-done', { requestId, conversationId: conversation.id, canceled: true });
    } else {
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
