/**
 * 本地大模型服务客户端（状态检测 + 模型列表）
 * 仅依赖 Node 内置模块，不依赖 Electron，可单独测试
 *
 * 支持所有 OpenAI 兼容的本地推理服务：
 *   - Ollama        http://127.0.0.1:11434/v1   （额外读取 /api/ps 获取已加载到显存的模型）
 *   - LM Studio     http://127.0.0.1:1234/v1
 *   - llama.cpp     http://127.0.0.1:8080/v1    （llama-server）
 *   - vLLM          http://127.0.0.1:8000/v1
 *   - 其它自定义    任意 OpenAI 兼容地址（如 Xinference / LocalAI / one-api）
 */

const https = require('https');
const http = require('http');

/** 预设的本地推理服务 */
const PROVIDERS = {
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  llamacpp: { name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  vllm: { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  custom: { name: '自定义', baseUrl: '' }
};

const DEFAULT_PROVIDER = 'ollama';
const DEFAULT_BASE_URL = PROVIDERS[DEFAULT_PROVIDER].baseUrl;
/** 状态检测超时（毫秒） */
const STATUS_TIMEOUT = 8000;

function providerName(provider) {
  return (PROVIDERS[provider] && PROVIDERS[provider].name) || '本地模型';
}

/** 补全协议前缀（本地服务默认 http） */
function normalizeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

/**
 * 把用户填写的地址规范成 OpenAI 兼容的 base 地址（以 /v1 之类的前缀结尾）
 *   ''                                         -> 预设地址
 *   http://127.0.0.1:11434                     -> http://127.0.0.1:11434/v1
 *   http://127.0.0.1:1234/v1/                  -> http://127.0.0.1:1234/v1
 *   http://127.0.0.1:1234/v1/chat/completions  -> http://127.0.0.1:1234/v1
 */
function resolveBaseUrl(config) {
  const provider = (config && config.provider) || DEFAULT_PROVIDER;
  const raw = normalizeUrl(config && config.apiEndpoint) ||
    (PROVIDERS[provider] && PROVIDERS[provider].baseUrl) || DEFAULT_BASE_URL;
  const parsed = new URL(raw);
  let pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!pathname) pathname = '/v1';
  return `${parsed.origin}${pathname}`;
}

/**
 * Node 18 解析 localhost 可能优先得到 ::1，而 Ollama 等默认只监听 127.0.0.1，
 * 这里统一把 localhost 换成 127.0.0.1，避免 ECONNREFUSED
 */
function requestHost(hostname) {
  return hostname === 'localhost' ? '127.0.0.1' : hostname.replace(/^\[|\]$/g, '');
}

/** 把网络错误翻译成用户能看懂的提示 */
function friendlyNetworkError(error, target) {
  const where = target ? `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}` : '';
  const code = error && error.code;
  if (code === 'ECONNREFUSED') {
    return `连接不到本地模型服务 ${where}，请确认 Ollama / LM Studio 等已启动`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `找不到主机 ${where}，请检查服务地址`;
  if (code === 'ECONNRESET') return `连接被重置 (${where})`;
  return `网络请求失败: ${(error && error.message) || '未知错误'}`;
}

/**
 * 发一个 GET 请求并解析 JSON
 * @returns {Promise<any>}
 */
function getJson(url, apiKey, timeout = STATUS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new Error(`服务地址格式无效: ${url}`));
      return;
    }
    const isHttps = target.protocol === 'https:';
    const headers = { Accept: 'application/json' };
    const key = String(apiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const req = (isHttps ? https : http).request({
      hostname: requestHost(target.hostname),
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      timeout
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error(res.statusCode === 401
            ? '服务需要 API Key 或 Key 无效 (401)'
            : `请求失败 (HTTP ${res.statusCode})`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('响应不是合法的 JSON，请确认地址指向 OpenAI 兼容接口'));
        }
      });
      res.on('error', (e) => reject(new Error(`响应错误: ${e.message}`)));
    });
    req.on('error', (e) => reject(new Error(friendlyNetworkError(e, target))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`连接超时（${Math.round(timeout / 1000)} 秒）`));
    });
    req.end();
  });
}

/**
 * 获取服务端可用模型列表（GET {base}/models）
 * @returns {Promise<string[]>}
 */
async function listModels(config) {
  const base = resolveBaseUrl(config);
  const parsed = await getJson(`${base}/models`, config && config.apiKey);
  const list = Array.isArray(parsed && parsed.data) ? parsed.data
    : (Array.isArray(parsed && parsed.models) ? parsed.models : []);
  const ids = list
    .map((m) => String((m && (m.id || m.name || m.model)) || '').trim())
    .filter(Boolean)
    // 向量模型无法对话，排到最后
    .sort((a, b) => Number(/embed/i.test(a)) - Number(/embed/i.test(b)));
  return [...new Set(ids)];
}

/**
 * Ollama 专属：读取当前已加载到内存/显存的模型（GET /api/ps），失败时返回 null
 * @returns {Promise<Array<{ name: string, sizeVram: number }>|null>}
 */
async function listOllamaLoaded(config) {
  try {
    const origin = new URL(resolveBaseUrl(config)).origin;
    const parsed = await getJson(`${origin}/api/ps`, config && config.apiKey, 4000);
    const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
    return models.map((m) => ({ name: String(m.name || m.model || ''), sizeVram: Number(m.size_vram) || 0 }));
  } catch (e) {
    return null;
  }
}

/**
 * 选出本次对话实际使用的模型：配置了就用配置的，否则取服务端第一个可对话的模型
 */
function pickModel(configured, models) {
  const name = String(configured || '').trim();
  if (name) return name;
  const chatModels = (models || []).filter((m) => !/embed/i.test(m));
  return chatModels[0] || (models || [])[0] || '';
}

/**
 * 检测本地模型服务状态
 * @param {Object} config { provider, apiEndpoint, apiKey, model }
 * @returns {Promise<Object>} { online, provider, providerName, baseUrl, models, model, modelAvailable, loaded, latencyMs }
 */
async function fetchStatus(config) {
  const provider = (config && config.provider) || DEFAULT_PROVIDER;
  const baseUrl = resolveBaseUrl(config);
  const started = Date.now();
  const models = await listModels(config);
  const latencyMs = Date.now() - started;
  const model = pickModel(config && config.model, models);
  const loaded = provider === 'ollama' ? await listOllamaLoaded(config) : null;

  return {
    online: true,
    provider,
    providerName: providerName(provider),
    baseUrl,
    models,
    model,
    modelAvailable: !!model && (models.length === 0 || models.includes(model)),
    loaded,
    latencyMs
  };
}

/** 把状态结果格式化为纯文字（气泡兜底 / 托盘提示用） */
function formatStatusText(status) {
  if (!status || !status.online) return '🔌 本地模型离线';
  const lines = [`🟢 ${status.providerName} 在线`];
  lines.push(status.model ? `模型：${status.model}` : '尚未选择模型');
  lines.push(`共 ${status.models.length} 个模型 · ${status.latencyMs}ms`);
  return lines.join('\n');
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  DEFAULT_BASE_URL,
  providerName,
  normalizeUrl,
  resolveBaseUrl,
  requestHost,
  friendlyNetworkError,
  listModels,
  listOllamaLoaded,
  pickModel,
  fetchStatus,
  formatStatusText
};
