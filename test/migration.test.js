/**
 * v1 → v2 数据库迁移测试。
 *
 * 手工用 node:sqlite 构造 v1 库（旧 events 表：feed_type 单值列，user_version = 0），
 * 再用 openDb() 打开，验证数据、id、时间、备注、类型映射、索引、user_version 与幂等性。
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
    };
  } finally {
    db.close();
  }
}

function assertV2Schema(dbPath, label = '') {
  const schema = readSchema(dbPath);
  assert.equal(schema.userVersion, SCHEMA_VERSION, `${label}user_version 应为 ${SCHEMA_VERSION}`);
  assert.ok(schema.columns.includes('feed_types'), `${label}events 应有 feed_types 列`);
  assert.ok(!schema.columns.includes('feed_type'), `${label}events 不应再有 feed_type 列`);
  assert.ok(!schema.tables.includes('events_v1_backup'), `${label}迁移后不应残留 events_v1_backup 表`);
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

/** 期望的 v2 事件（与 V1_ROWS 一一对应） */
function expectedV2(row) {
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

describe('openDb · v1 → v2 迁移', () => {
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
    assert.deepEqual(events, V1_ROWS.map(expectedV2), '每条记录的内容应完整迁移');

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
    assertV2Schema(dbPath, '首次迁移后 ');
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
    assertV2Schema(dbPath, '重复打开后 ');
  });

  test('迁移后继续写入：自动递增 id 接续旧 id、多标签按规范顺序存储', (t) => {
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
    store.close();

    store = openDb(dbPath);
    t.after(() => store.close());
    assert.equal(store.allEvents().length, V1_ROWS.length + 1);
    const raw = store.db.prepare('SELECT feed_types, amount_ml FROM events WHERE id = 11').get();
    assert.equal(raw.feed_types, '["formula","breast_direct"]');
    assert.equal(raw.amount_ml, 60);
    assertV2Schema(dbPath, '二次打开后 ');

    // 迁移没有被再次执行（不会重复插入）
    assert.equal(store.allEvents().filter((event) => event.id === 11).length, 1);
  });
});

describe('openDb · 全新 v2 库', () => {
  test('不存在时创建 v2 库：版本、列、索引正确，重复打开幂等', (t) => {
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
    store.close();

    assertV2Schema(dbPath, '新建库 ');

    store = openDb(dbPath);
    t.after(() => store.close());
    assert.equal(store.allEvents().length, 2);
    assert.deepEqual(store.allEvents().map((event) => event.id), [1, 2]);
  });

  test(':memory: 数据库可直接使用', (t) => {
    const store = openDb(':memory:');
    t.after(() => store.close());
    assert.deepEqual(store.allEvents(), []);
    const created = store.createDiaperEvent({ diaperKind: 'pee', happenedAt: T0, createdAt: T0 });
    assert.equal(created.kind, 'diaper');
    assert.equal(store.allEvents().length, 1);
  });
});
