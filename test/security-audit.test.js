// Security audit of routes, auth and sessions (CLAUDE.md sections 9 and 10).
// Tests that expose a real weakness are expected to FAIL until the code is fixed.
//
// Routes covered (from src/app.js and src/routes/*):
//   public:    GET /healthz, GET /static/calc.js, GET /static/*, GET /login, POST /login, POST /logout
//   dishes:    GET /, GET /dishes/new, POST /dishes, GET /dishes/:id, POST /dishes/:id, POST /dishes/:id/delete
//   ingredients: GET /ingredients, POST /ingredients, POST /ingredients/:id, POST /ingredients/:id/delete
//   import:    GET /import, GET /import/template.csv, POST /import/preview, GET /import/:batchId,
//              POST /import/:batchId/commit, POST /import/:batchId/discard, GET /import/:batchId/errors.csv
//   export:    GET /export, GET /export/ingredients.csv, GET /export/dishes.csv, GET /export/backup, GET /export/backups/:id
//   delivery:  GET /delivery
//   settings:  GET /settings, POST /settings, POST /settings/channels, POST /settings/channels/:id,
//              POST /settings/channels/:id/delete, POST /settings/password
//
// "Wrong user" / horizontal access control does not apply: the app has a single owner account.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import { testDatabases } from './helpers/databases.js';
import { startApp, Client } from './helpers/client.js';
import { seedIfNew } from '../src/seed.js';
import {
  listDishes, listIngredients, listChannels, getDish, getIngredient, saveDish, createIngredient,
  getImportBatch, getSettings, setStoredPasswordHash, saveBackup, createSnapshot,
} from '../src/db/index.js';

const XSS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>'];
const XSS_RAW = ['<script>alert(1)', '<img src=x onerror'];
const SQLI = ["' OR 1=1 --", "x'); DROP TABLE dishes; --", '" OR ""="', "1 UNION SELECT sid, data, 1 FROM sessions --"];
const CSV_OK = 'name,pack_size,pack_unit,pack_price\nAudit flour,1,kg,1.00\n';

const PROTECTED_GETS = (ids) => [
  '/', '/dishes/new', `/dishes/${ids.dish}`, '/ingredients', '/import', '/import/template.csv',
  `/import/${ids.batch}`, `/import/${ids.batch}/errors.csv`, '/export', '/export/ingredients.csv',
  '/export/dishes.csv', '/export/backup', `/export/backups/${ids.backup}`, '/delivery', '/settings',
];
const PROTECTED_POSTS = (ids) => [
  '/dishes', `/dishes/${ids.dish}`, `/dishes/${ids.dish}/delete`, '/ingredients', `/ingredients/${ids.ingredient}`,
  `/ingredients/${ids.ingredient}/delete`, '/import/preview', `/import/${ids.batch}/commit`, `/import/${ids.batch}/discard`,
  '/settings', '/settings/channels', `/settings/channels/${ids.channel}`, `/settings/channels/${ids.channel}/delete`,
  '/settings/password',
];

// Raw HTTP request, for paths fetch() would normalise (e.g. backslashes).
function rawRequest(base, path, { method = 'GET', headers = {} } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A multipart POST with no _csrf field: what a cross-site <form enctype="multipart/form-data"> sends.
async function multipartPost(client, path, fields = { x: '1' }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return client.request(path, { method: 'POST', body: form });
}

const sidOf = (cookie) => decodeURIComponent(cookie.split('=')[1] || '').replace(/^s:/, '').split('.')[0];
const noLeak = (body) => {
  const text = typeof body === 'string' ? body : '';
  assert.doesNotMatch(text, /\n\s+at .+\(.+:\d+:\d+\)/, 'stack trace leaked');
  assert.doesNotMatch(text, /node_modules|TypeError|ReferenceError|SQLITE_|ER_/, 'internal error detail leaked');
};

for (const { name, create } of testDatabases()) {
  describe(`security audit (${name})`, () => {
    let db; let cleanup; let app; let c; let ids;

    before(async () => {
      ({ db, cleanup } = await create());
      await seedIfNew(db);
      app = await startApp(db);
      c = app.client();
      await c.login();
      const up = await c.upload('/import/preview', 'audit.csv', `${CSV_OK}Bad,1,bottle,1\n`);
      assert.equal(up.status, 302);
      await saveBackup(db, await createSnapshot(db));
      ids = {
        dish: (await listDishes(db))[0].id,
        ingredient: (await listIngredients(db))[0].id,
        channel: (await listChannels(db))[0].id,
        batch: Number(up.location.split('/').pop()),
        backup: 1,
      };
    });
    after(async () => { await app.close(); await cleanup(); });

    // ---------- Unauthenticated access ----------

    test('/healthz is public, says ok and sets no cookie', async () => {
      const res = await app.client().get('/healthz');
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ok');
      assert.equal(res.headers.get('set-cookie'), null);
    });

    test('every protected GET redirects anonymous visitors to /login without leaking data', async () => {
      const anon = app.client();
      for (const path of PROTECTED_GETS(ids)) {
        const res = await anon.get(path);
        assert.equal(res.status, 302, path);
        assert.equal(res.location, '/login', path);
        assert.ok(!String(res.body).includes('Example dish'), `${path} leaked data`);
        assert.ok(!String(res.body).includes('House wine'), `${path} leaked data`);
        assert.doesNotMatch(res.headers.get('content-type') || '', /csv|json/, `${path} sent a file`);
      }
    });

    test('every protected POST is refused for anonymous visitors (with or without a CSRF token) and changes nothing', async () => {
      const before = { dishes: (await listDishes(db)).length, ings: (await listIngredients(db)).length, channels: (await listChannels(db)).length };
      for (const path of PROTECTED_POSTS(ids)) {
        const anon = app.client();
        await anon.get('/login');
        const withToken = await anon.post(path, { name: 'Anon', password: 'x' });
        assert.ok([302, 403].includes(withToken.status), `${path} -> ${withToken.status}`);
        if (withToken.status === 302) assert.equal(withToken.location, '/login', path);
        const noToken = await anon.post(path, { name: 'Anon' }, { csrf: false });
        assert.ok([302, 403].includes(noToken.status), `${path} -> ${noToken.status}`);
        const multi = await multipartPost(anon, path, { name: 'Anon' });
        assert.ok([302, 403].includes(multi.status), `${path} multipart -> ${multi.status}`);
      }
      assert.deepEqual(
        { dishes: (await listDishes(db)).length, ings: (await listIngredients(db)).length, channels: (await listChannels(db)).length },
        before,
      );
      assert.ok(await getDish(db, ids.dish));
    });

    test('anonymous CSV upload is refused before parsing', async () => {
      const anon = app.client();
      await anon.get('/login');
      const res = await anon.upload('/import/preview', 'x.csv', CSV_OK);
      assert.equal(res.status, 302);
      assert.equal(res.location, '/login');
    });

    test('/static serves only public assets; no path traversal to source, .env or data', async () => {
      const anon = app.client();
      assert.equal((await anon.get('/static/calc.js')).status, 200);
      assert.equal((await anon.get('/static/styles.css')).status, 200);
      for (const p of ['/static/../src/config.js', '/static/%2e%2e/src/config.js', '/static/..%2f.env', '/static/%2e%2e%2f%2e%2e%2fpackage.json',
        '/static/..%5c..%5c.env', '/static/.env', '/static/../data/gp-costing.db']) {
        const res = await rawRequest(app.base, p);
        assert.notEqual(res.status, 200, p);
        assert.ok(!res.body.includes('SESSION_SECRET') && !res.body.includes('"dependencies"'), p);
      }
    });

    // ---------- Valid / invalid input ----------

    test('valid create/update/delete works for ingredients, dishes and channels', async () => {
      const res = await c.post('/ingredients', { name: 'Audit butter', pack_size: '250', pack_unit: 'g', pack_price: '2.10', waste_pct: '2' });
      assert.equal(res.status, 302);
      const butter = (await listIngredients(db)).find((i) => i.name === 'Audit butter');
      assert.ok(butter);
      assert.equal((await c.post(`/ingredients/${butter.id}`, { name: 'Audit butter', pack_size: '250', pack_unit: 'g', pack_price: '2.20' })).status, 302);
      const dish = await c.post('/dishes', { name: 'Audit toast', type: 'food', menu_price: '5', line_ingredient: 'Audit butter', line_quantity: '10', line_unit: 'g', active: '1' });
      assert.equal(dish.status, 302);
      const dishId = Number(dish.location.split('/').pop());
      assert.equal((await c.post(`/dishes/${dishId}`, { name: 'Audit toast 2', type: 'food', menu_price: '6' })).status, 302);
      assert.equal((await getDish(db, dishId)).name, 'Audit toast 2');
      assert.equal((await c.post(`/dishes/${dishId}/delete`)).status, 302);
      assert.equal(await getDish(db, dishId), undefined);
      assert.equal((await c.post(`/ingredients/${butter.id}/delete`)).status, 302);
      assert.equal(await getIngredient(db, butter.id), undefined);
      assert.equal((await c.post('/settings/channels', { name: 'Audit channel', commission: '10' })).status, 302);
    });

    test('missing fields and wrong types are rejected with 422 on every form', async () => {
      const cases = [
        ['/ingredients', {}],
        ['/ingredients', { name: 'X', pack_size: 'abc', pack_unit: 'g', pack_price: '1' }],
        ['/ingredients', { name: 'X', pack_size: '1', pack_unit: 'bottle', pack_price: '1' }],
        ['/ingredients', { name: 'X', pack_size: '-1', pack_unit: 'g', pack_price: '1' }],
        ['/ingredients', { name: 'X', pack_size: '1', pack_unit: 'g', pack_price: 'free' }],
        ['/ingredients', { name: 'X', pack_size: '1', pack_unit: 'g', pack_price: '1', waste_pct: '150' }],
        ['/ingredients', { name: 'X', pack_size: 'Infinity', pack_unit: 'g', pack_price: '1' }],
        ['/ingredients', { name: 'X', pack_size: '1e400', pack_unit: 'g', pack_price: '1' }],
        [`/ingredients/${ids.ingredient}`, { name: '' }],
        ['/dishes', {}],
        ['/dishes', { name: 'X', menu_price: 'NaN' }],
        ['/dishes', { name: 'X', yield_portions: '0' }],
        ['/dishes', { name: 'X', line_ingredient: 'Nope', line_quantity: '1', line_unit: 'g' }],
        ['/dishes', { name: 'X', line_ingredient: 'Example dish ingredients', line_quantity: '1', line_unit: 'kg' }],
        [`/dishes/${ids.dish}`, { name: '' }],
        ['/settings', {}],
        ['/settings', { vat_rate: 'abc', target_gp_food: '70', target_gp_drink: '70', alert_gp: '60', default_packaging: '0.5', round_up_to_pence: '0' }],
        ['/settings/channels', {}],
        ['/settings/channels', { name: 'X', commission: '100' }],
        [`/settings/channels/${ids.channel}`, { name: '', commission: '10' }],
        ['/settings/password', {}],
        ['/settings/password', { current_password: 'wrong', new_password: 'longenough1', confirm_password: 'longenough1' }],
      ];
      for (const [path, fields] of cases) {
        const res = await c.post(path, fields);
        assert.equal(res.status, 422, `${path} ${JSON.stringify(fields)} -> ${res.status}`);
      }
    });

    test('huge bodies are refused with 413, long fields are truncated', async () => {
      const big = await c.post('/ingredients', { name: 'x'.repeat(300 * 1024), pack_size: '1', pack_unit: 'g', pack_price: '1' });
      assert.equal(big.status, 413);
      noLeak(big.body);
      const long = await c.post('/ingredients', { name: `Long${'y'.repeat(5000)}`, supplier: 'z'.repeat(5000), pack_size: '1', pack_unit: 'g', pack_price: '1' });
      assert.equal(long.status, 302);
      const saved = (await listIngredients(db)).find((i) => i.name.startsWith('Longyyy'));
      assert.ok(saved.name.length <= 200 && saved.supplier.length <= 200);
    });

    test('too many form fields gives a 4xx, not a 500', async () => {
      const fields = {};
      for (let i = 0; i < 6000; i++) fields[`f${i}`] = '1';
      const res = await c.post('/ingredients', fields);
      assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
      noLeak(res.body);
    });

    test('malformed percent-encoding in a URL gives a 4xx, not a 500', async () => {
      const res = await c.get('/dishes/%E0%A4%A');
      assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
      noLeak(res.body);
    });

    test('repeated scalar fields (arrays) are rejected, not concatenated into a different number', async () => {
      // pack_size=1&pack_size=000 arrives as ['1','000']; String() gives "1,000", read as a thousands separator -> 1000.
      const res = await c.post('/ingredients', { name: 'Audit array', pack_size: ['1', '000'], pack_unit: 'g', pack_price: ['1', '500'] });
      const saved = (await listIngredients(db)).find((i) => i.name === 'Audit array');
      assert.ok(res.status >= 400 && res.status < 500, `saved as pack_size=${saved?.pack_size}, price=${saved?.pack_price_ex_vat}`);
      assert.equal(saved, undefined);
    });

    test('repeated fields on the dish form cannot slip through String() either', async () => {
      const before = (await c.get(`/dishes/${ids.dish}`)).body;
      const res = await c.post(`/dishes/${ids.dish}`, { name: 'Audit dish', type: 'food', menu_price: ['1', '000'], yield_portions: '1', active: '1' });
      assert.equal(res.status, 400);
      const after = (await c.get(`/dishes/${ids.dish}`)).body;
      assert.doesNotMatch(after, /1000\.00|1,000\.00/);
      assert.ok(before.length > 0);
    });

    test('recipe line fields may still repeat', async () => {
      const res = await c.post('/dishes', { name: 'Two lines', type: 'food', menu_price: '10', line_ingredient: ['', ''], line_quantity: ['', ''], line_unit: ['g', 'g'] });
      assert.equal(res.status, 302);
    });

    test('bracketed array keys and other odd shapes never crash the server', async () => {
      const paths = ['/ingredients', '/dishes', '/settings', '/settings/channels', '/settings/password', `/dishes/${ids.dish}`];
      for (const path of paths) {
        const res = await c.post(path, { 'name[]': ['a', 'b'], 'password[]': 'x', 'line_ingredient[0]': 'x', 'menu_price[a]': '1' });
        assert.ok(res.status < 500, `${path} -> ${res.status}`);
      }
      const pw = await c.post('/settings/password', { current_password: ['password', 'password'], new_password: ['a'], confirm_password: ['a'] });
      assert.ok(pw.status >= 400 && pw.status < 500);
    });

    test('prototype-pollution keys in bodies and query strings do nothing', async () => {
      const fields = { name: 'Audit proto', pack_size: '1', pack_unit: 'g', pack_price: '1' };
      const body = new URLSearchParams({ _csrf: c.csrf, ...fields });
      body.append('__proto__[polluted]', 'yes');
      body.append('__proto__', 'yes');
      body.append('constructor[prototype][polluted]', 'yes');
      const res = await c.request('/ingredients', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.ok(res.status < 500);
      for (const q of ['/?__proto__[polluted]=yes', '/?constructor[prototype][polluted]=yes', '/?sort=__proto__', '/?sort=constructor', '/ingredients?__proto__=1&q=x', '/delivery?channel=__proto__']) {
        const r = await c.get(q);
        assert.equal(r.status, 200, q);
      }
      assert.equal(({}).polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
    });

    // ---------- Ids ----------

    test('non-existent and non-numeric ids give 404 on every :id route', async () => {
      const bad = ['999999', 'abc', '0', '-1', '1.5', '1e3', '99999999999', '1%20OR%201=1', "1'"];
      for (const id of bad) {
        for (const path of [`/dishes/${id}`, `/import/${id}`, `/import/${id}/errors.csv`, `/export/backups/${id}`]) {
          const res = await c.get(path);
          assert.equal(res.status, 404, `GET ${path} -> ${res.status}`);
        }
        for (const path of [`/dishes/${id}`, `/dishes/${id}/delete`, `/ingredients/${id}`, `/ingredients/${id}/delete`,
          `/import/${id}/commit`, `/settings/channels/${id}`, `/settings/channels/${id}/delete`]) {
          const res = await c.post(path, { name: 'X' });
          assert.equal(res.status, 404, `POST ${path} -> ${res.status}`);
        }
      }
    });

    test('discarding a non-existent import batch gives 404, not a "cancelled" message', async () => {
      const res = await c.post('/import/999999/discard');
      assert.equal(res.status, 404, `-> ${res.status} ${res.location}`);
    });

    // ---------- SQL injection ----------

    test('SQL injection payloads in every text field are stored literally', async () => {
      for (const [i, p] of SQLI.entries()) {
        const ing = await c.post('/ingredients', { name: `${p} ing${i}`, supplier: p, category: p, pack_size: '1', pack_unit: 'g', pack_price: '1' });
        assert.equal(ing.status, 302);
        const dish = await c.post('/dishes', { name: `${p} dish${i}`, type: 'food', notes: p });
        assert.equal(dish.status, 302);
        const ch = await c.post('/settings/channels', { name: `${p} ch${i}`, commission: '5' });
        assert.equal(ch.status, 302);
      }
      const ings = await listIngredients(db);
      for (const [i, p] of SQLI.entries()) {
        const row = ings.find((x) => x.name === `${p} ing${i}`);
        assert.ok(row, p);
        assert.equal(row.supplier, p.replace(/\s+/g, ' ').trim());
        assert.ok((await listDishes(db)).some((d) => d.name === `${p} dish${i}` && d.notes === p));
        assert.ok((await listChannels(db)).some((ch) => ch.name === `${p} ch${i}`));
      }
      assert.ok((await listDishes(db)).length > 2, 'dishes table still intact');
    });

    test('SQL injection payloads in query strings are harmless', async () => {
      const total = (await listDishes(db)).length;
      for (const p of SQLI) {
        const e = encodeURIComponent(p);
        for (const path of [`/?q=${e}`, `/?sort=${e}`, `/?type=${e}`, `/?below=${e}`, `/ingredients?q=${e}`, `/ingredients?open=${e}`,
          `/delivery?channel=${e}`, `/dishes/new?type=${e}`]) {
          const res = await c.get(path);
          assert.equal(res.status, 200, path);
        }
      }
      // A matching search must not return everything.
      const res = await c.get(`/?q=${encodeURIComponent("' OR 1=1 --")}`);
      assert.ok(!res.body.includes('Example house wine'));
      assert.equal((await listDishes(db)).length, total);
    });

    // ---------- Stored and reflected XSS ----------

    test('stored XSS in names, suppliers, notes, channels and import filenames is escaped on every page', async () => {
      for (const [i, p] of XSS.entries()) {
        assert.equal((await c.post('/ingredients', { name: `${p}${i}`, supplier: p, category: p, pack_size: '1', pack_unit: 'g', pack_price: '1' })).status, 302);
        assert.equal((await c.post('/settings/channels', { name: `${p}c${i}`, commission: '5' })).status, 302);
        const d = await c.post('/dishes', { name: `${p}d${i}`, type: 'food', menu_price: '10', notes: p, active: '1',
          line_ingredient: `${p}${i} (${p})`, line_quantity: '5', line_unit: 'g' });
        assert.equal(d.status, 302);
      }
      const xssDish = (await listDishes(db)).find((d) => d.name === `${XSS[1]}d1`);
      const up = await c.upload('/import/preview', `${XSS[1]}.csv`,
        `name,pack_size,pack_unit,pack_price\n${XSS[0].replace(/,/g, '')},1,"${XSS[1].replace(/"/g, '""')}",1\n"${XSS[1].replace(/"/g, '""')}",1,kg,2\n`);
      assert.equal(up.status, 302);
      const pages = ['/', '/?inactive=1', `/dishes/${xssDish.id}`, '/dishes/new', '/ingredients', '/delivery', '/settings', '/export', up.location,
        `/?q=${encodeURIComponent(XSS[0])}`, `/ingredients?q=${encodeURIComponent(XSS[1])}`];
      for (const path of pages) {
        const res = await c.get(path);
        assert.equal(res.status, 200, path);
        for (const raw of XSS_RAW) assert.ok(!res.body.includes(raw), `${path} contains unescaped ${raw}`);
      }
      // data-json attribute for the live calculator must be attribute-escaped.
      const editor = await c.get(`/dishes/${xssDish.id}`);
      const attr = editor.body.match(/data-json="([^"]*)"/);
      assert.ok(attr, 'data-json present and not broken out of');
      assert.ok(attr[1].includes('&lt;script&gt;') || attr[1].includes('&#34;&gt;&lt;img'));
      // Validation re-renders echo input back.
      const r1 = await c.post('/ingredients', { name: XSS[1], pack_size: 'bad', pack_unit: XSS[0], pack_price: XSS[1] });
      const r2 = await c.post('/dishes', { name: XSS[1], line_ingredient: XSS[0], line_quantity: XSS[1], line_unit: XSS[1], notes: XSS[0] });
      const r3 = await c.post('/settings', { vat_rate: XSS[1], default_packaging: XSS[0] });
      for (const r of [r1, r2, r3]) {
        assert.equal(r.status, 422);
        for (const raw of XSS_RAW) assert.ok(!r.body.includes(raw), `422 page contains unescaped ${raw}`);
      }
    });

    test('CSV exports escape formula injection', async () => {
      await c.post('/ingredients', { name: '=HYPERLINK("http://evil","x")', supplier: '+1+1', category: '@SUM(A1)', pack_size: '1', pack_unit: 'g', pack_price: '1' });
      await c.post('/dishes', { name: '-2+3', type: 'food' });
      const ing = await c.get('/export/ingredients.csv');
      assert.ok(!/(^|,|\n)"?=HYPERLINK/.test(ing.body));
      assert.ok(ing.body.includes("'=HYPERLINK"));
      assert.ok(ing.body.includes("'+1+1") && ing.body.includes("'@SUM"));
      const dishes = await c.get('/export/dishes.csv');
      assert.ok(dishes.body.includes("'-2+3"));
      assert.match(ing.headers.get('content-disposition'), /^attachment; filename="ingredients-\d{4}-\d{2}-\d{2}\.csv"$/);
    });

    // ---------- CSRF ----------

    test('every state-changing POST is refused without a token, with a wrong token, or with another session\'s token', async () => {
      const other = app.client();
      await other.login();
      const before = { dishes: (await listDishes(db)).length, ings: (await listIngredients(db)).length, settings: await getSettings(db) };
      for (const path of [...PROTECTED_POSTS(ids), '/logout']) {
        const none = await c.post(path, { name: 'csrf' }, { csrf: false });
        assert.equal(none.status, 403, `no token ${path}`);
        const wrongBody = new URLSearchParams({ _csrf: 'a'.repeat(64), name: 'csrf' });
        const wrong = await c.request(path, { method: 'POST', body: wrongBody, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.equal(wrong.status, 403, `wrong token ${path}`);
        const stolen = new URLSearchParams({ _csrf: other.csrf, name: 'csrf' });
        const cross = await c.request(path, { method: 'POST', body: stolen, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.equal(cross.status, 403, `other session's token ${path}`);
        const hdr = await c.request(path, { method: 'POST', body: 'name=csrf', headers: { 'content-type': 'text/plain', 'x-csrf-token': 'nope' } });
        assert.equal(hdr.status, 403, `text/plain ${path}`);
      }
      assert.equal((await listDishes(db)).length, before.dishes);
      assert.equal((await listIngredients(db)).length, before.ings);
      assert.deepEqual(await getSettings(db), before.settings);
      assert.equal((await c.get('/')).status, 200, 'still logged in');
    });

    test('multipart POSTs without a CSRF token are refused on routes other than the upload (cross-site form bypass)', async () => {
      // csrfUnlessMultipart (now csrfExceptCsvUpload) used to skip the check for ANY multipart request, but only /import/preview
      // re-checks it. Routes that don't read the body act on a forged multipart POST.
      const victim = await saveDish(db, null, { name: 'CSRF victim', type: 'food', menu_price_inc_pence: 100, vat_rate: null, target_gp: null, yield_portions: 1, packaging: null, active: 1, notes: '' }, []);
      const res = await multipartPost(c, `/dishes/${victim}/delete`);
      assert.equal(res.status, 403, `forged multipart delete -> ${res.status}`);
      assert.ok(await getDish(db, victim), 'dish was deleted by a forged request');
    });

    test('multipart CSRF bypass also hits ingredient/channel delete, import commit/discard, settings and logout', async () => {
      const ing = await createIngredient(db, { name: 'CSRF ing', supplier: '', category: '', pack_size: 1, pack_unit: 'g', pack_price_ex_vat: 1, vat_rate: 0, waste_pct: 0 });
      const up = await c.upload('/import/preview', 'csrf.csv', 'name,pack_size,pack_unit,pack_price\nCSRF import,1,kg,1\n');
      const batchId = Number(up.location.split('/').pop());
      const failures = [];
      for (const path of [`/ingredients/${ing.id}/delete`, `/import/${batchId}/commit`, `/settings/channels/${ids.channel}/delete`, '/settings']) {
        const res = await multipartPost(c, path, { vat_rate: '0' });
        if (res.status !== 403) failures.push(`${path} -> ${res.status} ${res.location || ''}`);
        noLeak(res.body);
      }
      const victim = app.client();
      await victim.login();
      const lo = await multipartPost(victim, '/logout');
      if (lo.status !== 403) failures.push(`/logout -> ${lo.status}`);
      assert.deepEqual(failures, [], `forged multipart POSTs were not refused: ${failures.join('; ')}; import batch status after forged commit: ${(await getImportBatch(db, batchId)).status}`);
    });

    test('multipart upload with wrong token is refused and stores no batch', async () => {
      const form = new FormData();
      form.append('_csrf', 'b'.repeat(64));
      form.append('file', new Blob([CSV_OK], { type: 'text/csv' }), 'x.csv');
      const res = await c.request('/import/preview', { method: 'POST', body: form });
      assert.equal(res.status, 403);
    });

    // ---------- Uploads ----------

    test('upload abuse: oversize, wrong field, multiple files, no file, non-CSV, too many fields', async () => {
      const big = await c.upload('/import/preview', 'big.csv', `name,pack_size,pack_unit,pack_price\n${'a'.repeat(2 * 1024 * 1024 + 10)}`);
      assert.equal(big.status, 400);
      assert.match(big.body, /larger than 2 MB/);

      const wrongField = new FormData();
      wrongField.append('_csrf', c.csrf);
      wrongField.append('upload', new Blob([CSV_OK], { type: 'text/csv' }), 'x.csv');
      assert.equal((await c.request('/import/preview', { method: 'POST', body: wrongField })).status, 400);

      const two = new FormData();
      two.append('_csrf', c.csrf);
      two.append('file', new Blob([CSV_OK], { type: 'text/csv' }), 'a.csv');
      two.append('file', new Blob([CSV_OK], { type: 'text/csv' }), 'b.csv');
      assert.equal((await c.request('/import/preview', { method: 'POST', body: two })).status, 400);

      const none = new FormData();
      none.append('_csrf', c.csrf);
      assert.equal((await c.request('/import/preview', { method: 'POST', body: none })).status, 400);

      const png = new FormData();
      png.append('_csrf', c.csrf);
      png.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])], { type: 'image/png' }), 'x.png');
      assert.equal((await c.request('/import/preview', { method: 'POST', body: png })).status, 400);

      const binaryCsv = await c.upload('/import/preview', 'x.csv', Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0]));
      assert.equal(binaryCsv.status, 400);

      const manyFields = new FormData();
      manyFields.append('_csrf', c.csrf);
      for (let i = 0; i < 10; i++) manyFields.append(`f${i}`, 'x');
      manyFields.append('file', new Blob([CSV_OK], { type: 'text/csv' }), 'x.csv');
      assert.equal((await c.request('/import/preview', { method: 'POST', body: manyFields })).status, 400);
    });

    test('path-traversal filenames are only stored as text (memory storage, nothing written)', async () => {
      const res = await c.upload('/import/preview', '../../../../tmp/evil.csv', CSV_OK);
      assert.equal(res.status, 302);
      const batch = await getImportBatch(db, Number(res.location.split('/').pop()));
      assert.ok(batch.filename.length <= 200);
      const page = await c.get(res.location);
      assert.equal(page.status, 200);
    });

    test('import confirmation cannot be tampered with: commit uses the stored batch, and twice is refused', async () => {
      const up = await c.upload('/import/preview', 't.csv', 'name,pack_size,pack_unit,pack_price\nTamper test,1,kg,3\n');
      const id = Number(up.location.split('/').pop());
      const res = await c.post(`/import/${id}/commit`, { 'rows[0][data][pack_price_ex_vat]': '0', name: 'Injected' });
      assert.equal(res.status, 302);
      const ing = (await listIngredients(db)).find((i) => i.name === 'Tamper test');
      assert.equal(ing.pack_price_ex_vat, 3);
      assert.ok(!(await listIngredients(db)).some((i) => i.name === 'Injected'));
      await c.post(`/import/${id}/commit`);
      assert.equal((await listIngredients(db)).filter((i) => i.name === 'Tamper test').length, 1);
      await c.post(`/import/${id}/discard`);
      assert.equal((await getImportBatch(db, id)).status, 'committed', 'discard must not overwrite a committed batch');
    });

    // ---------- Open redirects ----------

    test('no open redirect via ?next=, returnTo or protocol-relative paths', async () => {
      for (const p of ['/login?next=https://evil.example', '/login?returnTo=//evil.example', '/login?redirect=https:%2F%2Fevil.example']) {
        const anon = app.client();
        await anon.get(p);
        const res = await anon.post('/login', { password: 'password' });
        assert.equal(res.status, 302);
        assert.equal(res.location, '/', p);
      }
      const anon = app.client();
      await anon.get('//evil.example/x');
      await anon.get('/login');
      const res = await anon.post('/login', { password: 'password' });
      assert.ok(!/^\/\/|^https?:/i.test(res.location), res.location);
    });

    test('returnTo with a backslash cannot redirect off-site (browsers read /\\ as //)', async () => {
      const anon = app.client();
      await anon.get('/login');
      const r = await rawRequest(app.base, '/\\evil.example/', { headers: { cookie: anon.cookie } });
      assert.equal(r.status, 302);
      const res = await anon.post('/login', { password: 'password' });
      assert.ok(!/^\/[\\/]/.test(res.location) && !/^[a-z]+:/i.test(res.location), `redirected to ${res.location}`);
    });

    // ---------- Sessions and cookies ----------

    test('session cookie flags: httpOnly, SameSite=Lax, 14-day expiry after login, not Secure in dev', async () => {
      const anon = app.client();
      await anon.get('/login');
      const res = await anon.request('/login', {
        method: 'POST', body: new URLSearchParams({ _csrf: anon.csrf, password: 'password' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      const cookie = res.headers.get('set-cookie');
      assert.match(cookie, /^gp\.sid=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.doesNotMatch(cookie, /Secure/i);
      const expires = new Date(cookie.match(/Expires=([^;]+)/i)[1]).getTime();
      const days = (expires - Date.now()) / 86400000;
      assert.ok(days > 13.9 && days <= 14.01, `expires in ${days} days`);
    });

    test('session id rotates on login (no fixation); the pre-login id is not authenticated', async () => {
      const anon = app.client();
      await anon.get('/login');
      const preCookie = anon.cookie;
      await anon.post('/login', { password: 'password' });
      assert.notEqual(sidOf(anon.cookie), sidOf(preCookie));
      const attacker = new Client(app.base);
      attacker.cookie = preCookie;
      const res = await attacker.get('/');
      assert.equal(res.status, 302);
      assert.equal(res.location, '/login');
    });

    test('a forged / unsigned session cookie is ignored', async () => {
      const sid = sidOf(c.cookie);
      const forged = new Client(app.base);
      forged.cookie = `gp.sid=${encodeURIComponent(`s:${sid}.invalidsignature`)}`;
      assert.equal((await forged.get('/')).status, 302);
      forged.cookie = `gp.sid=${sid}`;
      assert.equal((await forged.get('/')).status, 302);
    });

    test('logout destroys the session server-side; replaying the old cookie fails', async () => {
      const u = app.client();
      await u.login();
      const old = u.cookie;
      const res = await u.post('/logout');
      assert.equal(res.status, 302);
      assert.equal(res.location, '/login');
      const replay = new Client(app.base);
      replay.cookie = old;
      const r = await replay.get('/');
      assert.equal(r.status, 302);
      assert.equal(r.location, '/login');
    });

    test('login: same generic message, oversized and non-string passwords are rejected', async () => {
      for (const pw of ['', 'x'.repeat(201), 'password '.trim() + ' ']) {
        const anon = app.client();
        await anon.get('/login');
        const res = await anon.post('/login', { password: pw });
        assert.equal(res.status, 401, JSON.stringify(pw.slice(0, 10)));
      }
      const anon = app.client();
      await anon.get('/login');
      const arr = await anon.post('/login', { password: ['password', 'password'] });
      assert.ok(arr.status === 400 || arr.status === 401, String(arr.status));
      assert.equal(arr.location, null, 'never logged in');
      const missing = await anon.post('/login', {});
      assert.equal(missing.status, 401);
    });

    // ---------- Headers ----------

    test('security headers and CSP on app pages and the login page', async () => {
      for (const res of [await c.get('/'), await app.client().get('/login')]) {
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /script-src 'self'(;|$)/);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /object-src 'none'/);
        assert.match(csp, /form-action 'self'/);
        assert.match(csp, /base-uri 'self'/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(res.headers.get('x-frame-options'));
        assert.ok(res.headers.get('referrer-policy'));
        assert.ok(res.headers.get('strict-transport-security'));
        assert.equal(res.headers.get('x-powered-by'), null);
        assert.match(res.headers.get('cache-control'), /no-store/);
      }
      for (const p of ['/export/ingredients.csv', '/export/backup']) {
        const res = await c.get(p);
        assert.match(res.headers.get('cache-control'), /no-store/, p);
        assert.match(res.headers.get('content-disposition'), /^attachment;/, p);
      }
    });

    test('error pages (404/500) never show stack traces', async () => {
      const nf = await c.get('/no/such/page');
      assert.equal(nf.status, 404);
      noLeak(nf.body);
      const crash = await multipartPost(c, '/dishes', { name: 'x' }); // req.body is undefined here
      noLeak(crash.body);
    });

    test('pages and exports render the seeded data when logged in (sanity)', async () => {
      for (const p of PROTECTED_GETS(ids)) {
        const res = await c.get(p);
        assert.equal(res.status, 200, p);
      }
    });
  });

  describe(`security audit: login rate limit (${name})`, () => {
    let db; let cleanup; let app;
    before(async () => {
      ({ db, cleanup } = await create());
      app = await startApp(db, { loginRateLimit: 3 });
    });
    after(async () => { await app.close(); await cleanup(); });

    test('blocks after the limit, even for the right password; successes do not count', async () => {
      const ok = app.client();
      for (let i = 0; i < 4; i++) {
        await ok.get('/login');
        assert.equal((await ok.post('/login', { password: 'password' })).status, 302, 'successful logins should not count');
        await ok.post('/logout');
        ok.cookie = '';
      }
      const anon = app.client();
      await anon.get('/login');
      for (let i = 0; i < 3; i++) assert.equal((await anon.post('/login', { password: `wrong${i}` })).status, 401);
      const blocked = await anon.post('/login', { password: 'wrong' });
      assert.equal(blocked.status, 429);
      assert.match(blocked.body, /Too many attempts/);
      const right = await anon.post('/login', { password: 'password' });
      assert.equal(right.status, 429);
      const fresh = app.client();
      await fresh.get('/login');
      assert.equal((await fresh.post('/login', { password: 'password' })).status, 429, 'limit is per IP, not per session');
    });
  });

  describe(`security audit: password change (${name})`, () => {
    let db; let cleanup; let app;
    before(async () => {
      ({ db, cleanup } = await create());
      await seedIfNew(db);
      app = await startApp(db);
    });
    after(async () => { await app.close(); await cleanup(); });

    test('changing the password logs out other sessions, keeps this one, and swaps the password', async () => {
      const me = app.client();
      const other = app.client();
      await me.login();
      await other.login();
      assert.equal((await other.get('/')).status, 200);
      const tooShort = await me.post('/settings/password', { current_password: 'password', new_password: 'short', confirm_password: 'short' });
      assert.equal(tooShort.status, 422);
      const mismatch = await me.post('/settings/password', { current_password: 'password', new_password: 'longenough1', confirm_password: 'longenough2' });
      assert.equal(mismatch.status, 422);
      const res = await me.post('/settings/password', { current_password: 'password', new_password: 'new-password-123', confirm_password: 'new-password-123' });
      assert.equal(res.status, 302);
      assert.equal((await me.get('/')).status, 200, 'current session kept');
      const o = await other.get('/');
      assert.equal(o.status, 302);
      assert.equal(o.location, '/login');
      const oldPw = app.client();
      await oldPw.get('/login');
      assert.equal((await oldPw.post('/login', { password: 'password' })).status, 401);
      const newPw = app.client();
      await newPw.get('/login');
      assert.equal((await newPw.post('/login', { password: 'new-password-123' })).status, 302);
    });

    test('backups never contain the password hash or session data', async () => {
      await setStoredPasswordHash(db, bcrypt.hashSync('another-password-1', 4));
      await saveBackup(db, await createSnapshot(db));
      const me = app.client();
      await me.login('another-password-1');
      for (const p of ['/export/backup', '/export/backups/1']) {
        const res = await me.get(p);
        assert.equal(res.status, 200, p);
        assert.ok(!res.body.includes('$2'), `${p} contains a bcrypt hash`);
        assert.ok(!res.body.includes('admin_password_hash'), p);
        assert.ok(!res.body.includes('"sessions"') && !res.body.includes('loggedIn') && !res.body.includes('csrf'), `${p} contains session data`);
      }
    });
  });

  describe(`security audit: production config (${name})`, () => {
    let db; let cleanup; let app;
    before(async () => {
      ({ db, cleanup } = await create());
      app = await startApp(db, { isProduction: true, env: 'production', adminPasswordHash: bcrypt.hashSync('prod-password-1', 4) });
    });
    after(async () => { await app.close(); await cleanup(); });

    const viaProxy = { 'x-forwarded-proto': 'https' };

    async function prodLogin(password) {
      const page = await fetch(`${app.base}/login`, { headers: viaProxy });
      const cookie = page.headers.get('set-cookie');
      const csrf = (await page.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
      const res = await fetch(`${app.base}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { ...viaProxy, cookie: cookie.split(';')[0], 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, password }),
      });
      return { res, preCookie: cookie };
    }

    test('the development password "password" does not work in production', async () => {
      const { res } = await prodLogin('password');
      assert.equal(res.status, 401);
    });

    test('cookie is Secure, HttpOnly, SameSite=Lax behind the HTTPS proxy (trust proxy)', async () => {
      const { res, preCookie } = await prodLogin('prod-password-1');
      assert.equal(res.status, 302);
      for (const cookie of [preCookie, res.headers.get('set-cookie')]) {
        assert.match(cookie, /; Secure/i);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
      }
    });

    test('no session cookie is sent over plain http in production', async () => {
      const page = await fetch(`${app.base}/login`);
      assert.equal(page.headers.get('set-cookie'), null);
    });

    test('CSP upgrades insecure requests in production', async () => {
      const res = await fetch(`${app.base}/login`, { headers: viaProxy });
      assert.match(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
    });

    test('error pages do not leak stack traces in production', async () => {
      const { res } = await prodLogin('prod-password-1');
      const cookie = res.headers.get('set-cookie').split(';')[0];
      const form = new FormData();
      form.append('name', 'x');
      const crash = await fetch(`${app.base}/settings`, { method: 'POST', headers: { ...viaProxy, cookie }, body: form, redirect: 'manual' });
      noLeak(await crash.text());
      const bad = await fetch(`${app.base}/dishes/%E0%A4%A`, { headers: { ...viaProxy, cookie }, redirect: 'manual' });
      noLeak(await bad.text());
    });
  });
}
