/**
 * 奶记 · HTTP API 服务（v2，前后端分离）
 *
 * - 零第三方依赖：node:http + node:sqlite
 * - 纯 JSON API；可选托管 web/ 静态文件（SERVE_WEB=1，方便家庭单机部署）
 * - 支持 CORS，web 可独立部署到任意静态主机
 * - 契约见 docs/CONTRACT.md
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb } from './db.js';
import { buildState } from './state.js';
import {
  FEED_TYPE_LABELS,
  DIAPER_KIND_LABELS,
  isValidFeedType,
  requiresAmount,
  sortFeedTypes,
} from './feed-types.js';
import { isValidTzOffset } from './util/time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..', '..');
export const DEFAULT_WEB_DIR = path.join(ROOT_DIR, 'web');
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

const DIAPER_KINDS = new Set(['pee', 'poop', 'mixed']);

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

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "script-src 'self'; manifest-src 'self'; connect-src *";

// ---------------------------------------------------------------------------
// 响应与 CORS
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

/** @param {string[]} allowedOrigins `['*']` 或具体来源列表 */
function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  let allow = null;
  if (allowedOrigins.includes('*')) allow = '*';
  else if (origin && allowedOrigins.includes(origin)) allow = origin;
  if (!allow) return;
  res.setHeader('Access-Control-Allow-Origin', allow);
  if (allow !== '*') res.setHeader('Vary', 'Origin');
}

function handleCorsPreflight(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Length': '0',
  });
  res.end();
}

// ---------------------------------------------------------------------------
// SSE 实时推送（多端同步）
// ---------------------------------------------------------------------------

const SSE_HEARTBEAT_MS = 25_000;

/**
 * 极简 SSE hub：维护 /api/events/stream 的客户端连接，记录增删时广播 change 事件。
 * 帧格式：
 *   retry: 3000                       ← 浏览器自动重连间隔
 *   : connected                       ← 连接成功注释帧
 *   event: change
 *   data: {"type":"feed","event":{...}}   ← 新增记录
 *   data: {"type":"delete","id":12}       ← 删除记录
 *   : ping                            ← 心跳（默认 25s，防代理/浏览器空闲断开）
 *
 * @param {{ heartbeatMs?: number }} [options]
 */
function createSseHub({ heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
  const clients = new Set();
  let heartbeatTimer = null;

  function stopHeartbeatIfIdle() {
    if (clients.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function ensureHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        try {
          client.write(': ping\n\n');
        } catch {
          clients.delete(client);
        }
      }
      stopHeartbeatIfIdle();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function add(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    clients.add(res);
    ensureHeartbeat();

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clients.delete(res);
      stopHeartbeatIfIdle();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * @param {'feed'|'diaper'|'delete'} type
   * @param {Record<string, unknown>} payload
   */
  function broadcast(type, payload) {
    if (clients.size === 0) return;
    const frame = `event: change\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
    stopHeartbeatIfIdle();
  }

  function closeAll() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // 连接可能已断开，忽略
      }
    }
    clients.clear();
  }

  return {
    add,
    broadcast,
    closeAll,
    get size() {
      return clients.size;
    },
  };
}

// ---------------------------------------------------------------------------
// 请求体解析与校验
// ---------------------------------------------------------------------------

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

function fail(status, code, message) {
  return { ok: false, status, code, message };
}

/** feedTypes 校验 + 规范化（v1 旧客户端的单值 feedType 已在 handler 里包装成数组） */
function validateFeedTypes(raw) {
  if (raw === undefined || raw === null) {
    return fail(400, 'invalid_feed_types', '请至少选择一种喂奶类型（formula / breast_milk / breast_direct）');
  }
  if (!Array.isArray(raw)) {
    return fail(400, 'invalid_feed_types', 'feedTypes 必须是数组');
  }
  const list = raw;
  if (list.length === 0) {
    return fail(400, 'invalid_feed_types', '请至少选择一种喂奶类型');
  }
  if (list.length > 3) {
    return fail(400, 'invalid_feed_types', '喂奶类型最多 3 种');
  }
  if (list.some((type) => !isValidFeedType(type))) {
    return fail(400, 'invalid_feed_types', '喂奶类型无效（formula / breast_milk / breast_direct）');
  }
  const types = sortFeedTypes(list);
  if (types.length !== list.length) {
    return fail(400, 'invalid_feed_types', '喂奶类型不能重复');
  }
  return { ok: true, value: types };
}

function validateFeedAmount(raw, types) {
  if (!requiresAmount(types)) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    return fail(400, 'unexpected_amount', '仅亲喂时不需要填写奶量');
  }
  if (raw === undefined || raw === null) {
    return fail(400, 'invalid_amount', '请填写奶量（毫升）');
  }
  if (!Number.isInteger(raw) || raw < AMOUNT_MIN_ML || raw > AMOUNT_MAX_ML) {
    return fail(
      400,
      'invalid_amount',
      `奶量必须是 ${AMOUNT_MIN_ML} 到 ${AMOUNT_MAX_ML} 之间的整数（毫升）`,
    );
  }
  return { ok: true, value: raw };
}

function validateHappenedAt(raw, nowMs) {
  if (raw === undefined || raw === null) return { ok: true, value: nowMs };
  if (!Number.isInteger(raw) || raw < HAPPENED_AT_MIN_MS || raw > nowMs + HAPPENED_AT_FUTURE_TOLERANCE_MS) {
    return fail(
      400,
      'invalid_happened_at',
      '记录时间不合法（必须是毫秒时间戳，且不能晚于当前时间 5 分钟）',
    );
  }
  return { ok: true, value: raw };
}

function validateNote(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return fail(400, 'invalid_note', '备注必须是字符串');
  const trimmed = raw.trim();
  if (trimmed.length > NOTE_MAX_LENGTH) {
    return fail(400, 'invalid_note', `备注不能超过 ${NOTE_MAX_LENGTH} 个字符`);
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

async function handleCreateFeeding(req, res, store, nowMs, hub) {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, body.status, body.code, body.message);

  // 兼容 v1 客户端：{ feedType: "formula" } → [ "formula" ]
  const rawTypes =
    body.value.feedTypes !== undefined
      ? body.value.feedTypes
      : body.value.feedType !== undefined
        ? [body.value.feedType]
        : undefined;

  const types = validateFeedTypes(rawTypes);
  if (!types.ok) return sendError(res, types.status, types.code, types.message);
  const amount = validateFeedAmount(body.value.amountMl, types.value);
  if (!amount.ok) return sendError(res, amount.status, amount.code, amount.message);
  const happenedAt = validateHappenedAt(body.value.happenedAt, nowMs);
  if (!happenedAt.ok) return sendError(res, happenedAt.status, happenedAt.code, happenedAt.message);
  const note = validateNote(body.value.note);
  if (!note.ok) return sendError(res, note.status, note.code, note.message);

  const event = store.createFeedEvent({
    feedTypes: types.value,
    amountMl: amount.value,
    note: note.value,
    happenedAt: happenedAt.value,
    createdAt: nowMs,
  });
  sendJson(res, 201, { event });
  hub?.broadcast('feed', { event });
}

async function handleCreateDiaper(req, res, store, nowMs, hub) {
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

  const event = store.createDiaperEvent({
    diaperKind,
    note: note.value,
    happenedAt: happenedAt.value,
    createdAt: nowMs,
  });
  sendJson(res, 201, { event });
  hub?.broadcast('diaper', { event });
}

function handleDeleteEvent(res, id, store, hub) {
  if (!store.deleteEvent(id)) return sendError(res, 404, 'not_found', '记录不存在');
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
  hub?.broadcast('delete', { id });
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
    const project = isFeed
      ? (event.feedTypes ?? []).map((type) => FEED_TYPE_LABELS[type] ?? type).join(' + ')
      : (DIAPER_KIND_LABELS[event.diaperKind] ?? '');
    lines.push(
      [
        formatLocalDateTime(event.happenedAt),
        isFeed ? '喂奶' : '大小便',
        project,
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
// 静态文件（可选：托管 web/）
// ---------------------------------------------------------------------------

async function serveStatic(req, res, pathname, webDir) {
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

  const root = path.resolve(webDir);
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
 * @param {{
 *   dbPath?: string,
 *   webDir?: string,
 *   serveWeb?: boolean,
 *   corsOrigins?: string[],
 *   now?: () => number,
 *   sseHeartbeatMs?: number,
 * }} [options]
 */
export function createApp({
  dbPath = DEFAULT_DB_PATH,
  webDir = DEFAULT_WEB_DIR,
  serveWeb = true,
  corsOrigins = ['*'],
  now = () => Date.now(),
  sseHeartbeatMs = SSE_HEARTBEAT_MS,
} = {}) {
  const store = openDb(dbPath);
  const allowedOrigins = Array.isArray(corsOrigins) && corsOrigins.length > 0 ? corsOrigins : ['*'];
  const hub = createSseHub({ heartbeatMs: sseHeartbeatMs });

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
      const isApi = pathname.startsWith('/api/');

      if (isApi) {
        applyCors(req, res, allowedOrigins);
        if (req.method === 'OPTIONS') return handleCorsPreflight(res);
      }

      if (pathname === '/api/health' && req.method === 'GET') return handleHealth(req, res);
      if (pathname === '/api/state' && req.method === 'GET') return handleState(req, res, url, store, nowMs);
      if (pathname === '/api/events' && req.method === 'GET') return handleListEvents(req, res, url, store);
      if (pathname === '/api/events/stream' && req.method === 'GET') return hub.add(req, res);
      if (pathname === '/api/feedings' && req.method === 'POST') {
        return await handleCreateFeeding(req, res, store, nowMs, hub);
      }
      if (pathname === '/api/diapers' && req.method === 'POST') {
        return await handleCreateDiaper(req, res, store, nowMs, hub);
      }
      if (pathname === '/api/export.csv' && req.method === 'GET') return handleExportCsv(res, store, nowMs);

      const deleteMatch = /^\/api\/events\/([1-9]\d{0,15})$/.exec(pathname);
      if (deleteMatch) {
        if (req.method !== 'DELETE') return sendError(res, 405, 'method_not_allowed', '不支持的请求方法');
        return handleDeleteEvent(res, Number(deleteMatch[1]), store, hub);
      }

      if (isApi) return sendError(res, 404, 'not_found', '接口不存在');

      if (!serveWeb) {
        return sendError(
          res,
          404,
          'web_disabled',
          '静态托管已关闭（SERVE_WEB=0）：web 前端请独立部署（可用 scripts/serve-web.mjs），或访问 API 端口',
        );
      }
      return await serveStatic(req, res, pathname, webDir);
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
    hub.closeAll();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    store.close();
  };

  return { server, store, dbPath, webDir, hub, close };
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

function parseOrigins(raw) {
  if (!raw || !raw.trim()) return ['*'];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : DEFAULT_DB_PATH;
  const serveWeb = process.env.SERVE_WEB !== '0' && process.env.SERVE_WEB !== 'false';
  const webDir = process.env.WEB_DIR ? path.resolve(process.env.WEB_DIR) : DEFAULT_WEB_DIR;
  const corsOrigins = parseOrigins(process.env.CORS_ORIGINS);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 不合法: ${process.env.PORT}`);
    process.exit(1);
  }

  const app = createApp({ dbPath, webDir, serveWeb, corsOrigins });
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
  console.log('  🍼 奶记 API 已启动');
  console.log(`     数据库: ${dbPath}`);
  console.log(`     API:    http://localhost:${actualPort}/api/health`);
  if (serveWeb) {
    console.log('     网页:');
    for (const url of localUrls(actualPort)) console.log(`       ${url}`);
  } else {
    console.log('     网页:   SERVE_WEB=0（未托管静态文件，请独立部署 web/）');
  }
  console.log(`     CLI:    naiji status --server http://127.0.0.1:${actualPort}`);
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
