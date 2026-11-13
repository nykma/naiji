/**
 * 奶记 · 首页聚合状态（/api/state 的响应体构造，v2）
 * 纯函数式：给定 store + 当前时间 + 时区偏移即可确定输出，便于单测。
 */

import { dayBounds } from './util/time.js';

/**
 * @param {import('./db.js').Store} store
 * @param {number} nowMs
 * @param {number|null} tzOffsetMinutes  null 表示服务器本地时区
 */
export function buildState(store, nowMs, tzOffsetMinutes = null) {
  const { start, end, dateKey } = dayBounds(nowMs, tzOffsetMinutes);
  const today = {
    date: dateKey,
    feedCount: 0,
    totalMl: 0,
    formulaCount: 0,
    breastMilkCount: 0,
    breastDirectCount: 0,
    mixedFeedCount: 0,
    diaperCount: 0,
    peeCount: 0,
    poopCount: 0,
    mixedCount: 0,
  };

  for (const event of store.eventsBetween(start, end)) {
    if (event.kind === 'feed') {
      today.feedCount += 1;
      if (event.amountMl !== null) today.totalMl += event.amountMl;
      const types = event.feedTypes ?? [];
      if (types.includes('formula')) today.formulaCount += 1;
      if (types.includes('breast_milk')) today.breastMilkCount += 1;
      if (types.includes('breast_direct')) today.breastDirectCount += 1;
      if (types.length > 1) today.mixedFeedCount += 1;
    } else if (event.kind === 'diaper') {
      today.diaperCount += 1;
      if (event.diaperKind === 'mixed') {
        today.mixedCount += 1;
        today.peeCount += 1;
        today.poopCount += 1;
      } else if (event.diaperKind === 'pee') {
        today.peeCount += 1;
      } else if (event.diaperKind === 'poop') {
        today.poopCount += 1;
      }
    }
  }

  return {
    now: nowMs,
    lastFeeding: store.lastEvent('feed'),
    lastDiaper: store.lastEvent('diaper'),
    today,
    recent: store.listEvents({ limit: 30 }),
  };
}
