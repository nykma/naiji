/**
 * 奶记 CLI · HTTP 客户端（零依赖，Node 内置 fetch）
 *
 * 只走 docs/CONTRACT.md §5 的 JSON API；错误统一抛 ApiError，
 * message 优先使用后端返回的中文 message，便于直接展示。
 */

import { ApiError } from './errors.mjs';

export class NaijiClient {
  /**
   * @param {{ server: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
   */
  constructor({ server, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    this.server = server;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {string} method
   * @param {string} pathname 以 / 开头
   * @param {{ query?: Record<string, string|number|null|undefined>, body?: unknown, binary?: boolean, accept?: string }} [options]
   */
  async request(method, pathname, { query, body, binary = false, accept } = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    const url = `${this.server}${pathname}${suffix}`;

    const headers = {
      Accept: accept ?? (binary ? 'text/csv, text/plain, */*' : 'application/json'),
    };
    const init = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      const name = error?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ApiError(`请求超时（${this.timeoutMs}ms）：${this.server}`, {
          network: true,
          timeout: true,
          code: 'timeout',
          cause: error,
        });
      }
      throw new ApiError(`无法连接服务器：${this.server}`, {
        network: true,
        code: 'network_error',
        cause: error,
      });
    }

    if (binary) {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw this.#toApiError(response.status, text);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) throw this.#toApiError(response.status, text);
    const trimmed = text.trim();
    if (trimmed === '') return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new ApiError(
        `服务器返回了非 JSON 响应（HTTP ${response.status}）：请确认 --server 指向奶记后端`,
        { status: response.status, code: 'invalid_response' },
      );
    }
  }

  #toApiError(status, text) {
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    let message;
    if (payload && typeof payload.message === 'string' && payload.message) message = payload.message;
    else if (payload && typeof payload.error === 'string') message = `请求失败：${payload.error}`;
    else if (status === 404) message = '接口不存在（HTTP 404）：请确认 --server 指向奶记后端';
    else message = `请求失败：HTTP ${status}`;
    return new ApiError(message, {
      status,
      code: (payload && typeof payload.error === 'string' && payload.error) || 'http_error',
    });
  }

  /** GET /api/health */
  async health() {
    return this.request('GET', '/api/health');
  }

  /** GET /api/state?tzOffset=…（默认使用 CLI 进程本地时区） */
  async getState({ tzOffset = new Date().getTimezoneOffset() } = {}) {
    return this.request('GET', '/api/state', { query: { tzOffset } });
  }

  /**
   * GET /api/events?limit=&before=&beforeId=
   * @param {{ limit?: number, before?: number, beforeId?: number }} [options]
   */
  async listEvents({ limit, before, beforeId } = {}) {
    const payload = await this.request('GET', '/api/events', {
      query: { limit, before, beforeId },
    });
    return Array.isArray(payload?.events) ? payload.events : [];
  }

  /** POST /api/feedings → 返回创建的 event */
  async createFeeding(body) {
    const payload = await this.request('POST', '/api/feedings', { body });
    if (!payload?.event) {
      throw new ApiError('服务器响应缺少 event 字段', { code: 'invalid_response' });
    }
    return payload.event;
  }

  /** POST /api/diapers → 返回创建的 event */
  async createDiaper(body) {
    const payload = await this.request('POST', '/api/diapers', { body });
    if (!payload?.event) {
      throw new ApiError('服务器响应缺少 event 字段', { code: 'invalid_response' });
    }
    return payload.event;
  }

  /** POST /api/baths → 返回创建的 event（kind: "bath"） */
  async createBath(body) {
    const payload = await this.request('POST', '/api/baths', { body });
    if (!payload?.event) {
      throw new ApiError('服务器响应缺少 event 字段', { code: 'invalid_response' });
    }
    return payload.event;
  }

  /** DELETE /api/events/:id */
  async deleteEvent(id) {
    return this.request('DELETE', `/api/events/${id}`);
  }

  /** GET /api/export.csv → Buffer（保留 UTF-8 BOM） */
  async exportCsv() {
    return this.request('GET', '/api/export.csv', { binary: true });
  }
}

export function createClient(options) {
  return new NaijiClient(options);
}
