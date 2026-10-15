// The only module the rest of the app uses for data. Routes call these functions and never
// see SQL or the driver. Two drivers share one async interface: SQLite (local development
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

// ---------- Settings ----------

const NUMERIC_SETTINGS = ['vat_rate', 'target_gp_food', 'target_gp_drink', 'alert_gp', 'default_packaging', 'round_up_to_pence'];

// Returns settings as an object, with the numeric ones parsed to numbers.
export async function getSettings(db) {
  const out = {};
  for (const { key, value } of await db.all('SELECT `key`, value FROM settings')) {
    out[key] = NUMERIC_SETTINGS.includes(key) ? Number(value) : value;
  }
  return out;
}

// Update-then-insert rather than an upsert, because SQLite and MySQL spell upsert differently.
export async function setSettings(db, values) {
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      const { changes } = await tx.run('UPDATE settings SET value = ? WHERE `key` = ?', [String(value), key]);
      if (changes === 0) await tx.run('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, String(value)]);
    }
  });
}

// ---------- Delivery channels ----------

export async function listChannels(db) {
  const rows = await db.all('SELECT id, name, commission FROM delivery_channels ORDER BY LOWER(name)');
  return rows.map((r) => ({ ...r, commission: Number(r.commission) }));
}
