import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb, migrate } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const db = openDb(':memory:');
migrate(db);
const server = createApp({ db }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

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
