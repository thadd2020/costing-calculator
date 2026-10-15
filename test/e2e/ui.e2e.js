// End-to-end UI tests in headless Chromium, at desktop (1280x800) and mobile (360x740) sizes.
// Run with:  node --test test/e2e/ui.e2e.js
// Each viewport gets its own server and fresh database (seeded with Dish A and the house wine).
// Every page visited is also audited: console/page errors, failed requests, CSP violations,
// horizontal scroll, input labels, inputmode on numeric fields and £x.xx money formatting.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  VIEWPORTS, SHOT_DIR, startServer, openSession, auditor, withShot, notes, note,
} from './harness.js';

const DISH_A = 'Example dish';
const WINE = 'Example house wine (bottle)';

// Reads every live figure in the dish editor.
async function readDocket(page) {
  return page.evaluate(() => {
    const out = (k) => document.querySelector(`[data-out="${k}"]`)?.textContent.trim();
    const delivery = {};
    for (const row of document.querySelectorAll('[data-channel]')) {
      const name = row.querySelector('th').firstChild.textContent.trim();
      const d = (k) => row.querySelector(`[data-dout="${k}"]`).textContent.trim();
      delivery[name] = { incVat: d('incVat'), gpPct: d('gpPct'), holdTarget: d('holdTargetIncVat') };
    }
    return {
      gpPct: out('gpPct'), gpMoney: out('gpMoney'), trueCost: out('trueCost'), priceEx: out('priceEx'),
      targetGp: out('targetGp'), suggestedInc: out('suggestedInc'),
      status: document.querySelector('[data-out="status"] .status')?.textContent.replace(/\s+/g, ' ').trim(),
      delivery,
    };
  });
}

const visibleDishNames = (page) => page.$$eval('.dish-list > li', (lis) => lis
  .filter((li) => !li.hidden && li.getBoundingClientRect().height > 0)
  .map((li) => li.querySelector('.name').firstChild.textContent.trim()));

const flashText = (page) => page.locator('.flash').textContent();

async function login(page, password = 'password') {
  await page.goto('/login');
  await page.fill('#password', password);
  await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
}

// Opens the "Add an ingredient" panel and submits it.
async function addIngredient(page, { name, supplier = '', size, unit, price, waste = '' }) {
  await page.goto('/ingredients');
  const panel = page.locator('details#add');
  if (!(await panel.evaluate((d) => d.open))) await panel.locator('summary').click();
  await page.fill('#new-name', name);
  await page.fill('#new-supplier', supplier);
  await page.fill('#new-size', String(size));
  await page.selectOption('#new-unit', unit);
  await page.fill('#new-price', String(price));
  await page.fill('#new-waste', String(waste));
  await Promise.all([page.waitForLoadState('load'), panel.locator('button[type=submit]').click()]);
}

const ingredientItem = (page, name) => page.locator('.ing-list > li').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) });

for (const vp of Object.values(VIEWPORTS)) {
  describe(`UI at ${vp.name} (${vp.viewport.width}x${vp.viewport.height})`, () => {
    let server;
    let s; // browser session

    before(async () => {
      server = await startServer();
      s = await openSession(vp, server.base);
    });
    after(async () => {
      await s?.close();
      await server?.stop();
    });

    test('login: wrong password is refused, right password lands on dishes', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'login', async () => {
        await page.goto('/');
        assert.match(new URL(page.url()).pathname, /^\/login$/, 'logged-out visit should redirect to /login');
        await a.check('login page');
        await login(page, 'not-the-password');
        await assert.doesNotReject(page.locator('.errors', { hasText: "That password isn't right." }).waitFor());
        await a.check('login wrong password', { allowStatus: [401] });
        await login(page, 'password');
        assert.equal(new URL(page.url()).pathname, '/');
        await page.locator('h1', { hasText: 'Dishes' }).waitFor();
        await a.check('dishes after login');
      });
      a.done();
    });

    test('dishes list: seeded dishes show correct GP and status', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dishes-seeded', async () => {
        await page.goto('/');
        const dish = page.locator('.dish-list > li', { hasText: DISH_A }).first();
        assert.match(await dish.textContent(), /68\.2%/);
        assert.match(await dish.locator('.status').textContent(), /Under target/);
        assert.match(await dish.textContent(), /£4\.77/);
        assert.match(await dish.textContent(), /£18\.00/);
        const wine = page.locator('.dish-list > li', { hasText: WINE });
        assert.match(await wine.textContent(), /74\.5%/);
        assert.match(await wine.locator('.status').textContent(), /On target/);
        await a.check('dishes list');
      });
      a.done();
    });

    test('dishes list: live search narrows the list', async () => {
      const { page } = s;
      s.mark();
      await withShot(s, 'dishes-search', async () => {
        await page.goto('/');
        await page.fill('#q', 'wine');
        assert.deepEqual(await visibleDishNames(page), [WINE]);
        await page.fill('#q', '');
        assert.equal((await visibleDishNames(page)).length, 2);
      });
    });

    test('dishes list: live search with no matches shows an empty state', async () => {
      const { page } = s;
      await withShot(s, 'dishes-search-empty', async () => {
        await page.goto('/');
        await page.fill('#q', 'zzzz-no-such-dish');
        assert.deepEqual(await visibleDishNames(page), []);
        const empty = page.locator('.empty, [data-empty]', { hasText: /no (dishes|matches)/i });
        assert.ok(await empty.isVisible(), 'typing a search with no matches leaves a blank list: expected a "No matches" message');
      });
    });

    test('dishes list: server-side search with no matches shows "No matches"', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dishes-search-server-empty', async () => {
        await page.goto('/?q=zzzz');
        await page.locator('.empty h2', { hasText: 'No matches' }).waitFor();
        await page.click('text=Show all dishes');
        await page.waitForURL((u) => u.pathname === '/' && !u.search);
        await a.check('dishes no matches');
      });
      a.done();
    });

    test('dishes list: type filter, below-target filter and sort apply immediately', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dishes-filters', async () => {
        await page.goto('/');
        assert.ok(await page.locator('[data-hide-with-js]').isHidden(), 'Apply button should be hidden when JS runs');
        await Promise.all([page.waitForURL(/type=drink/), page.selectOption('#type', 'drink')]);
        assert.deepEqual(await visibleDishNames(page), [WINE]);
        await Promise.all([page.waitForURL(/type=food/), page.selectOption('#type', 'food')]);
        assert.deepEqual(await visibleDishNames(page), [DISH_A]);
        await Promise.all([page.waitForURL((u) => !u.search.includes('type=food')), page.selectOption('#type', '')]);

        await Promise.all([page.waitForURL(/below=1/), page.locator('label.chip-toggle', { hasText: 'Below target only' }).click()]);
        assert.deepEqual(await visibleDishNames(page), [DISH_A]);
        assert.ok(await page.locator('input[name=below]').isChecked());
        await Promise.all([page.waitForURL((u) => !u.search.includes('below=1')), page.locator('label.chip-toggle', { hasText: 'Below target only' }).click()]);

        await Promise.all([page.waitForURL(/sort=gp/), page.selectOption('#sort', 'gp')]);
        assert.deepEqual(await visibleDishNames(page), [DISH_A, WINE]);
        await Promise.all([page.waitForURL(/sort=price/), page.selectOption('#sort', 'price')]);
        assert.deepEqual(await visibleDishNames(page), [WINE, DISH_A]);
        await Promise.all([page.waitForURL(/sort=name/), page.selectOption('#sort', 'name')]);
        await a.check('dishes filters');
      });
      a.done();
    });

    test('dishes list: inactive dishes are hidden until "Show inactive"', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dishes-inactive', async () => {
        await page.goto('/dishes/new');
        await page.fill('#name', 'E2E retired special');
        const more = page.locator('details.panel', { hasText: 'More options' });
        await more.locator('summary').click();
        await page.locator('input[name=active]').uncheck();
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('.save-bar button[type=submit]')]);
        await a.check('inactive dish saved');
        await page.goto('/');
        assert.ok(!(await visibleDishNames(page)).includes('E2E retired special'));
        await Promise.all([page.waitForURL(/inactive=1/), page.locator('label.chip-toggle', { hasText: 'Show inactive' }).click()]);
        assert.ok((await visibleDishNames(page)).includes('E2E retired special'));
        assert.match(await page.locator('.dish-list > li', { hasText: 'E2E retired special' }).textContent(), /Inactive/);
        await a.check('dishes show inactive');
      });
      a.done();
    });

    test('ingredients: add, validation errors and inline edit', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'ingredients', async () => {
        await page.goto('/ingredients');
        await a.check('ingredients page');

        // Validation: blank name, zero pack size, negative price.
        await addIngredient(page, { name: '', size: '0', unit: 'kg', price: '-1' });
        const errors = page.locator('details#add .errors');
        await errors.waitFor();
        const text = await errors.textContent();
        assert.match(text, /Enter a name\./);
        assert.match(text, /Pack size must be a number above 0/);
        assert.match(text, /Pack price must be an amount like 12\.50/);
        assert.equal(await page.inputValue('#new-price'), '-1', 'typed values are kept after an error');
        await a.check('ingredient validation', { allowStatus: [422] });

        await addIngredient(page, { name: 'E2E flour', size: '5', unit: 'kg', price: '12.00', waste: '6' });
        assert.match(await flashText(page), /Added E2E flour\./);
        assert.match(await ingredientItem(page, 'E2E flour').textContent(), /£12\.00/);
        assert.match(await ingredientItem(page, 'E2E flour').textContent(), /£2\.40 per kg/);
        await addIngredient(page, { name: 'E2E steak', size: '1', unit: 'each', price: '4.50', waste: '6' });
        await addIngredient(page, { name: 'E2E lemon', supplier: 'Brakes', size: '10', unit: 'each', price: '£3.00', waste: '0' });
        assert.match(await flashText(page), /Added E2E lemon\./);
        await a.check('ingredients added');

        // Duplicate name + supplier.
        await addIngredient(page, { name: 'e2e lemon', supplier: 'brakes', size: '1', unit: 'each', price: '1' });
        assert.match(await page.locator('details#add .errors').textContent(), /already an ingredient called/);
        await a.check('ingredient duplicate', { allowStatus: [422] });

        // Inline edit: change the price, see the history.
        await page.goto('/ingredients');
        const lemon = ingredientItem(page, 'E2E lemon');
        await lemon.locator('summary').click();
        const priceInput = lemon.locator('input[name=pack_price]');
        assert.equal(await priceInput.inputValue(), '3.00');
        await priceInput.fill('3.60');
        await Promise.all([page.waitForLoadState('load'), lemon.locator('button', { hasText: 'Save changes' }).click()]);
        assert.match(await flashText(page), /Saved E2E lemon\. New price recorded/);
        const lemon2 = ingredientItem(page, 'E2E lemon');
        assert.match(await lemon2.locator('summary').textContent(), /£3\.60/);
        if (!(await lemon2.locator('details').evaluate((d) => d.open))) await lemon2.locator('summary').click();
        assert.match(await lemon2.locator('.history').textContent(), /£3\.00/);
        await a.check('ingredient edited');

        // Inline edit validation keeps the panel open with the error.
        await lemon2.locator('input[name=pack_size]').fill('0');
        await Promise.all([page.waitForLoadState('load'), lemon2.locator('button', { hasText: 'Save changes' }).click()]);
        const lemon3 = ingredientItem(page, 'E2E lemon');
        assert.ok(await lemon3.locator('details').evaluate((d) => d.open), 'edit panel should stay open after an error');
        assert.match(await lemon3.locator('.errors').textContent(), /Pack size must be a number above 0/);
        await a.check('ingredient edit validation', { allowStatus: [422] });
      });
      a.done();
    });

    test('ingredients: live search with no matches shows an empty state', async () => {
      const { page } = s;
      await withShot(s, 'ingredients-search-empty', async () => {
        await page.goto('/ingredients');
        await page.fill('#q', 'flour');
        assert.equal(await page.locator('[data-ing-count]').textContent(), '1');
        await page.fill('#q', 'zzzz-nothing');
        assert.equal(await page.locator('[data-ing-count]').textContent(), '0');
        const empty = page.locator('.empty', { hasText: /no (ingredients|matches)/i });
        assert.ok(await empty.isVisible(), 'searching ingredients with no matches leaves a blank list: expected a "No matches" message');
      });
    });

    test('ingredients: deleting one in use is refused with the dish names; unused one deletes', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'ingredients-delete', async () => {
        await page.goto('/ingredients');
        const used = ingredientItem(page, 'Example dish ingredients');
        assert.match(await used.textContent(), /Used in 1 dish/);
        await used.locator('summary').click();
        s.dialogAnswer = false; // cancel first: nothing happens
        s.dialogs.length = 0;
        await used.locator('button', { hasText: 'Delete ingredient' }).click();
        assert.equal(s.dialogs.at(-1)?.message, 'Delete Example dish ingredients?');
        assert.equal(new URL(page.url()).pathname, '/ingredients');
        s.dialogAnswer = true;
        await Promise.all([page.waitForLoadState('load'), used.locator('button', { hasText: 'Delete ingredient' }).click()]);
        const flash = page.locator('.flash.error');
        assert.match(await flash.textContent(), /Example dish ingredients is used in a dish \(Example dish\)\. Remove it from that dish first\./);
        assert.equal(await ingredientItem(page, 'Example dish ingredients').count(), 1);
        await a.check('ingredient in use');

        const lemon = ingredientItem(page, 'E2E lemon');
        await lemon.locator('summary').click();
        await Promise.all([page.waitForLoadState('load'), lemon.locator('button', { hasText: 'Delete ingredient' }).click()]);
        assert.match(await flashText(page), /Deleted E2E lemon\./);
        assert.equal(await ingredientItem(page, 'E2E lemon').count(), 0);
        await a.check('ingredient deleted');
      });
      a.done();
    });

    test('dish editor: live recalculation matches Dish A vectors and the server after save', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dish-editor-live', async () => {
        await page.goto('/dishes/new');
        await a.check('new dish page');
        const empty = await readDocket(page);
        assert.equal(empty.gpPct, 'n/a');
        assert.equal(empty.trueCost, '£0.00');

        const line0 = page.locator('[data-line]').nth(0);
        await line0.locator('[data-ing-label]').fill('E2E steak');
        assert.equal(await line0.locator('[data-unit]').inputValue(), 'each', 'unit follows the ingredient');
        await line0.locator('[data-qty]').fill('1');
        assert.equal((await readDocket(page)).trueCost, '£4.77');
        assert.equal(await line0.locator('[data-line-cost]').textContent(), '£4.77');

        // Type the price one key at a time: figures update on every keystroke.
        await page.locator('#menu_price').pressSequentially('1');
        const afterOne = await readDocket(page);
        assert.equal(afterOne.priceEx, '£0.83');
        assert.match(afterOne.status, /Below alert/);
        await page.locator('#menu_price').pressSequentially('8');
        const live = await readDocket(page);
        assert.equal(live.trueCost, '£4.77');
        assert.equal(live.priceEx, '£15.00');
        assert.equal(live.gpMoney, '£10.23');
        assert.equal(live.gpPct, '68.2%');
        assert.match(live.status, /Under target/);
        assert.equal(live.suggestedInc, '£19.08');
        assert.deepEqual(live.delivery.Deliveroo, { incVat: '£26.57', gpPct: '66.0%', holdTarget: '£30.11' });

        // Second line, by weight: 200 g of £12.00 / 5 kg with 6% waste = £0.5088.
        await page.click('[data-add-line]');
        const line1 = page.locator('[data-line]').nth(1);
        await line1.locator('[data-ing-label]').fill('E2E flour');
        assert.equal(await line1.locator('[data-unit]').inputValue(), 'g');
        const disabled = await line1.locator('[data-unit] option').evaluateAll((os) => os.filter((o) => o.disabled).map((o) => o.value));
        assert.deepEqual(disabled.sort(), ['each', 'l', 'ml']);
        await line1.locator('[data-qty]').fill('200');
        assert.equal(await line1.locator('[data-line-cost]').textContent(), '£0.51');
        const two = await readDocket(page);
        assert.equal(two.trueCost, '£5.28');
        assert.equal(two.gpMoney, '£9.72');
        assert.equal(two.gpPct, '64.8%');
        assert.equal(two.suggestedInc, '£21.12');

        // Unknown ingredient name gets a line message.
        await page.click('[data-add-line]');
        const line2 = page.locator('[data-line]').nth(2);
        await line2.locator('[data-ing-label]').fill('Unicorn tears');
        await line2.locator('[data-qty]').fill('1');
        assert.match(await line2.locator('[data-line-error]').textContent(), /isn't in your ingredient list/);
        assert.match(await page.locator('[data-out="errors"]').textContent(), /Cost incomplete/);
        await line2.locator('[data-remove-line]').click();
        assert.equal(await page.locator('[data-line]').count(), 2);
        assert.equal(await page.locator('[data-out="errors"]').textContent(), '');

        // Save without a name: server refuses and keeps everything typed.
        await Promise.all([page.waitForLoadState('load'), page.click('.save-bar button[type=submit]')]);
        assert.match(await page.locator('.errors').textContent(), /Give the dish a name\./);
        assert.equal(await page.inputValue('#menu_price'), '18.00');
        assert.equal(await page.locator('[data-line]').count(), 2);
        await a.check('dish save without name', { allowStatus: [422] });

        await page.fill('#name', 'E2E burger');
        const beforeSave = await readDocket(page);
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('.save-bar button[type=submit]')]);
        assert.match(await flashText(page), /Saved E2E burger\. GP is now 64\.8%\./);
        // Server-rendered figures (read before any typing) match the live ones.
        const served = await page.evaluate(() => document.querySelector('[data-out="gpPct"]').textContent);
        assert.equal(served, '64.8%');
        assert.deepEqual(await readDocket(page), beforeSave);
        await page.reload();
        assert.deepEqual(await readDocket(page), beforeSave);
        assert.equal(await page.inputValue('[data-line]:nth-child(2) [data-unit]'), 'g');
        await a.check('dish saved');
      });
      a.done();
    });

    test('dish editor: unit mismatch is reported in the browser and by the server', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dish-unit-mismatch', async () => {
        await page.goto('/');
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('text=E2E burger')]);
        // The dropdown blocks incompatible units, so force one as an old browser or crafted post could.
        const line1 = page.locator('[data-line]').nth(1);
        await line1.locator('[data-unit]').evaluate((sel) => {
          for (const o of sel.options) { o.disabled = false; o.hidden = false; }
          sel.value = 'each';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        assert.equal(await line1.locator('[data-line-error]').textContent(), 'E2E flour is bought by weight; use g or kg');
        await Promise.all([page.waitForLoadState('load'), page.click('.save-bar button[type=submit]')]);
        assert.match(await page.locator('.errors').textContent(), /Line 2: E2E flour is bought by weight; use g or kg\./);
        await a.check('dish unit mismatch', { allowStatus: [422] });
      });
      a.done();
    });

    test('dish editor: "Use this price" hits target GP and survives save and reload', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dish-use-suggested', async () => {
        await page.goto('/');
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('text=E2E burger')]);
        await page.click('[data-use-suggested]');
        assert.equal(await page.inputValue('#menu_price'), '21.12');
        const live = await readDocket(page);
        assert.equal(live.gpPct, '70.0%');
        assert.match(live.status, /On target/);
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('.save-bar button[type=submit]')]);
        assert.match(await flashText(page), /GP is now 70\.0%/);
        await page.reload();
        assert.equal(await page.inputValue('#menu_price'), '21.12');
        assert.deepEqual(await readDocket(page), live);
        await a.check('dish suggested price saved');
      });
      a.done();
    });

    test('dish editor: leaving after "Use this price" warns about the unsaved price', async () => {
      const { page } = s;
      await withShot(s, 'dish-use-suggested-unsaved', async () => {
        await page.goto(`/dishes/new`);
        await page.locator('[data-line]').nth(0).locator('[data-ing-label]').fill('E2E steak');
        await page.locator('[data-line]').nth(0).locator('[data-qty]').fill('1');
        await page.fill('#name', 'E2E unsaved');
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('.save-bar button[type=submit]')]);
        const id = page.url().match(/(\d+)$/)[1];
        await page.click('[data-use-suggested]'); // only change: the price filled in by the button
        assert.equal(await page.inputValue('#menu_price'), '19.08');
        s.dialogs.length = 0;
        await page.goto('/ingredients');
        const warned = s.dialogs.some((d) => d.type === 'beforeunload');
        // Clean up the dish.
        await page.goto(`/dishes/${id}`);
        await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button.danger')]);
        assert.ok(warned, '"Use this price" changes the price but leaving the page gives no unsaved-changes warning');
      });
    });

    test('dish editor: switching to Drink uses the drink target GP live', async () => {
      const { page } = s;
      await withShot(s, 'dish-drink-target', async () => {
        await page.goto('/settings');
        await page.fill('#target_gp_drink', '75');
        await Promise.all([page.waitForLoadState('load'), page.locator('form[action="/settings"] button[type=submit]').click()]);
        try {
          await page.goto('/dishes/new');
          assert.equal((await readDocket(page)).targetGp, '70.0%');
          await page.locator('.segmented label', { hasText: 'Drink' }).click();
          assert.equal((await readDocket(page)).targetGp, '75.0%');
          const hint = await page.locator('label[for=target_gp] .hint').textContent();
          if (!/75%/.test(hint)) note(s, `/dishes/new: after switching to Drink the Target GP hint still says "${hint}" (docket shows 75.0%)`);
        } finally {
          await page.goto('/settings');
          await page.fill('#target_gp_drink', '70');
          await Promise.all([page.waitForLoadState('load'), page.locator('form[action="/settings"] button[type=submit]').click()]);
        }
      });
    });

    test('dish editor: delete asks first, then removes the dish', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'dish-delete', async () => {
        await page.goto('/');
        await Promise.all([page.waitForURL(/\/dishes\/\d+$/), page.click('text=E2E burger')]);
        const url = page.url();
        s.dialogAnswer = false;
        s.dialogs.length = 0;
        await page.click('button.danger');
        assert.equal(s.dialogs.at(-1)?.message, "Delete E2E burger? This can't be undone.");
        assert.equal(page.url(), url, 'cancelling the confirm keeps the dish');
        s.dialogAnswer = true;
        await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button.danger')]);
        assert.match(await flashText(page), /Deleted E2E burger\./);
        assert.ok(!(await visibleDishNames(page)).includes('E2E burger'));
        await a.check('dish deleted');
      });
      a.done();
    });

    test('delivery: switching channel updates the prices', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'delivery', async () => {
        await page.goto('/delivery');
        const row = () => page.locator('table.data tbody tr', { hasText: DISH_A });
        assert.match(await row().textContent(), /£26\.57/);
        assert.match(await row().textContent(), /£22\.14/);
        assert.match(await row().textContent(), /66\.0%/);
        assert.match(await row().textContent(), /£30\.11/);
        assert.ok(await page.locator('[data-hide-with-js]').isHidden());
        await a.check('delivery Deliveroo');
        const justEat = await page.locator('#channel option', { hasText: 'Just Eat' }).getAttribute('value');
        await Promise.all([page.waitForURL(new RegExp(`channel=${justEat}`)), page.selectOption('#channel', justEat)]);
        assert.match(await page.locator('.lede').textContent(), /Just Eat's 14\.0% commission/);
        assert.match(await row().textContent(), /£21\.63/);
        assert.match(await row().textContent(), /£24\.51/);
        await a.check('delivery Just Eat');
      });
      a.done();
    });

    test('settings: target GP changes status, invalid values are refused', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      const save = () => Promise.all([page.waitForLoadState('load'), page.locator('form[action="/settings"] button[type=submit]').click()]);
      await withShot(s, 'settings', async () => {
        await page.goto('/settings');
        await a.check('settings page');
        await page.fill('#target_gp_food', '65');
        await save();
        assert.match(await flashText(page), /Settings saved/);
        await page.goto('/');
        assert.match(await page.locator('.dish-list > li', { hasText: DISH_A }).locator('.status').textContent(), /On target/);

        await page.goto('/settings');
        await page.fill('#target_gp_food', '120');
        await save();
        assert.match(await page.locator('.errors').textContent(), /Food target GP must be a percentage from 0 to 95/);
        assert.equal(await page.inputValue('#target_gp_food'), '120');
        await a.check('settings invalid target', { allowStatus: [422] });

        await page.fill('#target_gp_food', '70');
        await page.fill('#alert_gp', '80');
        await save();
        assert.match(await page.locator('.errors').textContent(), /alert threshold should be at or below both target GPs/);
        await page.fill('#alert_gp', '60');
        await page.fill('#default_packaging', 'abc');
        await save();
        assert.match(await page.locator('.errors').textContent(), /Default packaging must be an amount/);
        await a.check('settings invalid values', { allowStatus: [422] });

        await page.fill('#default_packaging', '0.50');
        await save();
        assert.match(await flashText(page), /Settings saved/);
        await page.goto('/');
        assert.match(await page.locator('.dish-list > li', { hasText: DISH_A }).locator('.status').textContent(), /Under target/);
        await a.check('dishes after settings restored');
      });
      a.done();
    });

    test('settings: add, edit, reject and remove a delivery channel', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      const addChannel = async (name, commission) => {
        await page.fill('#ch-new-name', name);
        await page.fill('#ch-new-comm', commission);
        await Promise.all([page.waitForLoadState('load'), page.click('form[action="/settings/channels"] button[type=submit]')]);
      };
      await withShot(s, 'settings-channels', async () => {
        await page.goto('/settings');
        await addChannel('E2E Phone', '5');
        assert.match(await flashText(page), /Added E2E Phone\./);
        const row = page.locator('form.channel-row').filter({ has: page.locator('input[name=name][value="E2E Phone"]') });
        await row.locator('input[name=commission]').fill('7.5');
        await Promise.all([page.waitForLoadState('load'), row.locator('button', { hasText: 'Save' }).click()]);
        assert.match(await flashText(page), /Saved E2E Phone\./);
        assert.equal(await row.locator('input[name=commission]').inputValue(), '7.5');
        await a.check('channel saved');

        await addChannel('E2E Bad', '150');
        assert.match(await page.locator('#channels .errors').textContent(), /Commission must be a percentage from 0 to 99\./);
        await addChannel('', '5');
        assert.match(await page.locator('#channels .errors').textContent(), /Give the channel a name\./);
        await addChannel('Deliveroo', '10');
        assert.match(await page.locator('#channels .errors').textContent(), /already a channel called Deliveroo/);
        await a.check('channel invalid', { allowStatus: [422] });

        await page.goto('/delivery');
        assert.ok(await page.locator('#channel option', { hasText: 'E2E Phone, 7.5% commission' }).count());

        await page.goto('/settings');
        s.dialogAnswer = false;
        await row.locator('button', { hasText: 'Remove' }).click();
        assert.equal(await row.count(), 1, 'cancelled remove keeps the channel');
        s.dialogAnswer = true;
        await Promise.all([page.waitForLoadState('load'), row.locator('button', { hasText: 'Remove' }).click()]);
        assert.match(await flashText(page), /Removed E2E Phone\./);
        assert.equal(await row.count(), 0);
        await a.check('channel removed');
      });
      a.done();
    });

    test('import wizard: bad files are refused with a clear message', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      const upload = async (name, content, mimeType = 'text/csv') => {
        await page.goto('/import');
        await page.setInputFiles('#file', { name, mimeType, buffer: Buffer.from(content) });
        await Promise.all([page.waitForLoadState('load'), page.click('form[action="/import/preview"] button[type=submit]')]);
      };
      await withShot(s, 'import-bad', async () => {
        await page.goto('/import');
        await a.check('import page');
        await upload('wrong.csv', 'foo,bar\n1,2\n');
        assert.match(await page.locator('.errors').textContent(), /Missing columns: name, pack_size, pack_unit, pack_price/);
        await upload('empty.csv', '');
        assert.match(await page.locator('.errors').textContent(), /The file is empty\./);
        await upload('photo.png', '\u0089PNG\u0000\u0000', 'image/png');
        assert.match(await page.locator('.errors').textContent(), /Choose a CSV file/);
        await a.check('import bad files', { allowStatus: [400] });

        // Every row bad: preview lists them, nothing to import, rejected rows downloadable.
        await upload('allbad.csv', 'name,pack_size,pack_unit,pack_price\nE2E jug,1,bottle,2.00\n,1,kg,1\n');
        await page.waitForURL(/\/import\/\d+$/);
        const rejected = page.locator('section', { hasText: 'Rejected rows' });
        assert.match(await rejected.textContent(), /Row 2: pack_unit 'bottle' not recognised/);
        assert.match(await page.locator('.confirm-bar').textContent(), /Nothing to import/);
        const href = await page.locator('a', { hasText: 'Download rejected rows' }).getAttribute('href');
        const res = await page.request.get(href);
        assert.equal(res.status(), 200);
        assert.match(res.headers()['content-type'], /text\/csv/);
        assert.match(await res.text(), /bottle/);
        await a.check('import all rejected');
        await Promise.all([page.waitForURL(/\/import$/), page.click('.confirm-bar button.secondary')]);
        assert.match(await flashText(page), /Import cancelled/);
      });
      a.done();
    });

    test('import wizard: upload, preview counts, confirm, result shows dish impact', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      // BOM, mixed-case headers with aliases (Unit, Price), a quoted £ price and a bad unit.
      const csv = '\ufeffName,Supplier,Category,Pack Size,Unit,Price,VAT_rate,Waste_pct\n'
        + 'E2E olive oil,Brakes,Oils,5,L,"£15.50",0%,2%\n'
        + 'Example dish ingredients,,Example,1,each,6.00,0,6%\n'
        + 'House wine (bottle),,Example,1,each,6.00,20%,2%\n'
        + 'E2E jug,,,3,bottle,2.00,0,0\n';
      await withShot(s, 'import-good', async () => {
        await page.goto('/import');
        await page.setInputFiles('#file', { name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await Promise.all([page.waitForURL(/\/import\/\d+$/), page.click('form[action="/import/preview"] button[type=submit]')]);
        const counts = Object.fromEntries(await page.$$eval('ul.counts li', (lis) => lis.map((li) => [li.querySelector('.k').textContent.trim(), li.querySelector('.figure').textContent.trim()])));
        assert.deepEqual(counts, { New: '1', 'Price changed': '1', 'Other details changed': '0', Unchanged: '1', Rejected: '1' });
        const changeRow = page.locator('table.data tbody tr', { hasText: 'Example dish ingredients' });
        assert.match(await changeRow.textContent(), /£4\.50/);
        assert.match(await changeRow.textContent(), /£6\.00/);
        assert.match(await changeRow.textContent(), /33\.3%/);
        assert.match(await page.locator('section', { hasText: 'Rejected rows' }).textContent(), /Row 5: pack_unit 'bottle' not recognised/);
        await a.check('import preview');

        // Nothing written yet.
        await page.goto('/ingredients');
        assert.equal(await ingredientItem(page, 'E2E olive oil').count(), 0);
        await page.goBack();

        await Promise.all([page.waitForLoadState('load'), page.locator('.confirm-bar button', { hasText: 'Import 2 changes' }).click()]);
        await page.locator('h1', { hasText: 'Import complete' }).waitFor();
        assert.match(await flashText(page), /Imported: 1 new, 1 price changes/);
        const impact = page.locator('section', { hasText: 'Effect on your dishes' });
        assert.match(await impact.textContent(), /1 dish is now below your alert threshold/);
        assert.match(await impact.locator('tr', { hasText: DISH_A }).textContent(), /68\.2%.*57\.6%/s);
        await a.check('import result');

        await page.goto('/ingredients');
        assert.match(await ingredientItem(page, 'E2E olive oil').textContent(), /£15\.50/);
        assert.match(await ingredientItem(page, 'Example dish ingredients').textContent(), /£6\.00/);
        await page.goto('/');
        assert.match(await page.locator('.summary-line').textContent(), /1 dish is below your alert threshold/);
        await a.check('dishes after import');
      });
      a.done();
    });

    test('import wizard: a price-only CSV (no category/waste/vat columns) does not wipe existing details', async () => {
      const { page } = s;
      await withShot(s, 'import-partial-columns', async () => {
        // A typical supplier list: just name, size, unit and price. The wine is stored with
        // category "Example", 20% VAT and 2% waste; this row repeats its current price.
        const csv = 'name,pack_size,pack_unit,pack_price\nHouse wine (bottle),1,each,6.00\n';
        await page.goto('/import');
        await page.setInputFiles('#file', { name: 'supplier.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
        await Promise.all([page.waitForURL(/\/import\/\d+$/), page.click('form[action="/import/preview"] button[type=submit]')]);
        const changes = await page.locator('table.data tbody').textContent().catch(() => '');
        await Promise.all([page.waitForURL(/\/import$/), page.click('.confirm-bar button.secondary')]);
        assert.equal(changes.replace(/\s+/g, ' ').trim(), '',
          `columns missing from the file overwrite stored values with defaults; preview shows: ${changes.replace(/\s+/g, ' ').trim()}`);
      });
    });

    test('export and backup: each download has the right type', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'export', async () => {
        await page.goto('/settings');
        await Promise.all([page.waitForURL(/\/export$/), page.locator('a', { hasText: 'Export and backup' }).click()]);
        await a.check('export page');
        const expectations = [
          ['/export/ingredients.csv', /text\/csv/, /^name,supplier,category,pack_size,pack_unit,pack_price,price_includes_vat,vat_rate,waste_pct/],
          ['/export/dishes.csv', /text\/csv/, /^name,type,active,menu_price_inc_vat/],
          ['/export/backup', /application\/json/, /^\{/],
          ['/import/template.csv', /text\/csv/, /Plain flour/],
        ];
        for (const [url, type, body] of expectations) {
          const res = await page.request.get(url);
          assert.equal(res.status(), 200, url);
          assert.match(res.headers()['content-type'], type, url);
          assert.match(res.headers()['content-disposition'] || '', /attachment; filename=/, url);
          assert.match((await res.text()).replace(/^\ufeff/, ''), body, url);
        }
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('a', { hasText: 'Ingredients CSV' }).click()]);
        assert.match(download.suggestedFilename(), /^ingredients-\d{4}-\d{2}-\d{2}\.csv$/);
        await a.check('export after download');
      });
      a.done();
    });

    test('logout ends the session', async () => {
      const { page } = s;
      s.mark();
      const a = auditor(s, assert);
      await withShot(s, 'logout', async () => {
        await page.goto('/');
        const button = page.locator('form.logout button');
        assert.ok(await button.isVisible(), 'Log out button should be visible');
        await Promise.all([page.waitForURL(/\/login$/), button.click()]);
        await page.goto('/ingredients');
        assert.match(new URL(page.url()).pathname, /^\/login$/);
        const res = await page.request.get('/export/backup', { maxRedirects: 0 });
        assert.equal(res.status(), 302, 'exports need a login');
        await a.check('after logout');
      });
      a.done();
    });
  });
}

after(() => {
  if (notes.length) {
    const file = path.join(SHOT_DIR, 'ux-notes.txt');
    fs.writeFileSync(file, `${notes.join('\n')}\n`);
    console.log(`\nUX notes (not failures), also in ${file}:\n  ${notes.join('\n  ')}`);
  }
  console.log(`Screenshots of failures (if any): ${SHOT_DIR}`);
});
