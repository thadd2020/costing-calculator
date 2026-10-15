import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb, migrate } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const db = openDb({ client: 'sqlite', file: ':memory:' });
await migrate(db);
const server = createApp({ db }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); db.close(); });

test('GET /healthz returns 200 ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('GET /static/calc.js serves the same engine the server uses', async () => {
  const res = await fetch(`${base}/static/calc.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(await res.text(), fs.readFileSync(new URL('../src/calc/calc.js', import.meta.url), 'utf8'));
});

test('GET / shows the database creation time', async () => {
  const text = await (await fetch(`${base}/`)).text();
  assert.match(text, /Database: SQLite, created \d/);
});
