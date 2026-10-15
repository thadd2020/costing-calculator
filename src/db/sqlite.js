// SQLite driver (better-sqlite3), used for local development and tests.
// better-sqlite3 is synchronous; this wraps it in the same async interface as mysql.js.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function createSqlite(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const raw = new Database(filename);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const cache = new Map();
  const stmt = (sql) => {
    if (!cache.has(sql)) cache.set(sql, raw.prepare(sql));
    return cache.get(sql);
  };

  // One connection is shared by every request. While a transaction is awaiting, other
  // requests must not slip statements into it, so everything queues behind one lock.
  let lock = Promise.resolve();
  const exclusive = (fn) => {
    const result = lock.then(fn);
    lock = result.catch(() => {});
    return result;
  };

  const direct = {
    all: async (sql, params = []) => stmt(sql).all(params),
    get: async (sql, params = []) => stmt(sql).get(params),
    run: async (sql, params = []) => {
      const info = stmt(sql).run(params);
      return { insertId: Number(info.lastInsertRowid), changes: info.changes };
    },
    exec: async (sql) => { raw.exec(sql); },
  };

  return {
    client: 'sqlite',
    all: (sql, params) => exclusive(() => direct.all(sql, params)),
    get: (sql, params) => exclusive(() => direct.get(sql, params)),
    run: (sql, params) => exclusive(() => direct.run(sql, params)),
    exec: (sql) => exclusive(() => direct.exec(sql)),
    // fn receives a handle with the same methods; use it (not the outer db) inside the transaction.
    transaction: (fn) => exclusive(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(direct);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    }),
    close: async () => { await lock; raw.close(); },
  };
}
