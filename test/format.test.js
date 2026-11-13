/**
 * web/lib/format.js v2 纯函数测试（浏览器 / Node 共享模块）。
 *
 * 时间类断言全部用本地 Date 构造器生成时间戳，不假设运行环境时区。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEED_TYPES,
  formatDuration,
  formatClock,
  formatAmount,
  formatDayKey,
  formatDayLabel,
  feedTypeLabel,
  feedTypesLabel,
  sortFeedTypes,
  diaperKindLabel,
  eventTitle,
  eventIcon,
} from '../web/lib/format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 由本地时间构造时间戳（测试与 SUT 在同一进程、同一时区） */
function localTs(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('format · formatDuration 全档位边界', () => {
  test('小于 1 分钟 → 刚刚', () => {
    assert.equal(formatDuration(0), '刚刚');
    assert.equal(formatDuration(1), '刚刚');
    assert.equal(formatDuration(59_999), '刚刚');
  });

  test('分钟档', () => {
    assert.equal(formatDuration(MINUTE), '1 分钟');
    assert.equal(formatDuration(90_000), '1 分钟');
    assert.equal(formatDuration(59 * MINUTE), '59 分钟');
    assert.equal(formatDuration(HOUR - 1), '59 分钟');
  });

  test('小时档（分钟为 0 时省略）', () => {
    assert.equal(formatDuration(HOUR), '1 小时');
    assert.equal(formatDuration(3 * HOUR + 25 * MINUTE), '3 小时 25 分钟');
    assert.equal(formatDuration(3 * HOUR + 1), '3 小时');
    assert.equal(formatDuration(23 * HOUR + 59 * MINUTE), '23 小时 59 分钟');
    assert.equal(formatDuration(DAY - 1), '23 小时 59 分钟');
  });

  test('天档（小时为 0 时省略）', () => {
    assert.equal(formatDuration(DAY), '1 天');
    assert.equal(formatDuration(25 * HOUR), '1 天 1 小时');
    assert.equal(formatDuration(2 * DAY + 3 * HOUR), '2 天 3 小时');
    assert.equal(formatDuration(3 * DAY), '3 天');
  });

  test('负数 / NaN / Infinity 视为 0 → 刚刚', () => {
    assert.equal(formatDuration(-1), '刚刚');
    assert.equal(formatDuration(-100_000), '刚刚');
    assert.equal(formatDuration(NaN), '刚刚');
    assert.equal(formatDuration(Infinity), '刚刚');
    assert.equal(formatDuration(-Infinity), '刚刚');
  });
});

describe('format · formatClock / formatDayKey', () => {
  test('formatClock 输出本地 HH:mm，个位补零', () => {
    assert.equal(formatClock(localTs(2026, 11, 13, 9, 5)), '09:05');
    assert.equal(formatClock(localTs(2026, 11, 13, 0, 0)), '00:00');
    assert.equal(formatClock(localTs(2026, 11, 13, 23, 59)), '23:59');
    assert.equal(formatClock(localTs(2026, 11, 13, 12, 30)), '12:30');
  });

  test('formatDayKey 输出本地 YYYY-MM-DD', () => {
    assert.equal(formatDayKey(localTs(2026, 11, 13, 0, 0)), '2026-11-13');
    assert.equal(formatDayKey(localTs(2026, 1, 2, 23, 59)), '2026-01-02');
    assert.equal(formatDayKey(localTs(2025, 12, 31, 12, 0)), '2025-12-31');
    // 本地 00:00 与 23:59 同一天
    assert.equal(formatDayKey(localTs(2026, 11, 13, 0, 0)), formatDayKey(localTs(2026, 11, 13, 23, 59)));
    assert.equal(formatDayKey(localTs(2026, 11, 13, 0, 0)), localDayKey(localTs(2026, 11, 13, 0, 0)));
  });
});

describe('format · formatDayLabel', () => {
  const now = localTs(2026, 11, 13, 12, 0);

  test('今天 / 昨天 / 前天', () => {
    assert.equal(formatDayLabel(localTs(2026, 11, 13, 0, 0), now), '今天');
    assert.equal(formatDayLabel(localTs(2026, 11, 13, 23, 59), now), '今天');
    assert.equal(formatDayLabel(localTs(2026, 11, 12, 0, 0), now), '昨天');
    assert.equal(formatDayLabel(localTs(2026, 11, 11, 23, 59), now), '前天');
  });

  test('同年更早日期 → "M月D日 周X"', () => {
    const ts = localTs(2026, 11, 10, 9, 30);
    const d = new Date(ts);
    const expected = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
    assert.equal(formatDayLabel(ts, now), expected);
    assert.equal(formatDayLabel(localTs(2026, 1, 1), now), `1月1日 ${WEEKDAYS[new Date(2026, 0, 1).getDay()]}`);
  });

  test('跨年 → "YYYY年M月D日"', () => {
    assert.equal(formatDayLabel(localTs(2025, 12, 31, 20, 0), now), '2025年12月31日');
    assert.equal(formatDayLabel(localTs(2024, 11, 13), now), '2024年11月13日');
  });
});

describe('format · formatAmount', () => {
  test('数字 / 空值', () => {
    assert.equal(formatAmount(120), '120 ml');
    assert.equal(formatAmount(0), '0 ml');
    assert.equal(formatAmount(2000), '2000 ml');
    assert.equal(formatAmount(null), '');
    assert.equal(formatAmount(undefined), '');
    assert.equal(formatAmount(NaN), '');
  });
});

describe('format · feedTypeLabel / feedTypesLabel / sortFeedTypes', () => {
  test('FEED_TYPES 规范顺序', () => {
    assert.deepEqual(FEED_TYPES, ['formula', 'breast_milk', 'breast_direct']);
  });

  test('feedTypeLabel 单值中文', () => {
    assert.equal(feedTypeLabel('formula'), '奶粉');
    assert.equal(feedTypeLabel('breast_milk'), '母乳（瓶喂）');
    assert.equal(feedTypeLabel('breast_direct'), '亲喂');
    assert.equal(feedTypeLabel('bogus'), '喂奶');
    assert.equal(feedTypeLabel(undefined), '喂奶');
  });

  test('sortFeedTypes 规范顺序 / 去重 / 过滤非法 / 非数组', () => {
    assert.deepEqual(sortFeedTypes(['breast_direct', 'formula', 'breast_milk']), [
      'formula',
      'breast_milk',
      'breast_direct',
    ]);
    assert.deepEqual(sortFeedTypes(['formula', 'formula']), ['formula']);
    assert.deepEqual(sortFeedTypes(['bogus', 'breast_direct', null]), ['breast_direct']);
    assert.deepEqual(sortFeedTypes([]), []);
    assert.deepEqual(sortFeedTypes(undefined), []);
    assert.deepEqual(sortFeedTypes('formula'), []);
  });

  test('feedTypesLabel 单 / 双 / 三标签', () => {
    assert.equal(feedTypesLabel(['formula']), '奶粉');
    assert.equal(feedTypesLabel(['breast_milk']), '母乳（瓶喂）');
    assert.equal(feedTypesLabel(['breast_direct']), '亲喂');
    assert.equal(feedTypesLabel(['formula', 'breast_milk']), '奶粉 + 母乳（瓶喂）');
    assert.equal(feedTypesLabel(['breast_milk', 'formula']), '奶粉 + 母乳（瓶喂）');
    assert.equal(feedTypesLabel(['breast_direct', 'formula']), '奶粉 + 亲喂');
    assert.equal(feedTypesLabel(['breast_direct', 'breast_milk', 'formula']), '奶粉 + 母乳（瓶喂） + 亲喂');
  });

  test('feedTypesLabel 空数组 / 非法值 → 空或被过滤', () => {
    assert.equal(feedTypesLabel([]), '');
    assert.equal(feedTypesLabel(['bogus']), '');
    assert.equal(feedTypesLabel(['bogus', 'breast_direct']), '亲喂');
  });

  test('diaperKindLabel', () => {
    assert.equal(diaperKindLabel('pee'), '小便');
    assert.equal(diaperKindLabel('poop'), '大便');
    assert.equal(diaperKindLabel('mixed'), '大小便');
    assert.equal(diaperKindLabel('bogus'), '大小便');
    assert.equal(diaperKindLabel(undefined), '大小便');
  });
});

describe('format · eventTitle', () => {
  test('多标签喂奶带奶量：按规范顺序拼接 + " N ml"', () => {
    assert.equal(
      eventTitle({ kind: 'feed', feedTypes: ['formula', 'breast_milk'], amountMl: 120 }),
      '奶粉 + 母乳（瓶喂） 120 ml',
    );
    assert.equal(
      eventTitle({ kind: 'feed', feedTypes: ['breast_milk', 'formula'], amountMl: 120 }),
      '奶粉 + 母乳（瓶喂） 120 ml',
      '入参顺序不影响展示顺序',
    );
    assert.equal(
      eventTitle({ kind: 'feed', feedTypes: ['formula', 'breast_direct'], amountMl: 60 }),
      '奶粉 + 亲喂 60 ml',
    );
    assert.equal(
      eventTitle({ kind: 'feed', feedTypes: ['breast_direct', 'breast_milk', 'formula'], amountMl: 90 }),
      '奶粉 + 母乳（瓶喂） + 亲喂 90 ml',
    );
  });

  test('单标签喂奶', () => {
    assert.equal(eventTitle({ kind: 'feed', feedTypes: ['formula'], amountMl: 90 }), '奶粉 90 ml');
    assert.equal(eventTitle({ kind: 'feed', feedTypes: ['breast_milk'], amountMl: 120 }), '母乳（瓶喂） 120 ml');
  });

  test('仅亲喂（无奶量）→ 标签文案', () => {
    assert.equal(eventTitle({ kind: 'feed', feedTypes: ['breast_direct'], amountMl: null }), '亲喂');
    assert.equal(
      eventTitle({ kind: 'feed', feedTypes: ['breast_direct', 'formula'], amountMl: null }),
      '奶粉 + 亲喂',
    );
  });

  test('大小便事件', () => {
    assert.equal(eventTitle({ kind: 'diaper', diaperKind: 'pee' }), '小便');
    assert.equal(eventTitle({ kind: 'diaper', diaperKind: 'poop' }), '大便');
    assert.equal(eventTitle({ kind: 'diaper', diaperKind: 'mixed' }), '大小便');
  });

  test('v1 单值 feedType 兼容回退', () => {
    assert.equal(eventTitle({ kind: 'feed', feedType: 'formula', amountMl: 120 }), '奶粉 120 ml');
    assert.equal(eventTitle({ kind: 'feed', feedType: 'breast_milk', amountMl: 90 }), '母乳（瓶喂） 90 ml');
    assert.equal(eventTitle({ kind: 'feed', feedType: 'breast_direct', amountMl: null }), '亲喂');
  });

  test('空事件', () => {
    assert.equal(eventTitle(null), '');
    assert.equal(eventTitle(undefined), '');
  });
});

describe('format · eventIcon', () => {
  test('喂奶图标优先级：formula > breast_milk > breast_direct', () => {
    assert.equal(eventIcon({ kind: 'feed', feedTypes: ['formula'] }), '🍼');
    assert.equal(eventIcon({ kind: 'feed', feedTypes: ['formula', 'breast_direct'] }), '🍼');
    assert.equal(eventIcon({ kind: 'feed', feedTypes: ['formula', 'breast_milk'] }), '🍼');
    assert.equal(eventIcon({ kind: 'feed', feedTypes: ['breast_milk'] }), '🥛');
    assert.equal(eventIcon({ kind: 'feed', feedTypes: ['breast_milk', 'breast_direct'] }), '🥛');
    assert.equal(eventIcon({ kind: 'feed', feedTypes: ['breast_direct'] }), '🤱');
  });

  test('v1 单值 feedType 兼容回退', () => {
    assert.equal(eventIcon({ kind: 'feed', feedType: 'formula' }), '🍼');
    assert.equal(eventIcon({ kind: 'feed', feedType: 'breast_milk' }), '🥛');
    assert.equal(eventIcon({ kind: 'feed', feedType: 'breast_direct' }), '🤱');
  });

  test('大小便图标与空事件', () => {
    assert.equal(eventIcon({ kind: 'diaper', diaperKind: 'pee' }), '💧');
    assert.equal(eventIcon({ kind: 'diaper', diaperKind: 'poop' }), '💩');
    assert.equal(eventIcon({ kind: 'diaper', diaperKind: 'mixed' }), '🚼');
    assert.equal(eventIcon(null), '');
    assert.equal(eventIcon(undefined), '');
  });
});
