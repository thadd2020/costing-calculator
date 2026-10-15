// Single-owner login (CLAUDE.md section 9).
import bcrypt from 'bcryptjs';
import { getStoredPasswordHash } from './db/index.js';

export const DEV_PASSWORD = 'password';
let devHash = null;

// Hash saved from the settings screen wins; then ADMIN_PASSWORD_HASH; in development only,
// a fixed password so `npm start` works from a clean clone.
export async function currentPasswordHash(db, config) {
  const stored = await getStoredPasswordHash(db);
  if (stored) return stored;
  if (config.adminPasswordHash) return config.adminPasswordHash;
  if (!config.isProduction) {
    devHash ??= bcrypt.hashSync(DEV_PASSWORD, 10);
    return devHash;
  }
  return null;
}

export async function checkPassword(db, config, password) {
  const hash = await currentPasswordHash(db, config);
  if (!hash || typeof password !== 'string' || password.length > 200) return false;
  return bcrypt.compare(password, hash);
}

export function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export const PASSWORD_MIN = 10;
