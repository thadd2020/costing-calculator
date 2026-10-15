// Whole-database snapshots as JSON. Used for the manual backup download, the nightly
// copies kept in the backups table, and scripts/restore.js.
import { nowIso, numeric } from './util.js';
import { schemaVersion } from './index.js';

// Tables in an order that respects foreign keys when inserting (reverse to delete).
const TABLES = {
  settings: ['key', 'value'],
  delivery_channels: ['id', 'name', 'commission'],
  ingredients: ['id', 'name', 'supplier', 'category', 'pack_size', 'pack_unit', 'pack_price_ex_vat', 'vat_rate', 'waste_pct', 'updated_at'],
  price_history: ['id', 'ingredient_id', 'pack_price_ex_vat', 'changed_at', 'source'],
  dishes: ['id', 'name', 'type', 'menu_price_inc_pence', 'vat_rate', 'target_gp', 'yield_portions', 'packaging', 'active', 'notes'],
  dish_ingredients: ['id', 'dish_id', 'ingredient_id', 'quantity', 'unit'],
};
// Never put the password hash in a file that leaves the server.
const EXCLUDED_SETTINGS = ['admin_password_hash'];
const quote = (c) => (c === 'key' ? '`key`' : c);
const NUMERIC_COLUMNS = new Set(['id', 'commission', 'pack_size', 'pack_price_ex_vat', 'vat_rate', 'waste_pct',
  'ingredient_id', 'menu_price_inc_pence', 'target_gp', 'yield_portions', 'packaging', 'active', 'dish_id', 'quantity']);

export async function createSnapshot(q) {
  const tables = {};
  for (const [table, cols] of Object.entries(TABLES)) {
    const rows = await q.all(`SELECT ${cols.map(quote).join(', ')} FROM ${table} ORDER BY ${table === 'settings' ? '`key`' : 'id'}`);
    tables[table] = rows
      .filter((r) => table !== 'settings' || !EXCLUDED_SETTINGS.includes(r.key))
      .map((r) => numeric(r, cols.filter((c) => NUMERIC_COLUMNS.has(c))));
  }
  return { app: 'gp-costing-calculator', format: 1, schema_version: await schemaVersion(q), created_at: nowIso(), tables };
}

// Replaces all data with the snapshot's, in one transaction. The password hash is kept.
export async function restoreSnapshot(db, snapshot) {
  if (snapshot?.app !== 'gp-costing-calculator' || snapshot.format !== 1) throw new Error('Not a GP Costing Calculator backup file');
  await db.transaction(async (tx) => {
    const names = Object.keys(TABLES);
    for (const table of [...names].reverse()) {
      if (table === 'settings') {
        await tx.run(`DELETE FROM settings WHERE \`key\` NOT IN (${EXCLUDED_SETTINGS.map(() => '?').join(', ')})`, EXCLUDED_SETTINGS);
      } else {
        await tx.run(`DELETE FROM ${table}`);
      }
    }
    for (const table of names) {
      const cols = TABLES[table];
      const sql = `INSERT INTO ${table} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      for (const row of snapshot.tables[table] || []) {
        if (table === 'settings' && EXCLUDED_SETTINGS.includes(row.key)) continue;
        await tx.run(sql, cols.map((c) => row[c] ?? null));
      }
    }
  });
}

export async function saveBackup(q, snapshot) {
  const data = JSON.stringify(snapshot);
  const { insertId } = await q.run('INSERT INTO backups (created_at, size_bytes, data) VALUES (?, ?, ?)',
    [snapshot.created_at, Buffer.byteLength(data), data]);
  return insertId;
}

export async function listBackups(q) {
  const rows = await q.all('SELECT id, created_at, size_bytes FROM backups ORDER BY created_at DESC, id DESC');
  return rows.map((r) => numeric(r, ['id', 'size_bytes']));
}

export async function getBackup(q, id) {
  const row = await q.get('SELECT id, created_at, data FROM backups WHERE id = ?', [id]);
  return row ? { id: Number(row.id), created_at: row.created_at, data: row.data } : null;
}

export async function latestBackupAt(q) {
  const row = await q.get('SELECT MAX(created_at) AS at FROM backups');
  return row?.at || null;
}

// Keeps the newest `keep` backups.
export async function pruneBackups(q, keep = 14) {
  const rows = await q.all('SELECT id FROM backups ORDER BY created_at DESC, id DESC');
  for (const { id } of rows.slice(keep)) await q.run('DELETE FROM backups WHERE id = ?', [id]);
}
