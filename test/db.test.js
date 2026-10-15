import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate, schemaVersion, getSettings, setSettings, listChannels } from '../src/db/index.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('migrations apply once and are tracked', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db), ['001_init.sql']);
  assert.deepEqual(migrate(db), [], 'second run applies nothing');
  assert.equal(schemaVersion(db), 1);
});

test('later migrations are applied in numeric order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mig-'));
  fs.writeFileSync(path.join(dir, '010_b.sql'), "INSERT INTO t VALUES ('b');");
  fs.writeFileSync(path.join(dir, '002_a.sql'), "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a');");
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db, dir), ['002_a.sql', '010_b.sql']);
  assert.deepEqual(db.prepare('SELECT v FROM t').all().map((r) => r.v), ['a', 'b']);
  fs.rmSync(dir, { recursive: true });
});

test('default settings and delivery channels are seeded', () => {
  const db = freshDb();
  assert.deepEqual(getSettings(db), {
    vat_rate: 0.2, target_gp_food: 0.7, target_gp_drink: 0.7,
    alert_gp: 0.6, default_packaging: 0.5, round_up_to_pence: 0,
  });
  setSettings(db, { alert_gp: 0.55 });
  assert.equal(getSettings(db).alert_gp, 0.55);
  assert.deepEqual(listChannels(db).map((c) => [c.name, c.commission]), [
    ['Deliveroo', 0.3], ['Just Eat', 0.14], ['Own website', 0.02], ['Uber Eats', 0.3],
  ]);
});

test('foreign keys: an ingredient used by a dish cannot be deleted', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ing = db.prepare("INSERT INTO ingredients (name, pack_size, pack_unit, pack_price_ex_vat, updated_at) VALUES ('Flour', 5000, 'g', 12, ?)").run(now).lastInsertRowid;
  const dish = db.prepare("INSERT INTO dishes (name, type) VALUES ('Bread', 'food')").run().lastInsertRowid;
  db.prepare("INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity, unit) VALUES (?, ?, 200, 'g')").run(dish, ing);
  assert.throws(() => db.prepare('DELETE FROM ingredients WHERE id = ?').run(ing), /FOREIGN KEY/);
});

test('ingredient name + supplier is unique ignoring case', () => {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO ingredients (name, supplier, pack_size, pack_unit, pack_price_ex_vat, updated_at) VALUES (?, ?, 1, 'kg', 1, 'x')");
  ins.run('Flour', 'Brakes');
  ins.run('Flour', 'Bidfood');
  assert.throws(() => ins.run('FLOUR', 'brakes'), /UNIQUE/);
});

test('check constraints reject bad data', () => {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO ingredients (name, pack_size, pack_unit, pack_price_ex_vat, waste_pct, updated_at) VALUES ('X', ?, ?, ?, ?, 'x')");
  assert.throws(() => ins.run(0, 'g', 1, 0.05), /CHECK/);
  assert.throws(() => ins.run(1, 'bottle', 1, 0.05), /CHECK/);
  assert.throws(() => ins.run(1, 'g', -1, 0.05), /CHECK/);
  assert.throws(() => ins.run(1, 'g', 1, 1), /CHECK/);
});
