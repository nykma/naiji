/**
 * 奶记 · API 地址解析与请求封装（ES Module，零依赖）
 *
 * 前后端分离的关键：所有 HTTP 请求（以及导出 CSV 的链接 href）都必须经过 apiUrl()。
 *
 * API 基址优先级（高 → 低）：
 *   1. 页面 URL 参数 ?api=http://host:port（非空时写入 localStorage 持久化）
 *   2. localStorage['naiji.apiBase']
 *   3. window.NAIJI_CONFIG.apiBase（web/config.js，默认 '' = 同源）
 *   4. 同源（空字符串）
 *
 * 例：静态页 http://127.0.0.1:4323/?api=http://127.0.0.1:4322
 *     → 请求 http://127.0.0.1:4322/api/state?...（依赖后端 CORS）
 */

const STORAGE_KEY = 'naiji.apiBase';
const QUERY_KEY = 'api';

function normalizeBase(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  // 只接受 http(s) 绝对地址；其它值（拼写错误等）忽略，避免整站请求打空
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return trimmed.replace(/\/+$/, '');
}

function readStoredBase() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? null : normalizeBase(stored);
  } catch {
    return null; // 隐私模式下 localStorage 不可用
  }
}

function persistBase(base) {
  try {
    if (base) localStorage.setItem(STORAGE_KEY, base);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略存储失败，本次会话仍按 URL 参数生效 */
  }
}

function readQueryBase() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(QUERY_KEY)) return null;
    return normalizeBase(params.get(QUERY_KEY) ?? '');
  } catch {
    return null;
  }
}

function resolveApiBase() {
  const queryBase = readQueryBase();
  if (queryBase !== null) {
    // URL 显式指定：非空则持久化；空的 ?api= 表示清除持久化，回到同源 / config.js
    persistBase(queryBase);
    return queryBase;
  }
  const storedBase = readStoredBase();
  if (storedBase !== null && storedBase !== '') return storedBase;
  const configBase = window.NAIJI_CONFIG && typeof window.NAIJI_CONFIG.apiBase === 'string'
    ? normalizeBase(window.NAIJI_CONFIG.apiBase)
    : '';
  return configBase;
}

const API_BASE = resolveApiBase();

/** 当前生效的 API 基址；'' 表示同源 */
export function getApiBase() {
  return API_BASE;
}

/**
 * 拼接 API 绝对/相对地址。
 * @param {string} path 以 / 开头的 API 路径，如 '/api/state?x=1'
 */
export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/** /api/state 地址（带浏览器本地时区偏移） */
export function stateUrl() {
  return apiUrl(`/api/state?tzOffset=${new Date().getTimezoneOffset()}`);
}

/** 展示给用户的当前后端地址（同源时显示页面 origin） */
export function apiDisplayOrigin() {
  if (API_BASE) return API_BASE;
  try {
    return window.location.origin;
  } catch {
    return '当前地址';
  }
}

/** 带中文 message 的 API 错误 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function networkErrorMessage() {
  const origin = apiDisplayOrigin();
  return `网络连接失败，无法访问 ${origin}，请检查服务是否启动或 API 地址是否正确`;
}

/**
 * 统一请求封装：JSON 解析、错误信息中文、网络错误提示。
 * @param {string} path 以 / 开头的 API 路径，或已经由 apiUrl()/stateUrl() 拼好的绝对地址
 * @param {RequestInit} [options]
 * @returns {Promise<any>} 204 → null；否则解析后的 JSON
 */
export async function request(path, options = {}) {
  // path 可能已经是 stateUrl() 返回的绝对地址，避免重复拼接 base
  const url = /^https?:\/\//i.test(path) ? path : apiUrl(path);
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError(networkErrorMessage());
  }

  let payload = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload.message === 'string' && payload.message
        ? payload.message
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, {
      status: response.status,
      code: payload && typeof payload.error === 'string' ? payload.error : '',
    });
  }
  return payload;
}
