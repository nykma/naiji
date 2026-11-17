import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStyler,
  renderConfigShow,
  renderDayGroups,
  renderLog,
  renderRecordResult,
  renderStatus,
  renderToday,
  shouldUseColor,
} from '../src/render.mjs';
import { bathEvent, diaperEvent, emptyToday, feedEvent } from './helpers.mjs';

// 固定本地「现在」：2026-01-15 12:00
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
const styler = createStyler();

test('shouldUseColor：TTY / NO_COLOR / TERM=dumb / --no-color', () => {
  assert.equal(shouldUseColor({ isTTY: true, env: {} }), true);
  assert.equal(shouldUseColor({ isTTY: false, env: {} }), false);
  assert.equal(shouldUseColor({ isTTY: true, noColor: true, env: {} }), false);
  assert.equal(shouldUseColor({ isTTY: true, env: { NO_COLOR: '1' } }), false);
  assert.equal(shouldUseColor({ isTTY: true, env: { NO_COLOR: '' } }), true);
  assert.equal(shouldUseColor({ isTTY: true, env: { TERM: 'dumb' } }), false);
});

test('createStyler：关闭时原样返回，开启时带 ANSI', () => {
  const plain = createStyler();
  assert.equal(plain.bold('hi'), 'hi');
  assert.equal(plain.red('x'), 'x');

  const colored = createStyler({ enabled: true });
  assert.match(colored.bold('hi'), /^\u001b\[1mhi\u001b\[0m$/);
  assert.match(colored.cyan('x'), /\u001b\[36m/);
});

test('renderStatus：完整状态卡（对齐契约 §7.3 示例）', () => {
  const lastFeeding = feedEvent({
    id: 5,
    feedTypes: ['breast_milk'],
    amountMl: 90,
    happenedAt: NOW - 3 * 60 * 60_000 - 25 * 60_000,
  });
  const lastDiaper = diaperEvent({ id: 6, diaperKind: 'poop', happenedAt: NOW - 3 * 60 * 60_000 });
  const lastBath = bathEvent({ id: 7, happenedAt: NOW - 65 * 60_000 });
  const state = {
    now: NOW,
    lastFeeding,
    lastDiaper,
    lastBath,
    today: emptyToday({
      feedCount: 4,
      totalMl: 360,
      breastDirectCount: 1,
      peeCount: 2,
      poopCount: 1,
      bathCount: 1,
    }),
    recent: [],
  };
  const output = renderStatus(state, { now: NOW, styler });
  assert.equal(
    output,
    [
      '🍼 距离上次喂奶  3 小时 25 分钟',
      '   上次 08:35 · 母乳（瓶喂） 90 ml',
      '💧 距上次换尿布/洗澡  1 小时 5 分钟',
      '   上次 10:55 · 洗澡',
      '今日 喂奶 4 次 · 奶量 360 ml · 亲喂 1 次 · 小便 2 · 大便 1 · 洗澡 1 次',
    ].join('\n'),
  );
});

test('renderStatus：「距上次换尿布/洗澡」只有洗澡记录时取洗澡', () => {
  const output = renderStatus(
    {
      lastFeeding: null,
      lastDiaper: null,
      lastBath: bathEvent({ id: 2, happenedAt: NOW - 20 * 60_000 }),
      today: emptyToday({ bathCount: 1 }),
    },
    { now: NOW, styler },
  );
  assert.match(output, /💧 距上次换尿布\/洗澡  20 分钟/);
  assert.match(output, /上次 11:40 · 洗澡/);
  assert.match(output, /洗澡 1 次$/);
});

test('renderStatus：洗澡晚于换尿布 → 取洗澡；换尿布晚于洗澡 → 取换尿布', () => {
  const bathLater = renderStatus(
    {
      lastDiaper: diaperEvent({ id: 2, diaperKind: 'poop', happenedAt: NOW - 90 * 60_000 }),
      lastBath: bathEvent({ id: 3, happenedAt: NOW - 10 * 60_000 }),
      today: emptyToday(),
    },
    { now: NOW, styler },
  );
  assert.match(bathLater, /💧 距上次换尿布\/洗澡  10 分钟/);
  assert.match(bathLater, /上次 11:50 · 洗澡/);

  const diaperLater = renderStatus(
    {
      lastDiaper: diaperEvent({ id: 2, diaperKind: 'pee', happenedAt: NOW - 5 * 60_000 }),
      lastBath: bathEvent({ id: 3, happenedAt: NOW - 6 * 60 * 60_000 }),
      today: emptyToday(),
    },
    { now: NOW, styler },
  );
  assert.match(diaperLater, /💧 距上次换尿布\/洗澡  5 分钟/);
  assert.match(diaperLater, /上次 11:55 · 小便/);
});

test('renderStatus：洗澡与换尿布都没有 → 提示「还没有换尿布/洗澡记录」', () => {
  const output = renderStatus(
    { lastFeeding: null, lastDiaper: null, lastBath: null, today: emptyToday() },
    { now: NOW, styler },
  );
  assert.match(output, /还没有换尿布\/洗澡记录/);
});

test('renderStatus：空状态给出友好提示', () => {
  const output = renderStatus(
    {
      now: NOW,
      lastFeeding: null,
      lastDiaper: null,
      lastBath: null,
      today: emptyToday(),
      recent: [],
    },
    { now: NOW, styler },
  );
  assert.match(output, /还没有喂奶记录/);
  assert.match(output, /还没有换尿布\/洗澡记录/);
  assert.match(output, /今日 喂奶 0 次 · 奶量 0 ml · 亲喂 0 次 · 小便 0 · 大便 0 · 洗澡 0 次/);
});

test('renderStatus：跨天的上次记录显示日期', () => {
  const lastFeeding = feedEvent({ happenedAt: new Date(2026, 0, 13, 9, 5).getTime() });
  const output = renderStatus(
    { lastFeeding, lastDiaper: null, today: emptyToday() },
    { now: NOW, styler },
  );
  assert.match(output, /上次 前天 09:05 · 奶粉 120 ml/);
});

test('renderDayGroups：按天分组，事件行含 id / 图标 / 内容（含洗澡）', () => {
  const events = [
    bathEvent({ id: 4, happenedAt: NOW - 30_000 }),
    feedEvent({ id: 3, feedTypes: ['formula', 'breast_direct'], amountMl: 60, happenedAt: NOW - 60_000 }),
    diaperEvent({ id: 2, diaperKind: 'poop', note: '有点稀', happenedAt: NOW - 7200_000 }),
    feedEvent({ id: 1, happenedAt: new Date(2026, 0, 14, 9, 0).getTime() }),
  ];
  const lines = renderDayGroups(events, { now: NOW, styler });
  assert.equal(lines[0], '今天');
  assert.match(lines[1], /🛁 洗澡/);
  assert.match(lines[1], /#4/);
  assert.match(lines[2], /🍼 奶粉 \+ 亲喂 60 ml/);
  assert.match(lines[2], /#3/);
  assert.ok(lines.some((line) => line === '昨天'));
  assert.ok(lines.some((line) => /💩 大便/.test(line)));
  assert.ok(lines.some((line) => /· 有点稀/.test(line)));
  assert.ok(lines.some((line) => /#1/.test(line)));
});

test('renderLog：标题 + 分组（含洗澡）；空列表提示', () => {
  const events = [
    bathEvent({ id: 2, note: '洗香香', happenedAt: NOW - 60_000 }),
    feedEvent({ id: 1, happenedAt: NOW - 120_000 }),
  ];
  const output = renderLog(events, { now: NOW, styler });
  assert.match(output, /📋 最近 2 条记录/);
  assert.match(output, /今天/);
  assert.match(output, /🛁 洗澡/);
  assert.match(output, /#2/);
  assert.match(output, /· 洗香香/);
  assert.match(output, /#1/);

  const empty = renderLog([], { now: NOW, styler });
  assert.match(empty, /还没有任何记录/);
  assert.match(empty, /naiji feed 120/);
});

test('renderToday：标题（日期 + 周几）+ 记录 + 汇总（含洗澡）', () => {
  const events = [
    bathEvent({ id: 10, happenedAt: NOW - 1800_000 }),
    feedEvent({ id: 9, happenedAt: NOW - 3600_000 }),
  ];
  const output = renderToday(
    events,
    {
      today: emptyToday({ feedCount: 1, totalMl: 120, bathCount: 1 }),
    },
    { now: NOW, styler },
  );
  assert.match(output, /📅 今天 · 2026-01-15 周四/);
  assert.match(output, /🛁 洗澡/);
  assert.match(output, /11:30/);
  assert.match(output, /11:00/);
  assert.match(output, /今日 喂奶 1 次 · 奶量 120 ml/);
  assert.match(output, /洗澡 1 次/);

  const empty = renderToday([], { today: emptyToday() }, { now: NOW, styler });
  assert.match(empty, /今天还没有记录/);
  assert.match(empty, /今日 喂奶 0 次/);
  assert.match(empty, /洗澡 0 次/);
});

test('renderRecordResult：已记录 / 已撤销 / 带备注 / 可隐藏 id', () => {
  const event = feedEvent({ id: 7, feedTypes: ['formula', 'breast_milk'], amountMl: 120, happenedAt: NOW - 60_000 });
  assert.equal(
    renderRecordResult(event, { now: NOW, styler }),
    '✅ 已记录 #7 奶粉 + 母乳（瓶喂） 120 ml · 11:59',
  );

  const withNote = { ...event, note: '夜里那次' };
  assert.match(
    renderRecordResult(withNote, { now: NOW, styler }),
    /· 11:59 · 夜里那次$/,
  );

  assert.match(
    renderRecordResult(event, { now: NOW, styler, verb: '已撤销', icon: '🗑' }),
    /^🗑 已撤销 #7 /,
  );

  const bath = bathEvent({ id: 12, happenedAt: NOW - 60_000 });
  assert.equal(
    renderRecordResult(bath, { now: NOW, styler, showId: false }),
    '✅ 已记录 洗澡 · 11:59',
  );
  const bathWithNote = { ...bath, note: '洗香香' };
  assert.equal(
    renderRecordResult(bathWithNote, { now: NOW, styler, showId: false }),
    '✅ 已记录 洗澡 · 11:59 · 洗香香',
  );
  assert.match(renderRecordResult(bath, { now: NOW, styler }), /^✅ 已记录 #12 洗澡/);
});

test('renderConfigShow：地址 / 来源 / 配置文件', () => {
  const output = renderConfigShow(
    {
      server: 'http://192.168.1.9:3000',
      source: 'config',
      configPath: '/home/u/.config/naiji/config.json',
      configExists: true,
      configServer: 'http://192.168.1.9:3000',
      configError: null,
    },
    { styler },
  );
  assert.match(output, /服务器地址: http:\/\/192\.168\.1\.9:3000/);
  assert.match(output, /来源: 配置文件/);
  assert.match(output, /配置文件: \/home\/u\/\.config\/naiji\/config\.json（http:\/\/192\.168\.1\.9:3000）/);

  const missing = renderConfigShow(
    {
      server: 'http://127.0.0.1:3000',
      source: 'default',
      configPath: '/tmp/none.json',
      configExists: false,
      configServer: null,
      configError: null,
    },
    { styler },
  );
  assert.match(missing, /来源: 默认值（内置）/);
  assert.match(missing, /（不存在）/);
});

test('启用颜色时状态卡包含 ANSI 转义', () => {
  const colored = createStyler({ enabled: true });
  const output = renderStatus(
    {
      lastFeeding: feedEvent({ happenedAt: NOW - 60_000 }),
      lastDiaper: null,
      today: emptyToday(),
    },
    { now: NOW, styler: colored },
  );
  assert.match(output, /\u001b\[/);
});
