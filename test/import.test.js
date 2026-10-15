import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredientCsv, MAX_ROWS } from '../src/import/parse.js';
import { planImport } from '../src/import/plan.js';
import { parseFlexiblePercent, parseBoolean, parseUnit, parseMoney } from '../src/input.js';
import { safeCell } from '../src/csv.js';

const parse = (text) => parseIngredientCsv(Buffer.from(text, 'utf8'));
const HEAD = 'name,supplier,category,pack_size,pack_unit,pack_price,price_includes_vat,vat_rate,waste_pct\n';

describe('CSV parsing', () => {
  test('template columns with defaults', () => {
    const r = parse(`${HEAD}Plain flour,Brakes,Dry,16,kg,12.00,no,0%,2%\nEggs,,,30,each,6,,,\n`);
    assert.equal(r.fatal, null);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(r.rows[0].data, {
      name: 'Plain flour', supplier: 'Brakes', category: 'Dry', pack_size: 16, pack_unit: 'kg',
      pack_price_ex_vat: 12, vat_rate: 0, waste_pct: 0.02,
    });
    assert.equal(r.rows[1].data.waste_pct, 0.05, 'default waste 5%');
    assert.equal(r.rows[1].data.supplier, '');
    assert.equal(r.rows[1].row, 3, 'row numbers count the header as row 1');
  });

  test('UTF-8 BOM, case-insensitive headers and aliases', () => {
    const r = parse('﻿  Name , Size,UNIT, Price \nMilk,2.272,Litres,£1.45\n');
    assert.equal(r.fatal, null);
    assert.deepEqual([r.rows[0].data.name, r.rows[0].data.pack_size, r.rows[0].data.pack_unit, r.rows[0].data.pack_price_ex_vat], ['Milk', 2.272, 'l', 1.45]);
  });

  test('£ signs and thousands commas in prices and sizes', () => {
    const r = parse('name,pack_size,pack_unit,pack_price\nBeef,"1,000",g,"£1,250.50"\n');
    assert.equal(r.rows[0].data.pack_size, 1000);
    assert.equal(r.rows[0].data.pack_price_ex_vat, 1250.5);
  });

  test('waste as 6%, 6 or 0.06', () => {
    const r = parse('name,pack_size,pack_unit,pack_price,waste\nA,1,kg,1,6%\nB,1,kg,1,6\nC,1,kg,1,0.06\n');
    for (const row of r.rows) assert.ok(Math.abs(row.data.waste_pct - 0.06) < 1e-12, row.data.name);
  });

  test('price including VAT is converted with that row\'s own rate', () => {
    const r = parse('name,pack_size,pack_unit,pack_price,price_includes_vat,vat_rate\nWine,1,each,12,yes,20%\nBread,1,each,3,Y,0\nCrisps,1,each,1.20,true,0.2\n');
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.ok(Math.abs(r.rows[0].data.pack_price_ex_vat - 10) < 1e-12);
    assert.equal(r.rows[1].data.pack_price_ex_vat, 3, 'zero-rated: no VAT removed');
    assert.ok(Math.abs(r.rows[2].data.pack_price_ex_vat - 1) < 1e-12);
  });

  test('inc-VAT price with no VAT rate is rejected rather than guessed', () => {
    const r = parse('name,pack_size,pack_unit,pack_price,price_includes_vat\nWine,1,each,12,yes\n');
    assert.equal(r.rows.length, 0);
    assert.match(r.errors[0].message, /vat_rate is blank/);
  });

  test('bad rows are reported with row number and reason; good rows continue', () => {
    const r = parse(
      'name,pack_size,pack_unit,pack_price,waste_pct\n'
      + 'Good,1,kg,1,5%\n'
      + ',1,kg,1,5%\n'
      + 'NoSize,0,kg,1,5%\n'
      + 'Tonic,6,bottle,3,0\n'
      + 'Pricey,1,kg,abc,5%\n'
      + 'Wasteful,1,kg,1,150%\n'
      + 'Also good,500,ML,2,\n',
    );
    assert.deepEqual(r.rows.map((x) => x.data.name), ['Good', 'Also good']);
    assert.deepEqual(r.errors.map((e) => e.row), [3, 4, 5, 6, 7]);
    assert.equal(r.errors[2].message, "Row 5: pack_unit 'bottle' not recognised — use g, kg, ml, l or each");
    assert.match(r.errors[3].message, /Row 6: pack_price 'abc'/);
    assert.match(r.errors[4].message, /waste_pct/);
  });

  test('blank lines are skipped and row numbers still match the file', () => {
    const r = parse('name,pack_size,pack_unit,pack_price\n\nA,1,kg,1\n,,,\nB,1,kg,x\n');
    assert.deepEqual(r.rows.map((x) => x.row), [3]);
    assert.deepEqual(r.errors.map((e) => e.row), [5]);
  });

  test('duplicate name + supplier within the file: first wins, later reported', () => {
    const r = parse('name,supplier,pack_size,pack_unit,pack_price\nFlour,Brakes,1,kg,1\nflour,BRAKES,1,kg,2\nFlour,Bidfood,1,kg,3\n');
    assert.equal(r.rows.length, 2);
    assert.match(r.errors[0].message, /Row 3: same name and supplier as row 2/);
  });

  test('semicolon and tab separated files work', () => {
    assert.equal(parse('name;pack_size;pack_unit;pack_price\nA;1;kg;2\n').rows[0].data.pack_price_ex_vat, 2);
    assert.equal(parse('name\tpack_size\tpack_unit\tpack_price\nA\t1\tkg\t2\n').rows[0].data.pack_price_ex_vat, 2);
  });

  test('missing required columns is a clear whole-file error', () => {
    const r = parse('name,price\nA,1\n');
    assert.match(r.fatal, /Missing columns: pack_size, pack_unit/);
  });

  test('empty, binary and oversized files are refused', () => {
    assert.match(parse('').fatal, /empty/);
    assert.match(parseIngredientCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])).fatal, /doesn't look like a CSV/);
    assert.match(parseIngredientCsv(Buffer.alloc(2 * 1024 * 1024 + 1, 'a')).fatal, /larger than 2 MB/);
    const many = 'name,pack_size,pack_unit,pack_price\n' + Array.from({ length: MAX_ROWS + 1 }, (_, i) => `I${i},1,kg,1`).join('\n');
    assert.match(parse(many).fatal, /limit is 5000/);
  });

  test('formula-escaped cells from our own export are restored', () => {
    const r = parse(`name,pack_size,pack_unit,pack_price\n'=SUM(A1),1,kg,1\n`);
    assert.equal(r.rows[0].data.name, '=SUM(A1)');
  });
});

describe('import plan', () => {
  const existing = [{ id: 1, name: 'Flour', supplier: 'Brakes', category: '', pack_size: 16, pack_unit: 'kg', pack_price_ex_vat: 12, vat_rate: 0, waste_pct: 0.02 }];
  const row = (data) => ({ row: 2, data: { name: 'Flour', supplier: 'brakes', category: '', pack_size: 16, pack_unit: 'kg', pack_price_ex_vat: 12, vat_rate: 0, waste_pct: 0.02, ...data } });

  test('matches on name + supplier ignoring case', () => {
    const p = planImport([row({})], existing);
    assert.equal(p.items[0].action, 'unchanged');
    assert.equal(p.items[0].data.supplier, 'Brakes', 'keeps the saved spelling');
  });

  test('price change with percentage', () => {
    const p = planImport([row({ pack_price_ex_vat: 15 })], existing);
    assert.equal(p.items[0].action, 'price_changed');
    assert.ok(Math.abs(p.items[0].changePct - 0.25) < 1e-12);
  });

  test('detail change and new rows are counted', () => {
    const p = planImport([row({ waste_pct: 0.05 }), { row: 3, data: { ...row({}).data, name: 'Sugar' } }], existing, 2);
    assert.deepEqual(p.counts, { new: 1, price_changed: 0, details_changed: 1, unchanged: 0, rejected: 2 });
    assert.deepEqual(p.items[0].changedFields, ['waste_pct']);
  });
});

describe('input helpers', () => {
  test('percent, boolean, unit and money parsing', () => {
    assert.equal(parseFlexiblePercent('6%'), 0.06);
    assert.equal(parseFlexiblePercent('6'), 0.06);
    assert.equal(parseFlexiblePercent('0.06'), 0.06);
    assert.equal(parseFlexiblePercent('1'), 1, 'exactly 1 is a fraction (100%), rejected later as waste');
    for (const t of ['Y', 'yes', 'TRUE', '1']) assert.equal(parseBoolean(t), true, t);
    for (const t of ['n', 'No', 'false', '0', '']) assert.equal(parseBoolean(t), false, t);
    assert.equal(parseBoolean('maybe'), null);
    assert.equal(parseUnit('KG'), 'kg');
    assert.equal(parseUnit('Kg'), 'kg');
    assert.equal(parseUnit('bottle'), null);
    assert.equal(parseMoney('£ 12.50'), 12.5);
    assert.equal(parseMoney('12.5.0'), null);
  });

  test('formula injection escaping on export', () => {
    for (const s of ['=1+1', '+44', '-5', '@SUM(A1)']) assert.equal(safeCell(s), `'${s}`);
    assert.equal(safeCell('Flour'), 'Flour');
    assert.equal(safeCell(-5), '-5', 'real numbers are left alone');
  });
});
