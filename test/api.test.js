/**
 * HTTP API 集成测试（v2）。
 *
 * 每个用例用 fs.mkdtemp 临时目录 + :memory-free 文件 DB + listen(0) 随机端口，
 * 注入固定 now，结束后 close + 清理；不写仓库 data/，可并行重复运行。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/src/server.js';

const NOW = Date.UTC(2026, 10, 13, 4, 0, 0); // 2026-11-13T04:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TZ_SHANGHAI = -480;
const SH_DAY_START = Date.UTC(2026, 10, 12, 16, 0, 0); // 东八区 2026-11-13 00:00
const SH_DAY_END = Date.UTC(2026, 10, 13, 16, 0, 0); // 东八区 2026-11-14 00:00

const INDEX_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>奶记</title></head><body><div id="app">奶记测试页</div><script type="module" src="/app.js"></script></body></html>';
const APP_JS = 'export const marker = "naiji-test-app";\n';
const STYLE_CSS = 'body { color: #333; }\n';
const SUB_PAGE = '<!doctype html><html><body>sub page</body></html>';

/** 启动临时应用，返回 { url, app, dir }；测试结束自动关闭并删除目录 */
async function startApp(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'naiji-api-'));
  const webDir = path.join(dir, 'web');
  mkdirSync(path.join(webDir, 'sub'), { recursive: true });
  writeFileSync(path.join(webDir, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(webDir, 'app.js'), APP_JS);
  writeFileSync(path.join(webDir, 'style.css'), STYLE_CSS);
  writeFileSync(path.join(webDir, 'sub', 'page.html'), SUB_PAGE);

  const app = createApp({
    dbPath: path.join(dir, 'baby.db'),
    webDir,
    serveWeb: true,
    now: () => NOW,
    ...options,
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, url, dir, webDir };
}

function postJson(base, pathname, body, extraHeaders = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const postFeeding = (base, body, headers) => postJson(base, '/api/feedings', body, headers);
const postDiaper = (base, body, headers) => postJson(base, '/api/diapers', body, headers);
const getJson = (base, pathname) => fetch(`${base}${pathname}`);

/** 断言错误响应：状态码 + 错误码 + 非空中文 message */
async function assertError(res, status, code) {
  assert.equal(res.status, status, `期望状态码 ${status}，实际 ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  const body = await res.json();
  assert.equal(body.error, code);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0, 'message 不能为空');
  return body;
}

function expectedFeedEvent({ id, feedTypes, amountMl, note = null, happenedAt }) {
  return {
    id,
    kind: 'feed',
    feedTypes,
    amountMl,
    diaperKind: null,
    note,
    happenedAt,
    createdAt: NOW,
  };
}

function expectedDiaperEvent({ id, diaperKind, note = null, happenedAt }) {
  return {
    id,
    kind: 'diaper',
    feedTypes: null,
    amountMl: null,
    diaperKind,
    note,
    happenedAt,
    createdAt: NOW,
  };
}

/** 直接通过 Store 造数据（用于构造 API 校验不允许的边界时间/批量数据） */
function seedFeed(store, happenedAt, feedTypes, amountMl = null, note = null) {
  return store.createFeedEvent({ feedTypes, amountMl, note, happenedAt, createdAt: NOW });
}

function seedDiaper(store, happenedAt, diaperKind, note = null) {
  return store.createDiaperEvent({ diaperKind, note, happenedAt, createdAt: NOW });
}

// ---------------------------------------------------------------------------
// 健康检查 / 404
// ---------------------------------------------------------------------------

describe('基础路由', () => {
  test('GET /api/health → 200 { ok: true }，JSON + no-store + nosniff', async (t) => {
    const { url } = await startApp(t);
    const res = await fetch(`${url}/api/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('未知 /api 路径 → 404 not_found；/api 前缀之外的静态路径不返回 JSON 404', async (t) => {
    const { url } = await startApp(t);
    await assertError(await getJson(url, '/api/nope'), 404, 'not_found');
    await assertError(await getJson(url, '/api/events/extra/segments'), 404, 'not_found');
  });
});

// ---------------------------------------------------------------------------
// POST /api/feedings · 成功
// ---------------------------------------------------------------------------

describe('POST /api/feedings · 成功', () => {
  test('多标签（乱序入参）成功，返回规范顺序，备注 trim，createdAt=now', async (t) => {
    const { url } = await startApp(t);
    const happenedAt = NOW - HOUR;
    const res = await postFeeding(url, {
      feedTypes: ['breast_milk', 'formula'],
      amountMl: 120,
      note: '  夜里那次  ',
      happenedAt,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(Number.isInteger(body.event.id) && body.event.id > 0);
    assert.deepEqual(
      body.event,
      expectedFeedEvent({
        id: body.event.id,
        feedTypes: ['formula', 'breast_milk'],
        amountMl: 120,
        note: '夜里那次',
        happenedAt,
      }),
    );
  });

  test('v1 旧式 feedType 兼容归一化（formula 带奶量）', async (t) => {
    const { url } = await startApp(t);
    const happenedAt = NOW - 2 * HOUR;
    const res = await postFeeding(url, { feedType: 'formula', amountMl: 150, happenedAt });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(
      body.event,
      expectedFeedEvent({ id: body.event.id, feedTypes: ['formula'], amountMl: 150, happenedAt }),
    );
  });

  test('v1 旧式 feedType=breast_direct 兼容（无奶量）', async (t) => {
    const { url } = await startApp(t);
    const res = await postFeeding(url, { feedType: 'breast_direct' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(
      body.event,
      expectedFeedEvent({ id: body.event.id, feedTypes: ['breast_direct'], amountMl: null, happenedAt: NOW }),
    );
  });

  test('仅亲喂：省略 amountMl / 显式 null 均成功且 amountMl 为 null', async (t) => {
    const { url } = await startApp(t);
    const omitted = await postFeeding(url, { feedTypes: ['breast_direct'], happenedAt: NOW - 2 * MINUTE });
    assert.equal(omitted.status, 201);
    const omittedBody = await omitted.json();
    assert.equal(omittedBody.event.amountMl, null);
    assert.deepEqual(omittedBody.event.feedTypes, ['breast_direct']);

    const explicitNull = await postFeeding(url, {
      feedTypes: ['breast_direct'],
      amountMl: null,
      happenedAt: NOW - MINUTE,
    });
    assert.equal(explicitNull.status, 201);
    assert.equal((await explicitNull.json()).event.amountMl, null);
  });

  test('亲喂 + 奶粉带奶量成功（混合），标签规范顺序', async (t) => {
    const { url } = await startApp(t);
    const res = await postFeeding(url, {
      feedTypes: ['breast_direct', 'formula'],
      amountMl: 60,
      happenedAt: NOW - 3 * MINUTE,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(
      body.event,
      expectedFeedEvent({
        id: body.event.id,
        feedTypes: ['formula', 'breast_direct'],
        amountMl: 60,
        happenedAt: NOW - 3 * MINUTE,
      }),
    );
  });

  test('三个标签 + 奶量上限 2000 成功', async (t) => {
    const { url } = await startApp(t);
    const res = await postFeeding(url, {
      feedTypes: ['breast_direct', 'breast_milk', 'formula'],
      amountMl: 2000,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.event.feedTypes, ['formula', 'breast_milk', 'breast_direct']);
    assert.equal(body.event.amountMl, 2000);
    assert.equal(body.event.note, null);
    assert.equal(body.event.happenedAt, NOW);
    assert.equal(body.event.createdAt, NOW);
  });

  test('奶量下限 1 成功', async (t) => {
    const { url } = await startApp(t);
    const res = await postFeeding(url, { feedTypes: ['breast_milk'], amountMl: 1 });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).event.amountMl, 1);
  });

  test('happenedAt 边界：最小 2000-01-01 与 now+5min 均接受', async (t) => {
    const { url } = await startApp(t);
    const min = Date.UTC(2000, 0, 1);
    const maxFuture = NOW + 5 * MINUTE;
    const r1 = await postFeeding(url, { feedTypes: ['formula'], amountMl: 10, happenedAt: min });
    assert.equal(r1.status, 201);
    const r2 = await postFeeding(url, { feedTypes: ['formula'], amountMl: 10, happenedAt: maxFuture });
    assert.equal(r2.status, 201);
  });

  test('备注边界：trim 后 200 字符接受；纯空白 → null', async (t) => {
    const { url } = await startApp(t);
    const exact = 'x'.repeat(200);
    const res = await postFeeding(url, {
      feedTypes: ['formula'],
      amountMl: 10,
      note: `  ${exact}  `,
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).event.note, exact);

    const blank = await postFeeding(url, { feedTypes: ['formula'], amountMl: 10, note: '   ' });
    assert.equal(blank.status, 201);
    assert.equal((await blank.json()).event.note, null);
  });

  test('创建后 GET /api/events 能读到该记录', async (t) => {
    const { url } = await startApp(t);
    const created = await (
      await postFeeding(url, { feedTypes: ['formula'], amountMl: 120, note: '可见' })
    ).json();
    const res = await getJson(url, '/api/events');
    assert.equal(res.status, 200);
    const { events } = await res.json();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], created.event);
  });
});

// ---------------------------------------------------------------------------
// POST /api/feedings · 校验错误
// ---------------------------------------------------------------------------

describe('POST /api/feedings · 校验错误', () => {
  test('invalid_feed_types：空 / 重复 / 未知 / 超 3 个 / 非数组', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      ['缺少 feedTypes 与 feedType', { amountMl: 120 }],
      ['空数组', { feedTypes: [], amountMl: 120 }],
      ['feedTypes 为 null', { feedTypes: null, amountMl: 120 }],
      ['重复标签', { feedTypes: ['formula', 'formula'], amountMl: 120 }],
      ['未知标签', { feedTypes: ['formula', 'juice'], amountMl: 120 }],
      ['超过 3 个', { feedTypes: ['formula', 'breast_milk', 'breast_direct', 'formula'], amountMl: 120 }],
      ['非数组（数字）', { feedTypes: 123, amountMl: 120 }],
      ['非数组（对象）', { feedTypes: { formula: true }, amountMl: 120 }],
      ['v1 feedType 非字符串', { feedType: 42, amountMl: 120 }],
    ];
    for (const [name, body] of cases) {
      const res = await postFeeding(url, body);
      assert.equal(res.status, 400, `${name} 应返回 400`);
      const parsed = await res.json();
      assert.equal(parsed.error, 'invalid_feed_types', `${name} 错误码不对`);
    }
    // 没有产生任何记录
    const { events } = await (await getJson(url, '/api/events')).json();
    assert.deepEqual(events, []);
  });

  test('invalid_amount：缺失 / 0 / 2001 / 负数 / 小数 / 字符串 / 布尔', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      ['formula 缺奶量', { feedTypes: ['formula'] }],
      ['formula 奶量 null', { feedTypes: ['formula'], amountMl: null }],
      ['0', { feedTypes: ['formula'], amountMl: 0 }],
      ['2001', { feedTypes: ['formula'], amountMl: 2001 }],
      ['负数', { feedTypes: ['formula'], amountMl: -5 }],
      ['小数', { feedTypes: ['formula'], amountMl: 1.5 }],
      ['字符串', { feedTypes: ['formula'], amountMl: '120' }],
      ['布尔', { feedTypes: ['formula'], amountMl: true }],
      ['breast_milk 缺奶量', { feedTypes: ['breast_milk'] }],
      ['formula+direct 缺奶量', { feedTypes: ['formula', 'breast_direct'] }],
      ['v1 兼容缺奶量', { feedType: 'formula' }],
    ];
    for (const [name, body] of cases) {
      const res = await postFeeding(url, body);
      const parsed = await res.json();
      assert.equal(res.status, 400, `${name} 应返回 400，实际 ${res.status}`);
      assert.equal(parsed.error, 'invalid_amount', `${name} 错误码不对`);
    }
  });

  test('unexpected_amount：仅亲喂带任何非 null 奶量都不允许', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      { feedTypes: ['breast_direct'], amountMl: 120 },
      { feedTypes: ['breast_direct'], amountMl: 0 },
      { feedType: 'breast_direct', amountMl: 90 },
    ];
    for (const body of cases) {
      const res = await postFeeding(url, body);
      await assertError(res, 400, 'unexpected_amount');
    }
  });

  test('invalid_happened_at：字符串 / 太早 / 未来超过 5 分钟 / 小数 / 布尔', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      ['字符串', '昨天'],
      ['太早（1999）', Date.UTC(1999, 11, 31, 23, 59, 59)],
      ['未来 5 分钟 + 1ms', NOW + 5 * MINUTE + 1],
      ['小数', 1.5],
      ['布尔', true],
      ['负数', -1000],
    ];
    for (const [name, happenedAt] of cases) {
      const res = await postFeeding(url, { feedTypes: ['formula'], amountMl: 120, happenedAt });
      const parsed = await res.json();
      assert.equal(res.status, 400, `${name} 应返回 400`);
      assert.equal(parsed.error, 'invalid_happened_at', `${name} 错误码不对`);
    }
  });

  test('invalid_note：超过 200 字符 / 非字符串', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      ['201 字符', 'x'.repeat(201)],
      ['201 字符（带空格）', `  ${'x'.repeat(201)}  `],
      ['数字', 123],
      ['对象', { text: 'hi' }],
      ['数组', ['hi']],
    ];
    for (const [name, note] of cases) {
      const res = await postFeeding(url, { feedTypes: ['formula'], amountMl: 120, note });
      const parsed = await res.json();
      assert.equal(res.status, 400, `${name} 应返回 400`);
      assert.equal(parsed.error, 'invalid_note', `${name} 错误码不对`);
    }
  });

  test('invalid_json：空 body / 坏 JSON / 数组 / null / 字符串 / 数字', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      ['空 body', ''],
      ['空白 body', '   '],
      ['坏 JSON', '{"feedTypes":['],
      ['数组', '[]'],
      ['null', 'null'],
      ['字符串', '"formula"'],
      ['数字', '42'],
      ['布尔', 'true'],
    ];
    for (const [name, raw] of cases) {
      const res = await postFeeding(url, raw);
      const parsed = await res.json();
      assert.equal(res.status, 400, `${name} 应返回 400`);
      assert.equal(parsed.error, 'invalid_json', `${name} 错误码不对`);
    }
  });

  test('415：非 application/json / 缺 Content-Type', async (t) => {
    const { url } = await startApp(t);

    const textPlain = await fetch(`${url}/api/feedings`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ feedTypes: ['formula'], amountMl: 120 }),
    });
    await assertError(textPlain, 415, 'unsupported_media_type');

    const form = await fetch(`${url}/api/feedings`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'feedType=formula',
    });
    await assertError(form, 415, 'unsupported_media_type');

    // fetch 对字符串 body 自动加 text/plain → 415
    const noHeader = await fetch(`${url}/api/feedings`, {
      method: 'POST',
      body: JSON.stringify({ feedTypes: ['formula'], amountMl: 120 }),
    });
    await assertError(noHeader, 415, 'unsupported_media_type');
  });

  test('413：请求体超过 64KB', async (t) => {
    const { url } = await startApp(t);
    const big = JSON.stringify({ feedTypes: ['formula'], amountMl: 120, note: 'x'.repeat(70 * 1024) });
    assert.ok(Buffer.byteLength(big) > 64 * 1024);
    const res = await postFeeding(url, big);
    await assertError(res, 413, 'payload_too_large');
  });
});

// ---------------------------------------------------------------------------
// POST /api/diapers
// ---------------------------------------------------------------------------

describe('POST /api/diapers', () => {
  test('三种类型均成功，事件字段正确', async (t) => {
    const { url } = await startApp(t);
    const cases = [
      { diaperKind: 'pee', happenedAt: NOW - 3 * HOUR, note: null },
      { diaperKind: 'poop', happenedAt: NOW - 2 * HOUR, note: '拉臭臭' },
      { diaperKind: 'mixed', happenedAt: NOW - HOUR, note: ' 一次搞定 ' },
    ];
    for (const input of cases) {
      const res = await postDiaper(url, input);
      assert.equal(res.status, 201, `${input.diaperKind} 应成功`);
      const body = await res.json();
      assert.deepEqual(
        body.event,
        expectedDiaperEvent({
          id: body.event.id,
          diaperKind: input.diaperKind,
          note: input.note === null ? null : input.note.trim(),
          happenedAt: input.happenedAt,
        }),
      );
    }
  });

  test('省略 happenedAt / note 时默认 now / null', async (t) => {
    const { url } = await startApp(t);
    const res = await postDiaper(url, { diaperKind: 'pee' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.event.happenedAt, NOW);
    assert.equal(body.event.createdAt, NOW);
    assert.equal(body.event.note, null);
    assert.equal(body.event.kind, 'diaper');
    assert.equal(body.event.feedTypes, null);
    assert.equal(body.event.amountMl, null);
  });

  test('invalid_diaper_kind：缺失 / 未知 / 大小写错误 / 非字符串', async (t) => {
    const { url } = await startApp(t);
    for (const body of [
      {},
      { diaperKind: 'both' },
      { diaperKind: 'PEE' },
      { diaperKind: 123 },
      { diaperKind: null },
    ]) {
      const res = await postDiaper(url, body);
      await assertError(res, 400, 'invalid_diaper_kind');
    }
  });

  test('diapers 同样校验 happenedAt / note / JSON / 415', async (t) => {
    const { url } = await startApp(t);
    await assertError(
      await postDiaper(url, { diaperKind: 'pee', happenedAt: '昨天' }),
      400,
      'invalid_happened_at',
    );
    await assertError(await postDiaper(url, { diaperKind: 'pee', note: 'x'.repeat(201) }), 400, 'invalid_note');
    await assertError(await postDiaper(url, '{bad json'), 400, 'invalid_json');
    const wrongType = await fetch(`${url}/api/diapers`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    await assertError(wrongType, 415, 'unsupported_media_type');
  });
});

// ---------------------------------------------------------------------------
// GET /api/state
// ---------------------------------------------------------------------------

describe('GET /api/state', () => {
  test('空库：today 全 0、last* null、recent 空、now 为注入值', async (t) => {
    const { url } = await startApp(t);
    const res = await getJson(url, `/api/state?tzOffset=${TZ_SHANGHAI}`);
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.now, NOW);
    assert.deepEqual(state.today, {
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
    });
    assert.equal(state.lastFeeding, null);
    assert.equal(state.lastDiaper, null);
    assert.deepEqual(state.recent, []);
  });

  test('tzOffset=-480：POST 写入后聚合 / last* / recent 正确', async (t) => {
    const { url } = await startApp(t);
    const sh = (hour, minute = 0) => Date.UTC(2026, 10, 13, hour - 8, minute, 0, 0);

    const created = [];
    created.push((await (await postFeeding(url, { feedTypes: ['formula'], amountMl: 120, happenedAt: sh(0) })).json()).event);
    created.push((await (await postFeeding(url, { feedTypes: ['breast_milk'], amountMl: 90, happenedAt: sh(7, 30) })).json()).event);
    created.push((await (await postFeeding(url, { feedTypes: ['breast_direct'], happenedAt: sh(8) })).json()).event);
    created.push(
      (await (await postFeeding(url, { feedTypes: ['formula', 'breast_direct'], amountMl: 60, happenedAt: sh(9) })).json()).event,
    );
    created.push((await (await postDiaper(url, { diaperKind: 'pee', happenedAt: sh(10) })).json()).event);
    created.push((await (await postDiaper(url, { diaperKind: 'mixed', happenedAt: sh(10, 30) })).json()).event);
    created.push((await (await postDiaper(url, { diaperKind: 'poop', happenedAt: sh(11) })).json()).event);

    const state = await (await getJson(url, `/api/state?tzOffset=${TZ_SHANGHAI}`)).json();
    assert.equal(state.now, NOW);
    assert.deepEqual(state.today, {
      date: '2026-11-13',
      feedCount: 4,
      totalMl: 270,
      formulaCount: 2,
      breastMilkCount: 1,
      breastDirectCount: 2,
      mixedFeedCount: 1,
      diaperCount: 3,
      peeCount: 2,
      poopCount: 2,
      mixedCount: 1,
    });
    assert.deepEqual(state.lastFeeding, created[3]);
    assert.deepEqual(state.lastDiaper, created[6]);
    assert.equal(state.recent.length, 7);
    assert.deepEqual(
      state.recent.map((event) => event.id),
      [created[6].id, created[5].id, created[4].id, created[3].id, created[2].id, created[1].id, created[0].id],
    );
  });

  test('tzOffset=0：按 UTC 当天窗口聚合', async (t) => {
    const { url, app } = await startApp(t);
    seedFeed(app.store, Date.UTC(2026, 10, 13, 0, 0) - 1, ['formula'], 10); // UTC 前一天
    seedFeed(app.store, Date.UTC(2026, 10, 13, 0, 0), ['formula'], 20); // UTC 当天 00:00
    seedFeed(app.store, Date.UTC(2026, 10, 13, 1, 0), ['formula'], 30); // UTC 当天
    seedFeed(app.store, Date.UTC(2026, 10, 14, 0, 0), ['formula'], 40); // UTC 后一天

    const state = await (await getJson(url, '/api/state?tzOffset=0')).json();
    assert.equal(state.today.date, '2026-11-13');
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 50);
  });

  test('tzOffset=840 / -840：极端时区窗口与日期正确', async (t) => {
    // UTC−14（tzOffset=840）：NOW 本地 2026-11-12 14:00
    {
      const { url, app } = await startApp(t);
      const dayStart = Date.UTC(2026, 10, 12, 14, 0, 0);
      seedFeed(app.store, dayStart - 1, ['formula'], 10);
      seedFeed(app.store, dayStart, ['formula'], 20);
      seedFeed(app.store, dayStart + DAY - 1, ['formula'], 30);
      seedFeed(app.store, dayStart + DAY, ['formula'], 40);
      const state = await (await getJson(url, '/api/state?tzOffset=840')).json();
      assert.equal(state.today.date, '2026-11-12');
      assert.equal(state.today.feedCount, 2);
      assert.equal(state.today.totalMl, 50);
    }
    // UTC+14（tzOffset=-840）：NOW 本地 2026-11-13 18:00
    {
      const { url, app } = await startApp(t);
      const dayStart = Date.UTC(2026, 10, 12, 10, 0, 0);
      seedFeed(app.store, dayStart - 1, ['formula'], 10);
      seedFeed(app.store, dayStart, ['formula'], 20);
      seedFeed(app.store, dayStart + DAY - 1, ['formula'], 30);
      seedFeed(app.store, dayStart + DAY, ['formula'], 40);
      const state = await (await getJson(url, '/api/state?tzOffset=-840')).json();
      assert.equal(state.today.date, '2026-11-13');
      assert.equal(state.today.feedCount, 2);
      assert.equal(state.today.totalMl, 50);
    }
  });

  test('省略 tzOffset：使用服务器本地时区', async (t) => {
    const { url, app } = await startApp(t);
    const d = new Date(NOW);
    const localStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const localEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    seedFeed(app.store, localStart - 1, ['formula'], 10);
    seedFeed(app.store, localStart, ['formula'], 20);
    seedFeed(app.store, localEnd - 1, ['formula'], 30);
    seedFeed(app.store, localEnd, ['formula'], 40);

    const state = await (await getJson(url, '/api/state')).json();
    const expectedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    assert.equal(state.today.date, expectedDate);
    assert.equal(state.today.feedCount, 2);
    assert.equal(state.today.totalMl, 50);
  });

  test('非法 tzOffset → 400 invalid_tz_offset', async (t) => {
    const { url } = await startApp(t);
    for (const raw of ['abc', '1.5', '900', '-841', '', ' 480', '+480', 'NaN']) {
      const res = await getJson(url, `/api/state?tzOffset=${encodeURIComponent(raw)}`);
      await assertError(res, 400, 'invalid_tz_offset');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/events（limit 与复合游标）
// ---------------------------------------------------------------------------

describe('GET /api/events · limit', () => {
  test('默认 limit=50，1 / 200 边界，排序 happenedAt DESC, id DESC', async (t) => {
    const { url, app } = await startApp(t);
    const base = SH_DAY_START + 60_000;
    for (let i = 0; i < 55; i += 1) {
      seedFeed(app.store, base + i * 1000, ['formula'], 10 + i);
    }

    const def = await (await getJson(url, '/api/events')).json();
    assert.equal(def.events.length, 50);
    assert.deepEqual(
      def.events.map((event) => event.id),
      Array.from({ length: 50 }, (_, index) => 55 - index),
    );

    const one = await (await getJson(url, '/api/events?limit=1')).json();
    assert.equal(one.events.length, 1);
    assert.equal(one.events[0].id, 55);

    const twoHundred = await (await getJson(url, '/api/events?limit=200')).json();
    assert.equal(twoHundred.events.length, 55);

    const seven = await (await getJson(url, '/api/events?limit=7')).json();
    assert.equal(seven.events.length, 7);
  });

  test('非法 limit → 400 invalid_limit', async (t) => {
    const { url } = await startApp(t);
    for (const raw of ['0', '201', '-1', 'abc', '', '1.5', '001']) {
      // '001' 是正则接受的整数写法，值为 1，单独处理
      const res = await getJson(url, `/api/events?limit=${raw === '' ? '' : encodeURIComponent(raw)}`);
      if (raw === '001') {
        assert.equal(res.status, 200, '前导零的整数写法应被接受');
        await res.json();
      } else {
        await assertError(res, 400, 'invalid_limit');
      }
    }
  });
});

describe('GET /api/events · 游标分页', () => {
  test('只传 before 时严格 happened_at < before', async (t) => {
    const { url, app } = await startApp(t);
    const T = SH_DAY_START + 10_000;
    const older = seedFeed(app.store, T - 1, ['formula'], 10);
    const same1 = seedFeed(app.store, T, ['formula'], 20);
    seedFeed(app.store, T, ['formula'], 30);

    const strict = await (await getJson(url, `/api/events?before=${T}`)).json();
    assert.deepEqual(strict.events.map((event) => event.id), [older.id]);
    assert.ok(strict.events.every((event) => event.happenedAt < T));

    const inclusiveLook = await (await getJson(url, `/api/events?before=${T + 1}`)).json();
    assert.equal(inclusiveLook.events.length, 3);
    assert.equal(inclusiveLook.events[0].happenedAt, T);
    assert.equal(inclusiveLook.events[0].id, same1.id + 1);
  });

  test('复合游标（before + beforeId）同毫秒翻页不丢不重', async (t) => {
    const { url, app } = await startApp(t);
    const T = SH_DAY_START + 20_000;
    const created = [];
    // 同毫秒 5 条 + 相邻毫秒若干，混合排序
    for (let i = 0; i < 5; i += 1) created.push(seedFeed(app.store, T, ['formula'], 10 + i));
    created.push(seedFeed(app.store, T - 1, ['formula'], 100));
    created.push(seedFeed(app.store, T + 1, ['formula'], 200));

    const expectedIds = [...created].sort((a, b) => b.happenedAt - a.happenedAt || b.id - a.id).map((event) => event.id);
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const query = cursor
        ? `?limit=2&before=${cursor.happenedAt}&beforeId=${cursor.id}`
        : '?limit=2';
      const page = await (await getJson(url, `/api/events${query}`)).json();
      if (page.events.length === 0) break;
      seen.push(...page.events.map((event) => event.id));
      const last = page.events[page.events.length - 1];
      cursor = { happenedAt: last.happenedAt, id: last.id };
    }
    assert.deepEqual(seen, expectedIds, '翻页结果应完整、无重复、顺序一致');
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, created.length);
  });

  test('复合游标同毫秒：id 严格小于 beforeId', async (t) => {
    const { url, app } = await startApp(t);
    const T = SH_DAY_START + 30_000;
    const events = [];
    for (let i = 0; i < 4; i += 1) events.push(seedDiaper(app.store, T, 'pee'));
    const third = events[2];
    const page = await (await getJson(url, `/api/events?before=${T}&beforeId=${third.id}`)).json();
    assert.deepEqual(
      page.events.map((event) => event.id),
      [events[1].id, events[0].id],
    );
    assert.ok(page.events.every((event) => event.id < third.id));
  });

  test('非法游标 → 400 invalid_cursor；beforeId 单独出现时忽略', async (t) => {
    const { url } = await startApp(t);
    for (const query of [
      '?before=abc',
      '?before=-1',
      '?before=1.5',
      `?before=${SH_DAY_START}&beforeId=x`,
      `?before=${SH_DAY_START}&beforeId=-2`,
    ]) {
      const res = await getJson(url, `/api/events${query}`);
      await assertError(res, 400, 'invalid_cursor');
    }
    const ignored = await getJson(url, '/api/events?beforeId=5');
    assert.equal(ignored.status, 200);
    assert.deepEqual((await ignored.json()).events, []);
  });

  test('before 早于所有记录时返回空数组', async (t) => {
    const { url, app } = await startApp(t);
    seedFeed(app.store, SH_DAY_START + 1000, ['formula'], 10);
    const page = await (await getJson(url, '/api/events?before=1')).json();
    assert.deepEqual(page.events, []);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/events/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/events/:id', () => {
  test('204 删除成功，再次删除 404，state 同步更新', async (t) => {
    const { url } = await startApp(t);
    const created = await (
      await postFeeding(url, { feedTypes: ['formula'], amountMl: 120, happenedAt: NOW - HOUR })
    ).json();
    const id = created.event.id;

    const del = await fetch(`${url}/api/events/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal(await del.text(), '');

    const after = await (await getJson(url, '/api/events')).json();
    assert.deepEqual(after.events, []);

    await assertError(await fetch(`${url}/api/events/${id}`, { method: 'DELETE' }), 404, 'not_found');
    await assertError(await fetch(`${url}/api/events/999999`, { method: 'DELETE' }), 404, 'not_found');

    const state = await (await getJson(url, `/api/state?tzOffset=${TZ_SHANGHAI}`)).json();
    assert.equal(state.today.feedCount, 0);
    assert.equal(state.today.totalMl, 0);
    assert.equal(state.lastFeeding, null);
    assert.deepEqual(state.recent, []);
  });

  test('只删除目标记录，其他记录保留', async (t) => {
    const { url } = await startApp(t);
    const e1 = (await (await postFeeding(url, { feedTypes: ['formula'], amountMl: 10, happenedAt: NOW - 2 * HOUR })).json()).event;
    const e2 = (await (await postFeeding(url, { feedTypes: ['breast_milk'], amountMl: 20, happenedAt: NOW - HOUR })).json()).event;

    assert.equal((await fetch(`${url}/api/events/${e1.id}`, { method: 'DELETE' })).status, 204);
    const { events } = await (await getJson(url, '/api/events')).json();
    assert.deepEqual(events.map((event) => event.id), [e2.id]);
  });

  test('非法 id / 非 DELETE 方法', async (t) => {
    const { url } = await startApp(t);
    for (const pathname of ['/api/events/abc', '/api/events/0', '/api/events/-1', '/api/events/1.5', '/api/events/99999999999999999']) {
      const res = await fetch(`${url}${pathname}`, { method: 'DELETE' });
      assert.equal(res.status, 404, `${pathname} 应 404`);
      assert.equal((await res.json()).error, 'not_found');
    }
    // 已有 id 但用 POST → 405
    const created = await (await postFeeding(url, { feedTypes: ['formula'], amountMl: 10 })).json();
    const res = await postJson(url, `/api/events/${created.event.id}`, {});
    await assertError(res, 405, 'method_not_allowed');
  });
});

// ---------------------------------------------------------------------------
// CSV 导出
// ---------------------------------------------------------------------------

/** 极简 CSV 解析（支持引号、转义双引号、单元格内换行；CRLF 行分隔） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // 行分隔符的一部分，忽略
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('GET /api/export.csv', () => {
  test('BOM / 表头 / 多标签项目名 / 转义 / 升序 / 响应头', async (t) => {
    const { url } = await startApp(t);
    // 乱序写入，验证按 happenedAt ASC
    const t0 = NOW - 5 * HOUR;
    const t1 = NOW - 4 * HOUR;
    const t2 = NOW - 3 * HOUR;
    const t3 = NOW - 2 * HOUR;
    const t4 = NOW - HOUR;

    await postFeeding(url, { feedTypes: ['formula', 'breast_milk'], amountMl: 120, note: '夜里那次', happenedAt: t2 });
    await postFeeding(url, { feedTypes: ['formula'], amountMl: 60, note: '早些, 有"引号"', happenedAt: t0 });
    await postDiaper(url, { diaperKind: 'mixed', note: '换尿布', happenedAt: t3 });
    await postFeeding(url, { feedTypes: ['breast_direct'], happenedAt: t1 });
    await postFeeding(url, {
      feedTypes: ['breast_direct', 'formula'],
      amountMl: 45,
      note: '第一行, 和"引号"\n第二行',
      happenedAt: t4,
    });

    const res = await fetch(`${url}/api/export.csv`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const localDate = `${new Date(NOW).getFullYear()}-${String(new Date(NOW).getMonth() + 1).padStart(2, '0')}-${String(
      new Date(NOW).getDate(),
    ).padStart(2, '0')}`;
    assert.equal(
      res.headers.get('content-disposition'),
      `attachment; filename="baby-milk-${localDate}.csv"`,
    );

    const buffer = Buffer.from(await res.arrayBuffer());
    assert.ok(buffer.length > 3);
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 应以 UTF-8 BOM 开头');

    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const rows = parseCsv(text).filter((row) => row.length > 1 || row[0] !== '');
    assert.deepEqual(rows[0], ['时间', '类别', '项目', '奶量(ml)', '备注']);
    const dataRows = rows.slice(1);
    assert.equal(dataRows.length, 5, '应有 5 条数据行');

    for (const row of dataRows) {
      assert.equal(row.length, 5, `每行应有 5 列: ${JSON.stringify(row)}`);
      assert.match(row[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '时间格式应为 YYYY-MM-DD HH:mm');
    }

    // 升序：时间列字符串可直接比较（同格式）
    for (let i = 1; i < dataRows.length; i += 1) {
      assert.ok(dataRows[i - 1][0] <= dataRows[i][0], 'CSV 应按时间升序');
    }

    // 按时间升序：t0 奶粉 60 → t1 亲喂 → t2 奶粉+母乳 120 → t3 大小便 → t4 奶粉+亲喂 45
    assert.deepEqual(
      dataRows.map((row) => row.slice(1)),
      [
        ['喂奶', '奶粉', '60', '早些, 有"引号"'],
        ['喂奶', '亲喂', '', ''],
        ['喂奶', '奶粉 + 母乳（瓶喂）', '120', '夜里那次'],
        ['大小便', '大小便', '', '换尿布'],
        ['喂奶', '奶粉 + 亲喂', '45', '第一行, 和"引号"\n第二行'],
      ],
    );

    // 原始文本中引号按 RFC4180 双写
    assert.ok(text.includes('"早些, 有""引号"""'), '含逗号/引号单元格应用双引号包裹并双写引号');
    assert.ok(text.includes('\r\n'), '行分隔符应为 CRLF');
  });

  test('空库：仅 BOM + 表头', async (t) => {
    const { url } = await startApp(t);
    const res = await fetch(`${url}/api/export.csv`);
    assert.equal(res.status, 200);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    assert.equal(text, '时间,类别,项目,奶量(ml),备注\r\n');
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('CORS', () => {
  test('默认 *：API 响应带 Access-Control-Allow-Origin: *（带不带 Origin 都行）', async (t) => {
    const { url } = await startApp(t);
    const withOrigin = await fetch(`${url}/api/health`, { headers: { Origin: 'http://x.test' } });
    assert.equal(withOrigin.headers.get('access-control-allow-origin'), '*');

    const withoutOrigin = await fetch(`${url}/api/health`);
    assert.equal(withoutOrigin.headers.get('access-control-allow-origin'), '*');
  });

  test('OPTIONS 预检：204 + Allow-Methods / Allow-Headers / Max-Age', async (t) => {
    const { url } = await startApp(t);
    const res = await fetch(`${url}/api/feedings`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://x.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(res.headers.get('access-control-max-age'), '86400');
    assert.equal(await res.text(), '');
  });

  test('corsOrigins 白名单：匹配来源回显具体 origin + Vary，不匹配不返回', async (t) => {
    const { url } = await startApp(t, { corsOrigins: ['http://a.test'] });

    const match = await fetch(`${url}/api/health`, { headers: { Origin: 'http://a.test' } });
    assert.equal(match.headers.get('access-control-allow-origin'), 'http://a.test');
    assert.match(match.headers.get('vary') ?? '', /Origin/i);

    const mismatch = await fetch(`${url}/api/health`, { headers: { Origin: 'http://b.test' } });
    assert.equal(mismatch.headers.get('access-control-allow-origin'), null);

    const noOrigin = await fetch(`${url}/api/health`);
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);

    // POST 响应同样带 CORS
    const created = await postFeeding(
      url,
      { feedTypes: ['formula'], amountMl: 120 },
      { Origin: 'http://a.test' },
    );
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('access-control-allow-origin'), 'http://a.test');

    // 预检匹配来源
    const preflight = await fetch(`${url}/api/feedings`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://a.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://a.test');
  });

  test('corsOrigins 多来源：任一匹配来源均可', async (t) => {
    const { url } = await startApp(t, { corsOrigins: ['http://a.test', 'https://b.test'] });
    const a = await fetch(`${url}/api/health`, { headers: { Origin: 'http://a.test' } });
    assert.equal(a.headers.get('access-control-allow-origin'), 'http://a.test');
    const b = await fetch(`${url}/api/health`, { headers: { Origin: 'https://b.test' } });
    assert.equal(b.headers.get('access-control-allow-origin'), 'https://b.test');
    const c = await fetch(`${url}/api/health`, { headers: { Origin: 'http://c.test' } });
    assert.equal(c.headers.get('access-control-allow-origin'), null);
  });

  test('静态文件响应不添加 CORS 头', async (t) => {
    const { url } = await startApp(t);
    const res = await fetch(`${url}/`, { headers: { Origin: 'http://x.test' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

// ---------------------------------------------------------------------------
// 静态文件托管 / SERVE_WEB=0
// ---------------------------------------------------------------------------

describe('静态文件托管（serveWeb: true）', () => {
  test('GET / → index.html，MIME + CSP + no-cache + nosniff', async (t) => {
    const { url } = await startApp(t);
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "manifest-src 'self'",
    ]) {
      assert.ok(csp.includes(directive), `CSP 应包含 ${directive}`);
    }
    assert.equal(await res.text(), INDEX_HTML);
  });

  test('静态资源 MIME：js / css / 子目录 html', async (t) => {
    const { url } = await startApp(t);

    const js = await fetch(`${url}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await js.text(), APP_JS);

    const css = await fetch(`${url}/style.css`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await css.text(), STYLE_CSS);

    const sub = await fetch(`${url}/sub/page.html`);
    assert.equal(sub.status, 200);
    assert.equal(sub.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await sub.text(), SUB_PAGE);

    const indexDirect = await fetch(`${url}/index.html?x=1`);
    assert.equal(indexDirect.status, 200);
    assert.equal(await indexDirect.text(), INDEX_HTML);
  });

  test('HEAD /：200 + Content-Length 且无 body', async (t) => {
    const { url } = await startApp(t);
    const res = await fetch(`${url}/`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(INDEX_HTML));
    assert.equal(await res.text(), '');
  });

  test('未知文件 / 路径穿越 → 404', async (t) => {
    const { url } = await startApp(t);
    const missing = await fetch(`${url}/nope.js`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'Not Found');

    const traversal = await fetch(`${url}/%2e%2e/%2e%2e/etc/passwd`);
    assert.equal(traversal.status, 404);
    assert.equal(await traversal.text(), 'Not Found');

    const encodedSlashTraversal = await fetch(`${url}/..%2f..%2fetc%2fpasswd`);
    assert.equal(encodedSlashTraversal.status, 404);
  });

  test('静态路径非 GET/HEAD → 405', async (t) => {
    const { url } = await startApp(t);
    const post = await fetch(`${url}/`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    assert.equal(await post.text(), 'Method Not Allowed');

    const put = await fetch(`${url}/app.js`, { method: 'PUT', body: 'x' });
    assert.equal(put.status, 405);
  });
});

describe('SERVE_WEB=0（纯 API 模式）', () => {
  test('/ 与静态资源 404 web_disabled，/api/health 正常', async (t) => {
    const { url } = await startApp(t, { serveWeb: false });

    for (const pathname of ['/', '/index.html', '/app.js', '/sub/page.html']) {
      const res = await fetch(`${url}${pathname}`);
      assert.equal(res.status, 404, `${pathname} 应 404`);
      assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
      const body = await res.json();
      assert.equal(body.error, 'web_disabled');
      assert.equal(typeof body.message, 'string');
    }

    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    // API 仍可写
    const created = await postFeeding(url, { feedTypes: ['formula'], amountMl: 120 });
    assert.equal(created.status, 201);
  });
});
