/**
 * 奶记 · 首页聚合状态（/api/state 的响应体构造，v3）
 * 纯函数式：给定 store + 当前时间 + 时区偏移即可确定输出，便于单测。
 */

import { dayBounds } from './util/time.js';
import { createDayTotals, addEventToDayTotals } from './aggregate.js';

/**
 * @param {import('./db.js').Store} store
 * @param {number} nowMs
 * @param {number|null} tzOffsetMinutes  null 表示服务器本地时区
 */
export function buildState(store, nowMs, tzOffsetMinutes = null) {
  const { start, end, dateKey } = dayBounds(nowMs, tzOffsetMinutes);
  const today = createDayTotals(dateKey);
  for (const event of store.eventsBetween(start, end)) addEventToDayTotals(today, event);

  return {
    now: nowMs,
    lastFeeding: store.lastEvent('feed'),
    lastDiaper: store.lastEvent('diaper'),
    lastBath: store.lastEvent('bath'),
    today,
    recent: store.listEvents({ limit: 30 }),
  };
}
