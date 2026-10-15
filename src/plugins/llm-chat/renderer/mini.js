/**
 * 桌面小对话窗逻辑
 * 与完整对话窗口共用会话（当前活跃会话），只展示最近几条消息；
 * 落库、请求、桌宠联动都由插件主进程负责，这里只渲染与转发。
 */

/** 打开时展示的最近消息条数 */
const RECENT_COUNT = 4;

const state = {
  convId: null,
  messages: [],
  config: null,
  requestId: null,
  text: '',
  reasoning: '',
  streaming: false
};

const el = {
  card: document.getElementById('card'),
  model: document.getElementById('model'),
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  btnSend: document.getElementById('btn-send'),
  btnNew: document.getElementById('btn-new'),
  btnExpand: document.getElementById('btn-expand'),
  btnClose: document.getElementById('btn-close')
};

async function init() {
  setupListeners();
  await loadConfig();
  await loadConversation();
  // 按内容高度调整窗口
  new ResizeObserver(reportSize).observe(el.card);
  reportSize();
  el.input.focus();
}

async function loadConfig() {
  try { state.config = await window.chatAPI.getConfig(); } catch (e) { state.config = null; }
  const cfg = state.config || {};
  el.model.textContent = cfg.model || '默认模型';
}

/** 读取当前活跃会话的最近几条消息（与完整对话窗口同一个会话） */
async function loadConversation() {
  if (state.streaming) return;
  try {
    const active = await window.chatAPI.getActiveConversation();
    state.convId = active ? active.id : null;
    state.messages = active && Array.isArray(active.messages) ? active.messages.slice(-RECENT_COUNT) : [];
  } catch (e) {
    state.messages = [];
  }
  render();
}

function setupListeners() {
  el.btnSend.addEventListener('click', send);
  el.btnClose.addEventListener('click', () => window.chatAPI.closeMini());
  el.btnExpand.addEventListener('click', () => window.chatAPI.expandMini());
  el.btnNew.addEventListener('click', newTopic);

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el.input.addEventListener('input', autoResize);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.chatAPI.closeMini();
  });

  window.chatAPI.onMiniFocus(() => {
    el.input.focus();
    loadConfig();
    loadConversation();
  });

  window.chatAPI.onStreamChunk((data) => {
    if (!data || data.requestId !== state.requestId) return;
    if (data.kind === 'reasoning') state.reasoning += data.chunk || '';
    else state.text += data.chunk || '';
    render();
  });

  window.chatAPI.onStreamDone((data) => {
    if (!data || data.requestId !== state.requestId) return;
    const saved = data.message;
    const content = (saved && saved.content) || state.text;
    const reasoning = (saved && saved.reasoning) || state.reasoning;
    if (content || reasoning) state.messages.push({ role: 'assistant', content, reasoning });
    else if (data.canceled) state.messages.push({ role: 'notice', content: '已停止生成' });
    finishStream();
  });

  window.chatAPI.onStreamError((data) => {
    if (!data || data.requestId !== state.requestId) return;
    state.messages.push({ role: 'error', content: `⚠️ ${data.error || '未知错误'}` });
    finishStream();
  });

  window.chatAPI.onConversationUpdated((data) => {
    if (data && data.conversationId && !state.convId) state.convId = data.conversationId;
  });

  window.chatAPI.onConfigChanged((config) => {
    state.config = config;
    el.model.textContent = (config && config.model) || '默认模型';
  });
}

async function newTopic() {
  if (state.streaming) return;
  try {
    const { conversation } = await window.chatAPI.createConversation('新对话');
    state.convId = conversation ? conversation.id : null;
    state.messages = [];
    render();
    el.input.focus();
  } catch (e) {
    console.error('新建话题失败:', e);
  }
}

function send() {
  if (state.streaming) {
    if (state.requestId) window.chatAPI.cancelStream(state.requestId);
    return;
  }
  const content = el.input.value.trim();
  if (!content) return;
  el.input.value = '';
  autoResize();

  state.requestId = `mini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  state.text = '';
  state.reasoning = '';
  state.streaming = true;
  state.messages.push({ role: 'user', content });
  setSending(true);
  render();
  // 没有会话时由主进程新建，并通过 conversation-updated 回传 id
  window.chatAPI.sendMessage({ conversationId: state.convId || '', content, requestId: state.requestId });
}

function finishStream() {
  state.streaming = false;
  state.requestId = null;
  state.text = '';
  state.reasoning = '';
  setSending(false);
  render();
  el.input.focus();
}

function setSending(sending) {
  el.btnSend.classList.toggle('stop', sending);
  el.btnSend.textContent = sending ? '■' : '➤';
  el.btnSend.title = sending ? '停止生成' : '发送';
}

function showThinking() {
  return !state.config || state.config.showThinking !== false;
}

function thinkingBlock(text, open) {
  if (!text || !showThinking()) return '';
  return `<details class="thinking"${open ? ' open' : ''}><summary>💭 思考过程</summary>` +
    `<div class="thinking-body">${escapeHtml(text)}</div></details>`;
}

function render() {
  const parts = state.messages.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${escapeHtml(m.content)}</div>`;
    if (m.role === 'error') return `<div class="msg error">${escapeHtml(m.content)}</div>`;
    if (m.role === 'notice') return `<div class="msg notice">${escapeHtml(m.content)}</div>`;
    return `<div class="msg assistant">${thinkingBlock(m.reasoning, false)}${renderMarkdown(m.content)}</div>`;
  });
  if (state.streaming) {
    const body = state.text
      ? renderMarkdown(state.text)
      : `<span class="typing">${state.reasoning ? '思考中…' : '正在想…'}</span>`;
    parts.push(`<div class="msg assistant">${thinkingBlock(state.reasoning, !state.text)}${body}</div>`);
  }
  el.messages.innerHTML = parts.join('');
  el.messages.scrollTop = el.messages.scrollHeight;
}

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 96)}px`;
  // 超过最大高度才出现滚动条
  el.input.style.overflowY = el.input.scrollHeight > 96 ? 'auto' : 'hidden';
}

function reportSize() {
  const style = getComputedStyle(document.body);
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  window.chatAPI.resizeMini(Math.ceil(el.card.getBoundingClientRect().height + pad));
}

document.addEventListener('DOMContentLoaded', init);
