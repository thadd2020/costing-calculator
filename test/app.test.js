import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testDatabases } from './helpers/databases.js';
import { startApp } from './helpers/client.js';
import { seedIfNew } from '../src/seed.js';
import { listIngredients, listDishes } from '../src/db/index.js';

for (const { name, create } of testDatabases()) {
  describe(`app (${name})`, () => {
    let db; let cleanup; let app; let c;
    before(async () => {
      ({ db, cleanup } = await create());
      await seedIfNew(db);
      app = await startApp(db);
      c = app.client();
      await c.login();
    });
    after(async () => { await app.close(); await cleanup(); });

    test('/healthz is public', async () => {
      const res = await app.client().get('/healthz');
      assert.equal(res.status, 200);
      assert.equal(res.body, 'ok');
    });

    test('/static/calc.js serves the same engine the server uses', async () => {
      const res = await app.client().get('/static/calc.js');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.equal(res.body, fs.readFileSync(new URL('../src/calc/calc.js', import.meta.url), 'utf8'));
    });

    test('/static/input.js serves the same number parsers the server uses', async () => {
      const res = await app.client().get('/static/input.js');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.equal(res.body, fs.readFileSync(new URL('../src/input.js', import.meta.url), 'utf8'));
      assert.doesNotMatch(res.body, /^import /m, 'the browser copy must not import anything');
    });

    test('every page needs a login', async () => {
      const anon = app.client();
      for (const path of ['/', '/dishes/new', '/ingredients', '/import', '/delivery', '/settings', '/export', '/export/backup', '/export/ingredients.csv']) {
        const res = await anon.get(path);
        assert.equal(res.status, 302, path);
        assert.equal(res.location, '/login', path);
      }
    });

    test('wrong password is rejected with one generic message', async () => {
      const anon = app.client();
      await anon.get('/login');
      const res = await anon.post('/login', { password: 'nope' });
      assert.equal(res.status, 401);
      assert.match(res.body, /That password isn(&#39;|')t right/);
    });

    test('security headers are set', async () => {
      const res = await c.get('/');
      assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('cache-control'), /no-store/);
    });

    test('posts without the CSRF token are refused', async () => {
      const res = await c.post('/settings', { vat_rate: '20' }, { csrf: false });
      assert.equal(res.status, 403);
      const upload = await c.upload('/import/preview', 'x.csv', 'name,pack_size,pack_unit,pack_price\nA,1,kg,1\n', { csrf: false });
      assert.equal(upload.status, 403);
    });

    test('home lists the seeded examples with server-calculated GP', async () => {
      const res = await c.get('/');
      assert.equal(res.status, 200);
      assert.match(res.body, /Example dish/);
      assert.match(res.body, /68\.2%/);
      assert.match(res.body, /Under target/);
      assert.match(res.body, /74\.5%/);
    });

    test('dish editor shows the full costing for Dish A', async () => {
      const dish = (await listDishes(db)).find((d) => d.name === 'Example dish');
      const res = await c.get(`/dishes/${dish.id}`);
      assert.equal(res.status, 200);
      for (const s of ['£4.77', '£15.00', '£10.23', '68.2%', '£19.08', '£26.57', '£30.11']) assert.ok(res.body.includes(s), s);
    });

    test('saving a dish recalculates on the server and rejects mismatched units', async () => {
      await c.post('/ingredients', { name: 'Flour', supplier: 'Brakes', pack_size: '5', pack_unit: 'kg', pack_price: '12', vat_rate: '0', waste_pct: '6' });
      const bad = await c.post('/dishes', {
        name: 'Bread', type: 'food', menu_price: '6', yield_portions: '1',
        line_ingredient: 'Flour (Brakes)', line_quantity: '200', line_unit: 'ml',
      });
      assert.equal(bad.status, 422);
      assert.match(bad.body, /Flour is bought by weight; use g or kg/);

      const good = await c.post('/dishes', {
        name: 'Bread', type: 'food', menu_price: '£6.00', yield_portions: '1', active: '1',
        line_ingredient: ['Flour (Brakes)', ''], line_quantity: ['200', ''], line_unit: ['g', 'g'],
      });
      assert.equal(good.status, 302);
      const page = await c.get(good.location);
      assert.match(page.body, /Saved Bread\. GP is now 89\.8%/); // (5 - 0.5088) / 5
      assert.ok(page.body.includes('£0.51'));
    });

    test('an ingredient used by a dish cannot be deleted; the message names the dish', async () => {
      const flour = (await listIngredients(db)).find((i) => i.name === 'Flour');
      const res = await c.post(`/ingredients/${flour.id}/delete`, {}, { follow: true });
      assert.match(res.body, /Flour is used in a dish \(Bread\)/);
      assert.ok((await listIngredients(db)).some((i) => i.name === 'Flour'));
    });

    test('ingredient price typed inc-VAT is stored ex-VAT and logged in history', async () => {
      const flour = (await listIngredients(db)).find((i) => i.name === 'Flour');
      await c.post(`/ingredients/${flour.id}`, {
        name: 'Flour', supplier: 'Brakes', pack_size: '5', pack_unit: 'kg', pack_price: '14.40', price_includes_vat: '1', vat_rate: '0.2', waste_pct: '6',
      });
      const after = (await listIngredients(db)).find((i) => i.name === 'Flour');
      assert.ok(Math.abs(after.pack_price_ex_vat - 12) < 1e-9, 'unchanged ex-VAT price');
      await c.post(`/ingredients/${flour.id}`, {
        name: 'Flour', supplier: 'Brakes', pack_size: '5', pack_unit: 'kg', pack_price: '15', vat_rate: '0', waste_pct: '6',
      });
      const page = await c.get('/ingredients');
      assert.match(page.body, /Recent prices/);
    });

    test('import: upload, preview, confirm, then dishes below alert are reported', async () => {
      const csv = '﻿Name,Supplier,Pack Size,Unit,Price,Waste\n'
        + 'Flour,brakes,5,KG,"£60.00",6%\n'          // existing (case differs) -> price change, Bread drops below 60%
        + 'Sugar,Brakes,"1,000",g,£1.20,0.05\n'      // new
        + 'Butter,,250,g,£2.10,5\n'                  // new
        + 'Tonic,,6,bottle,£3,0\n';                  // rejected: unit
      const up = await c.upload('/import/preview', 'prices.csv', csv);
      assert.equal(up.status, 302);
      const preview = await c.get(up.location);
      assert.match(preview.body, /Nothing has been saved yet/);
      assert.match(preview.body, /Row 5: pack_unit &#39;bottle&#39; not recognised — use g, kg, ml, l or each/);
      assert.equal((await listIngredients(db)).some((i) => i.name === 'Sugar'), false, 'nothing written before confirm');

      const errorsCsv = await c.get(`${up.location}/errors.csv`);
      assert.match(errorsCsv.body, /Tonic/);

      const commit = await c.post(`${up.location}/commit`, {});
      const result = await c.get(commit.location);
      assert.match(result.body, /Import complete/);
      assert.match(result.body, /now below your alert threshold/);
      assert.match(result.body, /Bread/);
      const ings = await listIngredients(db);
      assert.ok(ings.some((i) => i.name === 'Sugar' && i.pack_size === 1000));
      assert.equal(ings.find((i) => i.name === 'Flour').supplier, 'Brakes', 'keeps saved spelling');

      const again = await c.post(`${up.location}/commit`, {}, { follow: true });
      assert.match(again.body, /already confirmed/);
    });

    test('re-uploading the same file changes nothing', async () => {
      const csv = 'name,supplier,pack_size,pack_unit,pack_price,waste_pct\nSugar,Brakes,1000,g,1.20,5%\n';
      const up = await c.upload('/import/preview', 'same.csv', csv);
      const preview = await c.get(up.location);
      assert.match(preview.body, /Nothing to import/);
    });

    test('a bad file is refused with a clear reason', async () => {
      const res = await c.upload('/import/preview', 'x.csv', 'colour,size\nred,big\n');
      assert.equal(res.status, 400);
      assert.match(res.body, /Missing columns: name, pack_unit, pack_price/);
    });

    test('ingredient export round-trips through the importer and escapes formulas', async () => {
      await c.post('/ingredients', { name: '=HYPERLINK("x")', pack_size: '1', pack_unit: 'each', pack_price: '1', vat_rate: '0', waste_pct: '0' });
      const exp = await c.get('/export/ingredients.csv');
      assert.match(exp.headers.get('content-type'), /text\/csv/);
      assert.match(exp.body, /'=HYPERLINK/);
      const up = await c.upload('/import/preview', 'export.csv', exp.body);
      const preview = await c.get(up.location);
      assert.match(preview.body, /Nothing to import/);
    });

    test('dishes CSV, backup and template download', async () => {
      const dishes = await c.get('/export/dishes.csv');
      assert.match(dishes.body, /Example dish,food,yes,18,15,4\.77,10\.23,68\.2%/);
      const backup = JSON.parse((await c.get('/export/backup')).body);
      assert.equal(backup.app, 'gp-costing-calculator');
      assert.ok(backup.tables.dishes.length >= 2);
      assert.ok(!JSON.stringify(backup).includes('admin_password_hash'));
      const template = await c.get('/import/template.csv');
      assert.match(template.body, /name,supplier,category,pack_size,pack_unit,pack_price,price_includes_vat,vat_rate,waste_pct/);
    });

    test('delivery page shows the Dish A vector for Deliveroo', async () => {
      const res = await c.get('/delivery');
      assert.ok(res.body.includes('£26.57'));
      assert.ok(res.body.includes('£30.11'));
      assert.ok(res.body.includes('66.0%'));
    });

    test('settings save, validate and recalculate', async () => {
      const bad = await c.post('/settings', { vat_rate: '20', target_gp_food: '70', target_gp_drink: '70', alert_gp: '80', default_packaging: '0.50', round_up_to_pence: '0' });
      assert.equal(bad.status, 422);
      assert.match(bad.body, /alert threshold should be at or below/);
      await c.post('/settings', { vat_rate: '20', target_gp_food: '70', target_gp_drink: '70', alert_gp: '60', default_packaging: '0.50', round_up_to_pence: '50' });
      const dish = (await listDishes(db)).find((d) => d.name === 'Example dish');
      const res = await c.get(`/dishes/${dish.id}`);
      assert.ok(res.body.includes('£19.50'), 'suggested price rounded up to 50p');
    });

    test('password change takes effect and logs out other devices', async () => {
      const other = app.client();
      await other.login('password');
      assert.equal((await other.get('/')).status, 200);
      const wrong = await c.post('/settings/password', { current_password: 'x', new_password: 'longenough1', confirm_password: 'longenough1' });
      assert.equal(wrong.status, 422);
      await c.post('/settings/password', { current_password: 'password', new_password: 'new-password-123', confirm_password: 'new-password-123' });
      const anon = app.client();
      assert.equal((await anon.login('password')).status, 401);
      assert.equal((await app.client().login('new-password-123')).status, 302);
      assert.equal((await other.get('/')).location, '/login', 'other device logged out');
      assert.equal((await c.get('/')).status, 200, 'this device stays logged in');
    });

    test('logout ends the session', async () => {
      const u = app.client();
      await u.login('new-password-123');
      await u.post('/logout', {});
      assert.equal((await u.get('/')).location, '/login');
    });
  });
}

describe('login rate limit', () => {
  test('locks out after 10 failed attempts', async () => {
    const { db, cleanup } = await testDatabases()[0].create();
    const app = await startApp(db, { loginRateLimit: undefined });
    const c = app.client();
    await c.get('/login');
    let last;
    for (let i = 0; i < 11; i++) last = await c.post('/login', { password: 'wrong' });
    assert.equal(last.status, 429);
    assert.match(last.body, /Too many attempts/);
    await app.close();
    await cleanup();
  });
});
