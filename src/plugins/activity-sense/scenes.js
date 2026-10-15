/**
 * 场景判定（纯函数，不依赖 Electron，可单独测试）
 *
 * 输入：前台程序名 / 窗口标题（可选）/ 正在出声的程序名 / 键鼠空闲秒数 / 设置
 * 输出：场景 id（coding / study / music / video / game / drowsy / sleep）或 null（普通闲置）
 */

/** 场景 → 默认循环播放的动画（多个时按动画节奏轮换）；可在设置里用 <场景>Anims 覆盖 */
const SCENES = {
  coding: { label: '写代码', loop: ['写代码', '工作状态-忙碌点按'] },
  study: { label: '学习 / 文档', loop: ['轻快记录', '深度思考碎碎念'] },
  music: { label: '听音乐', loop: ['小提琴演奏', '悠闲哼歌'] },
  video: { label: '看视频', loop: ['撸猫', '悠闲哼歌'] },
  game: { label: '打游戏', loop: ['玩游戏气急败坏'] },
  drowsy: { label: '发呆', loop: ['哈欠连天'] },
  sleep: { label: '离开 / 睡着', loop: ['原地小憩沉眠'] }
};

/** 程序名列表的默认值（不区分大小写、不带 .exe） */
const DEFAULT_APPS = {
  coding: 'Code, Cursor, Windsurf, Trae, pycharm64, idea64, webstorm64, clion64, goland64, rider64, devenv, sublime_text, notepad++, zed, WindowsTerminal, powershell, pwsh, cmd, wsl, Xcode, Terminal, iTerm2',
  study: 'WINWORD, EXCEL, POWERPNT, wps, et, wpp, Acrobat, AcroRd32, SumatraPDF, Notion, Obsidian, ONENOTE, Typora, Zotero, Anki, Microsoft Word, Microsoft Excel, Microsoft PowerPoint, Preview',
  music: 'Spotify, cloudmusic, QQMusic, KuGou, kwmusic, foobar2000, AppleMusic, Music, 网易云音乐',
  video: 'PotPlayerMini64, PotPlayerMini, vlc, mpv, IINA, QuickTime Player',
  game: 'League of Legends, LeagueClient, YuanShen, GenshinImpact, StarRail, ZenlessZoneZero, cs2, dota2, VALORANT-Win64-Shipping, eldenring, Overwatch, Minecraft'
};

/** 浏览器程序名：开启「读取窗口标题」后，按标题关键词识别看视频 */
const BROWSERS = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', '360se', 'qqbrowser', 'Google Chrome', 'Safari', 'Arc'];
const DEFAULT_VIDEO_KEYWORDS = 'bilibili, 哔哩哔哩, YouTube, Netflix, 爱奇艺, 腾讯视频, 优酷, 抖音, Twitch, 斗鱼, 虎牙';

/** 回来时（从睡着醒来）的默认反应动画 */
const DEFAULT_WAKE_ANIM = '打瞌睡被惊醒';

/** 「a, b\nc.webm」→ ['a', 'b', 'c']（保留大小写，去掉 .webm），用于动画名 */
function parseAnimList(text) {
  return String(text || '')
    .split(/[,，\n]/)
    .map((s) => s.trim().replace(/\.webm$/i, ''))
    .filter(Boolean);
}

/**
 * 自定义规则（设置里的表格，JSON 字符串）→ [{ name, apps, keywords, anims }]
 * 没填名字或程序名 / 关键词都没填的规则会被忽略
 */
function parseRules(text) {
  let rows = text;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows || '[]'); } catch (e) { rows = []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    name: String((row && row.name) || '').trim(),
    apps: parseList(row && row.apps),
    keywords: parseList(row && row.keywords),
    anims: parseAnimList(row && row.anims)
  })).filter((rule) => rule.name && (rule.apps.length || rule.keywords.length));
}

/** custom:<序号> → 对应的自定义规则 */
function customRuleOf(sceneId, settings) {
  const m = /^custom:(\d+)$/.exec(String(sceneId || ''));
  return m ? parseRules(settings && settings.customRules)[Number(m[1])] || null : null;
}

/** 场景的显示名 */
function sceneLabel(sceneId, settings) {
  const rule = customRuleOf(sceneId, settings);
  if (rule) return rule.name;
  return SCENES[sceneId] ? SCENES[sceneId].label : '普通闲置';
}

/** 某个场景实际使用的动画：设置里填了就用设置的，留空用默认 */
function sceneAnims(sceneId, settings) {
  const rule = customRuleOf(sceneId, settings);
  if (rule) return rule.anims;
  const custom = parseAnimList(settings && settings[`${sceneId}Anims`]);
  if (custom.length > 0) return custom;
  return SCENES[sceneId] ? SCENES[sceneId].loop : [];
}

/** 「a, b\nc」→ ['a', 'b', 'c']（小写） */
function parseList(text) {
  return String(text || '')
    .split(/[,，\n]/)
    .map((s) => s.trim().replace(/\.exe$/i, '').toLowerCase())
    .filter(Boolean);
}

/** DeskPet 自己的窗口（设置 / 对话）在前台时不改变场景 */
function isSelf(processName) {
  return /^(electron|deskpet)$/i.test(String(processName || ''));
}

/**
 * 判定场景
 * @param {{ process: string, title: string, audio?: string[] }} sample  audio：正在出声的程序名
 * @param {number} idleSeconds 键鼠空闲秒数
 * @param {Object} settings 插件设置
 * @returns {string|null}
 */
function detectScene(sample, idleSeconds, settings) {
  const awaySeconds = Math.max(60, (Number(settings.awayMinutes) || 5) * 60);
  const drowsySeconds = Math.min(120, awaySeconds / 2);
  const listOf = (key) => parseList(settings[`${key}Apps`] != null ? settings[`${key}Apps`] : DEFAULT_APPS[key]);

  // 后台在放音乐（音乐程序真的在出声）：前台是别的程序也算听音乐，并且不会「发呆打哈欠」
  const sounding = Array.isArray(sample && sample.audio) ? sample.audio.map((s) => String(s).toLowerCase()) : [];
  const musicPlaying = settings.backgroundMusic !== false && sounding.some((s) => listOf('music').includes(s));

  if (idleSeconds >= awaySeconds) return 'sleep';
  if (idleSeconds >= drowsySeconds && !musicPlaying) return 'drowsy';

  const name = String((sample && sample.process) || '').toLowerCase();
  const matches = (key) => !!name && listOf(key).includes(name);
  const title = String((sample && sample.title) || '').toLowerCase();

  // 自定义规则优先于内置场景（从上到下第一条命中的生效）；标题关键词只在开启读取标题后生效
  const rules = parseRules(settings.customRules);
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (name && rule.apps.includes(name)) return `custom:${i}`;
    if (settings.readTitles && title && rule.keywords.some((k) => title.includes(k))) return `custom:${i}`;
  }

  // 打游戏、看视频是「全神贯注」的场景，优先于后台音乐
  if (matches('game')) return 'game';
  if (matches('video')) return 'video';
  // 浏览器：只有用户开启了读取标题，才会按标题关键词判断是不是在看视频
  if (name && settings.readTitles && BROWSERS.some((b) => b.toLowerCase() === name)) {
    const keywords = parseList(settings.videoKeywords != null ? settings.videoKeywords : DEFAULT_VIDEO_KEYWORDS);
    if (title && keywords.some((k) => title.includes(k))) return 'video';
  }
  if (musicPlaying) return 'music';
  if (matches('coding')) return 'coding';
  if (matches('study')) return 'study';
  if (matches('music')) return 'music';
  return null;
}

// ============================================================================
// 时间与节日
// ============================================================================

/** 吃饭时间窗口（分钟数，含起不含止） */
const MEALS = [
  { id: 'breakfast', from: 7 * 60, to: 9 * 60, anim: '吃早餐', text: '早上好～记得吃早饭哦 🍳' },
  { id: 'lunch', from: 11 * 60 + 30, to: 13 * 60, anim: '吃午餐', text: '午饭时间到啦，去吃点好的吧 🍱' },
  { id: 'dinner', from: 17 * 60 + 30, to: 19 * 60 + 30, anim: '吃晚餐', text: '该吃晚饭啦，休息一下 🍜' }
];

/** 当前处于哪个吃饭窗口 */
function mealAt(date) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return MEALS.find((m) => minutes >= m.from && minutes < m.to) || null;
}

/** 是否深夜（23:00 ~ 05:00） */
function isLateNight(date) {
  const h = date.getHours();
  return h >= 23 || h < 5;
}

/** 农历节日的公历日期（月-日），按年份查表 */
const LUNAR_FESTIVALS = {
  2025: { spring: '01-29', midAutumn: '10-06' },
  2026: { spring: '02-17', midAutumn: '09-25' },
  2027: { spring: '02-06', midAutumn: '09-15' },
  2028: { spring: '01-26', midAutumn: '10-03' },
  2029: { spring: '02-13', midAutumn: '09-22' },
  2030: { spring: '02-03', midAutumn: '09-12' }
};

/** 今天是什么节日（没有返回 null） */
function festivalAt(date) {
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const lunar = LUNAR_FESTIVALS[date.getFullYear()] || {};
  if (md === lunar.spring) return { id: 'spring', anim: '放烟花', text: '新年快乐！🧧 恭喜发财～' };
  if (md === lunar.midAutumn) return { id: 'mid-autumn', anim: '中秋赏月吃月饼', text: '中秋快乐！🥮 记得吃月饼～' };
  if (md === '01-01') return { id: 'new-year', anim: '放烟花', text: '元旦快乐！🎆 新的一年也一起加油～' };
  if (md === '12-24' || md === '12-25') return { id: 'christmas', anim: '装点圣诞树', text: '圣诞快乐！🎄' };
  return null;
}

module.exports = {
  SCENES,
  DEFAULT_WAKE_ANIM,
  parseAnimList,
  parseRules,
  sceneLabel,
  sceneAnims,
  DEFAULT_APPS,
  DEFAULT_VIDEO_KEYWORDS,
  BROWSERS,
  parseList,
  isSelf,
  detectScene,
  MEALS,
  mealAt,
  isLateNight,
  festivalAt
};
