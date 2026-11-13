/**
 * 奶记 · SQLite 数据层（node:sqlite，零依赖）
 *
 * 单表 events 统一存喂奶与大小便，详见 docs/CONTRACT.md。
 * 所有时间均为 epoch 毫秒。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
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

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    feedType: row.feed_type ?? null,
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
        'INSERT INTO events (kind, feed_type, amount_ml, diaper_kind, note, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
   * @param {{ kind: 'feed'|'diaper', feedType?: string|null, amountMl?: number|null,
   *           diaperKind?: string|null, note?: string|null, happenedAt: number, createdAt?: number }} input
   */
  createEvent(input) {
    const now = Date.now();
    const info = this.stmts.insert.run(
      input.kind,
      input.feedType ?? null,
      input.amountMl ?? null,
      input.diaperKind ?? null,
      input.note ?? null,
      input.happenedAt,
      input.createdAt ?? now,
    );
    return this.getEvent(Number(info.lastInsertRowid));
  }

  getEvent(id) {
    return rowToEvent(this.stmts.byId.get(id));
  }

  /**
   * 按 happenedAt DESC, id DESC 返回事件（可分页）。
   * @param {{ limit?: number, before?: number|null, beforeId?: number|null }} [opts]
   */
  listEvents({ limit = 50, before = null, beforeId = null } = {}) {
    if (before === null || before === undefined) {
      return this.stmts.latest.all(limit).map(rowToEvent);
    }
    // 只传 before 时按 happenedAt 严格小于 before（游标包含 beforeId 时才是
    // 「(happenedAt, id) 复合游标」，可继续翻出同毫秒的旧记录）。
    const cursorId = Number.isInteger(beforeId) && beforeId > 0 ? beforeId : 0;
    return this.stmts.latestBefore.all(before, before, cursorId, limit).map(rowToEvent);
  }

  /** 某类事件中最近一条（kind: 'feed' | 'diaper'），无则 null */
  lastEvent(kind) {
    return rowToEvent(this.stmts.lastOfKind.get(kind));
  }

  /** [start, end) 内的事件，按时间升序 */
  eventsBetween(start, end) {
    return this.stmts.between.all(start, end).map(rowToEvent);
  }

  /** 全部事件，按时间升序（导出用） */
  allEvents() {
    return this.stmts.allAsc.all().map(rowToEvent);
  }

  /** 删除，返回是否真的删掉了一条 */
  deleteEvent(id) {
    const info = this.stmts.remove.run(id);
    return info.changes > 0;
  }

  close() {
    this.db.close();
  }
}

/**
 * 打开（必要时创建）数据库并执行迁移。
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
  db.exec(SCHEMA);
  return new Store(db);
}
