/**
 * 奶记 · 前端交互（ES Module，无第三方依赖）
 *
 * 设计要点：
 * - 所有事件用 addEventListener 绑定（CSP 禁止内联脚本）。
 * - Hero「距离上次喂奶」用本地 Date.now() 与 lastFeeding.happenedAt 计算，每秒刷新。
 * - 记录成功后先用 POST 返回的 event 就地更新（Hero 立即变「刚刚」），
 *   删除后用 /api/state 校准 lastFeeding / today，避免本地推算误差。
 * - 请求进行中禁用所有记录按钮，防止连点重复记录。
 */

import {
  formatDuration,
  formatClock,
  formatDayKey,
  formatDayLabel,
  feedTypeLabel,
  eventTitle,
  eventIcon,
} from '/lib/format.js';

const FEED_TYPES = ['formula', 'breast_milk', 'breast_direct'];
const FEED_TYPE_STORAGE_KEY = 'naiji.feedType';
const RECENT_LIMIT = 30;
const PAGE_SIZE = 50;
const MIN_AMOUNT_ML = 1;
const MAX_AMOUNT_ML = 2000;
const CLOCK_TICK_MS = 1000;
const TOAST_UNDO_MS = 5000;
const TOAST_ERROR_MS = 4200;
const TOAST_PLAIN_MS = 3000;

/* --------------------------------------------------------------------------
   状态
   -------------------------------------------------------------------------- */

const state = {
  loaded: false,
  loading: false,
  error: null,
  lastFeeding: null,
  lastDiaper: null,
  today: null,
  events: [], // 已加载的事件，happenedAt DESC, id DESC
  hasMore: false,
  feedType: readStoredFeedType(),
  loadingMore: false,
  deletingIds: new Set(),
  rolloverChecking: false,
};

let writeInFlight = 0;
let newEventId = null;
let toastHideTimer = null;

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
  amountPanel: document.getElementById('amountPanel'),
  amountHint: document.getElementById('amountHint'),
  directPanel: document.getElementById('directPanel'),
  chips: [...document.querySelectorAll('.chip')],
  customForm: document.getElementById('customForm'),
  customInput: byTestId('custom-amount-input'),
  breastDirectBtn: byTestId('record-breast-direct'),
  peeBtn: byTestId('record-pee'),
  poopBtn: byTestId('record-poop'),
  todaySummary: byTestId('today-summary'),
  history: byTestId('history-list'),
  historyCount: document.getElementById('historyCount'),
  emptyState: byTestId('empty-state'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMore: byTestId('load-more'),
  errorBanner: byTestId('load-error'),
  errorText: document.getElementById('loadErrorText'),
  retryBtn: byTestId('retry-load'),
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

function currentDateKey() {
  return state.today && typeof state.today.date === 'string' ? state.today.date : formatDayKey(Date.now());
}

function readStoredFeedType() {
  try {
    const stored = localStorage.getItem(FEED_TYPE_STORAGE_KEY);
    if (FEED_TYPES.includes(stored)) return stored;
  } catch {
    /* localStorage 不可用时静默降级 */
  }
  return 'formula';
}

class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError('网络连接失败，请检查服务是否正常运行');
  }
  let payload = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload.message === 'string' && payload.message
        ? payload.message
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message);
  }
  return payload;
}

function stateUrl() {
  return `/api/state?tzOffset=${new Date().getTimezoneOffset()}`;
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
    if (event.feedType === 'formula') today.formulaMl = (today.formulaMl ?? 0) + (event.amountMl ?? 0);
    else if (event.feedType === 'breast_milk') today.breastMl = (today.breastMl ?? 0) + (event.amountMl ?? 0);
    else if (event.feedType === 'breast_direct') today.breastDirectCount = (today.breastDirectCount ?? 0) + 1;
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
  }
  today.totalMl = (today.formulaMl ?? 0) + (today.breastMl ?? 0);
}

function applyTodayRemove(event) {
  const today = state.today;
  if (!today || !event) return;
  if (formatDayKey(event.happenedAt) !== currentDateKey()) return;

  if (event.kind === 'feed') {
    today.feedCount = Math.max(0, (today.feedCount ?? 0) - 1);
    if (event.feedType === 'formula') today.formulaMl = Math.max(0, (today.formulaMl ?? 0) - (event.amountMl ?? 0));
    else if (event.feedType === 'breast_milk') today.breastMl = Math.max(0, (today.breastMl ?? 0) - (event.amountMl ?? 0));
    else if (event.feedType === 'breast_direct') {
      today.breastDirectCount = Math.max(0, (today.breastDirectCount ?? 0) - 1);
    }
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
  }
  today.totalMl = (today.formulaMl ?? 0) + (today.breastMl ?? 0);
}

/* --------------------------------------------------------------------------
   渲染
   -------------------------------------------------------------------------- */

function renderAll() {
  renderHero();
  renderSummary();
  renderTimeline();
  renderErrorBanner();
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

  let diaperText;
  if (state.lastDiaper) {
    diaperText = `距上次换尿布 ${formatDuration(now - state.lastDiaper.happenedAt)}`;
  } else if (state.error) {
    diaperText = '大小便记录暂时无法加载';
  } else if (state.loaded) {
    diaperText = '还没有大小便记录';
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
    fragment.append(` · ${eventTitle(state.lastFeeding)}`);
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

  const parts = [
    ['喂奶 ', today.feedCount ?? 0, ' 次'],
    ['奶量 ', today.totalMl ?? 0, ' ml'],
    ['亲喂 ', today.breastDirectCount ?? 0, ' 次'],
    ['小便 ', today.peeCount ?? 0, ''],
    ['大便 ', today.poopCount ?? 0, ''],
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

function renderEventItem(event) {
  const item = makeEl('li', 'event');
  item.dataset.eventId = String(event.id);
  if (newEventId === event.id) item.classList.add('is-new');

  const icon = makeEl('span', 'event-icon', eventIcon(event));
  icon.dataset.tone =
    event.kind === 'feed' ? 'feed' : event.diaperKind === 'pee' ? 'pee' : event.diaperKind === 'poop' ? 'poop' : 'mixed';
  icon.setAttribute('aria-hidden', 'true');

  const body = makeEl('div', 'event-body');
  const top = makeEl('div', 'event-top');
  top.append(makeEl('p', 'event-title', eventTitle(event)));
  top.append(makeEl('span', 'event-time', formatClock(event.happenedAt)));
  body.append(top);
  if (event.note) body.append(makeEl('p', 'event-note', event.note));

  const remove = makeEl('button', 'event-delete', '×');
  remove.type = 'button';
  remove.title = '删除这条记录';
  remove.setAttribute('aria-label', `删除 ${formatClock(event.happenedAt)} 的${eventTitle(event)}记录`);
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
  state.today = data.today ?? null;

  const recent = Array.isArray(data.recent) ? data.recent : [];
  state.events = mergeEvents(recent, state.events);
  if (!state.loaded) state.hasMore = recent.length >= RECENT_LIMIT;
}

async function loadState({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
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

function handleEventCreated(event) {
  insertEventSorted(event);

  if (event.kind === 'feed') {
    if (!state.lastFeeding || compareEventsDesc(event, state.lastFeeding) < 0) state.lastFeeding = event;
  } else if (event.kind === 'diaper') {
    if (!state.lastDiaper || compareEventsDesc(event, state.lastDiaper) < 0) state.lastDiaper = event;
  }

  applyTodayAdd(event);
  newEventId = event.id;
  renderAll();
  if (!state.loaded) void loadState();
}

function handleEventRemoved(event) {
  const index = state.events.findIndex((item) => item.id === event.id);
  if (index !== -1) state.events.splice(index, 1);
  applyTodayRemove(event);

  if (state.lastFeeding && state.lastFeeding.id === event.id) state.lastFeeding = findLatestOfKind('feed');
  if (state.lastDiaper && state.lastDiaper.id === event.id) state.lastDiaper = findLatestOfKind('diaper');

  renderAll();
}

async function createFeeding(feedType, amountMl = null) {
  if (!FEED_TYPES.includes(feedType) || writeInFlight > 0) return;
  lockWrites();
  try {
    const payload = { feedType };
    if (feedType !== 'breast_direct') payload.amountMl = amountMl;
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

async function createDiaper(diaperKind) {
  if (writeInFlight > 0) return;
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

async function undoCreatedEvent(event) {
  const removed = await deleteEventById(event.id);
  if (removed) showToast(`已撤销「${eventTitle(event)}」`, { duration: 1800 });
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
    // 用服务端状态校准 lastFeeding / lastDiaper / today（删除最后一条记录时本地无法准确推算）
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

function setFeedType(feedType, { persist = true } = {}) {
  const next = FEED_TYPES.includes(feedType) ? feedType : 'formula';
  state.feedType = next;
  if (persist) {
    try {
      localStorage.setItem(FEED_TYPE_STORAGE_KEY, next);
    } catch {
      /* 忽略隐私模式下的存储失败 */
    }
  }
  for (const button of els.typeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.feedType === next));
  }
  const isDirect = next === 'breast_direct';
  els.amountPanel.hidden = isDirect;
  els.directPanel.hidden = !isDirect;
  if (els.amountHint) els.amountHint.textContent = isDirect ? '' : ` · ${feedTypeLabel(next)}`;
  if (!isDirect && els.customInput.value.trim() === '') els.customInput.value = '120';
}

function handleCustomAmountSubmit(domEvent) {
  domEvent.preventDefault();
  if (writeInFlight > 0 || state.feedType === 'breast_direct') return;

  const raw = els.customInput.value.trim();
  const amount = Number(raw);
  if (!/^\d{1,4}$/.test(raw) || !Number.isInteger(amount) || amount < MIN_AMOUNT_ML || amount > MAX_AMOUNT_ML) {
    showToast(`奶量必须是 ${MIN_AMOUNT_ML} 到 ${MAX_AMOUNT_ML} 之间的整数（毫升）`, { type: 'error' });
    els.customInput.focus();
    return;
  }
  void createFeeding(state.feedType, amount);
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
    if (removed) showToast('已删除这条记录', { duration: 1800 });
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
   初始化
   -------------------------------------------------------------------------- */

function bindEvents() {
  for (const button of els.typeButtons) {
    button.addEventListener('click', () => setFeedType(button.dataset.feedType));
  }

  for (const chip of els.chips) {
    chip.addEventListener('click', () => {
      if (state.feedType === 'breast_direct') return;
      const amount = Number(chip.dataset.amount);
      if (Number.isInteger(amount)) void createFeeding(state.feedType, amount);
    });
  }

  els.customForm.addEventListener('submit', handleCustomAmountSubmit);
  els.breastDirectBtn.addEventListener('click', () => void createFeeding('breast_direct'));
  els.peeBtn.addEventListener('click', () => void createDiaper('pee'));
  els.poopBtn.addEventListener('click', () => void createDiaper('poop'));
  els.loadMore.addEventListener('click', () => void loadMore());
  els.retryBtn.addEventListener('click', () => {
    if (!state.loading) void loadState();
  });
  els.history.addEventListener('click', handleHistoryClick);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderHeroClocks();
  });

  window.setInterval(renderHeroClocks, CLOCK_TICK_MS);
}

function init() {
  setFeedType(state.feedType, { persist: false });
  bindEvents();
  syncRecordButtons();
  renderAll();
  void loadState();
}

init();
