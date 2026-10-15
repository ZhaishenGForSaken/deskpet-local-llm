/**
 * 行为感知插件（主进程入口）
 * ============================================================================
 * 根据前台程序、键鼠空闲时间、时间段和节日，让桌宠播放对应的情景动画：
 *   写代码 / 学习 / 听音乐 / 看视频 / 打游戏 / 发呆 / 离开睡着 / 醒来、吃饭提醒、熬夜提醒、节日
 *
 * 隐私：
 *   - 默认只读前台「程序名」；窗口标题需要在设置里手动开启，且只用于本机匹配
 *   - 程序名与标题只在内存中使用，不写盘、不打日志、不发给任何模型
 *
 * 只通过宿主 ctx 获取能力，删除本目录即可完全下线该功能。
 */

const { startForegroundWatcher } = require('./foreground');
const S = require('./scenes');

/** 前台采样间隔 */
const SAMPLE_MS = 2000;
/** 情景优先级：低于对话（10），对话结束后会回到当前情景 */
const SCENE_PRIORITY = 1;
/** 情景在桌宠端的有效期；插件定期续期，插件异常时桌宠会自己回到闲置 */
const SCENE_TTL = 3 * 60 * 1000;
const SCENE_HEARTBEAT = 60 * 1000;
/** 用户在场的判定：键鼠空闲少于这个秒数才触发吃饭 / 熬夜 / 节日事件 */
const PRESENT_SECONDS = 60;
/** 两个时间事件之间至少间隔 */
const EVENT_GAP = 2 * 60 * 1000;
const LATE_NIGHT_EVERY = 30 * 60 * 1000;
const FESTIVAL_EVERY = 60 * 60 * 1000;

const runtime = {
  watcher: null,
  watcherTitles: false,
  timer: null,
  lastExternal: { process: '', title: '' },
  scene: null,
  pending: null,
  pendingSince: 0,
  lastSentAt: 0,
  lastEventAt: 0,
  lastLateNightAt: 0,
  lastFestivalAt: 0,
  fired: new Set(),
  error: ''
};

function settingsOf(ctx) {
  return ctx.settings.get() || {};
}

function idleSeconds(ctx) {
  const fn = ctx.host && ctx.host.getIdleSeconds;
  if (typeof fn !== 'function') return 0;
  const value = Number(fn());
  return Number.isFinite(value) ? value : 0;
}

/** 把当前情景（可附带一次反应动画）发给桌宠 */
function sendScene(ctx, sceneId, once) {
  const fn = ctx.host && ctx.host.setPetActivity;
  if (typeof fn !== 'function') return;
  const def = sceneId ? S.SCENES[sceneId] : null;
  runtime.lastSentAt = Date.now();
  if (!def && !once) { fn(null); return; }
  fn({
    id: sceneId ? `scene-${sceneId}` : 'scene-event',
    loop: def ? def.loop : [],
    once: once || undefined,
    priority: SCENE_PRIORITY,
    ttl: SCENE_TTL
  });
}

function say(ctx, text) {
  const fn = ctx.host && ctx.host.showPetBubble;
  if (typeof fn === 'function') fn({ text, duration: 6000 });
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// ============================================================================
// 主循环
// ============================================================================

function evaluate(ctx) {
  const settings = settingsOf(ctx);
  if (settings.enabled === false) return;
  const now = Date.now();
  const idle = idleSeconds(ctx);
  const candidate = S.detectScene(runtime.lastExternal, idle, settings);

  if (candidate !== runtime.scene) {
    // 发呆 / 睡着由空闲时间本身判定，进出都立即生效；其余场景要稳定一段时间才切换，避免切窗口时抽风
    const immediate = ['sleep', 'drowsy'].includes(candidate) || ['sleep', 'drowsy'].includes(runtime.scene);
    if (runtime.pending !== candidate) {
      runtime.pending = candidate;
      runtime.pendingSince = now;
    }
    const switchMs = Math.max(0, Number(settings.switchSeconds) || 30) * 1000;
    if (immediate || now - runtime.pendingSince >= switchMs) {
      const wokeUp = runtime.scene === 'sleep' && candidate !== 'sleep' && candidate !== 'drowsy';
      runtime.scene = candidate;
      runtime.pending = null;
      sendScene(ctx, candidate, wokeUp ? '打瞌睡被惊醒' : undefined);
      if (wokeUp) say(ctx, '你回来啦！👋');
      return;
    }
  } else {
    runtime.pending = null;
  }

  if (runtime.scene && now - runtime.lastSentAt >= SCENE_HEARTBEAT) sendScene(ctx, runtime.scene);
  timeEvents(ctx, settings, idle, now);
}

/** 吃饭 / 熬夜 / 节日：只在用户在场时触发，彼此至少间隔几分钟 */
function timeEvents(ctx, settings, idle, now) {
  if (idle >= PRESENT_SECONDS || now - runtime.lastEventAt < EVENT_GAP) return;
  const date = new Date(now);
  const fire = (anim, text) => {
    runtime.lastEventAt = now;
    sendScene(ctx, runtime.scene, anim);
    if (text) say(ctx, text);
  };

  if (settings.festivals !== false) {
    const festival = S.festivalAt(date);
    if (festival) {
      const greetKey = `${dayKey(date)}-festival-${festival.id}`;
      if (!runtime.fired.has(greetKey)) {
        runtime.fired.add(greetKey);
        runtime.lastFestivalAt = now;
        fire(festival.anim, festival.text);
        return;
      }
      if (now - runtime.lastFestivalAt >= FESTIVAL_EVERY) {
        runtime.lastFestivalAt = now;
        fire(festival.anim);
        return;
      }
    }
  }

  if (settings.mealReminders !== false) {
    const meal = S.mealAt(date);
    const key = meal ? `${dayKey(date)}-${meal.id}` : '';
    if (meal && !runtime.fired.has(key)) {
      runtime.fired.add(key);
      fire(meal.anim, meal.text);
      return;
    }
  }

  if (settings.lateNightReminder !== false && S.isLateNight(date) && now - runtime.lastLateNightAt >= LATE_NIGHT_EVERY) {
    runtime.lastLateNightAt = now;
    fire('哈欠连天', '很晚啦，早点休息吧 🌙');
  }
}

// ============================================================================
// 启停
// ============================================================================

function stopWatcher() {
  if (runtime.watcher) runtime.watcher.stop();
  runtime.watcher = null;
}

function startWatcher(ctx) {
  stopWatcher();
  const settings = settingsOf(ctx);
  runtime.watcherTitles = !!settings.readTitles;
  runtime.lastExternal = { process: '', title: '' };
  runtime.error = '';
  runtime.watcher = startForegroundWatcher({
    intervalMs: SAMPLE_MS,
    titles: runtime.watcherTitles,
    onSample: (sample) => {
      // DeskPet 自己的窗口（设置 / 对话）在前台时，保持之前的判断
      if (!S.isSelf(sample.process)) runtime.lastExternal = sample;
    },
    onError: (e) => {
      runtime.error = (e && e.message) || '未知错误';
      ctx.warn('前台探测异常:', runtime.error);
    }
  });
  if (!runtime.watcher) runtime.error = '当前系统不支持前台程序探测，只使用空闲时间与时间段';
}

function stopAll(ctx) {
  stopWatcher();
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  if (runtime.scene) sendScene(ctx, null);
  runtime.scene = null;
  runtime.pending = null;
}

function startAll(ctx) {
  stopAll(ctx);
  if (settingsOf(ctx).enabled === false) return;
  const now = Date.now();
  // 启动后 30 分钟内不提醒熬夜，避免一打开就念叨
  runtime.lastLateNightAt = now;
  runtime.lastEventAt = now - EVENT_GAP + 30 * 1000;
  startWatcher(ctx);
  runtime.timer = setInterval(() => {
    try { evaluate(ctx); } catch (e) { ctx.warn('场景判定异常:', e.message); }
  }, SAMPLE_MS);
}

/** 设置页「查看当前识别」：只展示给用户自己看 */
function statusMessage(ctx) {
  const settings = settingsOf(ctx);
  if (settings.enabled === false) return '行为感知已关闭';
  const idle = Math.round(idleSeconds(ctx));
  const sample = runtime.lastExternal;
  const scene = runtime.scene ? S.SCENES[runtime.scene].label : '普通闲置';
  const parts = [
    `前台程序：${sample.process || '（未知）'}`,
    settings.readTitles ? `窗口标题：${sample.title || '（空）'}` : '窗口标题：未读取',
    `键鼠空闲：${idle} 秒`,
    `当前场景：${scene}`
  ];
  if (runtime.pending !== null && runtime.pending !== runtime.scene) {
    parts.push(`即将切换到：${runtime.pending ? S.SCENES[runtime.pending].label : '普通闲置'}`);
  }
  if (runtime.error) parts.push(`⚠️ ${runtime.error}`);
  return parts.join('；');
}

module.exports = {
  activate(ctx) {
    ctx.onSettingsAction(async (actionId) => {
      if (actionId === 'status') return { success: true, message: statusMessage(ctx) };
      return { success: false, error: `未实现的动作: ${actionId}` };
    });

    // 宿主不支持桌宠情景（例如自检环境）时只注册设置，不启动探测
    if (!ctx.host || typeof ctx.host.setPetActivity !== 'function') {
      ctx.log('宿主未提供 setPetActivity，行为感知不启动');
      return;
    }

    ctx.onSettingsChanged(() => {
      const settings = settingsOf(ctx);
      if (settings.enabled === false) { stopAll(ctx); return; }
      // 开关「读取窗口标题」或从关闭恢复时重启探测
      if (!runtime.timer || runtime.watcherTitles !== !!settings.readTitles) startAll(ctx);
    });

    ctx.onDeactivate(() => stopAll(ctx));
    startAll(ctx);
    ctx.log('已就绪（读取窗口标题：' + (settingsOf(ctx).readTitles ? '开' : '关') + '）');
  },

  deactivate() {
    stopWatcher();
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.timer = null;
  }
};
