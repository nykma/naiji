/**
 * 奶记 CLI · 格式化与纯展示函数
 *
 * 与 `web/lib/format.js`（docs/CONTRACT.md §6.3）行为保持一致；
 * 只依赖运行环境的本地时区，不依赖 DOM / fetch / process。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 喂奶类型规范顺序：formula → breast_milk → breast_direct */
export const FEED_TYPE_ORDER = ['formula', 'breast_milk', 'breast_direct'];

export const FEED_TYPE_LABELS = {
  formula: '奶粉',
  breast_milk: '母乳（瓶喂）',
  breast_direct: '亲喂',
};

export const DIAPER_KIND_LABELS = {
  pee: '小便',
  poop: '大便',
  mixed: '大小便',
};

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 时长 → 中文文案（与 v1/web 一致）：
 * < 1 分钟 → 刚刚；< 1 小时 → N 分钟；< 24 小时 → H 小时 M 分钟（M 为 0 时省略）；
 * ≥ 24 小时 → D 天 H 小时（H 为 0 时省略）。负数 / 非数字视为 0。
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

/**
 * 紧凑时间文案：今天 → HH:mm；昨天/前天 → "昨天 HH:mm"；更早 → "11月12日 HH:mm" /
 * 跨年 → "2025年11月12日 HH:mm"。
 */
export function formatTimeShort(ts, now = Date.now()) {
  const clock = formatClock(ts);
  const dayDiff = Math.round((localDayStart(now) - localDayStart(ts)) / DAY);
  if (dayDiff === 0) return clock;
  if (dayDiff === 1) return `昨天 ${clock}`;
  if (dayDiff === 2) return `前天 ${clock}`;
  const d = new Date(ts);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  if (!sameYear) return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

/** "2026-11-13" → "周五"；格式不符 → '' */
export function formatDateKeyWeekday(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) return '';
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return WEEKDAYS[d.getDay()];
}

/** 喂奶类型 → 中文 */
export function feedTypeLabel(feedType) {
  return FEED_TYPE_LABELS[feedType] ?? '喂奶';
}

/** 按规范顺序去重（只保留合法值） */
export function sortFeedTypes(types) {
  const set = new Set(Array.isArray(types) ? types : []);
  return FEED_TYPE_ORDER.filter((type) => set.has(type));
}

/** ["breast_direct","formula"] → "奶粉 + 亲喂"（规范顺序） */
export function feedTypesLabel(types) {
  return sortFeedTypes(types)
    .map((type) => feedTypeLabel(type))
    .join(' + ');
}

/** 大小便类型 → 中文 */
export function diaperKindLabel(diaperKind) {
  return DIAPER_KIND_LABELS[diaperKind] ?? '大小便';
}

/** 事件标题：喂奶 → "奶粉 + 母乳（瓶喂） 120 ml" / "亲喂"；大小便 → "小便"；洗澡 → "洗澡" */
export function eventTitle(event) {
  if (!event) return '';
  if (event.kind === 'feed') {
    const types = Array.isArray(event.feedTypes)
      ? event.feedTypes
      : event.feedType
        ? [event.feedType]
        : [];
    const label = feedTypesLabel(types) || '喂奶';
    const amount = formatAmount(event.amountMl);
    return amount ? `${label} ${amount}` : label;
  }
  if (event.kind === 'bath') return '洗澡';
  return diaperKindLabel(event.diaperKind);
}

/** 事件图标：含 formula → 🍼；否则含 breast_milk → 🥛；否则 🤱；大小便 💧/💩/🚼；洗澡 🛁 */
export function eventIcon(event) {
  if (!event) return '';
  if (event.kind === 'feed') {
    const types = Array.isArray(event.feedTypes)
      ? event.feedTypes
      : event.feedType
        ? [event.feedType]
        : [];
    if (types.includes('formula')) return '🍼';
    if (types.includes('breast_milk')) return '🥛';
    return '🤱';
  }
  if (event.kind === 'bath') return '🛁';
  if (event.diaperKind === 'pee') return '💧';
  if (event.diaperKind === 'poop') return '💩';
  return '🚼';
}

/**
 * 今日汇总行（status / today 共用）：
 * 「今日 喂奶 N 次 · 奶量 M ml · 亲喂 K 次 · 小便 X · 大便 Y · 洗澡 Z 次」
 */
export function formatTodaySummary(today = {}) {
  const feedCount = Number(today?.feedCount ?? 0);
  const totalMl = Number(today?.totalMl ?? 0);
  const breastDirectCount = Number(today?.breastDirectCount ?? 0);
  const peeCount = Number(today?.peeCount ?? 0);
  const poopCount = Number(today?.poopCount ?? 0);
  const bathCount = Number(today?.bathCount ?? 0);
  return `今日 喂奶 ${feedCount} 次 · 奶量 ${totalMl} ml · 亲喂 ${breastDirectCount} 次 · 小便 ${peeCount} · 大便 ${poopCount} · 洗澡 ${bathCount} 次`;
}

/** 字节数 → 可读文案 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
