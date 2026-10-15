// Reads configuration from environment variables. A local .env file is loaded if present
// (Node's built-in loader, so no dotenv dependency); real env vars always win.
import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  sessionSecret: env.SESSION_SECRET || '',
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
};

export const dbFile = path.join(config.dataDir, 'gp-costing.db');
