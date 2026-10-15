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

  app.get('/', (req, res) => {
    res.type('text').send('GP Costing Calculator - milestone 1 scaffold. Screens arrive in milestones 2 and 3.');
  });

  return app;
}
