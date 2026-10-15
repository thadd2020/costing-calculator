import { nowIso } from './util.js';

const NUMERIC_SETTINGS = ['vat_rate', 'target_gp_food', 'target_gp_drink', 'alert_gp', 'default_packaging', 'round_up_to_pence'];
// Stored in the settings table but never handed to views or exports.
const PRIVATE_SETTINGS = ['admin_password_hash'];

// Returns settings as an object, with the numeric ones parsed to numbers.
export async function getSettings(q) {
  const out = {};
  for (const { key, value } of await q.all('SELECT `key`, value FROM settings')) {
    if (PRIVATE_SETTINGS.includes(key)) continue;
    out[key] = NUMERIC_SETTINGS.includes(key) ? Number(value) : value;
  }
  return out;
}

async function putSetting(q, key, value) {
  const { changes } = await q.run('UPDATE settings SET value = ? WHERE `key` = ?', [String(value), key]);
  if (changes === 0) await q.run('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, String(value)]);
}

// Update-then-insert rather than an upsert, because SQLite and MySQL spell upsert differently.
export async function setSettings(db, values) {
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(values)) await putSetting(tx, key, value);
  });
}

// The owner's password hash. A hash saved from the settings screen takes priority over
// the ADMIN_PASSWORD_HASH env var (see DECISIONS.md).
export async function getStoredPasswordHash(q) {
  const row = await q.get("SELECT value FROM settings WHERE `key` = 'admin_password_hash'");
  return row ? row.value : null;
}

export async function setStoredPasswordHash(q, hash) {
  await putSetting(q, 'admin_password_hash', hash);
  await putSetting(q, 'password_changed_at', nowIso());
}

export async function markSetting(q, key, value) {
  await putSetting(q, key, value);
}
