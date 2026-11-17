/**
 * 奶记 · 趋势统计（最近 N 天，按天聚合）
 * 纯函数：给定 store + now + tzOffset 即可确定输出，便于单测。
 *
 * 返回按日期升序的每日数据（最后一天是今天），没有记录的日子补 0，
 * 方便前端画连续的折线图 / CLI 输出。
 *
 * 注意：日期窗口必须按「日历天」逐天回退，不能简单用 now - i*24h——
 * 服务器本地时区遇到夏令时切换时 24h 硬减会跳天/重复（如 America/New_York 3 月）。
 */

import { dayBounds, isValidTzOffset } from './util/time.js';
import { createDayTotals, addEventToDayTotals } from './aggregate.js';

const DAY_MS = 86_400_000;

export const DEFAULT_STATS_DAYS = 7;
export const MIN_STATS_DAYS = 1;
export const MAX_STATS_DAYS = 90;

/** 按日历天回退，返回第 offset 天前的 [start, end, dateKey] */
function dayBoundsBefore(nowMs, offset, tzOffsetMinutes) {
  if (tzOffsetMinutes === null || tzOffsetMinutes === undefined) {
    // 服务器本地时区：用本地 Date 的日历运算（自动处理 DST）
    const today = new Date(nowMs);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset + 1);
    const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
    const dateKey = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
    return { start: start.getTime(), end: end.getTime(), dateKey };
  }

  // 固定 tzOffset：没有 DST，但同样按 UTC 日历天回退，避免月末/跨月误差
  const offsetMs = tzOffsetMinutes * 60_000;
  const shifted = new Date(nowMs - offsetMs);
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
  const startUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - offset);
  const endUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - offset + 1);
  const startDay = new Date(startUtc);
  const dateKey = `${startDay.getUTCFullYear()}-${pad2(startDay.getUTCMonth() + 1)}-${pad2(startDay.getUTCDate())}`;
  return { start: startUtc + offsetMs, end: endUtc + offsetMs, dateKey };
}

/**
 * @param {import('./db.js').Store} store
 * @param {number} nowMs
 * @param {number} days 1..90
 * @param {number|null} tzOffsetMinutes null 表示服务器本地时区
 * @returns {{ days: number, startDate: string, endDate: string, daily: ReturnType<typeof createDayTotals>[] }}
 */
export function buildDailyStats(store, nowMs, days = DEFAULT_STATS_DAYS, tzOffsetMinutes = null) {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('nowMs 必须是有限数字（epoch 毫秒）');
  }
  if (tzOffsetMinutes !== null && tzOffsetMinutes !== undefined && !isValidTzOffset(tzOffsetMinutes)) {
    throw new RangeError('tzOffset 必须是 -840 到 840 之间的整数（分钟）');
  }
  if (!Number.isInteger(days) || days < MIN_STATS_DAYS || days > MAX_STATS_DAYS) {
    throw new RangeError(`days 必须是 ${MIN_STATS_DAYS}..${MAX_STATS_DAYS} 的整数`);
  }

  const daily = [];
  // 从最早的一天到「今天」，保证升序且连续（中间没有记录的日子补 0）
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const { start, end, dateKey } = dayBoundsBefore(nowMs, offset, tzOffsetMinutes);
    const totals = createDayTotals(dateKey);
    for (const event of store.eventsBetween(start, end)) addEventToDayTotals(totals, event);
    daily.push(totals);
  }

  return {
    days,
    startDate: daily[0].date,
    endDate: daily[daily.length - 1].date,
    daily,
  };
}

// 保留导出：其它模块若需要「今天」边界可直接复用（与 state 一致）
export { dayBounds };
