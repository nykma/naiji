import assert from 'node:assert/strict';
import test from 'node:test';

import { NaijiClient } from '../src/client.mjs';
import { ApiError } from '../src/errors.mjs';
import {
  replyCsv,
  replyEmpty,
  replyJson,
  startStubServer,
} from './helpers.mjs';

test('createFeeding：POST /api/feedings，请求体为 JSON', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: {
        id: 7,
        kind: 'feed',
        feedTypes: record.body.feedTypes,
        amountMl: record.body.amountMl,
        diaperKind: null,
        note: null,
        happenedAt: 1763000000000,
        createdAt: 1763000000000,
      },
    });
  });
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const event = await client.createFeeding({
    feedTypes: ['formula', 'breast_direct'],
    amountMl: 60,
    happenedAt: 1763000000000,
    note: '夜里',
  });

  assert.equal(event.id, 7);
  assert.deepEqual(event.feedTypes, ['formula', 'breast_direct']);
  assert.equal(stub.requests.length, 1);
  const [request] = stub.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.pathname, '/api/feedings');
  assert.match(String(request.headers['content-type']), /application\/json/);
  assert.deepEqual(request.body, {
    feedTypes: ['formula', 'breast_direct'],
    amountMl: 60,
    happenedAt: 1763000000000,
    note: '夜里',
  });
});

test('createDiaper：POST /api/diapers', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: {
        id: 8,
        kind: 'diaper',
        feedTypes: null,
        amountMl: null,
        diaperKind: record.body.diaperKind,
        note: record.body.note ?? null,
        happenedAt: record.body.happenedAt ?? Date.now(),
        createdAt: Date.now(),
      },
    });
  });
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const event = await client.createDiaper({ diaperKind: 'mixed', note: '有点多' });

  assert.equal(event.diaperKind, 'mixed');
  assert.equal(stub.requests[0].method, 'POST');
  assert.equal(stub.requests[0].pathname, '/api/diapers');
  assert.deepEqual(stub.requests[0].body, { diaperKind: 'mixed', note: '有点多' });
});

test('createBath：POST /api/baths，method/路径/JSON body 正确', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: {
        id: 9,
        kind: 'bath',
        feedTypes: null,
        amountMl: null,
        diaperKind: null,
        note: record.body.note ?? null,
        happenedAt: record.body.happenedAt ?? 1763000000000,
        createdAt: 1763000000000,
      },
    });
  });
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const event = await client.createBath({ happenedAt: 1763000000000, note: '洗香香' });

  assert.equal(event.id, 9);
  assert.equal(event.kind, 'bath');
  assert.equal(stub.requests.length, 1);
  const [request] = stub.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.pathname, '/api/baths');
  assert.match(String(request.headers['content-type']), /application\/json/);
  assert.deepEqual(request.body, { happenedAt: 1763000000000, note: '洗香香' });

  // 不传任何字段时 body 为 {}（服务端用 now、无备注）
  await client.createBath({});
  assert.deepEqual(stub.requests[1].body, {});
});

test('createBath：响应缺少 event 字段时抛 ApiError', async (t) => {
  const stub = await startStubServer((record, res) => replyJson(res, 201, {}));
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  await assert.rejects(
    () => client.createBath({}),
    (error) => error instanceof ApiError && error.code === 'invalid_response',
  );
});

test('getState：GET /api/state 且带 tzOffset', async (t) => {
  const state = {
    now: 1763000000000,
    lastFeeding: null,
    lastDiaper: null,
    today: { date: '2026-01-01', feedCount: 0, totalMl: 0 },
    recent: [],
  };
  const stub = await startStubServer((record, res) => replyJson(res, 200, state));
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const result = await client.getState({ tzOffset: -480 });
  assert.deepEqual(result, state);
  assert.equal(stub.requests[0].method, 'GET');
  assert.equal(stub.requests[0].pathname, '/api/state');
  assert.equal(stub.requests[0].query.get('tzOffset'), '-480');

  // 默认使用进程本地时区
  await client.getState();
  assert.equal(
    stub.requests[1].query.get('tzOffset'),
    String(new Date().getTimezoneOffset()),
  );
});

test('listEvents：GET /api/events 带 limit / before / beforeId', async (t) => {
  const stub = await startStubServer((record, res) => replyJson(res, 200, { events: [] }));
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const events = await client.listEvents({ limit: 10, before: 1763000000000, beforeId: 42 });
  assert.deepEqual(events, []);
  assert.equal(stub.requests[0].method, 'GET');
  assert.equal(stub.requests[0].pathname, '/api/events');
  assert.equal(stub.requests[0].query.get('limit'), '10');
  assert.equal(stub.requests[0].query.get('before'), '1763000000000');
  assert.equal(stub.requests[0].query.get('beforeId'), '42');
});

test('deleteEvent：DELETE /api/events/:id（204 无响应体）', async (t) => {
  const stub = await startStubServer((record, res) => replyEmpty(res, 204));
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const result = await client.deleteEvent(12);
  assert.equal(result, null);
  assert.equal(stub.requests[0].method, 'DELETE');
  assert.equal(stub.requests[0].pathname, '/api/events/12');
});

test('exportCsv：GET /api/export.csv，返回保留 BOM 的 Buffer', async (t) => {
  const csvText = '\uFEFF时间,类别,项目,奶量(ml),备注\r\n2026-01-01 08:00,喂奶,奶粉,120,\r\n';
  const stub = await startStubServer((record, res) => replyCsv(res, csvText));
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  const buffer = await client.exportCsv();
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(buffer.toString('utf8'), csvText);
  assert.equal(stub.requests[0].pathname, '/api/export.csv');
});

test('非 2xx：抛 ApiError 且 message 使用后端中文 message', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 400, {
      error: 'invalid_amount',
      message: '奶量必须是 1 到 2000 之间的整数（毫升）',
    });
  });
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  await assert.rejects(
    () => client.createFeeding({ feedTypes: ['formula'], amountMl: 0 }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalid_amount');
      assert.match(error.message, /奶量必须是/);
      return true;
    },
  );
});

test('DELETE 404：message 为「记录不存在」', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 404, { error: 'not_found', message: '记录不存在' });
  });
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  await assert.rejects(
    () => client.deleteEvent(999),
    (error) => error instanceof ApiError && error.status === 404 && error.message === '记录不存在',
  );
});

test('非 JSON 响应 / 非 JSON 错误体也有友好消息', async (t) => {
  let status = 200;
  let reply = 'plain text';
  const stub = await startStubServer((record, res) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(reply);
  });
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  await assert.rejects(
    () => client.getState(),
    (error) => error instanceof ApiError && error.code === 'invalid_response' && /非 JSON/.test(error.message),
  );

  status = 500;
  reply = 'boom';
  await assert.rejects(
    () => client.getState(),
    (error) => error instanceof ApiError && error.status === 500 && /HTTP 500/.test(error.message),
  );

  // 指向静态网页服务等「不是后端」的地址时，给出可排查的提示
  status = 404;
  reply = '<html>Not Found</html>';
  await assert.rejects(
    () => client.getState(),
    (error) => error instanceof ApiError && error.status === 404 && /请确认 --server/.test(error.message),
  );
});

test('网络错误：ApiError.network=true，消息包含服务器地址', async () => {
  // 先占一个端口再关掉，保证连接被拒绝
  const stub = await startStubServer((record, res) => replyJson(res, 200, {}));
  const { baseUrl } = stub;
  await stub.close();

  const client = new NaijiClient({ server: baseUrl });
  await assert.rejects(
    () => client.getState(),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.network, true);
      assert.equal(error.code, 'network_error');
      assert.ok(error.message.includes(baseUrl));
      return true;
    },
  );
});

test('health', async (t) => {
  const stub = await startStubServer((record, res) => replyJson(res, 200, { ok: true }));
  t.after(() => stub.close());

  const client = new NaijiClient({ server: stub.baseUrl });
  assert.deepEqual(await client.health(), { ok: true });
  assert.equal(stub.requests[0].pathname, '/api/health');
});
