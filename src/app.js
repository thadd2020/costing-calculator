// Builds the Express app. Kept separate from server.js so tests can create an app
// around a temporary database without opening a port.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ping, getSettings } from './db/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db }) {
  const app = express();
  app.set('trust proxy', 1); // behind SiteGround's proxy
  app.disable('x-powered-by');

  // Unauthenticated deploy check: also proves the database is reachable.
  app.get('/healthz', async (req, res) => {
    await ping(db);
    res.type('text').send('ok');
  });

  // The calculation engine, served unchanged so the browser uses the same formulas as the server.
  app.get('/static/calc.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'src/calc/calc.js'));
  });

  // Temporary placeholder until milestone 3. Shows when the database was created, so a
  // redeploy can be checked for data loss (the time must not change).
  app.get('/', async (req, res) => {
    const { installed_at: installedAt } = await getSettings(db);
    const created = installedAt
      ? new Date(installedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'medium' })
      : 'unknown';
    res.type('text').send([
      'GP Costing Calculator - milestone 1 scaffold. Screens arrive in milestones 2 and 3.',
      `Database: ${db.client === 'mysql' ? 'MySQL' : 'SQLite'}, created ${created} (UK time)`,
      `Node ${process.version}`,
    ].join('\n'));
  });

  // Log the error server-side; never show stack traces or details to the browser.
  app.use((err, req, res, next) => {
    console.error(`${req.method} ${req.path} failed:`, err.message);
    res.status(500).type('text').send('Something went wrong. Please try again.');
  });

  return app;
}
