/**
 * buildState（/api/state 响应体）v2 聚合测试。
 *
 * 固定 NOW = 2026-11-13T04:00:00Z：东八区（tzOffset=-480）为 2026-11-13 12:00，
 * 当天窗口 = [2026-11-12T16:00Z, 2026-11-13T16:00Z)。所有断言不依赖真实时钟。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../server/src/db.js';
import { buildState } from '../server/src/state.js';

const TZ_SHANGHAI = -480;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const SH_DAY_START = Date.UTC(2026, 10, 12, 16, 0, 0);
const SH_DAY_END = Date.UTC(2026, 10, 13, 16, 0, 0);

/** 某时区本地墙上时间 → epoch ms（本地 = UTC − tzOffset） */
function atLocal(y, month, day, hour = 0, minute = 0, tzOffset = TZ_SHANGHAI) {
  return Date.UTC(y, month - 1, day, hour, minute, 0, 0) + tzOffset * 60_000;
}

const EMPTY_TODAY = {
  date: '2026-11-13',
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

function makeStore(t) {
  const store = openDb(':memory:');
  t.after(() => store.close());
  return store;
}

/** 插入喂奶事件；仅亲喂时 amount 为 null */
function addFeed(store, happenedAt, feedTypes, amountMl = null, note = null) {
  return store.createFeedEvent({ feedTypes, amountMl, note, happenedAt, createdAt: NOW });
}

function addDiaper(store, happenedAt, diaperKind, note = null) {
  return store.createDiaperEvent({ diaperKind, note, happenedAt, createdAt: NOW });
}

describe('buildState · 空库', () => {
  test('today 全为 0、last* 为 null、recent 为空、now 原样返回', (t) => {
    const store = makeStore(t);
    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.now, NOW);
    assert.deepEqual(state.today, EMPTY_TODAY);
    assert.equal(state.lastFeeding, null);
    assert.equal(state.lastDiaper, null);
    assert.deepEqual(state.recent, []);
  });
});

describe('buildState · today 聚合（tzOffset = -480）', () => {
  test('喂奶/大小便计数、奶量、各标签数、mixed 双计', (t) => {
    const store = makeStore(t);

    // 全部落在东八区 2026-11-13 当天
    addFeed(store, atLocal(2026, 11, 13, 0, 0), ['formula'], 120); // 00:00 当天起点
    addFeed(store, atLocal(2026, 11, 13, 7, 30), ['breast_milk'], 90);
    addFeed(store, atLocal(2026, 11, 13, 8, 0), ['breast_direct']); // 仅亲喂，无奶量
    addFeed(store, atLocal(2026, 11, 13, 9, 0), ['breast_direct', 'formula'], 60); // mixed
    addDiaper(store, atLocal(2026, 11, 13, 10, 0), 'pee');
    addDiaper(store, atLocal(2026, 11, 13, 10, 30), 'mixed');
    addDiaper(store, atLocal(2026, 11, 13, 11, 0), 'poop');

    const state = buildState(store, NOW, TZ_SHANGHAI);

    assert.equal(state.today.date, '2026-11-13');
    assert.equal(state.today.feedCount, 4, '亲喂也计入喂奶次数');
    assert.equal(state.today.totalMl, 120 + 90 + 60, '亲喂 null 不计入奶量');
    assert.equal(state.today.formulaCount, 2, '含 formula 的事件数（含 mixed）');
    assert.equal(state.today.breastMilkCount, 1);
    assert.equal(state.today.breastDirectCount, 2);
    assert.equal(state.today.mixedFeedCount, 1, '多于 1 个标签的喂奶数');
    assert.equal(state.today.diaperCount, 3);
    assert.equal(state.today.peeCount, 2, 'mixed 同时计入 pee');
    assert.equal(state.today.poopCount, 2, 'mixed 同时计入 poop');
    assert.equal(state.today.mixedCount, 1);

    // lastFeeding / lastDiaper 取各 kind 最新
    assert.equal(state.lastFeeding.id, 4);
    assert.deepEqual(state.lastFeeding.feedTypes, ['formula', 'breast_direct']);
    assert.equal(state.lastFeeding.feedTypes.length > 1, true);
    assert.equal(state.lastDiaper.id, 7);
    assert.equal(state.lastDiaper.diaperKind, 'poop');

    assert.equal(state.recent.length, 7);
    assert.deepEqual(
      state.recent.map((event) => event.id),
      [7, 6, 5, 4, 3, 2, 1],
      'recent 按 happenedAt DESC, id DESC',
    );
  });

  test('前一天 / 后一天不计入 today，但仍在 recent 中', (t) => {
    const store = makeStore(t);
    addFeed(store, SH_DAY_START - 1, ['formula'], 10); // 前一天 23:59:59.999
    addFeed(store, SH_DAY_START, ['formula'], 20); // 当天 00:00:00.000 包含
    addFeed(store, SH_DAY_END - 1, ['formula'], 30); // 当天 23:59:59.999 包含
    addFeed(store, SH_DAY_END, ['formula'], 40); // 后一天 00:00 不含
    addDiaper(store, SH_DAY_START - 1, 'pee');
    addDiaper(store, SH_DAY_END, 'poop');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 50);
    assert.equal(state.today.diaperCount, 0);
    assert.equal(state.recent.length, 6, 'recent 不受「今天」窗口限制');
    // lastFeeding 也不受今天限制
    assert.equal(state.lastFeeding.happenedAt, SH_DAY_END);
    assert.equal(state.lastDiaper.happenedAt, SH_DAY_END);
  });

  test('lastFeeding 含仅亲喂记录（amountMl 为 null）', (t) => {
    const store = makeStore(t);
    addFeed(store, atLocal(2026, 11, 13, 9, 0), ['formula'], 120);
    const direct = addFeed(store, atLocal(2026, 11, 13, 10, 0), ['breast_direct']);
    addDiaper(store, atLocal(2026, 11, 13, 11, 0), 'pee');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.lastFeeding.id, direct.id);
    assert.deepEqual(state.lastFeeding.feedTypes, ['breast_direct']);
    assert.equal(state.lastFeeding.amountMl, null);
    assert.equal(state.today.breastDirectCount, 1);
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 120);
  });
});

describe('buildState · tzOffset 对「今天」窗口的影响', () => {
  test('tzOffset=0：按 UTC 当天窗口聚合', (t) => {
    const store = makeStore(t);
    const utcDayStart = Date.UTC(2026, 10, 13, 0, 0, 0);
    addFeed(store, utcDayStart - 1, ['formula'], 10); // UTC 前一天
    addFeed(store, utcDayStart, ['formula'], 20); // UTC 当天起点
    addFeed(store, atLocal(2026, 11, 13, 9, 0, TZ_SHANGHAI), ['formula'], 30); // 2026-11-13T01:00Z 当天
    addFeed(store, utcDayStart + 24 * 3600_000, ['formula'], 40); // UTC 后一天 00:00

    const state = buildState(store, NOW, 0);
    assert.equal(state.today.date, '2026-11-13');
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 50);
  });

  test('tzOffset=840（UTC−14）：本地日期为 11-12，窗口边界正确', (t) => {
    const TZ = 840;
    const store = makeStore(t);
    // NOW 本地时间 = 2026-11-12 14:00 → 当天窗口 [2026-11-12T14:00Z, 2026-11-13T14:00Z)
    const dayStart = Date.UTC(2026, 10, 12, 14, 0, 0);
    addFeed(store, dayStart - 1, ['formula'], 10);
    addFeed(store, dayStart, ['formula'], 20);
    addFeed(store, dayStart + 24 * 3600_000 - 1, ['formula'], 30);

    const state = buildState(store, NOW, TZ);
    assert.equal(state.today.date, '2026-11-12');
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 50);
  });

  test('tzOffset=-840（UTC+14）：本地日期为 11-13，窗口边界正确', (t) => {
    const TZ = -840;
    const store = makeStore(t);
    // NOW 本地时间 = 2026-11-13 18:00 → 当天窗口 [2026-11-12T10:00Z, 2026-11-13T10:00Z)
    const dayStart = Date.UTC(2026, 10, 12, 10, 0, 0);
    const dayEnd = dayStart + 24 * 3600_000;
    addFeed(store, dayStart - 1, ['formula'], 10);
    addFeed(store, dayStart, ['formula'], 20);
    addFeed(store, dayEnd - 1, ['formula'], 30);
    addFeed(store, dayEnd, ['formula'], 40);

    const state = buildState(store, NOW, TZ);
    assert.equal(state.today.date, '2026-11-13');
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 50);
  });

  test('tzOffset 省略 / null：使用服务器本地时区，且与 getTimezoneOffset 结果一致', (t) => {
    const store = makeStore(t);
    const localNow = new Date(NOW);
    const localStart = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate(),
    ).getTime();
    const localEnd = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate() + 1,
    ).getTime();
    addFeed(store, localStart - 1, ['formula'], 10);
    addFeed(store, localStart, ['formula'], 20);
    addFeed(store, localEnd - 1, ['formula'], 30);
    addFeed(store, localEnd, ['formula'], 40);

    const expectedDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(
      localNow.getDate(),
    ).padStart(2, '0')}`;

    for (const tz of [undefined, null]) {
      const state = buildState(store, NOW, tz);
      assert.equal(state.today.date, expectedDate);
      assert.equal(state.today.feedCount, 2);
      assert.equal(state.today.totalMl, 50);
    }
    // 显式传入服务器本地 offset，结果应与省略一致
    const localOffset = localNow.getTimezoneOffset();
    assert.deepEqual(buildState(store, NOW, localOffset).today, buildState(store, NOW, null).today);
  });

  test('tzOffset 非法 / now 非法抛 RangeError（防御性）', (t) => {
    const store = makeStore(t);
    for (const bad of [900, -900, 1.5, NaN, '480']) {
      assert.throws(() => buildState(store, NOW, bad), RangeError, `tzOffset=${String(bad)} 应抛 RangeError`);
    }
    assert.throws(() => buildState(store, NaN, 0), RangeError);
  });
});

describe('buildState · recent 排序与上限', () => {
  test('最近 30 条，按 happenedAt DESC, id DESC', (t) => {
    const store = makeStore(t);
    const base = SH_DAY_START + 60_000;
    for (let i = 0; i < 35; i += 1) {
      addFeed(store, base + i * 1000, ['formula'], 10 + i);
    }

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.recent.length, 30);
    assert.deepEqual(
      state.recent.map((event) => event.id),
      Array.from({ length: 30 }, (_, index) => 35 - index),
      '应返回 id 35..6（最新 30 条）',
    );
    for (let i = 1; i < state.recent.length; i += 1) {
      const prev = state.recent[i - 1];
      const next = state.recent[i];
      assert.ok(
        prev.happenedAt > next.happenedAt || (prev.happenedAt === next.happenedAt && prev.id > next.id),
        'recent 排序应为 happenedAt DESC, id DESC',
      );
    }
  });

  test('同一毫秒的多条记录按 id DESC 排序', (t) => {
    const store = makeStore(t);
    const ts = SH_DAY_START + 5000;
    const first = addDiaper(store, ts, 'pee');
    const second = addDiaper(store, ts, 'poop');
    const third = addFeed(store, ts, ['breast_direct']);
    assert.ok(first.id < second.id && second.id < third.id);

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.deepEqual(
      state.recent.map((event) => event.id),
      [third.id, second.id, first.id],
    );
  });
});
