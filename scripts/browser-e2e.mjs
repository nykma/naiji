#!/usr/bin/env node
/**
 * 奶记 · 婴儿喂养记录 — v3 独立 QA 端到端脚本（零第三方依赖）
 *
 * 真正拉起 v3 的三个部分：
 *   1. 用真实 CLI 启动 `node server/src/server.js`（随机空闲端口 + 临时目录 SQLite）；
 *   2. 用 `node scripts/serve-web.mjs` 在另一个随机端口独立托管 web/，验证前后端分离 + CORS；
 *   3. spawn `cli/bin/naiji` 的端到端用例（status/feed/pee/poop/bath/log/today/undo/rm/export/config/错误退出码）；
 *   4. 启动系统 headless Chrome，用 Node 内置 WebSocket 走 Chrome DevTools Protocol 驱动真实页面：
 *      真实鼠标点击、真实键盘输入、真实确认弹窗、真实网络请求（含跨源预检 OPTIONS）；
 *   5. 断言 → 截图到 docs/screenshots/ → 清理 Chrome / 服务 / 临时目录；
 *   6. 全部通过 exit 0，有失败 exit 1。可重复执行（每次独立 DB / 端口 / 浏览器 profile）。
 *
 * v3 新增分组：
 *   - G06b 洗澡：一键记录 / toast / 时间线 / 今日汇总 / Hero「距上次换尿布/洗澡」重置 / 撤销 / 持久化 / SSE 他人记录；
 *   - G16b v3 契约：POST /api/baths 校验、state.lastBath/today.bathCount、/api/stats 形状与非法参数、CSV 洗澡行、v2→v3 迁移；
 *   - G18b 趋势卡：7/30 天切换、6 指标切换、数据点/汇总与 GET /api/stats 一致、空状态、320/390/900 无横向滚动、深色模式；
 *   - G17 补充 CLI 洗澡（bath/b/--note/--ago/--json/undo）、status/today/log 洗澡文案。
 *
 * 用法：
 *   node scripts/browser-e2e.mjs
 *   KEEP_ARTIFACTS=1 node scripts/browser-e2e.mjs   # 保留临时目录（调试用）
 *   E2E_MANIFEST=1 node scripts/browser-e2e.mjs     # 额外打印逐条断言清单（用于两次运行 diff）
 *
 * 覆盖 docs/CONTRACT.md v3 §4/§5/§6.4/§7/§8；本脚本只读产品代码，不修改 server/ web/ cli/ test/。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== *
 * 0. 配置与基础工具
 * ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER_ENTRY = path.join(ROOT, 'server', 'src', 'server.js');
const WEB_DIR = path.join(ROOT, 'web');
const SERVE_WEB_SCRIPT = path.join(ROOT, 'scripts', 'serve-web.mjs');
const CLI_ENTRY = path.join(ROOT, 'cli', 'bin', 'naiji.mjs');
const CLI_LAUNCHER = path.join(ROOT, 'cli', 'bin', 'naiji');
const QA_REPORT_V1 = path.join(ROOT, 'docs', 'qa-report-v1.md');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');

const NODE_BIN = process.env.NODE_BIN || process.execPath;
const CHROME_BIN = process.env.CHROME_BIN || '/etc/profiles/per-user/nykma/bin/google-chrome';
const KEEP_ARTIFACTS = process.env.KEEP_ARTIFACTS === '1';

const VIEWPORT_MOBILE = { width: 390, height: 844, dsf: 2, mobile: true };
const VIEWPORT_NARROW = { width: 320, height: 640, dsf: 2, mobile: true };
const VIEWPORT_DESKTOP = { width: 900, height: 900, dsf: 2, mobile: false };

const GAP_FORMAT_RE = /^(刚刚|\d+ 分钟|\d+ 小时( \d+ 分钟)?|\d+ 天( \d+ 小时)?)$/;
/** Hero 第三行 v3 文案「距上次换尿布/洗澡 X」的时长部分 */
const CLEANING_GAP_RE = /^距上次换尿布\/洗澡 (刚刚|\d+ 分钟|\d+ 小时( \d+ 分钟)?|\d+ 天( \d+ 小时)?)$/;
const FEED_LABELS = { formula: '奶粉', breast_milk: '母乳（瓶喂）', breast_direct: '亲喂' };
const DIAPER_LABELS = { pee: '小便', poop: '大便', mixed: '大小便' };

/** v3 趋势卡 6 个指标（与 web/app.js 的 STATS_METRICS 一致，仅用于断言） */
const STATS_METRICS = [
  { key: 'totalMl', label: '奶量', unit: 'ml' },
  { key: 'feedCount', label: '喂奶次数', unit: '次' },
  { key: 'breastDirectCount', label: '亲喂', unit: '次' },
  { key: 'peeCount', label: '小便', unit: '次' },
  { key: 'poopCount', label: '大便', unit: '次' },
  { key: 'bathCount', label: '洗澡', unit: '次' },
];
const STATS_X_LABEL_EVERY = 5; // 30 天视图每 5 天一个 X 标签

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tmpDir = null;
let serverProcess = null;
let webServerProcess = null;
const extraServerProcesses = [];
let chromeProcess = null;
let chromeExited = null;
let page = null;
let api = null;
let browserVersion = '';
let setupError = null;

const groups = [];
let currentGroup = null;
const failures = [];
const observations = [];
const screenshots = [];
const expectedIssues = []; // 故障注入期间的预期错误（不算失败，精确记录到报告）

/* ========================================================================== *
 * 1. 断言 / 记录框架
 * ========================================================================== */

function startGroup(id, title) {
  currentGroup = { id, title, rows: [], startedAt: Date.now() };
  groups.push(currentGroup);
  console.log(`\n── ${id} · ${title} ─────────────────────────────`);
}

function assert(ok, name, evidence = '') {
  const row = { name, ok: Boolean(ok), evidence: String(evidence) };
  if (!currentGroup) throw new Error('assert 必须在 group 内调用');
  currentGroup.rows.push(row);
  if (!row.ok) failures.push({ group: currentGroup.id, name, evidence });
  console.log(`  ${row.ok ? '✓ PASS' : '✗ FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
  return row.ok;
}

function assertEqual(actual, expected, name) {
  const ok = Object.is(actual, expected);
  return assert(
    ok,
    name,
    ok ? `= ${JSON.stringify(expected)}` : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

function assertMatch(text, regex, name) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const ok = regex.test(value);
  return assert(ok, name, ok ? `匹配 ${regex}，实际 "${value}"` : `不匹配 ${regex}，实际 "${value}"`);
}

function assertIncludes(text, needle, name) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const ok = value.includes(needle);
  return assert(ok, name, ok ? `包含「${needle}」` : `"${value}" 不包含「${needle}」`);
}

function assertNotIncludes(text, needle, name) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return assert(!value.includes(needle), name, `实际 "${value}"`);
}

function assertOneOf(actual, candidates, name) {
  const ok = candidates.includes(actual);
  return assert(ok, name, ok ? `= ${JSON.stringify(actual)}` : `期望属于 ${JSON.stringify(candidates)}，实际 ${JSON.stringify(actual)}`);
}

function note(name, detail = '') {
  observations.push({ name, detail });
  console.log(`  ⚠ 观察  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runGroup(id, title, fn) {
  startGroup(id, title);
  try {
    await fn();
  } catch (error) {
    assert(false, `${title}（步骤中断）`, error && error.message ? error.message : String(error));
    if (error && error.stack) {
      console.log(`  ↳ ${String(error.stack).split('\n').slice(0, 5).join('\n  ↳ ')}`);
    }
  }
  currentGroup.durationMs = Date.now() - currentGroup.startedAt;
}

/* ========================================================================== *
 * 2. 进程 / 端口 / 临时目录
 * ========================================================================== */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealth(baseUrl, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return await res.json();
      lastError = new Error(`health HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`服务启动超时（${timeoutMs}ms）：${lastError?.message ?? 'unknown'}`);
}

function launchServer({ port, dbPath, extraEnv = {}, label = 'server' }) {
  const child = spawn(NODE_BIN, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__label = label;
  const logLines = [];
  const append = (prefix) => (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) logLines.push(prefix + line.trim());
    }
    if (logLines.length > 800) logLines.splice(0, logLines.length - 800);
  };
  child.stdout.on('data', append(''));
  child.stderr.on('data', append('[stderr] '));
  child.once('exit', (code, signal) => {
    if (code !== 0 && code !== null && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      logLines.push(`[exit] code=${code} signal=${signal}`);
    }
  });
  return { child, logLines };
}

async function stopProcess(child, name) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish();
    }, 4000);
    child.once('exit', finish);
    try {
      // Chrome 以 detached 启动，杀整个进程组避免遗留子进程
      if (name === 'chrome' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

/* ========================================================================== *
 * 3. CDP 客户端
 * ========================================================================== */

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (event) => this._onMessage(event));
    ws.addEventListener('close', () => this._onClose());
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 15_000);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('WebSocket 连接失败'));
        },
        { once: true },
      );
    });
    return new CdpClient(ws);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(new Error(`CDP 已断开，无法发送 ${method}`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    for (const handler of this.handlers.get(message.method) ?? []) {
      Promise.resolve()
        .then(() => handler(message.params ?? {}))
        .catch((error) => console.error(`[cdp-handler] ${message.method}: ${error.message}`));
    }
  }

  _onClose() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('CDP 连接已关闭'));
    this.pending.clear();
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ========================================================================== *
 * 4. 页面驱动（真实点击 / 输入 / 截图 / 事件收集）
 * ========================================================================== */

function sel(testid) {
  return `[data-testid="${testid}"]`;
}

function jsString(value) {
  return JSON.stringify(value);
}

class PageClient {
  constructor(cdp) {
    this.cdp = cdp;
    this.requests = new Map();
    this.responses = [];
    this.consoleErrors = [];
    this.consoleOthers = [];
    this.exceptions = [];
    this.logErrors = [];
    this.requestFailures = [];
    this.dialogs = [];
    this.navigations = [];
    this.expectedWindow = null;
    this.failStateRequests = false;
    this.failPostRequests = false;
    this.holdFeedingRequests = false;
    this.heldRequestIds = [];
  }

  async enable() {
    const on = (method, fn) => this.cdp.on(method, fn);
    on('Network.requestWillBeSent', (params) => {
      this.requests.set(params.requestId, {
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        at: Date.now(),
      });
    });
    on('Network.responseReceived', (params) => {
      const request = this.requests.get(params.requestId) ?? {};
      const entry = {
        requestId: params.requestId,
        url: params.response.url,
        status: params.response.status,
        mimeType: params.response.mimeType,
        headers: Object.fromEntries(Object.entries(params.response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
        type: params.type,
        method: request.method ?? 'GET',
        at: Date.now(),
      };
      try {
        entry.path = new URL(entry.url).pathname;
      } catch {
        entry.path = entry.url;
      }
      this.responses.push(entry);
    });
    on('Network.loadingFailed', (params) => {
      const request = this.requests.get(params.requestId) ?? {};
      const entry = {
        requestId: params.requestId,
        url: request.url ?? '',
        method: request.method ?? '',
        errorText: params.errorText,
        canceled: Boolean(params.canceled),
        at: Date.now(),
      };
      if (entry.canceled) return;
      if (this.expectedWindow) {
        // 故障注入窗口内的网络失败都是主动制造的，精确记录且不计失败
        this._expect('network-failure', `${entry.method} ${entry.url} → ${entry.errorText}`);
        return;
      }
      this.requestFailures.push(entry);
    });
    on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args ?? []).map((arg) => this._argText(arg)).join(' ').trim();
      if (params.type === 'error') this._error('console', text);
      else this.consoleOthers.push({ type: params.type, text, at: Date.now() });
    });
    on('Runtime.exceptionThrown', (params) => {
      const description =
        params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '未知页面异常';
      this.exceptions.push({ text: description, at: Date.now() });
    });
    on('Log.entryAdded', (params) => {
      const entry = params.entry ?? {};
      if (entry.level === 'error') {
        if (this.expectedWindow) {
          this._expect('log-error', `${entry.source}: ${entry.text}`);
          return;
        }
        this.logErrors.push({ source: entry.source, text: entry.text, url: entry.url, at: Date.now() });
      } else if (entry.level === 'warning') {
        this.consoleOthers.push({ type: 'log-warning', text: `${entry.source}: ${entry.text}`, at: Date.now() });
      }
    });
    on('Page.frameNavigated', (params) => {
      if (params.frame && !params.frame.parentId) this.navigations.push({ url: params.frame.url, at: Date.now() });
    });
    on('Page.javascriptDialogOpening', async (params) => {
      this.dialogs.push({ type: params.type, message: params.message, at: Date.now() });
      try {
        await this.cdp.send('Page.handleJavaScriptDialog', { accept: true });
      } catch {
        /* 对话框可能已被其他逻辑关闭 */
      }
    });
    on('Fetch.requestPaused', async (params) => {
      try {
        if (this.failStateRequests) {
          await this.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' });
        } else if (this.failPostRequests) {
          await this.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' });
        } else if (this.holdFeedingRequests) {
          this.heldRequestIds.push(params.requestId);
        } else {
          await this.cdp.send('Fetch.continueRequest', { requestId: params.requestId });
        }
      } catch {
        /* ignore */
      }
    });

    for (const domain of ['Page', 'Runtime', 'Network', 'Log']) {
      await this.cdp.send(`${domain}.enable`);
    }
    await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.emulateMedia({ colorScheme: 'light' });
  }

  _argText(arg) {
    if (!arg) return '';
    if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
    return arg.description ?? arg.type ?? '';
  }

  _error(kind, text) {
    const entry = { kind, text, at: Date.now() };
    if (this.expectedWindow) {
      this._expect(kind, text);
      return;
    }
    this.consoleErrors.push(entry);
  }

  _expect(kind, text) {
    expectedIssues.push({ kind, text, reason: this.expectedWindow.reason, at: Date.now() });
    console.log(`  ⓘ 预期内错误（不计失败）：${kind} · ${text.slice(0, 160)}`);
  }

  /* ---------- 基础命令 ---------- */

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面 JS 异常：${description}`);
    }
    return result.result?.value;
  }

  async text(selector) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${jsString(selector)}); if (!el) return null; return el.textContent.replace(/\\s+/g, ' ').trim(); })()`,
    );
  }

  async textOfTestId(testid) {
    return this.text(sel(testid));
  }

  async exists(selector) {
    return Boolean(await this.evaluate(`Boolean(document.querySelector(${jsString(selector)}))`));
  }

  async isVisible(selector) {
    return Boolean(
      await this.evaluate(`(() => {
        const el = document.querySelector(${jsString(selector)});
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
      })()`),
    );
  }

  async attr(selector, name) {
    return this.evaluate(
      `(() => { const el = document.querySelector(${jsString(selector)}); return el ? el.getAttribute(${jsString(name)}) : null; })()`,
    );
  }

  async rect(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${jsString(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    })()`);
  }

  async scrollTop() {
    await this.evaluate('window.scrollTo(0, 0)');
    await sleep(120);
  }

  async waitForExpression(expression, { timeout = 8000, interval = 100, desc = '' } = {}) {
    const started = Date.now();
    let last = null;
    let lastError = null;
    while (Date.now() - started < timeout) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    throw new Error(
      `等待超时 ${timeout}ms：${desc || expression}（最后值 ${JSON.stringify(last)}${lastError ? `；异常 ${lastError.message}` : ''}）`,
    );
  }

  async waitForText(selector, needle, { timeout = 8000, desc = '' } = {}) {
    return this.waitForExpression(
      `(() => { const el = document.querySelector(${jsString(selector)}); if (!el) return false; const t = el.textContent.replace(/\\s+/g, ' ').trim(); return t.includes(${jsString(needle)}) ? t : false; })()`,
      { timeout, desc: desc || `${selector} 包含「${needle}」` },
    );
  }

  async waitForTestIdText(testid, needle, opts = {}) {
    return this.waitForText(sel(testid), needle, opts);
  }

  async waitForGone(selector, { timeout = 8000 } = {}) {
    return this.waitForExpression(`!document.querySelector(${jsString(selector)})`, {
      timeout,
      desc: `${selector} 消失`,
    });
  }

  async waitHistoryCount(count, { timeout = 8000 } = {}) {
    return this.waitForExpression(
      `document.querySelectorAll('[data-testid="history-list"] .event').length === ${Number(count)}`,
      { timeout, desc: `时间线条数 = ${count}` },
    );
  }

  /* ---------- 真实鼠标点击 / 键盘输入 ---------- */

  async click(selector) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${jsString(selector)});
      if (!el) return { missing: true };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, disabled: el.disabled === true };
    })()`);
    if (!box || box.missing) throw new Error(`点击目标不存在：${selector}`);
    if (box.width < 1 || box.height < 1) throw new Error(`点击目标不可见：${selector}`);
    if (box.disabled) return { clicked: false, disabled: true, box };
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(30);
    return { clicked: true, box };
  }

  async clickTestId(testid) {
    return this.click(sel(testid));
  }

  async clickAndAcceptDialog(selector, { timeout = 8000 } = {}) {
    const baseline = this.dialogs.length;
    const clickPromise = this.click(selector).catch((error) => ({ error }));
    const started = Date.now();
    while (this.dialogs.length <= baseline && Date.now() - started < timeout) await sleep(50);
    if (this.dialogs.length <= baseline) throw new Error('等待 window.confirm 对话框超时');
    await clickPromise;
    return this.dialogs[this.dialogs.length - 1];
  }

  async setInputValue(selector, value) {
    const target = String(value);
    await this.click(selector);
    await this.evaluate(`(() => {
      const el = document.querySelector(${jsString(selector)});
      el.focus();
      if (typeof el.select === 'function') el.select();
      else el.value = '';
    })()`);
    await this.cdp.send('Input.insertText', { text: target });
    let current = await this.evaluate(
      `(() => { const el = document.querySelector(${jsString(selector)}); return el ? el.value : null; })()`,
    );
    if (current !== target) {
      // 兜底：某些环境 insertText 不会触发 input，直接改值并派发 input 事件
      await this.evaluate(`(() => {
        const el = document.querySelector(${jsString(selector)});
        el.value = ${jsString(target)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      current = await this.evaluate(
        `(() => { const el = document.querySelector(${jsString(selector)}); return el ? el.value : null; })()`,
      );
    }
    return current;
  }

  /* ---------- 无障碍 / 对比度 ---------- */

  /** 通过 CDP Accessibility 域读取元素的无障碍名称（能正确反映 display:none 子节点） */
  async accessibleName(selector) {
    try {
      await this.cdp.send('Accessibility.enable');
    } catch {
      /* 已启用 */
    }
    const object = await this.cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${jsString(selector)})`,
      returnByValue: false,
    });
    if (!object.result?.objectId) return { role: null, name: null };
    const tree = await this.cdp.send('Accessibility.getPartialAXTree', {
      objectId: object.result.objectId,
      fetchRelatives: false,
    });
    const node = tree.nodes?.[0];
    return { role: node?.role?.value ?? null, name: node?.name?.value ?? null };
  }

  /** 读取「渐变背景元素 + 文字元素」并计算各渐变端点的对比度 */
  async gradientTextContrast(backgroundSelector, textSelector) {
    const info = await this.evaluate(`(() => {
      const bgEl = document.querySelector(${jsString(backgroundSelector)});
      const textEl = document.querySelector(${jsString(textSelector)});
      if (!bgEl || !textEl) return null;
      const bgStyle = getComputedStyle(bgEl);
      const textStyle = getComputedStyle(textEl);
      return {
        color: textStyle.color,
        backgroundImage: bgStyle.backgroundImage,
        background: bgStyle.backgroundColor,
        fontSize: textStyle.fontSize,
        fontWeight: textStyle.fontWeight,
      };
    })()`);
    if (!info) return null;
    const fg = parseRgb(info.color);
    const stops = [...String(info.backgroundImage).matchAll(/rgba?\(([^)]+)\)/g)].map((match) => {
      const parts = match[1].split(',').map((value) => Number(value.trim()));
      return { r: parts[0], g: parts[1], b: parts[2] };
    });
    if (stops.length === 0) {
      const solid = parseRgb(info.background);
      if (solid) stops.push(solid);
    }
    if (!fg || stops.length === 0) return { ...info, ratios: [], minRatio: 0 };
    const ratios = stops.map((stop) => contrastRatio(fg, stop));
    return { ...info, ratios, minRatio: Math.min(...ratios) };
  }

  /** 读取主按钮文字/渐变背景并计算各渐变端点的对比度 */
  async primaryButtonContrast(selector) {
    const info = await this.evaluate(`(() => {
      const el = document.querySelector(${jsString(selector)});
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.color, backgroundImage: cs.backgroundImage, fontSize: cs.fontSize, fontWeight: cs.fontWeight };
    })()`);
    if (!info) return null;
    const fg = parseRgb(info.color);
    const stops = [...String(info.backgroundImage).matchAll(/rgba?\(([^)]+)\)/g)].map((match) => {
      const parts = match[1].split(',').map((value) => Number(value.trim()));
      return { r: parts[0], g: parts[1], b: parts[2] };
    });
    if (!fg || stops.length === 0) return { ...info, ratios: [], minRatio: 0 };
    const ratios = stops.map((stop) => contrastRatio(fg, stop));
    return { ...info, ratios, minRatio: Math.min(...ratios) };
  }

  /* ---------- 视口 / 媒体 / 导航 ---------- */

  async setViewport({ width, height, dsf = 2, mobile = true }) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dsf,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    await sleep(200);
  }

  async emulateMedia({ colorScheme } = {}) {
    const features = [{ name: 'prefers-reduced-motion', value: 'reduce' }];
    if (colorScheme) features.unshift({ name: 'prefers-color-scheme', value: colorScheme });
    await this.cdp.send('Emulation.setEmulatedMedia', { features });
  }

  async navigate(url, { timeout = 15_000 } = {}) {
    const before = this.navigations.length;
    await this.cdp.send('Page.navigate', { url });
    await this._waitNavigation(before, timeout);
    await this.waitReady();
  }

  async reload({ timeout = 15_000 } = {}) {
    const before = this.navigations.length;
    await this.cdp.send('Page.reload', { ignoreCache: true });
    await this._waitNavigation(before, timeout);
    await this.waitReady();
  }

  async _waitNavigation(before, timeout) {
    const started = Date.now();
    while (this.navigations.length <= before && Date.now() - started < timeout) await sleep(80);
    if (this.navigations.length <= before) throw new Error('等待页面导航超时');
  }

  async waitReady({ timeout = 12_000 } = {}) {
    return this.waitForExpression(
      `(() => {
        if (document.readyState !== 'complete') return false;
        const feed = document.querySelector('[data-testid="gap-last-feed"]');
        const summary = document.querySelector('[data-testid="today-summary"]');
        if (!feed || !summary) return false;
        const a = feed.textContent.trim();
        const b = summary.textContent.trim();
        return a !== '正在加载…' && b !== '正在加载…';
      })()`,
      { timeout, desc: '首屏数据加载完成' },
    );
  }

  /* ---------- 网络等待 ---------- */

  async waitForResponse(predicate, { since = 0, timeout = 10_000 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const hit = this.responses.slice(since).find(predicate);
      if (hit) return hit;
      await sleep(50);
    }
    const recently = this.responses
      .slice(-6)
      .map((r) => `${r.method} ${r.path} → ${r.status}`)
      .join('; ');
    throw new Error(`等待网络响应超时；最近响应：${recently}`);
  }

  countRequests(predicate) {
    return [...this.requests.values()].filter(predicate).length;
  }

  /* ---------- 截图 ---------- */

  async screenshot(name, { fullPage = false } = {}) {
    await this.scrollTop();
    let params = { format: 'png', fromSurface: true };
    if (fullPage) {
      const metrics = await this.cdp.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      const width = Math.ceil(size.width);
      const height = Math.ceil(size.height);
      params = {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      };
    }
    return this._capture(name, params, { fullPage });
  }

  /** 不重置滚动位置，直接截当前视口（v3 趋势卡 / 洗澡记录后的页面用） */
  async screenshotViewport(name) {
    return this._capture(name, { format: 'png', fromSurface: true }, { fullPage: false });
  }

  /** 把目标元素滚到视口中央后截当前视口（元素级证据截图） */
  async screenshotOf(selector, name, { block = 'center' } = {}) {
    await this.evaluate(
      `(() => { const el = document.querySelector(${jsString(selector)}); if (el) el.scrollIntoView({ block: ${jsString(
        block,
      )}, inline: 'center' }); })()`,
    );
    await sleep(260);
    return this.screenshotViewport(name);
  }

  async _capture(name, params, { fullPage }) {
    const result = await this.cdp.send('Page.captureScreenshot', params, 30_000);
    const buffer = Buffer.from(result.data, 'base64');
    const file = path.join(SHOT_DIR, name);
    await writeFile(file, buffer);
    const info = pngSize(buffer);
    screenshots.push({ name, bytes: buffer.length, ...info });
    console.log(
      `  📸 ${name}  ${info.width}×${info.height}  ${(buffer.length / 1024).toFixed(1)} KB` +
        (fullPage ? '（整页）' : ''),
    );
  }
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0, png: false };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), png: true };
}

/* ========================================================================== *
 * 5. HTTP API 客户端（Node 侧造数 / 校验，不经过浏览器）
 * ========================================================================== */

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async request(pathname, { method = 'GET', json = undefined, body = undefined, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }
    const response = await fetch(this.baseUrl + pathname, init);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: response.status, headers: response.headers, buffer, text, data };
  }

  createFeeding(payload) {
    return this.request('/api/feedings', { method: 'POST', json: payload });
  }

  createDiaper(payload) {
    return this.request('/api/diapers', { method: 'POST', json: payload });
  }

  createBath(payload = {}) {
    return this.request('/api/baths', { method: 'POST', json: payload });
  }

  async stats(days, tzOffset) {
    const params = new URLSearchParams();
    if (days !== undefined && days !== null) params.set('days', String(days));
    if (tzOffset !== undefined && tzOffset !== null) params.set('tzOffset', String(tzOffset));
    const query = params.toString();
    return this.request(`/api/stats${query ? `?${query}` : ''}`);
  }

  async state(tzOffset) {
    const suffix = tzOffset === undefined || tzOffset === null ? '' : `?tzOffset=${tzOffset}`;
    const response = await this.request('/api/state' + suffix);
    return response.data;
  }

  async events(limit = 50, before = null, beforeId = null) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before !== null) params.set('before', String(before));
    if (beforeId !== null) params.set('beforeId', String(beforeId));
    const response = await this.request(`/api/events?${params.toString()}`);
    return response.data?.events ?? [];
  }

  async allEvents() {
    const out = [];
    let before = null;
    let beforeId = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const list = await this.events(200, before, beforeId);
      if (list.length === 0) break;
      out.push(...list);
      if (list.length < 200) break;
      const last = list[list.length - 1];
      before = last.happenedAt;
      beforeId = last.id;
    }
    return out;
  }

  deleteEvent(id) {
    return this.request(`/api/events/${id}`, { method: 'DELETE' });
  }

  exportCsv() {
    return this.request('/api/export.csv');
  }
}

/* ========================================================================== *
 * 6. 格式化辅助（与 public/lib/format.js 行为对齐，仅用于断言）
 * ========================================================================== */

const FEED_TYPE_ORDER_NODE = ['formula', 'breast_milk', 'breast_direct'];

/** 规范顺序 + 去重（与 web/lib/format.js 行为一致，仅用于断言） */
function sortFeedTypesNode(types) {
  const set = new Set(Array.isArray(types) ? types.filter((type) => FEED_TYPE_ORDER_NODE.includes(type)) : []);
  return FEED_TYPE_ORDER_NODE.filter((type) => set.has(type));
}

/** 多标签 → 中文，例：["formula","breast_milk"] → "奶粉 + 母乳（瓶喂）" */
function feedTypesLabelNode(types) {
  return sortFeedTypesNode(types)
    .map((type) => FEED_LABELS[type] ?? type)
    .join(' + ');
}

/** 事件标题（v3）：有奶量 → "奶粉 + 母乳（瓶喂） 120 ml"；仅亲喂 → "亲喂" */
function eventTitleNode(event) {
  if (!event) return '';
  if (event.kind === 'feed') {
    const types = Array.isArray(event.feedTypes)
      ? event.feedTypes
      : typeof event.feedType === 'string'
        ? [event.feedType]
        : [];
    const label = feedTypesLabelNode(types);
    if (event.amountMl === null || event.amountMl === undefined) return label || '喂奶';
    return label ? `${label} ${event.amountMl} ml` : `${event.amountMl} ml`;
  }
  if (event.kind === 'bath') return '洗澡';
  return DIAPER_LABELS[event.diaperKind] ?? '大小便';
}

/** 本地日历键 YYYY-MM-DD（与产品展示口径一致，仅用于断言） */
function formatDayKeyNode(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------- v3：趋势卡断言辅助（与 web/app.js 的纯函数口径保持一致） ---------- */

/** daily 里某指标的数值序列：非正 / 非法补 0（对应 web/app.js statsValues） */
function statsValuesNode(daily, metricKey) {
  return daily.map((item) => {
    const value = Number(item && item[metricKey]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
}

/** 日均格式化（对应 web/app.js formatAverage：最多 1 位小数，整数不带 .0） */
function formatAverageNode(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 汇总行期望文本：「N 天合计 X · 日均 Y · 最高 M（MM-DD）」（对应 renderStatsSummary） */
function statsSummaryExpectedNode(daily, days, metric) {
  const values = statsValuesNode(daily, metric.key);
  const unit = metric.unit === 'ml' ? 'ml' : '次';
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const maxIndex = max > 0 ? values.indexOf(max) : values.length - 1;
  const maxDay = daily[maxIndex];
  const maxDate = maxDay && typeof maxDay.date === 'string' ? maxDay.date.slice(5) : '—';
  const average = formatAverageNode(days > 0 ? total / days : 0);
  return `${days} 天合计 ${total} ${unit} · 日均 ${average} ${unit} · 最高 ${max} ${unit}（${maxDate}）`;
}

/** 读取趋势卡 DOM 快照（数据点 / 折线段 / X 标签 / 数值标签 / 汇总 / 控件状态） */
function pageStatsSnapshot() {
  return page.evaluate(`(() => {
    const chart = document.querySelector('[data-testid="stats-chart"]');
    const svg = chart ? chart.querySelector('svg') : null;
    const circles = svg ? [...svg.querySelectorAll('circle.stats-point')] : [];
    const line = svg ? svg.querySelector('.stats-line') : null;
    const d = line ? (line.getAttribute('d') || '') : '';
    const rangeOf = (testid) => {
      const el = document.querySelector('[data-testid="' + testid + '"]');
      return el ? el.getAttribute('aria-pressed') : null;
    };
    return {
      aria: chart ? chart.getAttribute('aria-label') : null,
      role: chart ? chart.getAttribute('role') : null,
      circles: circles.length,
      lineSegments: (d.match(/[ML]/g) || []).length,
      polyline: chart ? chart.querySelectorAll('polyline').length : 0,
      gridLines: chart ? chart.querySelectorAll('.stats-grid-line').length : 0,
      xLabels: chart ? [...chart.querySelectorAll('.stats-x-label')].map((el) => el.textContent) : [],
      valueLabels: chart ? [...chart.querySelectorAll('.stats-value-label')].map((el) => el.textContent) : [],
      emptyTexts: chart ? [...chart.querySelectorAll('.stats-empty-text')].map((el) => el.textContent) : [],
      summary: document.querySelector('[data-testid="stats-summary"]')
        ? document.querySelector('[data-testid="stats-summary"]').textContent
        : null,
      chartWidth: chart ? chart.clientWidth : 0,
      svgWidth: svg ? Number(svg.getAttribute('width')) : 0,
      range7: rangeOf('stats-range-7'),
      range30: rangeOf('stats-range-30'),
      metricsPressed: [...document.querySelectorAll('.stats-metric')]
        .filter((el) => el.getAttribute('aria-pressed') === 'true')
        .map((el) => el.dataset.metric),
      xLabelCount: chart ? chart.querySelectorAll('.stats-x-label').length : 0,
      gridLineCount: chart ? chart.querySelectorAll('.stats-grid-line').length : 0,
      valueLabelCount: chart ? chart.querySelectorAll('.stats-value-label').length : 0,
    };
  })()`);
}

/** 等待趋势卡 SVG 数据点数量达到预期（范围切换 / 指标切换后重绘） */
function waitStatsPoints(days, { timeout = 8000 } = {}) {
  return page.waitForExpression(
    `document.querySelectorAll('[data-testid="stats-chart"] circle.stats-point').length === ${Number(days)}`,
    { timeout, interval: 120, desc: `趋势卡数据点 = ${days}` },
  );
}

/** Node 侧 API 造一条洗澡记录 */
function seedBath(happenedAt, note) {
  const payload = {};
  if (happenedAt !== undefined) payload.happenedAt = happenedAt;
  if (note !== undefined) payload.note = note;
  return api.createBath(payload);
}

/** 轮询 GET /api/state 直到条件满足（SSE 应用 / 撤销回调都是异步的） */
async function waitApiState(predicate, { timeout = 8000, interval = 120, desc = 'API state 条件' } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await apiStateNow();
    if (predicate(last)) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时 ${timeout}ms：${desc}（最后 state.today=${JSON.stringify(last?.today ?? null)}）`);
}

/** 找出页面浏览器标签标题（document.title） */
const documentTitle = () => page.evaluate('document.title');

function parseRgb(colorText) {
  const match = /rgba?\(([^)]+)\)/.exec(String(colorText ?? ''));
  if (!match) return null;
  const parts = match[1].split(',').map((value) => Number(value.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ========================================================================== *
 * 7. Chrome 启动
 * ========================================================================== */

async function launchChrome(profileDir) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',
    '--window-size=390,844',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const child = spawn(CHROME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 30_000) stderr = stderr.slice(-30_000);
  });
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  chromeProcess = child;
  chromeExited = () => exited;

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 200; i += 1) {
    if (exited) throw new Error(`Chrome 启动失败（code=${exited.code}）：${stderr.slice(-1500)}`);
    try {
      const content = await readFile(portFile, 'utf8');
      const parsed = Number(content.split('\n')[0]);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        break;
      }
    } catch {
      /* 还没写入 */
    }
    await sleep(100);
  }
  if (!port) throw new Error(`Chrome 未在预期时间内写出 DevToolsActivePort：${stderr.slice(-1500)}`);

  let target = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* 端口还没就绪 */
    }
    await sleep(100);
  }
  if (!target) throw new Error('Chrome 未暴露可调试的 page target');

  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  const version = await cdp.send('Browser.getVersion');
  return { cdp, port, version: version.product ?? 'unknown', stderr: () => stderr };
}

/* ========================================================================== *
 * 8. 测试主体（v3：web 前端 + 洗澡/趋势卡 + 前后端分离跨源 + CLI 端到端）
 * ========================================================================== */

let tzOffset = 0; // 浏览器时区偏移，与 /api/state 对齐
let apiBase = ''; // API 服务地址（动态空闲端口）
let webBase = ''; // 独立托管 web/ 的静态服务地址（动态空闲端口）
let cliConfigDirPath = ''; // CLI 的临时 XDG_CONFIG_HOME，避免污染用户配置
let cliLogsRef = null;
let webLogsRef = [];

const shotNames = [
  'mobile-390.png',
  'mobile-390-after-record.png',
  'mobile-390-full.png',
  'mobile-320.png',
  'desktop-900.png',
  'dark-390.png',
  'empty-390.png',
  'multi-select-390.png',
  'cross-origin-390.png',
  // v3 新增：趋势卡（含 30 天视图与深色）与洗澡记录后的页面
  'stats-390.png',
  'stats-dark-390.png',
  'bath-390.png',
];

/* ---------- 8.1 通用辅助：HTTP / 进程 / CLI ---------- */

async function waitHttp(url, { timeout = 20_000, desc = url } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`等待 ${desc} 就绪超时（${timeout}ms）：${lastError?.message ?? 'unknown'}`);
}

/** 独立托管 web/ 的静态服务（scripts/serve-web.mjs，随机端口 + --api 指向后端） */
function launchWebServer({ port, api }) {
  const child = spawn(NODE_BIN, [SERVE_WEB_SCRIPT, '--port', String(port), '--host', '127.0.0.1', '--api', api], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines = [];
  const append = (prefix) => (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) logLines.push(prefix + line.trim());
    if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
  };
  child.stdout.on('data', append(''));
  child.stderr.on('data', append('[stderr] '));
  return { child, logLines };
}

/** 用采缓冲区方式 spawn 一个命令（CLI 输出可能是二进制 CSV） */
function spawnCapture(command, args, { env = {}, cwd = ROOT, timeoutMs = 40_000, detached = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    });
    const out = [];
    const err = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      resolve({ ...result, stdout, stderr, stdoutText: stdout.toString('utf8'), stderrText: stderr.toString('utf8') });
    };
    const timer = setTimeout(() => {
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ code: -1, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => finish({ code: -1, spawnError: error }));
    child.on('close', (code) => finish({ code }));
  });
}

/** CLI 运行环境：临时 XDG 配置目录、强制无色、不继承外部 NAIJI_SERVER */
function cliBaseEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb', XDG_CONFIG_HOME: cliConfigDirPath };
  delete env.NAIJI_SERVER;
  return { ...env, ...extra };
}

/** spawn `node cli/bin/naiji.mjs ...` */
function runCli(args, { env = {}, cwd = ROOT, timeoutMs = 40_000 } = {}) {
  return spawnCapture(NODE_BIN, [CLI_ENTRY, ...args], { env: cliBaseEnv(env), cwd, timeoutMs });
}

/** spawn `cli/bin/naiji` 启动器（/bin/sh → node，PATH 里补上 Node 目录以便验证启动器本身） */
function runCliLauncher(args, { env = {}, cwd = ROOT, timeoutMs = 40_000 } = {}) {
  const nodeDir = path.dirname(NODE_BIN);
  const launcherEnv = cliBaseEnv({ PATH: `${nodeDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...env });
  return spawnCapture(CLI_LAUNCHER, args, { env: launcherEnv, cwd, timeoutMs });
}

/** JSON 输出解析（--json 命令一律 stdout 单个 JSON） */
function cliJson(result) {
  try {
    return JSON.parse(result.stdoutText.trim());
  } catch {
    return null;
  }
}

/* ---------- 8.2 页面 / API 辅助 ---------- */

const segState = () =>
  page.evaluate(`Object.fromEntries([...document.querySelectorAll('.seg-btn')].map((el) => [el.dataset.feedType, el.getAttribute('aria-pressed')]))`);

const selectedTypes = async () => {
  const state = await segState();
  return ['formula', 'breast_milk', 'breast_direct'].filter((type) => state[type] === 'true');
};

const historyTitles = () =>
  page.evaluate(`[...document.querySelectorAll('[data-testid="history-list"] .event-title')].map((el) => el.textContent.trim())`);

const firstHistoryTitle = async () => (await historyTitles())[0] ?? null;

const domHistoryCount = () => page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`);

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

async function latestEvent() {
  const events = await api.events(1);
  return events[0] ?? null;
}

async function deleteAllEvents() {
  const events = await api.allEvents();
  let deleted = 0;
  for (const event of events) {
    const response = await api.deleteEvent(event.id);
    if (response.status === 204) deleted += 1;
  }
  return { total: events.length, deleted };
}

function seedFeed(feedTypes, amountMl, happenedAt, note) {
  const payload = { feedTypes };
  if (amountMl !== undefined && amountMl !== null) payload.amountMl = amountMl;
  if (happenedAt !== undefined) payload.happenedAt = happenedAt;
  if (note !== undefined) payload.note = note;
  return api.createFeeding(payload);
}

function seedDiaper(diaperKind, happenedAt, note) {
  const payload = { diaperKind };
  if (happenedAt !== undefined) payload.happenedAt = happenedAt;
  if (note !== undefined) payload.note = note;
  return api.createDiaper(payload);
}

async function clickTypeAndWait(testid, expectPressed) {
  await page.clickTestId(testid);
  await page.waitForExpression(
    `document.querySelector('[data-testid="${testid}"]').getAttribute('aria-pressed') === '${expectPressed ? 'true' : 'false'}'`,
    { timeout: 3000, desc: `${testid} aria-pressed=${expectPressed}` },
  );
}

async function ensureSelection(types) {
  const target = ['formula', 'breast_milk', 'breast_direct'].filter((type) => types.includes(type));
  for (const type of ['formula', 'breast_milk', 'breast_direct']) {
    const selector = type === 'formula' ? 'type-formula' : type === 'breast_milk' ? 'type-breast-milk' : 'type-breast-direct';
    const pressed = (await segState())[type] === 'true';
    const want = target.includes(type);
    if (pressed !== want) await clickTypeAndWait(selector, want);
  }
  const current = await selectedTypes();
  if (current.join(',') !== target.join(',')) throw new Error(`无法设置类型选择：期望 ${target}，实际 ${current}`);
}

async function apiStateNow() {
  return api.state(tzOffset);
}

/** 解析 PNG 后不需要；直接复用 page.screenshot */

/* ========================================================================== *
 * 9. 主流程
 * ========================================================================== */

async function main() {
  await ensureEnvironment();
  await mkdir(SHOT_DIR, { recursive: true });

  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'naiji-e2e-v3-'));
  const dbPath = path.join(tmpDir, 'qa-v3.db');
  cliConfigDirPath = path.join(tmpDir, 'cli-config');
  const apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  api = new ApiClient(apiBase);

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  奶记 v3 · 独立 QA（web E2E + 洗澡/趋势图 + 跨源部署 + CLI 端到端）');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Node      : ${process.version} (${NODE_BIN})`);
  console.log(`  项目根    : ${ROOT}`);
  console.log(`  临时 DB   : ${dbPath}`);
  console.log(`  API 服务  : ${apiBase}（真实 CLI: node server/src/server.js）`);
  console.log(`  截图目录  : ${path.relative(ROOT, SHOT_DIR)}/`);
  console.log('');

  const serverLaunch = launchServer({ port: apiPort, dbPath });
  serverProcess = serverLaunch.child;
  cliLogsRef = serverLaunch.logLines;

  try {
    /* ---------------------------------------------- 启动 API / 独立 web / Chrome */
    const health = await waitHealth(apiBase);
    console.log(`  [server] CLI 启动完成，/api/health → ${JSON.stringify(health)}`);

    const webPort = await freePort();
    webBase = `http://127.0.0.1:${webPort}`;
    const webLaunch = launchWebServer({ port: webPort, api: apiBase });
    webServerProcess = webLaunch.child;
    webLogsRef = webLaunch.logLines;
    await waitHttp(`${webBase}/`, { desc: '独立 web 静态服务' });
    console.log(`  [web] 独立静态服务就绪：${webBase}（serve-web.mjs --api ${apiBase}）`);

    const chrome = await launchChrome(path.join(tmpDir, 'chrome-profile'));
    console.log(`  [chrome] ${chrome.version}（CDP 端口 ${chrome.port}）`);
    browserVersion = chrome.version;

    page = new PageClient(chrome.cdp);
    await page.enable();
    await page.setViewport(VIEWPORT_MOBILE);
    await page.navigate(`${apiBase}/`);
    tzOffset = await page.evaluate('new Date().getTimezoneOffset()');
    console.log(`  [browser] 同源首屏加载完成，tzOffset=${tzOffset}`);
    console.log('');

    /* ------------------------------------------------ G00 环境与启动（真实 CLI 入口） */
    await runGroup('G00', '环境与启动（server CLI / 独立 web / Chrome）', async () => {
      const parts = process.version.replace(/^v/, '').split('.').map(Number);
      assert(
        parts[0] > 22 || (parts[0] === 22 && (parts[1] > 13 || (parts[1] === 13 && parts[2] >= 0))),
        'Node 版本满足 engines >= 22.13.0',
        `当前 ${process.version}`,
      );
      assertEqual(health?.ok, true, 'GET /api/health → 200 {ok:true}');
      const banner = cliLogsRef.join('\n');
      assertIncludes(banner, '奶记 API 已启动', 'server CLI 启动横幅（覆盖 node server/src/server.js 入口）');
      assertIncludes(banner, dbPath, 'server 使用 DB_PATH 指定的临时数据库');
      assertIncludes(banner, 'CLI:', 'server 启动日志打印 CLI 提示');
      assertMatch(browserVersion, /^Chrome\/\d+\./, 'headless Chrome 就绪', browserVersion);
      let shotDirOk = true;
      try {
        await access(SHOT_DIR);
      } catch {
        shotDirOk = false;
      }
      assert(shotDirOk, '截图目录 docs/screenshots/ 存在');
      assert(webServerProcess && webServerProcess.exitCode === null, '独立静态服务进程运行中', webBase);
      assertIncludes(webLogsRef.join('\n'), '奶记 web', 'serve-web.mjs 启动横幅（独立托管 web/）');
      assert(webBase.startsWith('http://127.0.0.1:'), '独立 web 使用动态空闲端口', webBase);
      assert(apiBase.startsWith('http://127.0.0.1:'), 'API 使用动态空闲端口', apiBase);
      const v1Report = await readFile(QA_REPORT_V1, 'utf8');
      assert(v1Report.length > 1000, '归档的 docs/qa-report-v1.md 保留且非空', `${v1Report.length} 字符`);
    });

    /* ------------------------------------------------ G01 首屏 200 / 空库 / 格式 / 秒级刷新 */
    await runGroup('G01', '首屏 200 / 空库 / 距离上次喂奶格式 / 秒级刷新', async () => {
      const docResponse = page.responses.find(
        (response) => response.type === 'Document' && response.path === '/' && response.status === 200,
      );
      assert(Boolean(docResponse), '首屏文档请求 GET / → 200', docResponse ? `${docResponse.method} ${docResponse.path} → ${docResponse.status}` : '未捕获 Document 200');

      const gapInitial = await page.textOfTestId('gap-duration');
      assertEqual(gapInitial, '还没开始', '空库首屏 Hero 显示「还没开始」');
      assert(await page.isVisible(sel('empty-state')), '空库首屏 empty-state 可见');
      const emptySummary = await page.textOfTestId('today-summary');
      assertIncludes(emptySummary, '喂奶 0 次', '空库今日汇总喂奶 0 次', `"${emptySummary}"`);
      assertIncludes(emptySummary, '奶量 0 ml', '空库今日汇总奶量 0 ml');
      assertIncludes(emptySummary, '洗澡 0 次', '空库今日汇总含 v3 新增「洗澡 0 次」', `"${emptySummary}"`);
      assertEqual(
        await page.textOfTestId('gap-last-diaper'),
        '还没有换尿布/洗澡记录',
        '空库 Hero 第三行显示 v3 文案「还没有换尿布/洗澡记录」',
      );
      // v3 趋势卡首屏即存在（懒加载数据，但 DOM 结构必须就位）
      assert(await page.isVisible(sel('stats-card')), 'v3 趋势卡 stats-card 首屏已渲染');
      assertEqual(await page.attr(sel('stats-range-7'), 'aria-pressed'), 'true', '趋势卡默认选中「7 天」');
      assertEqual(await page.attr(sel('stats-range-30'), 'aria-pressed'), 'false', '趋势卡「30 天」默认未选中');
      assertEqual(await page.attr(sel('stats-metric-totalMl'), 'aria-pressed'), 'true', '趋势卡默认指标为「奶量 ml」');
      const emptyChartText = await page.waitForText(sel('stats-chart'), '最近 7 天还没有数据', {
        timeout: 8000,
        desc: '空库趋势卡空状态',
      });
      assertIncludes(emptyChartText, '最近 7 天还没有数据', '空库趋势卡显示「最近 7 天还没有数据」', `"${emptyChartText}"`);
      assertEqual(await page.attr(sel('export-csv'), 'href'), '/api/export.csv', '同源模式下导出链接为相对 /api/export.csv');

      // 造一条 90 分钟前的多标签喂奶（奶粉 + 母乳瓶喂）
      const seed = await seedFeed(['formula', 'breast_milk'], 120, Date.now() - 90 * 60_000, 'QA 首屏种子');
      assertEqual(seed.status, 201, 'API 注入 90 分钟前「奶粉 + 母乳（瓶喂）」120ml');
      assertDeepEqual(
        seed.data?.event?.feedTypes,
        ['formula', 'breast_milk'],
        'API 返回 feedTypes 按规范顺序（formula → breast_milk）',
      );
      await page.reload();
      const gapText = await page.textOfTestId('gap-duration');
      assertMatch(gapText, GAP_FORMAT_RE, 'gap-duration 文案符合契约格式（刚刚 | N 分钟 | H 小时 M 分钟 | D 天 H 小时）');
      assertOneOf(gapText, ['1 小时 30 分钟', '1 小时 31 分钟'], 'H 小时 M 分钟 数值正确（约 90 分钟）');
      const lastFeedText = await page.textOfTestId('gap-last-feed');
      assertIncludes(lastFeedText, '上次', 'gap-last-feed 显示「上次 HH:mm · 项目」');
      assertIncludes(lastFeedText, '奶粉 + 母乳（瓶喂） 120 ml', '上次喂奶显示多标签标题');
      const summaryText = await page.textOfTestId('today-summary');
      assertIncludes(summaryText, '喂奶 1 次', '今日汇总计入新喂奶');
      assertIncludes(summaryText, '奶量 120 ml', '今日汇总奶量 = 120 ml');
      assertIncludes(summaryText, '亲喂 0 次', '今日汇总亲喂 0 次');
      await page.screenshot('mobile-390.png');

      // 秒级刷新：注入 2 分 50 秒前记录，观察 2 分钟 → 3 分钟
      const ticker = await seedFeed(['formula'], 60, Date.now() - (2 * 60_000 + 50_000));
      assertEqual(ticker.status, 201, 'API 注入用于验证秒级刷新的记录');
      await page.reload();
      const gapBefore = await page.textOfTestId('gap-duration');
      assertMatch(gapBefore, GAP_FORMAT_RE, '刷新后 Hero 仍为合法时长文案', `"${gapBefore}"`);
      let gapAfter = null;
      const refreshStarted = Date.now();
      try {
        gapAfter = await page.waitForExpression(
          `(() => { const el = document.querySelector('[data-testid="gap-duration"]'); return el && el.textContent.trim() === '3 分钟' ? '3 分钟' : false; })()`,
          { timeout: 15_000, interval: 200, desc: 'Hero 时长自动从 2 分钟跳到 3 分钟' },
        );
      } catch {
        gapAfter = await page.textOfTestId('gap-duration');
      }
      assertEqual(gapAfter, '3 分钟', 'Hero 每秒自动刷新（2 分钟 → 3 分钟）', `等待 ${Date.now() - refreshStarted}ms 后 "${gapAfter}"`);
    });

    /* ------------------------------------------------ G02 多选类型核心记录 */
    await runGroup('G02', '多选类型：奶粉 + 母乳（瓶喂）120ml 一键记录', async () => {
      assertDeepEqual(await segState(), { formula: 'true', breast_milk: 'false', breast_direct: 'false' }, '默认只选中「奶粉」（aria-pressed）');
      assert(await page.isVisible(sel('amount-panel')), '默认显示奶量面板');
      assert(!(await page.isVisible(sel('direct-panel'))), '默认隐藏亲喂面板');

      await clickTypeAndWait('type-breast-milk', true);
      assertDeepEqual(await segState(), { formula: 'true', breast_milk: 'true', breast_direct: 'false' }, '点击后「奶粉 + 母乳·瓶喂」同时选中（多选 toggle）');
      assertIncludes(await page.textOfTestId('amount-hint'), '奶粉 + 母乳（瓶喂）', '奶量面板标题显示当前标签组合');
      assert(!(await page.isVisible(sel('bottle-tip'))), '纯瓶喂组合不显示「补充瓶喂量」提示');

      const before = await apiStateNow();
      const beforeCount = (await api.allEvents()).length;
      const responsesSince = page.responses.length;
      await page.clickTestId('volume-chip-120');
      const postResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/feedings',
        { since: responsesSince },
      );
      assertEqual(postResponse.status, 201, '网络请求 POST /api/feedings → 201');
      const toastText = await page.waitForText(sel('toast'), '奶粉 + 母乳（瓶喂）', { desc: '多选记录 toast' });
      assertIncludes(toastText, '已记录 奶粉 + 母乳（瓶喂） 120 ml', 'toast 文案「已记录 奶粉 + 母乳（瓶喂） 120 ml」', `"${toastText}"`);
      assert(await page.exists(sel('toast-undo')), 'toast 带撤销按钮');
      await page.screenshot('multi-select-390.png');
      const toastRect = await page.rect(sel('toast'));
      const poopRect = await page.rect(sel('record-poop'));
      if (toastRect && poopRect) {
        const overlapY = Math.min(toastRect.bottom, poopRect.bottom) - Math.max(toastRect.y, poopRect.y);
        if (overlapY > 8) {
          note(
            '记录成功 toast 遮挡下方操作区（P2 体验）',
            `toast 与「大便」按钮垂直重叠约 ${Math.round(overlapY)}px；5 秒内被覆盖区域不可点击（toast pointer-events:auto），建议记录成功后自动滚动避开或缩短展示时长`,
          );
        } else {
          assert(true, '记录成功 toast 未遮挡主要操作按钮');
        }
      }

      const gapText = await page.waitForText(sel('gap-duration'), '刚刚', { desc: 'Hero 变「刚刚」' });
      assertEqual(gapText, '刚刚', 'Hero 立即归零为「刚刚」');
      const after = await apiStateNow();
      assertEqual(after.today.totalMl, before.today.totalMl + 120, '今日汇总 totalMl +120');
      assertEqual(after.today.feedCount, before.today.feedCount + 1, '今日 feedCount +1');
      assertEqual(after.today.formulaCount, before.today.formulaCount + 1, '今日 formulaCount +1');
      assertEqual(after.today.breastMilkCount, before.today.breastMilkCount + 1, '今日 breastMilkCount +1');
      assertEqual(after.today.mixedFeedCount, before.today.mixedFeedCount + 1, '今日 mixedFeedCount +1（多标签）');
      assertEqual(after.today.breastDirectCount, before.today.breastDirectCount, '今日 breastDirectCount 不变');
      const created = await latestEvent();
      assertDeepEqual(created?.feedTypes, ['formula', 'breast_milk'], '服务端最新记录 feedTypes = ["formula","breast_milk"]');
      assertEqual(created?.amountMl, 120, '服务端最新记录 amountMl = 120（总奶量）');
      const summaryText = await page.textOfTestId('today-summary');
      assertIncludes(summaryText, `${after.today.totalMl} ml`, '今日汇总条展示正确累计奶量', `"${summaryText}"`);
      assertEqual((await api.allEvents()).length, beforeCount + 1, '服务端事件数 +1');
      const titles = await historyTitles();
      assertEqual(titles[0], '奶粉 + 母乳（瓶喂） 120 ml', '时间线首条标题为多标签组合', JSON.stringify(titles.slice(0, 2)));
    });

    /* ------------------------------------------------ G03 撤销 */
    await runGroup('G03', 'toast 撤销：多标签记录不残留', async () => {
      const eventsBefore = await api.allEvents();
      const created = eventsBefore[0];
      assert(Boolean(created), '撤销前存在刚创建的多标签记录');
      const domCountBefore = await domHistoryCount();
      const responsesSince = page.responses.length;
      await page.clickTestId('toast-undo');
      const deleteResponse = await page.waitForResponse(
        (response) => response.method === 'DELETE' && /^\/api\/events\/\d+$/.test(response.path),
        { since: responsesSince },
      );
      assertEqual(deleteResponse.status, 204, '撤销调用 DELETE /api/events/:id → 204');
      const undoToast = await page.waitForText(sel('toast'), '已撤销', { desc: '撤销 toast' });
      assertIncludes(undoToast, '已撤销', '撤销后 toast 提示「已撤销」');
      await page.waitHistoryCount(domCountBefore - 1);
      const after = await api.allEvents();
      assertEqual(after.length, eventsBefore.length - 1, '撤销后服务端事件数恢复');
      assert(!after.some((event) => event.id === created.id), '被撤销记录在 GET /api/events 中不存在（无残留）');
      const latestFeed = after.find((event) => event.kind === 'feed');
      const gapLastFeed = await page.textOfTestId('gap-last-feed');
      assertIncludes(gapLastFeed, eventTitleNode(latestFeed), 'Hero 上次喂奶回退到上一条记录', `期望包含「${eventTitleNode(latestFeed)}」`);
      assertMatch(await page.textOfTestId('gap-duration'), GAP_FORMAT_RE, '撤销后 Hero 时长仍为合法格式');
    });

    /* ------------------------------------------------ G04 单标签 / 仅亲喂 / 亲喂+瓶喂 / 至少一个 / 记忆 */
    await runGroup('G04', '单标签 / 仅亲喂 / 亲喂 + 瓶喂组合 / 至少一个 / 类型记忆', async () => {
      // 当前选择：formula + breast_milk（G02 选择，G03 撤销不影响）
      await ensureSelection(['formula', 'breast_milk']);

      // A) 单标签：奶粉
      await clickTypeAndWait('type-breast-milk', false);
      assertDeepEqual(await selectedTypes(), ['formula'], '取消母乳后只剩「奶粉」');
      const beforeFormula = await apiStateNow();
      const sinceA = page.responses.length;
      await page.clickTestId('volume-chip-60');
      const respA = await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/feedings', { since: sinceA });
      assertEqual(respA.status, 201, '单标签「奶粉」60ml POST → 201');
      const toastA = await page.waitForText(sel('toast'), '已记录 奶粉 60 ml', { desc: '奶粉 60ml toast' });
      assertIncludes(toastA, '已记录 奶粉 60 ml', '单标签 toast 文案', `"${toastA}"`);
      const afterFormula = await apiStateNow();
      assertEqual(afterFormula.today.totalMl, beforeFormula.today.totalMl + 60, '单标签奶粉：totalMl +60');
      assertEqual(afterFormula.today.formulaCount, beforeFormula.today.formulaCount + 1, '单标签奶粉：formulaCount +1');
      assertEqual(afterFormula.today.mixedFeedCount, beforeFormula.today.mixedFeedCount, '单标签奶粉：mixedFeedCount 不变');
      const eventA = await latestEvent();
      assertDeepEqual(eventA?.feedTypes, ['formula'], '服务端记录 feedTypes = ["formula"]');
      assertEqual(eventA?.amountMl, 60, '服务端记录 amountMl = 60');
      assertEqual(await firstHistoryTitle(), '奶粉 60 ml', '时间线首条「奶粉 60 ml」');

      // B) 单标签：母乳（瓶喂）
      await clickTypeAndWait('type-breast-milk', true);
      await clickTypeAndWait('type-formula', false);
      assertDeepEqual(await selectedTypes(), ['breast_milk'], '只保留「母乳·瓶喂」');
      const beforeBreast = await apiStateNow();
      const sinceB = page.responses.length;
      await page.clickTestId('volume-chip-60');
      await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/feedings', { since: sinceB });
      const toastB = await page.waitForText(sel('toast'), '已记录 母乳（瓶喂） 60 ml', { desc: '母乳瓶喂 toast' });
      assertIncludes(toastB, '已记录 母乳（瓶喂） 60 ml', '单标签母乳 toast 文案');
      const afterBreast = await apiStateNow();
      assertEqual(afterBreast.today.totalMl, beforeBreast.today.totalMl + 60, '单标签母乳：totalMl +60');
      assertEqual(afterBreast.today.breastMilkCount, beforeBreast.today.breastMilkCount + 1, '单标签母乳：breastMilkCount +1');
      assertDeepEqual((await latestEvent())?.feedTypes, ['breast_milk'], '服务端记录 feedTypes = ["breast_milk"]');

      // C) 仅亲喂
      await clickTypeAndWait('type-breast-direct', true); // breast_milk + breast_direct
      await clickTypeAndWait('type-breast-milk', false); // 只剩 breast_direct
      assertDeepEqual(await selectedTypes(), ['breast_direct'], '只保留「亲喂」（仅亲喂模式）');
      assert(!(await page.isVisible(sel('amount-panel'))), '仅亲喂时隐藏奶量面板');
      assert(await page.isVisible(sel('direct-panel')), '仅亲喂时显示「亲喂一次」按钮');
      assertEqual(await page.textOfTestId('amount-hint'), '', '仅亲喂时奶量提示为空');
      assert(!(await page.isVisible(sel('bottle-tip'))), '仅亲喂时不显示瓶喂量提示');
      const beforeDirect = await apiStateNow();
      const sinceC = page.responses.length;
      await page.clickTestId('record-breast-direct');
      const respC = await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/feedings', { since: sinceC });
      assertEqual(respC.status, 201, '仅亲喂 POST → 201');
      const toastC = await page.waitForText(sel('toast'), '已记录 亲喂', { desc: '亲喂 toast' });
      assertIncludes(toastC, '已记录 亲喂', '仅亲喂 toast 文案');
      const afterDirect = await apiStateNow();
      assertEqual(afterDirect.today.breastDirectCount, beforeDirect.today.breastDirectCount + 1, '仅亲喂：breastDirectCount +1');
      assertEqual(afterDirect.today.totalMl, beforeDirect.today.totalMl, '仅亲喂：totalMl 不变（无奶量）');
      const directEvent = await latestEvent();
      assertDeepEqual(directEvent?.feedTypes, ['breast_direct'], '仅亲喂记录 feedTypes = ["breast_direct"]');
      assertEqual(directEvent?.amountMl, null, '仅亲喂记录 amountMl = null');
      assertEqual(await firstHistoryTitle(), '亲喂', '时间线首条「亲喂」');

      // D) 亲喂 + 奶粉组合（有奶量）
      await clickTypeAndWait('type-formula', true); // formula + breast_direct
      assertDeepEqual(await selectedTypes(), ['formula', 'breast_direct'], '同时选中「奶粉 + 亲喂」');
      assert(await page.isVisible(sel('amount-panel')), '亲喂 + 奶粉时显示奶量面板');
      assert(!(await page.isVisible(sel('direct-panel'))), '亲喂 + 瓶喂组合时隐藏独立亲喂按钮（由奶量面板记录组合）');
      assert(await page.isVisible(sel('bottle-tip')), '亲喂 + 瓶喂组合显示「奶量填写本次补充的瓶喂量」提示');
      assertIncludes(await page.textOfTestId('amount-hint'), '奶粉 + 亲喂', '奶量面板标题显示「奶粉 + 亲喂」');
      const beforeMix = await apiStateNow();
      const sinceD = page.responses.length;
      await page.clickTestId('volume-chip-60');
      await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/feedings', { since: sinceD });
      const toastD = await page.waitForText(sel('toast'), '奶粉 + 亲喂', { desc: '亲喂+奶粉 toast' });
      assertIncludes(toastD, '已记录 奶粉 + 亲喂 60 ml', '亲喂 + 奶粉 toast 文案', `"${toastD}"`);
      await page.screenshot('mobile-390-after-record.png');
      const afterMix = await apiStateNow();
      assertEqual(afterMix.today.totalMl, beforeMix.today.totalMl + 60, '亲喂 + 奶粉：totalMl +60');
      assertEqual(afterMix.today.mixedFeedCount, beforeMix.today.mixedFeedCount + 1, '亲喂 + 奶粉：mixedFeedCount +1');
      const mixEvent = await latestEvent();
      assertDeepEqual(mixEvent?.feedTypes, ['formula', 'breast_direct'], '组合记录 feedTypes = ["formula","breast_direct"]（规范顺序）');
      assertEqual(mixEvent?.amountMl, 60, '组合记录 amountMl = 60');
      assertEqual(await firstHistoryTitle(), '奶粉 + 亲喂 60 ml', '时间线首条「奶粉 + 亲喂 60 ml」');

      // E) 至少保留一个类型
      await clickTypeAndWait('type-formula', false); // 只剩 breast_direct
      assertDeepEqual(await selectedTypes(), ['breast_direct'], '只剩唯一类型「亲喂」');
      await page.clickTestId('type-breast-direct'); // 再点唯一选中项：应保持选中并提示
      const guardToast = await page.waitForText(sel('toast'), '至少要保留一种', { desc: '至少保留一种类型提示' });
      assertIncludes(guardToast, '至少要保留一种喂奶类型', '点击唯一选中类型时给出提示', `"${guardToast}"`);
      assertDeepEqual(await selectedTypes(), ['breast_direct'], '唯一选中类型不会被取消（至少保留一个）');
      await clickTypeAndWait('type-formula', true); // 恢复 formula + breast_direct

      // F) 选择持久化（localStorage + 刷新）
      assertEqual(
        await page.evaluate(`localStorage.getItem('naiji.feedTypes')`),
        '["formula","breast_direct"]',
        '类型选择按规范顺序持久化到 localStorage[naiji.feedTypes]',
      );
      await page.reload();
      assertDeepEqual(await selectedTypes(), ['formula', 'breast_direct'], '刷新后仍保持「奶粉 + 亲喂」选择');
      assert(await page.isVisible(sel('bottle-tip')), '刷新后亲喂+瓶喂提示仍显示');
      await ensureSelection(['formula']);
      assertDeepEqual(await selectedTypes(), ['formula'], '复位为默认「奶粉」选择');
    });

    /* ------------------------------------------------ G05 自定义奶量 999ml + 前端校验 */
    await runGroup('G05', '自定义奶量 999ml + 前端范围校验', async () => {
      assert(await page.isVisible(sel('amount-panel')), '奶粉模式下奶量面板可见');
      const setValue = await page.setInputValue(sel('custom-amount-input'), '999');
      assertEqual(setValue, '999', '自定义输入框可输入 999');
      const before = await apiStateNow();
      const since = page.responses.length;
      await page.clickTestId('custom-amount-submit');
      const resp = await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/feedings', { since });
      assertEqual(resp.status, 201, '自定义 999ml POST → 201（合法范围 1–2000）');
      const toast = await page.waitForText(sel('toast'), '999', { desc: '999ml toast' });
      assertIncludes(toast, '已记录 奶粉 999 ml', 'toast 显示「已记录 奶粉 999 ml」');
      const after = await apiStateNow();
      assertEqual(after.today.totalMl, before.today.totalMl + 999, '今日 totalMl +999');
      assertEqual((await latestEvent())?.amountMl, 999, '服务端记录 amountMl = 999');
      assertEqual(await firstHistoryTitle(), '奶粉 999 ml', '时间线首条「奶粉 999 ml」');
      const undoRect = await page.rect(sel('toast-undo'));
      assert(undoRect && undoRect.height >= 44, 'toast「撤销」按钮高度 ≥ 44px（触控友好）', undoRect ? `${Math.round(undoRect.width)}×${Math.round(undoRect.height)}px` : '未测量到');

      const postCountBefore = page.countRequests((request) => request.method === 'POST' && request.url.includes('/api/feedings'));
      await page.setInputValue(sel('custom-amount-input'), '2001');
      await page.clickTestId('custom-amount-submit');
      const errorToast = await page.waitForText(sel('toast'), '奶量必须是', { desc: '非法奶量错误 toast' });
      assertIncludes(errorToast, '1 到 2000', '超范围时前端提示「奶量必须是 1 到 2000 之间的整数」');
      await sleep(700);
      assertEqual(
        page.countRequests((request) => request.method === 'POST' && request.url.includes('/api/feedings')),
        postCountBefore,
        '非法奶量被前端拦截，未发出 POST 请求',
      );
    });

    /* ------------------------------------------------ G06 大小便 + 连点防重复 */
    await runGroup('G06', '大小便一键记录 + 请求中禁用防连点', async () => {
      const before = await apiStateNow();
      const sincePee = page.responses.length;
      await page.clickTestId('record-pee');
      const peeResp = await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/diapers', { since: sincePee });
      assertEqual(peeResp.status, 201, '小便 POST /api/diapers → 201');
      await page.waitForText(sel('toast'), '已记录 小便', { desc: '小便 toast' });
      const afterPee = await apiStateNow();
      assertEqual(afterPee.today.peeCount, before.today.peeCount + 1, 'peeCount +1');
      const sincePoop = page.responses.length;
      await page.clickTestId('record-poop');
      await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/diapers', { since: sincePoop });
      await page.waitForText(sel('toast'), '已记录 大便', { desc: '大便 toast' });
      const afterPoop = await apiStateNow();
      assertEqual(afterPoop.today.poopCount, before.today.poopCount + 1, 'poopCount +1');
      const historyText = await page.textOfTestId('history-list');
      assertIncludes(historyText, '小便', '时间线包含「小便」');
      assertIncludes(historyText, '大便', '时间线包含「大便」');

      // 连点防重复：挂起第一次 POST，验证按钮禁用、第二次点击不产生请求
      const postCount = () => page.countRequests((request) => request.method === 'POST' && request.url.includes('/api/feedings'));
      const beforePosts = postCount();
      const beforeEvents = (await api.allEvents()).length;
      await page.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/feedings*', requestStage: 'Request' }] });
      page.holdFeedingRequests = true;
      try {
        await page.evaluate(`document.querySelector('[data-testid="volume-chip-90"]').scrollIntoView({ block: 'center' })`);
        const rect = await page.rect(sel('volume-chip-90'));
        const dispatchClick = async () => {
          const x = Math.round(rect.x + rect.width / 2);
          const y = Math.round(rect.y + rect.height / 2);
          await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
          await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        };
        const sinceHold = page.responses.length;
        await dispatchClick();
        await sleep(120);
        assertEqual(
          await page.evaluate(`document.querySelector('[data-testid="volume-chip-90"]').disabled`),
          true,
          '请求进行中「90ml」按钮被禁用（防连点）',
        );
        await dispatchClick();
        await sleep(150);
        assertEqual(page.heldRequestIds.length, 1, '连点两次只发出 1 个 POST 请求（第二次未触发）', `held=${page.heldRequestIds.length}`);
        page.holdFeedingRequests = false;
        const held = [...page.heldRequestIds];
        page.heldRequestIds = [];
        for (const requestId of held) await page.cdp.send('Fetch.continueRequest', { requestId });
        const postResponse = await page.waitForResponse((r) => r.method === 'POST' && r.path === '/api/feedings', { since: sinceHold });
        assertEqual(postResponse.status, 201, '放行后 POST → 201');
        await page.waitForText(sel('toast'), '已记录 奶粉 90 ml', { desc: '90ml 记录 toast' });
        assertEqual(postCount() - beforePosts, 1, '快速连点两次只产生 1 次 POST');
        assertEqual((await api.allEvents()).length, beforeEvents + 1, '服务端只新增 1 条记录');
      } finally {
        await page.cdp.send('Fetch.disable');
        page.holdFeedingRequests = false;
        page.heldRequestIds = [];
      }
      const deleteSince = page.responses.length;
      await page.clickTestId('toast-undo');
      await page.waitForResponse((r) => r.method === 'DELETE' && /^\/api\/events\/\d+$/.test(r.path), { since: deleteSince });
      await sleep(250);
      assertEqual((await api.allEvents()).length, beforeEvents, '撤销后事件数恢复（连点测试数据已清理）');
    });

    /* ------------------------------------------------ G06b 洗澡（v3 新增） */
    await runGroup('G06b', '洗澡：一键记录 / toast / 时间线 / 汇总 / Hero 计时重置 / 撤销 / 持久化 / SSE', async () => {
      // 结构：大小便卡片第三个按钮，文案「洗澡」，点击区 ≥ 44px
      const bathButtonText = (await page.textOfTestId('record-bath')).trim();
      assertIncludes(bathButtonText, '洗澡', '「记录大小便」卡片第三个按钮文案包含「洗澡」');
      assertIncludes(bathButtonText, '🛁', '洗澡按钮带 🛁 图标');
      const diaperButtons = await page.evaluate(
        `[...document.querySelectorAll('.diaper-grid .diaper-btn')].map((el) => el.dataset.testid)`,
      );
      assertDeepEqual(
        diaperButtons,
        ['record-pee', 'record-poop', 'record-bath'],
        '大小便卡片按钮顺序为 小便 / 大便 / 洗澡（v3 新增第三个）',
      );
      const bathRect = await page.rect(sel('record-bath'));
      assert(
        bathRect && Math.min(bathRect.width, bathRect.height) >= 44,
        '洗澡按钮点击区 ≥ 44px',
        bathRect ? `${Math.round(bathRect.width)}×${Math.round(bathRect.height)}px` : '未测量到',
      );

      // 清掉 G06 刚记录的大小便（它们会让 Hero 显示「刚刚」），构造「45 分钟前换尿布」的计时基准
      const priorDiapers = (await api.allEvents()).filter((event) => event.kind === 'diaper');
      for (const event of priorDiapers) await api.deleteEvent(event.id);
      assertEqual(
        (await api.allEvents()).filter((event) => event.kind === 'diaper').length,
        0,
        '清理已有大小便记录（构造 Hero 计时基准）',
      );
      const diaperAgo = Date.now() - 45 * 60_000;
      const seededDiaper = await seedDiaper('pee', diaperAgo);
      assertEqual(seededDiaper.status, 201, 'API 造 45 分钟前小便（Hero 计时对照）');
      // 另造一条 50 分钟前的大便：Hero 仍取较晚的 45 分钟小便，同时保留「大便」数据供后续 CSV 断言使用
      const seededPoop = await seedDiaper('poop', diaperAgo - 5 * 60_000);
      assertEqual(seededPoop.status, 201, 'API 造 50 分钟前大便（保留大便数据）');
      await page.reload();
      const gapBeforeBath = await page.waitForExpression(
        `(() => { const el = document.querySelector('[data-testid="gap-last-diaper"]'); const t = el ? el.textContent.trim() : ''; return ${CLEANING_GAP_RE}.test(t) ? t : false; })()`,
        { timeout: 8000, desc: '洗澡前 Hero 第三行显示换尿布计时' },
      );
      assertMatch(gapBeforeBath, /^距上次换尿布\/洗澡 (44|45|46) 分钟$/, '洗澡前 Hero 显示「距上次换尿布/洗澡」约 45 分钟', `"${gapBeforeBath}"`);

      const bathCountBefore = (await apiStateNow()).today.bathCount ?? 0;
      const eventsBeforeBath = (await api.allEvents()).length;
      const domBeforeBath = await domHistoryCount();

      // 一键记录洗澡：POST /api/baths → toast → 时间线 / 今日汇总 / Hero
      const bathSince = page.responses.length;
      await page.clickTestId('record-bath');
      const bathPost = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/baths',
        { since: bathSince },
      );
      assertEqual(bathPost.status, 201, '点击「洗澡」→ POST /api/baths → 201');
      const bathToast = await page.waitForText(sel('toast'), '已记录 洗澡', { desc: '洗澡 toast' });
      assertIncludes(bathToast, '已记录 洗澡', 'toast 文案「已记录 洗澡」', `"${bathToast}"`);
      assert(await page.exists(sel('toast-undo')), '洗澡 toast 带撤销按钮');
      const heroAfterBath = await page.waitForText(sel('gap-last-diaper'), '刚刚', { desc: '洗澡后 Hero 归零' });
      assertEqual(heroAfterBath, '距上次换尿布/洗澡 刚刚', '洗澡重置 Hero「距上次换尿布/洗澡」为「刚刚」', `"${heroAfterBath}"`);
      await page.waitHistoryCount(domBeforeBath + 1);
      assertEqual(await firstHistoryTitle(), '洗澡', '时间线首条为「洗澡」');
      const bathIcon = await page.evaluate(
        `document.querySelector('[data-testid="history-list"] .event .event-icon').textContent.trim()`,
      );
      assertEqual(bathIcon, '🛁', '时间线洗澡记录图标为 🛁');
      const summaryAfterBath = await page.textOfTestId('today-summary');
      assertIncludes(summaryAfterBath, `洗澡 ${bathCountBefore + 1} 次`, '今日汇总洗澡次数 +1', `"${summaryAfterBath}"`);
      const stateAfterBath = await apiStateNow();
      assertEqual(stateAfterBath.today.bathCount, bathCountBefore + 1, '服务端 today.bathCount +1');
      assertEqual(stateAfterBath.lastBath?.kind, 'bath', '服务端 lastBath.kind = "bath"');
      assertEqual(stateAfterBath.lastBath?.feedTypes, null, 'lastBath.feedTypes = null');
      assertEqual(stateAfterBath.lastBath?.amountMl, null, 'lastBath.amountMl = null');
      assertEqual(stateAfterBath.lastBath?.diaperKind, null, 'lastBath.diaperKind = null');
      assertEqual((await api.allEvents()).length, eventsBeforeBath + 1, '服务端事件数 +1');
      const bathCreated = await latestEvent();
      assertEqual(bathCreated?.kind, 'bath', '服务端最新记录 kind = "bath"');
      await page.screenshot('bath-390.png');

      // 撤销洗澡：toast-undo → DELETE → 服务端 bathCount 恢复 / Hero 回退到小便计时
      const undoSince = page.responses.length;
      await page.clickTestId('toast-undo');
      const undoDelete = await page.waitForResponse(
        (response) => response.method === 'DELETE' && /^\/api\/events\/\d+$/.test(response.path),
        { since: undoSince },
      );
      assertEqual(undoDelete.status, 204, '撤销洗澡 → DELETE /api/events/:id → 204');
      const undoToast = await page.waitForText(sel('toast'), '已撤销', { desc: '撤销洗澡 toast' });
      assertIncludes(undoToast, '已撤销「洗澡」', '撤销 toast 文案「已撤销「洗澡」」', `"${undoToast}"`);
      await page.waitForExpression(
        `document.querySelectorAll('[data-testid="history-list"] .event').length === ${domBeforeBath}`,
        { timeout: 8000, desc: '撤销后时间线恢复条数' },
      );
      assertEqual(await domHistoryCount(), domBeforeBath, '撤销后时间线恢复为记录前条数');
      const stateAfterUndo = await waitApiState(
        (state) => (state.today.bathCount ?? 0) === bathCountBefore,
        { desc: '撤销后服务端 bathCount 恢复' },
      );
      assertEqual(stateAfterUndo.today.bathCount, bathCountBefore, '撤销后服务端 bathCount 恢复');
      assertEqual(stateAfterUndo.lastBath, null, '撤销后服务端 lastBath = null（此前无洗澡记录）');
      assertEqual((await api.allEvents()).length, eventsBeforeBath, '撤销后服务端事件数恢复');
      const heroAfterUndo = await page.textOfTestId('gap-last-diaper');
      assertMatch(
        heroAfterUndo,
        /^距上次换尿布\/洗澡 (44|45|46|47) 分钟$/,
        '撤销洗澡后 Hero 回退到小便计时（约 45 分钟）',
        `"${heroAfterUndo}"`,
      );

      // 持久化：再记录一次洗澡 → 刷新后仍在
      const persistSince = page.responses.length;
      await page.clickTestId('record-bath');
      await page.waitForResponse((response) => response.method === 'POST' && response.path === '/api/baths', {
        since: persistSince,
      });
      await page.waitForText(sel('toast'), '已记录 洗澡', { desc: '持久化测试洗澡 toast' });
      await page.reload();
      await page.waitHistoryCount(domBeforeBath + 1);
      assertEqual(await firstHistoryTitle(), '洗澡', '刷新后洗澡记录仍在时间线首条（持久化）');
      assertEqual((await apiStateNow()).lastBath?.kind, 'bath', '刷新后服务端 lastBath 仍为洗澡');
      assertIncludes(await page.textOfTestId('gap-last-diaper'), '距上次换尿布/洗澡 刚刚', '刷新后 Hero 第三行仍显示洗澡计时「刚刚」');
      assertIncludes(await page.textOfTestId('today-summary'), `洗澡 ${bathCountBefore + 1} 次`, '刷新后今日汇总仍包含新增洗澡');

      // SSE：第二客户端（Node 直接 fetch API）记录洗澡 → 页面无需刷新实时出现
      const currentToast = await page.exists(sel('toast'));
      if (currentToast) {
        // 页面刷新后不应有 toast；若存在旧 toast 先等它消失，避免「已同步」被撤销 toast 抑制
        try {
          await page.waitForGone(sel('toast'), { timeout: 6000 });
        } catch {
          await sleep(300);
        }
      }
      const sseDomBefore = await domHistoryCount();
      const sseBathCountBefore = (await apiStateNow()).today.bathCount ?? 0;
      const sseBath = await seedBath();
      assertEqual(sseBath.status, 201, '第二客户端直接 POST /api/baths → 201');
      const sseApplied = await page.waitForExpression(
        `document.querySelectorAll('[data-testid="history-list"] .event').length === ${sseDomBefore + 1}`,
        { timeout: 6000, desc: 'SSE：他人洗澡记录实时出现在时间线' },
      );
      assert(Boolean(sseApplied), '第二客户端记录洗澡 → 页面无需刷新时间线 +1（SSE 实时）');
      assertEqual(await firstHistoryTitle(), '洗澡', 'SSE 实时插入的时间线首条为「洗澡」');
      const syncToast = await page.waitForText(sel('toast'), '已同步 洗澡', { timeout: 6000, desc: 'SSE 同步 toast' });
      assertIncludes(syncToast, '已同步 洗澡', 'SSE 他人记录后页面提示「已同步 洗澡」', `"${syncToast}"`);
      assertIncludes(await page.textOfTestId('today-summary'), `洗澡 ${sseBathCountBefore + 1} 次`, 'SSE 后今日汇总洗澡次数 +1');
      assertEqual(await page.textOfTestId('gap-last-diaper'), '距上次换尿布/洗澡 刚刚', 'SSE 后 Hero 洗澡计时归零');
      const sseState = await waitApiState((state) => (state.today.bathCount ?? 0) === sseBathCountBefore + 1, {
        desc: 'SSE 后服务端 bathCount +1',
      });
      assertEqual(sseState.today.bathCount, sseBathCountBefore + 1, 'SSE 后服务端 bathCount +1');
      assertEqual(sseState.lastBath?.id, sseBath.data?.event?.id, 'SSE 后服务端 lastBath 指向第二客户端记录');
    });

    /* ------------------------------------------------ G07 时间线删除（window.confirm） */
    await runGroup('G07', '时间线删除：window.confirm → DELETE → 服务端/UI/Hero 同步', async () => {
      const events = await api.allEvents();
      const target = events.find((event) => event.kind === 'feed' && event.amountMl === 999);
      assert(Boolean(target), '找到待删除的 999ml 记录', target ? `id=${target.id}` : '未找到');
      const countBefore = events.length;
      const selector = `li.event[data-event-id="${target.id}"] .event-delete`;
      assert(await page.exists(`li.event[data-event-id="${target.id}"]`), '该记录出现在时间线中');
      const since = page.responses.length;
      const dialog = await page.clickAndAcceptDialog(selector);
      assertEqual(dialog.type, 'confirm', '删除触发原生 window.confirm（Page.javascriptDialogOpening）');
      assertIncludes(dialog.message, '确定删除', '确认框文案包含「确定删除」', `"${dialog.message}"`);
      const deleteResponse = await page.waitForResponse(
        (response) => response.method === 'DELETE' && response.path === `/api/events/${target.id}`,
        { since },
      );
      assertEqual(deleteResponse.status, 204, '确认后 DELETE /api/events/:id → 204');
      const deleteToast = await page.waitForText(sel('toast'), '已删除', { desc: '删除 toast' });
      assertIncludes(deleteToast, '已删除这条记录', '删除成功 toast');
      await page.waitForGone(`li.event[data-event-id="${target.id}"]`, { timeout: 5000 });
      const after = await api.allEvents();
      assertEqual(after.length, countBefore - 1, '服务端事件数 -1');
      assert(!after.some((event) => event.id === target.id), 'GET /api/events 中不再包含被删记录');
      const expectedTitle = eventTitleNode(after.find((event) => event.kind === 'feed'));
      const gapLastFeed = await page.waitForText(sel('gap-last-feed'), expectedTitle, { desc: `Hero 回退到「${expectedTitle}」` });
      assertIncludes(gapLastFeed, expectedTitle, '删除最新喂奶后 Hero 回退正确');
    });

    /* ------------------------------------------------ G08 刷新持久化 */
    await runGroup('G08', '刷新持久化（Page.reload）', async () => {
      const events = await api.allEvents();
      const total = events.length;
      const newestTitle = eventTitleNode(events[0]);
      const latestFeed = events.find((event) => event.kind === 'feed');
      const domCountBefore = await domHistoryCount();
      assertEqual(domCountBefore, Math.min(30, total), '刷新前时间线展示 min(30, 总数)', `${domCountBefore} 条 / 共 ${total}`);
      await page.reload();
      await page.waitHistoryCount(Math.min(30, total));
      assertEqual(await firstHistoryTitle(), newestTitle, '刷新后时间线首条仍是最新记录', `期望「${newestTitle}」`);
      assertMatch(await page.text('.event-time'), /^\d{2}:\d{2}$/, '时间线时间列格式为 HH:mm');
      const gapLastFeed = await page.textOfTestId('gap-last-feed');
      assertIncludes(gapLastFeed, eventTitleNode(latestFeed), '刷新后 Hero 上次喂奶仍正确', `"${gapLastFeed}"`);
      assertMatch(await page.textOfTestId('gap-duration'), GAP_FORMAT_RE, '刷新后 Hero 时长格式正确');
      assertDeepEqual(await selectedTypes(), ['formula'], '刷新后喂奶类型选择被记忆（奶粉）');
      assertEqual(await page.attr(sel('export-csv'), 'href'), '/api/export.csv', '刷新后导出链接仍为同源 API 地址');
      await page.screenshot('mobile-390-full.png', { fullPage: true });
    });

    /* ------------------------------------------------ G09 加载更多 */
    await runGroup('G09', '加载更多：30 条首屏 → 游标翻页 → 全部展示 → 按钮隐藏', async () => {
      const seedBase = Date.now();
      let okCount = 0;
      for (let index = 0; index < 45; index += 1) {
        const happenedAt = seedBase - (2 + index) * 3_600_000 - (index % 11) * 60_000;
        let response;
        const mod = index % 5;
        if (mod === 0) {
          response = await seedDiaper(index % 10 === 0 ? 'mixed' : 'pee', happenedAt);
        } else if (mod === 1) {
          response = await seedFeed(['formula'], 60 + (index % 6) * 30, happenedAt);
        } else if (mod === 2) {
          response = await seedFeed(['breast_milk'], 90, happenedAt);
        } else if (mod === 3) {
          response = await seedFeed(['formula', 'breast_milk'], 120, happenedAt);
        } else {
          response = await seedFeed(['formula', 'breast_direct'], 60, happenedAt);
        }
        if (response.status === 201) okCount += 1;
      }
      assertEqual(okCount, 45, 'API 造 45 条历史数据（含单标签/多标签/大小便）');
      const total = (await api.allEvents()).length;
      assert(total >= 40, '服务端累计记录数 ≥ 40', `${total} 条`);

      await page.reload();
      const firstScreenCount = await domHistoryCount();
      assertEqual(firstScreenCount, 30, '首屏只渲染最近 30 条');
      assert(await page.isVisible(sel('load-more')), '首屏底部出现「加载更多」');
      const dayLabels = await page.evaluate(`[...document.querySelectorAll('.day-label')].map((el) => el.textContent.trim())`);
      assert(dayLabels.length >= 2, '时间线按日期分组（跨天数据出现多个日期标题）', JSON.stringify(dayLabels.slice(0, 4)));
      assertIncludes(dayLabels.join(','), '今天', '时间线包含「今天」分组');
      const multiTitles = (await historyTitles()).filter((title) => title.includes(' + '));
      assert(multiTitles.length > 0, '时间线渲染多标签喂奶标题（含「 + 」）', JSON.stringify(multiTitles.slice(0, 3)));

      const since = page.responses.length;
      await page.clickTestId('load-more');
      const pageResponse = await page.waitForResponse((response) => response.method === 'GET' && response.path === '/api/events', { since });
      assertEqual(pageResponse.status, 200, '加载更多 GET /api/events 游标翻页 → 200');
      await page.waitHistoryCount(total);
      assertEqual(await domHistoryCount(), total, '翻页后时间线条数增加到全部记录', `${total} 条`);
      assert(!(await page.isVisible(sel('load-more'))), '无更多数据时「加载更多」按钮隐藏');
      const ids = await page.evaluate(`[...document.querySelectorAll('[data-testid="history-list"] .event')].map((el) => el.dataset.eventId)`);
      assertEqual(new Set(ids).size, ids.length, '翻页后无重复渲染的记录', `DOM ${ids.length} 条 / 去重 ${new Set(ids).size} 条`);
      assertIncludes(await page.text('#historyCount'), String(total), '时间线标题显示已显示条数');
    });

    /* ------------------------------------------------ G10 导出 CSV */
    await runGroup('G10', '导出 CSV：多标签项目名 / BOM / 记录数 / 转义', async () => {
      const exportHref = await page.attr(sel('export-csv'), 'href');
      assertEqual(exportHref, '/api/export.csv', '同源导出链接 href 为 /api/export.csv');
      assert((await page.attr(sel('export-csv'), 'download')) !== null, '导出链接带 download 属性');

      const trickyNote = '夜里,加"餐"';
      const noteRes = await seedFeed(['formula', 'breast_milk'], 30, undefined, trickyNote);
      assertEqual(noteRes.status, 201, 'API 造带特殊字符备注的多标签记录');

      const csv = await api.exportCsv();
      const total = (await api.allEvents()).length;
      assertEqual(csv.status, 200, 'GET /api/export.csv → 200');
      assertIncludes(csv.headers.get('content-type'), 'text/csv', 'Content-Type 为 text/csv');
      assertIncludes(String(csv.headers.get('content-type')), 'charset=utf-8', 'Content-Type 带 charset=utf-8');
      assertMatch(
        String(csv.headers.get('content-disposition')),
        /^attachment; filename="baby-milk-\d{4}-\d{2}-\d{2}\.csv"$/,
        'Content-Disposition 文件名格式正确',
      );
      assert(
        csv.buffer.length > 3 && csv.buffer[0] === 0xef && csv.buffer[1] === 0xbb && csv.buffer[2] === 0xbf,
        'CSV 带 UTF-8 BOM（Excel 打开不乱码）',
        `前 3 字节 ${[...csv.buffer.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`,
      );
      const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
      assertEqual(lines[0], '时间,类别,项目,奶量(ml),备注', 'CSV 表头符合契约');
      assertEqual(lines.length, total + 1, 'CSV 记录数 = 全部事件数', `数据行 ${lines.length - 1} / 事件 ${total}`);
      const body = lines.slice(1).join('\n');
      for (const label of ['奶粉', '母乳（瓶喂）', '亲喂', '小便', '大便', '奶粉 + 母乳（瓶喂）', '奶粉 + 亲喂']) {
        assertIncludes(body, label, `CSV 项目列含「${label}」（多标签用 + 连接）`);
      }
      const escapedLine = lines.find((line) => line.includes('夜里'));
      assert(Boolean(escapedLine), 'CSV 中找到带特殊字符备注的记录');
      assertIncludes(escapedLine ?? '', '"夜里,加""餐"""', 'CSV 对逗号 / 引号正确转义');
      const times = lines.slice(1).map((line) => line.split(',')[0]);
      assert(times.join('|') === [...times].sort().join('|'), 'CSV 数据按时间升序导出', `首行 ${times[0]} / 末行 ${times[times.length - 1]}`);
      assertMatch(times[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'CSV 时间列格式 YYYY-MM-DD HH:mm');
    });

    /* ------------------------------------------------ G11 加载失败 / 重试 / 记录失败 */
    await runGroup('G11', '首屏加载失败重试 + 记录失败错误提示', async () => {
      const chipStyleOf = () =>
        page.evaluate(`(() => {
          const el = document.querySelector('[data-testid="volume-chip-120"]');
          const cs = getComputedStyle(el);
          return { opacity: cs.opacity, background: cs.backgroundColor, color: cs.color, border: cs.borderColor, cursor: cs.cursor };
        })()`);
      const normalChipStyle = await chipStyleOf();
      page.expectedWindow = { reason: '主动注入 /api/state 网络失败' };
      page.failStateRequests = true;
      await page.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/state*', requestStage: 'Request' }] });
      try {
        await page.reload();
        const errorBanner = await page.waitForExpression(
          `(() => { const el = document.querySelector('[data-testid="load-error"]'); if (!el) return false; const rect = el.getBoundingClientRect(); return rect.height > 10 && !el.hidden ? el.textContent.replace(/\\s+/g, ' ').trim() : false; })()`,
          { timeout: 10_000, desc: '加载失败提示可见' },
        );
        assertIncludes(errorBanner, '加载失败', '加载失败时显示错误条（load-error）', `"${errorBanner}"`);
        const disabledStates = await page.evaluate(
          `[...document.querySelectorAll('.record-btn')].map((el) => ({ testid: el.dataset.testid, disabled: el.disabled }))`,
        );
        assert(
          disabledStates.length > 0 && disabledStates.every((item) => item.disabled),
          '加载失败时所有记录按钮禁用（直到重试成功）',
          disabledStates.map((item) => `${item.testid}:${item.disabled}`).join(', '),
        );
        const failedChipStyle = await chipStyleOf();
        if (JSON.stringify(normalChipStyle) === JSON.stringify(failedChipStyle)) {
          note(
            '加载失败时记录按钮视觉无禁用反馈（P2）',
            `disabled=true 但外观与正常态一致：${JSON.stringify(failedChipStyle)}；建议 .record-btn:disabled { opacity:.55; cursor:not-allowed }`,
          );
        } else {
          assert(true, '加载失败时记录按钮有可感知的禁用视觉反馈');
        }
        await page.screenshot('error-390.png');
        await sleep(250);
      } finally {
        await page.cdp.send('Fetch.disable');
        page.failStateRequests = false;
        page.expectedWindow = null;
      }

      await page.clickTestId('retry-load');
      await page.waitForExpression(
        `(() => { const el = document.querySelector('[data-testid="load-error"]'); return el ? el.hidden === true : true; })()`,
        { timeout: 10_000, desc: '重试后错误条隐藏' },
      );
      await page.waitForExpression(
        `(() => { const el = document.querySelector('[data-testid="gap-last-feed"]'); return el && el.textContent.trim().startsWith('上次'); })()`,
        { timeout: 10_000, desc: '重试后首屏数据恢复' },
      );
      assertEqual(
        await page.evaluate(`[...document.querySelectorAll('.record-btn')].some((el) => el.disabled)`),
        false,
        '重试成功后记录按钮全部恢复可用',
      );

      // 记录失败：网络错误 → 错误 toast 显示 API 地址提示，且不产生数据
      page.expectedWindow = { reason: '注入 POST /api/feedings 网络失败' };
      page.failPostRequests = true;
      await page.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/feedings*', requestStage: 'Request' }] });
      try {
        const beforeFailed = (await api.allEvents()).length;
        await page.clickTestId('volume-chip-30');
        const failToast = await page.waitForText(sel('toast'), '网络连接失败', { timeout: 8000, desc: '记录失败错误 toast' });
        assertIncludes(failToast, '网络连接失败', '记录失败 toast 提示网络错误');
        assertIncludes(failToast, apiBase, '错误 toast 显示当前 API 地址（便于排查）', `"${failToast}"`);
        assertEqual(
          await page.evaluate(`document.querySelector('[data-testid="toast"]')?.classList.contains('toast--error')`),
          true,
          '失败 toast 使用错误样式（toast--error）',
        );
        await sleep(600);
        assertEqual((await api.allEvents()).length, beforeFailed, '失败的记录请求没有产生服务端数据');
        assertEqual(
          await page.evaluate(`[...document.querySelectorAll('.record-btn')].filter((el) => el.disabled).length`),
          0,
          '记录失败后按钮恢复可用',
        );
      } finally {
        await page.cdp.send('Fetch.disable');
        page.failPostRequests = false;
        page.expectedWindow = null;
      }
      assert(expectedIssues.length >= 1, '故障注入期间的预期错误已精确记录（不计失败）', `${expectedIssues.length} 条`);
    });

    /* ------------------------------------------------ G12 前后端分离：跨源部署 + CORS */
    await runGroup('G12', '前后端分离：独立托管 web + ?api= 跨源访问 + CORS 预检', async () => {
      assert(webServerProcess && webServerProcess.exitCode === null, 'scripts/serve-web.mjs 独立静态服务运行中', webBase);
      const crossUrl = `${webBase}/?api=${encodeURIComponent(apiBase)}`;
      await page.navigate(crossUrl);
      assertEqual(await page.evaluate('location.origin'), webBase, '页面由独立静态服务托管（跨源页面 origin 正确）', webBase);
      const crossDoc = page.responses.find(
        (response) => response.type === 'Document' && response.path === '/' && response.status === 200 && originOf(response.url) === webBase,
      );
      assert(Boolean(crossDoc), '跨源页面 GET / 由独立 web 服务返回 200');
      assert(await page.isVisible(sel('export-csv')), '跨源页面渲染正常（导出入口可见）');
      assertEqual(await page.attr(sel('export-csv'), 'href'), `${apiBase}/api/export.csv`, '导出链接经由 apiUrl() 指向后端（跨源）');
      assertEqual(await page.evaluate(`localStorage.getItem('naiji.apiBase')`), apiBase, '?api= 参数持久化到 localStorage[naiji.apiBase]');
      assert(!(await page.isVisible(sel('load-error'))), '跨源首屏无加载错误（CORS GET 生效）');
      const gapText = await page.textOfTestId('gap-last-feed');
      assertIncludes(gapText, '上次', '跨源页面成功从 API 加载上次喂奶（CORS 生效）', `"${gapText}"`);

      // 跨源多选 → 记录：应出现 OPTIONS 预检 204 + POST 201
      await ensureSelection(['formula']);
      await clickTypeAndWait('type-breast-milk', true);
      const before = await apiStateNow();
      const since = page.responses.length;
      await page.clickTestId('volume-chip-120');
      const preflight = await page.waitForResponse(
        (response) => response.method === 'OPTIONS' && response.path === '/api/feedings',
        { since, timeout: 10_000 },
      );
      assertEqual(preflight.status, 204, '跨源 JSON POST 触发 OPTIONS 预检 → 204', `${preflight.method} ${preflight.path} ${preflight.status}`);
      assertEqual(
        preflight.headers['access-control-allow-origin'],
        '*',
        '预检响应 Access-Control-Allow-Origin: *（CORS 生效）',
      );
      assertIncludes(String(preflight.headers['access-control-allow-methods'] ?? ''), 'POST', '预检允许 POST 方法');
      assertIncludes(String(preflight.headers['access-control-allow-headers'] ?? '').toLowerCase(), 'content-type', '预检允许 Content-Type 头');
      const postResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/feedings',
        { since },
      );
      assertEqual(postResponse.status, 201, '跨源 POST /api/feedings → 201');
      const toast = await page.waitForText(sel('toast'), '奶粉 + 母乳（瓶喂）', { desc: '跨源记录 toast' });
      assertIncludes(toast, '已记录 奶粉 + 母乳（瓶喂） 120 ml', '跨源记录成功 toast', `"${toast}"`);
      await page.screenshot('cross-origin-390.png');

      const after = await apiStateNow();
      assertEqual(after.today.totalMl, before.today.totalMl + 120, '跨源记录写入后端（totalMl +120）');
      const crossEvent = await latestEvent();
      assertDeepEqual(crossEvent?.feedTypes, ['formula', 'breast_milk'], '跨源记录 feedTypes 正确');
      assertEqual(crossEvent?.amountMl, 120, '跨源记录 amountMl 正确');
      const crossStateResponses = page.responses.filter(
        (response) => response.path === '/api/state' && originOf(response.url) === apiBase && response.status === 200,
      );
      assert(crossStateResponses.length > 0, '跨源 GET /api/state 成功（200）', `${crossStateResponses.length} 次`);
      assert(
        crossStateResponses.every((response) => response.headers['access-control-allow-origin'] === '*'),
        '跨源 API 响应均带 Access-Control-Allow-Origin: *',
      );

      // ?api= 持久化后，不带查询参数打开静态首页也应回退到 localStorage 中的 API 地址
      await page.navigate(`${webBase}/`);
      assert(!(await page.isVisible(sel('load-error'))), '无 ?api= 时回退到 localStorage 的 API 地址（无加载错误）');
      assertEqual(await page.attr(sel('export-csv'), 'href'), `${apiBase}/api/export.csv`, 'localStorage 回退后导出链接仍指向后端');
      assertIncludes(await page.textOfTestId('gap-last-feed'), '上次', 'localStorage 回退后数据正常加载');

      // 回到同源页面（清除本次页面 origin 下的持久化，验证 config.js 默认同源模式）
      await page.evaluate(`localStorage.removeItem('naiji.apiBase')`);
      await page.navigate(`${apiBase}/`);
      assertEqual(await page.evaluate('location.origin'), apiBase, '切回 API 同源页面');
      assertEqual(await page.attr(sel('export-csv'), 'href'), '/api/export.csv', '同源模式导出链接恢复为相对地址');
      assertEqual(await page.evaluate(`localStorage.getItem('naiji.apiBase')`), null, '同源页面未持久化 apiBase');
    });

    /* ------------------------------------------------ G13 响应式 / 点击区 */
    await runGroup('G13', '320 / 390 / 900 视口：无横向滚动 + 点击区 ≥ 44px + 按钮不重叠', async () => {
      const measure = async (viewport, label) => {
        await page.setViewport(viewport);
        await sleep(250);
        const metrics = await page.evaluate(`({
          innerWidth: window.innerWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
        })`);
        assert(metrics.docScrollWidth <= metrics.innerWidth, `${label}：documentElement.scrollWidth ≤ innerWidth（无横向滚动）`, `scrollWidth=${metrics.docScrollWidth} ≤ ${metrics.innerWidth}`);
        assert(metrics.bodyScrollWidth <= metrics.innerWidth, `${label}：body.scrollWidth ≤ innerWidth`, `body=${metrics.bodyScrollWidth}`);
        const sizeSelectors = [
          ['type-formula', sel('type-formula')],
          ['volume-chip-30', sel('volume-chip-30')],
          ['volume-chip-120', sel('volume-chip-120')],
          ['custom-amount-submit', sel('custom-amount-submit')],
          ['record-pee', sel('record-pee')],
          ['record-poop', sel('record-poop')],
        ];
        for (const [name, selector] of sizeSelectors) {
          const rect = await page.rect(selector);
          assert(Boolean(rect), `${label}：${name} 可测量`, '元素不存在');
          if (!rect) continue;
          if (name.startsWith('volume-chip') || name.startsWith('record-pee') || name.startsWith('record-poop')) {
            assert(Math.min(rect.width, rect.height) >= 44, `${label}：${name} 点击区域 ≥ 44px`, `${Math.round(rect.width)}×${Math.round(rect.height)}`);
          }
          assert(rect.x >= -0.5 && rect.right <= metrics.innerWidth + 0.5, `${label}：${name} 位于视口内`, `x=${Math.round(rect.x)} right=${Math.round(rect.right)} / ${metrics.innerWidth}`);
        }
        const overlapRects = await page.evaluate(`(() => {
          const selectors = ${JSON.stringify(sizeSelectors.map((item) => item[1]))};
          return selectors.map((selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 };
          }).filter((item) => item && item.visible);
        })()`);
        const overlaps = [];
        for (let i = 0; i < overlapRects.length; i += 1) {
          for (let j = i + 1; j < overlapRects.length; j += 1) {
            const a = overlapRects[i];
            const b = overlapRects[j];
            const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            if (overlapX > 1 && overlapY > 1) overlaps.push(`${a.selector} ↔ ${b.selector}`);
          }
        }
        assert(overlaps.length === 0, `${label}：关键按钮互不重叠`, overlaps.join('; ') || '无重叠');
        return metrics;
      };

      await measure(VIEWPORT_MOBILE, '390×844');
      await measure(VIEWPORT_NARROW, '320×640');
      await page.screenshot('mobile-320.png');
      const desktopMetrics = await measure(VIEWPORT_DESKTOP, '900×900');
      assertEqual(desktopMetrics.innerWidth, 900, '900 视口 innerWidth = 900');
      const mainRect = await page.rect('.main');
      assert(mainRect.width <= 560 + 1, '桌面宽度下内容区保持 max-width ≈560px', `main 宽 ${Math.round(mainRect.width)}px`);
      const appRect = await page.rect('.app');
      assert(Math.abs(appRect.x - (900 - appRect.right)) <= 2, '桌面下内容水平居中', `左 ${Math.round(appRect.x)}px / 右 ${Math.round(900 - appRect.right)}px`);
      await page.screenshot('desktop-900.png');

      await page.setViewport(VIEWPORT_NARROW);
      await sleep(200);
      const summaryMetrics = await page.evaluate(`(() => {
        const el = document.querySelector('[data-testid="today-summary"]');
        const rect = el.getBoundingClientRect();
        return { height: rect.height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 24 };
      })()`);
      note('320px 今日汇总折行', `高度 ${Math.round(summaryMetrics.height)}px（${summaryMetrics.height > summaryMetrics.lineHeight * 1.5 ? '两行，前端已说明不算 bug' : '单行'}）`);
      const heroLastMetrics = await page.evaluate(`(() => {
        const el = document.querySelector('[data-testid="gap-last-feed"]');
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return { height: rect.height, lineHeight: parseFloat(cs.lineHeight) || 24, text: el.textContent.replace(/\\s+/g, ' ').trim() };
      })()`);
      if (heroLastMetrics.height > heroLastMetrics.lineHeight * 1.6) {
        note(
          '320px 多标签 Hero 上次详情折行（P2 视觉）',
          `高度 ${Math.round(heroLastMetrics.height)}px 折成多行：${heroLastMetrics.text}；「120 ml」被拆到「120」与「ml」两行，建议给 Hero 里的奶量/单位加 nowrap 或拆 span`,
        );
      } else {
        assert(true, '320px Hero 上次详情保持单行');
      }
      const deleteRect = await page.rect('.event-delete');
      note('时间线删除按钮点击区域', deleteRect ? `${Math.round(deleteRect.width)}×${Math.round(deleteRect.height)}px` : '未测量到');
      await page.setViewport(VIEWPORT_MOBILE);
      await sleep(200);
    });

    /* ------------------------------------------------ G14 深色模式 */
    await runGroup('G14', '深色模式：配色切换 + 对比度', async () => {
      await page.setViewport(VIEWPORT_MOBILE);
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(250);
      const readStyles = () =>
        page.evaluate(`(() => {
          const body = getComputedStyle(document.body);
          const summary = getComputedStyle(document.querySelector('.summary'));
          return { bg: body.backgroundColor, text: body.color, card: summary.backgroundColor };
        })()`);
      const light = await readStyles();
      await page.emulateMedia({ colorScheme: 'dark' });
      await sleep(300);
      const dark = await readStyles();
      assert(light.bg !== dark.bg, '深色模式背景色与浅色不同', `${light.bg} → ${dark.bg}`);
      assert(light.text !== dark.text, '深色模式文字色与浅色不同', `${light.text} → ${dark.text}`);
      assert(light.card !== dark.card, '深色模式卡片背景与浅色不同', `${light.card} → ${dark.card}`);
      const lightFg = parseRgb(light.text);
      const lightBg = parseRgb(light.bg);
      const darkFg = parseRgb(dark.text);
      const darkBg = parseRgb(dark.bg);
      const lightRatio = lightFg && lightBg ? contrastRatio(lightFg, lightBg) : 0;
      const darkRatio = darkFg && darkBg ? contrastRatio(darkFg, darkBg) : 0;
      assert(lightRatio >= 4.5, '浅色模式正文对比度 ≥ 4.5:1（WCAG AA）', `${lightRatio.toFixed(2)}:1`);
      assert(darkRatio >= 4.5, '深色模式正文对比度 ≥ 4.5:1（WCAG AA）', `${darkRatio.toFixed(2)}:1`);
      assertEqual(await page.evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`), true, 'CDP 媒体模拟生效：prefers-color-scheme: dark');
      await page.screenshot('dark-390.png');
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(200);
    });

    /* ------------------------------------------------ G14b 无障碍与对比度细节 */
    await runGroup('G14b', '无障碍与对比度细节抽查', async () => {
      await page.setViewport(VIEWPORT_NARROW);
      await sleep(250);
      const narrowName = await page.accessibleName(sel('export-csv'));
      assertEqual(narrowName?.name, '导出 CSV', '320px 下导出链接仍有无障碍名称（v2 已加 aria-label）', JSON.stringify(narrowName));
      const typeNames = [];
      for (const testid of ['type-formula', 'type-breast-milk', 'type-breast-direct']) {
        typeNames.push(await page.accessibleName(sel(testid)));
      }
      assert(
        typeNames.every((item) => typeof item?.name === 'string' && item.name.length > 0),
        '三个多选类型按钮均有可读无障碍名称',
        typeNames.map((item) => item?.name).join(' / '),
      );

      await page.setViewport(VIEWPORT_MOBILE);
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(250);
      const lightContrast = await page.primaryButtonContrast(sel('custom-amount-submit'));
      if (lightContrast) {
        note(
          '主按钮白字对比度（浅色）',
          `渐变端 ${lightContrast.ratios.map((ratio) => ratio.toFixed(2)).join(' / ')}:1，最小 ${lightContrast.minRatio.toFixed(2)}:1；字号 ${lightContrast.fontSize} / ${lightContrast.fontWeight}（WCAG AA 正文要求 4.5:1，P2 可访问性）`,
        );
      }
      const heroLight = await page.gradientTextContrast('.hero', sel('gap-duration'));
      if (heroLight) {
        note(
          'Hero 大字号白字对比度（浅色）',
          `渐变端 ${heroLight.ratios.map((ratio) => ratio.toFixed(2)).join(' / ')}:1，最小 ${heroLight.minRatio.toFixed(2)}:1；字号 ${heroLight.fontSize}（WCAG 大字号要求 3:1，P2 可访问性）`,
        );
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      await sleep(300);
      const darkContrast = await page.primaryButtonContrast(sel('custom-amount-submit'));
      if (darkContrast) {
        note(
          '主按钮白字对比度（深色）',
          `渐变端 ${darkContrast.ratios.map((ratio) => ratio.toFixed(2)).join(' / ')}:1，最小 ${darkContrast.minRatio.toFixed(2)}:1（P2 可访问性）`,
        );
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(200);
    });

    /* ------------------------------------------------ G15 空库状态 */
    await runGroup('G15', '空库状态：empty-state / 今日汇总为 0 / 无记录提示', async () => {
      const cleared = await deleteAllEvents();
      assertEqual(cleared.deleted, cleared.total, '通过 API 清空数据库', `删除 ${cleared.deleted}/${cleared.total} 条`);
      assertEqual((await api.allEvents()).length, 0, '服务端事件已清空');
      await page.reload();
      assert(await page.isVisible(sel('empty-state')), '空库刷新后 empty-state 可见');
      assertEqual(await domHistoryCount(), 0, '时间线无记录条目');
      const summary = await page.textOfTestId('today-summary');
      for (const part of ['喂奶 0 次', '奶量 0 ml', '亲喂 0 次', '小便 0', '大便 0', '洗澡 0 次']) {
        assertIncludes(summary, part, `空库今日汇总含「${part}」`, `"${summary}"`);
      }
      assertEqual(await page.textOfTestId('gap-last-feed'), '还没有喂奶记录', 'Hero 提示「还没有喂奶记录」');
      assertEqual(await page.textOfTestId('gap-duration'), '还没开始', 'Hero 时长显示「还没开始」');
      assertEqual(
        await page.textOfTestId('gap-last-diaper'),
        '还没有换尿布/洗澡记录',
        'Hero 第三行提示 v3 文案「还没有换尿布/洗澡记录」',
      );
      assert(!(await page.isVisible(sel('load-more'))), '空库时隐藏「加载更多」');
      assert(!(await page.isVisible(sel('load-error'))), '空库页面不显示错误条');
      const emptyStatsText = await page.waitForText(sel('stats-chart'), '最近 7 天还没有数据', {
        timeout: 8000,
        desc: '空库趋势卡空状态',
      });
      assertIncludes(emptyStatsText, '最近 7 天还没有数据', '空库趋势卡显示「最近 7 天还没有数据」');
      assertIncludes(
        await page.textOfTestId('stats-summary'),
        '7 天合计 0 ml',
        '空库趋势汇总显示「7 天合计 0 ml · 日均 0 ml · 最高 0 ml」',
      );
      const state = await apiStateNow();
      assertEqual(state.lastFeeding, null, '/api/state lastFeeding 为 null');
      assertEqual(state.lastDiaper, null, '/api/state lastDiaper 为 null');
      assertEqual(state.lastBath, null, '/api/state lastBath 为 null');
      assertEqual(state.recent.length, 0, '/api/state recent 为空');
      assertEqual(state.today.totalMl, 0, '/api/state today.totalMl = 0');
      assertEqual(state.today.bathCount, 0, '/api/state today.bathCount = 0');
      await page.screenshot('empty-390.png');
    });

    /* ------------------------------------------------ G16 契约一致性抽查（HTTP / CORS / SERVE_WEB / v1→v3 迁移） */
    await runGroup('G16', '契约一致性抽查（API 字段 / 错误码 / CORS / SERVE_WEB=0 / v1→v3 迁移）', async () => {
      // HTML 头 / CSP
      const html = await api.request('/');
      assertEqual(html.status, 200, 'GET / → 200（server 托管 web）');
      const csp = String(html.headers.get('content-security-policy') ?? '');
      assertIncludes(csp, "default-src 'self'", 'HTML CSP 含 default-src self');
      assertIncludes(csp, 'connect-src *', 'HTML CSP 含 connect-src *（允许跨源 API）');
      assertIncludes(csp, "script-src 'self'", 'HTML CSP 含 script-src self（无内联脚本）');
      assertEqual(html.headers.get('x-content-type-options'), 'nosniff', 'HTML 带 nosniff');
      assertEqual(html.headers.get('cache-control'), 'no-cache', 'HTML 带 Cache-Control: no-cache');
      for (const [assetPath, expectedMime] of [
        ['/app.css', 'text/css'],
        ['/app.js', 'text/javascript'],
        ['/config.js', 'text/javascript'],
        ['/lib/format.js', 'text/javascript'],
        ['/lib/api.js', 'text/javascript'],
        ['/icon.svg', 'image/svg+xml'],
        ['/manifest.webmanifest', 'application/manifest+json'],
      ]) {
        const response = await api.request(assetPath);
        assertEqual(response.status, 200, `静态资源 ${assetPath} → 200`);
        assertIncludes(response.headers.get('content-type'), expectedMime, `${assetPath} MIME 为 ${expectedMime}`);
      }

      // CORS
      const corsGet = await api.request('/api/health', { headers: { Origin: 'http://example.test' } });
      assertEqual(corsGet.headers.get('access-control-allow-origin'), '*', 'API GET 响应带 Access-Control-Allow-Origin: *');
      const preflight = await api.request('/api/feedings', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://example.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      assertEqual(preflight.status, 204, 'OPTIONS 预检 → 204');
      assertEqual(preflight.headers.get('access-control-allow-origin'), '*', '预检带 ACAO: *');
      assertIncludes(String(preflight.headers.get('access-control-allow-methods') ?? ''), 'DELETE', '预检 Allow-Methods 含 DELETE');
      assertIncludes(String(preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase(), 'content-type', '预检 Allow-Headers 含 Content-Type');
      assertEqual(preflight.headers.get('access-control-max-age'), '86400', '预检 Access-Control-Max-Age=86400');

      // CORS_ORIGINS 白名单模式（非 *）：只对匹配来源放行
      const whitelistPort = await freePort();
      const whitelistDb = path.join(tmpDir, 'cors-whitelist.db');
      const whitelistServer = launchServer({
        port: whitelistPort,
        dbPath: whitelistDb,
        extraEnv: { CORS_ORIGINS: 'http://allowed.test' },
        label: 'cors-whitelist',
      });
      extraServerProcesses.push(whitelistServer);
      try {
        const whitelistApi = `http://127.0.0.1:${whitelistPort}`;
        await waitHealth(whitelistApi);
        const allowed = await fetch(`${whitelistApi}/api/health`, { headers: { Origin: 'http://allowed.test' } });
        assertEqual(allowed.headers.get('access-control-allow-origin'), 'http://allowed.test', 'CORS_ORIGINS 白名单：匹配来源回显具体 Origin');
        assertEqual(allowed.headers.get('vary'), 'Origin', 'CORS_ORIGINS 白名单：响应带 Vary: Origin');
        const blocked = await fetch(`${whitelistApi}/api/health`, { headers: { Origin: 'http://other.test' } });
        assertEqual(blocked.headers.get('access-control-allow-origin'), null, 'CORS_ORIGINS 白名单：未匹配来源不带 ACAO（浏览器会拦截）');
        const allowedPreflight = await fetch(`${whitelistApi}/api/feedings`, {
          method: 'OPTIONS',
          headers: { Origin: 'http://allowed.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
        });
        assertEqual(allowedPreflight.status, 204, 'CORS_ORIGINS 白名单：匹配来源预检 204');
        assertEqual(allowedPreflight.headers.get('access-control-allow-origin'), 'http://allowed.test', 'CORS_ORIGINS 白名单：预检回显 Origin');
      } finally {
        await stopProcess(whitelistServer.child, 'server');
        const idx = extraServerProcesses.indexOf(whitelistServer);
        if (idx >= 0) extraServerProcesses.splice(idx, 1);
      }

      // 错误码 / 中文 message
      const expectError = async (name, response, status, code) => {
        assertEqual(response.status, status, `${name} → ${status}`);
        assertEqual(response.data?.error, code, `${name} error=${code}`);
        assert(typeof response.data?.message === 'string' && /[\u4e00-\u9fa5]/.test(response.data.message), `${name} message 为中文`, JSON.stringify(response.data?.message));
      };
      const postFeed = (body) => api.request('/api/feedings', { method: 'POST', json: body });
      await expectError('Content-Type 非 JSON', await api.request('/api/feedings', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
      await expectError('非法 JSON 体', await api.request('/api/feedings', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }), 400, 'invalid_json');
      await expectError('feedTypes 缺失', await postFeed({ amountMl: 120 }), 400, 'invalid_feed_types');
      await expectError('feedTypes 为空数组', await postFeed({ feedTypes: [], amountMl: 120 }), 400, 'invalid_feed_types');
      await expectError('feedTypes 重复', await postFeed({ feedTypes: ['formula', 'formula'], amountMl: 120 }), 400, 'invalid_feed_types');
      await expectError('feedTypes 非法值', await postFeed({ feedTypes: ['water'], amountMl: 120 }), 400, 'invalid_feed_types');
      await expectError('feedTypes 非数组', await postFeed({ feedTypes: 'formula', amountMl: 120 }), 400, 'invalid_feed_types');
      await expectError('奶粉缺奶量', await postFeed({ feedTypes: ['formula'] }), 400, 'invalid_amount');
      await expectError('奶量 0', await postFeed({ feedTypes: ['formula'], amountMl: 0 }), 400, 'invalid_amount');
      await expectError('奶量 2001', await postFeed({ feedTypes: ['breast_milk'], amountMl: 2001 }), 400, 'invalid_amount');
      await expectError('奶量非整数', await postFeed({ feedTypes: ['formula'], amountMl: 12.5 }), 400, 'invalid_amount');
      await expectError('仅亲喂带奶量', await postFeed({ feedTypes: ['breast_direct'], amountMl: 60 }), 400, 'unexpected_amount');
      await expectError('happenedAt 字符串', await postFeed({ feedTypes: ['formula'], amountMl: 120, happenedAt: '123' }), 400, 'invalid_happened_at');
      await expectError('happenedAt 超前 10 分钟', await postFeed({ feedTypes: ['formula'], amountMl: 120, happenedAt: Date.now() + 10 * 60_000 }), 400, 'invalid_happened_at');
      await expectError('备注超长', await postFeed({ feedTypes: ['formula'], amountMl: 120, note: 'x'.repeat(201) }), 400, 'invalid_note');
      await expectError('备注非字符串', await postFeed({ feedTypes: ['formula'], amountMl: 120, note: 123 }), 400, 'invalid_note');
      await expectError('非法 diaperKind', await api.createDiaper({ diaperKind: 'sleep' }), 400, 'invalid_diaper_kind');
      await expectError('limit=0', await api.request('/api/events?limit=0'), 400, 'invalid_limit');
      await expectError('limit=201', await api.request('/api/events?limit=201'), 400, 'invalid_limit');
      await expectError('tzOffset 越界', await api.request('/api/state?tzOffset=9999'), 400, 'invalid_tz_offset');
      await expectError('非法游标', await api.request('/api/events?before=abc'), 400, 'invalid_cursor');
      await expectError('删除不存在记录', await api.deleteEvent(999_999), 404, 'not_found');

      // 事件 JSON 字段 + 规范顺序 + v1 兼容
      const createdMulti = await postFeed({ feedTypes: ['breast_milk', 'formula'], amountMl: 120, note: 'QA 契约边界' });
      assertEqual(createdMulti.status, 201, 'feedTypes 顺序打乱提交 → 201');
      const event = createdMulti.data?.event ?? {};
      assertDeepEqual(
        Object.keys(event).sort(),
        ['amountMl', 'createdAt', 'diaperKind', 'feedTypes', 'happenedAt', 'id', 'kind', 'note'],
        '事件 JSON 字段与 v2 契约一致（feedTypes 数组）',
      );
      assertDeepEqual(event.feedTypes, ['formula', 'breast_milk'], '服务端按规范顺序返回 feedTypes');
      assert(typeof event.happenedAt === 'number' && typeof event.createdAt === 'number', '事件时间为 number（epoch ms）');
      const v1Compat = await postFeed({ feedType: 'breast_milk', amountMl: 90 });
      assertEqual(v1Compat.status, 201, 'v1 旧字段 feedType 兼容 → 201');
      assertDeepEqual(v1Compat.data?.event?.feedTypes, ['breast_milk'], '旧字段归一化为 feedTypes 数组');
      const bothFields = await postFeed({ feedType: 'formula', feedTypes: ['breast_direct'] });
      assertEqual(bothFields.status, 201, 'feedType 与 feedTypes 同时出现 → 201');
      assertDeepEqual(bothFields.data?.event?.feedTypes, ['breast_direct'], '同时出现时以 feedTypes 为准');
      assertEqual(bothFields.data?.event?.amountMl, null, '仅亲喂事件 amountMl=null');

      // v2 today 聚合语义
      const mixed = await postFeed({ feedTypes: ['formula', 'breast_direct'], amountMl: 60 });
      assertEqual(mixed.status, 201, '造「奶粉 + 亲喂」60ml 事件');
      const breast = await postFeed({ feedTypes: ['breast_milk'], amountMl: 30 });
      assertEqual(breast.status, 201, '造「母乳（瓶喂）」30ml 事件');
      const formulaOnly = await postFeed({ feedTypes: ['formula'], amountMl: 120 });
      assertEqual(formulaOnly.status, 201, '造「奶粉」120ml 事件');
      const diaperMixed = await api.createDiaper({ diaperKind: 'mixed' });
      assertEqual(diaperMixed.status, 201, '造「大小便」mixed 事件');
      const agg = await apiStateNow();
      assertEqual(agg.today.feedCount, 6, 'today.feedCount 统计 6 条喂奶（含多标签/仅亲喂）');
      assertEqual(agg.today.totalMl, 120 + 90 + 60 + 30 + 120, 'today.totalMl 为总奶量之和（不含亲喂）');
      assertEqual(agg.today.formulaCount, 3, 'formulaCount = 含奶粉标签的事件数（多标签重复计）');
      assertEqual(agg.today.breastMilkCount, 3, 'breastMilkCount = 含母乳标签的事件数');
      assertEqual(agg.today.breastDirectCount, 2, 'breastDirectCount = 含亲喂标签的事件数');
      assertEqual(agg.today.mixedFeedCount, 2, 'mixedFeedCount = 多标签事件数');
      assertEqual(agg.today.diaperCount, 1, 'diaperCount = 1');
      assertEqual(agg.today.mixedCount, 1, 'mixedCount = 1（大小便混合）');
      assertEqual(agg.today.peeCount, 1, 'peeCount 包含 mixed');
      assertEqual(agg.today.poopCount, 1, 'poopCount 包含 mixed');
      for (const item of [event, v1Compat.data.event, bothFields.data.event, mixed.data.event, breast.data.event, formulaOnly.data.event, diaperMixed.data.event]) {
        const deleted = await api.deleteEvent(item.id);
        assertEqual(deleted.status, 204, `清理契约测试记录 id=${item.id}`);
      }

      // 静态防护 / 方法
      for (const evil of ['/..%2fpackage.json', '/..%2f..%2fserver%2fsrc%2fserver.js', '/%2e%2e/package.json']) {
        assertEqual((await api.request(evil)).status, 404, `目录穿越被拦截 ${evil} → 404`);
      }
      assertEqual((await api.request('/', { method: 'POST', json: {} })).status, 405, '静态路径非 GET/HEAD → 405');

      // SERVE_WEB=0：纯 API 模式
      const disabledPort = await freePort();
      const disabledDb = path.join(tmpDir, 'serve-web-off.db');
      const disabledServer = launchServer({ port: disabledPort, dbPath: disabledDb, extraEnv: { SERVE_WEB: '0' }, label: 'api-only' });
      extraServerProcesses.push(disabledServer);
      try {
        const disabledApi = `http://127.0.0.1:${disabledPort}`;
        await waitHealth(disabledApi);
        const healthOnly = await fetch(`${disabledApi}/api/health`);
        assertEqual(healthOnly.status, 200, 'SERVE_WEB=0：API /api/health 仍可用');
        const rootResponse = await fetch(`${disabledApi}/`);
        assertEqual(rootResponse.status, 404, 'SERVE_WEB=0：GET / → 404');
        const rootBody = await rootResponse.json();
        assertEqual(rootBody.error, 'web_disabled', 'SERVE_WEB=0：错误码 web_disabled');
        assertIncludes(String(rootBody.message), '独立部署', 'SERVE_WEB=0：中文提示 web 需独立部署');
        const assetResponse = await fetch(`${disabledApi}/app.css`);
        assertEqual(assetResponse.status, 404, 'SERVE_WEB=0：静态资源 → 404');
        const corsDisabled = await fetch(`${disabledApi}/api/health`, { headers: { Origin: 'http://example.test' } });
        assertEqual(corsDisabled.headers.get('access-control-allow-origin'), '*', 'SERVE_WEB=0：API 仍带 CORS 头');
      } finally {
        await stopProcess(disabledServer.child, 'server');
        const idx = extraServerProcesses.indexOf(disabledServer);
        if (idx >= 0) extraServerProcesses.splice(idx, 1);
      }

      // v1 → v3 数据库迁移（真实 server 打开旧库；v3 迁移包含 v1→v3 直通与 v2→v3 放宽 kind CHECK）
      const { DatabaseSync } = await import('node:sqlite');
      const legacyDbPath = path.join(tmpDir, 'legacy-v1.db');
      const legacyTime = Date.now() - 3 * 3_600_000;
      const legacyDb = new DatabaseSync(legacyDbPath);
      legacyDb.exec(`CREATE TABLE events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT    NOT NULL CHECK (kind IN ('feed', 'diaper')),
        feed_type   TEXT    CHECK (feed_type IN ('formula', 'breast_milk', 'breast_direct')),
        amount_ml   INTEGER CHECK (amount_ml IS NULL OR (amount_ml > 0 AND amount_ml <= 2000)),
        diaper_kind TEXT    CHECK (diaper_kind IN ('pee', 'poop', 'mixed')),
        note        TEXT,
        happened_at INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        CHECK (
          (kind = 'feed' AND feed_type IS NOT NULL AND diaper_kind IS NULL
            AND (feed_type = 'breast_direct' OR amount_ml IS NOT NULL))
          OR
          (kind = 'diaper' AND diaper_kind IS NOT NULL AND feed_type IS NULL AND amount_ml IS NULL)
        )
      );`);
      const legacyInsert = legacyDb.prepare(
        'INSERT INTO events (id, kind, feed_type, amount_ml, diaper_kind, note, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      legacyInsert.run(1, 'feed', 'formula', 120, null, '老记录', legacyTime, legacyTime);
      legacyInsert.run(2, 'feed', 'breast_direct', null, null, null, legacyTime + 3_600_000, legacyTime + 3_600_000);
      legacyInsert.run(3, 'diaper', null, null, 'poop', null, legacyTime + 2 * 3_600_000, legacyTime + 2 * 3_600_000);
      legacyDb.close();

      const migratePort = await freePort();
      const migrateServer = launchServer({ port: migratePort, dbPath: legacyDbPath, label: 'migrate' });
      extraServerProcesses.push(migrateServer);
      try {
        const migrateApi = `http://127.0.0.1:${migratePort}`;
        await waitHealth(migrateApi);
        const migratedEvents = await new ApiClient(migrateApi).events(10);
        assertEqual(migratedEvents.length, 3, '打开 v1 旧库后 3 条记录全部保留');
        const migratedFormula = migratedEvents.find((item) => item.id === 1);
        const migratedDirect = migratedEvents.find((item) => item.id === 2);
        const migratedDiaper = migratedEvents.find((item) => item.id === 3);
        assertDeepEqual(migratedFormula?.feedTypes, ['formula'], 'v1 formula 记录迁移为 feedTypes=["formula"]');
        assertEqual(migratedFormula?.amountMl, 120, 'v1 奶量迁移后保留 120');
        assertEqual(migratedFormula?.note, '老记录', 'v1 备注迁移后保留');
        assertDeepEqual(migratedDirect?.feedTypes, ['breast_direct'], 'v1 亲喂记录迁移为 feedTypes=["breast_direct"]');
        assertEqual(migratedDirect?.amountMl, null, 'v1 亲喂迁移后 amountMl 仍为 null');
        assertEqual(migratedDiaper?.diaperKind, 'poop', 'v1 大小便记录迁移正确');
        assertEqual(migratedDiaper?.feedTypes, null, 'v1 大小便记录 feedTypes=null');
        assertEqual(migratedEvents[0]?.id, 3, '迁移后 id 与顺序保留（happenedAt DESC）');
      } finally {
        await stopProcess(migrateServer.child, 'server');
        const idx = extraServerProcesses.indexOf(migrateServer);
        if (idx >= 0) extraServerProcesses.splice(idx, 1);
      }
      const migratedDb = new DatabaseSync(legacyDbPath);
      const versionRow = migratedDb.prepare('PRAGMA user_version').get();
      const columns = migratedDb.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
      const migratedCount = migratedDb.prepare('SELECT COUNT(*) AS n FROM events').get();
      migratedDb.close();
      assertEqual(Number(versionRow?.user_version), 3, '迁移后 PRAGMA user_version = 3（v3 schema）');
      assert(columns.includes('feed_types') && !columns.includes('feed_type'), '迁移后表结构为 feed_types（旧列已替换）', columns.join(','));
      assertEqual(Number(migratedCount?.n), 3, '迁移后行数不变');
      // 迁移幂等：再次用同一 DB 启动 server，数据不重复、不报错
      const reopenPort = await freePort();
      const reopenServer = launchServer({ port: reopenPort, dbPath: legacyDbPath, label: 'migrate-reopen' });
      extraServerProcesses.push(reopenServer);
      try {
        const reopenApi = `http://127.0.0.1:${reopenPort}`;
        await waitHealth(reopenApi);
        const reopened = await new ApiClient(reopenApi).events(10);
        assertEqual(reopened.length, 3, '迁移幂等：二次打开已迁移库记录数仍为 3（未重复）');
        assertDeepEqual(reopened.find((item) => item.id === 1)?.feedTypes, ['formula'], '迁移幂等：feedTypes 保持正确');
      } finally {
        await stopProcess(reopenServer.child, 'server');
        const idx = extraServerProcesses.indexOf(reopenServer);
        if (idx >= 0) extraServerProcesses.splice(idx, 1);
      }
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(`${legacyDbPath}${suffix}`, { force: true });
      }
      assertEqual((await api.allEvents()).length, 0, '契约测试后主数据库为空');
    });

    /* ------------------------------------------------ G16b v3 契约（洗澡 API / stats / CSV / v2→v3 迁移） */
    await runGroup('G16b', 'v3 契约：洗澡 API / /api/stats / CSV 洗澡行 / v2→v3 迁移', async () => {
      assertEqual((await api.allEvents()).length, 0, 'v3 契约测试起始数据库为空');

      const expectV3Error = async (name, response, status, code) => {
        assertEqual(response.status, status, `${name} → ${status}`);
        assertEqual(response.data?.error, code, `${name} error=${code}`);
        assert(
          typeof response.data?.message === 'string' && /[\u4e00-\u9fa5]/.test(response.data.message),
          `${name} message 为中文`,
          JSON.stringify(response.data?.message),
        );
      };

      // ---- POST /api/baths 成功路径与 Event 结构
      const bath1 = await api.createBath({});
      assertEqual(bath1.status, 201, 'POST /api/baths（空对象 body）→ 201');
      const bathEvent = bath1.data?.event ?? {};
      assertDeepEqual(
        Object.keys(bathEvent).sort(),
        ['amountMl', 'createdAt', 'diaperKind', 'feedTypes', 'happenedAt', 'id', 'kind', 'note'],
        '洗澡 Event JSON 字段与契约一致（无多余/缺失字段）',
      );
      assertEqual(bathEvent.kind, 'bath', '洗澡事件 kind = "bath"');
      assertEqual(bathEvent.feedTypes, null, '洗澡事件 feedTypes = null');
      assertEqual(bathEvent.amountMl, null, '洗澡事件 amountMl = null');
      assertEqual(bathEvent.diaperKind, null, '洗澡事件 diaperKind = null');
      assertEqual(bathEvent.note, null, '洗澡事件 note 默认 null');
      assert(
        typeof bathEvent.happenedAt === 'number' && typeof bathEvent.createdAt === 'number',
        '洗澡事件时间为 epoch 毫秒 number',
      );
      const stateAfterBath1 = await apiStateNow();
      assertEqual(stateAfterBath1.lastBath?.id, bathEvent.id, '/api/state lastBath 指向最新洗澡');
      assertEqual(stateAfterBath1.today.bathCount, 1, '/api/state today.bathCount = 1');

      const bathTime = Date.now() - 90 * 60_000;
      const bath2 = await api.createBath({ note: '  洗香香  ', happenedAt: bathTime });
      assertEqual(bath2.status, 201, 'POST /api/baths 带 note/happenedAt → 201');
      assertEqual(bath2.data?.event?.note, '洗香香', '洗澡备注 trim 后保存');
      assertEqual(bath2.data?.event?.happenedAt, bathTime, '洗澡 happenedAt 原样保存');
      const stateAfterBath2 = await apiStateNow();
      assertEqual(stateAfterBath2.lastBath?.id, bathEvent.id, 'lastBath 取发生时间较晚者（bath2 更早）');
      assertEqual(stateAfterBath2.today.bathCount, 2, '同日两条洗澡 bathCount = 2');

      const threeDaysAgo = Date.now() - 3 * 86_400_000;
      const oldBath = await api.createBath({ happenedAt: threeDaysAgo, note: '三天前' });
      assertEqual(oldBath.status, 201, 'POST /api/baths 补记三天前洗澡 → 201');
      assertEqual((await apiStateNow()).today.bathCount, 2, '补记非今天洗澡不改变 today.bathCount');

      // ---- POST /api/baths 校验/错误码
      await expectV3Error('洗澡 note 超长（201 字符）', await api.createBath({ note: 'x'.repeat(201) }), 400, 'invalid_note');
      await expectV3Error('洗澡 note 非字符串', await api.createBath({ note: 123 }), 400, 'invalid_note');
      await expectV3Error(
        '洗澡 happenedAt 超前 10 分钟',
        await api.createBath({ happenedAt: Date.now() + 10 * 60_000 }),
        400,
        'invalid_happened_at',
      );
      await expectV3Error('洗澡 happenedAt 字符串', await api.createBath({ happenedAt: '123' }), 400, 'invalid_happened_at');
      await expectV3Error(
        '洗澡 happenedAt 早于 2000-01-01',
        await api.createBath({ happenedAt: 946_684_799_999 }),
        400,
        'invalid_happened_at',
      );
      await expectV3Error(
        '洗澡非法 JSON 体',
        await api.request('/api/baths', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }),
        400,
        'invalid_json',
      );
      await expectV3Error(
        '洗澡 Content-Type 非 JSON',
        await api.request('/api/baths', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }),
        415,
        'unsupported_media_type',
      );
      await expectV3Error(
        '洗澡请求体超大（>64KB）',
        await api.request('/api/baths', {
          method: 'POST',
          body: JSON.stringify({ note: 'x'.repeat(70 * 1024) }),
          headers: { 'Content-Type': 'application/json' },
        }),
        413,
        'payload_too_large',
      );
      // 非法请求不应产生记录
      const eventsAfterBathErrors = await api.allEvents();
      assertEqual(eventsAfterBathErrors.length, 3, '非法洗澡请求均未落库（仅 3 条合法洗澡记录）');

      // ---- GET /api/stats 形状 / 参数 / 与 state 口径一致
      const defaultStats = await api.stats();
      assertEqual(defaultStats.status, 200, 'GET /api/stats（不带参数）→ 200');
      assertEqual(defaultStats.data?.days, 7, 'GET /api/stats 默认 days = 7');
      assertEqual(defaultStats.data?.daily?.length, 7, 'daily 长度 = days');
      assert(
        typeof defaultStats.data?.startDate === 'string' && typeof defaultStats.data?.endDate === 'string',
        '响应含 startDate / endDate',
      );
      assertEqual(defaultStats.data?.endDate, formatDayKeyNode(Date.now()), '默认 tz 下 endDate = 今天（本地日历）');
      assertDeepEqual(
        Object.keys(defaultStats.data.daily[0]).sort(),
        [
          'bathCount',
          'breastDirectCount',
          'breastMilkCount',
          'date',
          'diaperCount',
          'feedCount',
          'formulaCount',
          'mixedCount',
          'mixedFeedCount',
          'peeCount',
          'poopCount',
          'totalMl',
        ],
        'daily 每项字段与契约 §5 一致（含 v3 bathCount）',
      );
      const datesAsc = defaultStats.data.daily.map((item) => item.date);
      assert(
        datesAsc.every((date, index) => index === 0 || date > datesAsc[index - 1]),
        'daily 按日期升序且连续',
        datesAsc.join(','),
      );
      const stateForStats = await api.state(tzOffset);
      const statsToday = (await api.stats(7, tzOffset)).data;
      const lastDaily = statsToday.daily[statsToday.daily.length - 1];
      assertEqual(lastDaily.date, stateForStats.today.date, 'stats 最后一天日期 = /api/state today.date（同 tzOffset）');
      assertDeepEqual(lastDaily, stateForStats.today, 'stats 最后一天聚合与 /api/state today 完全一致（同一套口径）');
      assertEqual(lastDaily.bathCount, 2, '今天 bathCount = 2（两条今天的洗澡）');
      const day3 = statsToday.daily[statsToday.daily.length - 4];
      assertEqual(day3.bathCount, 1, '三天前那天的 bathCount = 1');
      assertEqual(
        statsToday.daily.reduce((sum, item) => sum + item.bathCount, 0),
        3,
        '7 天窗口 bathCount 合计 = 3',
      );
      // 合法 days 范围 1..90
      for (const days of [1, 30, 90]) {
        const ranged = await api.stats(days);
        assertEqual(ranged.status, 200, `GET /api/stats?days=${days} → 200`);
        assertEqual(ranged.data?.days, days, `days=${days} 回显正确`);
        assertEqual(ranged.data?.daily?.length, days, `days=${days} daily 长度正确`);
      }
      // 非法 days / tzOffset
      for (const [raw, label] of [
        ['0', 'days=0'],
        ['91', 'days=91'],
        ['abc', 'days=abc'],
        ['1.5', 'days=1.5'],
        ['-1', 'days=-1'],
      ]) {
        await expectV3Error(`GET /api/stats ${label}`, await api.request(`/api/stats?days=${encodeURIComponent(raw)}`), 400, 'invalid_days');
      }
      await expectV3Error('GET /api/stats tzOffset=9999', await api.request('/api/stats?tzOffset=9999'), 400, 'invalid_tz_offset');
      await expectV3Error('GET /api/stats tzOffset=abc', await api.request('/api/stats?tzOffset=abc'), 400, 'invalid_tz_offset');
      // tzOffset 语义：days=1 的 endDate 应等于该固定时区下的「今天」
      const tzProbe = async (offset) => {
        const response = await api.request(`/api/stats?days=1&tzOffset=${offset}`);
        return response.data;
      };
      const tzMinus480 = await tzProbe(-480);
      const tzPlus840 = await tzProbe(840);
      const dateKeyForOffset = (ts, offsetMinutes) => {
        const shifted = new Date(ts - offsetMinutes * 60_000);
        const pad = (n) => (n < 10 ? `0${n}` : String(n));
        return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
      };
      assertEqual(tzMinus480?.endDate, dateKeyForOffset(Date.now(), -480), 'tzOffset=-480 的 endDate 符合固定偏移日历口径');
      assertEqual(tzPlus840?.endDate, dateKeyForOffset(Date.now(), 840), 'tzOffset=+840 的 endDate 符合固定偏移日历口径');

      // ---- CSV 洗澡行
      const csvBath = await api.exportCsv();
      assertEqual(csvBath.status, 200, 'GET /api/export.csv → 200');
      const csvLines = csvBath.text.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
      assertEqual(csvLines[0], '时间,类别,项目,奶量(ml),备注', 'CSV 表头符合 v3 契约');
      const bathRows = csvLines.filter((line) => line.includes(',洗澡,洗澡,'));
      assertEqual(bathRows.length, 3, 'CSV 中 3 条洗澡行（类别=洗澡、项目=洗澡）');
      assertMatch(bathRows[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2},洗澡,洗澡,,/, 'CSV 洗澡行格式：时间,洗澡,洗澡,,备注', bathRows[0]);
      assertIncludes(csvLines.join('\n'), '洗香香', 'CSV 洗澡行包含备注');

      // ---- v2 → v3 迁移（kind CHECK 仅 feed/diaper 的旧库）
      const { DatabaseSync } = await import('node:sqlite');
      const v2DbPath = path.join(tmpDir, 'legacy-v2.db');
      const t0 = Date.now() - 5 * 3_600_000;
      const v2Db = new DatabaseSync(v2DbPath);
      v2Db.exec(`CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT    NOT NULL CHECK (kind IN ('feed', 'diaper')),
        feed_types  TEXT,
        amount_ml   INTEGER CHECK (amount_ml IS NULL OR (amount_ml >= 1 AND amount_ml <= 2000)),
        diaper_kind TEXT    CHECK (diaper_kind IN ('pee', 'poop', 'mixed')),
        note        TEXT,
        happened_at INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        CHECK (
          (kind = 'feed' AND feed_types IS NOT NULL AND diaper_kind IS NULL)
          OR
          (kind = 'diaper' AND feed_types IS NULL AND amount_ml IS NULL AND diaper_kind IS NOT NULL)
        )
      );`);
      const v2Insert = v2Db.prepare(
        'INSERT INTO events (id, kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      v2Insert.run(1, 'feed', JSON.stringify(['formula', 'breast_milk']), 150, null, 'v2 老记录', t0, t0 + 1000);
      v2Insert.run(2, 'diaper', null, null, 'pee', null, t0 + 60_000, t0 + 61_000);
      v2Db.exec('PRAGMA user_version = 2');
      v2Db.close();

      const v2Port = await freePort();
      const v2Server = launchServer({ port: v2Port, dbPath: v2DbPath, label: 'migrate-v2' });
      extraServerProcesses.push(v2Server);
      try {
        const v2Api = `http://127.0.0.1:${v2Port}`;
        await waitHealth(v2Api);
        const v2Client = new ApiClient(v2Api);
        const migrated = await v2Client.events(10);
        assertEqual(migrated.length, 2, 'v2 旧库 2 条记录迁移后全部保留');
        assertDeepEqual(migrated.find((item) => item.id === 1)?.feedTypes, ['formula', 'breast_milk'], 'v2 多标签 feedTypes 迁移后保留');
        assertEqual(migrated.find((item) => item.id === 1)?.amountMl, 150, 'v2 奶量迁移后保留');
        assertEqual(migrated.find((item) => item.id === 2)?.diaperKind, 'pee', 'v2 大小便迁移后保留');
        const migratedBath = await v2Client.createBath({ note: '迁移后洗澡' });
        assertEqual(migratedBath.status, 201, 'v2→v3 迁移后 kind CHECK 已放宽：可记录洗澡 → 201');
        assertEqual(migratedBath.data?.event?.kind, 'bath', '迁移后写入的洗澡 kind = "bath"');
        assertEqual((await v2Client.events(10)).length, 3, '迁移后洗澡成功落库（3 条）');
      } finally {
        await stopProcess(v2Server.child, 'server');
        const idx = extraServerProcesses.indexOf(v2Server);
        if (idx >= 0) extraServerProcesses.splice(idx, 1);
      }
      const v2MigratedDb = new DatabaseSync(v2DbPath);
      const v2VersionRow = v2MigratedDb.prepare('PRAGMA user_version').get();
      const v2Columns = v2MigratedDb.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
      v2MigratedDb.close();
      assertEqual(Number(v2VersionRow?.user_version), 3, 'v2→v3 迁移后 PRAGMA user_version = 3');
      assert(v2Columns.includes('feed_types'), 'v2→v3 迁移后表结构仍为 feed_types 列', v2Columns.join(','));
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(`${v2DbPath}${suffix}`, { force: true });
      }

      // ---- 清理
      const cleanedV3 = await deleteAllEvents();
      assertEqual(cleanedV3.deleted, cleanedV3.total, '清理 v3 契约测试数据');
      assertEqual((await api.allEvents()).length, 0, 'v3 契约测试后主数据库为空');
    });

    /* ------------------------------------------------ G17 CLI 端到端（同一临时后端） */
    await runGroup('G17', 'CLI 端到端：status / feed / pee / bath / log / today / undo / rm / export / config / 错误码', async () => {
      assertEqual((await api.allEvents()).length, 0, 'CLI 测试起始数据库为空');
      const deadServer = 'http://127.0.0.1:1';
      const cliEnv = { XDG_CONFIG_HOME: cliConfigDirPath };
      const run = (args, opts = {}) => runCli([...args, '--server', apiBase], opts);
      const parseJson = (result, label) => {
        try {
          return JSON.parse(result.stdoutText.trim());
        } catch {
          return null;
        }
      };
      const parseErrJson = (result) => {
        try {
          return JSON.parse(result.stderrText.trim());
        } catch {
          return null;
        }
      };
      const expectUsage = async (args, label, messagePart, opts = {}) => {
        const result = await runCli(args, { env: cliEnv, ...opts });
        assertEqual(result.code, 2, `${label} → exit 2（用法错误）`, `exit=${result.code}`);
        const errorJson = parseErrJson(result);
        assertEqual(errorJson?.error, 'usage_error', `${label} stderr 为 JSON usage_error`);
        if (messagePart) assertIncludes(String(errorJson?.message ?? ''), messagePart, `${label} stderr message 提示正确`, String(errorJson?.message ?? ''));
        return result;
      };

      // 版本 / 帮助
      const versionRun = await runCli(['-V'], { env: cliEnv });
      assertEqual(versionRun.code, 0, 'CLI -V exit 0');
      assertEqual(versionRun.stdoutText.trim(), 'naiji 2.0.0', 'CLI 版本号 naiji 2.0.0');
      const helpRun = await runCli(['help'], { env: cliEnv });
      assertEqual(helpRun.code, 0, 'CLI help exit 0');
      assertIncludes(helpRun.stdoutText, 'naiji', 'CLI help 输出用法');
      const helpFeed = await runCli(['help', 'feed'], { env: cliEnv });
      assertEqual(helpFeed.code, 0, 'CLI help feed exit 0');
      assertIncludes(helpFeed.stdoutText, '-t', 'CLI help feed 显示 -t 类型选项');
      assertIncludes(helpFeed.stdoutText, '--direct', 'CLI help feed 显示 --direct 选项');

      // status --json 与服务端 state 一致
      const statusRun = await runCli(['status', '--json', '--server', apiBase], { env: cliEnv });
      assertEqual(statusRun.code, 0, 'CLI status --json exit 0', statusRun.stderrText.slice(0, 200));
      const statusJson = parseJson(statusRun, 'status');
      assert(Boolean(statusJson), 'CLI status --json stdout 为合法 JSON', statusRun.stdoutText.slice(0, 200));
      const apiEmptyState = await apiStateNow();
      assertEqual(statusJson?.lastFeeding, null, 'CLI status 空库 lastFeeding=null');
      assertDeepEqual(statusJson?.today, apiEmptyState.today, 'CLI status 的 today 与 GET /api/state 一致');

      const statusText = await runCli(['status', '--server', apiBase, '--no-color'], { env: cliEnv });
      assertEqual(statusText.code, 0, 'CLI status 文本模式 exit 0');
      assertIncludes(statusText.stdoutText, '还没有喂奶记录', 'CLI status 空库输出「还没有喂奶记录」');
      assertIncludes(statusText.stdoutText, '今日', 'CLI status 输出今日汇总');
      assert(!statusText.stdoutText.includes('\u001b'), 'CLI 非 TTY 输出无 ANSI 颜色码');
      const noArgs = await runCli(['--server', apiBase, '--no-color'], { env: cliEnv });
      assertEqual(noArgs.code, 0, 'CLI 无参数（= status）exit 0');
      assertIncludes(noArgs.stdoutText, '还没有喂奶记录', 'CLI 无参数默认执行 status');

      // feed：多标签 / 中文别名 / 组合 / 仅亲喂 / --ago / --at / --note
      const feedMulti = await run(['feed', '120', '-t', 'formula', '-t', 'breast_milk', '--json']);
      assertEqual(feedMulti.code, 0, 'CLI feed 多标签 exit 0', feedMulti.stderrText.slice(0, 200));
      const feedMultiJson = parseJson(feedMulti, 'feed');
      assertDeepEqual(feedMultiJson?.event?.feedTypes, ['formula', 'breast_milk'], 'CLI feed -t formula -t breast_milk → feedTypes 规范顺序');
      assertEqual(feedMultiJson?.event?.amountMl, 120, 'CLI feed 多标签总奶量 120');
      assertEqual(typeof feedMultiJson?.event?.happenedAt, 'number', 'CLI feed 返回 epoch ms happenedAt');
      const stateAfterMulti = await apiStateNow();
      assertEqual(stateAfterMulti.today.totalMl, 120, 'CLI feed 后服务端 totalMl=120');
      assertEqual(stateAfterMulti.today.mixedFeedCount, 1, 'CLI feed 后服务端 mixedFeedCount=1');

      const feedCn = await run(['f', '90', '-t', '奶粉,母乳', '--json']);
      assertEqual(feedCn.code, 0, 'CLI f 中文别名 + 逗号分隔 exit 0');
      assertDeepEqual(parseJson(feedCn, 'f')?.event?.feedTypes, ['formula', 'breast_milk'], 'CLI 中文别名「奶粉,母乳」解析正确');
      assertEqual((await apiStateNow()).today.totalMl, 210, 'CLI 第二条后 totalMl=210');

      const feedCombo = await run(['f', '60', '-t', 'formula', '-t', 'breast_direct', '--json']);
      assertEqual(feedCombo.code, 0, 'CLI f 亲喂 + 奶粉组合 exit 0');
      assertDeepEqual(parseJson(feedCombo, 'f')?.event?.feedTypes, ['formula', 'breast_direct'], 'CLI 组合标签规范顺序');
      assertEqual((await apiStateNow()).today.totalMl, 270, 'CLI 组合记录后 totalMl=270');

      const feedDirect = await run(['f', '--direct', '--json']);
      assertEqual(feedDirect.code, 0, 'CLI f --direct exit 0');
      const directEvent = parseJson(feedDirect, 'f');
      assertDeepEqual(directEvent?.event?.feedTypes, ['breast_direct'], 'CLI --direct → 仅亲喂');
      assertEqual(directEvent?.event?.amountMl, null, 'CLI 仅亲喂 amountMl=null');
      assertEqual((await apiStateNow()).today.totalMl, 270, 'CLI 仅亲喂不增加 totalMl');

      const agoBefore = Date.now();
      const feedAgo = await run(['f', '30', '--ago', '30', '--json']);
      const agoAfter = Date.now();
      assertEqual(feedAgo.code, 0, 'CLI f --ago 30 exit 0');
      const agoEvent = parseJson(feedAgo, 'f')?.event;
      const expectedAgo = agoBefore - 30 * 60_000;
      assert(Math.abs(agoEvent.happenedAt - expectedAgo) <= 5000, 'CLI --ago 30 的 happenedAt ≈ 30 分钟前', `差 ${agoEvent.happenedAt - expectedAgo}ms`);
      assert(agoEvent.happenedAt >= agoBefore - 30 * 60_000 - 5000 && agoEvent.happenedAt <= agoAfter - 30 * 60_000 + 5000, 'CLI --ago 时间落在执行窗口内');
      assertDeepEqual(agoEvent.feedTypes, ['formula'], 'CLI --ago 默认类型为 formula');

      // --at：HH:MM（今天）或绝对时间（凌晨回退为昨天绝对时间，保证可重复）
      const atNow = new Date();
      let atArg;
      let expectedAt;
      if (atNow.getHours() >= 3) {
        const target = new Date(Date.now() - 2 * 3_600_000);
        atArg = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
        expectedAt = new Date(atNow.getFullYear(), atNow.getMonth(), atNow.getDate(), target.getHours(), target.getMinutes(), 0, 0).getTime();
      } else {
        const yesterday = new Date(Date.now() - 24 * 3_600_000);
        atArg = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')} 20:00`;
        expectedAt = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 20, 0, 0, 0).getTime();
      }
      const feedAt = await run(['f', '45', '--at', atArg, '--json']);
      assertEqual(feedAt.code, 0, 'CLI f --at HH:MM exit 0', feedAt.stderrText.slice(0, 200));
      assertEqual(parseJson(feedAt, 'f')?.event?.happenedAt, expectedAt, 'CLI --at 解析为期望的本地时间戳');

      const feedNote = await run(['f', '30', '--note', '夜里那次', '--json']);
      assertEqual(feedNote.code, 0, 'CLI f --note exit 0');
      assertEqual(parseJson(feedNote, 'f')?.event?.note, '夜里那次', 'CLI --note 写入备注');
      const logNote = await runCli(['log', '-n', '1', '--server', apiBase, '--no-color'], { env: cliEnv });
      assertIncludes(logNote.stdoutText, '夜里那次', 'CLI log 文本输出包含备注');

      // 大小便
      const peeRun = await run(['p', '--json']);
      assertEqual(peeRun.code, 0, 'CLI pee 别名 exit 0');
      assertEqual(parseJson(peeRun, 'p')?.event?.diaperKind, 'pee', 'CLI p → diaperKind=pee');
      const poopRun = await run(['o', '--json']);
      assertEqual(poopRun.code, 0, 'CLI poop 别名 exit 0');
      assertEqual(parseJson(poopRun, 'o')?.event?.diaperKind, 'poop', 'CLI o → diaperKind=poop');
      const mixedRun = await run(['d', 'mixed', '--json']);
      assertEqual(mixedRun.code, 0, 'CLI diaper mixed exit 0');
      assertEqual(parseJson(mixedRun, 'd')?.event?.diaperKind, 'mixed', 'CLI d mixed → diaperKind=mixed');
      const diaperState = await apiStateNow();
      assertEqual(diaperState.today.diaperCount, 3, 'CLI 后服务端 diaperCount=3');
      assertEqual(diaperState.today.peeCount, 2, 'CLI 后服务端 peeCount=2（含 mixed）');
      assertEqual(diaperState.today.poopCount, 2, 'CLI 后服务端 poopCount=2（含 mixed）');
      assertEqual(diaperState.today.mixedCount, 1, 'CLI 后服务端 mixedCount=1');

      // ---- v3 洗澡：naiji bath / b（--note / --ago / --json / 文本输出）
      const bathCountBeforeCli = (await apiStateNow()).today.bathCount ?? 0;
      const cliBathRun = await run(['bath', '--json']);
      assertEqual(cliBathRun.code, 0, 'CLI bath --json exit 0', cliBathRun.stderrText.slice(0, 200));
      const cliBathJson = parseJson(cliBathRun, 'bath');
      assertEqual(cliBathJson?.event?.kind, 'bath', 'CLI bath --json 返回 kind="bath"');
      assertEqual(cliBathJson?.event?.feedTypes, null, 'CLI bath event.feedTypes=null');
      assertEqual(cliBathJson?.event?.amountMl, null, 'CLI bath event.amountMl=null');
      assertEqual(cliBathJson?.event?.diaperKind, null, 'CLI bath event.diaperKind=null');
      const bathCliState = await apiStateNow();
      assertEqual(bathCliState.today.bathCount, bathCountBeforeCli + 1, 'CLI bath 后服务端 today.bathCount +1');
      assertEqual(bathCliState.lastBath?.id, cliBathJson?.event?.id, 'CLI bath 后服务端 lastBath 指向该记录');

      const bathAgoBefore = Date.now();
      const cliBathAgo = await run(['bath', '--ago', '30', '--json']);
      const bathAgoAfter = Date.now();
      assertEqual(cliBathAgo.code, 0, 'CLI bath --ago 30 --json exit 0', cliBathAgo.stderrText.slice(0, 200));
      const bathAgoEvent = parseJson(cliBathAgo, 'bath')?.event;
      const expectedBathAgo = bathAgoBefore - 30 * 60_000;
      assert(
        Math.abs((bathAgoEvent?.happenedAt ?? 0) - expectedBathAgo) <= 5000,
        'CLI bath --ago 30 的 happenedAt ≈ 30 分钟前',
        `差 ${(bathAgoEvent?.happenedAt ?? 0) - expectedBathAgo}ms`,
      );
      assert(
        bathAgoEvent.happenedAt >= bathAgoBefore - 30 * 60_000 - 5000 && bathAgoEvent.happenedAt <= bathAgoAfter - 30 * 60_000 + 5000,
        'CLI bath --ago 时间落在执行窗口内',
      );

      const cliBathNote = await run(['b', '--note', '洗香香', '--json']);
      assertEqual(cliBathNote.code, 0, 'CLI b --note 洗香香 --json exit 0');
      assertEqual(parseJson(cliBathNote, 'b')?.event?.note, '洗香香', 'CLI bath --note 写入备注');

      const cliBathText = await run(['bath', '--no-color']);
      assertEqual(cliBathText.code, 0, 'CLI bath 文本模式 exit 0');
      assertMatch(cliBathText.stdoutText, /已记录 洗澡 . \d{2}:\d{2}/, 'CLI bath 文本输出「✅ 已记录 洗澡 · HH:MM」', JSON.stringify(cliBathText.stdoutText.trim()));
      assert(!cliBathText.stdoutText.includes('\u001b'), 'CLI bath 非 TTY 输出无 ANSI 颜色码');

      // status / today / log 的洗澡文案
      const statusWithBath = await runCli(['status', '--server', apiBase, '--no-color'], { env: cliEnv });
      assertEqual(statusWithBath.code, 0, 'CLI status（有洗澡数据）exit 0');
      assertIncludes(statusWithBath.stdoutText, '距上次换尿布/洗澡', 'CLI status 输出 v3 文案「距上次换尿布/洗澡」');
      assertMatch(statusWithBath.stdoutText, /距上次换尿布\/洗澡\s+(刚刚|\d+ 分钟|\d+ 小时( \d+ 分钟)?)/, 'CLI status 换尿布/洗澡计时格式正确');
      assertMatch(statusWithBath.stdoutText, /今日 .*洗澡 \d+ 次/, 'CLI status 今日汇总含「洗澡 N 次」', JSON.stringify(statusWithBath.stdoutText.trim()));
      const todayBathState = await apiStateNow();
      assertIncludes(
        statusWithBath.stdoutText,
        `洗澡 ${todayBathState.today.bathCount} 次`,
        'CLI status 洗澡次数与服务端 today.bathCount 一致',
      );
      const todayTextRun = await run(['today', '--no-color']);
      assertEqual(todayTextRun.code, 0, 'CLI today 文本模式 exit 0');
      assertIncludes(todayTextRun.stdoutText, '洗澡', 'CLI today 输出包含洗澡记录/汇总');
      const logTextRun = await run(['log', '-n', '30', '--no-color']);
      assertEqual(logTextRun.code, 0, 'CLI log 文本模式 exit 0');
      assertIncludes(logTextRun.stdoutText, '洗澡', 'CLI log 输出包含洗澡记录');
      const logJsonBath = await run(['log', '-n', '30', '--json']);
      const logBathEvents = (parseJson(logJsonBath, 'log')?.events ?? []).filter((item) => item.kind === 'bath');
      assert(logBathEvents.length >= 3, 'CLI log --json 返回的洗澡记录 ≥ 3 条', `${logBathEvents.length} 条`);

      // undo 删除洗澡
      const bathForUndo = await run(['b', '--json']);
      assertEqual(bathForUndo.code, 0, 'CLI 记录一条待撤销洗澡 exit 0');
      const bathForUndoId = parseJson(bathForUndo, 'b')?.event?.id;
      const undoBathRun = await run(['undo', '--json']);
      assertEqual(undoBathRun.code, 0, 'CLI undo 撤销洗澡 exit 0');
      const undoBathJson = parseJson(undoBathRun, 'undo');
      assertEqual(undoBathJson?.deleted?.id, bathForUndoId, 'CLI undo 删除最近一条洗澡');
      assertEqual(undoBathJson?.deleted?.kind, 'bath', 'CLI undo 输出的被删记录 kind="bath"');
      assert(!(await api.allEvents()).some((item) => item.id === bathForUndoId), 'CLI undo 后该洗澡记录从服务端消失');

      // 洗澡用法错误：多余位置参数 / 非法 --ago
      await expectUsage(['bath', 'extra', '--json'], 'CLI bath 多余位置参数', '不接受参数');
      await expectUsage(['bath', '--ago', 'abc', '--json'], 'CLI bath 非法 --ago', '--ago 必须是分钟数');

      // log / today 与服务端一致
      const apiEvents = await api.events(200);
      const logRun = await run(['log', '-n', '3', '--json']);
      assertEqual(logRun.code, 0, 'CLI log -n 3 --json exit 0');
      const logJson = parseJson(logRun, 'log');
      assertEqual(logJson?.events?.length, 3, 'CLI log -n 3 返回 3 条');
      assertDeepEqual(logJson?.events?.map((item) => item.id), apiEvents.slice(0, 3).map((item) => item.id), 'CLI log 顺序与 GET /api/events 一致');
      const apiToday = await apiStateNow();
      const todayRun = await run(['today', '--json']);
      assertEqual(todayRun.code, 0, 'CLI today --json exit 0');
      const todayJson = parseJson(todayRun, 'today');
      assertEqual(todayJson?.date, apiToday.today.date, 'CLI today 日期与 API 一致');
      assertDeepEqual(todayJson?.summary, apiToday.today, 'CLI today 汇总与 API /api/state 一致');
      const todayEventIds = apiEvents.filter((item) => formatDayKeyNode(item.happenedAt) === apiToday.today.date).map((item) => item.id);
      assertDeepEqual(todayJson?.events?.map((item) => item.id), todayEventIds, 'CLI today 只包含今天的记录');
      const statusAfterData = await runCli(['status', '--json', '--server', apiBase], { env: cliEnv });
      const statusAfterJson = parseJson(statusAfterData, 'status');
      assertDeepEqual(statusAfterJson?.today, apiToday.today, '有数据时 CLI status 汇总仍与 API 一致');
      assertEqual(statusAfterJson?.lastFeeding?.id, apiToday.lastFeeding?.id, 'CLI status lastFeeding 与 API 一致');

      // undo / rm
      const newest = (await api.events(1))[0];
      const undoRun = await run(['undo', '--json']);
      assertEqual(undoRun.code, 0, 'CLI undo --json exit 0');
      const undoJson = parseJson(undoRun, 'undo');
      assertEqual(undoJson?.ok, true, 'CLI undo 返回 ok:true');
      assertEqual(undoJson?.deleted?.id, newest.id, 'CLI undo 删除最近一条记录', `期望 id=${newest.id}`);
      assert(!(await api.allEvents()).some((item) => item.id === newest.id), 'CLI undo 后该记录从服务端消失');

      const rmTarget = agoEvent.id;
      const rmRun = await run(['rm', String(rmTarget), '--json']);
      assertEqual(rmRun.code, 0, 'CLI rm <id> --json exit 0');
      assertEqual(parseJson(rmRun, 'rm')?.deleted?.id, rmTarget, 'CLI rm 删除指定 id 记录');
      assert(!(await api.allEvents()).some((item) => item.id === rmTarget), 'CLI rm 后该记录从服务端消失');
      const rmMissing = await run(['rm', '999999', '--json']);
      assertEqual(rmMissing.code, 1, 'CLI rm 不存在 id → exit 1（API 错误）');
      const rmMissingJson = parseErrJson(rmMissing);
      assertEqual(rmMissingJson?.ok, false, 'CLI rm 错误输出 ok:false');
      assertEqual(rmMissingJson?.error, 'not_found', 'CLI rm 错误码 not_found');
      assertIncludes(String(rmMissingJson?.message ?? ''), '记录不存在', 'CLI rm 错误 message 来自后端中文');

      // export --out / stdout
      const exportCwd = tmpDir;
      const exportRun = await runCli(
        ['export', '--out', 'cli-export/milk.csv', '--json', '--server', apiBase],
        { env: cliEnv, cwd: exportCwd },
      );
      assertEqual(exportRun.code, 0, 'CLI export --out --json exit 0', exportRun.stderrText.slice(0, 200));
      const exportJson = parseJson(exportRun, 'export');
      const exportedPath = path.join(tmpDir, 'cli-export', 'milk.csv');
      assertEqual(exportJson?.ok, true, 'CLI export 返回 ok:true');
      assertEqual(exportJson?.path, exportedPath, 'CLI export 返回输出路径');
      const exportedBuffer = await readFile(exportedPath);
      assertEqual(exportJson?.bytes, exportedBuffer.length, 'CLI export 报告的 bytes 与文件大小一致');
      assert(exportedBuffer[0] === 0xef && exportedBuffer[1] === 0xbb && exportedBuffer[2] === 0xbf, 'CLI export 文件带 UTF-8 BOM');
      const exportedText = exportedBuffer.toString('utf8');
      assertIncludes(exportedText, '时间,类别,项目,奶量(ml),备注', 'CLI export 文件表头正确');
      const apiEventCountNow = (await api.allEvents()).length;
      assertEqual(exportedText.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0).length, apiEventCountNow + 1, 'CLI export 文件记录数 = 服务端记录数');
      const exportStdout = await runCli(['export', '--server', apiBase], { env: cliEnv });
      assertEqual(exportStdout.code, 0, 'CLI export 输出到 stdout exit 0');
      assert(exportStdout.stdout[0] === 0xef && exportStdout.stdout[1] === 0xbb && exportStdout.stdout[2] === 0xbf, 'CLI export stdout 带 UTF-8 BOM');
      assertIncludes(exportStdout.stdoutText, '时间,类别,项目,奶量(ml),备注', 'CLI export stdout 含表头');
      const exportDash = await runCli(['export', '--out', '-', '--server', apiBase], { env: cliEnv });
      assertEqual(exportDash.code, 0, 'CLI export --out - 输出到 stdout exit 0');
      assert(exportDash.stdout[0] === 0xef && exportDash.stdout[1] === 0xbb && exportDash.stdout[2] === 0xbf, 'CLI export --out - 仍带 BOM');

      // config：set / show / 生效
      const configSet = await runCli(['config', 'set', 'server', apiBase, '--json'], { env: cliEnv });
      assertEqual(configSet.code, 0, 'CLI config set server --json exit 0');
      const configSetJson = parseJson(configSet, 'config');
      assertEqual(configSetJson?.server, apiBase, 'CLI config set 返回写入地址');
      assertEqual(configSetJson?.path, path.join(cliConfigDirPath, 'naiji', 'config.json'), 'CLI config 写入 XDG_CONFIG_HOME/naiji/config.json');
      const configFile = JSON.parse(await readFile(configSetJson.path, 'utf8'));
      assertEqual(configFile.server, apiBase, 'CLI 配置文件内容正确');
      const configShow = await runCli(['config', 'show', '--json'], { env: cliEnv });
      const configShowJson = parseJson(configShow, 'config');
      assertEqual(configShowJson?.server, apiBase, 'CLI config show 显示配置地址');
      assertEqual(configShowJson?.source, 'config', 'CLI config show 来源为配置文件');
      assertEqual(configShowJson?.configExists, true, 'CLI config show 标记配置文件存在');
      const statusViaConfig = await runCli(['status', '--json'], { env: cliEnv });
      assertEqual(statusViaConfig.code, 0, 'CLI 无 --server 时使用配置文件地址（exit 0）');

      // 地址优先级：--server > NAIJI_SERVER > 配置文件
      const configDead = await runCli(['config', 'set', 'server', deadServer, '--json'], { env: cliEnv });
      assertEqual(configDead.code, 0, 'CLI config set 指向不可用地址 exit 0');
      const envPriority = await runCli(['status', '--json'], { env: { ...cliEnv, NAIJI_SERVER: apiBase } });
      assertEqual(envPriority.code, 0, 'NAIJI_SERVER 优先于配置文件（指向可用地址成功）');
      const flagPriority = await runCli(['status', '--json', '--server', apiBase], { env: { ...cliEnv, NAIJI_SERVER: deadServer } });
      assertEqual(flagPriority.code, 0, '--server 优先于 NAIJI_SERVER（成功）');

      // 错误码 / stderr
      await expectUsage(['feed', '120', '-t', '未知', '--json'], 'CLI 未知类型', '未知的喂奶类型');
      await expectUsage(['feed', 'abc', '--json'], 'CLI 非法奶量', '奶量必须是正整数');
      await expectUsage(['feed', '--json'], 'CLI 喂奶缺奶量', '需要奶量');
      await expectUsage(['feed', '--direct', '120', '--json'], 'CLI 仅亲喂带奶量', '仅亲喂');
      await expectUsage(['log', '-n', '999', '--json'], 'CLI log 超范围', '1 到 200');
      await expectUsage(['rm', '0', '--json'], 'CLI rm 非法 id', '记录 id');
      await expectUsage(['bogus', '--json'], 'CLI 未知命令', '未知命令');
      const networkError = await runCli(['status', '--json', '--server', deadServer], { env: cliEnv });
      assertEqual(networkError.code, 1, 'CLI 网络错误 → exit 1');
      const networkErrorJson = parseErrJson(networkError);
      assertEqual(networkErrorJson?.ok, false, 'CLI 网络错误输出 JSON ok:false');
      assertEqual(networkErrorJson?.error, 'network_error', 'CLI 网络错误码 network_error');
      assertIncludes(String(networkErrorJson?.message ?? ''), '无法连接服务器', 'CLI 网络错误提示包含服务器地址', String(networkErrorJson?.message ?? ''));
      const badEnv = await runCli(['status', '--json'], { env: { ...cliEnv, NAIJI_SERVER: '::::' } });
      assertEqual(badEnv.code, 2, 'CLI 非法 NAIJI_SERVER → exit 2（用法错误）');
      assertIncludes(String(parseErrJson(badEnv)?.message ?? ''), 'NAIJI_SERVER', 'CLI 非法 NAIJI_SERVER 提示明确');

      // 别名 + 启动器（cli/bin/naiji shell 启动器）
      const aliasS = await run(['s', '--json']);
      assertEqual(aliasS.code, 0, 'CLI 别名 s（status）exit 0');
      assertEqual(parseJson(aliasS, 's')?.today?.date, (await apiStateNow()).today.date, 'CLI 别名 s 输出 state');
      const aliasL = await run(['l', '-n', '1', '--json']);
      assertEqual(aliasL.code, 0, 'CLI 别名 l（log）exit 0');
      assertEqual(parseJson(aliasL, 'l')?.events?.length, 1, 'CLI 别名 l -n 1 返回 1 条');
      const aliasC = await runCli(['c', 'show', '--json'], { env: cliEnv });
      assertEqual(aliasC.code, 0, 'CLI 别名 c（config）exit 0');
      const launcherRun = await runCliLauncher(['status', '--json', '--server', apiBase]);
      assertEqual(launcherRun.code, 0, 'cli/bin/naiji shell 启动器 exit 0', launcherRun.stderrText.slice(0, 200));
      const launcherJson = parseJson(launcherRun, 'launcher');
      assert(Boolean(launcherJson?.today), 'cli/bin/naiji 启动器输出合法 JSON', launcherRun.stdoutText.slice(0, 200));
      assertEqual(launcherJson?.today?.date, (await apiStateNow()).today.date, '启动器与 CLI 行为一致');
    });

    /* ------------------------------------------------ G18 边界：恰好 30 条时的加载更多 */
    await runGroup('G18', '边界：恰好 30 条记录时「加载更多」的表现', async () => {
      const cleared = await deleteAllEvents();
      assertEqual(cleared.deleted, cleared.total, '清空 CLI 测试数据', `${cleared.deleted}/${cleared.total}`);
      const base = Date.now();
      let created = 0;
      for (let index = 0; index < 30; index += 1) {
        const happenedAt = base - (index + 1) * 600_000;
        let response;
        if (index % 5 === 0) response = await seedDiaper(index % 10 === 0 ? 'mixed' : 'pee', happenedAt);
        else if (index % 5 === 1) response = await seedFeed(['breast_milk'], 90, happenedAt);
        else response = await seedFeed(['formula'], 90, happenedAt);
        if (response.status === 201) created += 1;
      }
      assertEqual(created, 30, 'API 造满 30 条边界数据');
      await page.reload();
      assertEqual(await domHistoryCount(), 30, '恰好 30 条时首屏全部展示');
      const loadMoreVisible = await page.isVisible(sel('load-more'));
      note(
        '恰好 30 条时「加载更多」按钮',
        loadMoreVisible
          ? '按钮可见，但后端已无更多数据（点击后按钮消失、无新增）；属 P2 小瑕疵：首屏 hasMore 只能按 recent.length>=30 猜测'
          : '按钮已隐藏（符合契约「无更多时隐藏」）',
      );
      if (loadMoreVisible) {
        const since = page.responses.length;
        await page.clickTestId('load-more');
        await page.waitForResponse((response) => response.method === 'GET' && response.path === '/api/events', { since });
        await sleep(400);
        assertEqual(await domHistoryCount(), 30, '点击后记录数不变（确实没有更多数据）');
        assert(!(await page.isVisible(sel('load-more'))), '点击后「加载更多」按钮自行隐藏');
      }
    });

    /* ------------------------------------------------ G18b 趋势卡（v3 新增） */
    await runGroup('G18b', '趋势卡：7/30 天 · 6 指标 · 与 /api/stats 一致 · 空状态 · 响应式 · 深色', async () => {
      // 清库并造 10 天多类型数据（含今天）：每天都有喂奶，间隔出现亲喂/大小便/洗澡，覆盖 6 个指标
      const clearedForStats = await deleteAllEvents();
      assertEqual(clearedForStats.deleted, clearedForStats.total, '清空时间线数据（趋势卡用干净数据集）');
      const seedNow = Date.now();
      const seedResponses = [];
      for (let offset = 0; offset < 10; offset += 1) {
        const ts = offset === 0 ? seedNow - 900 : seedNow - offset * 86_400_000;
        seedResponses.push(await seedFeed(['formula', 'breast_milk'], 100 + offset * 10, ts));
        if (offset % 2 === 0) seedResponses.push(await seedFeed(['breast_direct'], undefined, ts));
        if (offset % 3 === 0) seedResponses.push(await seedFeed(['formula'], 60, ts));
        if (offset % 2 === 1) seedResponses.push(await seedDiaper('pee', ts));
        if (offset % 4 === 0) seedResponses.push(await seedDiaper('poop', ts));
        if (offset % 5 === 0) seedResponses.push(await seedDiaper('mixed', ts));
        if (offset % 3 === 0) seedResponses.push(await seedBath(ts, offset === 0 ? '今晚洗澡' : undefined));
      }
      assertEqual(seedResponses.filter((response) => response.status === 201).length, seedResponses.length, 'API 造 10 天多类型趋势数据（全部 201）');
      assert(seedResponses.length >= 30, '趋势数据集覆盖 6 个指标（事件数 ≥ 30）', `${seedResponses.length} 条`);

      const api7 = (await api.stats(7, tzOffset)).data;
      const api30 = (await api.stats(30, tzOffset)).data;
      assertEqual(api7?.days, 7, 'GET /api/stats?days=7 回显 days=7');
      assertEqual(api30?.days, 30, 'GET /api/stats?days=30 回显 days=30');
      const expected7Dates = [...Array(7)].map((_, index) => formatDayKeyNode(seedNow - (6 - index) * 86_400_000));
      assertDeepEqual(api7.daily.map((item) => item.date), expected7Dates, '7 天窗口日期 = 最近 7 个本地日历天（升序）');
      assertDeepEqual(api7.daily[6], (await api.state(tzOffset)).today, 'stats 最后一天与 /api/state today 聚合一致（同 tzOffset）');

      // 页面刷新 → 趋势卡渲染 7 天视图
      await page.reload();
      await page.evaluate(`document.querySelector('[data-testid="stats-card"]').scrollIntoView({ block: 'center' })`);
      await waitStatsPoints(7);
      assert(await page.isVisible(sel('stats-card')), '趋势卡 stats-card 可见');
      assert(await page.isVisible(sel('stats-chart')), '趋势图 stats-chart 可见');
      assert(await page.isVisible(sel('stats-summary')), '趋势汇总 stats-summary 可见');
      const cardOrder = await page.evaluate(`(() => {
        const summary = document.querySelector('[data-testid="today-summary"]');
        const stats = document.querySelector('[data-testid="stats-card"]');
        const timeline = document.querySelector('[data-testid="history-list"]');
        const top = (el) => el.getBoundingClientRect().top;
        return { summary: top(summary), stats: top(stats), timeline: top(timeline) };
      })()`);
      assert(
        cardOrder.summary < cardOrder.stats && cardOrder.stats < cardOrder.timeline,
        '趋势卡位于「今日汇总」之后、「记录时间线」之前',
        `summary=${Math.round(cardOrder.summary)} stats=${Math.round(cardOrder.stats)} timeline=${Math.round(cardOrder.timeline)}`,
      );
      assertEqual(await page.attr(sel('stats-range-7'), 'aria-pressed'), 'true', '默认选中 7 天范围');
      assertEqual(await page.attr(sel('stats-range-30'), 'aria-pressed'), 'false', '30 天范围默认未选中');
      const svgInfo = await page.evaluate(`(() => {
        const chart = document.querySelector('[data-testid="stats-chart"]');
        const svg = chart.querySelector('svg');
        return { svgCount: chart.querySelectorAll('svg').length, canvasCount: chart.querySelectorAll('canvas').length, role: chart.getAttribute('role'), aria: chart.getAttribute('aria-label') };
      })()`);
      assertEqual(svgInfo.svgCount, 1, '趋势图是内联 SVG（恰好 1 个 <svg>）');
      assertEqual(svgInfo.canvasCount, 0, '趋势图不依赖 canvas');
      assertEqual(svgInfo.role, 'img', '趋势图容器 role="img"（无障碍）');
      assertEqual(svgInfo.aria, '最近 7 天奶量趋势', '趋势图 aria-label 概括当前范围与指标');

      // 触控目标尺寸（契约 §6 保留 v1「≥48px 点击区」；项目既有 e2e 标准为 ≥44px）
      const statsTargets = await page.evaluate(`(() => {
        const items = [
          ['stats-range-7', '[data-testid="stats-range-7"]'],
          ['stats-range-30', '[data-testid="stats-range-30"]'],
          ...['totalMl', 'feedCount', 'breastDirectCount', 'peeCount', 'poopCount', 'bathCount'].map((key) => [
            'stats-metric-' + key,
            '[data-testid="stats-metric-' + key + '"]',
          ]),
        ];
        return items.map(([name, selector]) => {
          const el = document.querySelector(selector);
          if (!el) return { name, missing: true };
          const rect = el.getBoundingClientRect();
          return { name, width: rect.width, height: rect.height };
        });
      })()`);
      assert(
        statsTargets.length === 8 && statsTargets.every((item) => !item.missing && item.width > 1 && item.height > 1),
        '趋势卡 8 个范围/指标按钮全部存在且可测量',
        statsTargets.map((item) => item.name).join(', '),
      );
      const smallStatsTargets = statsTargets.filter((item) => Math.min(item.width, item.height) < 44);
      if (smallStatsTargets.length === 0) {
        assert(true, '趋势卡可点击控件均 ≥44px（触控友好）');
      } else {
        note(
          '趋势卡部分可点击控件 < 44px（P2 可触控性）',
          `${smallStatsTargets.map((item) => `${item.name} ${Math.round(item.width)}×${Math.round(item.height)}px`).join('；')}；契约 §6 保留 v1「≥48px 点击区」的约束，项目 e2e 既有标准为 ≥44px，建议统一提升到 44–48px`,
        );
      }

      let snap7 = await pageStatsSnapshot();
      assertEqual(snap7.circles, 7, '7 天视图折线数据点 = 7');
      assertEqual(snap7.lineSegments, 7, '7 天视图折线由 7 个数据点连成（M + 6×L）');
      if (snap7.polyline === 0) {
        note(
          '折线实现为 SVG <path> 而非 <polyline>',
          'CONTRACT §6.4 只要求「折线 + 面积渐变 + 数据点」；web 用 <path>（L 段）+ <circle> 实现，数据点数量按 circle 断言，polyline=0 不是缺陷，仅为任务书措辞差异',
        );
      }
      assertEqual(snap7.gridLineCount, 3, 'Y 轴 3 条网格线');
      assertEqual(snap7.xLabels.length, 7, '7 天视图 X 轴显示全部 7 个日期');
      assertDeepEqual(snap7.xLabels, api7.daily.map((item) => item.date.slice(5)), '7 天 X 轴日期标签与 API daily 日期一致');
      assertEqual(snap7.valueLabels.length, 7, '7 天视图每个数据点都有数值标签');
      const totalMl7 = statsValuesNode(api7.daily, 'totalMl');
      assertDeepEqual(snap7.valueLabels, totalMl7.map((value) => String(value)), '7 天视图各点数值 = GET /api/stats.totalMl');
      assertEqual(
        snap7.summary,
        statsSummaryExpectedNode(api7.daily, 7, STATS_METRICS[0]),
        'stats-summary 文本 = 「7 天合计 X · 日均 Y · 最高 M（MM-DD）」且与 API 数据一致',
      );

      // 6 个指标逐个切换：数值 + 汇总与 API 对应字段一致（首末点显式对比）
      for (const metric of STATS_METRICS) {
        await page.clickTestId(`stats-metric-${metric.key}`);
        await page.waitForExpression(
          `document.querySelector('[data-testid="stats-chart"]').getAttribute('aria-label') === ${jsString(`最近 7 天${metric.label}趋势`)}`,
          { timeout: 4000, desc: `指标切换为 ${metric.label}` },
        );
        const metricSnap = await pageStatsSnapshot();
        const metricValues = statsValuesNode(api7.daily, metric.key);
        assertEqual(metricSnap.circles, 7, `${metric.label}：7 天视图数据点 = 7`);
        assertDeepEqual(
          metricSnap.valueLabels,
          metricValues.map((value) => String(value)),
          `${metric.label}：7 天各点数值与 GET /api/stats.${metric.key} 一致`,
        );
        assertEqual(metricSnap.valueLabels[0], String(metricValues[0]), `${metric.label}：图表首点 = API 第 1 天`);
        assertEqual(metricSnap.valueLabels[6], String(metricValues[6]), `${metric.label}：图表末点 = API 第 7 天（今天）`);
        assertEqual(
          metricSnap.summary,
          statsSummaryExpectedNode(api7.daily, 7, metric),
          `${metric.label}：stats-summary 合计/日均/最高与 API 数据一致`,
        );
        assertEqual(
          await page.attr(sel(`stats-metric-${metric.key}`), 'aria-pressed'),
          'true',
          `${metric.label}：指标按钮 aria-pressed=true`,
        );
      }

      // 30 天视图：30 个点、X 轴每 5 天一个标签、只标最高点、汇总与 API 一致
      await page.clickTestId('stats-metric-totalMl');
      await sleep(150);
      await page.clickTestId('stats-range-30');
      await waitStatsPoints(30);
      const snap30 = await pageStatsSnapshot();
      assertEqual(snap30.circles, 30, '30 天视图折线数据点 = 30');
      assertEqual(snap30.lineSegments, 30, '30 天视图折线由 30 个数据点连成');
      assertEqual(snap30.range30, 'true', '切换到 30 天后 aria-pressed 状态正确');
      assertEqual(snap30.aria, '最近 30 天奶量趋势', '30 天视图 aria-label 更新');
      const expected30X = api30.daily
        .filter((_item, index) => (api30.daily.length - 1 - index) % STATS_X_LABEL_EVERY === 0)
        .map((item) => item.date.slice(5));
      assertDeepEqual(snap30.xLabels, expected30X, `30 天视图 X 轴每 ${STATS_X_LABEL_EVERY} 天一个标签（最后一个是今天）`);
      assertEqual(snap30.xLabels.length, 6, '30 天视图 X 轴标签数量符合「每 5 天一个」（30 天窗口共 6 个）');
      assertEqual(snap30.xLabels[snap30.xLabels.length - 1], formatDayKeyNode(seedNow).slice(5), '30 天视图最后一个 X 标签是今天');
      assertEqual(snap30.valueLabels.length, 1, '30 天视图只标注最高点（1 个数值标签）');
      const totalMl30 = statsValuesNode(api30.daily, 'totalMl');
      assertEqual(snap30.valueLabels[0], String(Math.max(...totalMl30)), '30 天视图最高点数值 = API 30 天最大值');
      assertEqual(
        snap30.summary,
        statsSummaryExpectedNode(api30.daily, 30, STATS_METRICS[0]),
        '30 天视图 stats-summary 合计/日均/最高与 API 一致',
      );

      // 范围切换命中缓存：7↔30 重复切换不再发 /api/stats 请求（契约「切换范围时拉取并缓存」）
      const statsRequestCountBefore = page.countRequests(
        (request) => request.method === 'GET' && request.url.includes('/api/stats'),
      );
      await page.clickTestId('stats-range-7');
      await waitStatsPoints(7);
      await page.clickTestId('stats-range-30');
      await waitStatsPoints(30);
      await page.clickTestId('stats-range-7');
      await waitStatsPoints(7);
      await sleep(300);
      const statsRequestCountAfter = page.countRequests(
        (request) => request.method === 'GET' && request.url.includes('/api/stats'),
      );
      assertEqual(statsRequestCountAfter, statsRequestCountBefore, '7/30 天范围切换命中缓存，不重复请求 /api/stats');

      // 趋势卡可见时收到 SSE 变更 → 静默重拉当前范围（契约 §6.4）
      await page.clickTestId('stats-metric-bathCount');
      await sleep(200);
      const bathBeforeStatsSse = await pageStatsSnapshot();
      const bathValsBeforeSse = statsValuesNode(api7.daily, 'bathCount');
      assertDeepEqual(
        bathBeforeStatsSse.valueLabels,
        bathValsBeforeSse.map((value) => String(value)),
        '洗澡指标：SSE 前 7 天各点与 API 一致',
      );
      const sseStatsSince = page.responses.length;
      const sseBathForStats = await seedBath();
      assertEqual(sseBathForStats.status, 201, '趋势卡 SSE 重拉：第二客户端记录洗澡 → 201');
      const statsRefetch = await page.waitForResponse(
        (response) => response.method === 'GET' && response.path === '/api/stats' && response.url.includes('days=7'),
        { since: sseStatsSince, timeout: 8000 },
      );
      assertEqual(statsRefetch.status, 200, '趋势卡可见时收到洗澡 SSE → 自动重拉 GET /api/stats?days=7');
      await sleep(400);
      const bathAfterStatsSse = await pageStatsSnapshot();
      assertEqual(
        bathAfterStatsSse.valueLabels[6],
        String(bathValsBeforeSse[6] + 1),
        'SSE 静默重拉后洗澡指标末点（今天）+1',
      );
      const api7AfterStatsSse = (await api.stats(7, tzOffset)).data;
      assertEqual(
        bathAfterStatsSse.summary,
        statsSummaryExpectedNode(api7AfterStatsSse.daily, 7, STATS_METRICS[5]),
        'SSE 静默重拉后洗澡汇总与最新 API 数据一致',
      );
      // 清理这条 SSE 数据 → 趋势卡再次静默重拉并恢复
      const sseDeleteSince = page.responses.length;
      const sseBathDelete = await api.deleteEvent(sseBathForStats.data.event.id);
      assertEqual(sseBathDelete.status, 204, '清理趋势 SSE 测试洗澡记录 → 204');
      await page.waitForResponse(
        (response) => response.method === 'GET' && response.path === '/api/stats' && response.url.includes('days=7'),
        { since: sseDeleteSince, timeout: 8000 },
      );
      await sleep(400);
      const bathAfterStatsDelete = await pageStatsSnapshot();
      assertEqual(
        bathAfterStatsDelete.valueLabels[6],
        String(bathValsBeforeSse[6]),
        '删除洗澡后趋势卡 7 天末点静默恢复',
      );

      // 回到 7 天 / 奶量，截图（浅色 + 深色）
      await page.clickTestId('stats-range-7');
      await waitStatsPoints(7);
      await page.clickTestId('stats-metric-totalMl');
      await sleep(200);
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(250);
      const lightChart = await page.evaluate(`(() => {
        const chart = document.querySelector('[data-testid="stats-chart"]');
        const line = chart.querySelector('.stats-line');
        const label = chart.querySelector('.stats-axis-label');
        return { lineStroke: getComputedStyle(line).stroke, labelFill: getComputedStyle(label).fill, bodyBg: getComputedStyle(document.body).backgroundColor };
      })()`);
      await page.screenshotOf(sel('stats-card'), 'stats-390.png');
      await page.emulateMedia({ colorScheme: 'dark' });
      await sleep(350);
      const darkChart = await page.evaluate(`(() => {
        const chart = document.querySelector('[data-testid="stats-chart"]');
        const line = chart.querySelector('.stats-line');
        const label = chart.querySelector('.stats-axis-label');
        return { lineStroke: getComputedStyle(line).stroke, labelFill: getComputedStyle(label).fill, bodyBg: getComputedStyle(document.body).backgroundColor };
      })()`);
      assert(lightChart.bodyBg !== darkChart.bodyBg, '深色模式背景色切换', `${lightChart.bodyBg} → ${darkChart.bodyBg}`);
      assert(lightChart.lineStroke !== darkChart.lineStroke, '深色模式趋势折线颜色随主题切换', `${lightChart.lineStroke} → ${darkChart.lineStroke}`);
      assert(lightChart.labelFill !== darkChart.labelFill, '深色模式坐标轴标签颜色随主题切换', `${lightChart.labelFill} → ${darkChart.labelFill}`);
      await page.screenshotOf(sel('stats-card'), 'stats-dark-390.png');
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(250);

      // 响应式：320 / 390 / 900 无横向滚动，SVG 宽度随容器自适应
      for (const [viewport, label] of [
        [VIEWPORT_NARROW, '320×640'],
        [VIEWPORT_MOBILE, '390×844'],
        [VIEWPORT_DESKTOP, '900×900'],
      ]) {
        await page.setViewport(viewport);
        await sleep(350);
        const metrics = await page.evaluate(`(() => {
          const chart = document.querySelector('[data-testid="stats-chart"]');
          const svg = chart.querySelector('svg');
          const card = document.querySelector('[data-testid="stats-card"]');
          const cardRect = card.getBoundingClientRect();
          const chartRect = chart.getBoundingClientRect();
          const metricRects = [...document.querySelectorAll('.stats-metric')].map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right };
          });
          return {
            innerWidth: window.innerWidth,
            docScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            chartWidth: chart.clientWidth,
            svgWidth: Number(svg.getAttribute('width')),
            cardRight: cardRect.right,
            chartRight: chartRect.right,
            metricOverflow: metricRects.filter((rect) => rect.left < -0.5 || rect.right > window.innerWidth + 0.5).length,
          };
        })()`);
        assert(
          metrics.docScrollWidth <= metrics.innerWidth && metrics.bodyScrollWidth <= metrics.innerWidth,
          `${label}：趋势卡存在时页面无横向滚动`,
          `doc=${metrics.docScrollWidth} body=${metrics.bodyScrollWidth} ≤ ${metrics.innerWidth}`,
        );
        assertEqual(metrics.svgWidth, Math.max(236, Math.round(metrics.chartWidth)), `${label}：SVG 宽度随容器自适应`);
        assert(metrics.chartRight <= metrics.innerWidth + 0.5, `${label}：趋势图位于视口内`, `chartRight=${Math.round(metrics.chartRight)} / ${metrics.innerWidth}`);
        assertEqual(metrics.metricOverflow, 0, `${label}：6 个指标 chips 均不溢出视口`);
      }
      await page.setViewport(VIEWPORT_MOBILE);
      await sleep(250);
      await page.evaluate(`document.querySelector('[data-testid="stats-card"]').scrollIntoView({ block: 'center' })`);
      await sleep(250);

      // 空状态：清库 + 手动刷新 → 「最近 N 天还没有数据」，仍画 0 基线
      const clearedForEmpty = await deleteAllEvents();
      assertEqual(clearedForEmpty.deleted, clearedForEmpty.total, '清空趋势数据（验证空状态）');
      const refreshSince = page.responses.length;
      await page.clickTestId('refresh');
      await page.waitForResponse((response) => response.method === 'GET' && response.path === '/api/state', { since: refreshSince });
      const empty7 = await page.waitForText(sel('stats-chart'), '最近 7 天还没有数据', {
        timeout: 10_000,
        desc: '空数据趋势卡提示',
      });
      assertIncludes(empty7, '最近 7 天还没有数据', '全 0 时显示「最近 7 天还没有数据」');
      const emptySnap = await pageStatsSnapshot();
      assertEqual(emptySnap.circles, 7, '空数据仍画 7 天 0 基线（7 个数据点）');
      assertDeepEqual(emptySnap.valueLabels, ['0', '0', '0', '0', '0', '0', '0'], '空数据 7 天每个点数值标签为 0');
      assertEqual(
        emptySnap.summary,
        statsSummaryExpectedNode(api7.daily.map((item) => ({ ...item, totalMl: 0 })), 7, STATS_METRICS[0]),
        '空数据汇总显示 7 天合计 0 ml / 日均 0 ml / 最高 0 ml',
      );
      await page.clickTestId('stats-range-30');
      await waitStatsPoints(30);
      const empty30 = await page.waitForText(sel('stats-chart'), '最近 30 天还没有数据', {
        timeout: 8000,
        desc: '空数据 30 天视图提示',
      });
      assertIncludes(empty30, '最近 30 天还没有数据', '空数据切 30 天显示「最近 30 天还没有数据」');
      await page.clickTestId('stats-range-7');
      await waitStatsPoints(7);
    });

    /* ------------------------------------------------ G19 控制台 / 网络 / 静态资源 */
    await runGroup('G19', '控制台错误 / 未捕获异常 / 4xx-5xx / 静态资源 / CORS 预检', async () => {
      assertEqual(page.consoleErrors.length, 0, '页面 console.error 为空（预期内故障注入除外）', page.consoleErrors.map((item) => item.text).join(' | ') || '无');
      assertEqual(page.exceptions.length, 0, '页面未捕获异常为空', page.exceptions.map((item) => item.text).join(' | ') || '无');
      assertEqual(page.logErrors.length, 0, 'Log.entryAdded error 为空', page.logErrors.map((item) => `${item.source}: ${item.text}`).join(' | ') || '无');
      assertEqual(page.requestFailures.length, 0, '网络请求失败（非 cancel）为空', page.requestFailures.map((item) => `${item.method} ${item.url} ${item.errorText}`).join(' | ') || '无');
      const httpErrors = page.responses.filter((response) => response.status >= 400);
      assertEqual(httpErrors.length, 0, '浏览器网络响应无 4xx/5xx', httpErrors.map((item) => `${item.method} ${item.path} → ${item.status}`).join(' | ') || '无');
      assertEqual(page.responses.filter((response) => response.status === 404).length, 0, '无 404（静态资源全部命中）');

      for (const [label, assetPath] of [
        ['HTML 文档', '/'],
        ['app.css', '/app.css'],
        ['app.js', '/app.js'],
        ['config.js', '/config.js'],
        ['lib/format.js', '/lib/format.js'],
        ['lib/api.js', '/lib/api.js'],
        ['icon.svg', '/icon.svg'],
        ['manifest.webmanifest', '/manifest.webmanifest'],
      ]) {
        const hit = page.responses.find(
          (response) => response.path === assetPath && response.status === 200 && originOf(response.url) === apiBase,
        );
        assert(Boolean(hit), `同源 ${label} 真实网络请求 → 200`, hit ? `${hit.method} ${hit.path} ${hit.status} ${hit.mimeType}` : '未捕获 200');
      }
      const crossAssets = ['/app.css', '/app.js', '/config.js', '/lib/api.js', '/lib/format.js'];
      for (const assetPath of crossAssets) {
        const hit = page.responses.find(
          (response) => response.path === assetPath && response.status === 200 && originOf(response.url) === webBase,
        );
        assert(Boolean(hit), `跨源独立服务 ${assetPath} → 200`, hit ? `${hit.status} ${hit.mimeType}` : '未捕获 200');
      }
      const allowedOrigins = new Set([apiBase, webBase]);
      const external = [...page.requests.values()].filter((request) => {
        try {
          const url = new URL(request.url);
          if (['data:', 'blob:', 'about:'].includes(url.protocol)) return false;
          return !allowedOrigins.has(url.origin);
        } catch {
          return false;
        }
      });
      assertEqual(external.length, 0, '页面只请求了本地 API / 独立 web，无外部 CDN', external.map((item) => item.url).join(' | ') || '无');
      const documentResponses = page.responses.filter((response) => response.type === 'Document' && response.status === 200);
      assert(documentResponses.length >= 2, '全部文档导航均 200（含跨源页面）', `${documentResponses.length} 次`);
      assertEqual(page.dialogs.length, 1, '全程只出现 1 次原生对话框（删除确认，已被脚本 accept）', page.dialogs.map((item) => item.type).join(', '));
      const preflights = page.responses.filter((response) => response.method === 'OPTIONS');
      assert(preflights.length >= 1, '跨源 POST 触发过 OPTIONS 预检', `${preflights.length} 次`);
      assert(preflights.every((response) => response.status === 204 && response.headers['access-control-allow-origin'] === '*'), '所有 OPTIONS 预检 204 且带 CORS 头');
      assert(!cliLogsRef.join('\n').includes('未捕获错误'), '主 server 日志无未捕获错误');
      assert(!webLogsRef.join('\n').includes('静态服务出错'), '独立 web 服务日志无未捕获错误');
      assert(expectedIssues.length >= 6, '故障注入产生的预期错误已单独标记（未混入失败项）', `${expectedIssues.length} 条`);
    });

    /* ------------------------------------------------ G20 截图产物完整性 */
    await runGroup('G20', '截图产物完整性（docs/screenshots/）', async () => {
      const expectedDims = {
        'mobile-390.png': [780, 1688],
        'mobile-390-after-record.png': [780, 1688],
        'mobile-320.png': [640, 1280],
        'desktop-900.png': [1800, 1800],
        'dark-390.png': [780, 1688],
        'empty-390.png': [780, 1688],
        'multi-select-390.png': [780, 1688],
        'cross-origin-390.png': [780, 1688],
        'stats-390.png': [780, 1688],
        'stats-dark-390.png': [780, 1688],
        'bath-390.png': [780, 1688],
      };
      for (const name of shotNames) {
        const file = path.join(SHOT_DIR, name);
        let buffer = null;
        try {
          buffer = await readFile(file);
        } catch {
          assert(false, `截图 ${name} 存在`, '文件不存在');
          continue;
        }
        const info = pngSize(buffer);
        assert(info.png && info.width > 0, `截图 ${name} 是有效 PNG`, `${info.width}×${info.height} ${(buffer.length / 1024).toFixed(1)}KB`);
        assert(buffer.length > 8 * 1024, `截图 ${name} 非空白（>8KB）`, `${(buffer.length / 1024).toFixed(1)}KB`);
        const expected = expectedDims[name];
        if (expected) {
          assertEqual(info.width, expected[0], `${name} 宽度符合 2x 设备像素比`);
          assertEqual(info.height, expected[1], `${name} 高度符合视口`);
        }
      }
      const full = screenshots.find((shot) => shot.name === 'mobile-390-full.png');
      assert(Boolean(full) && full.width === 780 && full.height > 1600, 'mobile-390-full.png 为整页长截图', full ? `${full.width}×${full.height}` : '未生成');
      const errorShot = path.join(SHOT_DIR, 'error-390.png');
      try {
        const errorBuffer = await readFile(errorShot);
        assert(pngSize(errorBuffer).width === 780, '附加 error-390.png 已生成（加载失败态证据）');
      } catch {
        assert(false, '附加 error-390.png 已生成', '文件不存在');
      }
    });
  } finally {
    await cleanup();
  }

  printSummary();
}

/** 深度相等断言（JSON 可序列化值） */
function assertDeepEqual(actual, expected, name) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  return assert(left === right, name, left === right ? `= ${right}` : `期望 ${right}，实际 ${left}`);
}
/* ========================================================================== *
 * 9. 测试辅助（需在 main 内联定义前后的函数）
 * ========================================================================== */

async function ensureEnvironment() {
  try {
    await access(CHROME_BIN);
  } catch {
    throw new Error(`找不到 Chrome 可执行文件：${CHROME_BIN}（可用 CHROME_BIN 环境变量覆盖）`);
  }
  const required = [
    [SERVER_ENTRY, 'server 入口'],
    [WEB_DIR, 'web 目录'],
    [SERVE_WEB_SCRIPT, 'scripts/serve-web.mjs'],
    [CLI_ENTRY, 'CLI 入口 cli/bin/naiji.mjs'],
    [CLI_LAUNCHER, 'CLI 启动器 cli/bin/naiji'],
    [QA_REPORT_V1, '归档的 v1 QA 报告'],
  ];
  for (const [target, label] of required) {
    try {
      await access(target);
    } catch {
      throw new Error(`找不到${label}：${target}`);
    }
  }
}

async function cleanup() {
  console.log('\n── 清理 ───────────────────────────────────────');
  try {
    page?.cdp?.close();
  } catch {
    /* ignore */
  }
  page = null;
  try {
    await stopProcess(chromeProcess, 'chrome');
    console.log('  ✓ Chrome 已退出');
  } catch (error) {
    console.log(`  ⚠ Chrome 清理异常：${error.message}`);
  }
  try {
    await stopProcess(webServerProcess, 'web');
    console.log('  ✓ 独立静态服务已退出');
  } catch (error) {
    console.log(`  ⚠ 静态服务清理异常：${error.message}`);
  }
  for (const extra of extraServerProcesses) {
    try {
      await stopProcess(extra.child ?? extra, 'server');
    } catch {
      /* ignore */
    }
  }
  if (extraServerProcesses.length > 0) {
    console.log(`  ✓ 额外测试服务已退出（${extraServerProcesses.length} 个）`);
    extraServerProcesses.length = 0;
  }
  try {
    await stopProcess(serverProcess, 'server');
    console.log('  ✓ 测试服务已退出');
  } catch (error) {
    console.log(`  ⚠ 服务清理异常：${error.message}`);
  }
  if (tmpDir && !KEEP_ARTIFACTS) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
      console.log('  ✓ 临时目录已删除');
    } catch (error) {
      console.log(`  ⚠ 临时目录删除失败：${error.message}`);
    }
  } else if (tmpDir) {
    console.log(`  ⓘ 保留临时目录：${tmpDir}`);
  }
}

function printSummary() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  结果汇总');
  console.log('══════════════════════════════════════════════════════════════');
  let total = 0;
  let passed = 0;
  for (const group of groups) {
    const failed = group.rows.filter((row) => !row.ok).length;
    total += group.rows.length;
    passed += group.rows.length - failed;
    const flag = failed === 0 ? '✓' : '✗';
    console.log(
      `  ${flag} ${group.id} ${group.title.padEnd(20, ' ')} ${String(group.rows.length - failed).padStart(2)}/${String(
        group.rows.length,
      ).padStart(2)} PASS${group.durationMs !== undefined ? `  (${group.durationMs}ms)` : ''}`,
    );
  }
  console.log('  ─────────────────────────────────────────────');
  console.log(`  断言总数 ${total}：PASS ${passed} / FAIL ${total - passed}`);
  if (failures.length > 0) {
    console.log('\n  失败明细：');
    for (const failure of failures) console.log(`  ✗ [${failure.group}] ${failure.name} — ${failure.evidence}`);
  }
  if (observations.length > 0) {
    console.log('\n  观察项（不计入 PASS/FAIL）：');
    for (const item of observations) console.log(`  ⚠ ${item.name} — ${item.detail}`);
  }
  if (expectedIssues.length > 0) {
    console.log('\n  故障注入预期错误（已精确记录，不计失败）：');
    for (const item of expectedIssues) console.log(`  ⓘ ${item.kind}: ${item.text.slice(0, 200)}`);
  }
  console.log('\n  截图产物：');
  for (const shot of screenshots) {
    console.log(`  📸 docs/screenshots/${shot.name}  ${shot.width}×${shot.height}  ${(shot.bytes / 1024).toFixed(1)}KB`);
  }
  // 断言明细指纹：只含 group / 断言名 / 结果，不含耗时、端口、时间等易变证据，
  // 用于验证「连跑 2 次明细一致」；E2E_MANIFEST=1 时额外打印逐条清单便于 diff。
  const manifest = groups.flatMap((group) =>
    group.rows.map((row) => `${group.id}|${row.name}|${row.ok ? 'PASS' : 'FAIL'}`),
  );
  const fingerprint = createHash('sha256').update(manifest.join('\n')).digest('hex');
  if (process.env.E2E_MANIFEST === '1') {
    console.log('\n  断言明细清单（group|name|result）：');
    for (const line of manifest) console.log(`  ${line}`);
  }
  console.log(`\n  明细指纹 sha256=${fingerprint}`);
  console.log(`  明细条数 ${manifest.length}`);
  console.log(`\n  总体结果：${failures.length === 0 ? 'PASS（exit 0）' : `FAIL ${failures.length} 项（exit 1）`}`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exitCode = failures.length === 0 ? 0 : 1;
}

/* ========================================================================== *
 * 10. 入口
 * ========================================================================== */

main()
  .then(async () => {
    if (setupError) {
      console.error(setupError);
      process.exitCode = 1;
    }
    await sleep(50);
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (error) => {
    console.error('\n[致命错误] 端到端脚本失败：');
    console.error(error && error.stack ? error.stack : error);
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    printSummary();
    process.exit(1);
  });
