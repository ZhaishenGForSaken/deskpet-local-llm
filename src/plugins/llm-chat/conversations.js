/**
 * 对话数据管理（插件私有）
 * 数据存放在插件自己的存储里（<userData>/plugins/llm-chat/data.json），
 * 与本体 DeskLLMPet 的配置完全隔离
 */

/** 单个对话保存的消息上限（防止无限增长撑爆配置文件） */
const MAX_MESSAGES_PER_CONVERSATION = 500;
/** 对话数量上限（超出时丢弃最久未更新的） */
const MAX_CONVERSATIONS = 100;

function genId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 用第一条用户消息生成标题 */
function inferTitle(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

function normalizeMessage(message) {
  const role = message && ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'user';
  return {
    role,
    content: String((message && message.content) || ''),
    timestamp: Number.isFinite(Number(message && message.timestamp)) ? Number(message.timestamp) : Date.now()
  };
}

/**
 * 创建对话仓库
 * @param {Object} store 插件存储（需实现 get/set）
 */
function createConversationStore(store) {
  function readAll() {
    const list = store.get('conversations');
    return Array.isArray(list) ? list : [];
  }

  function writeAll(list) {
    store.set('conversations', list.slice(0, MAX_CONVERSATIONS));
  }

  function list() {
    return readAll()
      .map((conv) => ({
        id: conv.id,
        title: conv.title || '新对话',
        createdAt: conv.createdAt || 0,
        updatedAt: conv.updatedAt || 0,
        messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function get(id) {
    const conv = readAll().find((c) => c.id === id);
    if (!conv) return null;
    return {
      id: conv.id,
      title: conv.title || '新对话',
      createdAt: conv.createdAt || 0,
      updatedAt: conv.updatedAt || 0,
      messages: (Array.isArray(conv.messages) ? conv.messages : []).map(normalizeMessage)
    };
  }

  function create(title) {
    const now = Date.now();
    const conv = {
      id: genId(),
      title: String(title || '新对话').trim() || '新对话',
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    const all = readAll();
    all.unshift(conv);
    writeAll(all);
    store.set('activeConversationId', conv.id);
    return get(conv.id);
  }

  function remove(id) {
    const all = readAll().filter((c) => c.id !== id);
    writeAll(all);
    if (store.get('activeConversationId') === id) {
      store.set('activeConversationId', all.length ? all[0].id : null);
    }
    return list();
  }

  function rename(id, title) {
    const clean = String(title || '').trim();
    if (!clean) return null;
    const all = readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    all[idx].title = clean.slice(0, 60);
    all[idx].updatedAt = Date.now();
    writeAll(all);
    return get(id);
  }

  function getActiveId() {
    return store.get('activeConversationId') || null;
  }

  function setActive(id) {
    store.set('activeConversationId', id || null);
    return getActiveId();
  }

  function getActive() {
    const id = getActiveId();
    return id ? get(id) : null;
  }

  /**
   * 追加一条消息
   * @returns {{ conversation: Object|null, message: Object|null }}
   */
  function addMessage(id, message) {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) return { conversation: null, message: null };

    const normalized = normalizeMessage(message);
    const messages = Array.isArray(all[idx].messages) ? all[idx].messages : [];
    messages.push(normalized);
    if (messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      messages.splice(0, messages.length - MAX_MESSAGES_PER_CONVERSATION);
    }
    all[idx].messages = messages;
    all[idx].updatedAt = normalized.timestamp;
    if ((!all[idx].title || all[idx].title === '新对话') && normalized.role === 'user') {
      all[idx].title = inferTitle(normalized.content);
    }

    const [updated] = all.splice(idx, 1);
    all.unshift(updated);
    writeAll(all);
    return { conversation: get(id), message: normalized };
  }

  function clearMessages(id) {
    const all = readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    all[idx].messages = [];
    all[idx].updatedAt = Date.now();
    writeAll(all);
    return get(id);
  }

  return { list, get, create, remove, rename, getActiveId, setActive, getActive, addMessage, clearMessages };
}

module.exports = { createConversationStore, inferTitle, MAX_MESSAGES_PER_CONVERSATION, MAX_CONVERSATIONS };
