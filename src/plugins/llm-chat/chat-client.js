/**
 * LLM 对话客户端（OpenAI 兼容 /chat/completions，面向本地部署的大模型）
 * 仅依赖 Node 内置模块，不依赖 Electron，可单独测试
 *
 * 支持：
 *   - Ollama / LM Studio / llama.cpp / vLLM 等 OpenAI 兼容服务（API Key 可选）
 *   - 流式（SSE）与非流式两种模式，中途取消（cancel）
 *   - 推理模型的思考过程：delta.reasoning_content / delta.reasoning 字段，
 *     以及正文里的 <think>...</think> 标签（DeepSeek-R1 / QwQ / Qwen3 等）
 *   - 读取服务端模型列表（GET /models）
 */

const https = require('https');
const http = require('http');

/** 默认对话接口地址（本机 Ollama 的 OpenAI 兼容接口） */
const DEFAULT_CHAT_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
/** 请求超时（毫秒）：本地大模型首次加载进显存可能很慢，给足时间 */
const REQUEST_TIMEOUT = 300000;

/** 构造「已取消」错误 */
function canceledError() {
  const err = new Error('已取消生成');
  err.canceled = true;
  return err;
}

/** 补全协议前缀（本地服务默认 http） */
function normalizeBaseUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

/**
 * 把用户填写的地址规范成 chat/completions 端点
 *   ''                                    -> http://127.0.0.1:11434/v1/chat/completions
 *   http://127.0.0.1:11434                -> http://127.0.0.1:11434/v1/chat/completions
 *   http://127.0.0.1:1234/v1              -> http://127.0.0.1:1234/v1/chat/completions
 *   127.0.0.1:8080/v1                     -> http://127.0.0.1:8080/v1/chat/completions
 *   https://api.openai.com/v1/chat/completions -> 原样使用
 * @param {string} endpoint
 * @returns {string}
 */
function resolveChatEndpoint(endpoint) {
  const raw = normalizeBaseUrl(endpoint);
  if (!raw) return DEFAULT_CHAT_ENDPOINT;

  const parsed = new URL(raw);
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    // 已经是完整端点
  } else if (!pathname) {
    pathname = '/v1/chat/completions';
  } else {
    pathname = `${pathname}/chat/completions`;
  }
  return `${parsed.origin}${pathname}`;
}

/** chat/completions 端点 -> 同前缀的 /models 端点 */
function resolveModelsEndpoint(endpoint) {
  return resolveChatEndpoint(endpoint).replace(/\/chat\/completions$/i, '/models');
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** localhost 在 Node 18 下可能解析成 ::1，而本地推理服务通常只监听 127.0.0.1 */
function requestHost(hostname) {
  return hostname === 'localhost' ? '127.0.0.1' : hostname.replace(/^\[|\]$/g, '');
}

/** 把网络错误翻译成用户能看懂的提示 */
function networkErrorMessage(error, target) {
  const where = `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`;
  if (error && error.code === 'ECONNREFUSED') {
    return `连接不到本地模型服务 ${where}，请确认 Ollama / LM Studio 等已启动`;
  }
  if (error && (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')) return `找不到主机 ${where}，请检查 API 地址`;
  return `网络请求失败: ${(error && error.message) || '未知错误'}`;
}

function authHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * 解析一行 SSE 数据
 * @returns {null | { done: boolean, content: string, reasoning: string }}
 */
function parseSseLine(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { done: true, content: '', reasoning: '' };
  try {
    const parsed = JSON.parse(data);
    if (parsed && parsed.error) {
      const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || '模型服务返回错误');
      return { done: false, content: '', reasoning: '', error: message };
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const delta = (choice && choice.delta) || {};
    return {
      done: false,
      content: String(delta.content || ''),
      reasoning: String(delta.reasoning_content || delta.reasoning || '')
    };
  } catch (e) {
    return null;
  }
}

/** SSE 增量解析器（按行切分，跨 chunk 保留残行） */
function createSseParser(onDelta, onError) {
  let buffer = '';
  const emit = (event) => {
    if (!event || event.done) return;
    if (event.error) { if (onError) onError(event.error); return; }
    if (event.content || event.reasoning) onDelta(event.content, event.reasoning);
  };
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) emit(parseSseLine(line));
    },
    flush() {
      if (!buffer) return;
      const event = parseSseLine(buffer);
      buffer = '';
      emit(event);
    }
  };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** text 的结尾是否可能是 tag 的前半截（需要等下一个 chunk 才能确定） */
function partialTagSuffix(text, tag) {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(-len))) return len;
  }
  return 0;
}

/**
 * <think>...</think> 增量分流器：把正文里的思考过程分离出来
 * 标签可能被切在两个 chunk 之间，因此会暂存可能是半个标签的尾巴
 * @param {(kind: 'content'|'reasoning', text: string) => void} emit
 */
function createThinkSplitter(emit) {
  let inThink = false;
  let pending = '';
  let sawText = false;

  const out = (kind, text) => { if (text) emit(kind, text); };

  return {
    push(text) {
      pending += text;
      while (pending) {
        if (!inThink) {
          // 只在回复开头（允许前导空白）识别 <think>，避免误伤正文里讨论标签的情况
          const lead = sawText ? -1 : pending.search(/\S/);
          if (lead >= 0 && pending.startsWith(THINK_OPEN, lead)) {
            inThink = true;
            sawText = true;
            pending = pending.slice(lead + THINK_OPEN.length);
            continue;
          }
          if (lead >= 0 && !sawText && THINK_OPEN.startsWith(pending.slice(lead))) return;
          if (lead < 0 && !sawText) return; // 只有空白，继续等
          sawText = true;
          out('content', pending);
          pending = '';
          return;
        }
        const end = pending.indexOf(THINK_CLOSE);
        if (end >= 0) {
          out('reasoning', pending.slice(0, end));
          pending = pending.slice(end + THINK_CLOSE.length).replace(/^\s+/, '');
          inThink = false;
          continue;
        }
        const keep = partialTagSuffix(pending, THINK_CLOSE);
        out('reasoning', pending.slice(0, pending.length - keep));
        pending = pending.slice(pending.length - keep);
        return;
      }
    },
    flush() {
      if (pending) out(inThink ? 'reasoning' : 'content', pending);
      pending = '';
    }
  };
}

/** 一次性分离完整文本里的 <think> 段落 */
function splitThink(text) {
  const result = { content: '', reasoning: '' };
  const splitter = createThinkSplitter((kind, part) => { result[kind] += part; });
  splitter.push(String(text || ''));
  splitter.flush();
  return result;
}

/**
 * 发起一次对话请求
 * @param {Object} config { apiKey?, apiEndpoint, model, maxTokens, temperature }
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options] { stream?: boolean, onChunk?: (text: string, kind: 'content'|'reasoning') => void }
 * @returns {{ promise: Promise<{content: string, reasoning: string}>, cancel: () => void }}
 */
function requestChat(config, messages, options = {}) {
  const stream = options.stream !== false;
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;

  let canceled = false;
  let req = null;
  let settled = false;

  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    fn(value);
  };

  const promise = new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(resolveChatEndpoint(config && config.apiEndpoint));
    } catch (e) {
      reject(new Error(`API 地址格式无效: ${(config && config.apiEndpoint) || ''}`));
      return;
    }

    const model = String((config && config.model) || '').trim();
    if (!model) {
      reject(new Error('尚未选择模型，请在「设置 → 本地模型」中选择'));
      return;
    }

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const maxTokens = Math.round(clampNumber(config && config.maxTokens, 1, 200000, 2048));
    const temperature = clampNumber(config && config.temperature, 0, 2, 0.7);

    const body = JSON.stringify({
      model,
      messages: Array.isArray(messages) ? messages : [],
      max_tokens: maxTokens,
      temperature,
      stream: !!stream
    });

    req = transport.request({
      hostname: requestHost(target.hostname),
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(config && config.apiKey),
        Accept: stream ? 'text/event-stream' : 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: REQUEST_TIMEOUT
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (canceled) { finish(reject, canceledError()); return; }
          let message = `请求失败 (HTTP ${res.statusCode})`;
          try {
            const parsed = JSON.parse(raw);
            const detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error && parsed.error.message);
            message = detail || parsed.message || message;
          } catch (e) { /* 保留默认文案 */ }
          if (res.statusCode === 401) message = '服务需要 API Key 或 Key 无效 (401)';
          if (res.statusCode === 404 && /model/i.test(message)) message = `模型「${model}」不存在，请先下载或在设置中重新选择 (404)`;
          else if (res.statusCode === 404) message = `接口不存在 (404)，请检查 API 地址：${message}`;
          finish(reject, new Error(message));
        });
        res.on('error', (e) => finish(reject, new Error(`响应错误: ${e.message}`)));
        return;
      }

      const result = { content: '', reasoning: '' };
      const deliver = (kind, text) => {
        if (!text) return;
        result[kind] += text;
        if (onChunk) {
          try { onChunk(text, kind); } catch (e) { /* 忽略渲染回调异常 */ }
        }
      };
      const splitter = createThinkSplitter(deliver);

      if (stream) {
        let streamError = '';
        const parser = createSseParser((content, reasoning) => {
          if (reasoning) deliver('reasoning', reasoning);
          if (content) splitter.push(content);
        }, (message) => { streamError = message; });
        res.setEncoding('utf8');
        res.on('data', (chunk) => parser.push(chunk));
        res.on('end', () => {
          if (canceled) { finish(reject, canceledError()); return; }
          parser.flush();
          splitter.flush();
          if (streamError && !result.content) { finish(reject, new Error(streamError)); return; }
          finish(resolve, result);
        });
        res.on('error', (e) => {
          if (canceled) { finish(reject, canceledError()); return; }
          finish(reject, new Error(`流式响应中断: ${e.message}`));
        });
        return;
      }

      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (canceled) { finish(reject, canceledError()); return; }
        try {
          const parsed = JSON.parse(raw);
          const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
          const message = (choice && choice.message) || {};
          deliver('reasoning', String(message.reasoning_content || message.reasoning || ''));
          splitter.push(String(message.content || ''));
          splitter.flush();
          finish(resolve, result);
        } catch (e) {
          finish(reject, new Error('解析响应失败'));
        }
      });
      res.on('error', (e) => finish(reject, new Error(`响应错误: ${e.message}`)));
    });

    req.on('error', (e) => {
      if (canceled) { finish(reject, canceledError()); return; }
      finish(reject, new Error(networkErrorMessage(e, target)));
    });

    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { /* 忽略 */ }
      finish(reject, new Error(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）`));
    });

    req.write(body);
    req.end();
  });

  return {
    promise,
    cancel() {
      canceled = true;
      try { if (req) req.destroy(); } catch (e) { /* 忽略 */ }
    }
  };
}

/**
 * 读取服务端模型列表（GET /models），向量模型排在最后
 * @param {Object} config { apiEndpoint, apiKey? }
 * @returns {Promise<string[]>}
 */
function listModels(config) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(resolveModelsEndpoint(config && config.apiEndpoint));
    } catch (e) {
      reject(new Error(`API 地址格式无效: ${(config && config.apiEndpoint) || ''}`));
      return;
    }
    const isHttps = target.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: requestHost(target.hostname),
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(config && config.apiKey) },
      timeout: 8000
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`获取模型列表失败 (HTTP ${res.statusCode})`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const list = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed.models) ? parsed.models : []);
          const ids = list
            .map((m) => String((m && (m.id || m.name || m.model)) || '').trim())
            .filter(Boolean)
            .sort((a, b) => Number(/embed/i.test(a)) - Number(/embed/i.test(b)));
          resolve([...new Set(ids)]);
        } catch (e) {
          reject(new Error('模型列表解析失败'));
        }
      });
    });
    req.on('error', (e) => reject(new Error(networkErrorMessage(e, target))));
    req.on('timeout', () => { req.destroy(); reject(new Error('获取模型列表超时')); });
    req.end();
  });
}

/**
 * 测试连接：发一条极短的对话，返回模型回复正文
 * @param {Object} config
 * @returns {Promise<string>}
 */
function testConnection(config) {
  return requestChat(config, [
    { role: 'user', content: '你好，请只回复四个字：连接成功' }
  ], { stream: false }).promise.then((result) => result.content.trim());
}

module.exports = {
  DEFAULT_CHAT_ENDPOINT,
  resolveChatEndpoint,
  resolveModelsEndpoint,
  parseSseLine,
  createSseParser,
  createThinkSplitter,
  splitThink,
  requestChat,
  listModels,
  testConnection
};
