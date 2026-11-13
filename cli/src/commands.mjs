/**
 * 奶记 CLI · 命令实现（各命令只做「解析输入 → 调 API → 渲染输出」）
 *
 * ctx 由 cli.mjs 组装：
 * {
 *   io: { stdout(chunk), stderr(text), stdoutIsTTY, stderrIsTTY, stdinIsTTY },
 *   styler, json, env, now, cwd, interactive,
 *   client: NaijiClient,
 *   server, serverSource, configPath, configExists, configServer, configError,
 *   confirm: (question) => Promise<boolean>,
 *   options: parsed.options,
 * }
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildDiaperRequest,
  buildFeedRequest,
  ensureNoPositionals,
  parseEventId,
  parseLimit,
} from './args.mjs';
import { eventTitle, formatBytes, formatDayKey, formatTimeShort } from './format.mjs';
import { renderConfigShow, renderLog, renderRecordResult, renderStatus, renderToday } from './render.mjs';
import { setConfigServer } from './config.mjs';
import { UsageError } from './errors.mjs';

function writeLine(io, text = '') {
  io.stdout(`${text}\n`);
}

function printJson(io, value) {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function statusCommand(parsed, ctx) {
  ensureNoPositionals('status', parsed.positionals);
  const state = await ctx.client.getState();
  if (ctx.json) {
    printJson(ctx.io, state);
    return;
  }
  writeLine(ctx.io, renderStatus(state, { now: ctx.now(), styler: ctx.styler }));
}

// ---------------------------------------------------------------------------
// feed / pee / poop / diaper
// ---------------------------------------------------------------------------

export async function recordCommand(parsed, ctx) {
  const isFeed = parsed.command === 'feed';
  const body = isFeed ? buildFeedRequest(parsed, ctx.now()) : buildDiaperRequest(parsed, ctx.now());
  const event = isFeed ? await ctx.client.createFeeding(body) : await ctx.client.createDiaper(body);
  if (ctx.json) {
    printJson(ctx.io, { event });
    return;
  }
  writeLine(ctx.io, renderRecordResult(event, { now: ctx.now(), styler: ctx.styler }));
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

export async function logCommand(parsed, ctx) {
  ensureNoPositionals('log', parsed.positionals);
  const limit = parseLimit(parsed.options.limit);
  const events = await ctx.client.listEvents({ limit });
  if (ctx.json) {
    printJson(ctx.io, { events });
    return;
  }
  writeLine(ctx.io, renderLog(events, { now: ctx.now(), styler: ctx.styler }));
}

// ---------------------------------------------------------------------------
// today
// ---------------------------------------------------------------------------

export async function todayCommand(parsed, ctx) {
  ensureNoPositionals('today', parsed.positionals);
  const [state, events] = await Promise.all([
    ctx.client.getState(),
    ctx.client.listEvents({ limit: 200 }),
  ]);
  const now = ctx.now();
  const dateKey = state?.today?.date ?? formatDayKey(now);
  const todayEvents = events.filter((event) => formatDayKey(event.happenedAt) === dateKey);
  if (ctx.json) {
    printJson(ctx.io, { date: dateKey, summary: state?.today ?? {}, events: todayEvents });
    return;
  }
  writeLine(ctx.io, renderToday(todayEvents, state ?? {}, { now, styler: ctx.styler }));
}

// ---------------------------------------------------------------------------
// undo / rm
// ---------------------------------------------------------------------------

async function shouldProceed(ctx, question) {
  // 非 TTY / --json / --yes 时直接执行，避免脚本卡住
  if (!ctx.interactive || ctx.json || ctx.options.yes) return true;
  return Boolean(await ctx.confirm(question));
}

export async function undoCommand(parsed, ctx) {
  ensureNoPositionals('undo', parsed.positionals);
  const events = await ctx.client.listEvents({ limit: 1 });
  const target = events[0];
  if (!target) {
    if (ctx.json) printJson(ctx.io, { ok: true, deleted: null });
    else writeLine(ctx.io, '没有可撤销的记录');
    return;
  }
  const question = `撤销 #${target.id} ${eventTitle(target)} · ${formatTimeShort(target.happenedAt, ctx.now())}？[y/N] `;
  if (!(await shouldProceed(ctx, question))) {
    writeLine(ctx.io, ctx.styler.dim('已取消'));
    return;
  }
  await ctx.client.deleteEvent(target.id);
  if (ctx.json) {
    printJson(ctx.io, { ok: true, deleted: target });
    return;
  }
  writeLine(
    ctx.io,
    renderRecordResult(target, { now: ctx.now(), styler: ctx.styler, verb: '已撤销', icon: '🗑' }),
  );
}

export async function rmCommand(parsed, ctx) {
  if (parsed.positionals.length === 0) {
    throw new UsageError('rm 需要记录 id，例如：naiji rm 12', '可先用 naiji log 查看记录 id');
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(`rm 只接受一个记录 id（收到：${parsed.positionals.join(' ')}）`);
  }
  const id = parseEventId(parsed.positionals[0]);

  // 先尝试找到记录内容用于确认提示（最多最近 200 条）
  let target = null;
  try {
    const events = await ctx.client.listEvents({ limit: 200 });
    target = events.find((event) => event.id === id) ?? null;
  } catch {
    target = null;
  }

  const label = target
    ? `#${id} ${eventTitle(target)} · ${formatTimeShort(target.happenedAt, ctx.now())}`
    : `#${id}`;
  if (!(await shouldProceed(ctx, `删除 ${label}？[y/N] `))) {
    writeLine(ctx.io, ctx.styler.dim('已取消'));
    return;
  }
  await ctx.client.deleteEvent(id);
  if (ctx.json) {
    printJson(ctx.io, { ok: true, deleted: target ?? { id } });
    return;
  }
  const result = target
    ? renderRecordResult(target, { now: ctx.now(), styler: ctx.styler, verb: '已删除', icon: '🗑' })
    : `🗑 ${ctx.styler.green('已删除')} ${ctx.styler.dim(`#${id}`)}`;
  writeLine(ctx.io, result);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export async function exportCommand(parsed, ctx) {
  ensureNoPositionals('export', parsed.positionals);
  const csv = await ctx.client.exportCsv();
  const out = parsed.options.out;
  if (out === undefined || out === '-') {
    ctx.io.stdout(csv);
    if (csv.length === 0 || csv[csv.length - 1] !== 0x0a) ctx.io.stdout('\n');
    return;
  }
  const targetPath = path.resolve(ctx.cwd, out);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, csv);
  if (ctx.json) {
    printJson(ctx.io, { ok: true, path: targetPath, bytes: csv.length });
    return;
  }
  writeLine(
    ctx.io,
    `✅ ${ctx.styler.green('已导出')} ${targetPath} ${ctx.styler.dim(`（${formatBytes(csv.length)}）`)}`,
  );
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export async function configCommand(parsed, ctx) {
  const [sub = 'show', ...rest] = parsed.positionals;
  if (sub === 'show') {
    if (rest.length > 0) {
      throw new UsageError(`config show 不接受参数（收到：${rest.join(' ')}）`);
    }
    if (ctx.json) {
      printJson(ctx.io, {
        server: ctx.server,
        source: ctx.serverSource,
        configPath: ctx.configPath,
        configExists: ctx.configExists,
        configServer: ctx.configServer ?? null,
        configError: ctx.configError ?? null,
      });
      return;
    }
    writeLine(
      ctx.io,
      renderConfigShow(
        {
          server: ctx.server,
          source: ctx.serverSource,
          configPath: ctx.configPath,
          configExists: ctx.configExists,
          configServer: ctx.configServer,
          configError: ctx.configError,
        },
        { styler: ctx.styler },
      ),
    );
    return;
  }

  if (sub === 'set') {
    if (rest.length < 2) {
      throw new UsageError('用法：naiji config set server <url>', '例如：naiji config set server http://192.168.1.23:3000');
    }
    if (rest.length > 2) {
      throw new UsageError(`config set 参数过多（收到：${rest.join(' ')}）`, '用法：naiji config set server <url>');
    }
    const [key, value] = rest;
    if (key !== 'server') {
      throw new UsageError(`不支持的配置项：${key}`, '目前仅支持：server');
    }
    const result = await setConfigServer({ env: ctx.env, url: value });
    if (ctx.json) {
      printJson(ctx.io, { ok: true, server: result.server, path: result.path });
      return;
    }
    writeLine(ctx.io, `✅ ${ctx.styler.green('已设置服务器地址')}: ${result.server}`);
    writeLine(ctx.io, ctx.styler.dim(`   写入 ${result.path}`));
    return;
  }

  throw new UsageError(
    `未知 config 子命令：${sub}`,
    '可用：naiji config show / naiji config set server <url>',
  );
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

const HANDLERS = {
  status: statusCommand,
  feed: recordCommand,
  pee: recordCommand,
  poop: recordCommand,
  diaper: recordCommand,
  log: logCommand,
  today: todayCommand,
  undo: undoCommand,
  rm: rmCommand,
  export: exportCommand,
  config: configCommand,
};

export async function runCommand(parsed, ctx) {
  const handler = HANDLERS[parsed.command];
  if (!handler) throw new UsageError(`未知命令：${parsed.command}`);
  await handler(parsed, ctx);
}
