import { config, dbFile } from './src/config.js';
import { openDb, migrate } from './src/db/index.js';
import { createApp } from './src/app.js';

console.log(`Database file: ${dbFile}`);
const db = openDb(dbFile);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const app = createApp({ db, config });
const server = app.listen(config.port, () => {
  console.log(`GP Costing Calculator listening on port ${config.port} (${config.env})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
