#!/usr/bin/env node
/**
 * 奶记 · 婴儿喂养记录 — 浏览器端到端 QA 脚本（零第三方依赖）
 *
 * 真正拉起产品：
 *   1. 用 CLI 启动 `node src/server.js`（随机空闲端口 + 临时目录 SQLite）；
 *   2. 启动系统 headless Chrome（--remote-debugging-port=0）；
 *   3. 用 Node 内置 WebSocket 走 Chrome DevTools Protocol 驱动真实页面：
 *      真实鼠标点击、真实输入、真实确认弹窗、真实网络请求；
 *   4. 断言 → 截图到 docs/screenshots/ → 清理 Chrome / 服务 / 临时目录；
 *   5. 全部通过 exit 0，有失败 exit 1。脚本可重复执行（每次独立 DB / 端口 / 浏览器 profile）。
 *
 * 用法：
 *   /path/to/node scripts/browser-e2e.mjs
 *   KEEP_ARTIFACTS=1 ...        # 保留临时目录（调试用）
 *
 * 覆盖 docs/CONTRACT.md 第 8 节验收清单，以及任务书中的 16 组端到端检查。
 * 本脚本只读产品代码，不修改 src/ public/ test/。
 */

import { spawn } from 'node:child_process';
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
const SERVER_ENTRY = path.join(ROOT, 'src', 'server.js');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');

const NODE_BIN = process.env.NODE_BIN || process.execPath;
const CHROME_BIN = process.env.CHROME_BIN || '/etc/profiles/per-user/nykma/bin/google-chrome';
const KEEP_ARTIFACTS = process.env.KEEP_ARTIFACTS === '1';

const VIEWPORT_MOBILE = { width: 390, height: 844, dsf: 2, mobile: true };
const VIEWPORT_NARROW = { width: 320, height: 640, dsf: 2, mobile: true };
const VIEWPORT_DESKTOP = { width: 900, height: 900, dsf: 2, mobile: false };

const GAP_FORMAT_RE = /^(刚刚|\d+ 分钟|\d+ 小时( \d+ 分钟)?|\d+ 天( \d+ 小时)?)$/;
const FEED_LABELS = { formula: '奶粉', breast_milk: '母乳（瓶喂）', breast_direct: '亲喂' };
const DIAPER_LABELS = { pee: '小便', poop: '大便', mixed: '大小便' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tmpDir = null;
let serverProcess = null;
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

function launchServer({ port, dbPath }) {
  const child = spawn(NODE_BIN, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

function eventTitleNode(event) {
  if (!event) return '';
  if (event.kind === 'feed') {
    if (event.feedType === 'breast_direct') return '亲喂';
    const label = FEED_LABELS[event.feedType] ?? '喂奶';
    return event.amountMl === null || event.amountMl === undefined ? label : `${label} ${event.amountMl} ml`;
  }
  return DIAPER_LABELS[event.diaperKind] ?? '大小便';
}

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
 * 8. 测试主体
 * ========================================================================== */

let tzOffset = 0; // 浏览器时区偏移；与 /api/state 对齐用
let baseUrl = '';
let cliLogsRef = null;
const shotNames = [
  'mobile-390.png',
  'mobile-390-after-record.png',
  'mobile-390-full.png',
  'mobile-320.png',
  'desktop-900.png',
  'dark-390.png',
  'empty-390.png',
];

async function main() {
  await ensureEnvironment();
  await mkdir(SHOT_DIR, { recursive: true });

  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'naiji-e2e-'));
  const dbPath = path.join(tmpDir, 'qa.db');
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  api = new ApiClient(baseUrl);

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  奶记 · 浏览器端到端 QA');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Node      : ${process.version} (${NODE_BIN})`);
  console.log(`  项目根    : ${ROOT}`);
  console.log(`  临时 DB   : ${dbPath}`);
  console.log(`  服务端口  : ${port} (CLI 启动: node src/server.js)`);
  console.log(`  截图目录  : ${path.relative(ROOT, SHOT_DIR)}/`);
  console.log('');

  const serverLaunch = launchServer({ port, dbPath });
  serverProcess = serverLaunch.child;
  cliLogsRef = serverLaunch.logLines;

  try {
    const health = await waitHealth(baseUrl);
    console.log(`  [server] CLI 启动完成，/api/health → ${JSON.stringify(health)}`);

    const chrome = await launchChrome(path.join(tmpDir, 'chrome-profile'));
    console.log(`  [chrome] ${chrome.version}（CDP 端口 ${chrome.port}）`);
    browserVersion = chrome.version;

    page = new PageClient(chrome.cdp);
    await page.enable();
    await page.setViewport(VIEWPORT_MOBILE);
    await page.navigate(`${baseUrl}/`);
    tzOffset = await page.evaluate('new Date().getTimezoneOffset()');
    console.log(`  [browser] 首屏加载完成，时区偏移 tzOffset=${tzOffset}`);
    console.log('');

    /* ------------------------------------------------ G00 环境与启动 */
    await runGroup('G00', '环境与启动（真实 CLI 入口）', async () => {
      const versionParts = process.version.replace(/^v/, '').split('.').map(Number);
      assert(
        versionParts[0] > 22 || (versionParts[0] === 22 && (versionParts[1] > 13 || (versionParts[1] === 13 && versionParts[2] >= 0))),
        'Node 版本满足 engines >= 22.13.0',
        `当前 ${process.version}，sqlite 可用`,
      );
      assert(health?.ok === true, 'GET /api/health → 200 {ok:true}', JSON.stringify(health));
      const banner = cliLogsRef.join('\n');
      assertIncludes(banner, '奶记 · 婴儿喂养记录已启动', 'CLI 启动日志包含应用启动横幅（覆盖 node src/server.js 入口）');
      assertIncludes(banner, dbPath, 'CLI 使用 DB_PATH 指定的临时数据库');
      assertMatch(browserVersion, /^Chrome\/\d+\./, 'headless Chrome 就绪', browserVersion);
      let shotDirOk = true;
      try {
        await access(SHOT_DIR);
      } catch {
        shotDirOk = false;
      }
      assert(shotDirOk, '截图输出目录 docs/screenshots/ 存在', path.relative(ROOT, SHOT_DIR));
    });

    /* ------------------------------------------------ G01 首屏 + 刷新 */
    await runGroup('G01', '首屏 200 / 距离上次喂奶格式 / 秒级刷新', async () => {
      const docResponse = page.responses.find(
        (response) => response.type === 'Document' && response.path === '/' && response.status === 200,
      );
      assert(Boolean(docResponse), '首屏文档请求 GET / → 200', docResponse ? `${docResponse.method} ${docResponse.path} ${docResponse.status}` : '未捕获到 Document 200 响应');

      const gapInitial = await page.textOfTestId('gap-duration');
      assert(gapInitial !== null && gapInitial.length > 0, '首屏 gap-duration 文本非空（空库）', `"${gapInitial}"`);

      // 注入 now-90min 的喂奶记录，验证「1 小时 30 分钟」
      const seedRes = await api.createFeeding({
        feedType: 'formula',
        amountMl: 120,
        happenedAt: Date.now() - 90 * 60_000,
        note: 'QA 首屏种子',
      });
      assertEqual(seedRes.status, 201, 'API 注入 90 分钟前的喂奶按 120ml', JSON.stringify(seedRes.data?.event ?? seedRes.data));
      await page.reload();
      const gapText = await page.textOfTestId('gap-duration');
      assertNotIncludes(gapText, '正在加载', '刷新后 gap-duration 已渲染');
      assertMatch(gapText, GAP_FORMAT_RE, 'gap-duration 文案符合契约格式 (刚刚|N 分钟|H 小时 M 分钟|D 天 H 小时)');
      assertOneOf(gapText, ['1 小时 30 分钟', '1 小时 31 分钟'], 'H 小时 M 分钟 数值正确（约 90 分钟）');
      const lastFeedText = await page.textOfTestId('gap-last-feed');
      assertIncludes(lastFeedText, '上次', 'gap-last-feed 显示「上次 HH:mm · 项目」');
      assertIncludes(lastFeedText, '奶粉 120 ml', 'gap-last-feed 显示上次喂奶明细');

      // 截图：首屏（单条历史，Hero 1 小时 30 分钟）
      await page.screenshot('mobile-390.png');

      // 秒级刷新：注入 2 分 50 秒前的记录，观察 2 分钟 → 3 分钟
      const tickerSeed = await api.createFeeding({
        feedType: 'formula',
        amountMl: 60,
        happenedAt: Date.now() - (2 * 60_000 + 50_000),
      });
      assertEqual(tickerSeed.status, 201, 'API 注入用于验证秒级刷新的喂奶记录');
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
      } catch (error) {
        gapAfter = await page.textOfTestId('gap-duration');
      }
      assertEqual(gapAfter, '3 分钟', 'Hero 每秒自动刷新（2 分钟 → 3 分钟）', `等待 ${Date.now() - refreshStarted}ms 后 "${gapAfter}"`);
    });

    /* ------------------------------------------------ G02 一键记录 120ml */
    await runGroup('G02', '点 120ml 快捷按钮：toast / Hero / 今日汇总 / 时间线 / POST 201', async () => {
      const before = await api.state(tzOffset);
      const beforeCount = (await api.allEvents()).length;
      const totalBefore = before.today.totalMl;
      const responsesSince = page.responses.length;

      await page.clickTestId('volume-chip-120');
      const postResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/feedings',
        { since: responsesSince },
      );
      assertEqual(postResponse.status, 201, '网络请求 POST /api/feedings 返回 201', `捕获 ${postResponse.method} ${postResponse.path} → ${postResponse.status}`);

      const toastText = await page.waitForText(sel('toast'), '120', { desc: 'toast 出现且含 120' });
      assertIncludes(toastText, '已记录', 'toast 文案「已记录 奶粉 120 ml」', `"${toastText}"`);
      assertIncludes(toastText, '120', 'toast 含奶量 120');
      assert(await page.exists(sel('toast-undo')), 'toast 带「撤销」按钮（toast-undo）');
      const undoRect = await page.rect(sel('toast-undo'));
      assert(undoRect && undoRect.height >= 40, 'toast「撤销」按钮点击区域足够（≥40px 高）', undoRect ? `${Math.round(undoRect.width)}×${Math.round(undoRect.height)}px` : '未测量到');
      if (undoRect && undoRect.height < 44) note('toast「撤销」按钮高度略小于 44px', `${Math.round(undoRect.width)}×${Math.round(undoRect.height)}px（契约大按钮建议 48px；撤销有时限，可接受但可优化）`);

      const gapText = await page.waitForText(sel('gap-duration'), '刚刚', { desc: 'Hero 变「刚刚」' });
      assertEqual(gapText, '刚刚', 'Hero 立即归零为「刚刚」');

      await page.screenshot('mobile-390-after-record.png');

      const after = await api.state(tzOffset);
      assertEqual(after.today.totalMl, totalBefore + 120, '今日汇总 totalMl 增加 120（服务端数据）', `${totalBefore} → ${after.today.totalMl}`);
      const summaryText = await page.textOfTestId('today-summary');
      assertIncludes(summaryText, `${after.today.totalMl} ml`, '今日汇总条展示正确的累计奶量', `"${summaryText}"`);

      const titles = await page.evaluate(
        `[...document.querySelectorAll('[data-testid="history-list"] .event-title')].map((el) => el.textContent.trim())`,
      );
      assertEqual(titles[0], '奶粉 120 ml', '时间线首条为「奶粉 120 ml」', JSON.stringify(titles.slice(0, 3)));
      assertEqual((await api.allEvents()).length, beforeCount + 1, '服务端事件数 +1');
    });

    /* ------------------------------------------------ G03 撤销 */
    await runGroup('G03', 'toast 撤销：记录不残留', async () => {
      const eventsBeforeUndo = await api.allEvents();
      const created = eventsBeforeUndo[0];
      assert(Boolean(created), '撤销前服务端存在刚创建的最新记录', JSON.stringify(created));
      const countBefore = eventsBeforeUndo.length;
      const domCountBefore = await page.evaluate(
        `document.querySelectorAll('[data-testid="history-list"] .event').length`,
      );
      const responsesSince = page.responses.length;

      await page.clickTestId('toast-undo');
      const deleteResponse = await page.waitForResponse(
        (response) => response.method === 'DELETE' && /^\/api\/events\/\d+$/.test(response.path),
        { since: responsesSince },
      );
      assertEqual(deleteResponse.status, 204, '撤销调用 DELETE /api/events/:id → 204', `${deleteResponse.method} ${deleteResponse.path}`);

      const undoToast = await page.waitForText(sel('toast'), '已撤销', { desc: '撤销 toast' });
      assertIncludes(undoToast, '已撤销', '撤销后 toast 提示「已撤销」', `"${undoToast}"`);

      await page.waitHistoryCount(domCountBefore - 1);
      const eventsAfterUndo = await api.allEvents();
      assertEqual(eventsAfterUndo.length, countBefore - 1, '撤销后服务端事件数恢复');
      assert(
        !eventsAfterUndo.some((event) => event.id === created.id),
        '同一 happenedAt 的数据未残留（GET /api/events 中不存在该 id）',
        `已删除 id=${created.id}`,
      );
      const previousLastFeed = eventTitleNode(eventsAfterUndo.find((event) => event.kind === 'feed'));
      const gapLastFeed = await page.textOfTestId('gap-last-feed');
      assertIncludes(gapLastFeed, previousLastFeed, 'Hero 上次喂奶回退到上一条记录', `期望包含「${previousLastFeed}」`);
      assertMatch(await page.textOfTestId('gap-duration'), GAP_FORMAT_RE, '撤销后 Hero 时长仍为合法格式');
    });

    /* ------------------------------------------------ G04 母乳瓶喂 / 亲喂 */
    await runGroup('G04', '母乳（瓶喂）60ml / 亲喂（含类型记忆）', async () => {
      await page.clickTestId('type-breast-milk');
      assertEqual(await page.attr(sel('type-breast-milk'), 'aria-pressed'), 'true', '切到「母乳·瓶喂」后 aria-pressed=true');
      const hint = await page.text('.field-hint');
      assertIncludes(hint, '母乳（瓶喂）', '奶量区提示跟随类型变化', `"${hint}"`);

      const before = await api.state(tzOffset);
      const since = page.responses.length;
      await page.clickTestId('volume-chip-60');
      const postResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/feedings',
        { since },
      );
      assertEqual(postResponse.status, 201, '母乳（瓶喂）60ml POST → 201');
      const toast = await page.waitForText(sel('toast'), '母乳（瓶喂）', { desc: '母乳瓶喂 toast' });
      assertIncludes(toast, '60 ml', 'toast 显示「已记录 母乳（瓶喂） 60 ml」', `"${toast}"`);
      const after = await api.state(tzOffset);
      assertEqual(after.today.breastMl, before.today.breastMl + 60, '今日 breastMl 增加 60');
      const firstTitle = await page.evaluate(
        `document.querySelector('[data-testid="history-list"] .event-title')?.textContent.trim()`,
      );
      assertEqual(firstTitle, '母乳（瓶喂） 60 ml', '时间线首条为「母乳（瓶喂） 60 ml」');

      await page.clickTestId('type-breast-direct');
      assert(await page.isVisible(sel('record-breast-direct')), '切到「亲喂」后大按钮可见');
      assert(!(await page.isVisible(sel('volume-chip-120'))), '亲喂时奶量快捷按钮隐藏');
      const directBefore = await api.state(tzOffset);
      const directSince = page.responses.length;
      await page.clickTestId('record-breast-direct');
      const directResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/feedings',
        { since: directSince },
      );
      assertEqual(directResponse.status, 201, '亲喂 POST → 201');
      const directToast = await page.waitForText(sel('toast'), '亲喂', { desc: '亲喂 toast' });
      assertIncludes(directToast, '已记录 亲喂', 'toast 显示「已记录 亲喂」');
      const directAfter = await api.state(tzOffset);
      assertEqual(directAfter.today.breastDirectCount, directBefore.today.breastDirectCount + 1, '今日 breastDirectCount +1');
      assertEqual(
        await page.evaluate(`document.querySelector('[data-testid="history-list"] .event-title')?.textContent.trim()`),
        '亲喂',
        '时间线首条为「亲喂」',
      );
      const gapLast = await page.textOfTestId('gap-last-feed');
      assertIncludes(gapLast, '亲喂', 'Hero 上次喂奶更新为「亲喂」', `"${gapLast}"`);

      // 类型选择记忆（localStorage + 刷新后保持）
      assertEqual(
        await page.evaluate(`localStorage.getItem('naiji.feedType')`),
        'breast_direct',
        '喂奶类型选择写入 localStorage（naiji.feedType）',
      );
      await page.reload();
      assertEqual(await page.attr(sel('type-breast-direct'), 'aria-pressed'), 'true', '刷新后仍保持「亲喂」选中态（localStorage 记忆）');
      assert(await page.isVisible(sel('record-breast-direct')), '刷新后亲喂面板仍可见');
      await page.clickTestId('type-formula');
      assertEqual(await page.attr(sel('type-formula'), 'aria-pressed'), 'true', '切回「奶粉」');
    });

    /* ------------------------------------------------ G05 自定义奶量 */
    await runGroup('G05', '自定义奶量 999ml + 前端范围校验', async () => {
      const setValue = await page.setInputValue(sel('custom-amount-input'), '999');
      assertEqual(setValue, '999', '自定义输入框可输入 999');
      const before = await api.state(tzOffset);
      const since = page.responses.length;
      await page.clickTestId('custom-amount-submit');
      const postResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/feedings',
        { since },
      );
      assertEqual(postResponse.status, 201, '自定义 999ml POST → 201（合法范围 1–2000）');
      const toast = await page.waitForText(sel('toast'), '999', { desc: '999ml toast' });
      assertIncludes(toast, '已记录 奶粉 999 ml', 'toast 显示「已记录 奶粉 999 ml」', `"${toast}"`);
      const after = await api.state(tzOffset);
      assertEqual(after.today.formulaMl, before.today.formulaMl + 999, '今日 formulaMl 增加 999');
      assertEqual(
        await page.evaluate(`document.querySelector('[data-testid="history-list"] .event-title')?.textContent.trim()`),
        '奶粉 999 ml',
        '时间线首条为「奶粉 999 ml」',
      );

      // 非法值：前端拦截，不产生网络请求
      const postCountBefore = page.countRequests(
        (request) => request.method === 'POST' && request.url.includes('/api/feedings'),
      );
      await page.setInputValue(sel('custom-amount-input'), '2001');
      await page.clickTestId('custom-amount-submit');
      const errorToast = await page.waitForText(sel('toast'), '奶量必须是', { desc: '非法奶量错误 toast' });
      assertIncludes(errorToast, '1 到 2000', '超出范围时前端提示「奶量必须是 1 到 2000 之间的整数」', `"${errorToast}"`);
      await sleep(700);
      const postCountAfter = page.countRequests(
        (request) => request.method === 'POST' && request.url.includes('/api/feedings'),
      );
      assertEqual(postCountAfter, postCountBefore, '非法奶量被前端拦截，未发出 POST 请求');
    });

    /* ------------------------------------------------ G06 大小便 */
    await runGroup('G06', '小便 / 大便一键记录', async () => {
      const before = await api.state(tzOffset);
      const sincePee = page.responses.length;
      await page.clickTestId('record-pee');
      const peeResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/diapers',
        { since: sincePee },
      );
      assertEqual(peeResponse.status, 201, '小便 POST /api/diapers → 201');
      const peeToast = await page.waitForText(sel('toast'), '小便', { desc: '小便 toast' });
      assertIncludes(peeToast, '已记录 小便', '小便 toast 文案');
      const afterPee = await api.state(tzOffset);
      assertEqual(afterPee.today.peeCount, before.today.peeCount + 1, '今日 peeCount +1');
      assertEqual(
        await page.evaluate(`document.querySelector('[data-testid="history-list"] .event-title')?.textContent.trim()`),
        '小便',
        '时间线出现「小便」',
      );

      const sincePoop = page.responses.length;
      await page.clickTestId('record-poop');
      const poopResponse = await page.waitForResponse(
        (response) => response.method === 'POST' && response.path === '/api/diapers',
        { since: sincePoop },
      );
      assertEqual(poopResponse.status, 201, '大便 POST /api/diapers → 201');
      const poopToast = await page.waitForText(sel('toast'), '大便', { desc: '大便 toast' });
      assertIncludes(poopToast, '已记录 大便', '大便 toast 文案');
      const afterPoop = await api.state(tzOffset);
      assertEqual(afterPoop.today.poopCount, before.today.poopCount + 1, '今日 poopCount +1');
      const historyText = await page.textOfTestId('history-list');
      assertIncludes(historyText, '小便', '时间线包含「小便」');
      assertIncludes(historyText, '大便', '时间线包含「大便」');
    });

    /* ------------------------------------------------ G06b 连点防重复 */
    await runGroup('G06b', '连点防重复：请求进行中按钮禁用，只记录一次', async () => {
      const postCount = () =>
        page.countRequests((request) => request.method === 'POST' && request.url.includes('/api/feedings'));
      const beforePosts = postCount();
      const beforeEvents = (await api.allEvents()).length;

      // 用 Fetch 挂起第一次 POST，模拟慢网络，保证第二次连点发生在请求进行中
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
        const responseSince = page.responses.length;
        await dispatchClick();
        await sleep(120);
        const disabledDuring = await page.evaluate(
          `document.querySelector('[data-testid="volume-chip-90"]').disabled`,
        );
        assertEqual(disabledDuring, true, '请求进行中「90ml」按钮被禁用（防止连点）');
        await dispatchClick(); // 第二次连点：按钮已 disabled，浏览器不会再触发 click
        await sleep(150);
        assertEqual(page.heldRequestIds.length, 1, '挂起的 POST 请求只有 1 个（第二次点击未发起请求）', `held=${page.heldRequestIds.length}`);

        page.holdFeedingRequests = false;
        const held = [...page.heldRequestIds];
        page.heldRequestIds = [];
        for (const requestId of held) await page.cdp.send('Fetch.continueRequest', { requestId });
        const postResponse = await page.waitForResponse(
          (response) => response.method === 'POST' && response.path === '/api/feedings',
          { since: responseSince, timeout: 10_000 },
        );
        assertEqual(postResponse.status, 201, '放行后 POST /api/feedings → 201');
        const toast = await page.waitForText(sel('toast'), '90', { desc: '90ml 记录 toast' });
        assertIncludes(toast, '已记录 奶粉 90 ml', '连点后只出现一次成功 toast', `"${toast}"`);
        assertEqual(postCount() - beforePosts, 1, '快速连点两次只产生 1 次 POST 请求');
        assertEqual((await api.allEvents()).length, beforeEvents + 1, '服务端只新增 1 条记录');
      } finally {
        await page.cdp.send('Fetch.disable');
        page.holdFeedingRequests = false;
        page.heldRequestIds = [];
      }

      // 撤销清理，保持后续用例数据基线
      const deleteSince = page.responses.length;
      await page.clickTestId('toast-undo');
      await page.waitForResponse(
        (response) => response.method === 'DELETE' && /^\/api\/events\/\d+$/.test(response.path),
        { since: deleteSince },
      );
      await sleep(250);
      assertEqual((await api.allEvents()).length, beforeEvents, '撤销后事件数恢复（连点测试数据已清理）');
    });

    /* ------------------------------------------------ G07 删除（confirm） */
    await runGroup('G07', '时间线删除：window.confirm → DELETE → 服务端/UI 同步', async () => {
      const events = await api.allEvents();
      const target = events.find((event) => event.kind === 'feed' && event.amountMl === 999);
      assert(Boolean(target), '找到待删除的 999ml 记录', target ? `id=${target.id}` : '未找到');
      const countBefore = events.length;
      const selector = `li.event[data-event-id="${target.id}"] .event-delete`;
      assert(await page.exists(`li.event[data-event-id="${target.id}"]`), '该记录出现在时间线中', `li.event[data-event-id="${target.id}"]`);
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
      assertIncludes(deleteToast, '已删除这条记录', '删除成功 toast', `"${deleteToast}"`);

      await page.waitForGone(`li.event[data-event-id="${target.id}"]`, { timeout: 5000 });
      const eventsAfter = await api.allEvents();
      assertEqual(eventsAfter.length, countBefore - 1, '服务端事件数 -1');
      assert(!eventsAfter.some((event) => event.id === target.id), 'GET /api/events 中不再包含被删记录', `id=${target.id}`);

      // 删除的是最新一条喂奶 → Hero 应回退到上一条（refreshStateQuietly 校准）
      const latestFeed = eventsAfter.find((event) => event.kind === 'feed');
      const expectedTitle = eventTitleNode(latestFeed);
      const gapLastFeed = await page.waitForText(sel('gap-last-feed'), expectedTitle, {
        desc: `Hero 回退到「${expectedTitle}」`,
      });
      assertIncludes(gapLastFeed, expectedTitle, '删除后 Hero 上次喂奶回退正确', `"${gapLastFeed}"`);
    });

    /* ------------------------------------------------ G08 持久化 */
    await runGroup('G08', '刷新持久化（Page.reload）', async () => {
      const events = await api.allEvents();
      const total = events.length;
      const newestTitle = eventTitleNode(events[0]);
      const latestFeed = events.find((event) => event.kind === 'feed');
      const expectedGapLastFeed = eventTitleNode(latestFeed);
      const domCountBefore = await page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`);
      assertEqual(domCountBefore, Math.min(30, total), '刷新前时间线展示 min(30, 总数)', `${domCountBefore} 条 / 共 ${total}`);

      await page.reload();
      await page.waitHistoryCount(Math.min(30, total));
      assertEqual(
        await page.evaluate(`document.querySelector('[data-testid="history-list"] .event-title')?.textContent.trim()`),
        newestTitle,
        '刷新后时间线首条仍是最新记录',
        `期望「${newestTitle}」`,
      );
      assertMatch(
        await page.text('.event-time'),
        /^\d{2}:\d{2}$/,
        '时间线时间列格式为 HH:mm',
      );
      const gapLastFeed = await page.textOfTestId('gap-last-feed');
      assertIncludes(gapLastFeed, expectedGapLastFeed, '刷新后 Hero 上次喂奶仍正确', `"${gapLastFeed}"`);
      assertMatch(await page.textOfTestId('gap-duration'), GAP_FORMAT_RE, '刷新后 Hero 时长格式正确');
      assertEqual(await page.attr(sel('type-formula'), 'aria-pressed'), 'true', '刷新后喂奶类型选择被记忆（奶粉）');
      assert(await page.isVisible(sel('export-csv')), '刷新后导出 CSV 入口可见');

      await page.screenshot('mobile-390-full.png', { fullPage: true });
    });

    /* ------------------------------------------------ G09 加载更多 */
    await runGroup('G09', '加载更多：30 条首屏 → 游标翻页 → 全部展示 → 按钮隐藏', async () => {
      const seedBase = Date.now();
      let okCount = 0;
      for (let index = 0; index < 45; index += 1) {
        const happenedAt = seedBase - (2 + index) * 3_600_000 - (index % 11) * 60_000;
        let response;
        if (index % 4 === 0) {
          response = await api.createDiaper({ diaperKind: index % 8 === 0 ? 'poop' : 'mixed', happenedAt });
        } else {
          response = await api.createFeeding({ feedType: 'formula', amountMl: 60 + (index % 6) * 30, happenedAt });
        }
        if (response.status === 201) okCount += 1;
      }
      assertEqual(okCount, 45, 'API 造 45 条历史数据（不同 happenedAt）');
      const total = (await api.allEvents()).length;
      assert(total >= 40, '服务端累计记录数 ≥ 40', `${total} 条`);

      await page.reload();
      const firstScreenCount = await page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`);
      assertEqual(firstScreenCount, 30, '首屏只渲染最近 30 条');
      assert(await page.isVisible(sel('load-more')), '首屏底部出现「加载更多」');
      const dayLabels = await page.evaluate(`[...document.querySelectorAll('.day-label')].map((el) => el.textContent.trim())`);
      assert(dayLabels.length >= 2, '时间线按日期分组（跨天数据出现多个日期标题）', JSON.stringify(dayLabels.slice(0, 4)));
      assertIncludes(dayLabels.join(','), '今天', '时间线包含「今天」分组');

      const since = page.responses.length;
      await page.clickTestId('load-more');
      const pageResponse = await page.waitForResponse(
        (response) => response.method === 'GET' && response.path === '/api/events',
        { since },
      );
      assertEqual(pageResponse.status, 200, '加载更多 GET /api/events 游标翻页 → 200');
      await page.waitHistoryCount(total);
      assertEqual(
        await page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`),
        total,
        '翻页后时间线条数增加到全部记录',
        `${total} 条`,
      );
      const loadMoreVisible = await page.isVisible(sel('load-more'));
      assert(!loadMoreVisible, '无更多数据时「加载更多」按钮隐藏');
      const ids = await page.evaluate(
        `[...document.querySelectorAll('[data-testid="history-list"] .event')].map((el) => el.dataset.eventId)`,
      );
      assertEqual(new Set(ids).size, ids.length, '翻页后无重复渲染的记录', `DOM ${ids.length} 条 / 去重 ${new Set(ids).size} 条`);
      const countHint = await page.text('#historyCount');
      assertIncludes(countHint, String(total), '时间线标题显示已显示条数', `"${countHint}"`);
    });

    /* ------------------------------------------------ G10 CSV 导出 */
    await runGroup('G10', '导出 CSV：链接 / BOM / 中文项目名 / 记录数 / 转义', async () => {
      const exportHref = await page.attr(sel('export-csv'), 'href');
      const downloadAttr = await page.attr(sel('export-csv'), 'download');
      assert(exportHref !== null && exportHref.endsWith('/api/export.csv'), '导出入口是 <a href="/api/export.csv" download>', `href="${exportHref}"`);
      assert(downloadAttr !== null, '导出链接带 download 属性', `download=${JSON.stringify(downloadAttr)}`);

      // 造一条带逗号 / 引号的备注，验证 CSV 转义
      const trickyNote = '夜里,加"餐"';
      const noteRes = await api.createFeeding({ feedType: 'formula', amountMl: 30, note: trickyNote });
      assertEqual(noteRes.status, 201, 'API 造带特殊字符备注的记录', trickyNote);

      const csv = await api.exportCsv();
      const total = (await api.allEvents()).length;
      assertEqual(csv.status, 200, 'GET /api/export.csv → 200');
      assertIncludes(csv.headers.get('content-type'), 'text/csv', 'Content-Type 为 text/csv');
      assertIncludes(String(csv.headers.get('content-type')), 'charset=utf-8', 'Content-Type 带 charset=utf-8');
      const disposition = String(csv.headers.get('content-disposition'));
      assertMatch(disposition, /^attachment; filename="baby-milk-\d{4}-\d{2}-\d{2}\.csv"$/, 'Content-Disposition 文件名格式正确', disposition);
      assert(
        csv.buffer.length > 3 && csv.buffer[0] === 0xef && csv.buffer[1] === 0xbb && csv.buffer[2] === 0xbf,
        'CSV 带 UTF-8 BOM（Excel 打开不乱码）',
        `前 3 字节 ${[...csv.buffer.slice(0, 3)].map((b) => b.toString(16)).join(' ')}`,
      );
      const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
      assertEqual(lines[0], '时间,类别,项目,奶量(ml),备注', 'CSV 表头符合契约');
      assertEqual(lines.length, total + 1, 'CSV 记录数 = 全部事件数', `数据行 ${lines.length - 1} / 事件 ${total}`);
      const body = lines.slice(1).join('\n');
      for (const label of ['奶粉', '母乳（瓶喂）', '亲喂', '小便', '大便']) {
        assertIncludes(body, label, `CSV 含中文项目名「${label}」`);
      }
      const escapedLine = lines.find((line) => line.includes('夜里'));
      assert(Boolean(escapedLine), 'CSV 中找到带特殊字符备注的记录');
      assertIncludes(escapedLine ?? '', '"夜里,加""餐"""', 'CSV 对逗号 / 引号正确加引号转义', escapedLine ?? '');
      const times = lines.slice(1).map((line) => line.split(',')[0]);
      const sorted = [...times].sort();
      assert(times.join('|') === sorted.join('|'), 'CSV 数据按时间升序导出', `首行 ${times[0]} / 末行 ${times[times.length - 1]}`);
      assertMatch(times[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'CSV 时间列格式 YYYY-MM-DD HH:mm');
    });

    /* ------------------------------------------------ G11 加载失败 + 重试（FE 注意点 2） */
    await runGroup('G11', '首屏加载失败：错误提示 / 记录按钮禁用 → 重试恢复', async () => {
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
          disabledStates.length > 0 && disabledStates.every((item) => item.disabled === true),
          '加载失败时所有记录按钮禁用（直到重试成功）',
          disabledStates.map((item) => `${item.testid}:${item.disabled}`).join(', '),
        );
        const retryDisabled = await page.evaluate(`document.querySelector('[data-testid="retry-load"]').disabled`);
        assertEqual(retryDisabled, false, '「重试」按钮可点击');
        assertEqual(await page.textOfTestId('gap-last-feed'), '加载失败，请点上方「重试」', 'Hero 提示加载失败');
        const failedChipStyle = await chipStyleOf();
        if (JSON.stringify(normalChipStyle) === JSON.stringify(failedChipStyle)) {
          note(
            '加载失败时记录按钮视觉无禁用反馈（P2）',
            `disabled=true 但外观与正常态完全一致：${JSON.stringify(failedChipStyle)}；建议补 .record-btn:disabled { opacity:.55; cursor:not-allowed }`,
          );
        } else {
          assert(true, '加载失败时记录按钮有可感知的禁用视觉反馈', JSON.stringify(failedChipStyle));
        }
        await page.screenshot('error-390.png');
        await sleep(250); // 等浏览器把网络错误日志吐完
        page.expectedWindow = null;
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
      const retryState = await page.evaluate(
        `[...document.querySelectorAll('.record-btn')].some((el) => el.disabled)`,
      );
      assertEqual(retryState, false, '重试成功后记录按钮全部恢复可用');
      assert(await page.isVisible(sel('today-summary')), '重试后今日汇总可见');

      // 记录失败路径：网络错误 → 错误 toast 显示后端 message，且不产生记录
      page.expectedWindow = { reason: '注入 POST /api/feedings 网络失败' };
      page.failPostRequests = true;
      await page.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/feedings*', requestStage: 'Request' }] });
      try {
        const beforeFailed = (await api.allEvents()).length;
        await page.clickTestId('volume-chip-30');
        const failToast = await page.waitForText(sel('toast'), '网络连接失败', { timeout: 8000, desc: '记录失败错误 toast' });
        assertIncludes(failToast, '网络连接失败，请检查服务是否正常运行', '记录失败 toast 显示后端 message', `"${failToast}"`);
        assertEqual(
          await page.evaluate(`document.querySelector('[data-testid="toast"]')?.classList.contains('toast--error')`),
          true,
          '失败 toast 使用错误样式（toast--error）',
        );
        await sleep(600);
        assertEqual((await api.allEvents()).length, beforeFailed, '失败的记录请求没有产生服务端数据');
        const disabledAfterFailure = await page.evaluate(
          `[...document.querySelectorAll('.record-btn')].filter((el) => el.disabled).length`,
        );
        assertEqual(disabledAfterFailure, 0, '记录失败后按钮恢复可用（不会卡在禁用态）');
      } finally {
        await page.cdp.send('Fetch.disable');
        page.failPostRequests = false;
        page.expectedWindow = null;
      }

      assert(expectedIssues.length > 0, '故障注入期间的预期错误已精确记录（不计失败）', `${expectedIssues.length} 条`);
    });

    /* ------------------------------------------------ G12 响应式 / 点击区 */
    await runGroup('G12', '320 / 390 / 900 视口：无横向滚动 + 点击区 ≥ 44px + 按钮不重叠', async () => {
      const measure = async (viewport, label) => {
        await page.setViewport(viewport);
        await sleep(250);
        const metrics = await page.evaluate(`({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          docClientWidth: document.documentElement.clientWidth,
        })`);
        assert(
          metrics.docScrollWidth <= metrics.innerWidth,
          `${label}：documentElement.scrollWidth ≤ innerWidth（无横向滚动）`,
          `scrollWidth=${metrics.docScrollWidth} ≤ innerWidth=${metrics.innerWidth}`,
        );
        assert(
          metrics.bodyScrollWidth <= metrics.innerWidth,
          `${label}：body.scrollWidth ≤ innerWidth（内容不溢出）`,
          `body=${metrics.bodyScrollWidth}`,
        );

        const sizeSelectors = [
          ['volume-chip-30', sel('volume-chip-30')],
          ['volume-chip-120', sel('volume-chip-120')],
          ['volume-chip-180', sel('volume-chip-180')],
          ['custom-amount-submit', sel('custom-amount-submit')],
          ['record-pee', sel('record-pee')],
          ['record-poop', sel('record-poop')],
        ];
        const sizes = [];
        for (const [name, selector] of sizeSelectors) {
          const rect = await page.rect(selector);
          if (!rect) {
            assert(false, `${label}：${name} 存在可测量`, '元素不存在');
            continue;
          }
          sizes.push({ name, width: Math.round(rect.width), height: Math.round(rect.height) });
          const minSide = Math.min(rect.width, rect.height);
          const isKey = name.startsWith('volume-chip') || name.startsWith('record-pee') || name.startsWith('record-poop');
          if (isKey) {
            assert(minSide >= 44, `${label}：${name} 点击区域 ≥ 44px`, `${Math.round(rect.width)}×${Math.round(rect.height)}`);
          }
          assert(
            rect.x >= -0.5 && rect.right <= metrics.innerWidth + 0.5,
            `${label}：${name} 位于视口内（不横向溢出）`,
            `x=${Math.round(rect.x)} right=${Math.round(rect.right)} / innerWidth=${metrics.innerWidth}`,
          );
        }
        // 按钮重叠检测
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
        assert(overlaps.length === 0, `${label}：关键按钮互不重叠`, overlaps.length ? overlaps.join('; ') : '无重叠');
        return { metrics, sizes };
      };

      const mobileResult = await measure(VIEWPORT_MOBILE, '390×844');
      assertEqual(mobileResult.metrics.innerWidth, 390, '390 视口 innerWidth = 390');

      const narrowResult = await measure(VIEWPORT_NARROW, '320×640');
      assertEqual(narrowResult.metrics.innerWidth, 320, '320 视口 innerWidth = 320');
      await page.screenshot('mobile-320.png');

      const desktopResult = await measure(VIEWPORT_DESKTOP, '900×900');
      assertEqual(desktopResult.metrics.innerWidth, 900, '900 视口 innerWidth = 900');
      const appRect = await page.rect('.app');
      const mainRect = await page.rect('.main');
      assert(mainRect.width <= 560 + 1, '桌面宽度下内容区保持 max-width ≈560px', `main 宽 ${Math.round(mainRect.width)}px`);
      const leftGap = appRect.x;
      const rightGap = 900 - appRect.right;
      assert(Math.abs(leftGap - rightGap) <= 2, '桌面下内容水平居中', `左 ${Math.round(leftGap)}px / 右 ${Math.round(rightGap)}px / app 宽 ${Math.round(appRect.width)}px`);
      await page.screenshot('desktop-900.png');

      // 移动端细节观察（不影响 PASS/FAIL）
      await page.setViewport(VIEWPORT_NARROW);
      await sleep(200);
      const summaryMetrics = await page.evaluate(`(() => {
        const el = document.querySelector('[data-testid="today-summary"]');
        const rect = el.getBoundingClientRect();
        return { height: rect.height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 24, text: el.textContent.replace(/\\s+/g, ' ').trim() };
      })()`);
      note(
        '320px 今日汇总折行',
        `高度 ${Math.round(summaryMetrics.height)}px，${summaryMetrics.height > summaryMetrics.lineHeight * 1.5 ? '折成两行（前端已说明不算 bug）' : '单行'}：${summaryMetrics.text}`,
      );
      const deleteRect = await page.rect('.event-delete');
      note(
        '时间线删除按钮点击区域',
        deleteRect ? `${Math.round(deleteRect.width)}×${Math.round(deleteRect.height)}px` : '未测量到',
      );

      await page.setViewport(VIEWPORT_MOBILE);
      await sleep(200);
    });

    /* ------------------------------------------------ G13 深色模式 */
    await runGroup('G13', '深色模式：配色切换 + 对比度', async () => {
      await page.setViewport(VIEWPORT_MOBILE);
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(250);
      const light = await page.evaluate(`(() => {
        const body = getComputedStyle(document.body);
        const summary = getComputedStyle(document.querySelector('.summary'));
        return { bg: body.backgroundColor, text: body.color, card: summary.backgroundColor, cardText: summary.color };
      })()`);
      await page.emulateMedia({ colorScheme: 'dark' });
      await sleep(300);
      const dark = await page.evaluate(`(() => {
        const body = getComputedStyle(document.body);
        const summary = getComputedStyle(document.querySelector('.summary'));
        return { bg: body.backgroundColor, text: body.color, card: summary.backgroundColor, cardText: summary.color };
      })()`);
      assert(light.bg !== dark.bg, '深色模式背景色与浅色不同', `${light.bg} → ${dark.bg}`);
      assert(light.text !== dark.text, '深色模式文字色与浅色不同', `${light.text} → ${dark.text}`);
      assert(light.card !== dark.card, '深色模式卡片背景与浅色不同', `${light.card} → ${dark.card}`);

      const lightFg = parseRgb(light.text);
      const lightBg = parseRgb(light.bg);
      const darkFg = parseRgb(dark.text);
      const darkBg = parseRgb(dark.bg);
      const lightRatio = lightFg && lightBg ? contrastRatio(lightFg, lightBg) : 0;
      const darkRatio = darkFg && darkBg ? contrastRatio(darkFg, darkBg) : 0;
      assert(lightRatio >= 4.5, '浅色模式正文对比度 ≥ 4.5:1（WCAG AA）', `${lightRatio.toFixed(2)}:1（${light.text} on ${light.bg}）`);
      assert(darkRatio >= 4.5, '深色模式正文对比度 ≥ 4.5:1（WCAG AA）', `${darkRatio.toFixed(2)}:1（${dark.text} on ${dark.bg}）`);

      const mediaMatches = await page.evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`);
      assertEqual(mediaMatches, true, 'CDP 媒体模拟生效：prefers-color-scheme: dark');
      await page.screenshot('dark-390.png');
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(200);
    });

    /* ------------------------------------------------ G13b 无障碍与对比度细节（观察项） */
    await runGroup('G13b', '无障碍与对比度细节抽查', async () => {
      await page.setViewport(VIEWPORT_MOBILE);
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(250);
      const wideName = await page.accessibleName(sel('export-csv'));
      assertEqual(wideName?.name, '导出 CSV', '390px 下导出链接的无障碍名称为「导出 CSV」', JSON.stringify(wideName));

      const lightContrast = await page.primaryButtonContrast(sel('custom-amount-submit'));
      assert(Boolean(lightContrast), '可读取主按钮样式以计算对比度');
      if (lightContrast) {
        note(
          '主按钮白字对比度（浅色）',
          `渐变端 ${lightContrast.ratios.map((ratio) => ratio.toFixed(2)).join(' / ')}:1，最小 ${lightContrast.minRatio.toFixed(
            2,
          )}:1；字号 ${lightContrast.fontSize} / ${lightContrast.fontWeight}，WCAG AA 正文要求 4.5:1（P2 可访问性）`,
        );
      }

      await page.setViewport(VIEWPORT_NARROW);
      await sleep(250);
      const narrowName = await page.accessibleName(sel('export-csv'));
      if (narrowName && narrowName.name) {
        assertEqual(narrowName.name, '导出 CSV', '320px 下导出链接仍有无障碍名称', JSON.stringify(narrowName));
      } else {
        note(
          '320px 下导出链接无无障碍名称（P2）',
          `AX role=${narrowName?.role} name=${JSON.stringify(narrowName?.name)}；窄屏 CSS 用 display:none 隐藏了「导出 CSV」文字，且链接未加 aria-label`,
        );
      }

      const heroLight = await page.gradientTextContrast('.hero', sel('gap-duration'));
      if (heroLight) {
        note(
          'Hero 大字号白字在珊瑚渐变上的对比度',
          `渐变端 ${heroLight.ratios.map((ratio) => ratio.toFixed(2)).join(' / ')}:1，最小 ${heroLight.minRatio.toFixed(
            2,
          )}:1；字号 ${heroLight.fontSize} / ${heroLight.fontWeight}（WCAG 大字号要求 3:1，P2 可访问性提示）`,
        );
      }

      await page.setViewport(VIEWPORT_MOBILE);
      await page.emulateMedia({ colorScheme: 'dark' });
      await sleep(300);
      const darkContrast = await page.primaryButtonContrast(sel('custom-amount-submit'));
      if (darkContrast) {
        note(
          '主按钮白字对比度（深色）',
          `渐变端 ${darkContrast.ratios.map((ratio) => ratio.toFixed(2)).join(' / ')}:1，最小 ${darkContrast.minRatio.toFixed(
            2,
          )}:1（P2 可访问性）`,
        );
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await sleep(200);
    });

    /* ------------------------------------------------ G14 空库 */
    await runGroup('G14', '空库状态：empty-state / 今日汇总为 0 / 无记录提示', async () => {
      const existing = await api.allEvents();
      let deleted = 0;
      for (const event of existing) {
        const response = await api.deleteEvent(event.id);
        if (response.status === 204) deleted += 1;
      }
      assertEqual(deleted, existing.length, '通过 API 清空数据库', `删除 ${deleted}/${existing.length} 条`);
      assertEqual((await api.allEvents()).length, 0, '服务端事件已清空');

      await page.reload();
      assert(await page.isVisible(sel('empty-state')), '空库刷新后 empty-state 可见');
      const historyCount = await page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`);
      assertEqual(historyCount, 0, '时间线无记录条目');
      const summary = await page.textOfTestId('today-summary');
      assertIncludes(summary, '喂奶 0 次', '今日汇总喂奶 0 次', `"${summary}"`);
      assertIncludes(summary, '奶量 0 ml', '今日汇总奶量 0 ml', `"${summary}"`);
      assertIncludes(summary, '小便 0', '今日汇总小便 0');
      assertIncludes(summary, '大便 0', '今日汇总大便 0');
      assertEqual(await page.textOfTestId('gap-last-feed'), '还没有喂奶记录', 'Hero 提示「还没有喂奶记录」');
      assertEqual(await page.textOfTestId('gap-duration'), '还没开始', 'Hero 时长显示「还没开始」');
      assertEqual(await page.textOfTestId('gap-last-diaper'), '还没有大小便记录', 'Hero 提示「还没有大小便记录」');
      assert(!(await page.isVisible(sel('load-more'))), '空库时隐藏「加载更多」');
      assert(!(await page.isVisible(sel('load-error'))), '空库页面不显示错误条');
      const state = await api.state(tzOffset);
      assertEqual(state.lastFeeding, null, '/api/state lastFeeding 为 null');
      assertEqual(state.lastDiaper, null, '/api/state lastDiaper 为 null');
      assertEqual(state.recent.length, 0, '/api/state recent 为空');
      assertEqual(state.today.totalMl, 0, '/api/state today.totalMl = 0');
      await page.screenshot('empty-390.png');
    });

    /* ------------------------------------------------ G15 API 契约抽查 */
    await runGroup('G15', '契约一致性抽查（API 字段 / 错误码 / 静态头 / CSV）', async () => {
      const html = await api.request('/');
      assertEqual(html.status, 200, 'GET / → 200');
      assertIncludes(html.headers.get('content-type'), 'text/html', 'HTML Content-Type 正确');
      const csp = String(html.headers.get('content-security-policy') ?? '');
      assertIncludes(csp, "default-src 'self'", 'HTML 带 CSP default-src self');
      assertIncludes(csp, "script-src 'self'", 'CSP script-src self（无内联脚本）');
      assertEqual(html.headers.get('x-content-type-options'), 'nosniff', 'HTML 带 X-Content-Type-Options: nosniff');
      assertEqual(html.headers.get('cache-control'), 'no-cache', 'HTML 带 Cache-Control: no-cache');

      for (const [assetPath, expectedMime] of [
        ['/app.css', 'text/css'],
        ['/app.js', 'text/javascript'],
        ['/lib/format.js', 'text/javascript'],
        ['/icon.svg', 'image/svg+xml'],
        ['/manifest.webmanifest', 'application/manifest+json'],
      ]) {
        const response = await api.request(assetPath);
        assertEqual(response.status, 200, `静态资源 ${assetPath} → 200`);
        assertIncludes(response.headers.get('content-type'), expectedMime, `${assetPath} MIME 为 ${expectedMime}`);
      }

      // 目录穿越防护
      for (const evilPath of ['/..%2fpackage.json', '/..%2f..%2fsrc%2fserver.js', '/%2e%2e/package.json']) {
        const response = await api.request(evilPath);
        assertEqual(response.status, 404, `目录穿越被拦截 ${evilPath} → 404`);
      }
      const badMethod = await api.request('/', { method: 'POST', json: {} });
      assertEqual(badMethod.status, 405, '静态路径非 GET/HEAD → 405');

      // 错误码 / 中文 message
      const expectError = async (name, response, status, code) => {
        assertEqual(response.status, status, `${name} → ${status}`);
        assertEqual(response.data?.error, code, `${name} error=${code}`);
        assert(
          typeof response.data?.message === 'string' && /[\u4e00-\u9fa5]/.test(response.data.message),
          `${name} message 为中文可直接展示`,
          JSON.stringify(response.data?.message),
        );
      };
      await expectError('Content-Type 非 JSON', await api.request('/api/feedings', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
      await expectError('非法 JSON 体', await api.request('/api/feedings', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }), 400, 'invalid_json');
      await expectError('非法 feedType', await api.createFeeding({ feedType: 'water', amountMl: 10 }), 400, 'invalid_feed_type');
      await expectError('amountMl = 0', await api.createFeeding({ feedType: 'formula', amountMl: 0 }), 400, 'invalid_amount');
      await expectError('amountMl = 2001', await api.createFeeding({ feedType: 'formula', amountMl: 2001 }), 400, 'invalid_amount');
      await expectError('amountMl 非整数', await api.createFeeding({ feedType: 'formula', amountMl: 12.5 }), 400, 'invalid_amount');
      await expectError('亲喂带奶量', await api.createFeeding({ feedType: 'breast_direct', amountMl: 120 }), 400, 'unexpected_amount');
      await expectError('happenedAt 为字符串', await api.createFeeding({ feedType: 'formula', amountMl: 120, happenedAt: '123' }), 400, 'invalid_happened_at');
      await expectError('happenedAt 超前 10 分钟', await api.createFeeding({ feedType: 'formula', amountMl: 120, happenedAt: Date.now() + 10 * 60_000 }), 400, 'invalid_happened_at');
      await expectError('备注超长', await api.createFeeding({ feedType: 'formula', amountMl: 120, note: 'x'.repeat(201) }), 400, 'invalid_note');
      await expectError('备注非字符串', await api.createFeeding({ feedType: 'formula', amountMl: 120, note: 123 }), 400, 'invalid_note');
      await expectError('非法 diaperKind', await api.createDiaper({ diaperKind: 'sleep' }), 400, 'invalid_diaper_kind');
      await expectError('limit=0', await api.request('/api/events?limit=0'), 400, 'invalid_limit');
      await expectError('limit=201', await api.request('/api/events?limit=201'), 400, 'invalid_limit');
      await expectError('tzOffset 越界', await api.request('/api/state?tzOffset=9999'), 400, 'invalid_tz_offset');
      await expectError('tzOffset 非数字', await api.request('/api/state?tzOffset=abc'), 400, 'invalid_tz_offset');
      await expectError('非法游标 before', await api.request('/api/events?before=abc'), 400, 'invalid_cursor');
      await expectError('删除不存在的记录', await api.deleteEvent(999_999), 404, 'not_found');

      // 边界合法值 + 事件 JSON 字段
      const grid = await api.state(tzOffset);
      assertMatch(String(grid.today.date ?? ''), /^\d{4}-\d{2}-\d{2}$/, '/api/state today.date 为 YYYY-MM-DD 格式');
      const created1 = await api.createFeeding({ feedType: 'formula', amountMl: 1, happenedAt: Date.now(), note: 'QA 契约边界' });
      assertEqual(created1.status, 201, 'amountMl=1（下边界）→ 201');
      const event = created1.data?.event ?? {};
      assertEqual(
        JSON.stringify(Object.keys(event).sort()),
        JSON.stringify(['amountMl', 'createdAt', 'diaperKind', 'feedType', 'happenedAt', 'id', 'kind', 'note']),
        '事件 JSON 字段与契约一致（camelCase）',
      );
      assert(typeof event.id === 'number' && typeof event.happenedAt === 'number' && typeof event.createdAt === 'number', '事件时间为 number（epoch ms）');
      const created2 = await api.createFeeding({ feedType: 'formula', amountMl: 2000 });
      assertEqual(created2.status, 201, 'amountMl=2000（上边界）→ 201');
      const createdDirect = await api.createFeeding({ feedType: 'breast_direct' });
      assertEqual(createdDirect.status, 201, '亲喂不带 amountMl → 201');
      assertEqual(createdDirect.data?.event?.amountMl, null, '亲喂事件 amountMl 为 null');
      const createdMixed = await api.createDiaper({ diaperKind: 'mixed' });
      assertEqual(createdMixed.status, 201, 'diaperKind=mixed → 201');
      const mixedState = await api.state(tzOffset);
      assertEqual(mixedState.today.diaperCount, 1, '今日 diaperCount 统计 mixed');
      assertEqual(mixedState.today.mixedCount, 1, '今日 mixedCount 单独统计');
      assertEqual(mixedState.today.peeCount, 1, 'peeCount 包含 mixed');
      assertEqual(mixedState.today.poopCount, 1, 'poopCount 包含 mixed');
      for (const id of [event.id, created2.data.event.id, createdDirect.data.event.id, createdMixed.data.event.id]) {
        const response = await api.deleteEvent(id);
        assertEqual(response.status, 204, `清理契约测试记录 id=${id} → 204`);
      }
      assertEqual((await api.allEvents()).length, 0, '契约测试后数据库恢复为空');
    });

    /* ------------------------------------------------ G16 恰好 30 条边界观察 */
    await runGroup('G16', '边界：恰好 30 条记录时「加载更多」的表现', async () => {
      const base = Date.now();
      let created = 0;
      for (let index = 0; index < 30; index += 1) {
        const happenedAt = base - (index + 1) * 600_000;
        const response =
          index % 5 === 0
            ? await api.createDiaper({ diaperKind: index % 10 === 0 ? 'mixed' : 'pee', happenedAt })
            : await api.createFeeding({ feedType: 'formula', amountMl: 90, happenedAt });
        if (response.status === 201) created += 1;
      }
      assertEqual(created, 30, 'API 造满 30 条边界数据');
      await page.reload();
      const count = await page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`);
      assertEqual(count, 30, '恰好 30 条时首屏全部展示');
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
        const countAfter = await page.evaluate(`document.querySelectorAll('[data-testid="history-list"] .event').length`);
        assertEqual(countAfter, 30, '点击后记录数不变（确实没有更多数据）');
        assert(!(await page.isVisible(sel('load-more'))), '点击后「加载更多」按钮自行隐藏');
      }
    });

    /* ------------------------------------------------ G17 控制台 / 网络 / 静态资源 */
    await runGroup('G17', '控制台错误 / 未捕获异常 / 4xx-5xx 网络响应 / 静态资源 200', async () => {
      assertEqual(page.consoleErrors.length, 0, '页面 console.error 为空（预期内故障注入除外）', page.consoleErrors.map((item) => item.text).join(' | ') || '无');
      assertEqual(page.exceptions.length, 0, '页面未捕获异常为空', page.exceptions.map((item) => item.text).join(' | ') || '无');
      assertEqual(page.logErrors.length, 0, 'Log.entryAdded error 为空', page.logErrors.map((item) => `${item.source}: ${item.text}`).join(' | ') || '无');
      assertEqual(page.requestFailures.length, 0, '网络请求失败（非 cancel）为空', page.requestFailures.map((item) => `${item.method} ${item.url} ${item.errorText}`).join(' | ') || '无');

      const httpErrors = page.responses.filter((response) => response.status >= 400);
      assertEqual(httpErrors.length, 0, '浏览器网络响应无 4xx/5xx', httpErrors.map((item) => `${item.method} ${item.path} → ${item.status}`).join(' | ') || '无');
      const notFound = page.responses.filter((response) => response.status === 404);
      assertEqual(notFound.length, 0, '无 404（静态资源全部命中）');

      for (const [label, assetPath] of [
        ['HTML 文档', '/'],
        ['app.css', '/app.css'],
        ['app.js', '/app.js'],
        ['lib/format.js', '/lib/format.js'],
        ['icon.svg', '/icon.svg'],
        ['manifest.webmanifest', '/manifest.webmanifest'],
      ]) {
        const hit = page.responses.find((response) => response.path === assetPath && response.status === 200);
        assert(Boolean(hit), `${label} 真实网络请求 → 200`, hit ? `${hit.method} ${hit.path} ${hit.status} ${hit.mimeType}` : '未捕获到 200 响应');
      }
      const external = page.requests.size
        ? [...page.requests.values()].filter((request) => {
            try {
              const url = new URL(request.url);
              return url.origin !== new URL(baseUrl).origin && !['data:', 'blob:', 'about:'].includes(url.protocol);
            } catch {
              return false;
            }
          })
        : [];
      assertEqual(external.length, 0, '页面未请求任何外部 CDN / 第三方资源', external.map((item) => item.url).join(' | ') || '无');
      assertEqual(page.dialogs.length, 1, '全程只出现 1 次原生对话框（删除确认，已被脚本 accept）', page.dialogs.map((item) => item.type).join(', '));
      assert(expectedIssues.length >= 1, '故障注入产生的预期错误已单独标记，未混入失败项', `${expectedIssues.length} 条`);
    });

    /* ------------------------------------------------ G18 截图产物 */
    await runGroup('G18', '截图产物完整性（docs/screenshots/）', async () => {
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
      }
      const expected = {
        'mobile-390.png': [780, 1688],
        'mobile-390-after-record.png': [780, 1688],
        'mobile-320.png': [640, 1280],
        'desktop-900.png': [1800, 1800],
        'dark-390.png': [780, 1688],
        'empty-390.png': [780, 1688],
      };
      for (const [name, [width, height]] of Object.entries(expected)) {
        const item = screenshots.find((shot) => shot.name === name);
        if (!item) {
          assert(false, `截图 ${name} 已由脚本捕获`, '未记录');
          continue;
        }
        assertEqual(item.width, width, `${name} 宽度符合 2x 设备像素比`, `${item.width}px`);
        assertEqual(item.height, height, `${name} 高度符合视口`);
      }
      const full = screenshots.find((shot) => shot.name === 'mobile-390-full.png');
      assert(Boolean(full) && full.width === 780 && full.height > 1600, 'mobile-390-full.png 为整页长截图', full ? `${full.width}×${full.height}` : '未生成');
      assert(await page.exists(sel('export-csv')), '页面存在导出入口（截图内容来自真实页面）');
    });
  } finally {
    await cleanup();
  }

  printSummary();
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
  try {
    await access(SERVER_ENTRY);
  } catch {
    throw new Error(`找不到服务入口：${SERVER_ENTRY}`);
  }
  if (!PUBLIC_DIR) throw new Error('public 目录缺失');
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
