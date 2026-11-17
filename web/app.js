/**
 * 奶记 · 前端交互（ES Module，无第三方依赖，v3）
 *
 * 设计要点：
 * - 所有事件用 addEventListener 绑定（CSP 禁止内联脚本）。
 * - 所有 HTTP 请求 / 导出链接都经由 lib/api.js 的 apiUrl()，支持前后端分离部署。
 * - 喂奶类型为**多选标签**（至少一个，规范顺序 formula → breast_milk → breast_direct）：
 *   选中的标签持久化到 localStorage['naiji.feedTypes']；含奶粉/母乳时显示奶量面板，
 *   点一下奶量即 POST { feedTypes, amountMl } 记录一条；仅亲喂时显示「亲喂一次」按钮。
 * - 洗澡（v3）：一键 POST /api/baths，与大小便一样进时间线/今日汇总，并重置「距上次换尿布/洗澡」。
 * - Hero「距离上次喂奶」用本地 Date.now() 与 lastFeeding.happenedAt 计算，每秒刷新。
 * - 趋势（v3）：GET /api/stats 按天聚合，手绘内联 SVG 折线图（无第三方库 / 无 canvas），
 *   7 天 / 30 天切换按范围缓存，指标切换不发请求；SSE 数据变更后若趋势卡可见则静默重拉。
 * - 记录成功后先用 POST 返回的 event 就地更新（Hero 立即变「刚刚」），
 *   删除后用 /api/state 校准 lastFeeding / lastDiaper / lastBath / today，避免本地推算误差。
 * - 请求进行中禁用所有记录按钮，防止连点重复记录。
 */

import {
  FEED_TYPES,
  formatDuration,
  formatAmount,
  formatClock,
  formatDayKey,
  formatDayLabel,
  feedTypesLabel,
  sortFeedTypes,
  eventTitle,
  eventIcon,
} from '/lib/format.js';
import { apiUrl, request, stateUrl, ApiError } from '/lib/api.js';

const FEED_TYPES_STORAGE_KEY = 'naiji.feedTypes';
const LEGACY_FEED_TYPE_STORAGE_KEY = 'naiji.feedType';
const RECENT_LIMIT = 30;
const PAGE_SIZE = 50;
const MIN_AMOUNT_ML = 1;
const MAX_AMOUNT_ML = 2000;
const CLOCK_TICK_MS = 1000;
const TOAST_UNDO_MS = 5000;
const TOAST_ERROR_MS = 4200;
const TOAST_PLAIN_MS = 3000;
const TOAST_SHORT_MS = 1800;
// 趋势卡：范围、指标、SSE 变更后的静默重拉（节流 ~1s）
const STATS_DAYS_OPTIONS = [7, 30];
const STATS_DEFAULT_DAYS = 7;
const STATS_REFRESH_THROTTLE_MS = 1000;
const STATS_MIN_RELOAD_GAP_MS = 700;
const STATS_METRICS = [
  { key: 'totalMl', label: '奶量', unit: 'ml' },
  { key: 'feedCount', label: '喂奶次数', unit: '次' },
  { key: 'breastDirectCount', label: '亲喂', unit: '次' },
  { key: 'peeCount', label: '小便', unit: '次' },
  { key: 'poopCount', label: '大便', unit: '次' },
  { key: 'bathCount', label: '洗澡', unit: '次' },
];
const STATS_METRICS_BY_KEY = Object.fromEntries(STATS_METRICS.map((metric) => [metric.key, metric]));
// 浏览器标签标题：有上次喂奶时显示「距上次 X 小时 X 分钟 · 奶记」，方便瞥一眼
const BASE_TITLE = '奶记 · 婴儿喂养记录';
const TITLE_NAME = '奶记';

/* --------------------------------------------------------------------------
   状态
   -------------------------------------------------------------------------- */

const state = {
  loaded: false,
  loading: false,
  refreshing: false,
  error: null,
  lastFeeding: null,
  lastDiaper: null,
  lastBath: null,
  today: null,
  events: [], // 已加载的事件，happenedAt DESC, id DESC
  hasMore: false,
  feedTypes: readStoredFeedTypes(), // 规范顺序、至少一个
  loadingMore: false,
  deletingIds: new Set(),
  rolloverChecking: false,
};

/** 趋势卡状态：按范围缓存 daily，指标切换只重绘不重新请求 */
const statsState = {
  range: STATS_DEFAULT_DAYS,
  metric: 'totalMl',
  cache: new Map(), // days -> daily[]
  staleRanges: new Set(), // 数据变更后待重拉的范围
  visible: false,
  loading: false,
  loadingRange: null,
  requestSeq: 0,
  lastFetchAt: 0,
  lastError: null,
  refreshTimer: null,
  pendingRefresh: false,
  renderedWidth: 0,
};

let writeInFlight = 0;
let newEventId = null;
let toastHideTimer = null;
let eventStream = null;
let sseEverConnected = false;
let fallbackPollTimer = null;

/* --------------------------------------------------------------------------
   DOM
   -------------------------------------------------------------------------- */

function byTestId(testId) {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!node) console.error(`[奶记] 缺少 data-testid="${testId}" 的元素`);
  return node;
}

const els = {
  hero: document.querySelector('.hero'),
  gapDuration: byTestId('gap-duration'),
  gapLastFeed: byTestId('gap-last-feed'),
  gapLastDiaper: byTestId('gap-last-diaper'),
  typeButtons: [...document.querySelectorAll('.seg-btn')],
  amountPanel: byTestId('amount-panel'),
  amountHint: byTestId('amount-hint'),
  bottleTip: byTestId('bottle-tip'),
  directPanel: byTestId('direct-panel'),
  chips: [...document.querySelectorAll('.chip')],
  customForm: document.getElementById('customForm'),
  customInput: byTestId('custom-amount-input'),
  breastDirectBtn: byTestId('record-breast-direct'),
  peeBtn: byTestId('record-pee'),
  poopBtn: byTestId('record-poop'),
  bathBtn: byTestId('record-bath'),
  todaySummary: byTestId('today-summary'),
  statsCard: byTestId('stats-card'),
  statsChart: byTestId('stats-chart'),
  statsSummary: byTestId('stats-summary'),
  statsRangeButtons: [...document.querySelectorAll('.stats-range-btn')],
  statsMetricButtons: [...document.querySelectorAll('.stats-metric')],
  history: byTestId('history-list'),
  historyCount: document.getElementById('historyCount'),
  emptyState: byTestId('empty-state'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMore: byTestId('load-more'),
  errorBanner: byTestId('load-error'),
  errorText: document.getElementById('loadErrorText'),
  retryBtn: byTestId('retry-load'),
  refreshBtn: byTestId('refresh'),
  exportLink: byTestId('export-csv'),
  toastRoot: document.getElementById('toastRoot'),
  recordButtons: [...document.querySelectorAll('.record-btn')],
};

/* --------------------------------------------------------------------------
   小工具
   -------------------------------------------------------------------------- */

function makeEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 更新浏览器标签标题（相同则跳过，避免每秒无意义写入） */
function setDocumentTitle(title) {
  if (document.title !== title) document.title = title;
}

/**
 * 标签标题文案：
 * - 有上次喂奶且 ≥ 1 分钟：「距上次 3 小时 25 分钟 · 奶记」
 * - 不到 1 分钟：「刚刚喂过 · 奶记」
 * - 还没有记录 / 未加载：默认标题
 */
function documentTitleFor(lastFeeding, now) {
  if (!lastFeeding) return BASE_TITLE;
  const gapMs = Math.max(0, now - lastFeeding.happenedAt);
  if (gapMs < 60_000) return `刚刚喂过 · ${TITLE_NAME}`;
  return `距上次 ${formatDuration(gapMs)} · ${TITLE_NAME}`;
}

function compareEventsDesc(a, b) {
  return b.happenedAt - a.happenedAt || b.id - a.id;
}

function mergeEvents(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const event of list) {
      if (!event || typeof event.id !== 'number' || seen.has(event.id)) continue;
      seen.add(event.id);
      merged.push(event);
    }
  }
  merged.sort(compareEventsDesc);
  return merged;
}

function insertEventSorted(event) {
  const index = state.events.findIndex((item) => compareEventsDesc(event, item) < 0);
  if (index === -1) state.events.push(event);
  else state.events.splice(index, 0, event);
}

function findLatestOfKind(kind) {
  for (const event of state.events) {
    if (event.kind === kind) return event;
  }
  return null;
}

/**
 * 「距上次换尿布/洗澡」取 lastDiaper 与 lastBath 中发生时间较晚者（洗澡也视为一次清洁）。
 * @returns {object|null}
 */
function latestCleaningEvent(lastDiaper, lastBath) {
  if (!lastDiaper) return lastBath ?? null;
  if (!lastBath) return lastDiaper;
  return lastDiaper.happenedAt >= lastBath.happenedAt ? lastDiaper : lastBath;
}

function currentDateKey() {
  return state.today && typeof state.today.date === 'string' ? state.today.date : formatDayKey(Date.now());
}

/** 选中集合是否含瓶喂标签（奶粉 / 母乳·瓶喂）→ 需要奶量 */
function hasBottleType(types) {
  return types.includes('formula') || types.includes('breast_milk');
}

function eventFeedTypes(event) {
  if (Array.isArray(event.feedTypes)) return event.feedTypes;
  if (typeof event.feedType === 'string') return [event.feedType];
  return [];
}

function readStoredFeedTypes() {
  try {
    const raw = localStorage.getItem(FEED_TYPES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const types = sortFeedTypes(Array.isArray(parsed) ? parsed : []);
      if (types.length > 0) return types;
    }
    // v1 迁移：旧的单值 'naiji.feedType'
    const legacy = localStorage.getItem(LEGACY_FEED_TYPE_STORAGE_KEY);
    if (FEED_TYPES.includes(legacy)) return [legacy];
  } catch {
    /* localStorage 不可用时静默降级为默认值 */
  }
  return ['formula'];
}

function persistFeedTypes() {
  try {
    localStorage.setItem(FEED_TYPES_STORAGE_KEY, JSON.stringify(state.feedTypes));
    localStorage.removeItem(LEGACY_FEED_TYPE_STORAGE_KEY);
  } catch {
    /* 忽略隐私模式下的存储失败 */
  }
}

/* --------------------------------------------------------------------------
   写入锁：任何一次增删进行中，禁用所有记录 / 删除按钮
   -------------------------------------------------------------------------- */

function syncDeleteButtons() {
  for (const button of els.history.querySelectorAll('.event-delete')) {
    const item = button.closest('.event');
    const id = item ? Number(item.dataset.eventId) : NaN;
    button.disabled = writeInFlight > 0 || state.deletingIds.has(id);
  }
}

function syncRecordButtons() {
  const disabled = writeInFlight > 0 || !state.loaded;
  for (const button of els.recordButtons) button.disabled = disabled;
  document.body.classList.toggle('is-busy', writeInFlight > 0);
  syncDeleteButtons();
  syncRefreshButton();
}

function lockWrites() {
  writeInFlight += 1;
  syncRecordButtons();
}

function unlockWrites() {
  writeInFlight = Math.max(0, writeInFlight - 1);
  syncRecordButtons();
}

/* --------------------------------------------------------------------------
   今日汇总的本地增量（记录后立即反映，删除后由服务端状态校准）
   -------------------------------------------------------------------------- */

function applyTodayAdd(event) {
  const today = state.today;
  if (!today || !event) return;
  if (formatDayKey(event.happenedAt) !== currentDateKey()) return;

  if (event.kind === 'feed') {
    today.feedCount = (today.feedCount ?? 0) + 1;
    if (event.amountMl !== null && event.amountMl !== undefined) {
      today.totalMl = (today.totalMl ?? 0) + event.amountMl;
    }
    const types = eventFeedTypes(event);
    if (types.includes('formula')) today.formulaCount = (today.formulaCount ?? 0) + 1;
    if (types.includes('breast_milk')) today.breastMilkCount = (today.breastMilkCount ?? 0) + 1;
    if (types.includes('breast_direct')) today.breastDirectCount = (today.breastDirectCount ?? 0) + 1;
    if (types.length > 1) today.mixedFeedCount = (today.mixedFeedCount ?? 0) + 1;
  } else if (event.kind === 'diaper') {
    today.diaperCount = (today.diaperCount ?? 0) + 1;
    if (event.diaperKind === 'mixed') {
      today.mixedCount = (today.mixedCount ?? 0) + 1;
      today.peeCount = (today.peeCount ?? 0) + 1;
      today.poopCount = (today.poopCount ?? 0) + 1;
    } else if (event.diaperKind === 'pee') {
      today.peeCount = (today.peeCount ?? 0) + 1;
    } else if (event.diaperKind === 'poop') {
      today.poopCount = (today.poopCount ?? 0) + 1;
    }
  } else if (event.kind === 'bath') {
    today.bathCount = (today.bathCount ?? 0) + 1;
  }
}

function applyTodayRemove(event) {
  const today = state.today;
  if (!today || !event) return;
  if (formatDayKey(event.happenedAt) !== currentDateKey()) return;

  if (event.kind === 'feed') {
    today.feedCount = Math.max(0, (today.feedCount ?? 0) - 1);
    if (event.amountMl !== null && event.amountMl !== undefined) {
      today.totalMl = Math.max(0, (today.totalMl ?? 0) - event.amountMl);
    }
    const types = eventFeedTypes(event);
    if (types.includes('formula')) today.formulaCount = Math.max(0, (today.formulaCount ?? 0) - 1);
    if (types.includes('breast_milk')) today.breastMilkCount = Math.max(0, (today.breastMilkCount ?? 0) - 1);
    if (types.includes('breast_direct')) today.breastDirectCount = Math.max(0, (today.breastDirectCount ?? 0) - 1);
    if (types.length > 1) today.mixedFeedCount = Math.max(0, (today.mixedFeedCount ?? 0) - 1);
  } else if (event.kind === 'diaper') {
    today.diaperCount = Math.max(0, (today.diaperCount ?? 0) - 1);
    if (event.diaperKind === 'mixed') {
      today.mixedCount = Math.max(0, (today.mixedCount ?? 0) - 1);
      today.peeCount = Math.max(0, (today.peeCount ?? 0) - 1);
      today.poopCount = Math.max(0, (today.poopCount ?? 0) - 1);
    } else if (event.diaperKind === 'pee') {
      today.peeCount = Math.max(0, (today.peeCount ?? 0) - 1);
    } else if (event.diaperKind === 'poop') {
      today.poopCount = Math.max(0, (today.poopCount ?? 0) - 1);
    }
  } else if (event.kind === 'bath') {
    today.bathCount = Math.max(0, (today.bathCount ?? 0) - 1);
  }
}

/* --------------------------------------------------------------------------
   喂奶类型多选
   -------------------------------------------------------------------------- */

function renderFeedTypes() {
  const types = state.feedTypes;
  for (const button of els.typeButtons) {
    button.setAttribute('aria-pressed', String(types.includes(button.dataset.feedType)));
  }

  const bottle = hasBottleType(types);
  // 奶量面板：选中集合含 formula / breast_milk 时显示
  els.amountPanel.hidden = !bottle;
  // 亲喂按钮：只有「仅亲喂」时才显示
  els.directPanel.hidden = bottle;
  els.amountHint.textContent = bottle ? ` · ${feedTypesLabel(types)}` : '';
  // 亲喂 + 瓶喂组合时提示奶量含义
  els.bottleTip.hidden = !(bottle && types.includes('breast_direct'));

  if (bottle && els.customInput.value.trim() === '') els.customInput.value = '120';
}

function toggleFeedType(feedType) {
  if (!FEED_TYPES.includes(feedType)) return;
  const selected = state.feedTypes.includes(feedType);
  if (selected && state.feedTypes.length === 1) {
    // 至少保留一个类型：再点唯一选中项时保持选中，只做轻微提示动画
    const button = els.typeButtons.find((item) => item.dataset.feedType === feedType);
    if (button) {
      button.classList.remove('is-nudge');
      void button.offsetWidth; // 重启动画
      button.classList.add('is-nudge');
    }
    showToast('至少要保留一种喂奶类型', { type: 'plain', duration: 1600 });
    return;
  }
  const next = selected ? state.feedTypes.filter((type) => type !== feedType) : [...state.feedTypes, feedType];
  state.feedTypes = sortFeedTypes(next);
  if (state.feedTypes.length === 0) state.feedTypes = ['formula'];
  persistFeedTypes();
  renderFeedTypes();
}

/* --------------------------------------------------------------------------
   渲染
   -------------------------------------------------------------------------- */

function renderAll() {
  renderHero();
  renderSummary();
  renderTimeline();
  renderErrorBanner();
  renderFeedTypes();
}

function renderHeroClocks() {
  const now = Date.now();

  if (state.lastFeeding) {
    const durationText = formatDuration(now - state.lastFeeding.happenedAt);
    if (els.gapDuration.textContent !== durationText) els.gapDuration.textContent = durationText;
    els.gapDuration.classList.remove('is-empty');
  } else {
    const emptyText = state.loaded ? '还没开始' : '—';
    if (els.gapDuration.textContent !== emptyText) els.gapDuration.textContent = emptyText;
    els.gapDuration.classList.add('is-empty');
  }

  // 浏览器标签标题同步显示「距上次 X 小时 X 分钟」，切到别的标签时也能瞥一眼
  setDocumentTitle(documentTitleFor(state.lastFeeding, now));

  // 第三行：换尿布/洗澡（洗澡也视为一次清洁，取 lastDiaper / lastBath 较晚者）
  const lastCleaning = latestCleaningEvent(state.lastDiaper, state.lastBath);
  let diaperText;
  if (lastCleaning) {
    diaperText = `距上次换尿布/洗澡 ${formatDuration(now - lastCleaning.happenedAt)}`;
  } else if (state.error) {
    diaperText = '换尿布/洗澡记录暂时无法加载';
  } else if (state.loaded) {
    diaperText = '还没有换尿布/洗澡记录';
  } else {
    diaperText = '正在加载…';
  }
  if (els.gapLastDiaper.textContent !== diaperText) els.gapLastDiaper.textContent = diaperText;

  checkDayRollover(now);
}

function renderHero() {
  if (state.lastFeeding) {
    const fragment = document.createDocumentFragment();
    fragment.append('上次 ');
    fragment.append(makeEl('span', 'hero-last-clock', formatClock(state.lastFeeding.happenedAt)));
    fragment.append(' · ');
    // 奶量整体 nowrap：窄屏（320px）换行时不要把「120 ml」拆成两行
    const title = eventTitle(state.lastFeeding);
    const amountMatch = /^(.*?)(\s\d+(?:\.\d+)?\s?ml)$/.exec(title);
    if (amountMatch) {
      fragment.append(amountMatch[1]);
      fragment.append(makeEl('span', 'hero-last-amount', amountMatch[2]));
    } else {
      fragment.append(title);
    }
    els.gapLastFeed.replaceChildren(fragment);
  } else if (state.error) {
    els.gapLastFeed.textContent = '加载失败，请点上方「重试」';
  } else if (state.loaded) {
    els.gapLastFeed.textContent = '还没有喂奶记录';
  } else {
    els.gapLastFeed.textContent = '正在加载…';
  }
  els.hero.classList.toggle('is-error', Boolean(state.error) && !state.lastFeeding);
  renderHeroClocks();
}

function renderSummary() {
  const today = state.today;
  if (!today) {
    els.todaySummary.className = 'summary-line summary-loading';
    els.todaySummary.textContent = state.error ? '暂时无法获取今日汇总' : '正在加载…';
    return;
  }

  // v3 汇总：喂奶 N 次 · 奶量 M ml · 亲喂 K 次 · 小便 X · 大便 Y · 洗澡 Z 次
  const parts = [
    ['喂奶 ', today.feedCount ?? 0, ' 次'],
    ['奶量 ', today.totalMl ?? 0, ' ml'],
    ['亲喂 ', today.breastDirectCount ?? 0, ' 次'],
    ['小便 ', today.peeCount ?? 0, ''],
    ['大便 ', today.poopCount ?? 0, ''],
    ['洗澡 ', today.bathCount ?? 0, ' 次'],
  ];

  const fragment = document.createDocumentFragment();
  parts.forEach(([label, value, suffix], index) => {
    const stat = makeEl('span', 'summary-stat');
    stat.append(label);
    stat.append(makeEl('b', null, String(value)));
    stat.append(suffix);
    if (index < parts.length - 1) stat.append(' · ');
    fragment.append(stat);
  });

  els.todaySummary.className = 'summary-line';
  els.todaySummary.replaceChildren(fragment);
}

function groupEventsByDay(events) {
  const groups = [];
  let current = null;
  for (const event of events) {
    const key = formatDayKey(event.happenedAt);
    if (!current || current.key !== key) {
      current = { key, label: formatDayLabel(event.happenedAt), events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

/**
 * 时间线标题：奶量部分整体不换行（避免「120 ml」被拆成两行只剩 "ml"），
 * DOM textContent 与 eventTitle(event) 完全一致（tests/QA 依赖）。
 */
function buildEventTitle(event) {
  const title = makeEl('p', 'event-title');
  if (event && event.kind === 'feed') {
    const label = feedTypesLabel(eventFeedTypes(event));
    const amount = formatAmount(event.amountMl);
    if (label && amount) {
      title.append(makeEl('span', 'event-title-label', label));
      title.append(' ');
      title.append(makeEl('span', 'event-title-amount', amount));
      return title;
    }
  }
  title.textContent = eventTitle(event);
  return title;
}

function renderEventItem(event) {
  const item = makeEl('li', 'event');
  item.dataset.eventId = String(event.id);
  if (newEventId === event.id) item.classList.add('is-new');

  const icon = makeEl('span', 'event-icon', eventIcon(event));
  icon.dataset.tone =
    event.kind === 'feed'
      ? 'feed'
      : event.kind === 'bath'
        ? 'bath'
        : event.diaperKind === 'pee'
          ? 'pee'
          : event.diaperKind === 'poop'
            ? 'poop'
            : 'mixed';
  icon.setAttribute('aria-hidden', 'true');

  const body = makeEl('div', 'event-body');
  const top = makeEl('div', 'event-top');
  top.append(buildEventTitle(event));
  top.append(makeEl('span', 'event-time', formatClock(event.happenedAt)));
  body.append(top);
  if (event.note) body.append(makeEl('p', 'event-note', event.note));

  const remove = makeEl('button', 'event-delete', '×');
  remove.type = 'button';
  remove.title = '删除这条记录';
  remove.setAttribute('aria-label', `删除 ${formatClock(event.happenedAt)} 的记录：${eventTitle(event)}`);
  remove.disabled = writeInFlight > 0 || state.deletingIds.has(event.id);

  item.append(icon, body, remove);
  return item;
}

function renderTimeline() {
  if (!state.loaded) {
    if (state.error) els.history.replaceChildren(makeEl('p', 'loading-note', '记录加载失败'));
    els.emptyState.hidden = true;
    els.loadMoreWrap.hidden = true;
    els.historyCount.textContent = '';
    return;
  }

  const events = state.events;
  els.historyCount.textContent = events.length > 0 ? `已显示 ${events.length} 条` : '';

  if (events.length === 0) {
    els.history.replaceChildren();
    els.emptyState.hidden = false;
    els.loadMoreWrap.hidden = true;
    return;
  }

  els.emptyState.hidden = true;

  const fragment = document.createDocumentFragment();
  for (const group of groupEventsByDay(events)) {
    const section = makeEl('section', 'day-group');
    section.setAttribute('aria-label', group.label);

    const head = makeEl('div', 'day-head');
    head.append(makeEl('h3', 'day-label', group.label));
    head.append(makeEl('span', 'day-line'));
    head.append(makeEl('span', 'day-count', `${group.events.length} 条`));
    section.append(head);

    const list = makeEl('ul', 'day-list');
    for (const event of group.events) list.append(renderEventItem(event));
    section.append(list);

    fragment.append(section);
  }

  els.history.replaceChildren(fragment);
  newEventId = null;
  els.loadMoreWrap.hidden = !state.hasMore;
}

function renderErrorBanner() {
  els.errorBanner.hidden = !state.error;
  els.errorText.textContent = state.error ? `加载失败：${state.error}` : '';
  if (state.loading) {
    els.retryBtn.disabled = true;
    els.retryBtn.textContent = '重试中…';
  } else {
    els.retryBtn.disabled = false;
    els.retryBtn.textContent = '重试';
  }
}

/* --------------------------------------------------------------------------
   数据加载
   -------------------------------------------------------------------------- */

function applyServerState(data) {
  if (!data || typeof data !== 'object') throw new ApiError('服务返回的数据格式不正确');
  state.lastFeeding = data.lastFeeding ?? null;
  state.lastDiaper = data.lastDiaper ?? null;
  state.lastBath = data.lastBath ?? null;
  state.today = data.today ?? null;

  const recent = Array.isArray(data.recent) ? data.recent : [];
  state.events = mergeEvents(recent, state.events);
  if (!state.loaded) state.hasMore = recent.length >= RECENT_LIMIT;
}

async function loadState({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  syncRefreshButton();
  if (!silent) {
    state.error = null;
    renderErrorBanner();
  }

  try {
    const data = await request(stateUrl());
    applyServerState(data);
    state.error = null;
    state.loaded = true;
  } catch (error) {
    console.error('[奶记] 加载失败:', error);
    if (!silent) state.error = error.message;
  } finally {
    state.loading = false;
    state.loaded = state.loaded || Boolean(state.today);
    syncRecordButtons();
    renderAll();
  }
}

async function refreshStateQuietly() {
  try {
    const data = await request(stateUrl());
    applyServerState(data);
    state.error = null;
    state.loaded = true;
    invalidateStats();
    return true;
  } catch (error) {
    console.warn('[奶记] 后台校准失败:', error);
    return false;
  } finally {
    syncRecordButtons();
    renderAll();
  }
}

function checkDayRollover(now) {
  if (!state.loaded || state.loading || state.rolloverChecking || writeInFlight > 0) return;
  if (!state.today || formatDayKey(now) === state.today.date) return;
  state.rolloverChecking = true;
  refreshStateQuietly().finally(() => {
    state.rolloverChecking = false;
  });
}

/* --------------------------------------------------------------------------
   刷新 / 多端实时同步（SSE，降级轮询）
   -------------------------------------------------------------------------- */

const SSE_PATH = '/api/events/stream';
const FALLBACK_POLL_MS = 30_000;

function syncRefreshButton() {
  if (!els.refreshBtn) return;
  const busy = Boolean(state.refreshing) || state.loading || writeInFlight > 0;
  els.refreshBtn.disabled = busy;
  els.refreshBtn.classList.toggle('is-refreshing', Boolean(state.refreshing));
  els.refreshBtn.setAttribute('aria-busy', String(Boolean(state.refreshing)));
}

/** 手动刷新：以服务端为准重置时间线（回到最新一页）与聚合状态 */
function applyServerStateFresh(data) {
  if (!data || typeof data !== 'object') throw new ApiError('服务返回的数据格式不正确');
  state.lastFeeding = data.lastFeeding ?? null;
  state.lastDiaper = data.lastDiaper ?? null;
  state.lastBath = data.lastBath ?? null;
  state.today = data.today ?? null;
  const recent = Array.isArray(data.recent) ? data.recent : [];
  state.events = recent;
  state.hasMore = recent.length >= RECENT_LIMIT;
  state.loaded = true;
  state.error = null;
}

/**
 * 主动向服务端拉一次最新状态。
 * @param {{ silent?: boolean }} [options] silent=true 时不弹 toast（自动刷新用）
 */
async function refreshNow({ silent = false } = {}) {
  if (state.refreshing || state.loading || writeInFlight > 0) return false;
  state.refreshing = true;
  syncRefreshButton();
  try {
    const data = await request(stateUrl());
    applyServerStateFresh(data);
    invalidateStats();
    renderAll();
    if (!silent) showToast('已刷新最新数据', { duration: TOAST_SHORT_MS });
    return true;
  } catch (error) {
    console.error('[奶记] 刷新失败:', error);
    if (!silent) showToast(error.message, { type: 'error' });
    return false;
  } finally {
    state.refreshing = false;
    syncRefreshButton();
  }
}

/** 处理服务端推送的变更（其他设备/浏览器记录或删除） */
function handleRealtimeChange(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'delete') {
    const target = state.events.find((event) => event.id === payload.id);
    if (target) handleEventRemoved(target);
    return;
  }

  const event = payload.event;
  if (!event || !Number.isInteger(event.id)) return;
  // 自己刚记录时本地已经应用过，跳过 SSE 回声
  if (state.events.some((item) => item.id === event.id)) return;

  handleEventCreated(event);
  // 撤销 toast 还在时不要打断（不然会顶掉「撤销」按钮）
  const currentToast = els.toastRoot.firstElementChild;
  const undoVisible = Boolean(currentToast && currentToast.classList.contains('toast--undo'));
  if (!undoVisible) showToast(`已同步 ${eventTitle(event)}`, { duration: TOAST_SHORT_MS });
}

function startFallbackPolling() {
  if (fallbackPollTimer) return;
  console.warn('[奶记] 当前浏览器不支持 EventSource，降级为每 30 秒轮询');
  fallbackPollTimer = window.setInterval(() => {
    if (!document.hidden && writeInFlight === 0) void refreshNow({ silent: true });
  }, FALLBACK_POLL_MS);
}

function connectEventStream() {
  if (typeof EventSource !== 'function') {
    startFallbackPolling();
    return;
  }
  try {
    eventStream = new EventSource(apiUrl(SSE_PATH));
  } catch (error) {
    console.warn('[奶记] 无法建立实时连接，降级为轮询:', error);
    startFallbackPolling();
    return;
  }

  eventStream.addEventListener('change', (domEvent) => {
    let payload = null;
    try {
      payload = JSON.parse(domEvent.data);
    } catch {
      return;
    }
    handleRealtimeChange(payload);
  });

  eventStream.addEventListener('open', () => {
    // 首次连接不需要额外请求；断线重连后以服务端为准校准一次，补上断线期间漏掉的变更
    if (sseEverConnected) void refreshNow({ silent: true });
    sseEverConnected = true;
  });

  eventStream.addEventListener('error', () => {
    // EventSource 会按服务端下发的 retry 自动重连，这里只记录日志
    console.warn('[奶记] 实时连接已断开，正在自动重连…');
  });
}

/* --------------------------------------------------------------------------
   Toast（撤销）
   -------------------------------------------------------------------------- */

function hideToast() {
  if (toastHideTimer) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  const toast = els.toastRoot.firstElementChild;
  if (!toast) return;
  toast.classList.add('toast--out');
  const node = toast;
  setTimeout(() => node.remove(), 190);
}

function showToast(message, { type = 'plain', undo = null, duration = null } = {}) {
  if (toastHideTimer) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  els.toastRoot.replaceChildren();

  const effectiveDuration = duration ?? (undo ? TOAST_UNDO_MS : type === 'error' ? TOAST_ERROR_MS : TOAST_PLAIN_MS);

  const toast = makeEl('div', 'toast');
  toast.dataset.testid = 'toast';
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.style.setProperty('--toast-ms', `${effectiveDuration}ms`);

  if (undo) {
    toast.classList.add('toast--undo');
  } else if (type === 'error') {
    toast.classList.add('toast--error');
    toast.append(makeEl('span', 'toast-emoji', '⚠️'));
  } else if (type === 'info') {
    toast.append(makeEl('span', 'toast-emoji', 'ℹ️'));
  }

  toast.append(makeEl('span', 'toast-message', message));

  if (typeof undo === 'function') {
    const undoButton = makeEl('button', 'toast-undo', '撤销');
    undoButton.type = 'button';
    undoButton.dataset.testid = 'toast-undo';
    undoButton.addEventListener('click', async () => {
      undoButton.disabled = true;
      hideToast();
      try {
        await undo();
      } catch (error) {
        console.error('[奶记] 撤销失败:', error);
      }
    });
    toast.append(undoButton);
  }

  els.toastRoot.append(toast);
  toastHideTimer = setTimeout(hideToast, effectiveDuration);
}

/* --------------------------------------------------------------------------
   记录 / 删除
   -------------------------------------------------------------------------- */

/**
 * 应用一条新记录（幂等：同一 id 只应用一次）。
 * 自己 POST 的响应与 SSE 回声谁先到谁应用，后到的一方直接跳过，
 * 避免今日汇总/时间线被重复计算。
 */
function handleEventCreated(event) {
  if (!event || !Number.isInteger(event.id)) return;
  if (state.events.some((item) => item.id === event.id)) return;

  insertEventSorted(event);

  if (event.kind === 'feed') {
    if (!state.lastFeeding || compareEventsDesc(event, state.lastFeeding) < 0) state.lastFeeding = event;
  } else if (event.kind === 'diaper') {
    if (!state.lastDiaper || compareEventsDesc(event, state.lastDiaper) < 0) state.lastDiaper = event;
  } else if (event.kind === 'bath') {
    if (!state.lastBath || compareEventsDesc(event, state.lastBath) < 0) state.lastBath = event;
  }

  applyTodayAdd(event);
  invalidateStats();
  newEventId = event.id;
  renderAll();
  if (!state.loaded) void loadState();
}

/**
 * 移除一条记录（幂等：本地已不存在则什么都不做）。
 * DELETE 响应与 SSE 删除回声同理，避免重复扣减今日汇总。
 */
function handleEventRemoved(event) {
  if (!event || !Number.isInteger(event.id)) return;
  const index = state.events.findIndex((item) => item.id === event.id);
  if (index === -1) return;
  state.events.splice(index, 1);
  applyTodayRemove(event);

  if (state.lastFeeding && state.lastFeeding.id === event.id) state.lastFeeding = findLatestOfKind('feed');
  if (state.lastDiaper && state.lastDiaper.id === event.id) state.lastDiaper = findLatestOfKind('diaper');
  if (state.lastBath && state.lastBath.id === event.id) state.lastBath = findLatestOfKind('bath');

  invalidateStats();
  renderAll();
}

/**
 * 记录一次喂奶：feedTypes = 当前全部选中标签；含奶粉/母乳时带 amountMl（总奶量）。
 * 仅亲喂时 amountMl 必须为 null（不带该字段）。
 */
async function recordFeeding(amountMl = null) {
  if (writeInFlight > 0 || !state.loaded) return;
  const types = [...state.feedTypes];
  if (types.length === 0) return;

  const needsAmount = hasBottleType(types);
  let amount = null;
  if (needsAmount) {
    if (!Number.isInteger(amountMl) || amountMl < MIN_AMOUNT_ML || amountMl > MAX_AMOUNT_ML) {
      showToast(`奶量必须是 ${MIN_AMOUNT_ML} 到 ${MAX_AMOUNT_ML} 之间的整数（毫升）`, { type: 'error' });
      return;
    }
    amount = amountMl;
  }

  lockWrites();
  try {
    const payload = { feedTypes: types };
    if (needsAmount) payload.amountMl = amount;
    const data = await request('/api/feedings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const event = data && data.event;
    if (!event) throw new ApiError('记录失败，请重试');
    handleEventCreated(event);
    showToast(`已记录 ${eventTitle(event)}`, { undo: () => undoCreatedEvent(event) });
  } catch (error) {
    console.error('[奶记] 记录喂奶失败:', error);
    showToast(error.message, { type: 'error' });
  } finally {
    unlockWrites();
    syncRecordButtons();
  }
}

async function recordDiaper(diaperKind) {
  if (writeInFlight > 0 || !state.loaded) return;
  lockWrites();
  try {
    const data = await request('/api/diapers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diaperKind }),
    });
    const event = data && data.event;
    if (!event) throw new ApiError('记录失败，请重试');
    handleEventCreated(event);
    showToast(`已记录 ${eventTitle(event)}`, { undo: () => undoCreatedEvent(event) });
  } catch (error) {
    console.error('[奶记] 记录大小便失败:', error);
    showToast(error.message, { type: 'error' });
  } finally {
    unlockWrites();
    syncRecordButtons();
  }
}

async function recordBath() {
  if (writeInFlight > 0 || !state.loaded) return;
  lockWrites();
  try {
    // 洗澡只有可选 happenedAt / note；这里记「现在」，body 用空对象即可
    const data = await request('/api/baths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const event = data && data.event;
    if (!event) throw new ApiError('记录失败，请重试');
    handleEventCreated(event);
    showToast(`已记录 ${eventTitle(event)}`, { undo: () => undoCreatedEvent(event) });
  } catch (error) {
    console.error('[奶记] 记录洗澡失败:', error);
    showToast(error.message, { type: 'error' });
  } finally {
    unlockWrites();
    syncRecordButtons();
  }
}

async function undoCreatedEvent(event) {
  const removed = await deleteEventById(event.id);
  if (removed) showToast(`已撤销「${eventTitle(event)}」`, { duration: TOAST_SHORT_MS });
  return removed;
}

async function deleteEventById(id) {
  if (state.deletingIds.has(id) || writeInFlight > 0) return false;
  const target = state.events.find((event) => event.id === id) ?? null;
  state.deletingIds.add(id);
  lockWrites();
  syncDeleteButtons();

  try {
    await request(`/api/events/${id}`, { method: 'DELETE' });
    if (target) handleEventRemoved(target);
    // 用服务端状态校准 lastFeeding / lastDiaper / lastBath / today（删除最后一条记录时本地无法准确推算）
    await refreshStateQuietly();
    return true;
  } catch (error) {
    console.error('[奶记] 删除失败:', error);
    showToast(error.message, { type: 'error' });
    return false;
  } finally {
    state.deletingIds.delete(id);
    unlockWrites();
    syncDeleteButtons();
  }
}

/* --------------------------------------------------------------------------
   交互
   -------------------------------------------------------------------------- */

function handleCustomAmountSubmit(domEvent) {
  domEvent.preventDefault();
  if (writeInFlight > 0) return;
  if (!hasBottleType(state.feedTypes)) return;

  const raw = els.customInput.value.trim();
  const amount = Number(raw);
  if (!/^\d{1,4}$/.test(raw) || !Number.isInteger(amount) || amount < MIN_AMOUNT_ML || amount > MAX_AMOUNT_ML) {
    showToast(`奶量必须是 ${MIN_AMOUNT_ML} 到 ${MAX_AMOUNT_ML} 之间的整数（毫升）`, { type: 'error' });
    els.customInput.focus();
    return;
  }
  void recordFeeding(amount);
}

function handleHistoryClick(domEvent) {
  const button = domEvent.target.closest('.event-delete');
  if (!button) return;
  const item = button.closest('.event');
  const id = item ? Number(item.dataset.eventId) : NaN;
  if (!Number.isInteger(id)) return;
  if (!window.confirm('确定删除这条记录吗？删除后无法恢复。')) return;
  void (async () => {
    const removed = await deleteEventById(id);
    if (removed) showToast('已删除这条记录', { duration: TOAST_SHORT_MS });
  })();
}

async function loadMore() {
  if (state.loadingMore || !state.hasMore || writeInFlight > 0) return;
  state.loadingMore = true;
  els.loadMore.disabled = true;
  els.loadMore.textContent = '正在加载…';

  try {
    const last = state.events[state.events.length - 1];
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (last) {
      params.set('before', String(last.happenedAt));
      params.set('beforeId', String(last.id));
    }
    const data = await request(`/api/events?${params.toString()}`);
    const page = data && Array.isArray(data.events) ? data.events : [];
    const previousCount = state.events.length;
    state.events = mergeEvents(state.events, page);
    state.hasMore = page.length >= PAGE_SIZE && state.events.length > previousCount;
  } catch (error) {
    console.error('[奶记] 加载更多失败:', error);
    showToast(error.message, { type: 'error' });
  } finally {
    state.loadingMore = false;
    els.loadMore.disabled = false;
    els.loadMore.textContent = '加载更多';
    renderTimeline();
  }
}

/* --------------------------------------------------------------------------
   趋势统计（v3）：GET /api/stats → 手绘内联 SVG 折线图（零依赖，无 canvas）
   -------------------------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Y 轴「好看的最大值」候选系数（1/1.5/2/2.5/3/4/5/6/8/10 × 10^n） */
const NICE_AXIS_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/** 30 天视图 X 轴每隔几天一个日期标签 */
const STATS_X_LABEL_EVERY = 5;

function statsUrl(days) {
  return `/api/stats?days=${days}&tzOffset=${new Date().getTimezoneOffset()}`;
}

function currentStatsMetric() {
  return STATS_METRICS_BY_KEY[statsState.metric] ?? STATS_METRICS[0];
}

function statsMetricUnit(metric) {
  return metric.unit === 'ml' ? 'ml' : '次';
}

/** 取某指标在 daily 里的数值序列（缺字段 / 非法值补 0） */
function statsValues(daily, metric) {
  return daily.map((item) => {
    const value = Number(item && item[metric.key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
}

function svgNode(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  if (text !== null) node.textContent = text;
  return node;
}

/** Y 轴最大值：全 0 时按 1（契约）；否则向上取整到较好看的刻度，保证 3 条网格线数值清爽 */
function niceAxisMax(rawMax, unit) {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const fraction = rawMax / magnitude;
  const step = NICE_AXIS_STEPS.find((candidate) => fraction <= candidate + 1e-9) ?? 10;
  let max = step * magnitude;
  if (unit !== 'ml') {
    // 次数轴：中线与刻度保持整数
    max = Math.max(2, Math.ceil(max / 2) * 2);
  }
  return max;
}

function formatAxisNumber(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatAverage(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 汇总行数据：「N 天合计 X · 日均 Y · 最高 M（MM-DD）」，单位随指标 */
function statsSummaryData(daily, days, metric) {
  const values = statsValues(daily, metric);
  const unit = statsMetricUnit(metric);
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const maxIndex = max > 0 ? values.indexOf(max) : values.length - 1;
  const maxDay = daily[maxIndex];
  return {
    unit,
    total,
    max,
    average: formatAverage(days > 0 ? total / days : 0),
    maxDate: maxDay && typeof maxDay.date === 'string' ? maxDay.date.slice(5) : '—',
  };
}

/** 汇总行渲染成若干 nowrap 片段，窄屏换行时不会把「540 ml（11-13）」拆散 */
function renderStatsSummary(daily, days, metric) {
  const data = statsSummaryData(daily, days, metric);
  const fragment = document.createDocumentFragment();
  fragment.append(makeEl('span', 'stats-summary-group', `${days} 天合计 ${data.total} ${data.unit}`));
  fragment.append(' · ');
  fragment.append(makeEl('span', 'stats-summary-group', `日均 ${data.average} ${data.unit}`));
  fragment.append(' · ');
  fragment.append(makeEl('span', 'stats-summary-group', `最高 ${data.max} ${data.unit}`));
  fragment.append(makeEl('span', 'stats-summary-date', `（${data.maxDate}）`));
  els.statsSummary.replaceChildren(fragment);
}

/**
 * 手绘折线图：折线 + 面积渐变 + 数据点；7 天标每个点的数值，30 天只标最高点；
 * X 轴 MM-DD（7 天全显示，30 天每 5 天一个）；Y 轴 3 条网格线 + 数值。
 */
function buildStatsChartSvg(daily, days, metric) {
  const containerWidth = Math.round(els.statsChart.clientWidth) || 280;
  const width = Math.max(236, containerWidth);
  const height = width <= 300 ? 146 : 164;
  const values = statsValues(daily, metric);
  const rawMax = values.length > 0 ? Math.max(...values) : 0;
  const yMax = niceAxisMax(rawMax, metric.unit);
  const margin = { top: 20, right: 12, bottom: 22, left: 34 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const baseY = margin.top + plotHeight;
  const pointCount = values.length;
  const xFor = (index) =>
    margin.left + (pointCount <= 1 ? plotWidth / 2 : (plotWidth * index) / (pointCount - 1));
  const yFor = (value) => margin.top + plotHeight * (1 - value / yMax);
  const xText = (value) => value.toFixed(2);
  const yText = (value) => value.toFixed(2);

  const svg = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'stats-svg',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  // 面积渐变（颜色走 CSS 变量，自动适配深色模式）
  const defs = svgNode('defs');
  const gradient = svgNode('linearGradient', { id: 'statsAreaGradient', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(svgNode('stop', { offset: '0%', class: 'stats-area-stop-start' }));
  gradient.append(svgNode('stop', { offset: '100%', class: 'stats-area-stop-end' }));
  defs.append(gradient);
  svg.append(defs);

  // 3 条网格线 + Y 轴数值
  for (const value of [yMax, yMax / 2, 0]) {
    const y = yFor(value);
    svg.append(
      svgNode('line', {
        x1: margin.left,
        y1: yText(y),
        x2: width - margin.right,
        y2: yText(y),
        class: value === 0 ? 'stats-grid-line stats-grid-line--base' : 'stats-grid-line',
      }),
    );
    svg.append(
      svgNode(
        'text',
        { x: margin.left - 7, y: yText(y + 3.2), 'text-anchor': 'end', class: 'stats-axis-label' },
        formatAxisNumber(value),
      ),
    );
  }

  if (pointCount > 0) {
    const lineSegments = values.map(
      (value, index) => `${index === 0 ? 'M' : 'L'} ${xText(xFor(index))} ${yText(yFor(value))}`,
    );
    const linePath = lineSegments.join(' ');
    const areaPath =
      `M ${xText(xFor(0))} ${yText(baseY)} ` +
      values.map((value, index) => `L ${xText(xFor(index))} ${yText(yFor(value))}`).join(' ') +
      ` L ${xText(xFor(pointCount - 1))} ${yText(baseY)} Z`;

    svg.append(svgNode('path', { d: areaPath, class: 'stats-area' }));
    svg.append(
      svgNode('path', { d: linePath, class: 'stats-line stats-line--draw', pathLength: '1', fill: 'none' }),
    );

    const maxIndex = rawMax > 0 ? values.indexOf(rawMax) : -1;
    const dotRadius = days > 7 ? 2.6 : 3.2;
    values.forEach((value, index) => {
      const x = xFor(index);
      const y = yFor(value);
      const isMax = index === maxIndex;
      svg.append(
        svgNode('circle', {
          cx: xText(x),
          cy: yText(y),
          r: isMax ? 4.2 : dotRadius,
          class: isMax ? 'stats-point stats-point--max' : 'stats-point',
        }),
      );
      // 7 天视图每个点标数值；30 天视图只标最高点
      if (days > 7 && !isMax) return;
      const anchor = index === 0 ? 'start' : index === pointCount - 1 ? 'end' : 'middle';
      svg.append(
        svgNode(
          'text',
          {
            x: xText(x),
            y: yText(y - 8),
            'text-anchor': anchor,
            class: isMax ? 'stats-value-label stats-value-label--max' : 'stats-value-label',
          },
          String(value),
        ),
      );
    });

    // X 轴日期标签：7 天全显示；30 天从今天往回每 5 天一个（保证今天有标签）
    daily.forEach((day, index) => {
      if (days > 7 && (pointCount - 1 - index) % STATS_X_LABEL_EVERY !== 0) return;
      svg.append(
        svgNode(
          'text',
          {
            x: xText(xFor(index)),
            y: height - 6,
            'text-anchor': 'middle',
            class: 'stats-axis-label stats-x-label',
          },
          typeof day.date === 'string' ? day.date.slice(5) : '',
        ),
      );
    });

    if (rawMax <= 0) {
      svg.append(
        svgNode(
          'text',
          {
            x: xText(margin.left + plotWidth / 2),
            y: yText(margin.top + plotHeight / 2 + 4),
            'text-anchor': 'middle',
            class: 'stats-empty-text',
          },
          `最近 ${days} 天还没有数据`,
        ),
      );
    }
  }

  return svg;
}

/** 占位：趋势还没有数据 / 正在加载 */
function renderStatsPlaceholder() {
  els.statsChart.replaceChildren(makeEl('p', 'stats-chart-note', '正在加载趋势…'));
  els.statsSummary.className = 'stats-summary stats-summary--muted';
  els.statsSummary.textContent = '正在加载趋势…';
}

function renderStatsControls() {
  for (const button of els.statsRangeButtons) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.range) === statsState.range));
  }
  for (const button of els.statsMetricButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.metric === statsState.metric));
  }
}

function renderStats() {
  renderStatsControls();
  const days = statsState.range;
  const metric = currentStatsMetric();
  els.statsChart.setAttribute('aria-label', `最近 ${days} 天${metric.label}趋势`);

  const daily = statsState.cache.get(days);
  if (!daily) {
    if (statsState.lastError) {
      const box = makeEl('div', 'stats-chart-empty');
      box.append(makeEl('p', 'stats-chart-note', '趋势数据暂时无法加载'));
      const retry = makeEl('button', 'stats-retry', '重新加载');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        statsState.lastError = null;
        renderStats();
        void fetchStats(statsState.range);
      });
      box.append(retry);
      els.statsChart.replaceChildren(box);
      els.statsSummary.className = 'stats-summary stats-summary--muted';
      els.statsSummary.textContent = '趋势数据暂时无法加载';
    } else {
      renderStatsPlaceholder();
    }
    return;
  }

  els.statsChart.replaceChildren(buildStatsChartSvg(daily, days, metric));
  statsState.renderedWidth = Math.round(els.statsChart.clientWidth);
  els.statsSummary.className = 'stats-summary';
  renderStatsSummary(daily, days, metric);
}

/** 拉取某个范围的按天聚合；切换指标不会触发请求，切换范围命中缓存也不会 */
async function fetchStats(days) {
  const seq = ++statsState.requestSeq;
  statsState.loading = true;
  statsState.loadingRange = days;
  if (!statsState.cache.has(days)) renderStats();
  try {
    const data = await request(statsUrl(days));
    if (seq !== statsState.requestSeq) return;
    const daily = data && Array.isArray(data.daily) ? data.daily : [];
    if (daily.length !== days) throw new ApiError('趋势数据格式不正确');
    statsState.cache.set(days, daily);
    statsState.staleRanges.delete(days);
    statsState.lastFetchAt = Date.now();
    statsState.lastError = null;
  } catch (error) {
    if (seq !== statsState.requestSeq) return;
    console.warn('[奶记] 趋势数据加载失败:', error);
    if (!statsState.cache.has(days)) statsState.lastError = error.message;
  } finally {
    if (seq === statsState.requestSeq) {
      statsState.loading = false;
      statsState.loadingRange = null;
      renderStats();
      if (statsState.pendingRefresh) {
        statsState.pendingRefresh = false;
        scheduleStatsRefresh();
      }
    }
  }
}

/** 数据变更后标记趋势数据过期；趋势卡在视口内才静默重拉（节流 ~1s） */
function invalidateStats() {
  for (const days of STATS_DAYS_OPTIONS) statsState.staleRanges.add(days);
  if (!statsState.visible) return;
  scheduleStatsRefresh();
}

function scheduleStatsRefresh() {
  if (statsState.refreshTimer) return;
  statsState.refreshTimer = window.setTimeout(() => {
    statsState.refreshTimer = null;
    if (!statsState.visible) return;
    const days = statsState.range;
    if (statsState.loading) {
      statsState.pendingRefresh = true;
      return;
    }
    if (!statsState.staleRanges.has(days) && statsState.cache.has(days)) return;
    // 刚拉取过就再等一拍，避免和首屏 / 上一次请求贴太近
    if (Date.now() - statsState.lastFetchAt < STATS_MIN_RELOAD_GAP_MS) {
      scheduleStatsRefresh();
      return;
    }
    void fetchStats(days);
  }, STATS_REFRESH_THROTTLE_MS);
}

/** 缓存缺失或已过期时才请求，避免重复拉取 */
function ensureStats(days) {
  if (statsState.cache.has(days) && !statsState.staleRanges.has(days)) return;
  if (statsState.loading && statsState.loadingRange === days) return;
  void fetchStats(days);
}

function selectStatsRange(days) {
  if (!STATS_DAYS_OPTIONS.includes(days) || days === statsState.range) return;
  statsState.range = days;
  statsState.lastError = null;
  renderStatsControls();
  const cached = statsState.cache.get(days);
  if (cached) renderStats();
  ensureStats(days);
}

function selectStatsMetric(key) {
  if (!STATS_METRICS_BY_KEY[key] || key === statsState.metric) return;
  statsState.metric = key;
  renderStatsControls();
  renderStats();
}

/** 趋势卡是否在视口内：决定 SSE 变更后是否静默重拉；首次可见时懒加载 */
function observeStatsVisibility() {
  if (!els.statsCard || typeof IntersectionObserver !== 'function') {
    statsState.visible = true;
    ensureStats(statsState.range);
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        statsState.visible = entry.isIntersecting;
        if (!entry.isIntersecting) continue;
        ensureStats(statsState.range);
      }
    },
    { rootMargin: '180px 0px' },
  );
  observer.observe(els.statsCard);
}

/** 容器宽度变化（旋转屏幕 / 桌面拉伸）时按新宽度重绘 SVG，保证文字不糊 */
function observeStatsChartSize() {
  if (!els.statsChart) return;
  const rerender = () => {
    const width = Math.round(els.statsChart.clientWidth);
    if (width === statsState.renderedWidth) return;
    if (!statsState.cache.has(statsState.range)) return;
    renderStats();
  };
  if (typeof ResizeObserver !== 'function') {
    window.addEventListener('resize', rerender);
    return;
  }
  const observer = new ResizeObserver(rerender);
  observer.observe(els.statsChart);
}

/* --------------------------------------------------------------------------
   初始化
   -------------------------------------------------------------------------- */

function bindEvents() {
  for (const button of els.typeButtons) {
    button.addEventListener('click', () => toggleFeedType(button.dataset.feedType));
  }

  for (const chip of els.chips) {
    chip.addEventListener('click', () => {
      if (!hasBottleType(state.feedTypes)) return;
      const amount = Number(chip.dataset.amount);
      if (Number.isInteger(amount)) void recordFeeding(amount);
    });
  }

  els.customForm.addEventListener('submit', handleCustomAmountSubmit);
  els.breastDirectBtn.addEventListener('click', () => void recordFeeding());
  els.peeBtn.addEventListener('click', () => void recordDiaper('pee'));
  els.poopBtn.addEventListener('click', () => void recordDiaper('poop'));
  els.bathBtn.addEventListener('click', () => void recordBath());
  for (const button of els.statsRangeButtons) {
    button.addEventListener('click', () => selectStatsRange(Number(button.dataset.range)));
  }
  for (const button of els.statsMetricButtons) {
    button.addEventListener('click', () => selectStatsMetric(button.dataset.metric));
  }
  els.loadMore.addEventListener('click', () => void loadMore());
  els.refreshBtn.addEventListener('click', () => void refreshNow());
  els.retryBtn.addEventListener('click', () => {
    if (!state.loading) void loadState();
  });
  els.history.addEventListener('click', handleHistoryClick);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    renderHeroClocks();
    // 回到页面时静默校准一次（多端场景：别人可能在你切走期间记录过）
    if (state.loaded && !state.loading && writeInFlight === 0) void refreshStateQuietly();
  });

  window.setInterval(renderHeroClocks, CLOCK_TICK_MS);
}

function init() {
  // 导出链接同样走 apiUrl()，前后端分离时指向 API 服务器
  if (els.exportLink) els.exportLink.href = apiUrl('/api/export.csv');

  renderFeedTypes();
  renderStatsControls();
  renderStats();
  bindEvents();
  observeStatsVisibility();
  observeStatsChartSize();
  ensureStats(statsState.range);
  syncRefreshButton();
  syncRecordButtons();
  renderAll();
  // 首屏数据到位后再建立实时连接，避免加载竞态
  void loadState().finally(() => connectEventStream());
}

init();
