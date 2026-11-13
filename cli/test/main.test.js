import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { formatDayKey } from '../src/format.mjs';
import {
  diaperEvent,
  emptyToday,
  feedEvent,
  makeState,
  makeTempDir,
  makeTestEnv,
  removeTempDir,
  replyCsv,
  stripAnsi,
  replyEmpty,
  replyJson,
  runMain,
  startStubServer,
} from './helpers.mjs';

// 固定本地「现在」：2026-11-13 22:00
const NOW = new Date(2026, 10, 13, 22, 0, 0, 0).getTime();
const now = () => NOW;
const TODAY = formatDayKey(NOW);
const HOUR = 60 * 60_000;

const FEED_STATE = makeState({
  now: NOW,
  lastFeeding: feedEvent({ id: 3, feedTypes: ['formula', 'breast_direct'], amountMl: 60, happenedAt: NOW - 30 * 60_000 }),
  lastDiaper: diaperEvent({ id: 2, diaperKind: 'poop', happenedAt: NOW - 65 * 60_000 }),
  today: emptyToday({ date: TODAY, feedCount: 4, totalMl: 360, breastDirectCount: 1, peeCount: 2, poopCount: 1 }),
  recent: [],
});

function stateStub(t) {
  return startStubServer((record, res) => {
    if (record.pathname === '/api/state') return replyJson(res, 200, FEED_STATE);
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  }).then((stub) => {
    t.after(() => stub.close());
    return stub;
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status 人类可读输出', async (t) => {
  const stub = await stateStub(t);
  const result = await runMain(['--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /🍼 距离上次喂奶  30 分钟/);
  assert.match(result.stdout, /上次 21:30 · 奶粉 \+ 亲喂 60 ml/);
  assert.match(result.stdout, /💧 距上次换尿布  1 小时 5 分钟/);
  assert.match(result.stdout, /今日 喂奶 4 次 · 奶量 360 ml · 亲喂 1 次 · 小便 2 · 大便 1/);
  assert.equal(result.stderr, '');
});

test('status --json 输出原始 state', async (t) => {
  const stub = await stateStub(t);
  const result = await runMain(['status', '--json', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), FEED_STATE);
});

// ---------------------------------------------------------------------------
// feed / diaper
// ---------------------------------------------------------------------------

test('feed：多标签 + 奶量请求体与中文回显', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: {
        id: 11,
        kind: 'feed',
        feedTypes: record.body.feedTypes,
        amountMl: record.body.amountMl,
        diaperKind: null,
        note: record.body.note ?? null,
        happenedAt: record.body.happenedAt ?? NOW,
        createdAt: NOW,
      },
    });
  });
  t.after(() => stub.close());

  const result = await runMain(
    ['f', '60', '-t', 'formula', '-t', 'breast_direct', '--note', '夜里', '--server', stub.baseUrl],
    { now },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(stub.requests[0].body, {
    feedTypes: ['formula', 'breast_direct'],
    amountMl: 60,
    note: '夜里',
  });
  assert.match(result.stdout, /✅ 已记录 #11 奶粉 \+ 亲喂 60 ml/);
  assert.match(result.stdout, /22:00 · 夜里/);
});

test('feed --direct 仅亲喂：请求体无 amountMl', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: feedEvent({ id: 12, feedTypes: record.body.feedTypes, amountMl: null }),
    });
  });
  t.after(() => stub.close());

  const result = await runMain(['f', '--direct', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.deepEqual(stub.requests[0].body, { feedTypes: ['breast_direct'] });
  assert.match(result.stdout, /✅ 已记录 #12 亲喂/);
});

test('feed --ago 回溯：happenedAt 为 now - N 分钟', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: feedEvent({ id: 13, happenedAt: record.body.happenedAt ?? NOW }),
    });
  });
  t.after(() => stub.close());

  const result = await runMain(['f', '90', '-t', '母乳', '--ago', '30', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.equal(stub.requests[0].body.happenedAt, NOW - 30 * 60_000);
  assert.deepEqual(stub.requests[0].body.feedTypes, ['breast_milk']);
  assert.match(result.stdout, /21:30/);
});

test('pee / diaper mixed：请求体与回显', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: diaperEvent({
        id: 21,
        diaperKind: record.body.diaperKind,
        note: record.body.note ?? null,
        happenedAt: record.body.happenedAt ?? NOW,
      }),
    });
  });
  t.after(() => stub.close());

  const first = await runMain(['p', '--server', stub.baseUrl], { now });
  assert.equal(first.code, 0);
  assert.deepEqual(stub.requests[0].body, { diaperKind: 'pee' });
  assert.match(first.stdout, /✅ 已记录 #21 小便/);

  const second = await runMain(['d', 'mixed', '--note', '有点多', '--server', stub.baseUrl], { now });
  assert.equal(second.code, 0);
  assert.deepEqual(stub.requests[1].body, { diaperKind: 'mixed', note: '有点多' });
  assert.match(second.stdout, /大小便/);
});

test('feed --json：输出 { event }', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 201, {
      event: feedEvent({ id: 31, happenedAt: record.body.happenedAt ?? NOW }),
    });
  });
  t.after(() => stub.close());

  const result = await runMain(['f', '120', '--json', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.event.id, 31);
});

// ---------------------------------------------------------------------------
// log / today
// ---------------------------------------------------------------------------

function eventsStub(t, events) {
  return startStubServer((record, res) => {
    if (record.pathname === '/api/events') return replyJson(res, 200, { events });
    if (record.pathname === '/api/state') {
      return replyJson(res, 200, makeState({ now: NOW, today: emptyToday({ date: TODAY }) }));
    }
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  }).then((stub) => {
    t.after(() => stub.close());
    return stub;
  });
}

const LOG_EVENTS = [
  feedEvent({ id: 4, feedTypes: ['formula', 'breast_direct'], amountMl: 60, happenedAt: NOW - 60_000 }),
  diaperEvent({ id: 3, diaperKind: 'pee', happenedAt: NOW - 2 * 60_000 }),
  feedEvent({ id: 2, feedTypes: ['breast_milk'], amountMl: 90, note: '夜里那次', happenedAt: new Date(2026, 10, 12, 9, 0).getTime() }),
];

test('log：按天分组 + -n 参数', async (t) => {
  const stub = await eventsStub(t, LOG_EVENTS);
  const result = await runMain(['log', '-n', '5', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.equal(stub.requests[0].query.get('limit'), '5');
  assert.match(result.stdout, /📋 最近 3 条记录/);
  assert.match(result.stdout, /今天/);
  assert.match(result.stdout, /昨天/);
  assert.match(result.stdout, /#4/);
  assert.match(result.stdout, /母乳（瓶喂） 90 ml/);
  assert.match(result.stdout, /· 夜里那次/);
});

test('log：空列表提示', async (t) => {
  const stub = await eventsStub(t, []);
  const result = await runMain(['l', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /还没有任何记录/);
});

test('log --json：输出 { events }', async (t) => {
  const stub = await eventsStub(t, LOG_EVENTS);
  const result = await runMain(['log', '--json', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { events: LOG_EVENTS });
});

test('today：只列今天记录 + 今日汇总；--json 结构', async (t) => {
  const oldEvent = feedEvent({ id: 99, happenedAt: new Date(2026, 10, 12, 9, 0).getTime() });
  const allEvents = [...LOG_EVENTS, oldEvent];
  const state = makeState({
    now: NOW,
    today: emptyToday({ date: TODAY, feedCount: 2, totalMl: 150, breastDirectCount: 1 }),
  });
  const stub = await startStubServer((record, res) => {
    if (record.pathname === '/api/state') return replyJson(res, 200, state);
    if (record.pathname === '/api/events') return replyJson(res, 200, { events: allEvents });
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  });
  t.after(() => stub.close());

  const human = await runMain(['today', '--server', stub.baseUrl], { now });
  assert.equal(human.code, 0);
  assert.match(human.stdout, new RegExp(`📅 今天 · ${TODAY}`));
  assert.match(human.stdout, /今日 喂奶 2 次 · 奶量 150 ml/);
  assert.match(human.stdout, /#4/);
  assert.ok(!human.stdout.includes('#99'), '昨天的记录不应出现在 today');

  const machine = await runMain(['today', '--json', '--server', stub.baseUrl], { now });
  const payload = JSON.parse(machine.stdout);
  assert.equal(payload.date, TODAY);
  assert.equal(payload.summary.feedCount, 2);
  assert.equal(payload.events.length, 2); // 只有今天的两条（昨日那条被过滤）
});

// ---------------------------------------------------------------------------
// undo / rm
// ---------------------------------------------------------------------------

test('undo（非 TTY 自动执行）：删除最近一条并打印被删内容', async (t) => {
  const target = feedEvent({
    id: 5,
    feedTypes: ['formula'],
    amountMl: 120,
    happenedAt: NOW - 10 * 60_000,
  });
  const stub = await startStubServer((record, res) => {
    if (record.method === 'GET' && record.pathname === '/api/events') {
      return replyJson(res, 200, { events: [target] });
    }
    if (record.method === 'DELETE') return replyEmpty(res, 204);
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  });
  t.after(() => stub.close());

  const result = await runMain(['undo', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.equal(stub.requests[0].query.get('limit'), '1');
  assert.equal(stub.requests[1].method, 'DELETE');
  assert.equal(stub.requests[1].pathname, '/api/events/5');
  assert.match(result.stdout, /🗑 已撤销 #5 奶粉 120 ml · 21:50/);
});

test('undo：没有记录时不发 DELETE', async (t) => {
  const stub = await startStubServer((record, res) => {
    if (record.pathname === '/api/events') return replyJson(res, 200, { events: [] });
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  });
  t.after(() => stub.close());

  const result = await runMain(['undo', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /没有可撤销的记录/);
  assert.equal(stub.requests.filter((request) => request.method === 'DELETE').length, 0);
});

test('undo（TTY）：确认取消则不删除，确认后删除', async (t) => {
  let deleted = 0;
  const target = diaperEvent({ id: 6, diaperKind: 'poop', happenedAt: NOW - 5 * 60_000 });
  const stub = await startStubServer((record, res) => {
    if (record.method === 'GET' && record.pathname === '/api/events') {
      return replyJson(res, 200, { events: [target] });
    }
    if (record.method === 'DELETE') {
      deleted += 1;
      return replyEmpty(res, 204);
    }
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  });
  t.after(() => stub.close());

  const tty = { stdoutIsTTY: true, stdinIsTTY: true };
  const cancelled = await runMain(['undo', '--server', stub.baseUrl], {
    now,
    tty,
    confirm: async () => false,
  });
  assert.equal(cancelled.code, 0);
  assert.equal(deleted, 0);
  assert.match(cancelled.stdout, /已取消/);

  const confirmed = await runMain(['undo', '--server', stub.baseUrl], {
    now,
    tty,
    confirm: async () => true,
  });
  assert.equal(confirmed.code, 0);
  assert.equal(deleted, 1);
  assert.match(stripAnsi(confirmed.stdout), /已撤销 #6 大便/);
});

test('undo --yes：跳过确认（即使 TTY）', async (t) => {
  const target = feedEvent({ id: 7, happenedAt: NOW - 60_000 });
  const stub = await startStubServer((record, res) => {
    if (record.method === 'GET') return replyJson(res, 200, { events: [target] });
    return replyEmpty(res, 204);
  });
  t.after(() => stub.close());

  const result = await runMain(['u', '--yes', '--server', stub.baseUrl], {
    now,
    tty: { stdoutIsTTY: true, stdinIsTTY: true },
    confirm: async () => {
      throw new Error('不应调用确认');
    },
  });
  assert.equal(result.code, 0);
  assert.match(stripAnsi(result.stdout), /已撤销 #7/);
});

test('undo --json：输出 { ok, deleted }', async (t) => {
  const target = feedEvent({ id: 8, happenedAt: NOW - 60_000 });
  const stub = await startStubServer((record, res) => {
    if (record.method === 'GET') return replyJson(res, 200, { events: [target] });
    return replyEmpty(res, 204);
  });
  t.after(() => stub.close());

  const result = await runMain(['undo', '--json', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, deleted: target });
});

test('rm：查找内容后删除指定 id', async (t) => {
  const target = feedEvent({ id: 5, feedTypes: ['breast_milk'], amountMl: 90, happenedAt: NOW - HOUR });
  const stub = await startStubServer((record, res) => {
    if (record.method === 'GET' && record.pathname === '/api/events') {
      return replyJson(res, 200, { events: [target] });
    }
    if (record.method === 'DELETE') return replyEmpty(res, 204);
    replyJson(res, 404, { error: 'not_found', message: '接口不存在' });
  });
  t.after(() => stub.close());

  const result = await runMain(['rm', '5', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.equal(stub.requests.at(-1).method, 'DELETE');
  assert.equal(stub.requests.at(-1).pathname, '/api/events/5');
  assert.match(result.stdout, /🗑 已删除 #5 母乳（瓶喂） 90 ml/);
});

test('rm：后端 404 时退出码 1 且显示中文 message', async (t) => {
  const stub = await startStubServer((record, res) => {
    if (record.method === 'GET') return replyJson(res, 200, { events: [] });
    return replyJson(res, 404, { error: 'not_found', message: '记录不存在' });
  });
  t.after(() => stub.close());

  const result = await runMain(['rm', '999', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /记录不存在/);
});


test('rm：非法 id 为用法错误', async () => {
  const result = await runMain(['rm', 'abc', '--server', 'http://127.0.0.1:1'], { now });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /正整数/);
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const CSV = '\uFEFF时间,类别,项目,奶量(ml),备注\r\n2026-11-13 08:00,喂奶,奶粉,120,\r\n';

test('export：stdout 保留 BOM 与 CRLF', async (t) => {
  const stub = await startStubServer((record, res) => replyCsv(res, CSV));
  t.after(() => stub.close());

  const result = await runMain(['export', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, CSV);
  assert.equal(stub.requests[0].pathname, '/api/export.csv');
});

test('export --out：写文件并确认；--json 输出路径', async (t) => {
  const dir = makeTempDir();
  try {
    const stub = await startStubServer((record, res) => replyCsv(res, CSV));
    t.after(() => stub.close());

    const result = await runMain(['export', '--out', 'sub/baby.csv', '--server', stub.baseUrl], {
      now,
      cwd: dir,
    });
    assert.equal(result.code, 0);
    const target = path.join(dir, 'sub', 'baby.csv');
    assert.ok(existsSync(target));
    assert.equal(readFileSync(target, 'utf8'), CSV);
    assert.match(result.stdout, /已导出/);

    const machine = await runMain(
      ['export', '--out', 'b.csv', '--json', '--server', stub.baseUrl],
      { now, cwd: dir },
    );
    const payload = JSON.parse(machine.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.path.endsWith('b.csv'));
    assert.equal(payload.bytes, Buffer.byteLength(CSV));
  } finally {
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('config show / set：写入临时 XDG 配置并生效', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });

    const before = await runMain(['config', 'show'], { env, now });
    assert.equal(before.code, 0);
    assert.match(before.stdout, /服务器地址: http:\/\/127\.0\.0\.1:3000/);
    assert.match(before.stdout, /来源: 默认值（内置）/);

    const set = await runMain(['config', 'set', 'server', 'http://192.168.1.9:3000/'], { env, now });
    assert.equal(set.code, 0);
    assert.match(set.stdout, /已设置服务器地址: http:\/\/192\.168\.1\.9:3000/);
    const configFile = path.join(dir, 'naiji', 'config.json');
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), {
      server: 'http://192.168.1.9:3000',
    });

    const after = await runMain(['config', 'show'], { env, now });
    assert.match(after.stdout, /服务器地址: http:\/\/192\.168\.1\.9:3000/);
    assert.match(after.stdout, /来源: 配置文件/);

    const machine = await runMain(['config', 'show', '--json'], { env, now });
    const payload = JSON.parse(machine.stdout);
    assert.equal(payload.server, 'http://192.168.1.9:3000');
    assert.equal(payload.source, 'config');
    assert.equal(payload.configExists, true);
  } finally {
    removeTempDir(dir);
  }
});

test('config set：不支持的键 / 缺参数为用法错误', async () => {
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    const unsupported = await runMain(['config', 'set', 'foo', 'bar'], { env, now });
    assert.equal(unsupported.code, 2);
    assert.match(unsupported.stderr, /不支持的配置项/);

    const missing = await runMain(['config', 'set', 'server'], { env, now });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /用法：naiji config set server <url>/);

    const badUrl = await runMain(['config', 'set', 'server', 'ftp://nope'], { env, now });
    assert.equal(badUrl.code, 2);
  } finally {
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 颜色 / 帮助 / 版本 / 错误
// ---------------------------------------------------------------------------

test('TTY 下输出带 ANSI；NO_COLOR / --no-color 降级', async (t) => {
  const stub = await stateStub(t);
  const dir = makeTempDir();
  try {
    const env = makeTestEnv({ XDG_CONFIG_HOME: dir });
    const tty = { stdoutIsTTY: true };

    const colored = await runMain(['status', '--server', stub.baseUrl], { now, env, tty });
    assert.match(colored.stdout, /\u001b\[/);

    const noColorEnv = await runMain(['status', '--server', stub.baseUrl], {
      now,
      env: { ...env, NO_COLOR: '1' },
      tty,
    });
    assert.ok(!noColorEnv.stdout.includes('\u001b['));

    const noColorFlag = await runMain(['status', '--no-color', '--server', stub.baseUrl], { now, env, tty });
    assert.ok(!noColorFlag.stdout.includes('\u001b['));
  } finally {
    removeTempDir(dir);
  }
});

test('非 TTY 自动无颜色', async (t) => {
  const stub = await stateStub(t);
  const result = await runMain(['status', '--server', stub.baseUrl], { now });
  assert.ok(!result.stdout.includes('\u001b['));
});

test('-V / --version', async () => {
  const result = await runMain(['-V']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^naiji \d+\.\d+\.\d+\n$/);
});

test('--help / help <command> / <command> --help', async () => {
  const global = await runMain(['--help']);
  assert.equal(global.code, 0);
  assert.match(global.stdout, /用法:/);
  assert.match(global.stdout, /feed, f <ml>/);
  assert.match(global.stdout, /服务器地址优先级/);

  const feed = await runMain(['help', 'feed']);
  assert.equal(feed.code, 0);
  assert.match(feed.stdout, /naiji feed/);
  assert.match(feed.stdout, /--direct/);

  const feedFlag = await runMain(['feed', '--help']);
  assert.equal(feedFlag.code, 0);
  assert.match(feedFlag.stdout, /naiji feed/);

  const unknown = await runMain(['help', 'bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /没有该命令的帮助/);
});

test('用法错误：退出码 2 + 提示', async () => {
  const badAmount = await runMain(['f', 'abc', '--server', 'http://127.0.0.1:1']);
  assert.equal(badAmount.code, 2);
  assert.match(badAmount.stderr, /奶量必须是正整数/);
  assert.match(badAmount.stderr, /提示：/);

  const unknownCommand = await runMain(['bogus']);
  assert.equal(unknownCommand.code, 2);
  assert.match(unknownCommand.stderr, /未知命令：bogus/);

  const badServer = await runMain(['status', '--server', 'ftp://nope']);
  assert.equal(badServer.code, 2);
  assert.match(badServer.stderr, /--server/);
});

test('--json 模式下的用法错误：stderr 为单行 JSON', async () => {
  const result = await runMain(['--json', 'bogus']);
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stderr.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'usage_error');
  assert.match(payload.message, /未知命令/);
});

test('API 错误：退出码 1，stderr 显示后端中文 message', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 400, {
      error: 'invalid_happened_at',
      message: '记录时间不合法（必须是毫秒时间戳，且不能晚于当前时间 5 分钟）',
    });
  });
  t.after(() => stub.close());

  const result = await runMain(['f', '120', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /记录时间不合法/);
});

test('API 错误 --json：stderr 为 JSON（含 error/status）', async (t) => {
  const stub = await startStubServer((record, res) => {
    replyJson(res, 500, { error: 'internal_error', message: '服务器内部错误' });
  });
  t.after(() => stub.close());

  const result = await runMain(['--json', 'status', '--server', stub.baseUrl], { now });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stderr.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'internal_error');
  assert.equal(payload.status, 500);
  assert.equal(payload.message, '服务器内部错误');
});

test('网络错误：退出码 1 + 排查建议（含服务器地址）', async () => {
  const stub = await startStubServer((record, res) => replyJson(res, 200, {}));
  const { baseUrl } = stub;
  await stub.close();

  const result = await runMain(['status', '--server', baseUrl], { now });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /无法连接服务器/);
  assert.match(result.stderr, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stderr, /服务是否已启动/);
  assert.match(result.stderr, /NAIJI_SERVER/);
});

test('NAIJI_SERVER 环境变量作为服务器地址', async (t) => {
  const stub = await stateStub(t);
  const env = makeTestEnv({ NAIJI_SERVER: stub.baseUrl });
  const result = await runMain(['status', '--json'], { env, now });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), FEED_STATE);
});
