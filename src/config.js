// Reads configuration from environment variables. A local .env file is loaded if present
// (Node's built-in loader, so no dotenv dependency); real env vars always win.
import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3000,
  dataDir,
  sessionSecret: env.SESSION_SECRET || '',
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
  // DB_CLIENT=mysql in production (SiteGround); SQLite file in DATA_DIR otherwise.
  db: env.DB_CLIENT === 'mysql'
    ? {
        client: 'mysql',
        host: env.DB_HOST || 'localhost',
        port: Number(env.DB_PORT) || 3306,
        user: env.DB_USER || '',
        password: env.DB_PASSWORD || '',
        database: env.DB_NAME || '',
      }
    : { client: 'sqlite', file: path.join(dataDir, 'gp-costing.db') },
};

// Safe to log: never includes the password.
export function describeDb(db) {
  return db.client === 'mysql' ? `MySQL ${db.user}@${db.host}:${db.port}/${db.database}` : `SQLite ${db.file}`;
}
