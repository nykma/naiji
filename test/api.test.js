/**
 * src/server.js HTTP API 集成测试（真实 HTTP + node:sqlite 临时数据库）
 *
 * - 每个顶层 describe 使用独立 createApp()（独立临时 DB 目录、独立端口），互不污染。
 * - server.listen(0, '127.0.0.1') 后从 server.address().port 取端口，用全局 fetch 访问。
 * - 所有时间相关断言使用固定 now（createApp 的 now 注入），不依赖真实时钟。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import nodeHttp from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createApp } from '../src/server.js';

// 固定「服务器当前时间」：2026-11-13T04:00:00Z = 东八区 2026-11-13 12:00
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const TZ_SHANGHAI = -480;

/** 东八区 2026-11-13 本地 hh:mm → epoch ms（h < 8 时落到 UTC 前一天） */
function shanghai(h, min = 0) {
  return Date.UTC(2026, 10, 13, h - 8, min, 0, 0);
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localStamp(ms) {
  const d = new Date(ms);
  return `${localDateKey(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 压掉 createApp 每请求一行的访问日志（避免测试输出被淹没），其余日志保留。
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const first = args[0];
  if (typeof first === 'string' && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \//.test(first)) return;
  originalConsoleLog(...args);
};
after(() => {
  console.log = originalConsoleLog;
});

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 启动一个独立 app：临时 DB 目录 + 随机端口；返回 ctx.stop() 关闭并清理。 */
async function startApp({ publicDir, now = () => FIXED_NOW } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bmt-api-'));
  const app = createApp({
    dbPath: path.join(dir, 'baby.db'),
    now,
    ...(publicDir ? { publicDir } : {}),
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const port = app.server.address().port;
  return {
    app,
    dir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function apiRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, headers: response.headers, text, json };
}

function postJson(baseUrl, pathname, payload) {
  return apiRequest(baseUrl, pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function postRaw(baseUrl, pathname, body, contentType = 'application/json') {
  return apiRequest(baseUrl, pathname, {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : {},
    body,
  });
}

/** 断言 4xx/5xx 错误响应：状态码 + error code + 非空中文 message。 */
function assertApiError(result, expectedStatus, expectedCode) {
  assert.equal(result.status, expectedStatus, `期望状态码 ${expectedStatus}，实际 ${result.status}；body=${result.text}`);
  assert.ok(result.json, `响应不是 JSON：${result.text}`);
  assert.equal(result.json.error, expectedCode);
  assert.equal(typeof result.json.message, 'string');
  assert.ok(result.json.message.length > 0, 'message 不能为空');
}

/** 用原始 http.request 发请求（不受 fetch/URL 客户端规范化影响，用于路径穿越用例）。 */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const request = nodeHttp.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function getCsv(baseUrl) {
  const response = await fetch(`${baseUrl}/api/export.csv`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer, text: buffer.toString('utf8') };
}

// ---------------------------------------------------------------------------
// 基础路由
// ---------------------------------------------------------------------------

describe('GET /api/health 与基础路由', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  test('GET /api/health → 200 { ok: true }，JSON 响应', async () => {
    const result = await apiRequest(ctx.baseUrl, '/api/health');
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type') ?? '', /^application\/json; charset=utf-8/);
    assert.deepEqual(result.json, { ok: true });
  });

  test('未知 /api 路由 → 404 JSON { error: "not_found" }', async () => {
    const cases = [
      ['GET', '/api/nope'],
      ['POST', '/api/nope'],
      ['GET', '/api/feedings'], // 只有 POST，GET 应落到 404 JSON 而不是静态 404
      ['POST', '/api/events'],
      ['DELETE', '/api/state'],
    ];
    for (const [method, pathname] of cases) {
      const result = await apiRequest(ctx.baseUrl, pathname, { method, body: method === 'POST' ? '{}' : undefined });
      assertApiError(result, 404, 'not_found');
      assert.match(result.headers.get('content-type') ?? '', /^application\/json/);
    }
  });

  test('GET /api/export.csv 空库 → BOM + 仅表头 + CRLF', async () => {
    const { buffer, text, response } = await getCsv(ctx.baseUrl);
    assert.equal(response.status, 200);
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 必须以 UTF-8 BOM 开头');
    assert.equal(text, '\uFEFF时间,类别,项目,奶量(ml),备注\r\n');
  });
});

// ---------------------------------------------------------------------------
// POST /api/feedings
// ---------------------------------------------------------------------------

describe('POST /api/feedings', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  test('formula 成功：201，事件字段形状正确，note 去空格', async () => {
    const happenedAt = shanghai(9, 0);
    const result = await postJson(ctx.baseUrl, '/api/feedings', {
      feedType: 'formula',
      amountMl: 120,
      happenedAt,
      note: '  夜里那次  ',
    });
    assert.equal(result.status, 201);
    const event = result.json.event;
    assert.deepEqual(event, {
      id: event.id,
      kind: 'feed',
      feedType: 'formula',
      amountMl: 120,
      diaperKind: null,
      note: '夜里那次',
      happenedAt,
      createdAt: FIXED_NOW,
    });
    assert.ok(Number.isInteger(event.id) && event.id > 0);
  });

  test('breast_milk 成功：201 且 amountMl 保留', async () => {
    const happenedAt = shanghai(9, 30);
    const result = await postJson(ctx.baseUrl, '/api/feedings', {
      feedType: 'breast_milk',
      amountMl: 90,
      happenedAt,
    });
    assert.equal(result.status, 201);
    assert.deepEqual(result.json.event, {
      id: result.json.event.id,
      kind: 'feed',
      feedType: 'breast_milk',
      amountMl: 90,
      diaperKind: null,
      note: null,
      happenedAt,
      createdAt: FIXED_NOW,
    });
  });

  test('breast_direct 成功：省略 amountMl → null', async () => {
    const happenedAt = shanghai(10, 0);
    const result = await postJson(ctx.baseUrl, '/api/feedings', { feedType: 'breast_direct', happenedAt });
    assert.equal(result.status, 201);
    const event = result.json.event;
    assert.equal(event.feedType, 'breast_direct');
    assert.equal(event.amountMl, null);
    assert.equal(event.happenedAt, happenedAt);
  });

  test('breast_direct 显式 amountMl: null 也合法', async () => {
    const result = await postJson(ctx.baseUrl, '/api/feedings', {
      feedType: 'breast_direct',
      amountMl: null,
      happenedAt: shanghai(10, 15),
    });
    assert.equal(result.status, 201);
    assert.equal(result.json.event.amountMl, null);
  });

  test('happenedAt 省略时默认服务器当前时间（now 注入值）', async () => {
    const result = await postJson(ctx.baseUrl, '/api/feedings', { feedType: 'formula', amountMl: 60 });
    assert.equal(result.status, 201);
    assert.equal(result.json.event.happenedAt, FIXED_NOW);
    assert.equal(result.json.event.createdAt, FIXED_NOW);
  });

  test('奶量边界 1 与 2000 合法', async () => {
    for (const amountMl of [1, 2000]) {
      const result = await postJson(ctx.baseUrl, '/api/feedings', {
        feedType: 'formula',
        amountMl,
        happenedAt: shanghai(11, 0),
      });
      assert.equal(result.status, 201, `amountMl=${amountMl} 应合法，body=${result.text}`);
      assert.equal(result.json.event.amountMl, amountMl);
    }
  });

  test('happenedAt 边界：2000-01-01 与 FIXED_NOW + 5 分钟合法', async () => {
    const okCases = [Date.UTC(2000, 0, 1), FIXED_NOW + 5 * 60_000];
    for (const happenedAt of okCases) {
      const result = await postJson(ctx.baseUrl, '/api/feedings', {
        feedType: 'formula',
        amountMl: 120,
        happenedAt,
      });
      assert.equal(result.status, 201, `happenedAt=${happenedAt} 应合法，body=${result.text}`);
      assert.equal(result.json.event.happenedAt, happenedAt);
    }
  });

  test('note：空串/纯空白视为 null，省略也是 null', async () => {
    for (const note of ['', '   ', undefined]) {
      const payload = { feedType: 'formula', amountMl: 60, happenedAt: shanghai(11, 30) };
      if (note !== undefined) payload.note = note;
      const result = await postJson(ctx.baseUrl, '/api/feedings', payload);
      assert.equal(result.status, 201, `note=${JSON.stringify(note)} 应合法，body=${result.text}`);
      assert.equal(result.json.event.note, null);
    }
  });

  test('note 恰好 200 字符合法（trim 后）', async () => {
    const note = 'a'.repeat(200);
    const result = await postJson(ctx.baseUrl, '/api/feedings', {
      feedType: 'formula',
      amountMl: 60,
      happenedAt: shanghai(11, 40),
      note,
    });
    assert.equal(result.status, 201);
    assert.equal(result.json.event.note, note);
  });

  // --- 校验失败 ---

  const invalidFeedTypeCases = [
    ['缺失 feedType', { amountMl: 120 }],
    ['未知类型 bottle', { feedType: 'bottle', amountMl: 120 }],
    ['null', { feedType: null, amountMl: 120 }],
    ['数字', { feedType: 1, amountMl: 120 }],
    ['大小写 FORMULA', { feedType: 'FORMULA', amountMl: 120 }],
    ['未知类型 Mixed', { feedType: 'Mixed', amountMl: 120 }],
  ];
  for (const [label, payload] of invalidFeedTypeCases) {
    test(`feedType 非法（${label}）→ 400 invalid_feed_type`, async () => {
      const result = await postJson(ctx.baseUrl, '/api/feedings', payload);
      assertApiError(result, 400, 'invalid_feed_type');
    });
  }

  const invalidAmountCases = [
    ['缺失 amountMl', { feedType: 'formula' }],
    ['null', { feedType: 'formula', amountMl: null }],
    ['0', { feedType: 'formula', amountMl: 0 }],
    ['2001', { feedType: 'formula', amountMl: 2001 }],
    ['负数 -1', { feedType: 'formula', amountMl: -1 }],
    ['小数 1.5', { feedType: 'formula', amountMl: 1.5 }],
    ['字符串 "120"', { feedType: 'formula', amountMl: '120' }],
    ['NaN（JSON 序列化为 null）', { feedType: 'formula', amountMl: NaN }],
    ['Infinity（JSON 序列化为 null）', { feedType: 'formula', amountMl: Infinity }],
    ['breast_milk 缺失 amountMl', { feedType: 'breast_milk' }],
    ['breast_milk amountMl = 0', { feedType: 'breast_milk', amountMl: 0 }],
  ];
  for (const [label, payload] of invalidAmountCases) {
    test(`amountMl 非法（${label}）→ 400 invalid_amount`, async () => {
      const result = await postJson(ctx.baseUrl, '/api/feedings', payload);
      assertApiError(result, 400, 'invalid_amount');
    });
  }

  test('亲喂带 amountMl → 400 unexpected_amount', async () => {
    for (const amountMl of [120, 0, -1]) {
      const result = await postJson(ctx.baseUrl, '/api/feedings', { feedType: 'breast_direct', amountMl });
      assertApiError(result, 400, 'unexpected_amount');
    }
  });

  const invalidHappenedAtCases = [
    ['ISO 字符串', '2026-11-13T04:00:00Z'],
    ['数字字符串', String(FIXED_NOW)],
    ['1999-12-31', Date.UTC(1999, 11, 31, 23, 59, 59)],
    ['2000-01-01 前 1ms', Date.UTC(2000, 0, 1) - 1],
    ['未来 10 分钟', FIXED_NOW + 10 * 60_000],
    ['未来 5 分钟 + 1ms', FIXED_NOW + 5 * 60_000 + 1],
    ['小数时间戳', 1_763_000_000_000.5],
    ['布尔值', true],
  ];
  for (const [label, happenedAt] of invalidHappenedAtCases) {
    test(`happenedAt 非法（${label}）→ 400 invalid_happened_at`, async () => {
      const result = await postJson(ctx.baseUrl, '/api/feedings', {
        feedType: 'formula',
        amountMl: 120,
        happenedAt,
      });
      assertApiError(result, 400, 'invalid_happened_at');
    });
  }

  const invalidNoteCases = [
    ['201 字符', 'a'.repeat(201)],
    ['前后空格 + 201 字符', `  ${'a'.repeat(201)}  `],
    ['数字', 120],
    ['对象', { text: 'x' }],
    ['数组', ['x']],
    ['布尔', true],
  ];
  for (const [label, note] of invalidNoteCases) {
    test(`note 非法（${label}）→ 400 invalid_note`, async () => {
      const result = await postJson(ctx.baseUrl, '/api/feedings', {
        feedType: 'formula',
        amountMl: 120,
        note,
      });
      assertApiError(result, 400, 'invalid_note');
    });
  }

  const invalidJsonCases = [
    ['空 body', ''],
    ['纯空白', '   '],
    ['坏 JSON {', '{'],
    ['数组 [1,2]', '[1,2]'],
    ['JSON null', 'null'],
    ['数字 42', '42'],
    ['布尔 true', 'true'],
  ];
  for (const [label, body] of invalidJsonCases) {
    test(`请求体非法 JSON（${label}）→ 400 invalid_json`, async () => {
      const result = await postRaw(ctx.baseUrl, '/api/feedings', body);
      assertApiError(result, 400, 'invalid_json');
    });
  }

  test('Content-Type 非 application/json → 415 unsupported_media_type', async () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      const result = await postRaw(ctx.baseUrl, '/api/feedings', JSON.stringify({ feedType: 'formula', amountMl: 120 }), contentType);
      assertApiError(result, 415, 'unsupported_media_type');
    }
  });

  test('请求体超过 64KB → 413 payload_too_large', async () => {
    const body = JSON.stringify({ feedType: 'formula', amountMl: 120, note: 'a'.repeat(70_000) });
    const result = await postRaw(ctx.baseUrl, '/api/feedings', body);
    assertApiError(result, 413, 'payload_too_large');
  });
});

// ---------------------------------------------------------------------------
// POST /api/diapers
// ---------------------------------------------------------------------------

describe('POST /api/diapers', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  for (const diaperKind of ['pee', 'poop', 'mixed']) {
    test(`${diaperKind} 成功：201 且事件字段形状正确`, async () => {
      const happenedAt = shanghai(8, 0);
      const result = await postJson(ctx.baseUrl, '/api/diapers', { diaperKind, happenedAt, note: ' 有点稀 ' });
      assert.equal(result.status, 201);
      assert.deepEqual(result.json.event, {
        id: result.json.event.id,
        kind: 'diaper',
        feedType: null,
        amountMl: null,
        diaperKind,
        note: '有点稀',
        happenedAt,
        createdAt: FIXED_NOW,
      });
    });
  }

  test('happenedAt 省略时默认服务器当前时间；note 省略为 null', async () => {
    const result = await postJson(ctx.baseUrl, '/api/diapers', { diaperKind: 'pee' });
    assert.equal(result.status, 201);
    assert.equal(result.json.event.happenedAt, FIXED_NOW);
    assert.equal(result.json.event.note, null);
  });

  const invalidDiaperKindCases = [
    ['缺失 diaperKind', {}],
    ['未知类型 wet', { diaperKind: 'wet' }],
    ['null', { diaperKind: null }],
    ['数字', { diaperKind: 1 }],
    ['喂奶类型 formula', { diaperKind: 'formula' }],
  ];
  for (const [label, payload] of invalidDiaperKindCases) {
    test(`diaperKind 非法（${label}）→ 400 invalid_diaper_kind`, async () => {
      const result = await postJson(ctx.baseUrl, '/api/diapers', payload);
      assertApiError(result, 400, 'invalid_diaper_kind');
    });
  }

  test('diaper 的 happenedAt / note / JSON 校验复用同一套错误码', async () => {
    assertApiError(
      await postJson(ctx.baseUrl, '/api/diapers', { diaperKind: 'pee', happenedAt: String(FIXED_NOW) }),
      400,
      'invalid_happened_at',
    );
    assertApiError(
      await postJson(ctx.baseUrl, '/api/diapers', { diaperKind: 'pee', note: 'a'.repeat(201) }),
      400,
      'invalid_note',
    );
    assertApiError(await postRaw(ctx.baseUrl, '/api/diapers', '{'), 400, 'invalid_json');
  });
});

// ---------------------------------------------------------------------------
// GET /api/state
// ---------------------------------------------------------------------------

describe('GET /api/state', () => {
  let ctx;
  const seeded = {};

  before(async () => {
    ctx = await startApp();
    // 东八区 2026-11-12（前一天）本地 hh:mm → epoch ms
    const prevDay = (h, min) => Date.UTC(2026, 10, 12, h - 8, min, 0, 0);
    const specs = [
      ['f120', '/api/feedings', { feedType: 'formula', amountMl: 120, happenedAt: shanghai(7, 0) }],
      ['mixed', '/api/diapers', { diaperKind: 'mixed', happenedAt: shanghai(11, 0) }],
      ['prevFormula', '/api/feedings', { feedType: 'formula', amountMl: 500, happenedAt: prevDay(23, 0) }],
      ['bm', '/api/feedings', { feedType: 'breast_milk', amountMl: 90, happenedAt: shanghai(9, 15) }],
      ['pee', '/api/diapers', { diaperKind: 'pee', happenedAt: shanghai(8, 0) }],
      ['bd', '/api/feedings', { feedType: 'breast_direct', happenedAt: shanghai(10, 30) }],
      ['f180', '/api/feedings', { feedType: 'formula', amountMl: 180, happenedAt: shanghai(8, 30) }],
      ['prevPee', '/api/diapers', { diaperKind: 'pee', happenedAt: prevDay(23, 30) }],
      ['poop', '/api/diapers', { diaperKind: 'poop', happenedAt: shanghai(9, 0) }],
    ];
    for (const [label, pathname, payload] of specs) {
      const result = await postJson(ctx.baseUrl, pathname, payload);
      assert.equal(result.status, 201, `种子数据 ${label} 创建失败：${result.text}`);
      seeded[label] = result.json.event;
    }
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  test('tzOffset=-480：today 聚合、lastFeeding/lastDiaper、recent 排序全部正确', async () => {
    const result = await apiRequest(ctx.baseUrl, `/api/state?tzOffset=${TZ_SHANGHAI}`);
    assert.equal(result.status, 200);
    const state = result.json;

    assert.equal(state.now, FIXED_NOW);
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

    assert.equal(state.lastFeeding.id, seeded.bd.id, 'lastFeeding 应是最近一条 feed（含亲喂）');
    assert.equal(state.lastFeeding.feedType, 'breast_direct');
    assert.equal(state.lastDiaper.id, seeded.mixed.id, 'lastDiaper 应是最近一条 diaper');
    assert.equal(state.lastDiaper.diaperKind, 'mixed');

    const expectedRecentIds = ['mixed', 'bd', 'bm', 'poop', 'f180', 'pee', 'f120', 'prevPee', 'prevFormula'].map(
      (label) => seeded[label].id,
    );
    assert.deepEqual(state.recent.map((event) => event.id), expectedRecentIds);
    for (let i = 1; i < state.recent.length; i += 1) {
      const previous = state.recent[i - 1];
      const current = state.recent[i];
      assert.ok(
        previous.happenedAt > current.happenedAt ||
          (previous.happenedAt === current.happenedAt && previous.id > current.id),
        `recent 排序错误（index ${i}）`,
      );
    }
  });

  test('tzOffset=0：只统计 UTC 当天的事件', async () => {
    const result = await apiRequest(ctx.baseUrl, '/api/state?tzOffset=0');
    assert.equal(result.status, 200);
    assert.equal(result.json.today.date, '2026-11-13');
    assert.deepEqual(result.json.today, {
      date: '2026-11-13',
      feedCount: 3, // f180 / bm / bd（东八区上午 = UTC 同日 00:00–03:00）
      breastDirectCount: 1,
      formulaMl: 180,
      breastMl: 90,
      totalMl: 270,
      diaperCount: 3,
      peeCount: 2,
      poopCount: 2,
      mixedCount: 1,
    });
  });

  test('省略 tzOffset → 200，按服务器本地时区返回结构完整的数据', async () => {
    const result = await apiRequest(ctx.baseUrl, '/api/state');
    assert.equal(result.status, 200);
    const state = result.json;
    assert.equal(state.now, FIXED_NOW);
    assert.match(state.today.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(state.today.totalMl, state.today.formulaMl + state.today.breastMl);
    assert.ok(state.today.feedCount >= state.today.breastDirectCount);
    assert.ok(state.today.diaperCount >= state.today.mixedCount);
    assert.equal(state.recent.length, 9);
    assert.equal(state.lastFeeding.id, seeded.bd.id);
    assert.equal(state.lastDiaper.id, seeded.mixed.id);
  });

  test('tzOffset 非法 → 400 invalid_tz_offset', async () => {
    for (const raw of ['-841', '841', 'abc', '1.5', '', '-480.0', 'NaN']) {
      const result = await apiRequest(ctx.baseUrl, `/api/state?tzOffset=${encodeURIComponent(raw)}`);
      assertApiError(result, 400, 'invalid_tz_offset');
    }
  });

  test('tzOffset 合法边界 -840 / 840 / 480 → 200', async () => {
    for (const raw of ['-840', '840', '480', '0', '-0']) {
      const result = await apiRequest(ctx.baseUrl, `/api/state?tzOffset=${raw}`);
      assert.equal(result.status, 200, `tzOffset=${raw} 应合法，body=${result.text}`);
      assert.match(result.json.today.date, /^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/events（limit / 游标分页）
// ---------------------------------------------------------------------------

describe('GET /api/events', () => {
  let ctx;
  const BASE_TIME = Date.UTC(2026, 10, 1, 0, 0, 0);
  const SAME_MS_TIME = Date.UTC(2026, 10, 2, 0, 0, 0); // 比 BASE_TIME 系列都新
  const TOTAL = 60; // 55 条时间互不相同 + 5 条同一毫秒
  const allIdsDesc = Array.from({ length: TOTAL }, (_, index) => TOTAL - index); // [60, 59, ..., 1]
  let sameMsIds = [];

  before(async () => {
    ctx = await startApp();
    for (let i = 0; i < 55; i += 1) {
      const happenedAt = BASE_TIME + i * 60_000;
      if (i % 5 === 0) {
        ctx.app.store.createEvent({
          kind: 'diaper',
          diaperKind: ['pee', 'poop', 'mixed'][i % 3],
          happenedAt,
          createdAt: FIXED_NOW,
        });
      } else {
        ctx.app.store.createEvent({
          kind: 'feed',
          feedType: 'formula',
          amountMl: 60 + i,
          happenedAt,
          createdAt: FIXED_NOW,
        });
      }
    }
    for (let i = 0; i < 5; i += 1) {
      sameMsIds.push(
        ctx.app.store.createEvent({
          kind: 'feed',
          feedType: 'formula',
          amountMl: 10 + i,
          happenedAt: SAME_MS_TIME,
          createdAt: FIXED_NOW,
        }).id,
      );
    }
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  async function getEvents(query = '') {
    const result = await apiRequest(ctx.baseUrl, `/api/events${query}`);
    assert.equal(result.status, 200, result.text);
    assert.ok(Array.isArray(result.json.events), '响应必须是 { events: [] }');
    return result.json.events;
  }

  test('limit 默认 50，按 happenedAt DESC, id DESC', async () => {
    const events = await getEvents();
    assert.equal(events.length, 50);
    assert.deepEqual(events.map((event) => event.id), allIdsDesc.slice(0, 50));
    assert.equal(events[50 - 1].id, 11);
    assert.equal(events[50 - 1].happenedAt, BASE_TIME + 10 * 60_000);
  });

  test('limit 自定义 1 / 3 / 200', async () => {
    assert.deepEqual((await getEvents('?limit=1')).map((event) => event.id), [60]);
    assert.deepEqual((await getEvents('?limit=3')).map((event) => event.id), [60, 59, 58]);
    assert.equal((await getEvents('?limit=200')).length, TOTAL);
  });

  const invalidLimitCases = ['0', '201', '-1', 'abc', '1.5', ''];
  for (const raw of invalidLimitCases) {
    test(`limit 非法（${JSON.stringify(raw)}）→ 400 invalid_limit`, async () => {
      const result = await apiRequest(ctx.baseUrl, `/api/events?limit=${raw}`);
      assertApiError(result, 400, 'invalid_limit');
    });
  }

  test('游标翻页（limit=7）不漏不重、顺序与全量一致', async () => {
    const collected = [];
    let query = '?limit=7';
    for (let guard = 0; guard < 20; guard += 1) {
      const events = await getEvents(query);
      if (events.length === 0) break;
      collected.push(...events);
      const last = events[events.length - 1];
      query = `?limit=7&before=${last.happenedAt}&beforeId=${last.id}`;
    }
    assert.deepEqual(collected.map((event) => event.id), allIdsDesc);
    assert.equal(new Set(collected.map((event) => event.id)).size, TOTAL, '翻页结果不能有重复');
  });

  test('同一 happenedAt 的事件跨页不丢不重（limit=2）', async () => {
    const page1 = await getEvents('?limit=2');
    assert.deepEqual(page1.map((event) => event.id), [60, 59]);
    assert.equal(page1[0].happenedAt, SAME_MS_TIME);

    const page2 = await getEvents(`?limit=2&before=${SAME_MS_TIME}&beforeId=${page1[1].id}`);
    assert.deepEqual(page2.map((event) => event.id), [58, 57]);

    const page3 = await getEvents(`?limit=2&before=${SAME_MS_TIME}&beforeId=${page2[1].id}`);
    assert.deepEqual(page3.map((event) => event.id), [56, 55]);

    const page4 = await getEvents(`?limit=2&before=${page3[1].happenedAt}&beforeId=${page3[1].id}`);
    assert.deepEqual(page4.map((event) => event.id), [54, 53]);

    const seen = [...page1, ...page2, ...page3, ...page4].map((event) => event.id);
    assert.equal(new Set(seen).size, seen.length, '跨页不能出现重复事件');
    assert.deepEqual(seen, allIdsDesc.slice(0, 8));
  });

  test('只传 before（不传 beforeId）→ happenedAt 严格小于 before', async () => {
    const events = await getEvents(`?before=${SAME_MS_TIME}&limit=200`);
    assert.equal(events.length, 55);
    assert.deepEqual(events.map((event) => event.id), Array.from({ length: 55 }, (_, index) => 55 - index));
    assert.ok(events.every((event) => event.happenedAt < SAME_MS_TIME));
  });

  test('before + beforeId → 返回严格更旧的数据（同毫秒按 id 比较）', async () => {
    const events = await getEvents(`?before=${SAME_MS_TIME}&beforeId=${sameMsIds[3]}&limit=200`);
    assert.deepEqual(events.slice(0, 3).map((event) => event.id), [58, 57, 56]);
    assert.equal(events.length, 58);
    assert.ok(!events.some((event) => event.id >= sameMsIds[3]));
  });

  test('非法游标 → 400 invalid_cursor', async () => {
    for (const query of ['?before=abc', '?before=', '?before=-1', `?before=${SAME_MS_TIME}&beforeId=abc`, `?before=${SAME_MS_TIME}&beforeId=`]) {
      const result = await apiRequest(ctx.baseUrl, `/api/events${query}`);
      assertApiError(result, 400, 'invalid_cursor');
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/events/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/events/:id', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  async function createFeed(amountMl = 120) {
    const result = await postJson(ctx.baseUrl, '/api/feedings', {
      feedType: 'formula',
      amountMl,
      happenedAt: shanghai(9, 0),
    });
    assert.equal(result.status, 201, result.text);
    return result.json.event;
  }

  test('删除存在的事件 → 204 无响应体，再查列表不含该记录', async () => {
    const event = await createFeed();
    const deleted = await apiRequest(ctx.baseUrl, `/api/events/${event.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.text, '');

    const list = await apiRequest(ctx.baseUrl, '/api/events?limit=200');
    assert.equal(list.status, 200);
    assert.ok(!list.json.events.some((item) => item.id === event.id));
    assert.equal(list.json.events.length, 0);
  });

  test('重复删除 / 删除不存在的事件 → 404 not_found', async () => {
    const event = await createFeed(90);
    const first = await apiRequest(ctx.baseUrl, `/api/events/${event.id}`, { method: 'DELETE' });
    assert.equal(first.status, 204);
    const second = await apiRequest(ctx.baseUrl, `/api/events/${event.id}`, { method: 'DELETE' });
    assertApiError(second, 404, 'not_found');

    assertApiError(await apiRequest(ctx.baseUrl, '/api/events/99999', { method: 'DELETE' }), 404, 'not_found');
  });

  test('非法 id 格式 → 404 JSON not_found（不泄露路由细节）', async () => {
    for (const badId of ['abc', '0', '-1', '1.5', '01', '99999999999999999999']) {
      const result = await apiRequest(ctx.baseUrl, `/api/events/${badId}`, { method: 'DELETE' });
      assertApiError(result, 404, 'not_found');
      assert.match(result.headers.get('content-type') ?? '', /^application\/json/);
    }
  });

  test('只删除指定事件，其余记录保留', async () => {
    const keepA = await createFeed(60);
    const remove = await createFeed(120);
    const keepB = await createFeed(180);

    const deleted = await apiRequest(ctx.baseUrl, `/api/events/${remove.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);

    const list = await apiRequest(ctx.baseUrl, '/api/events?limit=200');
    const ids = list.json.events.map((event) => event.id);
    assert.ok(ids.includes(keepA.id));
    assert.ok(ids.includes(keepB.id));
    assert.ok(!ids.includes(remove.id));
  });
});

// ---------------------------------------------------------------------------
// GET /api/export.csv
// ---------------------------------------------------------------------------

describe('GET /api/export.csv', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
    // 故意按乱序插入，验证导出按 happenedAt 升序排序
    const specs = [
      ['/api/feedings', { feedType: 'breast_direct', happenedAt: shanghai(11, 0), note: 'n-bd' }],
      ['/api/feedings', { feedType: 'formula', amountMl: 120, happenedAt: shanghai(8, 0) }],
      ['/api/diapers', { diaperKind: 'mixed', happenedAt: shanghai(10, 0), note: 'n-mixed' }],
      ['/api/feedings', { feedType: 'breast_milk', amountMl: 90, happenedAt: shanghai(9, 0), note: 'n-bm' }],
      ['/api/diapers', { diaperKind: 'pee', happenedAt: shanghai(9, 30), note: 'n-pee' }],
      ['/api/feedings', { feedType: 'formula', amountMl: 60, happenedAt: shanghai(8, 30), note: 'he said "hi", ok' }],
    ];
    for (const [pathname, payload] of specs) {
      const result = await postJson(ctx.baseUrl, pathname, payload);
      assert.equal(result.status, 201, result.text);
    }
  });
  after(async () => {
    if (ctx) await ctx.stop();
  });

  test('200 + BOM + 表头 + CSV 响应头（含本地日期文件名）', async () => {
    const { response, buffer, text } = await getCsv(ctx.baseUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="baby-milk-${localDateKey(FIXED_NOW)}.csv"`,
    );
    assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 必须以 UTF-8 BOM 开头');
    assert.equal(text.charCodeAt(0), 0xfeff);

    const body = text.slice(1); // 去掉 BOM 再按行断言
    const lines = body.split('\r\n').filter((line) => line !== '');
    assert.equal(lines[0], '时间,类别,项目,奶量(ml),备注');
    assert.equal(lines.length, 7, `应为表头 + 6 条数据，实际：${JSON.stringify(lines)}`);
  });

  test('中文项目名 / 奶量 / 备注转义 / 本地时间格式正确，且按时间升序', async () => {
    const { text } = await getCsv(ctx.baseUrl);
    const lines = text.split('\r\n').filter((line) => line !== '');

    assert.equal(lines[1], `${localStamp(shanghai(8, 0))},喂奶,奶粉,120,`);
    assert.equal(lines[2], `${localStamp(shanghai(8, 30))},喂奶,奶粉,60,"he said ""hi"", ok"`);
    assert.equal(lines[3], `${localStamp(shanghai(9, 0))},喂奶,母乳（瓶喂）,90,n-bm`);
    assert.equal(lines[4], `${localStamp(shanghai(9, 30))},大小便,小便,,n-pee`);
    assert.equal(lines[5], `${localStamp(shanghai(10, 0))},大小便,大小便,,n-mixed`);
    assert.equal(lines[6], `${localStamp(shanghai(11, 0))},喂奶,亲喂,,n-bd`);

    // 升序校验：YYYY-MM-DD HH:mm 字符串顺序即时间顺序
    const stamps = lines.slice(1).map((line) => line.slice(0, 16));
    assert.deepEqual(stamps, [...stamps].sort());
    assert.match(lines[1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2},/);
  });
});

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

describe('静态文件托管', () => {
  let ctx;
  let rootDir;
  const publicDirFiles = {
    'index.html': '<!doctype html><html><body><h1>奶记</h1></body></html>',
    'app.js': 'console.log("app");\n',
    'style.css': 'body { color: #333; }\n',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'manifest.webmanifest': '{"name":"奶记"}',
  };

  before(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'bmt-static-'));
    const publicDir = path.join(rootDir, 'public');
    const outsideDir = path.join(rootDir, 'outside');
    await mkdir(publicDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    for (const [name, content] of Object.entries(publicDirFiles)) {
      await writeFile(path.join(publicDir, name), content);
    }
    await writeFile(path.join(outsideDir, 'secret.txt'), 'TOP_SECRET_DO_NOT_LEAK');
    ctx = await startApp({ publicDir });
  });
  after(async () => {
    if (ctx) await ctx.stop();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  test('GET / → index.html，MIME / no-cache / nosniff / CSP 正确', async () => {
    const result = await apiRequest(ctx.baseUrl, '/');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(result.headers.get('cache-control'), 'no-cache');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      result.headers.get('content-security-policy'),
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "script-src 'self'; manifest-src 'self'",
    );
    assert.equal(result.text, publicDirFiles['index.html']);

    const explicit = await apiRequest(ctx.baseUrl, '/index.html');
    assert.equal(explicit.status, 200);
    assert.equal(explicit.text, publicDirFiles['index.html']);
  });

  test('GET /app.js 等静态资源 → 200 且 MIME 正确', async () => {
    const expectations = [
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/style.css', 'text/css; charset=utf-8'],
      ['/icon.svg', 'image/svg+xml'],
      ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ];
    for (const [pathname, contentType] of expectations) {
      const result = await apiRequest(ctx.baseUrl, pathname);
      assert.equal(result.status, 200, `${pathname} 应 200，实际 ${result.status}`);
      assert.equal(result.headers.get('content-type'), contentType, `${pathname} MIME 错误`);
      assert.equal(result.headers.get('cache-control'), 'no-cache');
    }
    const js = await apiRequest(ctx.baseUrl, '/app.js');
    assert.equal(js.text, publicDirFiles['app.js']);
    assert.equal(js.headers.get('content-security-policy'), null, '非 HTML 不应带 CSP');
  });

  test('不存在文件 / 目录 → 404', async () => {
    for (const pathname of ['/missing.html', '/nope/app.js', '/sub/']) {
      const result = await apiRequest(ctx.baseUrl, pathname);
      assert.equal(result.status, 404, `${pathname} 应 404，实际 ${result.status}`);
    }
  });

  test('路径穿越（含 URL 编码绕过）→ 404 且不泄露 public 外内容', async () => {
    const attempts = [
      '/../outside/secret.txt',
      '/..%2foutside%2fsecret.txt',
      '/%2e%2e%2foutside%2fsecret.txt',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/..%2fpackage.json',
    ];
    for (const rawPath of attempts) {
      const result = await rawGet(ctx.port, rawPath);
      assert.equal(result.status, 404, `path=${rawPath} 应 404，实际 ${result.status}`);
      assert.ok(!result.body.includes('TOP_SECRET_DO_NOT_LEAK'), `path=${rawPath} 泄露了 public 外文件内容`);
      assert.ok(!result.body.includes('root:'), `path=${rawPath} 泄露了 /etc/passwd 内容`);
    }
  });

  test('静态路径非 GET/HEAD 方法 → 405 Method Not Allowed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const result = await apiRequest(ctx.baseUrl, '/', { method });
      assert.equal(result.status, 405, `${method} / 应 405，实际 ${result.status}`);
      assert.equal(result.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(result.text, 'Method Not Allowed');
    }
  });

  test('非法百分号编码的静态路径 → 400 Bad Request（不崩溃）', async () => {
    const result = await rawGet(ctx.port, '/%zz');
    assert.equal(result.status, 400);
    assert.equal(result.body, 'Bad Request');
  });

  test('HEAD / → 200，有 Content-Length 无响应体', async () => {
    const result = await apiRequest(ctx.baseUrl, '/', { method: 'HEAD' });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(result.text, '');
    assert.equal(Number(result.headers.get('content-length')), Buffer.byteLength(publicDirFiles['index.html']));
  });
});
