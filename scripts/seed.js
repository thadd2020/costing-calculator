// Loads the two spreadsheet examples: npm run seed
import { config, describeDb } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { seedExamples } from '../src/seed.js';

const db = openDb(config.db);
await migrate(db);
const added = await seedExamples(db);
console.log(added ? `Added the example dish and house wine to ${describeDb(config.db)}` : 'The examples are already there; nothing changed.');
await db.close();
