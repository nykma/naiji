/**
 * 服务端时间工具（纯函数，可单测）。
 *
 * 「今天」的边界需要按调用方时区计算。tzOffsetMinutes 语义与 JS
 * Date.prototype.getTimezoneOffset() 一致：本地时间 = UTC - tzOffset 分钟。
 * 东八区手机上传 -480；省略 / null 时使用服务器本地时区。
 */

const DAY_MS = 86_400_000;

/**
 * @param {number} nowMs epoch 毫秒
 * @param {number|null|undefined} tzOffsetMinutes 分钟；null/undefined 表示服务器本地时区
 * @returns {{ start: number, end: number, dateKey: string }}
 */
export function dayBounds(nowMs, tzOffsetMinutes = null) {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('nowMs 必须是有限数字（epoch 毫秒）');
  }

  if (tzOffsetMinutes === null || tzOffsetMinutes === undefined) {
    // 服务器本地时区：用本地 Date 构造器，天然处理 DST / 本地时区
    const d = new Date(nowMs);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const dateKey = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return { start, end, dateKey };
  }

  if (!isValidTzOffset(tzOffsetMinutes)) {
    throw new RangeError('tzOffset 必须是 -840 到 840 之间的整数（分钟）');
  }

  const offsetMs = tzOffsetMinutes * 60_000;
  const shifted = new Date(nowMs - offsetMs);
  const startShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const start = startShifted + offsetMs;
  const end = start + DAY_MS;
  const dateKey = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  return { start, end, dateKey };
}

/** tzOffset（分钟）是否合法：−840..840 的整数 */
export function isValidTzOffset(v) {
  return Number.isInteger(v) && v >= -840 && v <= 840;
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
