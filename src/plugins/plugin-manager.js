/**
 * 插件宿主（主进程）
 * ============================================================================
 * 目标：
 *   1. 把「可扩展功能」（如 LLM 对话）与本体彻底解耦，插件出错/缺失都不影响本体；
 *   2. 为后续新功能预留统一接口：菜单项（桌宠右键 / 托盘）、设置页表单、
 *      命名空间化的 IPC、插件独立存储与窗口。
 *
 * 一个插件就是一个目录：src/plugins/<id>/
 *   plugin.json   清单（必需）
 *   main.js       主进程入口，导出 { activate(ctx), deactivate?(ctx) }
 *   preload.js    渲染进程桥（可选，由清单的 preload 字段声明）
 *   renderer/*    插件自己的页面（可选）
 *
 * 本模块不直接 require('electron')，所有 Electron 能力由外部注入，
 * 因此可以脱离 GUI 单独做自检（见 scripts/self-check.js）。
 *
 * 详细接口说明见 src/plugins/README.md
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

/** 插件根目录（本文件所在目录） */
const PLUGINS_DIR = __dirname;
/** 宿主对渲染进程暴露的注册表通道前缀 */
const CHANNEL_PREFIX = 'plugins:';
/** 插件自有 IPC 的通道前缀（完整形如 plugin:<id>:<channel>） */
const PLUGIN_CHANNEL_PREFIX = 'plugin:';
/** 允许的设置字段类型 */
const FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'textarea', 'select'];
/** 插件 id 规范：字母/数字开头，允许 . _ - */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
/** 设置字段 key 规范：只允许字母数字 _ -（可直接用于 DOM 选择器） */
const SAFE_KEY = /^[a-z0-9_-]+$/i;

let currentHost = null;

/**
 * 默认的存储工厂：插件数据落在 <userData>/plugins/<id>/<name>.json
 * 可注入替换（自检脚本用内存实现），避免在非 Electron 环境加载 electron-store
 */
function defaultStoreFactory({ name, cwd, defaults }) {
  const Store = require('electron-store');
  return new Store({ name, cwd, defaults });
}

// ============================================================================
// 清单字段整理（纯函数，便于单测）
// ============================================================================

/** 规范化设置字段列表 */
function sanitizeFields(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawFields) {
    if (!raw || typeof raw !== 'object') continue;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key || !SAFE_KEY.test(key) || seen.has(key)) continue;
    const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'text';
    seen.add(key);
    const field = {
      key,
      label: raw.label || key,
      type,
      default: raw.default,
      hint: raw.hint || '',
      placeholder: raw.placeholder || ''
    };
    if (type === 'number') {
      if (Number.isFinite(Number(raw.min))) field.min = Number(raw.min);
      if (Number.isFinite(Number(raw.max))) field.max = Number(raw.max);
      if (Number.isFinite(Number(raw.step))) field.step = Number(raw.step);
      if (!Number.isFinite(Number(field.default))) field.default = 0;
    }
    if (type === 'boolean') field.default = raw.default === true;
    if (type === 'textarea') field.rows = Number.isFinite(Number(raw.rows)) ? Number(raw.rows) : 3;
    if (type === 'select') {
      field.options = (Array.isArray(raw.options) ? raw.options : [])
        .filter((o) => o && typeof o === 'object' && o.value !== undefined)
        .map((o) => ({ value: String(o.value), label: o.label ? String(o.label) : String(o.value) }));
      if (!field.options.length) field.options = [{ value: '', label: '（无选项）' }];
      const values = field.options.map((o) => o.value);
      field.default = values.includes(String(field.default)) ? String(field.default) : values[0];
    }
    if (typeof field.default !== 'string' && field.type !== 'number' && field.type !== 'boolean') {
      field.default = field.default === undefined || field.default === null ? '' : String(field.default);
    }
    out.push(field);
  }
  return out;
}

/** 规范化设置动作列表 */
function sanitizeActions(rawActions) {
  if (!Array.isArray(rawActions)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: raw.label || id, style: raw.style === 'primary' ? 'primary' : 'secondary' });
  }
  return out;
}

/** 读取清单中的菜单贡献 */
function sanitizeMenuItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item) => item && typeof item === 'object' && typeof item.command === 'string' && item.command.trim())
    .map((item) => ({
      command: item.command.trim(),
      label: item.label ? String(item.label) : item.command.trim(),
      icon: item.icon ? String(item.icon) : '🧩',
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0
    }));
}

/** 确保目标路径位于插件目录内部（阻止 ../ 逃逸） */
function assertInside(dir, target, label) {
  const rel = path.relative(path.resolve(dir), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} 必须位于插件目录内`);
  }
}

// ============================================================================
// 插件宿主
// ============================================================================

function createPluginManager(options = {}) {
  const electron = options.electron || {};
  const { app, ipcMain, BrowserWindow, shell, dialog } = electron;
  const log = options.logger || console;
  const pluginsDir = options.pluginsDir || PLUGINS_DIR;
  const storeFactory = typeof options.storeFactory === 'function' ? options.storeFactory : defaultStoreFactory;
  const hostServices = options.hostServices && typeof options.hostServices === 'object' ? options.hostServices : {};

  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('插件宿主需要 electron.ipcMain');
  }

  /** id -> 插件记录 */
  const records = new Map();
  /** 加载报告（用于日志 / 自检） */
  const reports = [];
  let loaded = false;
  let registryRegistered = false;

  const tag = (id) => `[插件:${id}]`;

  function userDataDir() {
    try {
      if (app && typeof app.getPath === 'function') return app.getPath('userData');
    } catch (e) { /* 回退到临时目录 */ }
    return path.join(os.tmpdir(), 'deskllmpet-plugins');
  }

  // ---------- 发现 ----------

  function discover() {
    let entries = [];
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch (e) {
      log.warn('[插件] 无法读取插件目录:', e.message);
      return [];
    }

    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 以 _ 或 . 开头的目录（例如 _shared 工具目录）不作为插件
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      const dir = path.join(pluginsDir, entry.name);
      const manifestPath = path.join(dir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        found.push({ dir, manifest, fallbackId: entry.name });
      } catch (e) {
        log.warn(`⚠️ 插件清单解析失败 [${entry.name}]: ${e.message}`);
        reports.push({ id: entry.name, status: 'error', error: `plugin.json 解析失败: ${e.message}` });
      }
    }
    return found;
  }

  // ---------- 校验 ----------

  function validateManifest(manifest, dir, fallbackId) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('plugin.json 内容必须是对象');
    }
    const id = String(manifest.id || fallbackId || '').trim();
    if (!id) throw new Error('缺少 id');
    if (!SAFE_ID.test(id)) throw new Error(`id 非法（只允许字母数字 . _ -）: ${id}`);
    if (records.has(id)) throw new Error(`id 重复: ${id}`);

    const mainRel = String(manifest.main || 'main.js').trim();
    const mainPath = path.resolve(dir, mainRel);
    assertInside(dir, mainPath, 'main');
    if (!fs.existsSync(mainPath)) throw new Error(`入口文件不存在: ${mainRel}`);

    let preloadPath = null;
    if (manifest.preload) {
      const preloadRel = String(manifest.preload).trim();
      preloadPath = path.resolve(dir, preloadRel);
      assertInside(dir, preloadPath, 'preload');
      if (!fs.existsSync(preloadPath)) throw new Error(`preload 不存在: ${preloadRel}`);
    }

    const contributes = manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : {};
    for (const key of ['petMenu', 'trayMenu']) {
      const items = contributes[key];
      if (items !== undefined && !Array.isArray(items)) throw new Error(`contributes.${key} 必须是数组`);
    }
    if (contributes.settings !== undefined) {
      const s = contributes.settings;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('contributes.settings 必须是对象');
      if (s.fields !== undefined && !Array.isArray(s.fields)) throw new Error('contributes.settings.fields 必须是数组');
      if (s.actions !== undefined && !Array.isArray(s.actions)) throw new Error('contributes.settings.actions 必须是数组');
    }

    return { id, mainPath, preloadPath };
  }

  // ---------- 上下文 ----------

  function createContext(record) {
    const { id, dir, manifest } = record;
    const settingsManifest = (manifest.contributes && manifest.contributes.settings) || {};
    const fields = sanitizeFields(settingsManifest.fields);

    const channelOf = (channel) => {
      if (typeof channel !== 'string' || !channel.trim()) throw new Error('IPC channel 必须是非空字符串');
      return `${PLUGIN_CHANNEL_PREFIX}${id}:${channel.trim()}`;
    };

    // ---- 设置读写 ----

    function defaultsOf() {
      const out = {};
      for (const f of fields) out[f.key] = f.default;
      return out;
    }

    function coerce(field, value) {
      switch (field.type) {
        case 'boolean':
          return value === true || value === 'true';
        case 'number': {
          const num = Number(value);
          if (!Number.isFinite(num)) return field.default;
          const min = field.min === undefined ? -Infinity : field.min;
          const max = field.max === undefined ? Infinity : field.max;
          return Math.min(max, Math.max(min, num));
        }
        case 'select': {
          const allowed = field.options.map((o) => o.value);
          const str = value === undefined || value === null ? '' : String(value);
          return allowed.includes(str) ? str : field.default;
        }
        default:
          return value === undefined || value === null ? '' : String(value);
      }
    }

    function getSettings() {
      const stored = record.store.get('settings') || {};
      const out = defaultsOf();
      for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(stored, f.key)) out[f.key] = coerce(f, stored[f.key]);
      }
      return out;
    }

    function setSettings(values) {
      const next = getSettings();
      if (values && typeof values === 'object') {
        for (const f of fields) {
          if (Object.prototype.hasOwnProperty.call(values, f.key)) next[f.key] = coerce(f, values[f.key]);
        }
        record.store.set('settings', next);
      }
      for (const listener of [...record.settingsListeners]) {
        try { listener(next); } catch (e) { log.warn(tag(id), '设置变更回调异常:', e.message); }
      }
      return next;
    }

    // ---- 窗口 ----

    function createWindow(windowOptions = {}) {
      if (!BrowserWindow) throw new Error('BrowserWindow 不可用');
      const opts = { ...windowOptions };
      const webPreferences = { ...(opts.webPreferences || {}), contextIsolation: true, nodeIntegration: false };
      if (record.preloadPath) webPreferences.preload = record.preloadPath;
      opts.webPreferences = webPreferences;

      const win = new BrowserWindow(opts);
      record.windows.add(win);
      win.on('closed', () => record.windows.delete(win));

      // 安全兜底：插件窗口只允许停留在自己的插件目录内，外链交给系统浏览器
      const pluginUrlPrefix = pathToFileURL(record.dir).href.replace(/\/?$/, '/');
      try {
        win.webContents.on('will-navigate', (event, url) => {
          if (!String(url).startsWith(pluginUrlPrefix)) {
            event.preventDefault();
            if (/^https?:/i.test(url)) openExternal(url);
          }
        });
        win.webContents.setWindowOpenHandler(({ url }) => {
          if (/^https?:/i.test(url)) openExternal(url);
          return { action: 'deny' };
        });
      } catch (e) { /* 老版本 Electron 兜底 */ }

      return win;
    }

    function openExternal(url) {
      try {
        if (shell && typeof shell.openExternal === 'function') shell.openExternal(url);
      } catch (e) { /* 忽略 */ }
    }

    const ctx = {
      id,
      name: manifest.name || id,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      dir,
      manifest,
      log: (...args) => log.log(tag(id), ...args),
      warn: (...args) => log.warn(tag(id), ...args),
      resolve: (...parts) => path.join(dir, ...parts),

      ipc: {
        /** 注册 invoke 处理器（自动命名空间化） */
        handle(channel, handler) {
          if (typeof handler !== 'function') throw new Error('ipc.handle 需要函数');
          const full = channelOf(channel);
          ipcMain.handle(full, handler);
          record.channels.add(full);
          return full;
        },
        /** 注册单向消息处理器（自动命名空间化） */
        on(channel, handler) {
          if (typeof handler !== 'function') throw new Error('ipc.on 需要函数');
          const full = channelOf(channel);
          ipcMain.on(full, handler);
          record.channels.add(full);
          return full;
        },
        /** 向本插件创建的所有窗口广播消息 */
        send(channel, payload) {
          const full = `${PLUGIN_CHANNEL_PREFIX}${id}:${String(channel)}`;
          for (const win of record.windows) {
            try {
              if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send(full, payload);
              }
            } catch (e) { /* 忽略单个窗口的异常 */ }
          }
        }
      },

      /** 插件专属存储（数据隔离在 <userData>/plugins/<id>/） */
      createStore(name, defaults) {
        const safeName = String(name || 'data').replace(/[^a-z0-9._-]/gi, '_') || 'data';
        return storeFactory({
          name: safeName,
          cwd: path.join(userDataDir(), 'plugins', id),
          defaults: defaults && typeof defaults === 'object' ? defaults : {}
        });
      },

      createWindow,

      settings: { get: getSettings, set: setSettings },

      /** 菜单项被点击时回调 (command, payload) */
      onCommand(fn) { if (typeof fn === 'function') record.commandHandlers.push(fn); },
      /** 设置页动作按钮被点击时回调 (actionId, values)，可返回 { message } */
      onSettingsAction(fn) { if (typeof fn === 'function') record.settingsActions.push(fn); },
      /** 设置被保存后回调 (values) */
      onSettingsChanged(fn) { if (typeof fn === 'function') record.settingsListeners.push(fn); },
      /** 插件卸载时回调 */
      onDeactivate(fn) { if (typeof fn === 'function') record.deactivateHandlers.push(fn); },

      /** 宿主提供的可选只读服务（可能为空，插件需自行兜底） */
      host: {
        app,
        BrowserWindow,
        shell,
        dialog,
        /** 本体共享的 LLM 配置（只读，用于插件缺省回退） */
        getSharedLLMConfig: typeof hostServices.getSharedLLMConfig === 'function'
          ? () => {
            try { return hostServices.getSharedLLMConfig() || null; }
            catch (e) { return null; }
          }
          : () => null,
        /**
         * 让桌宠进入某个情景（可选服务）
         * { id, loop?: [动画名], once?: 动画名, ttl?: 毫秒 }；传 null 回到闲置
         */
        setPetActivity: typeof hostServices.setPetActivity === 'function'
          ? (activity) => {
            try { return hostServices.setPetActivity(activity) !== false; }
            catch (e) { return false; }
          }
          : null,
        /** 让桌宠弹出一个文字气泡（可选服务）：{ text, duration, onClick? }，传了 onClick 气泡可点击 */
        showPetBubble: typeof hostServices.showPetBubble === 'function'
          ? (payload) => {
            try { return hostServices.showPetBubble(payload) !== false; }
            catch (e) { return false; }
          }
          : null,
        /** 打开本体的设置窗口（可选服务，返回是否成功） */
        openSettings: typeof hostServices.openSettings === 'function'
          ? () => {
            try { return hostServices.openSettings() !== false; }
            catch (e) { return false; }
          }
          : null
      }
    };

    return ctx;
  }

  // ---------- 生命周期 ----------

  function disposeRecord(record) {
    record.active = false;
    for (const handler of [...record.deactivateHandlers].reverse()) {
      try { handler(); } catch (e) { log.warn(tag(record.id), '卸载回调异常:', e.message); }
    }
    record.deactivateHandlers = [];

    for (const channel of record.channels) {
      try { ipcMain.removeHandler(channel); } catch (e) { /* 非 handle 通道会抛错，忽略 */ }
      try { if (typeof ipcMain.removeAllListeners === 'function') ipcMain.removeAllListeners(channel); } catch (e) { /* 忽略 */ }
    }
    record.channels.clear();

    for (const win of [...record.windows]) {
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) { /* 忽略 */ }
    }
    record.windows.clear();
  }

  async function loadAll() {
    if (loaded) return reports;
    loaded = true;

    registerRegistryIpc();

    for (const entry of discover()) {
      const { dir, manifest, fallbackId } = entry;
      const id = String(manifest.id || fallbackId || '').trim() || fallbackId;

      if (manifest.enabled === false) {
        reports.push({ id, status: 'disabled' });
        log.log(`[插件] ${id} 已禁用（plugin.json 中 enabled=false）`);
        continue;
      }

      let record = null;
      try {
        const info = validateManifest(manifest, dir, fallbackId);
        record = {
          id: info.id,
          dir,
          manifest,
          preloadPath: info.preloadPath,
          channels: new Set(),
          windows: new Set(),
          commandHandlers: [],
          settingsActions: [],
          settingsListeners: [],
          deactivateHandlers: [],
          active: false,
          store: null,
          ctx: null,
          module: null
        };
        record.store = storeFactory({
          name: 'settings',
          cwd: path.join(userDataDir(), 'plugins', info.id),
          defaults: { settings: {} }
        });
        record.ctx = createContext(record);

        const mod = require(info.mainPath);
        record.module = mod;
        const activate = typeof mod === 'function' ? mod : mod && mod.activate;
        if (typeof activate !== 'function') throw new Error('入口文件必须导出 activate(ctx)');

        // 先登记，插件在 activate 期间即可使用宿主 API
        records.set(info.id, record);
        await activate(record.ctx);
        record.active = true;
        reports.push({ id: info.id, status: 'active', name: record.ctx.name, version: record.ctx.version });
        log.log(`✅ 插件已加载: ${record.ctx.name} v${record.ctx.version} (${info.id})`);
      } catch (e) {
        if (record) {
          records.delete(record.id);
          try { disposeRecord(record); } catch (err) { /* 忽略 */ }
        }
        reports.push({ id: record ? record.id : id, status: 'error', error: e.message });
        log.warn(`⚠️ 插件加载失败 [${id}]: ${e.message}（已跳过，不影响本体功能）`);
      }
    }

    broadcastChanged();
    return reports;
  }

  async function deactivateAll() {
    for (const record of [...records.values()]) {
      try {
        if (record.module && typeof record.module.deactivate === 'function') {
          await record.module.deactivate(record.ctx);
        }
      } catch (e) {
        log.warn(tag(record.id), 'deactivate 异常:', e.message);
      }
      try { disposeRecord(record); } catch (e) { /* 忽略 */ }
    }
    records.clear();
  }

  // ---------- 对外查询 ----------

  function collectMenu(kind) {
    const out = [];
    for (const record of records.values()) {
      if (!record.active) continue;
      const contributes = record.manifest.contributes || {};
      for (const item of sanitizeMenuItems(contributes[kind])) {
        out.push({
          pluginId: record.id,
          pluginName: record.ctx ? record.ctx.name : record.id,
          command: item.command,
          label: item.label,
          icon: item.icon,
          order: item.order
        });
      }
    }
    return out.sort((a, b) => (a.order - b.order) || a.pluginId.localeCompare(b.pluginId));
  }

  function getSettingsSections() {
    const out = [];
    for (const record of records.values()) {
      if (!record.active) continue;
      const settings = (record.manifest.contributes || {}).settings;
      if (!settings || typeof settings !== 'object') continue;
      const fields = sanitizeFields(settings.fields);
      const actions = sanitizeActions(settings.actions);
      if (!fields.length && !actions.length) continue;
      out.push({
        pluginId: record.id,
        title: settings.title || (record.ctx ? record.ctx.name : record.id),
        icon: settings.icon || '🧩',
        description: settings.description || '',
        fields,
        actions
      });
    }
    return out;
  }

  function listPlugins() {
    return [...records.values()].map((record) => ({
      id: record.id,
      name: record.ctx ? record.ctx.name : record.id,
      version: record.ctx ? record.ctx.version : '',
      description: record.ctx ? record.ctx.description : '',
      active: record.active
    }));
  }

  async function runCommand(pluginId, command, payload) {
    const record = records.get(String(pluginId || ''));
    if (!record) return { success: false, error: `插件 ${pluginId} 未加载` };
    if (!record.active) return { success: false, error: `插件 ${pluginId} 未启用` };
    if (!record.commandHandlers.length) return { success: false, error: `插件 ${pluginId} 未注册命令处理器` };
    try {
      for (const handler of record.commandHandlers) {
        await handler(String(command || ''), payload && typeof payload === 'object' ? payload : {});
      }
      return { success: true };
    } catch (e) {
      log.warn(tag(record.id), `命令 ${command} 执行失败:`, e.message);
      return { success: false, error: e.message };
    }
  }

  function getPluginSettings(pluginId) {
    const record = records.get(String(pluginId || ''));
    if (!record || !record.active) return {};
    return record.ctx.settings.get();
  }

  function setPluginSettings(pluginId, values) {
    const record = records.get(String(pluginId || ''));
    if (!record || !record.active) return { success: false, error: `插件 ${pluginId} 未加载` };
    try {
      return { success: true, values: record.ctx.settings.set(values) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async function runSettingsAction(pluginId, actionId, values) {
    const record = records.get(String(pluginId || ''));
    if (!record || !record.active) return { success: false, error: `插件 ${pluginId} 未加载` };

    const settings = (record.manifest.contributes || {}).settings || {};
    const declared = sanitizeActions(settings.actions);
    if (!declared.some((a) => a.id === actionId)) {
      return { success: false, error: `未声明的设置动作: ${actionId}` };
    }
    if (!record.settingsActions.length) {
      return { success: false, error: `插件 ${pluginId} 未注册设置动作处理器` };
    }
    try {
      for (const handler of record.settingsActions) {
        const result = await handler(String(actionId), values && typeof values === 'object' ? values : record.ctx.settings.get());
        if (result && typeof result === 'object') {
          return { success: result.success !== false, message: result.message || '', error: result.error };
        }
        if (result !== undefined) return { success: true, message: String(result) };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ---------- 宿主注册表 IPC ----------

  function broadcastChanged() {
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send(`${CHANNEL_PREFIX}changed`);
      } catch (e) { /* 忽略 */ }
    }
  }

  function registerRegistryIpc() {
    if (registryRegistered) return;
    registryRegistered = true;

    // 命名空间统一为 plugins:*，与插件自身的 plugin:<id>:* 区分，避免撞车
    ipcMain.handle(`${CHANNEL_PREFIX}list`, () => listPlugins());
    ipcMain.handle(`${CHANNEL_PREFIX}get-pet-menu`, () => collectMenu('petMenu'));
    ipcMain.handle(`${CHANNEL_PREFIX}get-tray-menu`, () => collectMenu('trayMenu'));
    ipcMain.handle(`${CHANNEL_PREFIX}get-settings-sections`, () => getSettingsSections());
    ipcMain.handle(`${CHANNEL_PREFIX}get-settings`, (event, pluginId) => getPluginSettings(pluginId));
    ipcMain.handle(`${CHANNEL_PREFIX}set-settings`, (event, pluginId, values) => setPluginSettings(pluginId, values));
    ipcMain.handle(`${CHANNEL_PREFIX}run-settings-action`, (event, pluginId, actionId, values) =>
      runSettingsAction(pluginId, actionId, values));
    ipcMain.handle(`${CHANNEL_PREFIX}run-command`, (event, pluginId, command, payload) =>
      runCommand(pluginId, command, payload));
  }

  return {
    pluginsDir,
    loadAll,
    deactivateAll,
    getReports: () => [...reports],
    listPlugins,
    getPetMenuItems: () => collectMenu('petMenu'),
    getTrayMenuItems: () => collectMenu('trayMenu'),
    getSettingsSections,
    getPluginSettings,
    setPluginSettings,
    runSettingsAction,
    runCommand
  };
}

/**
 * 初始化全局插件宿主（幂等）
 * @param {{electron: Object, logger?: Object, pluginsDir?: string, storeFactory?: Function, hostServices?: Object}} options
 */
function initPluginHost(options = {}) {
  if (!currentHost) currentHost = createPluginManager(options);
  return currentHost;
}

/** 获取当前插件宿主（未初始化时返回 null，调用方必须兜底） */
function getPluginHost() {
  return currentHost;
}

module.exports = {
  PLUGINS_DIR,
  CHANNEL_PREFIX,
  PLUGIN_CHANNEL_PREFIX,
  createPluginManager,
  initPluginHost,
  getPluginHost,
  // 导出纯函数便于自检
  sanitizeFields,
  sanitizeActions,
  sanitizeMenuItems
};
