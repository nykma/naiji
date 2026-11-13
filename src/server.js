/**
 * 奶记 · HTTP 服务
 *
 * - 零第三方依赖：node:http + node:sqlite，静态托管 public/
 * - REST API 与行为契约见 docs/CONTRACT.md
 * - 可直接 `node src/server.js` 启动，也可在测试里 `createApp()` 后自行 listen
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb } from './db.js';
import { buildState } from './state.js';
import { isValidTzOffset } from './util/time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
export const DEFAULT_PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'baby.db');

const MAX_BODY_BYTES = 64 * 1024;
const NOTE_MAX_LENGTH = 200;
const AMOUNT_MIN_ML = 1;
const AMOUNT_MAX_ML = 2000;
const HAPPENED_AT_MIN_MS = Date.UTC(2000, 0, 1);
const HAPPENED_AT_FUTURE_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;
const RECENT_LIMIT = 30;

const FEED_TYPES = new Set(['formula', 'breast_milk', 'breast_direct']);
const DIAPER_KINDS = new Set(['pee', 'poop', 'mixed']);

const FEED_TYPE_TEXT = { formula: '奶粉', breast_milk: '母乳（瓶喂）', breast_direct: '亲喂' };
const DIAPER_KIND_TEXT = { pee: '小便', poop: '大便', mixed: '大小便' };

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// 响应助手
// ---------------------------------------------------------------------------

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// 请求体解析与校验
// ---------------------------------------------------------------------------

/**
 * 读取并解析 JSON 请求体。
 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, status: number, code: string, message: string }>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      resolve({
        ok: false,
        status: 415,
        code: 'unsupported_media_type',
        message: '请求体必须是 application/json',
      });
      req.resume();
      return;
    }

    let settled = false;
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve({ ok: false, status: 413, code: 'payload_too_large', message: '请求体过大' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({ ok: false, status: 400, code: 'invalid_json', message: '请求体不能为空' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        resolve({ ok: false, status: 400, code: 'invalid_json', message: '请求体不是合法 JSON' });
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        resolve({ ok: false, status: 400, code: 'invalid_json', message: '请求体必须是 JSON 对象' });
        return;
      }
      resolve({ ok: true, value: parsed });
    });

    req.on('error', () => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, status: 400, code: 'invalid_json', message: '读取请求体失败' });
      }
    });
  });
}

function validateAmount(rawAmount, feedType) {
  if (feedType === 'breast_direct') {
    if (rawAmount === undefined || rawAmount === null) return { ok: true, value: null };
    return {
      ok: false,
      status: 400,
      code: 'unexpected_amount',
      message: '亲喂不需要填写奶量',
    };
  }
  if (rawAmount === undefined || rawAmount === null) {
    return { ok: false, status: 400, code: 'invalid_amount', message: '请填写奶量（毫升）' };
  }
  if (!Number.isInteger(rawAmount) || rawAmount < AMOUNT_MIN_ML || rawAmount > AMOUNT_MAX_ML) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_amount',
      message: `奶量必须是 ${AMOUNT_MIN_ML} 到 ${AMOUNT_MAX_ML} 之间的整数（毫升）`,
    };
  }
  return { ok: true, value: rawAmount };
}

function validateHappenedAt(raw, nowMs) {
  if (raw === undefined || raw === null) return { ok: true, value: nowMs };
  if (!Number.isInteger(raw) || raw < HAPPENED_AT_MIN_MS || raw > nowMs + HAPPENED_AT_FUTURE_TOLERANCE_MS) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_happened_at',
      message: '记录时间不合法（必须是毫秒时间戳，且不能晚于当前时间 5 分钟）',
    };
  }
  return { ok: true, value: raw };
}

function validateNote(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, status: 400, code: 'invalid_note', message: '备注必须是字符串' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > NOTE_MAX_LENGTH) {
    return { ok: false, status: 400, code: 'invalid_note', message: `备注不能超过 ${NOTE_MAX_LENGTH} 个字符` };
  }
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

function handleHealth(_req, res) {
  sendJson(res, 200, { ok: true });
}

function handleState(_req, res, url, store, nowMs) {
  const raw = url.searchParams.get('tzOffset');
  let tzOffset = null;
  if (raw !== null) {
    if (!/^-?\d{1,4}$/.test(raw)) return sendError(res, 400, 'invalid_tz_offset', 'tzOffset 必须是整数分钟');
    const parsed = Number(raw);
    if (!isValidTzOffset(parsed)) {
      return sendError(res, 400, 'invalid_tz_offset', 'tzOffset 必须在 -840 到 840 之间');
    }
    tzOffset = parsed;
  }
  sendJson(res, 200, buildState(store, nowMs, tzOffset));
}

function handleListEvents(_req, res, url, store) {
  let limit = DEFAULT_EVENT_LIMIT;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) return sendError(res, 400, 'invalid_limit', 'limit 必须是整数');
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_EVENT_LIMIT) {
      return sendError(res, 400, 'invalid_limit', `limit 必须在 1 到 ${MAX_EVENT_LIMIT} 之间`);
    }
  }

  let before = null;
  let beforeId = null;
  const rawBefore = url.searchParams.get('before');
  if (rawBefore !== null) {
    if (!/^\d{1,16}$/.test(rawBefore)) return sendError(res, 400, 'invalid_cursor', 'before 必须是毫秒时间戳');
    before = Number(rawBefore);
    const rawBeforeId = url.searchParams.get('beforeId');
    if (rawBeforeId !== null) {
      if (!/^\d{1,16}$/.test(rawBeforeId)) return sendError(res, 400, 'invalid_cursor', 'beforeId 必须是整数');
      beforeId = Number(rawBeforeId);
    }
  }

  sendJson(res, 200, { events: store.listEvents({ limit, before, beforeId }) });
}

async function handleCreateFeeding(req, res, store, nowMs) {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);

  const { feedType } = body.value;
  if (!FEED_TYPES.has(feedType)) {
    return sendError(res, 400, 'invalid_feed_type', '喂奶类型无效（formula / breast_milk / breast_direct）');
  }
  const amount = validateAmount(body.value.amountMl, feedType);
  if (!amount.ok) return sendError(res, amount.status, amount.code, amount.message);
  const happenedAt = validateHappenedAt(body.value.happenedAt, nowMs);
  if (!happenedAt.ok) return sendError(res, happenedAt.status, happenedAt.code, happenedAt.message);
  const note = validateNote(body.value.note);
  if (!note.ok) return sendError(res, note.status, note.code, note.message);

  const event = store.createEvent({
    kind: 'feed',
    feedType,
    amountMl: amount.value,
    diaperKind: null,
    note: note.value,
    happenedAt: happenedAt.value,
    createdAt: nowMs,
  });
  sendJson(res, 201, { event });
}

async function handleCreateDiaper(req, res, store, nowMs) {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);

  const { diaperKind } = body.value;
  if (!DIAPER_KINDS.has(diaperKind)) {
    return sendError(res, 400, 'invalid_diaper_kind', '大小便类型无效（pee / poop / mixed）');
  }
  const happenedAt = validateHappenedAt(body.value.happenedAt, nowMs);
  if (!happenedAt.ok) return sendError(res, happenedAt.status, happenedAt.code, happenedAt.message);
  const note = validateNote(body.value.note);
  if (!note.ok) return sendError(res, note.status, note.code, note.message);

  const event = store.createEvent({
    kind: 'diaper',
    feedType: null,
    amountMl: null,
    diaperKind,
    note: note.value,
    happenedAt: happenedAt.value,
    createdAt: nowMs,
  });
  sendJson(res, 201, { event });
}

function handleDeleteEvent(res, id, store) {
  if (!store.deleteEvent(id)) {
    return sendError(res, 404, 'not_found', '记录不存在');
  }
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function formatLocalDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}`;
}

function formatLocalDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function handleExportCsv(res, store, nowMs) {
  const lines = ['时间,类别,项目,奶量(ml),备注'];
  for (const event of store.allEvents()) {
    const isFeed = event.kind === 'feed';
    lines.push(
      [
        formatLocalDateTime(event.happenedAt),
        isFeed ? '喂奶' : '大小便',
        isFeed ? (FEED_TYPE_TEXT[event.feedType] ?? '') : (DIAPER_KIND_TEXT[event.diaperKind] ?? ''),
        isFeed && event.amountMl !== null ? event.amountMl : '',
        event.note,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const body = `\uFEFF${lines.join('\r\n')}\r\n`;
  const filename = `baby-milk-${formatLocalDate(nowMs)}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "script-src 'self'; manifest-src 'self'";

async function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  if (decodedPath === '/' || decodedPath === '') decodedPath = '/index.html';

  const root = path.resolve(publicDir);
  const target = path.resolve(root, `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendText(res, 404, 'Not Found');
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return sendText(res, 404, 'Not Found');
  }
  if (!info.isFile()) return sendText(res, 404, 'Not Found');

  const ext = path.extname(target).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (ext === '.html') headers['Content-Security-Policy'] = CSP;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(target);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// 应用工厂
// ---------------------------------------------------------------------------

/**
 * 创建应用（不自动 listen，便于测试）。
 * @param {{ dbPath?: string, publicDir?: string, now?: () => number }} [options]
 * @returns {{ server: http.Server, store: import('./db.js').Store, dbPath: string, close: () => Promise<void> }}
 */
export function createApp({ dbPath = DEFAULT_DB_PATH, publicDir = DEFAULT_PUBLIC_DIR, now = () => Date.now() } = {}) {
  const store = openDb(dbPath);

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const elapsed = Date.now() - startedAt;
      console.log(`${req.method} ${req.url} ${res.statusCode} ${elapsed}ms`);
    });

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { pathname } = url;
      const nowMs = now();

      if (pathname === '/api/health' && req.method === 'GET') return handleHealth(req, res);
      if (pathname === '/api/state' && req.method === 'GET') return handleState(req, res, url, store, nowMs);
      if (pathname === '/api/events' && req.method === 'GET') return handleListEvents(req, res, url, store);
      if (pathname === '/api/feedings' && req.method === 'POST') {
        return await handleCreateFeeding(req, res, store, nowMs);
      }
      if (pathname === '/api/diapers' && req.method === 'POST') {
        return await handleCreateDiaper(req, res, store, nowMs);
      }
      if (pathname === '/api/export.csv' && req.method === 'GET') return handleExportCsv(res, store, nowMs);

      const deleteMatch = /^\/api\/events\/([1-9]\d{0,15})$/.exec(pathname);
      if (deleteMatch) {
        if (req.method !== 'DELETE') return sendError(res, 405, 'method_not_allowed', '不支持的请求方法');
        return handleDeleteEvent(res, Number(deleteMatch[1]), store);
      }

      if (pathname.startsWith('/api/')) {
        return sendError(res, 404, 'not_found', '接口不存在');
      }

      return await serveStatic(req, res, pathname, publicDir);
    } catch (error) {
      console.error('[server] 未捕获错误:', error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      return sendError(res, 500, 'internal_error', '服务器内部错误');
    }
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    store.close();
  };

  return { server, store, dbPath, close };
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function localUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }
  return urls;
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 不合法: ${process.env.PORT}`);
    process.exit(1);
  }

  const app = createApp({ dbPath });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, host, resolve);
    });
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用，可以用 PORT=3001 npm start 换一个端口。`);
    } else {
      console.error('启动失败:', error);
    }
    process.exit(1);
  }

  const actualPort = app.server.address().port;
  console.log('');
  console.log('  🍼 奶记 · 婴儿喂养记录已启动');
  console.log(`     数据库: ${dbPath}`);
  console.log('     打开页面:');
  for (const url of localUrls(actualPort)) console.log(`       ${url}`);
  console.log('     Ctrl+C 停止');
  console.log('');

  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭...`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error('启动失败:', error);
    process.exitCode = 1;
  });
}
