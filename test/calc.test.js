import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as calc from '../src/calc/calc.js';

const TOL = 1e-6;
function near(actual, expected, tol = TOL, msg = '') {
  assert.ok(typeof actual === 'number' && Number.isFinite(actual), `${msg} expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);
}

// Walks any result object and fails on NaN or Infinity anywhere inside it.
function assertNoNaN(value, path = 'result') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is ${value}`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

const SETTINGS = {
  vat_rate: 0.2, target_gp_food: 0.7, target_gp_drink: 0.7,
  alert_gp: 0.6, default_packaging: 0.5, round_up_to_pence: 0,
};

const each = (name, price, waste) => ({
  name, pack_size: 1, pack_unit: 'each', pack_price_ex_vat: price, waste_pct: waste,
});

const dishA = {
  dish: { type: 'food', menu_price_inc_pence: 1800, yield_portions: 1 },
  lines: [{ quantity: 1, unit: 'each', ingredient: each('Dish A ingredients', 4.5, 0.06) }],
};

const wine = {
  dish: { type: 'drink', menu_price_inc_pence: 2880, yield_portions: 1 },
  lines: [{ quantity: 1, unit: 'each', ingredient: each('House wine', 6, 0.02) }],
};

describe('test vectors (CLAUDE.md section 6)', () => {
  test('unit cost: £12.00 for 5000 g is 0.0024 per g', () => {
    near(calc.unitCost(12, 5000, 'g'), 0.0024);
    near(calc.unitCost(12, 5, 'kg'), 0.0024, TOL, 'same pack expressed in kg');
  });

  test('line cost: 200 g at 0.0024 with 6% waste is 0.5088', () => {
    const flour = { name: 'Flour', pack_size: 5000, pack_unit: 'g', pack_price_ex_vat: 12, waste_pct: 0.06 };
    const r = calc.lineCost({ quantity: 200, unit: 'g' }, flour);
    assert.equal(r.error, null);
    near(r.cost, 0.5088);
    near(calc.lineCost({ quantity: 0.2, unit: 'kg' }, flour).cost, 0.5088, TOL, 'kg recipe line');
  });

  test('Dish A: cost, GP and status', () => {
    const r = calc.costDish(dishA.dish, dishA.lines, SETTINGS);
    near(r.trueCost, 4.77);
    near(r.priceEx, 15.0);
    near(r.gpMoney, 10.23);
    near(r.gpPct, 0.682);
    assert.equal(r.status.label, 'Under target');
  });

  test('Dish A suggested price at 70% target', () => {
    const r = calc.costDish(dishA.dish, dishA.lines, SETTINGS);
    near(r.suggested.exVat, 15.9);
    near(r.suggested.incVat, 19.08);
  });

  test('house wine', () => {
    const r = calc.costDish(wine.dish, wine.lines, SETTINGS);
    near(r.trueCost, 6.12);
    near(r.priceEx, 24.0);
    near(r.gpMoney, 17.88);
    near(r.gpPct, 0.745);
    assert.equal(r.status.label, 'On target');
    near(r.suggested.exVat, 20.4);
    near(r.suggested.incVat, 24.48);
  });

  test('delivery: Dish A, 30% commission, £0.50 packaging', () => {
    const r = calc.costDish(dishA.dish, dishA.lines, SETTINGS, [{ id: 1, name: 'Deliveroo', commission: 0.3 }]);
    const d = r.delivery[0];
    near(d.exVat, 22.142857, 1e-6);
    near(d.incVat, 26.571429, 1e-6);
    near(d.revenueKept, 15.5);
    near(d.gpMoney, 10.23);
    near(d.gpPct, 0.66);
    near(d.holdTargetExVat, 25.095238, 1e-6);
    near(d.holdTargetIncVat, 30.114286, 1e-6);
  });

  test('markup: 70% GP at cost 30, price 100 is 2.3333', () => {
    near(calc.markupPct(100, 30), 2.333333, 1e-6);
  });
});

describe('edge cases: never NaN or Infinity', () => {
  const channels = [
    { id: 1, name: 'Zero', commission: 0 },
    { id: 2, name: 'Deliveroo', commission: 0.3 },
  ];

  test('price 0 gives n/a GP and status', () => {
    const r = calc.costDish({ ...dishA.dish, menu_price_inc_pence: 0 }, dishA.lines, SETTINGS, channels);
    assertNoNaN(r);
    assert.equal(r.gpPct, null);
    assert.equal(r.gpMoney, null);
    assert.equal(r.status.key, 'na');
    assert.equal(r.delivery[1].exVat, null);
    near(r.delivery[1].holdTargetExVat, 25.095238, 1e-6, 'hold-target price still works without a menu price');
    near(r.suggested.exVat, 15.9, TOL, 'suggested price still works without a menu price');
  });

  test('price missing gives n/a', () => {
    const r = calc.costDish({ ...dishA.dish, menu_price_inc_pence: null }, dishA.lines, SETTINGS, channels);
    assertNoNaN(r);
    assert.equal(r.priceEx, null);
    assert.equal(r.gpPct, null);
    assert.equal(r.markupPct, null);
  });

  test('waste 0', () => {
    const lines = [{ quantity: 1, unit: 'each', ingredient: each('X', 4.5, 0) }];
    const r = calc.costDish(dishA.dish, lines, SETTINGS);
    near(r.trueCost, 4.5);
    assertNoNaN(r);
  });

  test('yield 4 divides the batch cost', () => {
    const lines = [{ quantity: 4, unit: 'each', ingredient: each('X', 4.5, 0.06) }];
    const r = calc.costDish({ ...dishA.dish, yield_portions: 4 }, lines, SETTINGS);
    near(r.trueCost, 4.77);
  });

  test('yield 0 or missing cost gives n/a', () => {
    assert.equal(calc.trueCost([1, 2], 0), null);
    assert.equal(calc.trueCost([1, null], 1), null);
  });

  test('mismatched units give a clear message and n/a cost', () => {
    const flour = { name: 'Flour', pack_size: 1.5, pack_unit: 'kg', pack_price_ex_vat: 2, waste_pct: 0.05 };
    const r = calc.costDish(dishA.dish, [{ quantity: 100, unit: 'ml', ingredient: flour }], SETTINGS, channels);
    assertNoNaN(r);
    assert.deepEqual(r.errors, ['Flour is bought by weight; use g or kg']);
    assert.equal(r.trueCost, null);
    assert.equal(r.gpPct, null);
  });

  test('commission 0: delivery price is just price plus packaging', () => {
    const r = calc.costDish(dishA.dish, dishA.lines, SETTINGS, channels);
    const d = r.delivery[0];
    assertNoNaN(r);
    near(d.exVat, 15.5);
    near(d.revenueKept, 15.5);
  });

  test('impossible rates give n/a, not Infinity', () => {
    assert.deepEqual(calc.suggestedPrice(5, 1, 0.2), { exVat: null, incVat: null });
    assert.equal(calc.deliveryPricing({ priceEx: 10, cost: 3, packaging: 0, commission: 1, vatRate: 0.2, targetGp: 0.7 }).exVat, null);
    assert.equal(calc.markupPct(10, 0), null);
    assert.equal(calc.unitCost(5, 0, 'g'), null);
    assert.equal(calc.priceExVat('abc', 0.2), null);
  });

  test('no recipe lines: zero cost is valid', () => {
    const r = calc.costDish(dishA.dish, [], SETTINGS);
    assert.equal(r.trueCost, 0);
    near(r.gpPct, 1);
    assert.equal(r.markupPct, null);
  });
});

describe('units', () => {
  test('conversions to base units', () => {
    assert.equal(calc.toBase(1.5, 'kg'), 1500);
    assert.equal(calc.toBase(0.75, 'l'), 750);
    assert.equal(calc.toBase(3, 'each'), 3);
    assert.equal(calc.toBase(3, 'bottle'), null);
  });

  test('families', () => {
    assert.ok(calc.unitsCompatible('g', 'kg'));
    assert.ok(calc.unitsCompatible('l', 'ml'));
    assert.ok(!calc.unitsCompatible('g', 'ml'));
    assert.ok(!calc.unitsCompatible('each', 'g'));
  });

  test('mismatch messages', () => {
    assert.equal(calc.unitMismatchMessage('Milk', 'l'), 'Milk is bought by volume; use ml or l');
    assert.equal(calc.unitMismatchMessage('Eggs', 'each'), 'Eggs is bought by the item; use each');
  });
});

describe('VAT and rounding', () => {
  test('ex-VAT from inc-VAT uses the item rate, not a blanket 1.20', () => {
    near(calc.exVatFromInc(12, 0.2), 10);
    near(calc.exVatFromInc(12, 0), 12);
  });

  test('round up only, to 5p / 10p / 50p', () => {
    near(calc.roundUpToStep(19.08, 5), 19.1);
    near(calc.roundUpToStep(19.08, 10), 19.1);
    near(calc.roundUpToStep(19.08, 50), 19.5);
    near(calc.roundUpToStep(19.1, 10), 19.1, TOL, 'exact multiples stay put');
    near(calc.roundUpToStep(19.08, 0), 19.08);
  });

  test('rounded suggested price still meets target', () => {
    const s = calc.suggestedPrice(4.77, 0.7, 0.2, 50);
    near(s.incVat, 19.5);
    assert.ok(calc.grossProfit(s.exVat, 4.77).pct >= 0.7);
  });

  test('display formatting', () => {
    assert.equal(calc.formatGBP(19.08), '£19.08');
    assert.equal(calc.formatGBP(null), 'n/a');
    assert.equal(calc.formatPct(0.682), '68.2%');
    assert.equal(calc.formatPct(undefined), 'n/a');
    assert.equal(calc.poundsToPence(18.2), 1820);
  });
});

describe('properties', () => {
  // Small deterministic pseudo-random generator so failures are reproducible.
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const randomIngredient = () => ({
    name: 'R', pack_size: 1 + rand() * 5000, pack_unit: 'g',
    pack_price_ex_vat: rand() * 50, waste_pct: rand() * 0.2,
  });
  const ITER = 500;

  test('raising an ingredient price never raises GP%', () => {
    for (let i = 0; i < ITER; i++) {
      const ings = [randomIngredient(), randomIngredient()];
      const lines = ings.map((ing) => ({ quantity: 1 + rand() * 500, unit: 'g', ingredient: ing }));
      const dish = { type: 'food', menu_price_inc_pence: 100 + Math.floor(rand() * 5000), yield_portions: 1 + Math.floor(rand() * 4) };
      const before = calc.costDish(dish, lines, SETTINGS).gpPct;
      const k = Math.floor(rand() * lines.length);
      lines[k] = { ...lines[k], ingredient: { ...lines[k].ingredient, pack_price_ex_vat: lines[k].ingredient.pack_price_ex_vat + rand() * 10 } };
      const after = calc.costDish(dish, lines, SETTINGS).gpPct;
      assert.ok(after <= before + 1e-12, `GP rose from ${before} to ${after}`);
    }
  });

  test('raising the menu price never lowers GP%', () => {
    for (let i = 0; i < ITER; i++) {
      const lines = [{ quantity: 1 + rand() * 500, unit: 'g', ingredient: randomIngredient() }];
      const pence = 1 + Math.floor(rand() * 5000);
      const dish = { type: 'food', menu_price_inc_pence: pence, yield_portions: 1 };
      const before = calc.costDish(dish, lines, SETTINGS).gpPct;
      const after = calc.costDish({ ...dish, menu_price_inc_pence: pence + 1 + Math.floor(rand() * 1000) }, lines, SETTINGS).gpPct;
      assert.ok(after >= before - 1e-12, `GP fell from ${before} to ${after}`);
    }
  });

  test('suggested price always yields GP >= target, with and without rounding', () => {
    for (let i = 0; i < ITER; i++) {
      const cost = rand() * 40;
      const target = rand() * 0.95;
      const vat = rand() < 0.5 ? 0.2 : 0;
      for (const step of calc.ROUNDING_STEPS) {
        const s = calc.suggestedPrice(cost, target, vat, step);
        const gp = calc.grossProfit(s.exVat, cost).pct;
        if (cost === 0) continue;
        assert.ok(gp >= target - 1e-9, `cost ${cost} target ${target} step ${step}: GP ${gp}`);
      }
    }
  });
});
