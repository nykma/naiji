/**
 * 奶记 · 共享格式化工具（纯函数，v3）
 *
 * 浏览器（web/index.html 经 app.js import）与 Node 测试（test/*.test.js）共用。
 * 约定：所有时间戳为 epoch 毫秒；日期/时钟展示一律使用**运行环境的本地时区**。
 * 本文件不要依赖 DOM、fetch、process 等环境 API。
 *
 * v2 变更：喂奶类型由单值改为多标签数组（feedTypes），并新增 feedTypesLabel()。
 * v3 变更：新增洗澡事件（kind === 'bath'）的标题与图标。
 * 规范顺序：formula → breast_milk → breast_direct。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 喂奶类型（规范顺序） */
export const FEED_TYPES = ['formula', 'breast_milk', 'breast_direct'];

const FEED_TYPE_LABELS = {
  formula: '奶粉',
  breast_milk: '母乳（瓶喂）',
  breast_direct: '亲喂',
};

const DIAPER_KIND_LABELS = {
  pee: '小便',
  poop: '大便',
  mixed: '大小便',
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 时长 → 中文文案。
 * < 1 分钟 → 刚刚；< 1 小时 → N 分钟；< 24 小时 → H 小时 M 分钟（M 为 0 时省略）；
 * ≥ 24 小时 → D 天 H 小时（H 为 0 时省略）。负数 / NaN 视为 0。
 */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (total < MINUTE) return '刚刚';
  if (total < HOUR) return `${Math.floor(total / MINUTE)} 分钟`;
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
  }
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`;
}

/** epoch ms → 本地 HH:mm */
export function formatClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 奶量 → "120 ml"；空值 → '' */
export function formatAmount(ml) {
  if (ml === null || ml === undefined || !Number.isFinite(Number(ml))) return '';
  return `${Number(ml)} ml`;
}

/** epoch ms → 本地 YYYY-MM-DD */
export function formatDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localDayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 日期分组标题：今天 / 昨天 / 前天 / 11月12日 周三 / 2025年11月12日
 */
export function formatDayLabel(ts, now = Date.now()) {
  const dayDiff = Math.round((localDayStart(now) - localDayStart(ts)) / DAY);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  if (dayDiff === 2) return '前天';
  const d = new Date(ts);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (!sameYear) return `${d.getFullYear()}年${md}`;
  return `${md} ${WEEKDAYS[d.getDay()]}`;
}

/** 喂奶类型 → 中文 */
export function feedTypeLabel(feedType) {
  return FEED_TYPE_LABELS[feedType] ?? '喂奶';
}

/** 按规范顺序排列、去重并丢弃非法值；非数组 → [] */
export function sortFeedTypes(types) {
  const set = new Set(Array.isArray(types) ? types.filter((type) => FEED_TYPES.includes(type)) : []);
  return FEED_TYPES.filter((type) => set.has(type));
}

/**
 * 多标签喂奶类型 → 中文文案，按规范顺序用 " + " 连接。
 * 例：['breast_milk','formula'] → "奶粉 + 母乳（瓶喂）"；空数组 → ''。
 */
export function feedTypesLabel(types) {
  return sortFeedTypes(types)
    .map((type) => feedTypeLabel(type))
    .join(' + ');
}

/** 大小便类型 → 中文 */
export function diaperKindLabel(diaperKind) {
  return DIAPER_KIND_LABELS[diaperKind] ?? '大小便';
}

/**
 * 从事件中取规范化的 feedTypes（兼容 v1 单值字段 feedType，便于共享纯函数鲁棒）。
 */
function eventFeedTypes(event) {
  if (Array.isArray(event.feedTypes)) return event.feedTypes;
  if (typeof event.feedType === 'string') return [event.feedType];
  return [];
}

/**
 * 事件标题：
 * - 喂奶有奶量 → "奶粉 + 母乳（瓶喂） 120 ml"
 * - 喂奶无奶量 → 标签文案（"亲喂"）
 * - 大小便 → 小便 / 大便 / 大小便
 * - 洗澡 → 洗澡（v3）
 */
export function eventTitle(event) {
  if (!event) return '';
  if (event.kind === 'feed') {
    const label = feedTypesLabel(eventFeedTypes(event));
    const amount = formatAmount(event.amountMl);
    if (amount) return label ? `${label} ${amount}` : amount;
    return label || '喂奶';
  }
  if (event.kind === 'bath') return '洗澡';
  return diaperKindLabel(event.diaperKind);
}

/**
 * 事件图标 emoji：含 formula → 🍼；否则含 breast_milk → 🥛；否则 🤱；
 * 大小便同 v1；洗澡 → 🛁（v3）。
 */
export function eventIcon(event) {
  if (!event) return '';
  if (event.kind === 'feed') {
    const types = eventFeedTypes(event);
    if (types.includes('formula')) return '🍼';
    if (types.includes('breast_milk')) return '🥛';
    return '🤱';
  }
  if (event.kind === 'bath') return '🛁';
  if (event.diaperKind === 'pee') return '💧';
  if (event.diaperKind === 'poop') return '💩';
  return '🚼';
}
