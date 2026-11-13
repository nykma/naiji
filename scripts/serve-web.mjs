#!/usr/bin/env node
/**
 * 奶记 · 独立托管 web/ 静态前端（验证前后端分离部署，零依赖）
 *
 * 用法：
 *   node scripts/serve-web.mjs                        # http://127.0.0.1:8080
 *   node scripts/serve-web.mjs --port 9000 --host 0.0.0.0
 *   node scripts/serve-web.mjs --api http://192.168.1.10:3000
 *
 * 指定 --api 时，终端会打印带 「?api=...」 的地址，前端据此跨源访问 API
 * （server 端默认 CORS_ORIGINS=* ，无需额外配置）。
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "script-src 'self'; manifest-src 'self'; connect-src *";

function parseArgs(argv) {
  const opts = { port: 8080, host: '127.0.0.1', dir: path.join(ROOT, 'web'), api: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' || arg === '-p') {
      opts.port = Number(next);
      i += 1;
    } else if (arg === '--host') {
      opts.host = next;
      i += 1;
    } else if (arg === '--dir') {
      opts.dir = path.resolve(next);
      i += 1;
    } else if (arg === '--api') {
      opts.api = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/serve-web.mjs [--port 8080] [--host 127.0.0.1] [--dir web] [--api http://127.0.0.1:3000]');
      process.exit(0);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('--port 不合法');
    process.exit(2);
  }
  return opts;
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function serveStatic(req, res, pathname, webDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad Request');
  }
  if (decodedPath === '/' || decodedPath === '') decodedPath = '/index.html';

  const root = path.resolve(webDir);
  const target = path.resolve(root, `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`);
  if (target !== root && !target.startsWith(root + path.sep)) return sendText(res, 404, 'Not Found');

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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    serveStatic(req, res, pathname, opts.dir).catch((error) => {
      console.error('静态服务出错:', error);
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${opts.port} 已被占用，换一个 --port。`);
    else console.error('启动失败:', error);
    process.exit(1);
  });

  server.listen(opts.port, opts.host, () => {
    const host = opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host;
    console.log('');
    console.log('  🍼 奶记 web（纯静态，前后端分离部署）');
    console.log(`     目录: ${opts.dir}`);
    if (opts.api) {
      const base = opts.api.replace(/\/$/, '');
      console.log(`     API:  ${base}`);
      console.log(`     打开: http://${host}:${opts.port}/?api=${encodeURIComponent(base)}`);
    } else {
      console.log(`     打开: http://${host}:${opts.port}/`);
      console.log('     （同源模式；跨源请用 --api 或页面加 ?api=http://后端:3000）');
    }
    console.log('     Ctrl+C 停止');
    console.log('');
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
