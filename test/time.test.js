/**
 * src/util/time.js 服务端时间纯函数测试
 *
 * tzOffset 语义与 Date.prototype.getTimezoneOffset() 一致：
 *   本地时间 = UTC - tzOffset 分钟，东八区为 -480。
 *
 * 涉及「服务器本地时区」的用例不用硬编码时区，而用本地 Date 构造器 + 本地字段断言，
 * 这样在任意时区运行都成立。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dayBounds, isValidTzOffset } from '../src/util/time.js';

const DAY_MS = 86_400_000;

function utc(y, monthIndex, d, h = 0, min = 0, s = 0, ms = 0) {
  return Date.UTC(y, monthIndex, d, h, min, s, ms);
}

function assertDayBounds(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.equal(actual.end - actual.start, DAY_MS, 'end - start 必须等于一天');
}

describe('dayBounds · 东八区（tzOffset = -480）', () => {
  test('UTC 2026-11-12T16:30Z 属于东八区 2026-11-13 当天', () => {
    const now = utc(2026, 10, 12, 16, 30);
    const bounds = dayBounds(now, -480);
    assertDayBounds(bounds, {
      start: utc(2026, 10, 12, 16, 0),
      end: utc(2026, 10, 13, 16, 0),
      dateKey: '2026-11-13',
    });
    assert.ok(bounds.start <= now && now < bounds.end);
  });

  test('当天 0 点整 / 当天最后一毫秒 / 次日 0 点整的边界归属', () => {
    const start = utc(2026, 10, 12, 16, 0);
    assert.equal(dayBounds(start, -480).dateKey, '2026-11-13');
    assert.equal(dayBounds(start, -480).start, start);

    const lastMs = start + DAY_MS - 1;
    assert.equal(dayBounds(lastMs, -480).dateKey, '2026-11-13');
    assert.equal(dayBounds(lastMs, -480).start, start);

    const nextStart = start + DAY_MS;
    assert.equal(dayBounds(nextStart, -480).dateKey, '2026-11-14');
    assert.equal(dayBounds(nextStart, -480).start, nextStart);
  });

  test('东八区跨日：UTC 15:59:59.999 与 16:00:00.000 分属两天', () => {
    assert.equal(dayBounds(utc(2026, 10, 12, 15, 59, 59, 999), -480).dateKey, '2026-11-12');
    assert.equal(dayBounds(utc(2026, 10, 12, 16, 0, 0, 0), -480).dateKey, '2026-11-13');
  });
});

describe('dayBounds · 其他时区偏移', () => {
  test('tzOffset = 0（UTC）', () => {
    const now = utc(2026, 10, 13, 23, 59, 59, 999);
    assertDayBounds(dayBounds(now, 0), {
      start: utc(2026, 10, 13, 0, 0),
      end: utc(2026, 10, 14, 0, 0),
      dateKey: '2026-11-13',
    });
    assert.equal(dayBounds(utc(2026, 10, 14, 0, 0), 0).dateKey, '2026-11-14');
  });

  test('tzOffset = +330（UTC-5:30），UTC 凌晨仍算前一天', () => {
    const now = utc(2026, 10, 13, 4, 0);
    assertDayBounds(dayBounds(now, 330), {
      start: utc(2026, 10, 12, 5, 30),
      end: utc(2026, 10, 13, 5, 30),
      dateKey: '2026-11-12',
    });
    assert.ok(dayBounds(now, 330).start <= now && now < dayBounds(now, 330).end);
  });

  test('tzOffset = -300（UTC+5）', () => {
    const now = utc(2026, 10, 13, 2, 0);
    assertDayBounds(dayBounds(now, -300), {
      start: utc(2026, 10, 12, 19, 0),
      end: utc(2026, 10, 13, 19, 0),
      dateKey: '2026-11-13',
    });
  });

  test('合法边界 tzOffset = -840（UTC+14）与 +840（UTC-14）', () => {
    assertDayBounds(dayBounds(utc(2026, 10, 13, 10, 0), -840), {
      start: utc(2026, 10, 13, 10, 0),
      end: utc(2026, 10, 14, 10, 0),
      dateKey: '2026-11-14',
    });
    assertDayBounds(dayBounds(utc(2026, 10, 13, 9, 59, 59, 999), -840), {
      start: utc(2026, 10, 12, 10, 0),
      end: utc(2026, 10, 13, 10, 0),
      dateKey: '2026-11-13',
    });
    assertDayBounds(dayBounds(utc(2026, 10, 13, 14, 0), 840), {
      start: utc(2026, 10, 13, 14, 0),
      end: utc(2026, 10, 14, 14, 0),
      dateKey: '2026-11-13',
    });
    assertDayBounds(dayBounds(utc(2026, 10, 13, 13, 59, 59, 999), 840), {
      start: utc(2026, 10, 12, 14, 0),
      end: utc(2026, 10, 13, 14, 0),
      dateKey: '2026-11-12',
    });
  });
});

describe('dayBounds · 省略 tzOffset 时使用服务器本地时区', () => {
  // 用本地构造器取一个确定时刻：本地 2026-06-15 12:30:45.678
  const nowLocal = new Date(2026, 5, 15, 12, 30, 45, 678).getTime();

  test('start / end / dateKey 与本地日历一致（不假设运行时时区）', () => {
    const bounds = dayBounds(nowLocal);

    assert.equal(bounds.dateKey, '2026-06-15');
    assert.equal(bounds.start, new Date(2026, 5, 15, 0, 0, 0, 0).getTime());
    assert.equal(bounds.end, new Date(2026, 5, 16, 0, 0, 0, 0).getTime());
    assert.ok(bounds.start <= nowLocal && nowLocal < bounds.end);
  });

  test('start 是本地当天 0 点，end 是本地次日 0 点', () => {
    const { start, end } = dayBounds(nowLocal);
    const startDate = new Date(start);
    const endDate = new Date(end);

    assert.equal(startDate.getHours(), 0);
    assert.equal(startDate.getMinutes(), 0);
    assert.equal(startDate.getSeconds(), 0);
    assert.equal(startDate.getMilliseconds(), 0);
    assert.equal(startDate.getFullYear(), 2026);
    assert.equal(startDate.getMonth(), 5);
    assert.equal(startDate.getDate(), 15);

    assert.equal(endDate.getHours(), 0);
    assert.equal(endDate.getMinutes(), 0);
    assert.equal(endDate.getSeconds(), 0);
    assert.equal(endDate.getMilliseconds(), 0);
    assert.equal(endDate.getFullYear(), 2026);
    assert.equal(endDate.getMonth(), 5);
    assert.equal(endDate.getDate(), 16);
  });

  test('null / undefined / 显式省略 行为一致（均走本地时区）', () => {
    const omitted = dayBounds(nowLocal);
    assert.deepEqual(dayBounds(nowLocal, null), omitted);
    assert.deepEqual(dayBounds(nowLocal, undefined), omitted);
  });

  test('本地时区跨日边界：当天 23:59:59.999 与次日 0 点分属两天', () => {
    const lastMs = new Date(2026, 5, 15, 23, 59, 59, 999).getTime();
    const nextDayStart = new Date(2026, 5, 16, 0, 0, 0, 0).getTime();
    assert.equal(dayBounds(lastMs).dateKey, '2026-06-15');
    assert.equal(dayBounds(nextDayStart).dateKey, '2026-06-16');
    assert.equal(dayBounds(lastMs).end, nextDayStart);
  });
});

describe('dayBounds · 非法参数', () => {
  const NOW = utc(2026, 10, 13, 4, 0);

  test('非法 tzOffset 抛 RangeError', () => {
    for (const bad of [-841, 841, -0.5, 1.5, NaN, Infinity, -Infinity, '0', 'abc', true, {}, []]) {
      assert.throws(() => dayBounds(NOW, bad), RangeError, `tzOffset=${String(bad)} 应该抛 RangeError`);
    }
  });

  test('非法 nowMs 抛 RangeError', () => {
    for (const bad of [NaN, Infinity, -Infinity, '1763000000000', null, undefined, {}]) {
      assert.throws(() => dayBounds(bad, 0), RangeError, `nowMs=${String(bad)} 应该抛 RangeError`);
    }
  });
});

describe('isValidTzOffset', () => {
  test('合法：-840..840 的整数', () => {
    for (const ok of [-840, -480, -330, 0, 300, 330, 840]) {
      assert.equal(isValidTzOffset(ok), true, `${ok} 应该合法`);
    }
  });

  test('非法：越界 / 非整数 / 非 number', () => {
    for (const bad of [-841, 841, -840.5, 840.5, 1.5, NaN, Infinity, '0', '480', null, undefined, true, {}, []]) {
      assert.equal(isValidTzOffset(bad), false, `${String(bad)} 应该非法`);
    }
  });
});
