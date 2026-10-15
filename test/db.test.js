import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, schemaVersion, getSettings, setSettings, listChannels } from '../src/db/index.js';
import { testDatabases } from './helpers/databases.js';

// Runs fn with a fresh database and always cleans up.
async function withDb(create, fn, opts) {
  const { db, cleanup } = await create(opts);
  try {
    await fn(db);
  } finally {
    await cleanup();
  }
}

const NOW = '2026-10-15T12:00:00.000Z';

for (const { name, create } of testDatabases()) {
  describe(`database (${name})`, () => {
    test('migrations apply once and are tracked', () => withDb(create, async (db) => {
      assert.deepEqual(await migrate(db), ['001_init.sql', '002_installed_at.sql']);
      assert.deepEqual(await migrate(db), [], 'second run applies nothing');
      assert.equal(await schemaVersion(db), 2);
    }, { migrated: false }));

    test('later migrations are applied in numeric order', () => withDb(create, async (db) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mig-'));
      fs.writeFileSync(path.join(dir, '010_b.sql'), "INSERT INTO t VALUES ('b');");
      fs.writeFileSync(path.join(dir, '002_a.sql'), "CREATE TABLE t (v VARCHAR(10));\nINSERT INTO t VALUES ('a');");
      try {
        assert.deepEqual(await migrate(db, dir), ['002_a.sql', '010_b.sql']);
        assert.deepEqual((await db.all('SELECT v FROM t ORDER BY v')).map((r) => r.v), ['a', 'b']);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    }, { migrated: false }));

    test('default settings and delivery channels are seeded', () => withDb(create, async (db) => {
      const { installed_at: installedAt, ...settings } = await getSettings(db);
      assert.match(installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.deepEqual(settings, {
        vat_rate: 0.2, target_gp_food: 0.7, target_gp_drink: 0.7,
        alert_gp: 0.6, default_packaging: 0.5, round_up_to_pence: 0,
      });
      await setSettings(db, { alert_gp: 0.55, example_new_key: 'x' });
      await setSettings(db, { alert_gp: 0.55 }); // same value again must not try to insert a duplicate
      assert.equal((await getSettings(db)).alert_gp, 0.55);
      assert.deepEqual((await listChannels(db)).map((c) => [c.name, c.commission]), [
        ['Deliveroo', 0.3], ['Just Eat', 0.14], ['Own website', 0.02], ['Uber Eats', 0.3],
      ]);
    }));

    test('foreign keys: an ingredient used by a dish cannot be deleted', () => withDb(create, async (db) => {
      const ing = (await db.run("INSERT INTO ingredients (name, pack_size, pack_unit, pack_price_ex_vat, updated_at) VALUES ('Flour', 5000, 'g', 12, ?)", [NOW])).insertId;
      const dish = (await db.run("INSERT INTO dishes (name, type) VALUES ('Bread', 'food')")).insertId;
      await db.run("INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity, unit) VALUES (?, ?, 200, 'g')", [dish, ing]);
      await assert.rejects(db.run('DELETE FROM ingredients WHERE id = ?', [ing]), /FOREIGN KEY|foreign key/);
      await db.run('DELETE FROM dishes WHERE id = ?', [dish]);
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM dish_ingredients')).n, 0, 'recipe lines cascade with the dish');
    }));

    test('ingredient name + supplier is unique ignoring case', () => withDb(create, async (db) => {
      const sql = "INSERT INTO ingredients (name, supplier, pack_size, pack_unit, pack_price_ex_vat, updated_at) VALUES (?, ?, 1, 'kg', 1, ?)";
      await db.run(sql, ['Flour', 'Brakes', NOW]);
      await db.run(sql, ['Flour', 'Bidfood', NOW]);
      await assert.rejects(db.run(sql, ['FLOUR', 'brakes', NOW]), /UNIQUE|Duplicate/);
    }));

    test('check constraints reject bad data', () => withDb(create, async (db) => {
      const sql = "INSERT INTO ingredients (name, pack_size, pack_unit, pack_price_ex_vat, waste_pct, updated_at) VALUES ('X', ?, ?, ?, ?, ?)";
      await assert.rejects(db.run(sql, [0, 'g', 1, 0.05, NOW]), /check constraint|CHECK/i);
      await assert.rejects(db.run(sql, [1, 'bottle', 1, 0.05, NOW]), /check constraint|CHECK/i);
      await assert.rejects(db.run(sql, [1, 'g', -1, 0.05, NOW]), /check constraint|CHECK/i);
      await assert.rejects(db.run(sql, [1, 'g', 1, 1, NOW]), /check constraint|CHECK/i);
    }));

    test('transactions roll back on error', () => withDb(create, async (db) => {
      await assert.rejects(db.transaction(async (tx) => {
        await tx.run('UPDATE settings SET value = ? WHERE `key` = ?', ['0.5', 'alert_gp']);
        throw new Error('boom');
      }), /boom/);
      assert.equal((await getSettings(db)).alert_gp, 0.6);
    }));

    test('numbers come back as numbers', () => withDb(create, async (db) => {
      await db.run("INSERT INTO ingredients (name, pack_size, pack_unit, pack_price_ex_vat, waste_pct, updated_at) VALUES ('Milk', 2.272, 'l', 1.45, 0.02, ?)", [NOW]);
      const row = await db.get('SELECT pack_size, pack_price_ex_vat, waste_pct FROM ingredients');
      assert.deepEqual(row, { pack_size: 2.272, pack_price_ex_vat: 1.45, waste_pct: 0.02 });
    }));
  });
}
