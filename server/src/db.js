/**
 * 奶记 · SQLite 数据层（node:sqlite，零依赖）
 *
 * schema v3：单表 events，kind 支持 feed / diaper / bath；
 * 喂奶类型存 feed_types JSON 数组（多选标签），奶量为「本次喂奶总奶量」。
 * 打开旧库时自动迁移：v1（单值 feed_type 列）→ v3，v2（kind 仅 feed/diaper）→ v3。
 * 详见 docs/CONTRACT.md。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { sortFeedTypes } from './feed-types.js';

export const SCHEMA_VERSION = 3;

const EVENTS_TABLE_V3 = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('feed', 'diaper', 'bath')),
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
    OR
    (kind = 'bath' AND feed_types IS NULL AND amount_ml IS NULL AND diaper_kind IS NULL)
  )
);
`;

const EVENTS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_time ON events (happened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events (kind, happened_at DESC, id DESC);
`;

function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function getUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/** 事务内执行迁移步骤 */
function runInTransaction(db, step) {
  db.exec('BEGIN');
  try {
    step();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** v1：单值 feed_type 列 → v3（feed_types JSON 数组 + 支持 bath） */
function migrateFromV1(db) {
  const columns = tableInfo(db, 'events');
  if (!columns.includes('feed_type')) {
    throw new Error('无法识别的 events 表结构（缺少 feed_type / feed_types 列），拒绝迁移');
  }

  runInTransaction(db, () => {
    db.exec('ALTER TABLE events RENAME TO events_v1_backup');
    db.exec(EVENTS_TABLE_V3);

    // 大小便记录直接搬
    db.exec(`
      INSERT INTO events (id, kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at)
      SELECT id, kind, NULL, NULL, diaper_kind, note, happened_at, created_at
      FROM events_v1_backup WHERE kind = 'diaper'
    `);

    // 喂奶记录：feed_type → feed_types JSON 数组（v1 每条只有一个类型）
    const feedRows = db.prepare("SELECT * FROM events_v1_backup WHERE kind = 'feed'").all();
    const insert = db.prepare(`
      INSERT INTO events (id, kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at)
      VALUES (?, 'feed', ?, ?, NULL, ?, ?, ?)
    `);
    for (const row of feedRows) {
      const types = sortFeedTypes([row.feed_type]);
      insert.run(
        row.id,
        JSON.stringify(types.length > 0 ? types : ['formula']),
        row.amount_ml ?? null,
        row.note ?? null,
        row.happened_at,
        row.created_at,
      );
    }

    db.exec('DROP TABLE events_v1_backup');
    db.exec(EVENTS_INDEXES);
  });
}

/** v2：kind 仅允许 feed/diaper，需要重建表以放宽 CHECK（新增 bath），结构不变、数据原样搬 */
function migrateFromV2(db) {
  runInTransaction(db, () => {
    db.exec('ALTER TABLE events RENAME TO events_v2_backup');
    db.exec(EVENTS_TABLE_V3);
    db.exec(`
      INSERT INTO events (id, kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at)
      SELECT id, kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at
      FROM events_v2_backup
    `);
    db.exec('DROP TABLE events_v2_backup');
    db.exec(EVENTS_INDEXES);
  });
}

/**
 * 建表 / 迁移到 v3。迁移均在事务内完成，重复打开幂等：
 * - 无表 → 建 v3
 * - v1（无 feed_types 列）→ v3
 * - v2（有 feed_types 列但版本 < 3）→ 重建表放宽 kind CHECK
 */
function ensureSchema(db) {
  const version = getUserVersion(db);
  const hasEvents = tableExists(db, 'events');

  if (!hasEvents) {
    runInTransaction(db, () => {
      db.exec(EVENTS_TABLE_V3);
      db.exec(EVENTS_INDEXES);
    });
    return;
  }

  const columns = tableInfo(db, 'events');
  if (!columns.includes('feed_types')) {
    migrateFromV1(db);
    return;
  }

  if (version < SCHEMA_VERSION) {
    migrateFromV2(db);
    return;
  }

  // 已经是 v3：只补索引
  db.exec(EVENTS_INDEXES);
}

function parseFeedTypes(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const types = sortFeedTypes(parsed);
    return types.length > 0 ? types : null;
  } catch {
    return null;
  }
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    feedTypes: parseFeedTypes(row.feed_types),
    amountMl: row.amount_ml ?? null,
    diaperKind: row.diaper_kind ?? null,
    note: row.note ?? null,
    happenedAt: Number(row.happened_at),
    createdAt: Number(row.created_at),
  };
}

export class Store {
  /** @param {DatabaseSync} db */
  constructor(db) {
    this.db = db;
    this.stmts = {
      insert: db.prepare(
        'INSERT INTO events (kind, feed_types, amount_ml, diaper_kind, note, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      byId: db.prepare('SELECT * FROM events WHERE id = ?'),
      latest: db.prepare('SELECT * FROM events ORDER BY happened_at DESC, id DESC LIMIT ?'),
      latestBefore: db.prepare(
        'SELECT * FROM events WHERE (happened_at < ? OR (happened_at = ? AND id < ?)) ORDER BY happened_at DESC, id DESC LIMIT ?',
      ),
      lastOfKind: db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY happened_at DESC, id DESC LIMIT 1'),
      between: db.prepare(
        'SELECT * FROM events WHERE happened_at >= ? AND happened_at < ? ORDER BY happened_at ASC, id ASC',
      ),
      remove: db.prepare('DELETE FROM events WHERE id = ?'),
      allAsc: db.prepare('SELECT * FROM events ORDER BY happened_at ASC, id ASC'),
    };
  }

  /**
   * 底层创建事件：feed 传 feedTypes/amountMl，diaper 传 diaperKind，bath 两者都不传。
   * @param {{ kind: 'feed'|'diaper'|'bath', feedTypes?: string[]|null, amountMl?: number|null,
   *           diaperKind?: string|null, note?: string|null, happenedAt: number, createdAt?: number }} input
   */
  createEvent(input) {
    const isFeed = input.kind === 'feed';
    const isDiaper = input.kind === 'diaper';
    const kind = isFeed ? 'feed' : isDiaper ? 'diaper' : 'bath';
    const types = isFeed ? sortFeedTypes(input.feedTypes ?? []) : null;
    const info = this.stmts.insert.run(
      kind,
      isFeed ? JSON.stringify(types) : null,
      isFeed ? (input.amountMl ?? null) : null,
      isDiaper ? (input.diaperKind ?? null) : null,
      input.note ?? null,
      input.happenedAt,
      input.createdAt ?? Date.now(),
    );
    return this.getEvent(Number(info.lastInsertRowid));
  }

  /** 记录一次喂奶（feedTypes 可为 1–3 个标签，amountMl 为总奶量/亲喂时 null） */
  createFeedEvent({ feedTypes, amountMl = null, note = null, happenedAt, createdAt }) {
    return this.createEvent({ kind: 'feed', feedTypes, amountMl, diaperKind: null, note, happenedAt, createdAt });
  }

  /** 记录一次大小便 */
  createDiaperEvent({ diaperKind, note = null, happenedAt, createdAt }) {
    return this.createEvent({ kind: 'diaper', feedTypes: null, amountMl: null, diaperKind, note, happenedAt, createdAt });
  }

  /** 记录一次洗澡（无奶量/无大小便类型） */
  createBathEvent({ note = null, happenedAt, createdAt }) {
    return this.createEvent({ kind: 'bath', feedTypes: null, amountMl: null, diaperKind: null, note, happenedAt, createdAt });
  }

  getEvent(id) {
    return rowToEvent(this.stmts.byId.get(id));
  }

  /**
   * @param {{ limit?: number, before?: number|null, beforeId?: number|null }} [opts]
   */
  listEvents({ limit = 50, before = null, beforeId = null } = {}) {
    if (before === null || before === undefined) {
      return this.stmts.latest.all(limit).map(rowToEvent);
    }
    // 只传 before 时严格 happenedAt < before；带 beforeId 时按 (happenedAt, id) 复合游标
    const cursorId = Number.isInteger(beforeId) && beforeId > 0 ? beforeId : 0;
    return this.stmts.latestBefore.all(before, before, cursorId, limit).map(rowToEvent);
  }

  lastEvent(kind) {
    return rowToEvent(this.stmts.lastOfKind.get(kind));
  }

  eventsBetween(start, end) {
    return this.stmts.between.all(start, end).map(rowToEvent);
  }

  allEvents() {
    return this.stmts.allAsc.all().map(rowToEvent);
  }

  deleteEvent(id) {
    return this.stmts.remove.run(id).changes > 0;
  }

  close() {
    this.db.close();
  }
}

/**
 * 打开（必要时创建 / 迁移）数据库。
 * @param {string} dbPath 文件路径，或 ':memory:'
 * @returns {Store}
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return new Store(db);
}
