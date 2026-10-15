// Applies pending migrations without starting the server: npm run migrate
import { dbFile } from '../src/config.js';
import { openDb, migrate, schemaVersion } from '../src/db/index.js';

const db = openDb(dbFile);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply');
console.log(`Schema version ${schemaVersion(db)} at ${dbFile}`);
db.close();
