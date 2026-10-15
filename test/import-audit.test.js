// Audit of the CSV bulk import (CLAUDE.md section 7). Tests that fail here document real bugs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as csvParse } from 'csv-parse/sync';
import { parseIngredientCsv, MAX_ROWS } from '../src/import/parse.js';
import { previewImport, commitImport } from '../src/import/service.js';
import {
  listIngredients, createIngredient, updateIngredient, saveDish, getImportBatch, priceHistory,
} from '../src/db/index.js';
import { testDatabases } from './helpers/databases.js';
import { startApp } from './helpers/client.js';

const parse = (text) => parseIngredientCsv(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));
const H = 'name,pack_size,pack_unit,pack_price\n';
const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

const ING = { supplier: '', category: '', pack_size: 1, pack_unit: 'kg', pack_price_ex_vat: 10, vat_rate: 0, waste_pct: 0 };
const ingredient = (data) => ({ ...ING, ...data });
const DISH = { type: 'food', menu_price_inc_pence: 2400, vat_rate: null, target_gp: null, yield_portions: 1, packaging: null, active: 1, notes: '' };

async function freshDb() {
  return testDatabases()[0].create();
}

// A logged-in client on a fresh database.
async function withApp(fn) {
  const { db, cleanup } = await freshDb();
  const app = await startApp(db);
  const c = app.client();
  await c.login();
  try {
    await fn({ db, c, app });
  } finally {
    await app.close();
    await cleanup();
  }
}

async function uploadRaw(c, filename, content, type = 'text/csv') {
  const form = new FormData();
  form.append('_csrf', c.csrf);
  form.append('file', new Blob([content], { type }), filename);
  return c.request('/import/preview', { method: 'POST', body: form });
}

async function historyCount(db, id) {
  return (await priceHistory(db, id, 1000)).length;
}

// ---------------------------------------------------------------------------------------------
describe('import audit: headers and file shape', () => {
  test('odd-case, dashed and aliased headers all map', () => {
    const r = parse('INGREDIENT,Vendor,Type,Qty,UOM,Cost,Inc-VAT,VAT,Waste %\nFlour,Brakes,Dry,16,KG,£12.00,no,0,2%\n');
    assert.equal(r.fatal, null);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual(r.rows[0].data, {
      name: 'Flour', supplier: 'Brakes', category: 'Dry', pack_size: 16, pack_unit: 'kg',
      pack_price_ex_vat: 12, vat_rate: 0, waste_pct: 0.02,
    });
  });

  test('duplicated header: the first column wins', () => {
    const r = parse('name,pack_size,pack_unit,pack_price,pack_price\nFlour,1,kg,5,9\n');
    assert.equal(r.rows[0].data.pack_price_ex_vat, 5);
  });

  test('extra unknown columns are ignored', () => {
    const r = parse('code,name,notes,pack_size,pack_unit,pack_price,barcode\nX1,Flour,"lots, of notes",1,kg,2,5012345\n');
    assert.equal(r.fatal, null);
    assert.equal(r.rows[0].data.name, 'Flour');
    assert.equal(r.rows[0].data.pack_price_ex_vat, 2);
  });

  test('header only, no data: not fatal, nothing to import', () => {
    const r = parse(H);
    assert.equal(r.fatal, null);
    assert.equal(r.rows.length, 0);
  });

  test('a single missing required column is named', () => {
    assert.match(parse('name,pack_size,pack_unit\nA,1,kg\n').fatal, /Missing column: pack_price/);
  });

  test('empty and whitespace-only rows are skipped without errors', () => {
    const r = parse(`${H}\n   ,  ,\t, \nA,1,kg,1\n,,,\n\r\nB,1,kg,2\n   \n`);
    assert.deepEqual(r.rows.map((x) => x.data.name), ['A', 'B']);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  });

  test('quoted fields with commas, escaped quotes and newlines', () => {
    const r = parse(`${H}"Flour, plain ""00""",1,kg,2\n"Cheddar\nmature",1,kg,"£1,234.50"\n`);
    assert.equal(r.rows[0].data.name, 'Flour, plain "00"');
    assert.equal(r.rows[1].data.name, 'Cheddar mature', 'newline inside a name collapses to a space');
    assert.equal(r.rows[1].data.pack_price_ex_vat, 1234.5);
  });

  test('row number of a multi-line record is the line it starts on (spreadsheet row)', () => {
    const r = parse(`${H}"Cheddar\nmature",1,kg,x\n`);
    // The record starts on line 2; currently reported as row 3 (the line it ends on).
    assert.equal(r.errors[0].row, 2);
  });

  test('a stray quote in an unquoted field is kept as text, not a whole-file error', () => {
    const r = parse(`${H}12" pizza base,1,each,1\nFlour,1,kg,2\n`);
    assert.equal(r.fatal, null, `whole file refused: ${r.fatal}`);
    assert.deepEqual(r.rows.map((x) => x.data.name), ['12" pizza base', 'Flour']);
  });

  test('UTF-8 BOM with CRLF line endings', () => {
    const r = parse('﻿Name,Pack_Size,Pack_Unit,Pack_Price\r\nFlour,1,kg,2\r\nSugar,500,g,1\r\n');
    assert.equal(r.fatal, null);
    assert.deepEqual(r.rows.map((x) => [x.row, x.data.name]), [[2, 'Flour'], [3, 'Sugar']]);
  });

  test('old Mac CR-only line endings', () => {
    const r = parse('name,pack_size,pack_unit,pack_price\rA,1,kg,1\rB,1,kg,2\r');
    assert.equal(r.rows.length, 2);
  });

  test('a blank line before the header still finds the semicolon delimiter', () => {
    const r = parse('\nname;pack_size;pack_unit;pack_price\nFlour;1;kg;12\n');
    assert.equal(r.fatal, null, r.fatal);
    assert.equal(r.rows[0].data.pack_price_ex_vat, 12);
  });

  test('Windows-1252 (Excel "CSV Comma delimited") names are not silently corrupted', () => {
    // "Crème fraîche" in Windows-1252: è = 0xE8, î = 0xEE.
    const buf = Buffer.concat([Buffer.from(H), Buffer.from([0x43, 0x72, 0xe8, 0x6d, 0x65, 0x20, 0x66, 0x72, 0x61, 0xee, 0x63, 0x68, 0x65]), Buffer.from(',1,kg,2\n')]);
    const r = parseIngredientCsv(buf);
    const names = r.rows.map((x) => x.data.name);
    assert.ok(!names.some((n) => n.includes('�')), `stored with replacement chars: ${JSON.stringify(names)}`);
  });

  test('Windows-1252 £ sign (0xA3) in a price is understood', () => {
    const buf = Buffer.concat([Buffer.from(`${H}Flour,1,kg,`), Buffer.from([0xa3]), Buffer.from('12.50\n')]);
    const r = parseIngredientCsv(buf);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors.map((e) => e.message)));
    assert.equal(r.rows[0]?.data.pack_price_ex_vat, 12.5);
  });

  test('exactly 5000 rows is accepted, 5001 refused', () => {
    const rows = (n) => H + Array.from({ length: n }, (_, i) => `Item ${i},1,kg,1`).join('\n');
    const ok = parse(rows(MAX_ROWS));
    assert.equal(ok.fatal, null);
    assert.equal(ok.rows.length, 5000);
    assert.match(parse(rows(MAX_ROWS + 1)).fatal, /5001 rows; the limit is 5000/);
  });

  test('blank lines do not count towards the 5000-row limit', () => {
    const text = H + Array.from({ length: MAX_ROWS }, (_, i) => `Item ${i},1,kg,1\n`).join('') + '\n\n,,,\n';
    assert.equal(parse(text).fatal, null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('import audit: values', () => {
  const one = (cells, head = H) => parse(`${head}${cells}\n`);

  test('£, "£1,234.50", spaces and trailing whitespace in prices and names', () => {
    const r = parse(`${H}  Flour  ,  16 ,  kg ,  £12.00  \nBeef,"1,000",g," £ 1,234.50 "\n`);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.rows[0].data.name, 'Flour');
    assert.equal(r.rows[0].data.pack_price_ex_vat, 12);
    assert.equal(r.rows[1].data.pack_size, 1000);
    assert.equal(r.rows[1].data.pack_price_ex_vat, 1234.5);
  });

  test('European decimal comma "12,50" is not read as £1,250', () => {
    const r = parse('name;pack_size;pack_unit;pack_price\nFlour;1;kg;12,50\n');
    const price = r.rows[0]?.data.pack_price_ex_vat;
    assert.ok(price === undefined || close(price, 12.5), `12,50 became ${price}`);
  });

  test('"1.234,50" is not read as £1.2345', () => {
    const r = parse('name;pack_size;pack_unit;pack_price\nFlour;1;kg;1.234,50\n');
    const price = r.rows[0]?.data.pack_price_ex_vat;
    assert.ok(price === undefined || close(price, 1234.5), `1.234,50 became ${price}`);
  });

  test('misplaced commas ("1,2,3") are rejected, not merged into 123', () => {
    const r = one('A,1,kg,"1,2,3"');
    assert.equal(r.rows.length, 0, `accepted as ${r.rows[0]?.data.pack_price_ex_vat}`);
  });

  test('text, negative and zero values are rejected with the field named', () => {
    const cases = [
      ['A,abc,kg,1', 'pack_size'],
      ['A,0,kg,1', 'pack_size'],
      ['A,-1,kg,1', 'pack_size'],
      ['A,1,kg,-5', 'pack_price'],
      ['A,1,kg,-£5', 'pack_price'],
      ['A,1,kg,£', 'pack_price'],
      ['A,1,kg,twelve', 'pack_price'],
      ['A,1,bottle,1', 'pack_unit'],
      ['A,1,,1', 'pack_unit'],
      [',1,kg,1', 'name'],
    ];
    for (const [cells, field] of cases) {
      const r = one(cells);
      assert.equal(r.rows.length, 0, cells);
      assert.equal(r.errors[0].field, field, cells);
      assert.match(r.errors[0].message, /^Row 2: /, cells);
    }
  });

  test('price of zero is allowed (schema allows >= 0)', () => {
    assert.equal(one('Free herbs,1,each,0').rows[0].data.pack_price_ex_vat, 0);
  });

  test('waste 100% or more is rejected in every format', () => {
    const head = 'name,pack_size,pack_unit,pack_price,waste_pct\n';
    for (const w of ['100%', '100', '1', '1.0', '150', '-5%', 'lots']) {
      const r = one(`A,1,kg,1,${w}`, head);
      assert.equal(r.rows.length, 0, `waste ${w} accepted`);
      assert.equal(r.errors[0].field, 'waste_pct');
    }
    assert.ok(close(one('A,1,kg,1,99.5%', head).rows[0].data.waste_pct, 0.995));
    assert.equal(one('A,1,kg,1,0', head).rows[0].data.waste_pct, 0);
  });

  test('vat_rate must be 0 or 20%', () => {
    const head = 'name,pack_size,pack_unit,pack_price,vat_rate\n';
    for (const v of ['5%', '17.5', '0.175', '1', '100%', 'standard', '-20%']) {
      const r = one(`A,1,kg,1,${v}`, head);
      assert.equal(r.rows.length, 0, `vat ${v} accepted`);
      assert.equal(r.errors[0].field, 'vat_rate');
    }
    for (const v of ['20%', '20', '0.2', '0.20', '20 %', '0', '0%']) {
      const r = one(`A,1,kg,1,${v}`, head);
      assert.equal(r.errors.length, 0, `vat ${v} rejected`);
    }
  });

  test('price_includes_vat at 20% and 0%, and odd booleans', () => {
    const head = 'name,pack_size,pack_unit,pack_price,price_includes_vat,vat_rate\n';
    const r = parse(`${head}Wine,1,each,£14.40,YES,20%\nBread,1,each,3.00,Y,0%\nCola,1,each,1.20,inc vat,20\nJuice,1,each,1.20,no,20%\nTea,1,each,2,maybe,0\n`);
    const by = Object.fromEntries(r.rows.map((x) => [x.data.name, x.data]));
    assert.ok(close(by.Wine.pack_price_ex_vat, 12));
    assert.equal(by.Wine.vat_rate, 0.2);
    assert.equal(by.Bread.pack_price_ex_vat, 3, 'zero-rated: nothing removed');
    assert.ok(close(by.Cola.pack_price_ex_vat, 1));
    assert.equal(by.Juice.pack_price_ex_vat, 1.2, 'ex-VAT price kept as entered');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].field, 'price_includes_vat');
  });

  test('duplicates within the file ignore case and whitespace', () => {
    const r = parse('name,supplier,pack_size,pack_unit,pack_price\nPlain flour,Brakes,1,kg,1\n  PLAIN   FLOUR , brakes ,1,kg,2\nPlain flour,,1,kg,3\n');
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].data.pack_price_ex_vat, 1, 'first wins');
    assert.match(r.errors[0].message, /Row 3: same name and supplier as row 2/);
  });

  test('a duplicate after an invalid first occurrence is used', () => {
    const r = parse(`${H}Flour,1,kg,x\nFlour,1,kg,2\n`);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].data.pack_price_ex_vat, 2);
  });
});

// ---------------------------------------------------------------------------------------------
describe('import audit: commit service', () => {
  test('price_history is written for new rows and price changes only', async () => {
    const { db, cleanup } = await freshDb();
    try {
      const flour = (await createIngredient(db, ingredient({ name: 'Flour', supplier: 'Brakes', pack_price_ex_vat: 12 }))).id;
      const salt = (await createIngredient(db, ingredient({ name: 'Salt', pack_price_ex_vat: 1 }))).id;
      const oil = (await createIngredient(db, ingredient({ name: 'Oil', pack_unit: 'l', pack_price_ex_vat: 5 }))).id;
      const csv = 'name,supplier,pack_size,pack_unit,pack_price,waste_pct\n'
        + 'flour,BRAKES,1,kg,15,0\n' // price change
        + 'Salt,,1,kg,1,10%\n' //     details only
        + 'Oil,,1,l,5,0\n' //         unchanged
        + 'Sugar,,1,kg,2,0\n'; //     new
      const { batchId } = await previewImport(db, { filename: 'x.csv', buffer: Buffer.from(csv) });
      const { result } = await commitImport(db, batchId);
      assert.deepEqual([result.new, result.price_changed, result.details_changed, result.unchanged], [1, 1, 1, 1]);
      assert.equal(await historyCount(db, flour), 2);
      assert.equal((await priceHistory(db, flour))[0].source, 'import');
      assert.equal(await historyCount(db, salt), 1, 'no history row for a waste-only change');
      assert.equal(await historyCount(db, oil), 1);
      const sugar = (await listIngredients(db)).find((i) => i.name === 'Sugar');
      assert.equal(await historyCount(db, sugar.id), 1);
      // Committing the same file again is a no-op.
      const again = await previewImport(db, { filename: 'x.csv', buffer: Buffer.from(csv) });
      const second = await commitImport(db, again.batchId);
      assert.deepEqual([second.result.new, second.result.price_changed, second.result.details_changed], [0, 0, 0]);
      assert.equal(await historyCount(db, flour), 2);
    } finally { await cleanup(); }
  });

  test('a failure mid-commit rolls back every row (all-or-nothing)', async () => {
    const { db, cleanup } = await freshDb();
    try {
      const flour = (await createIngredient(db, ingredient({ name: 'Flour', pack_price_ex_vat: 12 }))).id;
      const csv = `${H}Flour,1,kg,20\nSugar,1,kg,2\nSalt,1,kg,1\nPepper,1,kg,9\n`;
      const { batchId } = await previewImport(db, { filename: 'x.csv', buffer: Buffer.from(csv) });
      // Wrap the transaction handle so the 3rd ingredient write throws.
      let writes = 0;
      const failing = {
        ...db,
        transaction: (fn) => db.transaction((tx) => fn({
          ...tx,
          run: async (sql, params) => {
            if (/^\s*(INSERT INTO|UPDATE) ingredients/.test(sql) && ++writes === 3) throw new Error('disk full');
            return tx.run(sql, params);
          },
        })),
      };
      await assert.rejects(commitImport(failing, batchId), /disk full/);
      const ings = await listIngredients(db);
      assert.deepEqual(ings.map((i) => i.name), ['Flour'], 'no new rows survived');
      assert.equal(ings[0].pack_price_ex_vat, 12, 'price update rolled back');
      assert.equal(await historyCount(db, flour), 1, 'history rolled back');
      assert.equal((await getImportBatch(db, batchId)).status, 'previewed', 'batch can be retried');
      const ok = await commitImport(db, batchId);
      assert.equal(ok.result.new, 3);
      assert.equal(ok.error, undefined);
    } finally { await cleanup(); }
  });

  test('ingredient edited between preview and commit: commit uses current values', async () => {
    const { db, cleanup } = await freshDb();
    try {
      const flour = (await createIngredient(db, ingredient({ name: 'Flour', pack_price_ex_vat: 12 }))).id;
      const { batchId } = await previewImport(db, { filename: 'x.csv', buffer: Buffer.from(`${H}Flour,1,kg,15\n`) });
      // Owner types the same new price by hand before confirming.
      await updateIngredient(db, flour, ingredient({ name: 'Flour', pack_price_ex_vat: 15 }));
      const { result } = await commitImport(db, batchId);
      assert.equal(result.price_changed, 0);
      assert.equal(await historyCount(db, flour), 2, 'only the manual change is in history');
    } finally { await cleanup(); }
  });

  test('ingredient deleted between preview and commit is re-created', async () => {
    const { db, cleanup } = await freshDb();
    try {
      const flour = (await createIngredient(db, ingredient({ name: 'Flour', pack_price_ex_vat: 12 }))).id;
      const { batchId } = await previewImport(db, { filename: 'x.csv', buffer: Buffer.from(`${H}Flour,1,kg,15\n`) });
      await db.run('DELETE FROM ingredients WHERE id = ?', [flour]);
      const { result } = await commitImport(db, batchId);
      assert.equal(result.new, 1);
      assert.equal((await listIngredients(db))[0].pack_price_ex_vat, 15);
    } finally { await cleanup(); }
  });

  test('commit of unknown, committed and discarded batches', async () => {
    const { db, cleanup } = await freshDb();
    try {
      assert.deepEqual(await commitImport(db, 999), { error: 'not_found' });
      const { batchId } = await previewImport(db, { filename: 'x.csv', buffer: Buffer.from(`${H}A,1,kg,1\n`) });
      await commitImport(db, batchId);
      assert.deepEqual(await commitImport(db, batchId), { error: 'committed' });
      const b2 = await previewImport(db, { filename: 'y.csv', buffer: Buffer.from(`${H}B,1,kg,1\n`) });
      await db.run("UPDATE import_batches SET status = 'discarded' WHERE id = ?", [b2.batchId]);
      assert.deepEqual(await commitImport(db, b2.batchId), { error: 'discarded' });
      assert.equal((await listIngredients(db)).some((i) => i.name === 'B'), false);
    } finally { await cleanup(); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('import audit: HTTP flow', () => {
  test('preview writes nothing; tampered commit body is ignored; double commit applies once', async () => {
    await withApp(async ({ db, c }) => {
      const flour = (await createIngredient(db, ingredient({ name: 'Flour', pack_price_ex_vat: 12 }))).id;
      const up = await c.upload('/import/preview', 'p.csv', `${H}Flour,1,kg,15\nSugar,1,kg,2\n`);
      assert.equal(up.status, 302);
      await c.get(up.location);
      assert.equal((await listIngredients(db)).length, 1, 'nothing written on preview');

      const noCsrf = await c.post(`${up.location}/commit`, {}, { csrf: false });
      assert.equal(noCsrf.status, 403);
      assert.equal((await listIngredients(db)).length, 1);

      // Extra fields that try to change the rows are ignored; two commits race.
      const tamper = { rows: 'Flour,1,kg,0.01', pack_price: '0.01', name: 'Evil', payload: '{"rows":[]}' };
      const [a, b] = await Promise.all([c.post(`${up.location}/commit`, tamper), c.post(`${up.location}/commit`, tamper)]);
      assert.equal(a.status, 302);
      assert.equal(b.status, 302);
      const ings = await listIngredients(db);
      assert.deepEqual(ings.map((i) => [i.name, i.pack_price_ex_vat]), [['Flour', 15], ['Sugar', 2]]);
      assert.equal(await historyCount(db, flour), 2, 'one price change recorded once');
    });
  });

  test('commit/preview/errors for unknown or malformed batch ids are 404', async () => {
    await withApp(async ({ c }) => {
      assert.equal((await c.post('/import/9999/commit', {})).status, 404);
      assert.equal((await c.post('/import/abc/commit', {})).status, 404);
      assert.equal((await c.get('/import/9999')).status, 404);
      assert.equal((await c.get('/import/9999/errors.csv')).status, 404);
    });
  });

  test('committing a discarded batch is refused and writes nothing', async () => {
    await withApp(async ({ db, c }) => {
      const up = await c.upload('/import/preview', 'p.csv', `${H}Sugar,1,kg,2\n`);
      await c.get(up.location);
      await c.post(`${up.location}/discard`, {});
      const res = await c.post(`${up.location}/commit`, {}, { follow: true });
      assert.match(res.body, /cancelled/);
      assert.equal((await listIngredients(db)).length, 0);
    });
  });

  test('cancelling an already-committed import does not claim "Nothing was changed"', async () => {
    await withApp(async ({ db, c }) => {
      const up = await c.upload('/import/preview', 'p.csv', `${H}Sugar,1,kg,2\n`);
      await c.get(up.location);
      await c.post(`${up.location}/commit`, {}, { follow: true });
      const res = await c.post(`${up.location}/discard`, {}, { follow: true });
      assert.equal((await listIngredients(db)).length, 1, 'still imported');
      assert.doesNotMatch(res.body, /Nothing was changed/);
    });
  });

  test('errors.csv lists every rejected row with its reason and escapes formulas', async () => {
    await withApp(async ({ c }) => {
      const csv = 'name,supplier,pack_size,pack_unit,pack_price,waste_pct\n'
        + 'Good,,1,kg,1,0\n'
        + '"=HYPERLINK(""http://evil"")",,1,bottle,1,0\n'
        + 'Tonic,@supplier,1,kg,abc,0\n'
        + '"Flour, plain",,0,kg,1,0\n'
        + 'Good,,1,kg,9,0\n';
      const up = await c.upload('/import/preview', 'p.csv', csv);
      assert.equal(up.status, 302, up.body);
      const res = await c.get(`${up.location}/errors.csv`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="rejected-rows-\d+\.csv"/);
      const records = csvParse(res.body, { bom: true });
      assert.deepEqual(records[0], ['row', 'problem', 'name', 'supplier', 'category', 'pack_size', 'pack_unit', 'pack_price', 'price_includes_vat', 'vat_rate', 'waste_pct']);
      const body = records.slice(1);
      assert.deepEqual(body.map((r) => r[0]), ['3', '4', '5', '6']);
      assert.equal(body[0][2], `'=HYPERLINK("http://evil")`, 'formula escaped');
      assert.match(body[0][1], /pack_unit 'bottle' not recognised/);
      assert.equal(body[1][3], "'@supplier");
      assert.equal(body[2][2], 'Flour, plain');
      assert.match(body[3][1], /same name and supplier as row 2/);
    });
  });

  test('upload limits: >2 MB, no file, wrong type, binary', async () => {
    await withApp(async ({ c }) => {
      await c.get('/import');
      const big = Buffer.alloc(2 * 1024 * 1024 + 10, 'a');
      const tooBig = await uploadRaw(c, 'big.csv', big);
      assert.equal(tooBig.status, 400);
      assert.match(tooBig.body, /larger than 2 MB/);

      const none = await c.request('/import/preview', { method: 'POST', body: (() => { const f = new FormData(); f.append('_csrf', c.csrf); return f; })() });
      assert.equal(none.status, 400);
      assert.match(none.body, /Choose a CSV file/);

      const png = await uploadRaw(c, 'photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), 'image/png');
      assert.equal(png.status, 400);

      const xlsx = await uploadRaw(c, 'prices.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.equal(xlsx.status, 400);

      const binaryCsv = await uploadRaw(c, 'prices.csv', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]));
      assert.equal(binaryCsv.status, 400);
      assert.match(binaryCsv.body, /look like a CSV/);

      const ok = await uploadRaw(c, 'prices.txt', `${H}A,1,kg,1\n`, 'text/plain');
      assert.equal(ok.status, 302, 'text/plain is accepted');
    });
  });

  test('a price change via pack size (same price, smaller pack) is reported in dish impact', async () => {
    await withApp(async ({ db, c }) => {
      const beef = (await createIngredient(db, ingredient({ name: 'Beef', pack_size: 1, pack_unit: 'kg', pack_price_ex_vat: 10 }))).id;
      // 500 g = £5 cost; £24 inc = £20 ex -> GP 75%.
      await saveDish(db, null, { ...DISH, name: 'Steak' }, [{ ingredient_id: beef, quantity: 500, unit: 'g' }]);
      // Supplier shrinks the pack to 500 g at the same price -> cost £10, GP 50% (below the 60% alert).
      const up = await c.upload('/import/preview', 'p.csv', `${H}Beef,0.5,kg,10\n`);
      await c.get(up.location);
      const res = await c.post(`${up.location}/commit`, {}, { follow: true });
      assert.match(res.body, /Import complete/);
      assert.match(res.body, /Steak/, 'dish that fell below alert is not listed');
      assert.match(res.body, /now below your alert threshold/);
    });
  });

  test('an import that changes pack_unit family does not silently break recipes', async () => {
    await withApp(async ({ db, c }) => {
      const cream = (await createIngredient(db, ingredient({ name: 'Cream', pack_size: 1, pack_unit: 'kg', pack_price_ex_vat: 4 }))).id;
      await saveDish(db, null, { ...DISH, name: 'Panna cotta' }, [{ ingredient_id: cream, quantity: 200, unit: 'g' }]);
      const up = await c.upload('/import/preview', 'p.csv', `${H}Cream,1,l,4\n`);
      const preview = await c.get(up.location);
      const rejected = /Cream/.test(preview.body) && /Rejected rows/.test(preview.body);
      if (rejected) return;
      const res = await c.post(`${up.location}/commit`, {}, { follow: true });
      assert.match(res.body, /Panna cotta/, 'kg -> l committed, but the dish with a g recipe line is not flagged');
    });
  });

  test('export -> re-import round-trip: commas, quotes, formula characters', async () => {
    const tricky = [
      ingredient({ name: 'Flour, plain "00"', supplier: 'Smith & Sons, Ltd', category: 'Dry, bulk', pack_price_ex_vat: 12.345678 }),
      ingredient({ name: '=HYPERLINK("http://evil")', pack_unit: 'each' }),
      ingredient({ name: '+44 hot sauce', supplier: '-Discount', vat_rate: 0.2, waste_pct: 0.025 }),
      ingredient({ name: '@home blend', category: '=1+1', pack_size: 2.272, pack_unit: 'l' }),
      ingredient({ name: 'Crème fraîche', supplier: 'Müller', pack_size: 500, pack_unit: 'ml', pack_price_ex_vat: 10 / 1.2 }),
    ];
    let exported;
    await withApp(async ({ db, c }) => {
      for (const t of tricky) assert.ok((await createIngredient(db, t)).id);
      const res = await c.get('/export/ingredients.csv');
      exported = res.body;
      const cells = csvParse(exported, { bom: true }).slice(1);
      for (const row of cells) {
        for (const cell of row) assert.doesNotMatch(cell, /^[=+\-@]/, `unescaped formula cell: ${cell}`);
      }
      // Same database: nothing to import.
      const up = await c.upload('/import/preview', 'export.csv', exported);
      assert.match((await c.get(up.location)).body, /Nothing to import/);
    });
    // Fresh database: everything comes back identical.
    await withApp(async ({ db, c }) => {
      const up = await c.upload('/import/preview', 'export.csv', exported);
      await c.get(up.location);
      await c.post(`${up.location}/commit`, {});
      const got = (await listIngredients(db)).map(({ name, supplier, category, pack_size, pack_unit, pack_price_ex_vat, vat_rate, waste_pct }) => ({ name, supplier, category, pack_size, pack_unit, pack_price_ex_vat, vat_rate, waste_pct }));
      const want = tricky.map((t) => ({ ...t }));
      const sortByName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      got.sort(sortByName); want.sort(sortByName);
      assert.equal(got.length, want.length);
      for (let i = 0; i < want.length; i += 1) {
        for (const k of Object.keys(want[i])) {
          if (typeof want[i][k] === 'number') assert.ok(close(got[i][k], want[i][k], 1e-9), `${want[i].name}.${k}: ${got[i][k]} vs ${want[i][k]}`);
          else assert.equal(got[i][k], want[i][k], `${want[i].name}.${k}`);
        }
      }
    });
  });

  test('a name that genuinely starts with an apostrophe + formula char survives a round-trip', async () => {
    await withApp(async ({ db, c }) => {
      await createIngredient(db, ingredient({ name: "'+ special" }));
      const exported = (await c.get('/export/ingredients.csv')).body;
      await db.run('DELETE FROM price_history');
      await db.run('DELETE FROM ingredients');
      const up = await c.upload('/import/preview', 'export.csv', exported);
      await c.get(up.location);
      await c.post(`${up.location}/commit`, {});
      assert.equal((await listIngredients(db))[0].name, "'+ special");
    });
  });

  test('duplicates vs the database ignore case and extra whitespace', async () => {
    await withApp(async ({ db, c }) => {
      await createIngredient(db, ingredient({ name: 'Plain flour', supplier: 'Brakes', pack_price_ex_vat: 12 }));
      const up = await c.upload('/import/preview', 'p.csv', 'name,supplier,pack_size,pack_unit,pack_price\n  PLAIN   FLOUR ,  brakes ,1,kg,13\n');
      await c.get(up.location);
      await c.post(`${up.location}/commit`, {});
      const ings = await listIngredients(db);
      assert.equal(ings.length, 1);
      assert.deepEqual([ings[0].name, ings[0].supplier, ings[0].pack_price_ex_vat], ['Plain flour', 'Brakes', 13]);
    });
  });
});
