/**
 * v1 → v3 / v2 → v3 数据库迁移测试（schema v3）。
 *
 * 手工用 node:sqlite 构造旧库：
 * - v1：旧 events 表（单值 feed_type 列，kind 仅 feed/diaper，user_version = 0）
 * - v2：events 表有 feed_types 列，但 kind CHECK 仅 feed/diaper（user_version = 2）
 * 再用 openDb() 打开，验证数据、id、时间、备注、类型映射、索引、user_version=3 与幂等性，
 * 以及迁移后 kind CHECK 放宽、可以写入 bath。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDb, SCHEMA_VERSION } from '../server/src/db.js';

/** 测试结束自动删除的临时目录 */
function tempDir(t, prefix = 'naiji-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 与 git HEAD 中 v1 src/db.js 完全一致的旧 schema
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('feed', 'diaper')),
  feed_type   TEXT    CHECK (feed_type IN ('formula', 'breast_milk', 'breast_direct')),
  amount_ml   INTEGER CHECK (amount_ml IS NULL OR (amount_ml > 0 AND amount_ml <= 2000)),
  diaper_kind TEXT    CHECK (diaper_kind IN ('pee', 'poop', 'mixed')),
  note        TEXT,
  happened_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  CHECK (
    (kind = 'feed' AND feed_type IS NOT NULL AND diaper_kind IS NULL
      AND (feed_type = 'breast_direct' OR amount_ml IS NOT NULL))
    OR
    (kind = 'diaper' AND diaper_kind IS NOT NULL AND feed_type IS NULL AND amount_ml IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (happened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events (kind, happened_at DESC, id DESC);
`;

// 与 git HEAD 中 v2 src/db.js 完全一致的旧 schema（kind CHECK 仅 feed/diaper）
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('feed', 'diaper')),
  feed_types  TEXT,
  amount_ml   INTEGER CHECK (amount_ml IS NULL OR (amount_ml >= 1 AND amount_ml <= 2000)),
  diaper_kind TEXT    CHECK (diaper_kind IN ('pee', 'poop', 'mixed')),
  note        TEXT,
  happened_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  CHECK (
    (kind = 'feed' AND feed_types IS NOT NULL AND diaper_kind IS NULL)
    OR
    (kind = 'diaper' AND feed_types IS NULL AND amount_ml IS NULL AND diaper_kind IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (happened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events (kind, happened_at DESC, id DESC);
`;

const T0 = 1_763_000_000_000;

// id 故意留出空洞（10），验证迁移保留 id（AUTOINCREMENT 之后从 11 继续）
const V1_ROWS = [
  {
    id: 1,
    kind: 'feed',
    feedType: 'formula',
    amountMl: 120,
    diaperKind: null,
    note: '早上的奶',
    happenedAt: T0,
    createdAt: T0 + 5_000,
  },
  {
    id: 2,
    kind: 'feed',
    feedType: 'breast_milk',
    amountMl: 90,
    diaperKind: null,
    note: null,
    happenedAt: T0 + 60_000,
    createdAt: T0 + 65_000,
  },
  {
    id: 3,
    kind: 'feed',
    feedType: 'breast_direct',
    amountMl: null,
    diaperKind: null,
    note: '亲喂很顺利',
    happenedAt: T0 + 120_000,
    createdAt: T0 + 125_000,
  },
  {
    id: 4,
    kind: 'diaper',
    feedType: null,
    amountMl: null,
    diaperKind: 'pee',
    note: null,
    happenedAt: T0 + 180_000,
    createdAt: T0 + 185_000,
  },
  {
    id: 5,
    kind: 'diaper',
    feedType: null,
    amountMl: null,
    diaperKind: 'poop',
    note: '拉臭臭',
    happenedAt: T0 + 240_000,
    createdAt: T0 + 245_000,
  },
  {
    id: 6,
    kind: 'diaper',
    feedType: null,
    amountMl: null,
    diaperKind: 'mixed',
    note: null,
    happenedAt: T0 + 300_000,
    createdAt: T0 + 305_000,
  },
  {
    id: 10,
    kind: 'feed',
    feedType: 'formula',
    amountMl: 150,
    diaperKind: null,
    note: 'id 有空洞',
    happenedAt: T0 + 360_000,
    createdAt: T0 + 365_000,
  },
];

// v2 旧库固定行：feed_types 已是 JSON 数组文本；id 留空洞（6）
const V2_ROWS = [
  {
    id: 1,
    kind: 'feed',
    feedTypes: ['formula'],
    amountMl: 120,
    diaperKind: null,
    note: '早上的奶',
    happenedAt: T0,
    createdAt: T0 + 5_000,
  },
  {
    id: 2,
    kind: 'feed',
    feedTypes: ['formula', 'breast_milk'],
    amountMl: 150,
    diaperKind: null,
    note: '混合瓶喂',
    happenedAt: T0 + 60_000,
    createdAt: T0 + 65_000,
  },
  {
    id: 3,
    kind: 'feed',
    feedTypes: ['breast_direct'],
    amountMl: null,
    diaperKind: null,
    note: null,
    happenedAt: T0 + 120_000,
    createdAt: T0 + 125_000,
  },
  {
    id: 4,
    kind: 'diaper',
    feedTypes: null,
    amountMl: null,
    diaperKind: 'mixed',
    note: '一次搞定',
    happenedAt: T0 + 180_000,
    createdAt: T0 + 185_000,
  },
  {
    id: 6,
    kind: 'feed',
    feedTypes: ['formula'],
    amountMl: 90,
    diaperKind: null,
    note: 'id 有空洞',
    happenedAt: T0 + 240_000,
    createdAt: T0 + 245_000,
  },
];

/** 手工创建 v1 库并插入固定行；返回文件路径 */
function createV1Db(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(V1_SCHEMA);
    const insert = db.prepare(
      `INSERT INTO events (id, kind, feed_type, amount_ml, diaper_kind, note, happened_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of V1_ROWS) {
      insert.run(
        row.id,
        row.kind,
        row.feedType,
        row.amountMl,
        row.diaperKind,
        row.note,
        row.happenedAt,
        row.createdAt,
      );
    }
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0, 'v1 库 user_version 应为 0');
  } finally {
    db.close();
  }
  return dbPath;
}

/** 手工创建 v2 库（旧 kind CHECK）并插入固定行；返回文件路径 */
function createV2Db(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(V2_SCHEMA);
    // fixture 自校验：旧库的结构确实是 v2（有 feed_types、无 feed_type、kind 仅 feed/diaper）
    const columns = db.prepare('PRAGMA table_info(events)').all().map((row) => row.name);
    assert.ok(columns.includes('feed_types'), 'v2 fixture 应有 feed_types 列');
    assert.ok(!columns.includes('feed_type'), 'v2 fixture 不应有 feed_type 列');
    const schemaSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get().sql;
    assert.match(schemaSql, /kind IN \('feed', 'diaper'\)/, 'v2 fixture 的 kind CHECK 应仅允许 feed/diaper');
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO events (kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at)
             VALUES ('bath', NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run(T0, T0),
      /CHECK/i,
      'v2 旧库不应允许写入 bath（迁移前自校验）',
    );

    const insert = db.prepare(
      `INSERT INTO events (id, kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of V2_ROWS) {
      insert.run(
        row.id,
        row.kind,
        row.feedTypes === null ? null : JSON.stringify(row.feedTypes),
        row.amountMl,
        row.diaperKind,
        row.note,
        row.happenedAt,
        row.createdAt,
      );
    }
    db.exec('PRAGMA user_version = 2');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2, 'v2 库 user_version 应为 2');
  } finally {
    db.close();
  }
  return dbPath;
}

/** 打开已关闭的库读结构信息（不经过 Store） */
function readSchema(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      userVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
      columns: db.prepare('PRAGMA table_info(events)').all().map((row) => row.name),
      tables: db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
      indexes: db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name")
        .all()
        .map((row) => ({ name: row.name, sql: row.sql ?? '' })),
      tableSql: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get().sql,
    };
  } finally {
    db.close();
  }
}

/** 断言 schema 已是 v3（版本号、列、索引、无备份表、kind CHECK 含 bath） */
function assertV3Schema(dbPath, label = '') {
  assert.equal(SCHEMA_VERSION, 3, 'schema 版本常量应为 3');
  const schema = readSchema(dbPath);
  assert.equal(schema.userVersion, 3, `${label}user_version 应为 3`);
  assert.ok(schema.columns.includes('feed_types'), `${label}events 应有 feed_types 列`);
  assert.ok(!schema.columns.includes('feed_type'), `${label}events 不应再有 feed_type 列`);
  assert.ok(!schema.tables.includes('events_v1_backup'), `${label}迁移后不应残留 events_v1_backup 表`);
  assert.ok(!schema.tables.includes('events_v2_backup'), `${label}迁移后不应残留 events_v2_backup 表`);
  assert.match(schema.tableSql, /kind IN \('feed', 'diaper', 'bath'\)/, `${label}kind CHECK 应允许 bath`);
  assert.deepEqual(
    schema.indexes.map((index) => index.name).sort(),
    ['idx_events_kind_time', 'idx_events_time'],
    `${label}迁移后索引应存在且只有两个`,
  );
  const byName = new Map(schema.indexes.map((index) => [index.name, index.sql]));
  assert.match(byName.get('idx_events_time'), /happened_at DESC,\s*id DESC/i);
  assert.match(byName.get('idx_events_kind_time'), /kind,\s*happened_at DESC,\s*id DESC/i);
  return schema;
}

/** 期望的 v3 事件（与 V1_ROWS 一一对应） */
function expectedV3FromV1(row) {
  const isFeed = row.kind === 'feed';
  return {
    id: row.id,
    kind: row.kind,
    feedTypes: isFeed ? [row.feedType] : null,
    amountMl: isFeed ? row.amountMl : null,
    diaperKind: row.diaperKind,
    note: row.note,
    happenedAt: row.happenedAt,
    createdAt: row.createdAt,
  };
}

/** 期望的 v3 事件（与 V2_ROWS 一一对应，v2→v3 数据原样保留） */
function expectedV3FromV2(row) {
  return {
    id: row.id,
    kind: row.kind,
    feedTypes: row.feedTypes,
    amountMl: row.amountMl,
    diaperKind: row.diaperKind,
    note: row.note,
    happenedAt: row.happenedAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// v1 → v3
// ---------------------------------------------------------------------------

describe('openDb · v1 → v3 迁移', () => {
  test('v1 旧库迁移后记录数、id、时间、备注全部保留，类型归一化为 feedTypes 数组', (t) => {
    const dir = tempDir(t, 'naiji-mig-');
    const dbPath = createV1Db(path.join(dir, 'v1.db'));

    const store = openDb(dbPath);
    let closed = false;
    t.after(() => {
      if (!closed) store.close();
    });

    const events = store.allEvents();
    assert.equal(events.length, V1_ROWS.length, '迁移后记录数不应变化');
    assert.deepEqual(
      events.map((event) => event.id),
      V1_ROWS.map((row) => row.id),
      'id 应保留（含空洞）',
    );
    assert.deepEqual(events, V1_ROWS.map(expectedV3FromV1), '每条记录的内容应完整迁移');

    // 逐条断言关键字段（防止 deepEqual 掩盖问题时的可读性）
    const formula = store.getEvent(1);
    assert.deepEqual(formula.feedTypes, ['formula']);
    assert.equal(formula.amountMl, 120);
    assert.equal(formula.diaperKind, null);

    const breastMilk = store.getEvent(2);
    assert.deepEqual(breastMilk.feedTypes, ['breast_milk']);
    assert.equal(breastMilk.amountMl, 90);
    assert.equal(breastMilk.note, null);

    const direct = store.getEvent(3);
    assert.deepEqual(direct.feedTypes, ['breast_direct'], '亲喂应映射为 ["breast_direct"]');
    assert.equal(direct.amountMl, null, '亲喂 amount 应保持 null');
    assert.equal(direct.note, '亲喂很顺利');

    assert.equal(store.getEvent(4).diaperKind, 'pee');
    assert.equal(store.getEvent(5).diaperKind, 'poop');
    assert.equal(store.getEvent(6).diaperKind, 'mixed');
    assert.equal(store.getEvent(10).note, 'id 有空洞');

    // 数据库内实际存储的是 JSON 数组文本（规范顺序）
    const raw = store.db.prepare('SELECT feed_types FROM events WHERE id = 1').get();
    assert.equal(raw.feed_types, '["formula"]');
    const rawDirect = store.db.prepare('SELECT feed_types FROM events WHERE id = 3').get();
    assert.equal(rawDirect.feed_types, '["breast_direct"]');

    store.close();
    closed = true;
    assertV3Schema(dbPath, '首次迁移后 ');
  });

  test('重复 openDb 幂等：不重复插入、数据不变、索引与版本号保持', (t) => {
    const dir = tempDir(t, 'naiji-mig-');
    const dbPath = createV1Db(path.join(dir, 'v1.db'));

    const first = openDb(dbPath);
    const firstEvents = first.allEvents();
    const firstSchema = readSchema(dbPath);
    first.close();

    // 第二次、第三次打开
    const second = openDb(dbPath);
    const secondEvents = second.allEvents();
    second.close();
    const third = openDb(dbPath);
    const thirdEvents = third.allEvents();
    third.close();

    assert.equal(secondEvents.length, V1_ROWS.length);
    assert.equal(thirdEvents.length, V1_ROWS.length);
    assert.deepEqual(secondEvents, firstEvents);
    assert.deepEqual(thirdEvents, firstEvents);
    assert.deepEqual(readSchema(dbPath), firstSchema, '重复打开后 schema 不应变化');
    assertV3Schema(dbPath, '重复打开后 ');
  });

  test('迁移后继续写入：id 接续旧 id、多标签按规范顺序存储、可写 bath', (t) => {
    const dir = tempDir(t, 'naiji-mig-');
    const dbPath = createV1Db(path.join(dir, 'v1.db'));

    let store = openDb(dbPath);
    const created = store.createFeedEvent({
      feedTypes: ['breast_direct', 'formula'],
      amountMl: 60,
      note: '迁移后新记录',
      happenedAt: T0 + 420_000,
      createdAt: T0 + 425_000,
    });
    assert.equal(created.id, 11, 'AUTOINCREMENT 应接续迁移前的最大 id(10)');
    assert.deepEqual(created.feedTypes, ['formula', 'breast_direct'], '应按规范顺序存储');

    // v1 库结构原本不允许 bath，迁移后 kind CHECK 放宽
    const bath = store.createBathEvent({
      note: '洗澡',
      happenedAt: T0 + 480_000,
      createdAt: T0 + 485_000,
    });
    assert.equal(bath.id, 12);
    assert.deepEqual(bath, {
      id: 12,
      kind: 'bath',
      feedTypes: null,
      amountMl: null,
      diaperKind: null,
      note: '洗澡',
      happenedAt: T0 + 480_000,
      createdAt: T0 + 485_000,
    });
    store.close();

    store = openDb(dbPath);
    t.after(() => store.close());
    assert.equal(store.allEvents().length, V1_ROWS.length + 2);
    const raw = store.db.prepare('SELECT feed_types, amount_ml FROM events WHERE id = 11').get();
    assert.equal(raw.feed_types, '["formula","breast_direct"]');
    assert.equal(raw.amount_ml, 60);
    assertV3Schema(dbPath, '二次打开后 ');

    // 迁移没有被再次执行（不会重复插入）
    assert.equal(store.allEvents().filter((event) => event.id === 11).length, 1);
    assert.equal(store.allEvents().filter((event) => event.id === 12).length, 1);
  });
});

// ---------------------------------------------------------------------------
// v2 → v3
// ---------------------------------------------------------------------------

describe('openDb · v2 → v3 迁移', () => {
  test('v2 旧库（kind CHECK 仅 feed/diaper）迁移后数据原样保留、结构升级到 v3', (t) => {
    const dir = tempDir(t, 'naiji-mig-v2-');
    const dbPath = createV2Db(path.join(dir, 'v2.db'));

    // 迁移前确认：v2 库结构（有 feed_types、kind 无 bath）
    const before = readSchema(dbPath);
    assert.equal(before.userVersion, 2);
    assert.ok(before.columns.includes('feed_types'));

    const store = openDb(dbPath);
    let closed = false;
    t.after(() => {
      if (!closed) store.close();
    });

    const events = store.allEvents();
    assert.equal(events.length, V2_ROWS.length, '迁移后记录数不应变化');
    assert.deepEqual(events, V2_ROWS.map(expectedV3FromV2), 'v2 数据应原样保留（id/时间/备注/feedTypes）');
    assert.deepEqual(
      events.map((event) => event.id),
      V2_ROWS.map((row) => row.id),
      'id 应保留（含空洞）',
    );
    assert.deepEqual(events.find((event) => event.id === 2).feedTypes, ['formula', 'breast_milk']);
    assert.equal(events.find((event) => event.id === 4).diaperKind, 'mixed');

    store.close();
    closed = true;
    assertV3Schema(dbPath, 'v2 迁移后 ');
  });

  test('v2 迁移后可写入 bath：Event 业务字段全 null、note/时间正确、id 接续', (t) => {
    const dir = tempDir(t, 'naiji-mig-v2-');
    const dbPath = createV2Db(path.join(dir, 'v2.db'));

    const store = openDb(dbPath);
    t.after(() => store.close());

    // 旧 v2 最大 id 为 6（有空洞）
    const bath = store.createBathEvent({
      note: '洗香香',
      happenedAt: T0 + 300_000,
      createdAt: T0 + 305_000,
    });
    assert.equal(bath.id, 7, 'AUTOINCREMENT 应接续 v2 最大 id(6)');
    assert.deepEqual(bath, {
      id: 7,
      kind: 'bath',
      feedTypes: null,
      amountMl: null,
      diaperKind: null,
      note: '洗香香',
      happenedAt: T0 + 300_000,
      createdAt: T0 + 305_000,
    });
    assert.equal(store.lastEvent('bath').id, 7, '迁移后 lastEvent(bath) 可用');

    // 迁移后 feed / diaper 仍可正常写入
    const feed = store.createFeedEvent({
      feedTypes: ['breast_milk', 'formula'],
      amountMl: 100,
      happenedAt: T0 + 360_000,
      createdAt: T0 + 365_000,
    });
    assert.equal(feed.id, 8);
    assert.deepEqual(feed.feedTypes, ['formula', 'breast_milk']);
    const diaper = store.createDiaperEvent({ diaperKind: 'poop', happenedAt: T0 + 420_000, createdAt: T0 + 425_000 });
    assert.equal(diaper.id, 9);

    assert.equal(store.allEvents().length, V2_ROWS.length + 3);
  });

  test('v2 库重复 openDb 幂等：不重复建表/搬迁、数据与 schema 不变、迁移后新记录保留', (t) => {
    const dir = tempDir(t, 'naiji-mig-v2-');
    const dbPath = createV2Db(path.join(dir, 'v2.db'));

    const first = openDb(dbPath);
    const firstEvents = first.allEvents();
    const firstSchema = readSchema(dbPath);
    const bath = first.createBathEvent({ note: '一次', happenedAt: T0 + 300_000, createdAt: T0 + 305_000 });
    first.close();

    const second = openDb(dbPath);
    const secondEvents = second.allEvents();
    const secondSchema = readSchema(dbPath);
    second.close();

    const third = openDb(dbPath);
    const thirdEvents = third.allEvents();
    third.close();

    assert.equal(firstEvents.length, V2_ROWS.length, '首次打开后仍是原 v2 数据');
    assert.equal(secondEvents.length, V2_ROWS.length + 1, 'bath 记录应在重开后保留');
    assert.deepEqual(thirdEvents, secondEvents);
    assert.equal(secondEvents.at(-1).kind, 'bath');
    assert.equal(secondEvents.at(-1).id, bath.id);
    assert.equal(secondSchema.userVersion, 3);
    assert.deepEqual(secondSchema, firstSchema, '重复打开后 schema 不应变化');
    assertV3Schema(dbPath, '重复打开后 ');
  });
});

// ---------------------------------------------------------------------------
// 全新库
// ---------------------------------------------------------------------------

describe('openDb · 全新 v3 库', () => {
  test('不存在时创建 v3 库：版本=3、列/索引/kind CHECK 正确，feed/diaper/bath 均可写', (t) => {
    const dir = tempDir(t, 'naiji-fresh-');
    const dbPath = path.join(dir, 'nested', 'dir', 'fresh.db');

    let store = openDb(dbPath);
    const feed = store.createFeedEvent({
      feedTypes: ['breast_milk', 'formula'],
      amountMl: 120,
      happenedAt: T0,
      createdAt: T0,
    });
    assert.deepEqual(feed.feedTypes, ['formula', 'breast_milk']);
    const diaper = store.createDiaperEvent({
      diaperKind: 'mixed',
      note: '一次搞定',
      happenedAt: T0 + 1,
      createdAt: T0 + 1,
    });
    assert.equal(diaper.kind, 'diaper');
    assert.equal(diaper.feedTypes, null);
    assert.equal(diaper.amountMl, null);
    const bath = store.createBathEvent({ note: '洗澡', happenedAt: T0 + 2, createdAt: T0 + 2 });
    assert.equal(bath.kind, 'bath');
    assert.equal(bath.feedTypes, null);
    assert.equal(bath.amountMl, null);
    assert.equal(bath.diaperKind, null);
    store.close();

    assertV3Schema(dbPath, '新建库 ');

    store = openDb(dbPath);
    t.after(() => store.close());
    assert.equal(store.allEvents().length, 3);
    assert.deepEqual(store.allEvents().map((event) => event.id), [1, 2, 3]);
    assert.deepEqual(store.allEvents().map((event) => event.kind), ['feed', 'diaper', 'bath']);
  });

  test(':memory: 数据库可直接使用（v3、可写 bath）', (t) => {
    const store = openDb(':memory:');
    t.after(() => store.close());
    assert.deepEqual(store.allEvents(), []);
    const created = store.createDiaperEvent({ diaperKind: 'pee', happenedAt: T0, createdAt: T0 });
    assert.equal(created.kind, 'diaper');
    const bath = store.createBathEvent({ happenedAt: T0 + 1, createdAt: T0 + 1 });
    assert.equal(bath.kind, 'bath');
    assert.equal(store.allEvents().length, 2);
  });
});
