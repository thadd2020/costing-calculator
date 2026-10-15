import { config, describeDb } from './src/config.js';
import { openDb, migrate } from './src/db/index.js';
import { createApp } from './src/app.js';

if (config.isProduction && config.db.client !== 'mysql') {
  // On SiteGround each deploy runs from a fresh folder, so a SQLite file would be lost.
  console.error('Refusing to start: production needs DB_CLIENT=mysql (see DEPLOY.md).');
  process.exit(1);
}

console.log(`Database: ${describeDb(config.db)}`);
const db = openDb(config.db);
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const app = createApp({ db, config });
const server = app.listen(config.port, () => {
  console.log(`GP Costing Calculator listening on port ${config.port} (${config.env})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
