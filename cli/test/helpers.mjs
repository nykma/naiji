/**
 * 奶记 CLI 测试辅助（本地 stub HTTP server / 输出捕获 / 临时配置目录）
 *
 * 注意：该文件位于 cli/test/ 下，`node --test` 会把它也当测试文件执行，
 * 但它只有函数定义、没有副作用，运行结果为空（通过）。
 */

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main } from '../src/cli.mjs';

/** 干净的测试环境变量（去掉可能影响结果的 NAIJI_SERVER / NO_COLOR / TERM） */
export function makeTestEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.NAIJI_SERVER;
  delete env.NO_COLOR;
  delete env.TERM;
  return { ...env, ...overrides };
}

/** 创建临时目录（测试结束请调用 removeTempDir） */
export function makeTempDir(prefix = 'naiji-cli-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 去掉 ANSI 颜色转义，便于断言纯文本 */
export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

/** 捕获 main() 的 stdout / stderr */
export function captureIO({ stdoutIsTTY = false, stderrIsTTY = false, stdinIsTTY = false } = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (chunk) => {
        out.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      },
      stderr: (chunk) => {
        err.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      },
      stdoutIsTTY,
      stderrIsTTY,
      stdinIsTTY,
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/**
 * 进程内运行 CLI 主流程并收集输出。
 * @param {string[]} argv
 * @param {{ env?: Record<string,string|undefined>, cwd?: string, now?: () => number, confirm?: Function, tty?: object }} [options]
 */
export async function runMain(argv, { env = makeTestEnv(), cwd, now, confirm, tty } = {}) {
  const capture = captureIO(tty);
  const overrides = { io: capture.io, env };
  if (cwd) overrides.cwd = cwd;
  if (now) overrides.now = now;
  if (confirm) overrides.confirm = confirm;
  const code = await main(argv, overrides);
  return { code, stdout: capture.stdout(), stderr: capture.stderr() };
}

/**
 * 启动本地 stub HTTP server。
 * handler(record, res, req) 中可用 replyJson / replyEmpty / replyCsv。
 * @returns {Promise<{ requests: object[], baseUrl: string, close: () => Promise<void> }>}
 */
export async function startStubServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const record = {
      method: req.method,
      pathname: parsedUrl.pathname,
      query: parsedUrl.searchParams,
      headers: req.headers,
      rawBody,
      body,
    };
    requests.push(record);
    try {
      await handler(record, res, req);
    } catch (error) {
      if (!res.headersSent) replyJson(res, 500, { error: 'stub_error', message: String(error) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function replyJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function replyEmpty(res, status = 204) {
  res.writeHead(status, { 'Content-Length': '0' });
  res.end();
}

export function replyCsv(res, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// 事件 / state 工厂
// ---------------------------------------------------------------------------

export function feedEvent({
  id = 1,
  feedTypes = ['formula'],
  amountMl = 120,
  note = null,
  happenedAt = Date.now(),
} = {}) {
  return {
    id,
    kind: 'feed',
    feedTypes,
    amountMl,
    diaperKind: null,
    note,
    happenedAt,
    createdAt: happenedAt,
  };
}

export function diaperEvent({
  id = 2,
  diaperKind = 'pee',
  note = null,
  happenedAt = Date.now(),
} = {}) {
  return {
    id,
    kind: 'diaper',
    feedTypes: null,
    amountMl: null,
    diaperKind,
    note,
    happenedAt,
    createdAt: happenedAt,
  };
}

export function bathEvent({
  id = 3,
  note = null,
  happenedAt = Date.now(),
} = {}) {
  return {
    id,
    kind: 'bath',
    feedTypes: null,
    amountMl: null,
    diaperKind: null,
    note,
    happenedAt,
    createdAt: happenedAt,
  };
}

export function emptyToday(overrides = {}) {
  return {
    date: '2026-01-15',
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
    ...overrides,
  };
}

export function makeState({
  now = Date.now(),
  lastFeeding = null,
  lastDiaper = null,
  lastBath = null,
  today = emptyToday(),
  recent = [],
} = {}) {
  return { now, lastFeeding, lastDiaper, lastBath, today, recent };
}
