/**
 * SSE 实时推送（多端同步）测试
 *
 * 覆盖：事件流响应头 / 初始帧、记录与删除广播、多客户端同时收到、
 * 心跳帧、关闭应用时结束连接。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/src/server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startApp(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naiji-sse-'));
  const app = createApp({
    dbPath: path.join(dir, 'test.db'),
    serveWeb: false,
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, port, base: `http://127.0.0.1:${port}` };
}

/** 打开一个 SSE 连接，返回可等待特定帧的客户端 */
function connectSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/events/stream',
      headers: { Accept: 'text/event-stream' },
    });
    let text = '';
    let closed = false;
    const timer = setTimeout(() => reject(new Error('SSE 连接超时')), 3000);
    timer.unref?.();

    req.on('response', (res) => {
      clearTimeout(timer);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        closed = true;
      });

      resolve({
        res,
        status: res.statusCode,
        headers: res.headers,
        get closed() {
          return closed;
        },
        get text() {
          return text;
        },
        /** 等待文本中出现匹配内容，超时抛错 */
        async waitFor(pattern, timeoutMs = 3000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (pattern.test(text)) return text;
            await sleep(20);
          }
          throw new Error(`等待 SSE 帧超时: ${pattern}；已收到: ${JSON.stringify(text.slice(-400))}`);
        },
        async waitClosed(timeoutMs = 3000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (closed) return;
            await sleep(20);
          }
          throw new Error('等待 SSE 连接关闭超时');
        },
        close() {
          req.destroy();
        },
      });
    });

    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function jsonFetch(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = res.status === 204 ? null : await res.json();
  return { status: res.status, payload };
}

test('GET /api/events/stream：返回 SSE 响应头、CORS 与初始帧', async (t) => {
  const { port } = await startApp(t);
  const client = await connectSse(port);
  t.after(() => client.close());

  assert.equal(client.status, 200);
  assert.match(String(client.headers['content-type']), /^text\/event-stream/);
  assert.match(String(client.headers['cache-control']), /no-cache/);
  assert.equal(client.headers['access-control-allow-origin'], '*');
  assert.equal(client.headers['x-accel-buffering'], 'no');

  await client.waitFor(/^retry: 3000/m);
  await client.waitFor(/: connected/);
});

test('记录喂奶后向所有 SSE 客户端广播 feed 事件（多端同步）', async (t) => {
  const { port, base } = await startApp(t);
  const clientA = await connectSse(port);
  const clientB = await connectSse(port);
  t.after(() => {
    clientA.close();
    clientB.close();
  });
  await clientA.waitFor(/: connected/);
  await clientB.waitFor(/: connected/);

  const { status, payload } = await jsonFetch(base, 'POST', '/api/feedings', {
    feedTypes: ['formula', 'breast_milk'],
    amountMl: 120,
  });
  assert.equal(status, 201);

  const expected = new RegExp(`"type":"feed".*"amountMl":120`);
  await clientA.waitFor(expected);
  await clientB.waitFor(expected);
  assert.ok(clientA.text.includes(`"id":${payload.event.id}`));
});

test('记录大小便后广播 diaper 事件', async (t) => {
  const { port, base } = await startApp(t);
  const client = await connectSse(port);
  t.after(() => client.close());
  await client.waitFor(/: connected/);

  const { status } = await jsonFetch(base, 'POST', '/api/diapers', { diaperKind: 'poop' });
  assert.equal(status, 201);
  await client.waitFor(/"type":"diaper".*"diaperKind":"poop"/);
});

test('删除记录后广播 delete 事件', async (t) => {
  const { port, base } = await startApp(t);
  const created = await jsonFetch(base, 'POST', '/api/feedings', {
    feedTypes: ['breast_direct'],
  });
  assert.equal(created.status, 201);
  const id = created.payload.event.id;

  const client = await connectSse(port);
  t.after(() => client.close());
  await client.waitFor(/: connected/);

  const removed = await jsonFetch(base, 'DELETE', `/api/events/${id}`);
  assert.equal(removed.status, 204);
  await client.waitFor(new RegExp(`"type":"delete","id":${id}`));
});

test('心跳帧按 sseHeartbeatMs 发送', async (t) => {
  const { port } = await startApp(t, { sseHeartbeatMs: 60 });
  const client = await connectSse(port);
  t.after(() => client.close());

  await client.waitFor(/: ping/, 3000);
});

test('关闭应用会结束所有 SSE 连接', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naiji-sse-close-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), serveWeb: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(() => rm(dir, { recursive: true, force: true }));

  const client = await connectSse(port);
  await client.waitFor(/: connected/);

  await app.close();
  await client.waitClosed(3000);
  assert.equal(client.closed, true);
});

test('同一浏览器多次增删：同一毫秒记录也都能收到广播', async (t) => {
  const { port, base } = await startApp(t);
  const client = await connectSse(port);
  t.after(() => client.close());
  await client.waitFor(/: connected/);

  const happenedAt = Date.now();
  const first = await jsonFetch(base, 'POST', '/api/feedings', {
    feedTypes: ['formula'],
    amountMl: 60,
    happenedAt,
  });
  const second = await jsonFetch(base, 'POST', '/api/feedings', {
    feedTypes: ['formula'],
    amountMl: 90,
    happenedAt,
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  await client.waitFor(new RegExp(`"id":${first.payload.event.id}`));
  await client.waitFor(new RegExp(`"id":${second.payload.event.id}`));
});
