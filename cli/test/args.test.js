import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiaperRequest,
  buildFeedRequest,
  ensureNoPositionals,
  parseAmountMl,
  parseArgs,
  parseAtValue,
  parseEventId,
  parseFeedTypes,
  parseLimit,
  parseTimeOptions,
} from '../src/args.mjs';
import { UsageError } from '../src/errors.mjs';

const MINUTE = 60_000;
// 固定「现在」：2026-11-13 22:00（本地时区）
const NOW = new Date(2026, 10, 13, 22, 0, 0, 0).getTime();

function parse(argv) {
  return parseArgs(argv);
}

function assertUsageError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof UsageError, `期望 UsageError，实际：${error?.name}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 基础解析
// ---------------------------------------------------------------------------

test('无参数默认 status', () => {
  const parsed = parse([]);
  assert.equal(parsed.command, 'status');
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.options.json, false);
});

test('只带全局选项也默认 status', () => {
  const parsed = parse(['--json', '--no-color']);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.noColor, true);
});

test('命令别名', () => {
  const cases = [
    [['s'], 'status'],
    [['f', '120'], 'feed'],
    [['p'], 'pee'],
    [['o'], 'poop'],
    [['d', 'poop'], 'diaper'],
    [['l'], 'log'],
    [['u'], 'undo'],
    [['c'], 'config'],
    [['today'], 'today'],
    [['rm', '3'], 'rm'],
    [['export'], 'export'],
    [['help', 'feed'], 'help'],
  ];
  for (const [argv, expected] of cases) {
    assert.equal(parse(argv).command, expected, `${argv.join(' ')} → ${expected}`);
  }
});

test('选项可出现在命令前后、支持 --opt=value', () => {
  const parsed = parse(['--json', 'feed', '120', '-t', 'formula', '--note=hi', '--direct']);
  assert.equal(parsed.command, 'feed');
  assert.deepEqual(parsed.positionals, ['120']);
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.options.types, ['formula']);
  assert.equal(parsed.options.note, 'hi');
  assert.equal(parsed.options.direct, true);

  const parsed2 = parse(['feed', '120', '--server=http://127.0.0.1:3000']);
  assert.equal(parsed2.options.server, 'http://127.0.0.1:3000');
});

test('-t / --type 可重复收集原始值', () => {
  const parsed = parse(['feed', '60', '-t', 'formula', '--type', 'breast_direct', '-t', '奶粉,breast_milk']);
  assert.deepEqual(parsed.options.types, ['formula', 'breast_direct', '奶粉,breast_milk']);
});

test('-- 之后全部视为位置参数', () => {
  const parsed = parse(['feed', '--', '120']);
  assert.equal(parsed.command, 'feed');
  assert.deepEqual(parsed.positionals, ['120']);
});

test('非法选项 / 缺少选项值 / 重复单值选项都报用法错误', () => {
  assertUsageError(() => parse(['--bogus']), /未知选项/);
  assertUsageError(() => parse(['feed', '--server']), /需要一个值/);
  assertUsageError(() => parse(['feed', '120', '--note', 'a', '--note', 'b']), /只能出现一次/);
  assertUsageError(() => parse(['--json=1']), /不接受值/);
});

test('未知命令报用法错误；纯数字命令给出 feed 提示', () => {
  assertUsageError(() => parse(['bogus']), /未知命令：bogus/);
  try {
    parse(['120']);
    assert.fail('应当抛错');
  } catch (error) {
    assert.match(error.hint, /naiji feed 120/);
  }
});

test('命令级选项校验：命令不支持的选项报错', () => {
  assertUsageError(() => parse(['status', '--note', 'x']), /不支持选项/);
  assertUsageError(() => parse(['log', '--ago', '5']), /不支持选项/);
  assertUsageError(() => parse(['undo', '--out', 'x']), /不支持选项/);
});

test('--help / --version 优先，不校验参数', () => {
  const parsed = parse(['feed', '--help']);
  assert.equal(parsed.command, 'feed');
  assert.equal(parsed.options.help, true);

  const version = parse(['-V']);
  assert.equal(version.options.version, true);

  const unknownWithHelp = parse(['bogus', '-h']);
  assert.equal(unknownWithHelp.command, null);
  assert.equal(unknownWithHelp.options.help, true);
});

test('ensureNoPositionals', () => {
  assert.doesNotThrow(() => ensureNoPositionals('status', []));
  assertUsageError(() => ensureNoPositionals('status', ['x']), /不接受参数/);
});

// ---------------------------------------------------------------------------
// 喂奶类型
// ---------------------------------------------------------------------------

test('parseFeedTypes：英文 / 中文 / 单字母别名', () => {
  assert.deepEqual(parseFeedTypes(['formula']), ['formula']);
  assert.deepEqual(parseFeedTypes(['奶粉']), ['formula']);
  assert.deepEqual(parseFeedTypes(['母乳']), ['breast_milk']);
  assert.deepEqual(parseFeedTypes(['亲喂']), ['breast_direct']);
  assert.deepEqual(parseFeedTypes(['f']), ['formula']);
  assert.deepEqual(parseFeedTypes(['b']), ['breast_milk']);
  assert.deepEqual(parseFeedTypes(['d']), ['breast_direct']);
  assert.deepEqual(parseFeedTypes(['FORMULA']), ['formula']);
});

test('parseFeedTypes：逗号列表 + 重复 + 去重 + 规范顺序', () => {
  assert.deepEqual(parseFeedTypes(['breast_direct,formula']), ['formula', 'breast_direct']);
  assert.deepEqual(parseFeedTypes(['formula', 'formula', 'breast_milk']), ['formula', 'breast_milk']);
  assert.deepEqual(parseFeedTypes([' 奶粉 , 亲喂 ']), ['formula', 'breast_direct']);
  assert.deepEqual(parseFeedTypes([]), []);
});

test('parseFeedTypes：非法类型报用法错误', () => {
  assertUsageError(() => parseFeedTypes(['water']), /未知的喂奶类型/);
});

// ---------------------------------------------------------------------------
// 奶量 / 时间
// ---------------------------------------------------------------------------

test('parseAmountMl：1–2000 的整数', () => {
  assert.equal(parseAmountMl('1'), 1);
  assert.equal(parseAmountMl('120'), 120);
  assert.equal(parseAmountMl('2000'), 2000);
  for (const bad of ['0', '2001', 'abc', '1.5', '-5', '', '  ']) {
    assertUsageError(() => parseAmountMl(bad), /奶量/);
  }
});

test('parseAtValue：HH:MM 与绝对日期时间', () => {
  assert.deepEqual(parseAtValue('08:30'), { type: 'clock', hour: 8, minute: 30 });
  assert.deepEqual(parseAtValue('8:05'), { type: 'clock', hour: 8, minute: 5 });
  const absolute = parseAtValue('2026-01-10 20:30');
  assert.equal(absolute.type, 'absolute');
  assert.equal(absolute.ts, new Date(2026, 0, 10, 20, 30, 0, 0).getTime());
  const isoLike = parseAtValue('2026-01-10T20:30');
  assert.equal(isoLike.ts, new Date(2026, 0, 10, 20, 30, 0, 0).getTime());
});

test('parseAtValue：非法值报用法错误', () => {
  for (const bad of ['25:00', '08:60', 'foo', '2026-02-30 10:00', '2026-13-01 10:00', '2026-01-10', '']) {
    assertUsageError(() => parseAtValue(bad), /--at/);
  }
});

test('parseTimeOptions：--ago 分钟', () => {
  assert.equal(parseTimeOptions({ ago: '30' }, NOW), NOW - 30 * MINUTE);
  assert.equal(parseTimeOptions({ ago: '0' }, NOW), NOW);
  assert.equal(parseTimeOptions({}, NOW), undefined);
});

test('parseTimeOptions：--at HH:MM = 今天该时刻', () => {
  assert.equal(
    parseTimeOptions({ at: '08:30' }, NOW),
    new Date(2026, 10, 13, 8, 30, 0, 0).getTime(),
  );
});

test('parseTimeOptions：--at 绝对时间', () => {
  assert.equal(
    parseTimeOptions({ at: '2026-01-10 20:30' }, NOW),
    new Date(2026, 0, 10, 20, 30, 0, 0).getTime(),
  );
});

test('parseTimeOptions：非法 / 未来时间报用法错误', () => {
  assertUsageError(() => parseTimeOptions({ ago: 'abc' }, NOW), /--ago/);
  assertUsageError(() => parseTimeOptions({ ago: '-5' }, NOW), /--ago/);
  assertUsageError(() => parseTimeOptions({ ago: '30', at: '08:30' }, NOW), /不能同时使用/);
  assertUsageError(() => parseTimeOptions({ at: '23:59' }, NOW), /在未来/);
  assertUsageError(() => parseTimeOptions({ at: '2027-01-01 00:00' }, NOW), /在未来/);
  assertUsageError(() => parseTimeOptions({ ago: '99999999' }, NOW), /2000-01-01/);
});

// ---------------------------------------------------------------------------
// buildFeedRequest
// ---------------------------------------------------------------------------

test('buildFeedRequest：默认奶粉 + 奶量', () => {
  const body = buildFeedRequest(parse(['feed', '120']), NOW);
  assert.deepEqual(body, { feedTypes: ['formula'], amountMl: 120 });
});

test('buildFeedRequest：多标签（重复 -t）+ 总奶量，按规范顺序', () => {
  const body = buildFeedRequest(parse(['feed', '60', '-t', 'breast_direct', '-t', 'formula']), NOW);
  assert.deepEqual(body, { feedTypes: ['formula', 'breast_direct'], amountMl: 60 });
});

test('buildFeedRequest：逗号列表 + 中文别名', () => {
  const body = buildFeedRequest(parse(['f', '60', '-t', '奶粉,亲喂']), NOW);
  assert.deepEqual(body.feedTypes, ['formula', 'breast_direct']);
  assert.equal(body.amountMl, 60);
});

test('buildFeedRequest：--direct 追加亲喂标签', () => {
  const body = buildFeedRequest(parse(['f', '60', '-t', 'formula', '--direct']), NOW);
  assert.deepEqual(body, { feedTypes: ['formula', 'breast_direct'], amountMl: 60 });
});

test('buildFeedRequest：仅亲喂（--direct 无奶量 / -t breast_direct）', () => {
  assert.deepEqual(buildFeedRequest(parse(['f', '--direct']), NOW), { feedTypes: ['breast_direct'] });
  assert.deepEqual(buildFeedRequest(parse(['f', '-t', '亲喂']), NOW), { feedTypes: ['breast_direct'] });
});

test('buildFeedRequest：--note / --ago / --at 写入请求体', () => {
  const withNote = buildFeedRequest(parse(['f', '90', '--note', '  夜里那次  ']), NOW);
  assert.equal(withNote.note, '夜里那次');

  const withAgo = buildFeedRequest(parse(['f', '90', '--ago', '30']), NOW);
  assert.equal(withAgo.happenedAt, NOW - 30 * MINUTE);

  const withAt = buildFeedRequest(parse(['f', '90', '--at', '08:30']), NOW);
  assert.equal(withAt.happenedAt, new Date(2026, 10, 13, 8, 30, 0, 0).getTime());
});

test('buildFeedRequest：奶量与标签不匹配时报用法错误', () => {
  assertUsageError(() => buildFeedRequest(parse(['feed']), NOW), /需要奶量/);
  assertUsageError(() => buildFeedRequest(parse(['feed', '-t', 'formula']), NOW), /需要奶量/);
  assertUsageError(() => buildFeedRequest(parse(['feed', '60', '-t', 'breast_direct']), NOW), /不需要奶量/);
  assertUsageError(() => buildFeedRequest(parse(['feed', '60', '--direct']), NOW), /不需要奶量/);
  assertUsageError(() => buildFeedRequest(parse(['feed', '60', '70']), NOW), /只接受一个奶量参数/);
  assertUsageError(
    () => buildFeedRequest(parse(['feed', '60', '--note', 'x'.repeat(201)]), NOW),
    /备注不能超过/,
  );
});

// ---------------------------------------------------------------------------
// buildDiaperRequest
// ---------------------------------------------------------------------------

test('buildDiaperRequest：pee / poop / diaper 三种入口', () => {
  assert.deepEqual(buildDiaperRequest(parse(['pee']), NOW), { diaperKind: 'pee' });
  assert.deepEqual(buildDiaperRequest(parse(['poop']), NOW), { diaperKind: 'poop' });
  assert.deepEqual(buildDiaperRequest(parse(['d', 'mixed']), NOW), { diaperKind: 'mixed' });
  assert.deepEqual(buildDiaperRequest(parse(['d', '大便']), NOW), { diaperKind: 'poop' });
});

test('buildDiaperRequest：--note / --ago 写入请求体', () => {
  const body = buildDiaperRequest(parse(['p', '--note', '挺多', '--ago', '10']), NOW);
  assert.deepEqual(body, {
    diaperKind: 'pee',
    note: '挺多',
    happenedAt: NOW - 10 * MINUTE,
  });
});

test('buildDiaperRequest：非法类型 / 缺少类型 / 多余参数报用法错误', () => {
  assertUsageError(() => buildDiaperRequest(parse(['d']), NOW), /需要指定类型/);
  assertUsageError(() => buildDiaperRequest(parse(['d', 'wet']), NOW), /未知的大小便类型/);
  assertUsageError(() => buildDiaperRequest(parse(['d', 'pee', 'poop']), NOW), /只接受一个类型/);
  assertUsageError(() => buildDiaperRequest(parse(['p', 'extra']), NOW), /不接受参数/);
});

// ---------------------------------------------------------------------------
// log 条数 / rm id
// ---------------------------------------------------------------------------

test('parseLimit', () => {
  assert.equal(parseLimit(undefined), 10);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('200'), 200);
  assertUsageError(() => parseLimit('0'), /1 到 200/);
  assertUsageError(() => parseLimit('201'), /1 到 200/);
  assertUsageError(() => parseLimit('abc'), /整数/);
});

test('parseEventId', () => {
  assert.equal(parseEventId('12'), 12);
  assertUsageError(() => parseEventId('0'), /正整数/);
  assertUsageError(() => parseEventId('-3'), /正整数/);
  assertUsageError(() => parseEventId('abc'), /正整数/);
});
