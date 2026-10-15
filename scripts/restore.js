// Replaces ALL data with a backup file: npm run restore -- path/to/backup.json
// Your password is kept. Take a fresh backup first if you might want the current data.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { config, describeDb } from '../src/config.js';
import { openDb, migrate, restoreSnapshot } from '../src/db/index.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run restore -- path/to/backup.json');
  process.exit(1);
}
const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
const counts = Object.entries(snapshot.tables || {}).map(([t, rows]) => `${rows.length} ${t}`).join(', ');
console.log(`Backup from ${snapshot.created_at}: ${counts}`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`This replaces everything in ${describeDb(config.db)}. Type "restore" to continue: `);
rl.close();
if (answer.trim() !== 'restore') {
  console.log('Cancelled; nothing changed.');
  process.exit(0);
}
const db = openDb(config.db);
await migrate(db);
await restoreSnapshot(db, snapshot);
await db.close();
console.log('Restored.');
