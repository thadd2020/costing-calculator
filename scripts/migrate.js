// Applies pending migrations without starting the server: npm run migrate
import { config, describeDb } from '../src/config.js';
import { openDb, migrate, schemaVersion } from '../src/db/index.js';

const db = openDb(config.db);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply');
console.log(`Schema version ${await schemaVersion(db)} on ${describeDb(config.db)}`);
await db.close();
