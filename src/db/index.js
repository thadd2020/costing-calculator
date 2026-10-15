// The only module that talks to the database. Everything else calls the functions exported
// from src/db/, so moving to MySQL later only means rewriting this folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Opens (creating if needed) the database file. Pass ':memory:' for tests.
export function openDb(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Applies numbered .sql files (001_x.sql, 002_y.sql ...) that haven't run yet, each in its
// own transaction. Returns the list of files applied.
export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number.parseInt(f, 10) }))
    .sort((a, b) => a.version - b.version);

  const applied = [];
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
  for (const { file, version } of files) {
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(version, file, new Date().toISOString());
    })();
    applied.push(file);
  }
  return applied;
}

export function schemaVersion(db) {
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
}

// ---------- Settings ----------

const NUMERIC_SETTINGS = ['vat_rate', 'target_gp_food', 'target_gp_drink', 'alert_gp', 'default_packaging', 'round_up_to_pence'];

// Returns settings as an object, with the numeric ones parsed to numbers.
export function getSettings(db) {
  const out = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    out[key] = NUMERIC_SETTINGS.includes(key) ? Number(value) : value;
  }
  return out;
}

export function setSettings(db, values) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) upsert.run(key, String(value));
  })();
}

// ---------- Delivery channels ----------

export function listChannels(db) {
  return db.prepare('SELECT id, name, commission FROM delivery_channels ORDER BY name COLLATE NOCASE').all();
}
