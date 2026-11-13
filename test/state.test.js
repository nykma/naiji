/**
 * src/state.js buildState() 测试（真实 Store + ':memory:' 数据库）
 *
 * 固定 now 与 tzOffset，避免依赖真实时间：
 *   NOW = 2026-11-13T04:00:00Z = 东八区 2026-11-13 12:00，
 *   东八区当天窗口 = [2026-11-12T16:00Z, 2026-11-13T16:00Z)。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { buildState } from '../src/state.js';

const TZ_SHANGHAI = -480;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const DAY_START = Date.UTC(2026, 10, 12, 16, 0, 0);
const DAY_END = Date.UTC(2026, 10, 13, 16, 0, 0);

/** 东八区 2026-11-13 本地 hh:mm → epoch ms（h < 8 时自动落到 UTC 前一天） */
function shanghai(h, min = 0) {
  return Date.UTC(2026, 10, 13, h - 8, min, 0, 0);
}

function makeStore(t) {
  const store = openDb(':memory:');
  t.after(() => store.close());
  return store;
}

/** 插入一条喂奶事件（亲喂 amountMl 强制为 null） */
function feed(store, happenedAt, { feedType = 'formula', amountMl = 120, note = null } = {}) {
  return store.createEvent({
    kind: 'feed',
    feedType,
    amountMl: feedType === 'breast_direct' ? null : amountMl,
    diaperKind: null,
    note,
    happenedAt,
    createdAt: NOW,
  });
}

/** 插入一条大小便事件 */
function diaper(store, happenedAt, diaperKind, note = null) {
  return store.createEvent({
    kind: 'diaper',
    feedType: null,
    amountMl: null,
    diaperKind,
    note,
    happenedAt,
    createdAt: NOW,
  });
}

const EMPTY_TODAY = {
  date: '2026-11-13',
  feedCount: 0,
  breastDirectCount: 0,
  formulaMl: 0,
  breastMl: 0,
  totalMl: 0,
  diaperCount: 0,
  peeCount: 0,
  poopCount: 0,
  mixedCount: 0,
};

describe('buildState · today 聚合（tzOffset = -480）', () => {
  test('各类喂奶/大小便计数与奶量正确，mixed 同时计入 pee 与 poop', (t) => {
    const store = makeStore(t);
    feed(store, shanghai(7), { amountMl: 120 });
    diaper(store, shanghai(8), 'pee');
    feed(store, shanghai(8, 30), { amountMl: 180 });
    diaper(store, shanghai(9), 'poop');
    feed(store, shanghai(9, 15), { feedType: 'breast_milk', amountMl: 90 });
    feed(store, shanghai(10, 30), { feedType: 'breast_direct' });
    diaper(store, shanghai(11), 'mixed');

    const state = buildState(store, NOW, TZ_SHANGHAI);

    assert.equal(state.now, NOW);
    assert.deepEqual(Object.keys(state).sort(), ['lastDiaper', 'lastFeeding', 'now', 'recent', 'today']);
    assert.deepEqual(state.today, {
      date: '2026-11-13',
      feedCount: 4,
      breastDirectCount: 1,
      formulaMl: 300,
      breastMl: 90,
      totalMl: 390,
      diaperCount: 3,
      peeCount: 2, // pee + mixed
      poopCount: 2, // poop + mixed
      mixedCount: 1,
    });
  });

  test('今天 0 点之前（昨天）的事件不计入 today，但仍是 lastFeeding/最近记录', (t) => {
    const store = makeStore(t);
    feed(store, DAY_START - 1, { amountMl: 500 });
    diaper(store, DAY_START - 60_000, 'pee');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.deepEqual(state.today, EMPTY_TODAY);
    assert.equal(state.lastFeeding.amountMl, 500);
    assert.equal(state.lastDiaper.diaperKind, 'pee');
    assert.equal(state.recent.length, 2);
  });

  test('次日 0 点及之后的事件不计入 today', (t) => {
    const store = makeStore(t);
    feed(store, DAY_END, { amountMl: 999 });
    diaper(store, DAY_END + 1_000, 'mixed');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.deepEqual(state.today, EMPTY_TODAY);
    assert.equal(state.recent.length, 2);
  });

  test('窗口边界：DAY_START 计入，DAY_END 之前的 1ms 计入，DAY_END 不计入', (t) => {
    const store = makeStore(t);
    feed(store, DAY_START, { amountMl: 100 });
    feed(store, DAY_END - 1, { amountMl: 50 });
    feed(store, DAY_END, { amountMl: 999 });
    diaper(store, DAY_START, 'pee');
    diaper(store, DAY_END, 'poop');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.deepEqual(state.today, {
      ...EMPTY_TODAY,
      feedCount: 2,
      formulaMl: 150,
      totalMl: 150,
      diaperCount: 1,
      peeCount: 1,
    });
  });

  test('tzOffset = 0（UTC）只统计 UTC 当天', (t) => {
    const store = makeStore(t);
    feed(store, Date.UTC(2026, 10, 12, 23, 30), { amountMl: 999 }); // UTC 前一天
    feed(store, Date.UTC(2026, 10, 13, 0, 0), { amountMl: 100 }); // UTC 当天 0 点
    feed(store, Date.UTC(2026, 10, 13, 3, 59), { amountMl: 40 }); // UTC 当天
    diaper(store, Date.UTC(2026, 10, 13, 12, 0), 'pee'); // UTC 当天

    const state = buildState(store, NOW, 0);
    assert.deepEqual(state.today, {
      ...EMPTY_TODAY,
      feedCount: 2,
      formulaMl: 140,
      totalMl: 140,
      diaperCount: 1,
      peeCount: 1,
    });
  });

  test('省略 tzOffset 时按服务器本地时区（用本地构造时间验证，不假设时区）', (t) => {
    const store = makeStore(t);
    const nowLocal = new Date(2026, 5, 15, 12, 0, 0, 0).getTime(); // 本地 2026-06-15 12:00
    const localStart = new Date(2026, 5, 15, 0, 0, 0, 0).getTime();
    const localEnd = new Date(2026, 5, 16, 0, 0, 0, 0).getTime();
    feed(store, localStart + 1_000, { amountMl: 100 }); // 本地当天
    feed(store, localStart - 1, { amountMl: 999 }); // 本地前一天最后一毫秒
    feed(store, localEnd, { amountMl: 999 }); // 本地次日 0 点

    const state = buildState(store, nowLocal);
    assert.equal(state.today.date, '2026-06-15');
    assert.equal(state.today.feedCount, 1);
    assert.equal(state.today.formulaMl, 100);
    assert.equal(state.today.totalMl, 100);
  });
});

describe('buildState · lastFeeding / lastDiaper', () => {
  test('取最近一条 feed（含亲喂）与最近一条 diaper，互相独立', (t) => {
    const store = makeStore(t);
    feed(store, shanghai(9), { amountMl: 180 });
    feed(store, shanghai(7), { amountMl: 120 });
    const direct = feed(store, shanghai(10), { feedType: 'breast_direct' });
    diaper(store, shanghai(8), 'mixed');
    const latestDiaper = diaper(store, shanghai(11), 'poop');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.lastFeeding.id, direct.id);
    assert.equal(state.lastFeeding.feedType, 'breast_direct');
    assert.equal(state.lastFeeding.happenedAt, shanghai(10));
    assert.equal(state.lastDiaper.id, latestDiaper.id);
    assert.equal(state.lastDiaper.diaperKind, 'poop');
    assert.equal(state.lastDiaper.happenedAt, shanghai(11));
  });

  test('无数据时均为 null，recent 为空数组', (t) => {
    const store = makeStore(t);
    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.lastFeeding, null);
    assert.equal(state.lastDiaper, null);
    assert.deepEqual(state.recent, []);
    assert.deepEqual(state.today, EMPTY_TODAY);
  });

  test('同一 happenedAt 时取 id 更大（后插入）的一条', (t) => {
    const store = makeStore(t);
    const tie = shanghai(9);
    feed(store, tie, { amountMl: 120 });
    const second = feed(store, tie, { amountMl: 180 });
    diaper(store, tie, 'pee');
    const secondDiaper = diaper(store, tie, 'poop');

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.lastFeeding.id, second.id);
    assert.equal(state.lastDiaper.id, secondDiaper.id);
  });
});

describe('buildState · recent', () => {
  test('最多 30 条，按 happenedAt DESC, id DESC', (t) => {
    const store = makeStore(t);
    const BASE = shanghai(0); // 东八区当天 00:00
    const ids = [];
    for (let i = 0; i < 35; i += 1) {
      const happenedAt = BASE + i * 1_000;
      const event = i % 3 === 0 ? diaper(store, happenedAt, 'pee') : feed(store, happenedAt, { amountMl: 60 + i });
      ids.push(event.id);
    }

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.recent.length, 30);
    // 期望：i = 34 最新的 30 条 → i 从 34 递减到 5
    assert.deepEqual(
      state.recent.map((event) => event.happenedAt),
      Array.from({ length: 30 }, (_, index) => BASE + (34 - index) * 1_000),
    );
    assert.equal(state.recent[0].id, ids[34]);
    assert.equal(state.recent[29].id, ids[5]);
    assert.equal(new Set(state.recent.map((event) => event.id)).size, 30);
  });

  test('同一 happenedAt 的多条事件按 id DESC（后插入在前）', (t) => {
    const store = makeStore(t);
    const tie = shanghai(9);
    feed(store, tie, { amountMl: 120 });
    feed(store, tie, { amountMl: 150 });
    const third = feed(store, tie, { amountMl: 180 });

    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.deepEqual(
      state.recent.map((event) => event.id),
      [third.id, third.id - 1, third.id - 2],
    );
    assert.ok(state.recent.every((event) => event.happenedAt === tie));
  });

  test('recent 是全局最近记录（包含昨天等非今天事件）', (t) => {
    const store = makeStore(t);
    const yesterday = feed(store, DAY_START - 60_000, { amountMl: 200 });
    const state = buildState(store, NOW, TZ_SHANGHAI);
    assert.equal(state.recent.length, 1);
    assert.equal(state.recent[0].id, yesterday.id);
    assert.deepEqual(state.today, EMPTY_TODAY);
  });
});
