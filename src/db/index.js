// The only module the rest of the app uses for data. Routes call these functions and never
// see SQL or the driver. Every query function takes `q`, which is either the db or the
// handle passed into db.transaction(), so callers can group calls in one transaction. Two drivers share one async interface: SQLite (local development
// and tests) and MySQL (production). Queries here must work on both; see DECISIONS.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlite } from './sqlite.js';
import { createMysql } from './mysql.js';

const MIGRATIONS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// dbConfig: { client: 'sqlite', file } or { client: 'mysql', host, port, user, password, database }
export function openDb(dbConfig) {
  if (dbConfig.client === 'mysql') return createMysql(dbConfig);
  if (dbConfig.client === 'sqlite') return createSqlite(dbConfig.file);
  throw new Error(`Unknown database client "${dbConfig.client}"`);
}

// Applies numbered .sql files (001_x.sql, 002_y.sql ...) from the driver's folder that
// haven't run yet. SQLite applies each file in a transaction. MySQL can't roll back
// CREATE TABLE, so back up the database before deploying a migration (see DEPLOY.md).
export async function migrate(db, dir = path.join(MIGRATIONS_ROOT, db.client)) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at VARCHAR(30) NOT NULL)');
  const current = await schemaVersion(db);
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number.parseInt(f, 10) }))
    .sort((a, b) => a.version - b.version);

  const applied = [];
  for (const { file, version } of files) {
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const apply = async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)', [version, file, new Date().toISOString()]);
    };
    if (db.client === 'sqlite') await db.transaction(apply);
    else await apply(db);
    applied.push(file);
  }
  return applied;
}

export async function schemaVersion(db) {
  return Number((await db.get('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')).v);
}

export async function ping(db) {
  await db.get('SELECT 1 AS ok');
}

export * from './settings.js';
export * from './ingredients.js';
export * from './dishes.js';
export * from './channels.js';
export * from './imports.js';
export * from './sessions.js';
export * from './backups.js';
