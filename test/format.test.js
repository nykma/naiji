/**
 * public/lib/format.js 共享前端纯函数测试（Node 与浏览器共用）
 *
 * 时间相关用例一律使用**本地构造**的时间戳（new Date(y, m, d, h, min).getTime()），
 * 这样无论测试运行在哪个时区，断言都成立。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDuration,
  formatClock,
  formatAmount,
  formatDayKey,
  formatDayLabel,
  feedTypeLabel,
  diaperKindLabel,
  eventTitle,
  eventIcon,
} from '../public/lib/format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 本地时间戳构造器（不假设运行时区） */
function local(y, monthIndex, d, h = 0, min = 0, s = 0, ms = 0) {
  return new Date(y, monthIndex, d, h, min, s, ms).getTime();
}

describe('formatDuration', () => {
  test('小于 1 分钟 → 刚刚（含 0 与 59.999 秒）', () => {
    assert.equal(formatDuration(0), '刚刚');
    assert.equal(formatDuration(1), '刚刚');
    assert.equal(formatDuration(59_999), '刚刚');
  });

  test('分钟档位边界：60_000 → 1 分钟，3_599_999 → 59 分钟', () => {
    assert.equal(formatDuration(MINUTE), '1 分钟');
    assert.equal(formatDuration(MINUTE + 1), '1 分钟');
    assert.equal(formatDuration(2 * MINUTE), '2 分钟');
    assert.equal(formatDuration(HOUR - 1), '59 分钟');
    assert.equal(formatDuration(3_599_999), '59 分钟');
  });

  test('小时档位：整点不带 0 分钟，产品核心文案 3 小时 25 分钟', () => {
    assert.equal(formatDuration(HOUR), '1 小时');
    assert.equal(formatDuration(2 * HOUR), '2 小时');
    assert.equal(formatDuration(3 * HOUR + 25 * MINUTE), '3 小时 25 分钟');
    assert.equal(formatDuration(23 * HOUR + 59 * MINUTE), '23 小时 59 分钟');
  });

  test('天档位：24h → 1 天，25h → 1 天 1 小时，整天空小时省略', () => {
    assert.equal(formatDuration(DAY), '1 天');
    assert.equal(formatDuration(DAY + HOUR), '1 天 1 小时');
    assert.equal(formatDuration(DAY + 5 * HOUR), '1 天 5 小时');
    assert.equal(formatDuration(2 * DAY), '2 天');
    assert.equal(formatDuration(2 * DAY + 3 * HOUR + 30 * MINUTE), '2 天 3 小时');
  });

  test('负数 / NaN / Infinity 视为 0 → 刚刚', () => {
    assert.equal(formatDuration(-1), '刚刚');
    assert.equal(formatDuration(-DAY), '刚刚');
    assert.equal(formatDuration(NaN), '刚刚');
    assert.equal(formatDuration(Infinity), '刚刚');
    assert.equal(formatDuration(-Infinity), '刚刚');
  });

  test('毫秒向下取整，不会提前进位', () => {
    assert.equal(formatDuration(HOUR - 1), '59 分钟');
    assert.equal(formatDuration(3 * HOUR + 25 * MINUTE - 1), '3 小时 24 分钟');
  });
});

describe('formatClock', () => {
  test('本地 HH:mm 补零', () => {
    assert.equal(formatClock(local(2026, 10, 13, 14, 5)), '14:05');
    assert.equal(formatClock(local(2026, 10, 13, 9, 5)), '09:05');
    assert.equal(formatClock(local(2026, 10, 13, 0, 0)), '00:00');
    assert.equal(formatClock(local(2026, 10, 13, 23, 59)), '23:59');
    assert.equal(formatClock(local(2026, 10, 13, 7, 30)), '07:30');
  });
});

describe('formatAmount', () => {
  test('正常奶量 → "N ml"', () => {
    assert.equal(formatAmount(120), '120 ml');
    assert.equal(formatAmount(30), '30 ml');
    assert.equal(formatAmount(0), '0 ml');
    assert.equal(formatAmount(2000), '2000 ml');
  });

  test('null / undefined → 空串', () => {
    assert.equal(formatAmount(null), '');
    assert.equal(formatAmount(undefined), '');
  });
});

describe('formatDayKey', () => {
  test('本地 YYYY-MM-DD，月/日补零', () => {
    assert.equal(formatDayKey(local(2026, 10, 13, 14, 5)), '2026-11-13');
    assert.equal(formatDayKey(local(2026, 0, 1, 0, 0)), '2026-01-01');
    assert.equal(formatDayKey(local(2026, 0, 9, 23, 59)), '2026-01-09');
    assert.equal(formatDayKey(local(2026, 11, 31, 23, 59)), '2026-12-31');
  });
});

describe('formatDayLabel', () => {
  // 2026-11-13 是周五；now 固定为当天下午
  const NOW = local(2026, 10, 13, 16, 0);

  test('今天 / 昨天 / 前天（按本地日历天，与具体时刻无关）', () => {
    assert.equal(formatDayLabel(local(2026, 10, 13, 0, 0), NOW), '今天');
    assert.equal(formatDayLabel(local(2026, 10, 13, 15, 59), NOW), '今天');
    assert.equal(formatDayLabel(local(2026, 10, 12, 0, 30), NOW), '昨天');
    assert.equal(formatDayLabel(local(2026, 10, 11, 23, 30), NOW), '前天');
  });

  test('同年更早日期 → "M月D日 周X"（含周几）', () => {
    // 2026-11-03 是周二（与 11-13 周五相差 10 天）
    assert.equal(formatDayLabel(local(2026, 10, 3, 8, 0), NOW), '11月3日 周二');
    assert.equal(formatDayLabel(local(2026, 0, 1, 8, 0), NOW), '1月1日 周四');
  });

  test('跨年 → "YYYY年M月D日"', () => {
    const nowNewYear = local(2026, 0, 2, 12, 0);
    assert.equal(formatDayLabel(local(2025, 10, 12, 9, 0), nowNewYear), '2025年11月12日');
    assert.equal(formatDayLabel(local(2025, 0, 5, 9, 0), nowNewYear), '2025年1月5日');
  });

  test('跨年的昨天 / 前天仍优先显示相对文案', () => {
    const nowNewYear = local(2026, 0, 1, 10, 0);
    assert.equal(formatDayLabel(local(2025, 11, 31, 23, 0), nowNewYear), '昨天');
    assert.equal(formatDayLabel(local(2025, 11, 30, 23, 0), nowNewYear), '前天');
    assert.equal(formatDayLabel(local(2025, 11, 29, 23, 0), nowNewYear), '2025年12月29日');
  });
});

describe('feedTypeLabel / diaperKindLabel', () => {
  test('喂奶类型中文', () => {
    assert.equal(feedTypeLabel('formula'), '奶粉');
    assert.equal(feedTypeLabel('breast_milk'), '母乳（瓶喂）');
    assert.equal(feedTypeLabel('breast_direct'), '亲喂');
  });

  test('大小便类型中文', () => {
    assert.equal(diaperKindLabel('pee'), '小便');
    assert.equal(diaperKindLabel('poop'), '大便');
    assert.equal(diaperKindLabel('mixed'), '大小便');
  });
});

describe('eventTitle', () => {
  test('喂奶：奶粉 / 母乳瓶喂 带奶量，亲喂不带', () => {
    assert.equal(
      eventTitle({ kind: 'feed', feedType: 'formula', amountMl: 120, diaperKind: null }),
      '奶粉 120 ml',
    );
    assert.equal(
      eventTitle({ kind: 'feed', feedType: 'breast_milk', amountMl: 90, diaperKind: null }),
      '母乳（瓶喂） 90 ml',
    );
    assert.equal(
      eventTitle({ kind: 'feed', feedType: 'breast_direct', amountMl: null, diaperKind: null }),
      '亲喂',
    );
  });

  test('大小便：三种类型标题', () => {
    assert.equal(eventTitle({ kind: 'diaper', feedType: null, amountMl: null, diaperKind: 'pee' }), '小便');
    assert.equal(eventTitle({ kind: 'diaper', feedType: null, amountMl: null, diaperKind: 'poop' }), '大便');
    assert.equal(eventTitle({ kind: 'diaper', feedType: null, amountMl: null, diaperKind: 'mixed' }), '大小便');
  });

  test('空事件 → 空串', () => {
    assert.equal(eventTitle(null), '');
    assert.equal(eventTitle(undefined), '');
  });
});

describe('eventIcon', () => {
  test('喂奶图标按类型区分', () => {
    assert.equal(eventIcon({ kind: 'feed', feedType: 'formula', diaperKind: null }), '🍼');
    assert.equal(eventIcon({ kind: 'feed', feedType: 'breast_milk', diaperKind: null }), '🥛');
    assert.equal(eventIcon({ kind: 'feed', feedType: 'breast_direct', diaperKind: null }), '🤱');
  });

  test('大小便图标按类型区分', () => {
    assert.equal(eventIcon({ kind: 'diaper', feedType: null, diaperKind: 'pee' }), '💧');
    assert.equal(eventIcon({ kind: 'diaper', feedType: null, diaperKind: 'poop' }), '💩');
    assert.equal(eventIcon({ kind: 'diaper', feedType: null, diaperKind: 'mixed' }), '🚼');
  });

  test('空事件 → 空串', () => {
    assert.equal(eventIcon(null), '');
  });
});
