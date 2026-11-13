import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEEKDAYS,
  diaperKindLabel,
  eventIcon,
  eventTitle,
  feedTypeLabel,
  feedTypesLabel,
  formatAmount,
  formatBytes,
  formatClock,
  formatDateKeyWeekday,
  formatDayKey,
  formatDayLabel,
  formatDuration,
  formatTimeShort,
  formatTodaySummary,
  sortFeedTypes,
} from '../src/format.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('formatDuration：分钟 / 小时 / 天', () => {
  assert.equal(formatDuration(0), '刚刚');
  assert.equal(formatDuration(30_000), '刚刚');
  assert.equal(formatDuration(MINUTE - 1), '刚刚');
  assert.equal(formatDuration(MINUTE), '1 分钟');
  assert.equal(formatDuration(59 * MINUTE), '59 分钟');
  assert.equal(formatDuration(HOUR), '1 小时');
  assert.equal(formatDuration(HOUR + 25 * MINUTE), '1 小时 25 分钟');
  assert.equal(formatDuration(DAY - 1), '23 小时 59 分钟');
  assert.equal(formatDuration(DAY), '1 天');
  assert.equal(formatDuration(DAY + HOUR), '1 天 1 小时');
  assert.equal(formatDuration(3 * DAY + 5 * HOUR), '3 天 5 小时');
});

test('formatDuration：负数 / 非数字按 0 处理', () => {
  assert.equal(formatDuration(-5000), '刚刚');
  assert.equal(formatDuration(Number.NaN), '刚刚');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '刚刚');
});

test('formatClock：本地 HH:mm', () => {
  const ts = new Date(2026, 0, 2, 9, 5, 0).getTime();
  assert.equal(formatClock(ts), '09:05');
  const late = new Date(2026, 0, 2, 23, 59, 0).getTime();
  assert.equal(formatClock(late), '23:59');
});

test('formatAmount', () => {
  assert.equal(formatAmount(120), '120 ml');
  assert.equal(formatAmount(0), '0 ml');
  assert.equal(formatAmount(null), '');
  assert.equal(formatAmount(undefined), '');
  assert.equal(formatAmount('90'), '90 ml');
});

test('formatDayKey：本地 YYYY-MM-DD', () => {
  assert.equal(formatDayKey(new Date(2026, 10, 13, 23, 30).getTime()), '2026-11-13');
  assert.equal(formatDayKey(new Date(2026, 0, 5, 0, 1).getTime()), '2026-01-05');
});

test('formatDayLabel：今天 / 昨天 / 前天 / 日期', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const day = (offsetDays) => new Date(2026, 0, 15 - offsetDays, 9, 0, 0).getTime();
  assert.equal(formatDayLabel(day(0), now), '今天');
  assert.equal(formatDayLabel(day(1), now), '昨天');
  assert.equal(formatDayLabel(day(2), now), '前天');
  const threeDaysAgo = new Date(2026, 0, 12, 9, 0, 0);
  assert.equal(
    formatDayLabel(threeDaysAgo.getTime(), now),
    `1月12日 ${WEEKDAYS[threeDaysAgo.getDay()]}`,
  );
  const lastYear = new Date(2025, 10, 20, 9, 0, 0);
  assert.equal(
    formatDayLabel(lastYear.getTime(), now),
    `2025年11月20日`,
  );
});

test('formatTimeShort：当天只给时间，跨天给日期', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
  assert.equal(formatTimeShort(new Date(2026, 0, 15, 9, 5).getTime(), now), '09:05');
  assert.equal(formatTimeShort(new Date(2026, 0, 14, 21, 30).getTime(), now), '昨天 21:30');
  assert.equal(formatTimeShort(new Date(2026, 0, 13, 8, 0).getTime(), now), '前天 08:00');
  assert.equal(formatTimeShort(new Date(2026, 0, 2, 8, 0).getTime(), now), '1月2日 08:00');
  assert.equal(formatTimeShort(new Date(2025, 11, 31, 8, 0).getTime(), now), '2025年12月31日 08:00');
});

test('formatDateKeyWeekday', () => {
  assert.equal(formatDateKeyWeekday('2026-11-13'), '周五');
  assert.equal(formatDateKeyWeekday('not-a-date'), '');
});

test('喂奶类型 / 大小便类型中文标签', () => {
  assert.equal(feedTypeLabel('formula'), '奶粉');
  assert.equal(feedTypeLabel('breast_milk'), '母乳（瓶喂）');
  assert.equal(feedTypeLabel('breast_direct'), '亲喂');
  assert.equal(feedTypeLabel('unknown'), '喂奶');
  assert.equal(diaperKindLabel('pee'), '小便');
  assert.equal(diaperKindLabel('poop'), '大便');
  assert.equal(diaperKindLabel('mixed'), '大小便');
});

test('sortFeedTypes / feedTypesLabel：按规范顺序去重', () => {
  assert.deepEqual(sortFeedTypes(['breast_direct', 'formula']), ['formula', 'breast_direct']);
  assert.equal(feedTypesLabel(['breast_direct', 'formula']), '奶粉 + 亲喂');
  assert.equal(feedTypesLabel(['breast_milk', 'formula']), '奶粉 + 母乳（瓶喂）');
  assert.equal(feedTypesLabel([]), '');
});

test('eventTitle：多标签 / 亲喂 / 大小便 / v1 兼容', () => {
  const now = Date.now();
  assert.equal(
    eventTitle({ kind: 'feed', feedTypes: ['formula', 'breast_milk'], amountMl: 120, happenedAt: now }),
    '奶粉 + 母乳（瓶喂） 120 ml',
  );
  assert.equal(
    eventTitle({ kind: 'feed', feedTypes: ['breast_direct'], amountMl: null, happenedAt: now }),
    '亲喂',
  );
  assert.equal(
    eventTitle({ kind: 'feed', feedTypes: ['formula', 'breast_direct'], amountMl: 60, happenedAt: now }),
    '奶粉 + 亲喂 60 ml',
  );
  assert.equal(eventTitle({ kind: 'feed', feedType: 'formula', amountMl: 90 }), '奶粉 90 ml');
  assert.equal(eventTitle({ kind: 'diaper', diaperKind: 'mixed' }), '大小便');
});

test('eventIcon：含奶粉优先奶瓶，只有母乳用奶杯，亲喂用抱娃', () => {
  assert.equal(eventIcon({ kind: 'feed', feedTypes: ['formula', 'breast_direct'] }), '🍼');
  assert.equal(eventIcon({ kind: 'feed', feedTypes: ['breast_milk', 'breast_direct'] }), '🥛');
  assert.equal(eventIcon({ kind: 'feed', feedTypes: ['breast_direct'] }), '🤱');
  assert.equal(eventIcon({ kind: 'feed', feedType: 'formula' }), '🍼');
  assert.equal(eventIcon({ kind: 'diaper', diaperKind: 'pee' }), '💧');
  assert.equal(eventIcon({ kind: 'diaper', diaperKind: 'poop' }), '💩');
  assert.equal(eventIcon({ kind: 'diaper', diaperKind: 'mixed' }), '🚼');
});

test('formatTodaySummary：与契约 §7.3 的格式一致', () => {
  assert.equal(
    formatTodaySummary({
      feedCount: 4,
      totalMl: 360,
      breastDirectCount: 1,
      peeCount: 2,
      poopCount: 1,
    }),
    '今日 喂奶 4 次 · 奶量 360 ml · 亲喂 1 次 · 小便 2 · 大便 1',
  );
  assert.equal(
    formatTodaySummary({}),
    '今日 喂奶 0 次 · 奶量 0 ml · 亲喂 0 次 · 小便 0 · 大便 0',
  );
});

test('formatBytes', () => {
  assert.equal(formatBytes(500), '500 字节');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});
