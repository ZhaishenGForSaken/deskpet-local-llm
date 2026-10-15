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
/** 曲间短暂静音不算停止播放：最近这么久内出过声都算在放音乐 */
const AUDIO_HOLD_MS = 15 * 1000;
/** 两个时间事件之间至少间隔 */
const EVENT_GAP = 2 * 60 * 1000;
const LATE_NIGHT_EVERY = 30 * 60 * 1000;
/** 需要「久坐提醒」的场景：写代码 / 学习 / 打游戏 / 自定义场景 */
const LONG_SESSION_SCENES = ['coding', 'study', 'game'];

/** 总线 topic：其它插件（例如 AI 对话）可以订阅 */
const TOPIC_SCENE = 'activity.scene';
const TOPIC_MILESTONE = 'activity.milestone';
const FESTIVAL_EVERY = 60 * 60 * 1000;

const runtime = {
  watcher: null,
  watcherTitles: false,
  timer: null,
  lastExternal: { process: '', title: '' },
  audioHeard: new Map(),   // 程序名 → 最近一次听到它出声的时间
  scene: null,
  sceneSince: 0,
  milestonesFired: 0,
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

/** 发呆 / 睡着本身就是安静的状态，始终持续循环 */
const CALM_SCENES = ['drowsy', 'sleep'];

/**
 * 场景动画频率：
 *   quiet      安静：只在进入场景时播一次，之后按普通闲置节奏
 *   ambient    适中（默认）：平时循环待机，情景动画代替「动作」按播放节奏偶尔出现
 *   continuous 持续：一直循环情景动画
 */
function sceneMode(sceneId, settings) {
  if (CALM_SCENES.includes(sceneId)) return 'continuous';
  return ['quiet', 'ambient', 'continuous'].includes(settings.sceneMode) ? settings.sceneMode : 'ambient';
}

/** 把当前情景（可附带一次反应动画）发给桌宠；动画名来自设置（留空用默认） */
function sendScene(ctx, sceneId, once) {
  const fn = ctx.host && ctx.host.setPetActivity;
  if (typeof fn !== 'function') return;
  const settings = settingsOf(ctx);
  const mode = sceneId ? sceneMode(sceneId, settings) : 'quiet';
  const loop = sceneId && mode !== 'quiet' ? S.sceneAnims(sceneId, settings) : [];
  runtime.lastSentAt = Date.now();
  if (loop.length === 0 && !once) { fn(null); return; }
  fn({
    // id 带上动画列表与模式：改了场景动画或频率后，桌宠会立即生效
    id: sceneId ? `scene-${sceneId}:${mode}:${loop.join('|')}` : 'scene-event',
    loop,
    mode: mode === 'ambient' ? 'ambient' : 'loop',
    once: once || undefined,
    priority: SCENE_PRIORITY,
    ttl: SCENE_TTL
  });
}

function say(ctx, text) {
  const fn = ctx.host && ctx.host.showPetBubble;
  if (typeof fn === 'function') fn({ text, duration: 6000 });
}

/** 最近 AUDIO_HOLD_MS 内出过声的程序 */
function soundingNow(now) {
  const list = [];
  for (const [name, at] of runtime.audioHeard) {
    if (now - at <= AUDIO_HOLD_MS) list.push(name);
    else runtime.audioHeard.delete(name);
  }
  return list;
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
  const candidate = S.detectScene({ ...runtime.lastExternal, audio: soundingNow(now) }, idle, settings);

  if (candidate !== runtime.scene) {
    // 发呆 / 睡着由空闲时间本身判定，进出都立即生效；其余场景要稳定一段时间才切换，避免切窗口时抽风
    const immediate = ['sleep', 'drowsy'].includes(candidate) || ['sleep', 'drowsy'].includes(runtime.scene);
    if (runtime.pending !== candidate) {
      runtime.pending = candidate;
      runtime.pendingSince = now;
    }
    // 注意 0 是合法值（立即切换），不能用 || 兜底
    const switchSeconds = Number(settings.switchSeconds);
    const switchMs = Math.max(0, Number.isFinite(switchSeconds) ? switchSeconds : 30) * 1000;
    if (immediate || now - runtime.pendingSince >= switchMs) {
      const wokeUp = runtime.scene === 'sleep' && candidate !== 'sleep' && candidate !== 'drowsy';
      runtime.scene = candidate;
      runtime.sceneSince = now;
      runtime.milestonesFired = 0;
      runtime.pending = null;
      publishScene(ctx, settings);
      const wakeAnim = S.parseAnimList(settings.wakeAnim)[0] || S.DEFAULT_WAKE_ANIM;
      // 进入新场景时先播一次该场景的动画打个招呼（持续模式本来就在循环，不需要）
      let greet;
      if (wokeUp) greet = wakeAnim;
      else if (candidate && !CALM_SCENES.includes(candidate) && sceneMode(candidate, settings) !== 'continuous') {
        const anims = S.sceneAnims(candidate, settings);
        greet = anims[Math.floor(Math.random() * anims.length)];
      }
      sendScene(ctx, candidate, greet);
      if (wokeUp) say(ctx, '你回来啦！👋');
      return;
    }
  } else {
    runtime.pending = null;
  }

  if (runtime.scene && now - runtime.lastSentAt >= SCENE_HEARTBEAT) sendScene(ctx, runtime.scene);
  if (longSession(ctx, settings, now)) return;
  timeEvents(ctx, settings, idle, now);
}

/** 把当前场景发布到插件总线（只有场景名和开始时间，不含程序名和标题） */
function publishScene(ctx, settings) {
  if (!ctx.bus) return;
  ctx.bus.publish(TOPIC_SCENE, {
    scene: runtime.scene,
    label: S.sceneLabel(runtime.scene, settings),
    since: runtime.sceneSince
  });
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/**
 * 久坐提醒：同一个专注场景每持续 N 分钟提醒一次。
 * 先发到总线让 AI 对话用本地模型生成一句话；没有订阅者时用内置文案。
 * @returns {boolean} 本轮是否触发了提醒
 */
function longSession(ctx, settings, now) {
  const every = Math.max(0, Number(settings.longSessionMinutes) || 0);
  const scene = runtime.scene;
  if (!every || !scene || !(LONG_SESSION_SCENES.includes(scene) || scene.startsWith('custom:'))) return false;
  if (now - runtime.lastEventAt < EVENT_GAP) return false;
  const minutes = Math.floor((now - runtime.sceneSince) / 60000);
  const due = Math.floor(minutes / every);
  if (due <= runtime.milestonesFired) return false;

  runtime.milestonesFired = due;
  runtime.lastEventAt = now;
  const label = S.sceneLabel(scene, settings);
  const payload = { scene, label, minutes: due * every };
  const delivered = ctx.bus ? ctx.bus.publish(TOPIC_MILESTONE, payload) : 0;
  if (!delivered) say(ctx, `已经「${label}」${formatMinutes(payload.minutes)}了，起来活动一下、喝口水吧 🧘`);
  return true;
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
  runtime.watcherAudio = settings.backgroundMusic !== false;
  runtime.lastExternal = { process: '', title: '' };
  runtime.audioHeard.clear();
  runtime.error = '';
  runtime.watcher = startForegroundWatcher({
    intervalMs: SAMPLE_MS,
    titles: runtime.watcherTitles,
    audio: runtime.watcherAudio,
    onSample: (sample) => {
      // DeskPet 自己的窗口（设置 / 对话）在前台时，保持之前的判断
      if (!S.isSelf(sample.process)) runtime.lastExternal = { process: sample.process, title: sample.title };
      const now = Date.now();
      for (const name of sample.audio || []) runtime.audioHeard.set(name, now);
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
  runtime.sceneSince = 0;
  runtime.pending = null;
  if (ctx.bus) ctx.bus.publish(TOPIC_SCENE, { scene: null, label: '普通闲置', since: Date.now() });
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
  const scene = runtime.scene
    ? `${S.sceneLabel(runtime.scene, settings)}（${S.sceneAnims(runtime.scene, settings).join('、') || '无动画'}，已持续 ${formatMinutes(Math.floor((Date.now() - runtime.sceneSince) / 60000))}）`
    : '普通闲置';
  const parts = [
    `前台程序：${sample.process || '（未知）'}`,
    settings.readTitles ? `窗口标题：${sample.title || '（空）'}` : '窗口标题：未读取',
    settings.backgroundMusic !== false
      ? `正在出声：${soundingNow(Date.now()).join('、') || '无'}`
      : '后台音乐识别：关闭',
    `键鼠空闲：${idle} 秒`,
    `当前场景：${scene}`
  ];
  if (runtime.pending !== null && runtime.pending !== runtime.scene) {
    parts.push(`即将切换到：${S.sceneLabel(runtime.pending, settings)}`);
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
      // 改了当前场景的动画：立即生效
      if (runtime.scene) sendScene(ctx, runtime.scene);
      // 开关「读取窗口标题」「后台音乐识别」或从关闭恢复时重启探测
      if (!runtime.timer ||
          runtime.watcherTitles !== !!settings.readTitles ||
          runtime.watcherAudio !== (settings.backgroundMusic !== false)) startAll(ctx);
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
