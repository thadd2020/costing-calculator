// Builds the Express app. Kept separate from server.js so tests can create an app
// around a temporary database without opening a port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db }) {
  const app = express();
  app.set('trust proxy', 1); // behind SiteGround's proxy
  app.disable('x-powered-by');

  // Unauthenticated deploy check.
  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.type('text').send('ok');
  });

  // The calculation engine, served unchanged so the browser uses the same formulas as the server.
  app.get('/static/calc.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'src/calc/calc.js'));
  });

  // Temporary placeholder until milestone 3. Shows when the database was created, so a
  // redeploy can be checked for data loss (the time must not change).
  app.get('/', (req, res) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'installed_at'").get();
    const created = row
      ? new Date(row.value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'medium' })
      : 'unknown';
    res.type('text').send([
      'GP Costing Calculator - milestone 1 scaffold. Screens arrive in milestones 2 and 3.',
      `Database created: ${created} (UK time)`,
      `Node ${process.version}`,
    ].join('\n'));
  });

  return app;
}
