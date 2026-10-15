import crypto from 'node:crypto';
import { config, describeDb } from './src/config.js';
import { openDb, migrate } from './src/db/index.js';
import { createApp } from './src/app.js';
import { seedIfNew } from './src/seed.js';
import { startBackupSchedule } from './src/backup.js';

if (config.isProduction) {
  const problems = [];
  // On SiteGround each deploy runs from a fresh folder, so a SQLite file would be lost.
  if (config.db.client !== 'mysql') problems.push('DB_CLIENT=mysql (and the DB_* settings)');
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET (at least 32 characters)');
  if (!config.adminPasswordHash) problems.push('ADMIN_PASSWORD_HASH (from npm run set-password)');
  if (problems.length) {
    console.error(`Refusing to start in production. Set: ${problems.join('; ')}. See DEPLOY.md.`);
    process.exit(1);
  }
} else {
  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
    console.log('No SESSION_SECRET set: using a temporary one (you will be logged out on restart).');
  }
  if (!config.adminPasswordHash) console.log('No ADMIN_PASSWORD_HASH set: development password is "password".');
}

console.log(`Database: ${describeDb(config.db)}`);
const db = openDb(config.db);
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
if (await seedIfNew(db)) console.log('New database: added the example dish and house wine.');

const app = createApp({ db, config });
const stopBackups = startBackupSchedule(db);
const server = app.listen(config.port, () => {
  console.log(`GP Costing Calculator listening on port ${config.port} (${config.env})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopBackups();
  app.locals.sessionStore.close();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
