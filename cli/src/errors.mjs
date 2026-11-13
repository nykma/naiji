/**
 * 奶记 CLI · 错误类型
 *
 * - UsageError：命令行用法错误（退出码 2）
 * - ApiError：后端 / 网络错误（退出码 1）
 */

export class UsageError extends Error {
  /**
   * @param {string} message 面向用户的错误说明
   * @param {string} [hint] 提示（例如正确的用法示例）
   */
  constructor(message, hint = '运行 naiji help 查看用法') {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

export class ApiError extends Error {
  /**
   * @param {string} message 面向用户的错误说明（后端 message 或网络提示）
   * @param {{ status?: number, code?: string, network?: boolean, timeout?: boolean, cause?: unknown }} [details]
   */
  constructor(message, { status = 0, code = 'api_error', network = false, timeout = false, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.network = network;
    this.timeout = timeout;
    this.cause = cause;
  }
}
