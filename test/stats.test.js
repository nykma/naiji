/**
 * buildDailyStats（GET /api/stats 的纯函数核心）v3 测试。
 *
 * 固定 NOW = 2026-11-13T04:00:00Z：东八区（tzOffset=-480）为 2026-11-13 12:00。
 * 全部用 :memory: 库 + 注入 now，不依赖真实时钟与仓库 data/。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { openDb } from '../server/src/db.js';
import {
  buildDailyStats,
  DEFAULT_STATS_DAYS,
  MIN_STATS_DAYS,
  MAX_STATS_DAYS,
} from '../server/src/stats.js';

const DAY = 86_400_000;
const TZ_SHANGHAI = -480;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0); // 东八区 2026-11-13 12:00

/** 某时区本地墙上时间 → epoch ms（本地 = UTC − tzOffset） */
function atLocal(y, month, day, hour = 0, minute = 0, tzOffset = TZ_SHANGHAI) {
  return Date.UTC(y, month - 1, day, hour, minute, 0, 0) + tzOffset * 60_000;
}

function makeStore(t) {
  const store = openDb(':memory:');
  t.after(() => store.close());
  return store;
}

/** 空的单日聚合（与 createDayTotals 的结构一致，用于 deepEqual 断言） */
function zeros(date) {
  return {
    date,
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
    bathCount: 0,
  };
}

function addFeed(store, happenedAt, feedTypes, amountMl = null) {
  return store.createFeedEvent({ feedTypes, amountMl, happenedAt, createdAt: NOW });
}

function addDiaper(store, happenedAt, diaperKind) {
  return store.createDiaperEvent({ diaperKind, happenedAt, createdAt: NOW });
}

function addBath(store, happenedAt, note = null) {
  return store.createBathEvent({ note, happenedAt, createdAt: NOW });
}

/** 用 UTC 解析日期键，断言 daily 日期升序且每天恰好 +1 天 */
function assertContinuousAscending(daily) {
  for (let i = 1; i < daily.length; i += 1) {
    const prev = Date.parse(`${daily[i - 1].date}T00:00:00Z`);
    const curr = Date.parse(`${daily[i].date}T00:00:00Z`);
    assert.equal(curr - prev, DAY, `daily[${i - 1}]=${daily[i - 1].date} 到 daily[${i}]=${daily[i].date} 应连续 1 天`);
  }
}

// ---------------------------------------------------------------------------
// 长度 / 起止日期 / 连续性 / 补 0
// ---------------------------------------------------------------------------

describe('buildDailyStats · 天数、起止日期与连续性', () => {
  test('默认 7 天：长度 7、升序连续、startDate/endDate 正确', (t) => {
    const store = makeStore(t);
    assert.equal(DEFAULT_STATS_DAYS, 7);

    const stats = buildDailyStats(store, NOW, undefined, TZ_SHANGHAI);
    assert.equal(stats.days, 7, 'days 省略时默认 7');
    assert.equal(stats.daily.length, 7);
    assert.equal(stats.startDate, '2026-11-07');
    assert.equal(stats.endDate, '2026-11-13');
    assert.deepEqual(
      stats.daily.map((day) => day.date),
      ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
    );
    assertContinuousAscending(stats.daily);
    // 没有记录 → 每天补 0，且字段形状完整
    for (const day of stats.daily) assert.deepEqual(day, zeros(day.date));
  });

  test('days=1：只有今天一天，startDate === endDate === 今天', (t) => {
    const store = makeStore(t);
    assert.equal(MIN_STATS_DAYS, 1);
    const stats = buildDailyStats(store, NOW, 1, TZ_SHANGHAI);
    assert.equal(stats.days, 1);
    assert.equal(stats.daily.length, 1);
    assert.equal(stats.startDate, '2026-11-13');
    assert.equal(stats.endDate, '2026-11-13');
    assert.deepEqual(stats.daily[0], zeros('2026-11-13'));
  });

  test('days=30：长度 30，startDate 为 29 天前', (t) => {
    const store = makeStore(t);
    const stats = buildDailyStats(store, NOW, 30, TZ_SHANGHAI);
    assert.equal(stats.days, 30);
    assert.equal(stats.daily.length, 30);
    assert.equal(stats.startDate, '2026-10-15');
    assert.equal(stats.endDate, '2026-11-13');
    assertContinuousAscending(stats.daily);
    for (const day of stats.daily) assert.deepEqual(day, zeros(day.date));
  });

  test('days=90（上限）：长度 90，startDate 为 89 天前', (t) => {
    const store = makeStore(t);
    assert.equal(MAX_STATS_DAYS, 90);
    const stats = buildDailyStats(store, NOW, 90, TZ_SHANGHAI);
    assert.equal(stats.days, 90);
    assert.equal(stats.daily.length, 90);
    assert.equal(stats.startDate, '2026-08-16');
    assert.equal(stats.endDate, '2026-11-13');
    assertContinuousAscending(stats.daily);
  });

  test('窗口外记录不计入（days=1 / 7 / 8 的边界）', (t) => {
    const store = makeStore(t);
    addFeed(store, atLocal(2026, 11, 5, 12, 0), ['formula'], 10); // 8 天前
    addFeed(store, atLocal(2026, 11, 6, 12, 0), ['formula'], 20); // 7 天前
    addFeed(store, atLocal(2026, 11, 13, 12, 0), ['formula'], 30); // 今天

    const seven = buildDailyStats(store, NOW, 7, TZ_SHANGHAI);
    assert.equal(seven.daily[0].date, '2026-11-07');
    assert.ok(!seven.daily.some((day) => day.date === '2026-11-06' || day.date === '2026-11-05'));
    assert.equal(seven.daily.at(-1).feedCount, 1);
    assert.equal(seven.daily.at(-1).totalMl, 30);

    // 8 天窗口才包含 11-06（窗口 = 11-06..11-13）
    const eight = buildDailyStats(store, NOW, 8, TZ_SHANGHAI);
    assert.equal(eight.daily[0].date, '2026-11-06');
    assert.equal(eight.daily[0].feedCount, 1);
    assert.equal(eight.daily[0].totalMl, 20);

    const one = buildDailyStats(store, NOW, 1, TZ_SHANGHAI);
    assert.deepEqual(one.daily, [{ ...zeros('2026-11-13'), feedCount: 1, totalMl: 30, formulaCount: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// 按天聚合（feed / diaper / bath）
// ---------------------------------------------------------------------------

describe('buildDailyStats · 按天聚合', () => {
  test('feed 各标签计数 / totalMl（亲喂不计奶量）/ mixedFeedCount', (t) => {
    const store = makeStore(t);
    addFeed(store, atLocal(2026, 11, 12, 8, 0), ['formula'], 120);
    addFeed(store, atLocal(2026, 11, 13, 8, 0), ['breast_milk'], 90);
    addFeed(store, atLocal(2026, 11, 13, 9, 0), ['breast_direct']);
    addFeed(store, atLocal(2026, 11, 13, 10, 0), ['breast_direct', 'formula'], 60);
    addFeed(store, atLocal(2026, 11, 13, 11, 0), ['breast_direct', 'breast_milk', 'formula'], 30);

    const stats = buildDailyStats(store, NOW, 7, TZ_SHANGHAI);
    const byDate = new Map(stats.daily.map((day) => [day.date, day]));

    assert.deepEqual(byDate.get('2026-11-12'), {
      ...zeros('2026-11-12'),
      feedCount: 1,
      totalMl: 120,
      formulaCount: 1,
    });

    const today = byDate.get('2026-11-13');
    assert.equal(today.feedCount, 4, '亲喂也计入喂奶次数');
    assert.equal(today.totalMl, 90 + 60 + 30, '亲喂无奶量不计入 totalMl');
    assert.equal(today.formulaCount, 2, '含 formula 标签的事件数');
    assert.equal(today.breastMilkCount, 2);
    assert.equal(today.breastDirectCount, 3);
    assert.equal(today.mixedFeedCount, 2, '多于一个标签的喂奶事件数');
    // 其他类别保持 0
    assert.equal(today.diaperCount, 0);
    assert.equal(today.bathCount, 0);
  });

  test('diaper 计数：pee / poop / mixed（mixed 同时计 pee + poop 与 mixedCount）', (t) => {
    const store = makeStore(t);
    addDiaper(store, atLocal(2026, 11, 13, 8, 0), 'pee');
    addDiaper(store, atLocal(2026, 11, 13, 9, 0), 'poop');
    addDiaper(store, atLocal(2026, 11, 13, 10, 0), 'mixed');
    addDiaper(store, atLocal(2026, 11, 13, 11, 0), 'mixed');

    const today = buildDailyStats(store, NOW, 1, TZ_SHANGHAI).daily[0];
    assert.equal(today.diaperCount, 4);
    assert.equal(today.peeCount, 3, 'pee 1 + mixed 2');
    assert.equal(today.poopCount, 3, 'poop 1 + mixed 2');
    assert.equal(today.mixedCount, 2);
    assert.equal(today.feedCount, 0);
    assert.equal(today.bathCount, 0);
  });

  test('bath 计数只累加 bathCount，不影响其它字段', (t) => {
    const store = makeStore(t);
    addBath(store, atLocal(2026, 11, 12, 20, 0), '昨天洗澡');
    addBath(store, atLocal(2026, 11, 13, 20, 0), '今天洗澡');
    addBath(store, atLocal(2026, 11, 13, 21, 0));

    const stats = buildDailyStats(store, NOW, 2, TZ_SHANGHAI);
    assert.deepEqual(stats.daily, [
      { ...zeros('2026-11-12'), bathCount: 1 },
      { ...zeros('2026-11-13'), bathCount: 2 },
    ]);
  });

  test('同一批事件混排：feed / diaper / bath 互不串扰', (t) => {
    const store = makeStore(t);
    addFeed(store, atLocal(2026, 11, 13, 7, 0), ['formula'], 100);
    addDiaper(store, atLocal(2026, 11, 13, 8, 0), 'pee');
    addBath(store, atLocal(2026, 11, 13, 9, 0));
    addFeed(store, atLocal(2026, 11, 13, 10, 0), ['breast_direct']);

    const today = buildDailyStats(store, NOW, 1, TZ_SHANGHAI).daily[0];
    assert.deepEqual(today, {
      ...zeros('2026-11-13'),
      feedCount: 2,
      totalMl: 100,
      formulaCount: 1,
      breastDirectCount: 1,
      diaperCount: 1,
      peeCount: 1,
      bathCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 时区
// ---------------------------------------------------------------------------

describe('buildDailyStats · tzOffset', () => {
  test('tzOffset=0：按 UTC 天聚合，日期标签为 UTC 日期', (t) => {
    const store = makeStore(t);
    const utcDayStart = Date.UTC(2026, 10, 13, 0, 0, 0);
    addFeed(store, utcDayStart - 1, ['formula'], 10); // UTC 11-12 23:59:59.999
    addFeed(store, utcDayStart, ['formula'], 20); // UTC 11-13 00:00
    addFeed(store, utcDayStart + DAY - 1, ['formula'], 30); // UTC 11-13 23:59:59.999
    addFeed(store, utcDayStart + DAY, ['formula'], 40); // UTC 11-14 00:00

    const stats = buildDailyStats(store, NOW, 2, 0);
    assert.deepEqual(stats.daily, [
      { ...zeros('2026-11-12'), feedCount: 1, totalMl: 10, formulaCount: 1 },
      { ...zeros('2026-11-13'), feedCount: 2, totalMl: 50, formulaCount: 2 },
    ]);
    assert.equal(stats.endDate, '2026-11-13');
  });

  test('tzOffset=840（UTC−14）：本地日期为 11-12，窗口边界正确', (t) => {
    const TZ = 840;
    const store = makeStore(t);
    // NOW 本地时间 = 2026-11-12 14:00 → 当天窗口 [2026-11-12T14:00Z, 2026-11-13T14:00Z)
    const dayStart = Date.UTC(2026, 10, 12, 14, 0, 0);
    addFeed(store, dayStart - 1, ['formula'], 10);
    addFeed(store, dayStart, ['formula'], 20);
    addFeed(store, dayStart + DAY - 1, ['formula'], 30);
    addFeed(store, dayStart + DAY, ['formula'], 40);

    const stats = buildDailyStats(store, NOW, 2, TZ);
    assert.equal(stats.endDate, '2026-11-12');
    assert.deepEqual(stats.daily, [
      { ...zeros('2026-11-11'), feedCount: 1, totalMl: 10, formulaCount: 1 },
      { ...zeros('2026-11-12'), feedCount: 2, totalMl: 50, formulaCount: 2 },
    ]);
  });

  test('tzOffset=-840（UTC+14）：本地日期为 11-13，窗口边界正确', (t) => {
    const TZ = -840;
    const store = makeStore(t);
    // NOW 本地时间 = 2026-11-13 18:00 → 当天窗口 [2026-11-12T10:00Z, 2026-11-13T10:00Z)
    const dayStart = Date.UTC(2026, 10, 12, 10, 0, 0);
    addFeed(store, dayStart - 1, ['formula'], 10);
    addFeed(store, dayStart, ['formula'], 20);
    addFeed(store, dayStart + DAY - 1, ['formula'], 30);
    addFeed(store, dayStart + DAY, ['formula'], 40);

    const stats = buildDailyStats(store, NOW, 2, TZ);
    assert.equal(stats.endDate, '2026-11-13');
    assert.deepEqual(stats.daily, [
      { ...zeros('2026-11-12'), feedCount: 1, totalMl: 10, formulaCount: 1 },
      { ...zeros('2026-11-13'), feedCount: 2, totalMl: 50, formulaCount: 2 },
    ]);
  });

  test('省略 / null tzOffset：按服务器本地时区，结果与显式本地 offset 一致', (t) => {
    const store = makeStore(t);
    const local = new Date(NOW);
    const localStart = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime();
    addFeed(store, localStart - 1, ['formula'], 10);
    addFeed(store, localStart, ['formula'], 20);
    addFeed(store, localStart + DAY - 1, ['formula'], 30);
    addFeed(store, localStart + DAY, ['formula'], 40);

    const expectedDate = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
      local.getDate(),
    ).padStart(2, '0')}`;

    for (const tz of [undefined, null]) {
      const stats = buildDailyStats(store, NOW, 1, tz);
      assert.equal(stats.endDate, expectedDate);
      assert.equal(stats.daily[0].date, expectedDate);
      assert.equal(stats.daily[0].feedCount, 2);
      assert.equal(stats.daily[0].totalMl, 50);
    }

    const localOffset = local.getTimezoneOffset();
    assert.deepEqual(
      buildDailyStats(store, NOW, 3, localOffset),
      buildDailyStats(store, NOW, 3, null),
      '显式服务器本地 offset 应与省略结果一致',
    );
  });

  test('非法 tzOffset → RangeError（900 / -900 / 1.5 / NaN / 字符串）', (t) => {
    const store = makeStore(t);
    for (const bad of [900, -900, 1.5, NaN, '480', 481.2, Infinity]) {
      assert.throws(
        () => buildDailyStats(store, NOW, 7, bad),
        RangeError,
        `tzOffset=${String(bad)} 应抛 RangeError`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 跨日边界
// ---------------------------------------------------------------------------

describe('buildDailyStats · 跨日边界', () => {
  test('东八区：23:59:59.999 与次日 00:00:00.000 分属相邻两天', (t) => {
    const store = makeStore(t);
    const dayStart = atLocal(2026, 11, 13, 0, 0);
    addFeed(store, dayStart - 1, ['formula'], 10); // 11-12 23:59:59.999
    addFeed(store, dayStart, ['formula'], 20); // 11-13 00:00:00.000
    addBath(store, dayStart - 1);
    addBath(store, dayStart);

    const stats = buildDailyStats(store, NOW, 2, TZ_SHANGHAI);
    assert.equal(stats.daily[0].date, '2026-11-12');
    assert.equal(stats.daily[0].feedCount, 1);
    assert.equal(stats.daily[0].totalMl, 10);
    assert.equal(stats.daily[0].bathCount, 1);
    assert.equal(stats.daily[1].date, '2026-11-13');
    assert.equal(stats.daily[1].feedCount, 1);
    assert.equal(stats.daily[1].totalMl, 20);
    assert.equal(stats.daily[1].bathCount, 1);
  });

  test('今天窗口末端（次日 00:00）不计入最后一天', (t) => {
    const store = makeStore(t);
    const nextDayStart = atLocal(2026, 11, 14, 0, 0); // 2026-11-13T16:00Z
    const lastMoment = nextDayStart - 1;
    addFeed(store, lastMoment, ['formula'], 20);
    addFeed(store, nextDayStart, ['formula'], 40); // 明天 00:00，超出 1 天窗口

    const stats = buildDailyStats(store, NOW, 1, TZ_SHANGHAI);
    assert.equal(stats.daily.length, 1);
    assert.equal(stats.daily[0].date, '2026-11-13');
    assert.equal(stats.daily[0].feedCount, 1);
    assert.equal(stats.daily[0].totalMl, 20);
  });

  test('横跨多天的数据按各自本地日归档（tzOffset=-480 与 0 的日期归属不同）', (t) => {
    const store = makeStore(t);
    // 2026-11-12T17:00Z：东八区 11-13 01:00（今天），UTC 11-12 17:00（昨天）
    const instant = Date.UTC(2026, 10, 12, 17, 0, 0);
    addFeed(store, instant, ['formula'], 50);

    const sh = buildDailyStats(store, NOW, 2, TZ_SHANGHAI);
    assert.equal(sh.daily.find((day) => day.date === '2026-11-13').totalMl, 50);
    assert.equal(sh.daily.find((day) => day.date === '2026-11-12').totalMl, 0);

    const utc = buildDailyStats(store, NOW, 2, 0);
    assert.equal(utc.daily.find((day) => day.date === '2026-11-12').totalMl, 50);
    assert.equal(utc.daily.find((day) => day.date === '2026-11-13').totalMl, 0);
  });
});

// ---------------------------------------------------------------------------
// 非法 days
// ---------------------------------------------------------------------------

describe('buildDailyStats · 非法 days 抛 RangeError', () => {
  test('0 / 91 / -1 / 1.5 / 小数 / 字符串 / null / NaN / Infinity', (t) => {
    const store = makeStore(t);
    for (const bad of [0, 91, -1, 1.5, 7.5, '7', null, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => buildDailyStats(store, NOW, bad, TZ_SHANGHAI),
        RangeError,
        `days=${String(bad)} 应抛 RangeError`,
      );
    }
  });

  test('边界值 1 与 90 合法', (t) => {
    const store = makeStore(t);
    assert.equal(buildDailyStats(store, NOW, 1, TZ_SHANGHAI).daily.length, 1);
    assert.equal(buildDailyStats(store, NOW, 90, TZ_SHANGHAI).daily.length, 90);
  });

  test('非法 now（NaN / Infinity）抛 RangeError（防御性）', (t) => {
    const store = makeStore(t);
    for (const bad of [NaN, Infinity]) {
      assert.throws(() => buildDailyStats(store, bad, 7, TZ_SHANGHAI), RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// 服务器本地时区 + 跨夏令时（回归：曾经用固定 24h 递减导致跳天）
// ---------------------------------------------------------------------------

describe('buildDailyStats · 服务器本地时区跨 DST', () => {
  test('America/New_York 春季 DST 切换周仍为连续 N 天（不跳天）', () => {
    const dbUrl = new URL('../server/src/db.js', import.meta.url).href;
    const statsUrl = new URL('../server/src/stats.js', import.meta.url).href;
    const code = [
      'import { openDb } from ' + JSON.stringify(dbUrl) + ';',
      'import { buildDailyStats } from ' + JSON.stringify(statsUrl) + ';',
      "const s = buildDailyStats(openDb(':memory:'), Date.UTC(2026, 2, 9, 4, 30, 0), 7, null);",
      'console.log(JSON.stringify(s.daily.map((d) => d.date)));',
    ].join('\n');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(out.trim()), [
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
  });
});
