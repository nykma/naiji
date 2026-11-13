/**
 * 奶记 CLI · 输出渲染（中文 + 可选 ANSI 颜色）
 *
 * 所有 render* 函数返回字符串（不含结尾换行），不直接写 stdout，便于单测。
 * 颜色仅在 TTY 且未禁用时启用；NO_COLOR / --no-color / 非 TTY 自动降级为纯文本。
 */

import {
  diaperKindLabel,
  eventIcon,
  eventTitle,
  formatClock,
  formatDateKeyWeekday,
  formatDayKey,
  formatDayLabel,
  formatDuration,
  formatTimeShort,
  formatTodaySummary,
} from './format.mjs';
import { SERVER_SOURCE_LABELS } from './config.mjs';

/**
 * 是否启用 ANSI 颜色。
 * @param {{ isTTY?: boolean, noColor?: boolean, env?: Record<string, string|undefined> }} options
 */
export function shouldUseColor({ isTTY = false, noColor = false, env = {} } = {}) {
  if (noColor) return false;
  if (env && typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  if (env && env.TERM === 'dumb') return false;
  return Boolean(isTTY);
}

/**
 * 创建着色器；disabled 时所有方法原样返回字符串。
 */
export function createStyler({ enabled = false } = {}) {
  const wrap = (code) => (value) => (enabled ? `\u001b[${code}m${value}\u001b[0m` : String(value));
  return {
    enabled: Boolean(enabled),
    bold: wrap(1),
    dim: wrap(2),
    red: wrap(31),
    green: wrap(32),
    yellow: wrap(33),
    blue: wrap(34),
    magenta: wrap(35),
    cyan: wrap(36),
  };
}

/** 事件行：`  09:35  🍼 奶粉 120 ml  #12  · 备注` */
export function renderEventRow(event, { styler = createStyler() } = {}) {
  const note = event.note ? styler.dim(`  · ${event.note}`) : '';
  return `  ${styler.dim(formatClock(event.happenedAt))}  ${eventIcon(event)} ${eventTitle(event)}  ${styler.dim(`#${event.id}`)}${note}`;
}

/** 按天分组的事件列表（不含标题行） */
export function renderDayGroups(events, { now = Date.now(), styler = createStyler() } = {}) {
  const lines = [];
  let currentDay = null;
  for (const event of events) {
    const dayKey = formatDayKey(event.happenedAt);
    if (dayKey !== currentDay) {
      if (lines.length > 0) lines.push('');
      lines.push(styler.bold(formatDayLabel(event.happenedAt, now)));
      currentDay = dayKey;
    }
    lines.push(renderEventRow(event, { styler }));
  }
  return lines;
}

/**
 * 状态卡（docs/CONTRACT.md §7.3）：
 *
 * 🍼 距离上次喂奶  3 小时 25 分钟
 *    上次 09:35 · 母乳（瓶喂） 90 ml
 * 💧 距上次换尿布  1 小时 5 分钟
 *    上次 12:20 · 大便
 * 今日 喂奶 4 次 · 奶量 360 ml · 亲喂 1 次 · 小便 2 · 大便 1
 */
export function renderStatus(state = {}, { now = Date.now(), styler = createStyler() } = {}) {
  const lines = [];

  const lastFeeding = state.lastFeeding ?? null;
  if (lastFeeding) {
    lines.push(
      `🍼 ${styler.bold('距离上次喂奶')}  ${styler.cyan(formatDuration(now - lastFeeding.happenedAt))}`,
    );
    lines.push(
      styler.dim(`   上次 ${formatTimeShort(lastFeeding.happenedAt, now)} · ${eventTitle(lastFeeding)}`),
    );
  } else {
    lines.push(`🍼 ${styler.dim('还没有喂奶记录')}`);
    lines.push(styler.dim('   记录一次：naiji feed 120'));
  }

  const lastDiaper = state.lastDiaper ?? null;
  if (lastDiaper) {
    lines.push(
      `💧 ${styler.bold('距上次换尿布')}  ${styler.cyan(formatDuration(now - lastDiaper.happenedAt))}`,
    );
    lines.push(
      styler.dim(`   上次 ${formatTimeShort(lastDiaper.happenedAt, now)} · ${diaperKindLabel(lastDiaper.diaperKind)}`),
    );
  } else {
    lines.push(`💧 ${styler.dim('还没有换尿布记录')}`);
  }

  lines.push(formatTodaySummary(state.today ?? {}));
  return lines.join('\n');
}

/** 记录成功 / 撤销 / 删除后的一行反馈 */
export function renderRecordResult(
  event,
  { now = Date.now(), styler = createStyler(), verb = '已记录', icon = '✅' } = {},
) {
  const meta = [formatTimeShort(event.happenedAt, now)];
  if (event.note) meta.push(event.note);
  return `${icon} ${styler.green(verb)} ${styler.dim(`#${event.id}`)} ${styler.bold(eventTitle(event))} ${styler.dim(`· ${meta.join(' · ')}`)}`;
}

/** 最近记录列表（log） */
export function renderLog(events, { now = Date.now(), styler = createStyler() } = {}) {
  if (!events || events.length === 0) {
    return `📋 ${styler.bold('还没有任何记录')}\n${styler.dim('   先记录一条：naiji feed 120')}`;
  }
  const lines = [`📋 ${styler.bold(`最近 ${events.length} 条记录`)}`, ''];
  lines.push(...renderDayGroups(events, { now, styler }));
  return lines.join('\n');
}

/** 今日记录 + 今日汇总（today） */
export function renderToday(
  events,
  state = {},
  { now = Date.now(), styler = createStyler() } = {},
) {
  const dateKey = state?.today?.date ?? formatDayKey(now);
  const weekday = formatDateKeyWeekday(dateKey);
  const lines = [
    `📅 ${styler.bold('今天')} ${styler.dim(`· ${dateKey}${weekday ? ` ${weekday}` : ''}`)}`,
    '',
  ];
  if (!events || events.length === 0) {
    lines.push(styler.dim('   今天还没有记录。'));
  } else {
    for (const event of events) lines.push(renderEventRow(event, { styler }));
  }
  lines.push('');
  lines.push(formatTodaySummary(state?.today ?? {}));
  return lines.join('\n');
}

/** config show 的信息卡 */
export function renderConfigShow(
  { server, source, configPath, configExists, configServer, configError },
  { styler = createStyler() } = {},
) {
  const lines = [
    `${styler.dim('服务器地址')}: ${styler.bold(server)}`,
    `${styler.dim('来源')}: ${SERVER_SOURCE_LABELS[source] ?? source}`,
  ];
  let detail;
  if (configError) detail = `读取失败：${configError}`;
  else if (!configExists) detail = '不存在';
  else if (configServer) detail = configServer;
  else detail = '未设置 server';
  lines.push(`${styler.dim('配置文件')}: ${configPath}（${detail}）`);
  return lines.join('\n');
}
