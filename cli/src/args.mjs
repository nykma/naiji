/**
 * 奶记 CLI · 参数解析与「命令行输入 → API 请求体」构造（纯函数，可单测）
 *
 * 解析策略：选项可出现在命令前后；`--` 之后全部视为位置参数。
 * 命令别名在 COMMAND_ALIASES；喂奶类型别名支持英文 / 中文 / 单字母（README 约定 f/b/d）。
 */

import { UsageError } from './errors.mjs';
import { FEED_TYPE_ORDER, feedTypesLabel } from './format.mjs';

export const COMMAND_ALIASES = {
  status: 'status',
  s: 'status',
  feed: 'feed',
  f: 'feed',
  pee: 'pee',
  p: 'pee',
  poop: 'poop',
  o: 'poop',
  diaper: 'diaper',
  d: 'diaper',
  log: 'log',
  l: 'log',
  today: 'today',
  undo: 'undo',
  u: 'undo',
  rm: 'rm',
  export: 'export',
  config: 'config',
  c: 'config',
  help: 'help',
};

export const COMMAND_NAMES = Object.keys(COMMAND_ALIASES);

/** 喂奶类型别名：规范值 / 单字母 / 中文 */
export const FEED_TYPE_ALIASES = {
  formula: 'formula',
  f: 'formula',
  奶粉: 'formula',
  配方奶: 'formula',
  breast_milk: 'breast_milk',
  b: 'breast_milk',
  母乳: 'breast_milk',
  瓶喂: 'breast_milk',
  母乳瓶喂: 'breast_milk',
  '母乳（瓶喂）': 'breast_milk',
  breast_direct: 'breast_direct',
  d: 'breast_direct',
  亲喂: 'breast_direct',
  直接喂: 'breast_direct',
};

/** 大小便类型别名 */
export const DIAPER_ALIASES = {
  pee: 'pee',
  小便: 'pee',
  poop: 'poop',
  大便: 'poop',
  mixed: 'mixed',
  大小便: 'mixed',
};

/** 后端允许的最早记录时间（2000-01-01 UTC）与未来容差，与 server 校验一致 */
const MINUTE_MS = 60_000;
const HAPPENED_AT_MIN_MS = Date.UTC(2000, 0, 1);
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const NOTE_MAX_LENGTH = 200;
const AMOUNT_MIN_ML = 1;
const AMOUNT_MAX_ML = 2000;
const LIMIT_MIN = 1;
const LIMIT_MAX = 200;
export const DEFAULT_LOG_LIMIT = 10;

const OPTION_SPECS = {
  '--server': { key: 'server', takesValue: true, display: '--server' },
  '--json': { key: 'json', display: '--json' },
  '--no-color': { key: 'noColor', display: '--no-color' },
  '--help': { key: 'help', display: '--help' },
  '-h': { key: 'help', display: '-h' },
  '--version': { key: 'version', display: '--version' },
  '-V': { key: 'version', display: '-V' },
  '--yes': { key: 'yes', display: '--yes' },
  '-y': { key: 'yes', display: '-y' },
  '-t': { key: 'types', takesValue: true, repeatable: true, display: '-t/--type' },
  '--type': { key: 'types', takesValue: true, repeatable: true, display: '-t/--type' },
  '--direct': { key: 'direct', display: '--direct' },
  '--note': { key: 'note', takesValue: true, display: '--note' },
  '--ago': { key: 'ago', takesValue: true, display: '--ago' },
  '--at': { key: 'at', takesValue: true, display: '--at' },
  '-n': { key: 'limit', takesValue: true, display: '-n/--limit' },
  '--limit': { key: 'limit', takesValue: true, display: '-n/--limit' },
  '--out': { key: 'out', takesValue: true, display: '--out' },
};

const GLOBAL_OPTION_KEYS = ['server', 'json', 'noColor', 'help', 'version'];

const COMMAND_OPTION_KEYS = {
  status: [],
  feed: ['types', 'direct', 'note', 'ago', 'at'],
  pee: ['note', 'ago', 'at'],
  poop: ['note', 'ago', 'at'],
  diaper: ['note', 'ago', 'at'],
  log: ['limit'],
  today: [],
  undo: ['yes'],
  rm: ['yes'],
  export: ['out'],
  config: [],
  help: [],
};

function emptyOptions() {
  return {
    types: [],
    json: false,
    noColor: false,
    help: false,
    version: false,
    yes: false,
    direct: false,
    server: undefined,
    note: undefined,
    ago: undefined,
    at: undefined,
    limit: undefined,
    out: undefined,
  };
}

function unknownCommandHint(token) {
  if (/^\d+$/.test(String(token))) return `想记录奶量？试试：naiji feed ${token}`;
  return '运行 naiji help 查看可用命令';
}

/**
 * 解析 argv（不含 node / 脚本路径）。
 * @param {string[]} argv
 * @returns {{
 *   command: string|null,
 *   commandToken: string|null,
 *   positionals: string[],
 *   options: ReturnType<typeof emptyOptions>,
 * }}
 */
export function parseArgs(argv = []) {
  const options = emptyOptions();
  const seenKeys = new Map(); // key → 首次出现时的展示名
  const positionals = [];
  let endOfOptions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && typeof token === 'string' && token.startsWith('-') && token !== '-') {
      let name = token;
      let inlineValue;
      if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        if (eq > 2) {
          name = token.slice(0, eq);
          inlineValue = token.slice(eq + 1);
        }
      }
      const spec = OPTION_SPECS[name];
      if (!spec) throw new UsageError(`未知选项：${name}`, '运行 naiji help 查看可用选项');
      if (spec.takesValue) {
        let value = inlineValue;
        if (value === undefined) {
          i += 1;
          if (i >= argv.length) {
            throw new UsageError(`选项 ${spec.display} 需要一个值`, `例如：naiji feed 120 ${spec.display} ...`);
          }
          value = argv[i];
        }
        if (spec.repeatable) {
          options[spec.key].push(value);
        } else {
          if (seenKeys.has(spec.key)) throw new UsageError(`选项 ${spec.display} 只能出现一次`);
          options[spec.key] = value;
        }
      } else {
        if (inlineValue !== undefined) throw new UsageError(`选项 ${name} 不接受值`);
        options[spec.key] = true;
      }
      if (!seenKeys.has(spec.key)) seenKeys.set(spec.key, spec.display);
      continue;
    }
    positionals.push(token);
  }

  const commandToken = positionals.length > 0 ? positionals[0] : null;
  const command =
    commandToken === null
      ? 'status'
      : (COMMAND_ALIASES[String(commandToken).toLowerCase()] ?? undefined);

  if (command === undefined) {
    if (options.help) return { command: null, commandToken, positionals: positionals.slice(1), options };
    throw new UsageError(`未知命令：${commandToken}`, unknownCommandHint(commandToken));
  }

  const commandArgs = positionals.slice(1);

  // --help / --version 优先，不校验命令选项（便于 `naiji feed --help`）
  if (options.help || options.version) {
    return { command, commandToken, positionals: commandArgs, options };
  }

  const allowed = new Set([...GLOBAL_OPTION_KEYS, ...(COMMAND_OPTION_KEYS[command] ?? [])]);
  for (const [key, display] of seenKeys) {
    if (!allowed.has(key)) {
      throw new UsageError(
        `命令 ${command} 不支持选项 ${display}`,
        `运行 naiji help ${command} 查看用法`,
      );
    }
  }

  return { command, commandToken, positionals: commandArgs, options };
}

/** 命令不接受位置参数 */
export function ensureNoPositionals(command, positionals) {
  if (positionals.length > 0) {
    throw new UsageError(
      `命令 ${command} 不接受参数（收到：${positionals.join(' ')}）`,
      `运行 naiji help ${command} 查看用法`,
    );
  }
}

/**
 * 解析喂奶类型（--type 的原始值列表）：逗号分隔、可重复、去重并按规范顺序。
 * @param {string[]} rawValues
 * @returns {string[]}
 */
export function parseFeedTypes(rawValues = []) {
  const collected = [];
  for (const raw of rawValues) {
    for (const part of String(raw).split(',')) {
      const token = part.trim();
      if (token === '') continue;
      const type = FEED_TYPE_ALIASES[token.toLowerCase()];
      if (!type) {
        throw new UsageError(
          `未知的喂奶类型：${token}`,
          '可用：formula/f(奶粉)、breast_milk/b(母乳)、breast_direct/d(亲喂)',
        );
      }
      collected.push(type);
    }
  }
  return FEED_TYPE_ORDER.filter((type) => collected.includes(type));
}

/** 解析奶量（毫升）：1–2000 的整数 */
export function parseAmountMl(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new UsageError(`奶量必须是正整数（毫升），收到：${raw}`, '例如：naiji feed 120');
  }
  const ml = Number(text);
  if (!Number.isInteger(ml) || ml < AMOUNT_MIN_ML || ml > AMOUNT_MAX_ML) {
    throw new UsageError(
      `奶量必须是 ${AMOUNT_MIN_ML} 到 ${AMOUNT_MAX_ML} 之间的整数（毫升），收到：${ml}`,
    );
  }
  return ml;
}

/**
 * 解析 --at 的值。
 * @returns {{ type: 'clock', hour: number, minute: number } | { type: 'absolute', ts: number }}
 */
export function parseAtValue(raw) {
  const text = String(raw ?? '').trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) {
      throw new UsageError(`--at 时间不合法：${raw}`, 'HH:MM 中小时为 0–23、分钟为 00–59');
    }
    return { type: 'clock', hour, minute };
  }
  const absolute = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text);
  if (absolute) {
    const [year, month, day, hour, minute] = absolute.slice(1).map(Number);
    if (hour > 23 || minute > 59) {
      throw new UsageError(`--at 时间不合法：${raw}`, '时间部分小时为 0–23、分钟为 00–59');
    }
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      throw new UsageError(`--at 日期不存在：${raw}`, '请检查年月日是否正确');
    }
    return { type: 'absolute', ts: date.getTime() };
  }
  throw new UsageError(
    `--at 时间格式不正确：${raw}`,
    '支持 HH:MM（今天）或 "YYYY-MM-DD HH:MM"（含空格请加引号）',
  );
}

function clockToTimestamp({ hour, minute }, now) {
  const base = new Date(now);
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hour,
    minute,
    0,
    0,
  ).getTime();
}

/**
 * 解析 --ago / --at，得到 happenedAt（epoch ms）或 undefined（默认现在）。
 * 非法值抛 UsageError。
 */
export function parseTimeOptions(options = {}, now = Date.now()) {
  const { ago, at } = options;
  if (ago !== undefined && at !== undefined) {
    throw new UsageError('--ago 与 --at 不能同时使用', '选择其一即可');
  }
  let happenedAt;
  if (ago !== undefined) {
    const text = String(ago).trim();
    if (!/^\d+$/.test(text)) {
      throw new UsageError(`--ago 必须是分钟数（非负整数），收到：${ago}`, '例如：naiji feed 120 --ago 30');
    }
    happenedAt = now - Number(text) * MINUTE_MS;
  } else if (at !== undefined) {
    const parsed = parseAtValue(at);
    happenedAt = parsed.type === 'clock' ? clockToTimestamp(parsed, now) : parsed.ts;
  } else {
    return undefined;
  }

  if (happenedAt > now + FUTURE_TOLERANCE_MS) {
    throw new UsageError(
      '--ago / --at 指定的时间在未来，无法记录',
      '--at 的 HH:MM 表示「今天」，补记昨天请写 "YYYY-MM-DD HH:MM"',
    );
  }
  if (happenedAt < HAPPENED_AT_MIN_MS) {
    throw new UsageError('记录时间不能早于 2000-01-01');
  }
  return happenedAt;
}

/** 备注：trim 后为空视为未填；≤ 200 字符 */
export function normalizeNote(raw) {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;
  if (text.length > NOTE_MAX_LENGTH) {
    throw new UsageError(`备注不能超过 ${NOTE_MAX_LENGTH} 个字符（当前 ${text.length} 个）`);
  }
  return text;
}

/**
 * feed / f 命令 → POST /api/feedings 请求体。
 * @param {ReturnType<typeof parseArgs>} parsed
 * @param {number} [now]
 */
export function buildFeedRequest(parsed, now = Date.now()) {
  const { positionals, options } = parsed;
  if (positionals.length > 1) {
    throw new UsageError(
      `feed 只接受一个奶量参数（收到：${positionals.join(' ')}）`,
      '用法：naiji feed <ml> [选项]',
    );
  }
  const amount = positionals.length === 1 ? parseAmountMl(positionals[0]) : null;

  let types = parseFeedTypes(options.types);
  if (options.direct) {
    types = FEED_TYPE_ORDER.filter(
      (type) => type === 'breast_direct' || types.includes(type),
    );
  }
  if (types.length === 0) types = ['formula'];

  const needsAmount = types.includes('formula') || types.includes('breast_milk');
  if (needsAmount && amount === null) {
    throw new UsageError(
      `记录「${feedTypesLabel(types)}」需要奶量（毫升）`,
      '例如：naiji feed 120；仅亲喂可不带奶量：naiji feed --direct',
    );
  }
  if (!needsAmount && amount !== null) {
    throw new UsageError(
      '仅亲喂记录不需要奶量',
      '如果是「亲喂 + 瓶喂补充」，请同时加 -t formula 或 -t breast_milk',
    );
  }

  const happenedAt = parseTimeOptions(options, now);
  const note = normalizeNote(options.note);
  const body = { feedTypes: types };
  if (amount !== null) body.amountMl = amount;
  if (note !== undefined) body.note = note;
  if (happenedAt !== undefined) body.happenedAt = happenedAt;
  return body;
}

/**
 * pee / poop / diaper / d 命令 → POST /api/diapers 请求体。
 * @param {ReturnType<typeof parseArgs>} parsed
 * @param {number} [now]
 */
export function buildDiaperRequest(parsed, now = Date.now()) {
  const { command, positionals, options } = parsed;
  let diaperKind;
  if (command === 'pee' || command === 'poop') {
    ensureNoPositionals(command, positionals);
    diaperKind = command;
  } else {
    if (positionals.length === 0) {
      throw new UsageError(
        'diaper 需要指定类型：pee / poop / mixed',
        '也可以直接使用：naiji pee / naiji poop',
      );
    }
    if (positionals.length > 1) {
      throw new UsageError(`diaper 只接受一个类型参数（收到：${positionals.join(' ')}）`);
    }
    diaperKind = DIAPER_ALIASES[String(positionals[0]).toLowerCase()];
    if (!diaperKind) {
      throw new UsageError(
        `未知的大小便类型：${positionals[0]}`,
        '可用：pee(小便) / poop(大便) / mixed(大小便)',
      );
    }
  }

  const happenedAt = parseTimeOptions(options, now);
  const note = normalizeNote(options.note);
  const body = { diaperKind };
  if (note !== undefined) body.note = note;
  if (happenedAt !== undefined) body.happenedAt = happenedAt;
  return body;
}

/** log 的 -n / --limit：1–200 的整数，默认 10 */
export function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LOG_LIMIT;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new UsageError(`-n/--limit 必须是整数（${LIMIT_MIN}–${LIMIT_MAX}），收到：${raw}`);
  }
  const limit = Number(text);
  if (limit < LIMIT_MIN || limit > LIMIT_MAX) {
    throw new UsageError(`-n/--limit 必须在 ${LIMIT_MIN} 到 ${LIMIT_MAX} 之间，收到：${limit}`);
  }
  return limit;
}

/** rm 的记录 id：正整数 */
export function parseEventId(raw) {
  const text = String(raw ?? '').trim();
  if (!/^[1-9]\d{0,15}$/.test(text)) {
    throw new UsageError(
      `记录 id 必须是正整数，收到：${raw}`,
      '可先用 naiji log 查看记录 id',
    );
  }
  return Number(text);
}
