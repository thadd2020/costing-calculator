// Audit of the calculation engine, display formatting and input parsing.
// Covers what test/calc.test.js does not. Tests marked "BUG:" fail against the current code on
// purpose: they document a defect found in the audit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as calc from '../src/calc/calc.js';
import { moneyInput, percentInput, formatQty, unitCostLabel } from '../src/format.js';
import { parseNumber, parseMoney, parsePercentField, parseFlexiblePercent, parseUnit } from '../src/input.js';

const TOL = 1e-6;
function near(actual, expected, tol = TOL, msg = '') {
  assert.ok(typeof actual === 'number' && Number.isFinite(actual), `${msg} expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);
}
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
const CHANNELS = [
  { id: 1, name: 'Deliveroo', commission: 0.3 },
  { id: 2, name: 'Uber Eats', commission: 0.3 },
  { id: 3, name: 'Just Eat', commission: 0.14 },
  { id: 4, name: 'Own website', commission: 0.02 },
  { id: 5, name: 'Free', commission: 0 },
];
const eachIng = (price, waste = 0, name = 'X') => ({
  name, pack_size: 1, pack_unit: 'each', pack_price_ex_vat: price, waste_pct: waste,
});
const oneLine = (price, waste = 0) => [{ quantity: 1, unit: 'each', ingredient: eachIng(price, waste) }];
const food = (pence, extra = {}) => ({ type: 'food', menu_price_inc_pence: pence, yield_portions: 1, ...extra });

describe('GP % and cash margin', () => {
  test('GP £ and GP % from ex-VAT figures', () => {
    const gp = calc.grossProfit(15, 4.77);
    near(gp.money, 10.23);
    near(gp.pct, 0.682);
  });

  test('GP is never worked out on the inc-VAT price', () => {
    const r = calc.costDish(food(1800), oneLine(4.5, 0.06), SETTINGS);
    // On £18 inc-VAT the wrong answer would be 73.5%.
    assert.ok(Math.abs(r.gpPct - (18 - 4.77) / 18) > 0.05);
    near(r.gpPct, 0.682);
  });

  test('cost above price gives negative GP, not n/a', () => {
    const gp = calc.grossProfit(10, 12);
    near(gp.money, -2);
    near(gp.pct, -0.2);
    assert.equal(calc.gpStatus(gp.pct, 0.7, 0.6).key, 'below');
  });

  test('zero cost gives 100% GP; markup is n/a', () => {
    const gp = calc.grossProfit(10, 0);
    near(gp.pct, 1);
    assert.equal(calc.markupPct(10, 0), null);
  });

  test('negative or zero price gives n/a', () => {
    assert.deepEqual(calc.grossProfit(-5, 2), { money: null, pct: null });
    assert.deepEqual(calc.grossProfit(0, 2), { money: null, pct: null });
  });

  test('bad inputs give n/a, never NaN', () => {
    for (const bad of [null, undefined, '', '   ', NaN, Infinity, -Infinity, 'abc', '£5', {}, [], true]) {
      assertNoNaN(calc.grossProfit(bad, 1));
      assertNoNaN(calc.grossProfit(10, bad));
      assert.equal(calc.grossProfit(bad, 1).pct, null, `price ${String(bad)}`);
    }
  });

  test('numeric strings are accepted', () => {
    near(calc.grossProfit('15', '4.77').pct, 0.682);
    near(calc.grossProfit(' 15 ', 4.77).money, 10.23);
  });

  test('huge and tiny numbers stay finite', () => {
    near(calc.grossProfit(1e9, 3e8).pct, 0.7);
    near(calc.grossProfit(0.0001, 0.00003).pct, 0.7, 1e-9);
    assertNoNaN(calc.costDish(food(1e11), oneLine(1e9, 0.05), SETTINGS, CHANNELS));
  });
});

describe('status thresholds', () => {
  test('exact target and exact alert in plain numbers', () => {
    assert.equal(calc.gpStatus(0.7, 0.7, 0.6).key, 'on');
    assert.equal(calc.gpStatus(0.6, 0.7, 0.6).key, 'under');
    assert.equal(calc.gpStatus(0.5999, 0.7, 0.6).key, 'below');
    assert.equal(calc.gpStatus(null, 0.7, 0.6).key, 'na');
    assert.equal(calc.gpStatus(0.65, null, 0.6).key, 'na');
    assert.equal(calc.gpStatus(0.1, 0.7, null).key, 'under', 'no alert set: never "below"');
  });

  test('every status has a text label and an icon, not just a colour', () => {
    for (const s of Object.values(calc.STATUS)) {
      assert.ok(s.label.length > 0);
      assert.ok(s.icon.length > 0);
    }
  });

  // £4.95 + 5% waste = £5.1975 cost. £20.79 inc = £17.325 ex. GP = 12.1275 / 17.325 = exactly 70%.
  test('BUG: a dish at exactly 70% GP shows "On target" (float noise)', () => {
    const r = calc.costDish(food(2079), oneLine(4.95, 0.05), SETTINGS);
    assert.equal(calc.formatPct(r.gpPct), '70.0%');
    assert.equal(r.status.key, 'on', `GP computed as ${r.gpPct}`);
  });

  test('BUG: pressing "Use suggested price" gives "On target"', () => {
    const lines = oneLine(4.95, 0.05);
    const before = calc.costDish(food(null), lines, SETTINGS);
    // What public/js/dish-editor.js puts in the price box.
    const typed = calc.roundUpToStep(before.suggested.incVat, 1).toFixed(2);
    assert.equal(typed, '20.79');
    const after = calc.costDish(food(calc.poundsToPence(Number(typed))), lines, SETTINGS);
    assert.equal(after.status.key, 'on', `GP computed as ${after.gpPct}`);
  });

  // £2.61 inc = £2.175 ex; cost £0.87 -> GP = 1.305 / 2.175 = exactly 60%.
  test('BUG: a dish at exactly the 60% alert line is "Under target", not "Below alert"', () => {
    const r = calc.costDish(food(261), oneLine(0.87, 0), SETTINGS);
    assert.equal(r.status.key, 'under', `GP computed as ${r.gpPct}`);
  });
});

describe('VAT in and out', () => {
  test('20% and 0% sales VAT', () => {
    near(calc.priceExVat(18, 0.2), 15);
    near(calc.priceExVat(18, 0), 18);
    near(calc.priceExVat(18, null), 18, TOL, 'missing rate treated as 0');
  });

  test('per-dish VAT override beats the setting, including an override of 0', () => {
    const zero = calc.costDish(food(1800, { vat_rate: 0 }), oneLine(4.5, 0.06), SETTINGS);
    near(zero.priceEx, 18);
    near(zero.gpPct, (18 - 4.77) / 18);
    near(zero.suggested.exVat, 15.9);
    near(zero.suggested.incVat, 15.9, TOL, '0% VAT: inc = ex');
    const blank = calc.costDish(food(1800, { vat_rate: null }), oneLine(4.5, 0.06), SETTINGS);
    near(blank.priceEx, 15);
    const str = calc.costDish(food(1800, { vat_rate: '' }), oneLine(4.5, 0.06), SETTINGS);
    near(str.priceEx, 15, TOL, 'blank string falls back to the setting');
    const settingsAsText = calc.costDish(food(1800), oneLine(4.5, 0.06), { ...SETTINGS, vat_rate: '0.2' });
    near(settingsAsText.priceEx, 15, TOL, 'settings read from the DB as text');
  });

  test('ingredient inc-VAT price converted with its own rate', () => {
    near(calc.exVatFromInc(14.4, 0.2), 12);
    near(calc.exVatFromInc(12, 0), 12, TOL, 'zero-rated food is not divided by 1.2');
    near(calc.exVatFromInc(12, undefined), 12);
    assert.equal(calc.exVatFromInc(12, -1), null);
    assert.equal(calc.exVatFromInc('', 0.2), null);
  });

  test('delivery inc-VAT uses the dish VAT override', () => {
    const r = calc.costDish(food(1800, { vat_rate: 0 }), oneLine(4.5, 0.06), SETTINGS, CHANNELS);
    near(r.delivery[0].exVat, (18 + 0.5) / 0.7);
    near(r.delivery[0].incVat, r.delivery[0].exVat);
  });
});

describe('target and suggested pricing', () => {
  test('suggested price for food and drink targets', () => {
    const s = calc.suggestedPrice(6.12, 0.7, 0.2);
    near(s.exVat, 20.4);
    near(s.incVat, 24.48);
    const drinkTarget = calc.costDish({ type: 'drink', menu_price_inc_pence: 2880, yield_portions: 1 },
      oneLine(6, 0.02), { ...SETTINGS, target_gp_drink: 0.75 });
    near(drinkTarget.suggested.exVat, 6.12 / 0.25);
  });

  test('per-dish target override, including 0%', () => {
    const r = calc.costDish(food(1800, { target_gp: 0.8 }), oneLine(4.5, 0.06), SETTINGS);
    near(r.suggested.exVat, 4.77 / 0.2);
    assert.equal(r.status.key, 'under');
    const zero = calc.costDish(food(1800, { target_gp: 0 }), oneLine(4.5, 0.06), SETTINGS);
    near(zero.suggested.exVat, 4.77, TOL, '0% target: sell at cost');
    assert.equal(zero.status.key, 'on');
  });

  test('target close to 1 is huge but finite; 1 and above is n/a', () => {
    const s = calc.suggestedPrice(4.77, 0.999999, 0.2);
    assertNoNaN(s);
    near(s.exVat, 4.77e6, 1e-3);
    assert.deepEqual(calc.suggestedPrice(4.77, 1, 0.2), { exVat: null, incVat: null });
    assert.deepEqual(calc.suggestedPrice(4.77, 1.5, 0.2), { exVat: null, incVat: null });
    const r = calc.costDish(food(1800, { target_gp: 1 }), oneLine(4.5, 0.06), SETTINGS, CHANNELS);
    assertNoNaN(r);
    assert.equal(r.delivery[0].holdTargetExVat, null);
  });

  test('missing cost or target gives n/a', () => {
    assert.deepEqual(calc.suggestedPrice(null, 0.7, 0.2), { exVat: null, incVat: null });
    assert.deepEqual(calc.suggestedPrice(4.77, null, 0.2), { exVat: null, incVat: null });
    assert.deepEqual(calc.suggestedPrice(-1, 0.7, 0.2), { exVat: null, incVat: null });
    assert.deepEqual(calc.suggestedPrice(NaN, 0.7, 0.2), { exVat: null, incVat: null });
  });

  test('BUG: zero cost suggests £0.00 (not -£0.00) at every rounding step', () => {
    for (const step of calc.ROUNDING_STEPS) {
      const s = calc.suggestedPrice(0, 0.7, 0.2, step);
      assert.equal(s.incVat, 0, `step ${step}`);
      assert.equal(s.exVat, 0, `step ${step}`);
      assert.equal(calc.formatGBP(s.incVat), '£0.00', `step ${step}`);
    }
  });

  // Dish A suggests 19.08 inc-VAT.
  const roundingCases = [
    [0, 19.08], [5, 19.1], [10, 19.1], [50, 19.5],
  ];
  for (const [step, expected] of roundingCases) {
    test(`Dish A suggested inc-VAT with ${step}p rounding is ${expected}`, () => {
      const r = calc.costDish(food(1800), oneLine(4.5, 0.06), { ...SETTINGS, round_up_to_pence: step });
      near(r.suggested.incVat, expected);
      near(r.suggested.exVat, expected / 1.2);
      assert.ok(calc.grossProfit(r.suggested.exVat, r.trueCost).pct >= 0.7 - 1e-12);
    });
  }

  test('rounding step stored as text in settings still works', () => {
    const r = calc.costDish(food(1800), oneLine(4.5, 0.06), { ...SETTINGS, round_up_to_pence: '50' });
    near(r.suggested.incVat, 19.5);
  });

  test('exact boundaries stay put at every step', () => {
    for (const [amount, step] of [[19.05, 5], [19.1, 5], [19.1, 10], [19.5, 50], [20, 50], [0.05, 5], [0.1, 10], [0.5, 50]]) {
      near(calc.roundUpToStep(amount, step), amount, 1e-9, `${amount} @ ${step}p`);
    }
    // Wine suggests exactly 24.48: 5p -> 24.50, 10p -> 24.50, 50p -> 24.50.
    for (const step of [5, 10, 50]) near(calc.suggestedPrice(6.12, 0.7, 0.2, step).incVat, 24.5);
  });

  test('one penny over a boundary goes up a full step', () => {
    near(calc.roundUpToStep(19.11, 5), 19.15);
    near(calc.roundUpToStep(19.11, 10), 19.2);
    near(calc.roundUpToStep(19.51, 50), 20);
    near(calc.roundUpToStep(19.001, 5), 19.05);
  });

  test('exact 2 dp amounts are never bumped up by float noise', () => {
    for (let p = 1; p <= 200000; p++) {
      for (const step of [1, 5, 10, 50]) {
        if (p % step) continue;
        const a = p / 100;
        assert.ok(Math.abs(calc.roundUpToStep(a, step) - a) < 1e-9, `${a} @ ${step}p`);
      }
    }
  });

  test('rounding never goes down', () => {
    for (let p = 1; p <= 20000; p++) {
      const a = p / 100 + 0.003;
      for (const step of [5, 10, 50]) assert.ok(calc.roundUpToStep(a, step) >= a, `${a} @ ${step}p`);
    }
  });

  test('rounding: bad input', () => {
    assert.equal(calc.roundUpToStep(null, 5), null);
    assert.equal(calc.roundUpToStep('abc', 5), null);
    near(calc.roundUpToStep(19.08, null), 19.08);
    near(calc.roundUpToStep(19.08, -5), 19.08);
    near(calc.roundUpToStep(1e9 + 0.01, 50), 1e9 + 0.5, 1e-6);
  });
});

describe('delivery commission', () => {
  // Dish A: price ex 15, cost 4.77, packaging 0.50, target 70%, VAT 20%.
  const expected = (comm) => {
    const ex = 15.5 / (1 - comm);
    const hold = (5.27 / 0.3) / (1 - comm);
    return { ex, inc: ex * 1.2, kept: 15.5, gp: 10.23, gpPct: 10.23 / 15.5, hold, holdInc: hold * 1.2 };
  };

  test('30%, 30%, 14%, 2% and 0% commission', () => {
    const r = calc.costDish(food(1800), oneLine(4.5, 0.06), SETTINGS, CHANNELS);
    assertNoNaN(r);
    for (const d of r.delivery) {
      const e = expected(d.commission);
      near(d.exVat, e.ex, TOL, `${d.channelName} ex`);
      near(d.incVat, e.inc, TOL, `${d.channelName} inc`);
      near(d.revenueKept, e.kept, TOL, `${d.channelName} kept`);
      near(d.gpMoney, e.gp, TOL, `${d.channelName} GP £`);
      near(d.gpPct, e.gpPct, TOL, `${d.channelName} GP %`);
      near(d.holdTargetExVat, e.hold, TOL, `${d.channelName} hold ex`);
      near(d.holdTargetIncVat, e.holdInc, TOL, `${d.channelName} hold inc`);
    }
    near(r.delivery[2].exVat, 18.023256, 1e-6, 'Just Eat 14%');
    near(r.delivery[3].exVat, 15.816327, 1e-6, 'Own website 2%');
  });

  test('selling at the hold-target price gives the target delivery GP', () => {
    for (const comm of [0, 0.02, 0.14, 0.3]) {
      const d = calc.deliveryPricing({ priceEx: 1, cost: 4.77, packaging: 0.5, commission: comm, vatRate: 0.2, targetGp: 0.7 });
      const kept = d.holdTargetExVat * (1 - comm);
      near((kept - 0.5 - 4.77) / kept, 0.7);
    }
  });

  test('packaging override (0 and custom) and default', () => {
    const none = calc.costDish(food(1800, { packaging: 0 }), oneLine(4.5, 0.06), SETTINGS, CHANNELS);
    near(none.delivery[0].exVat, 15 / 0.7);
    near(none.delivery[0].gpPct, 10.23 / 15);
    const custom = calc.costDish(food(1800, { packaging: 1.25 }), oneLine(4.5, 0.06), SETTINGS, CHANNELS);
    near(custom.delivery[0].exVat, 16.25 / 0.7);
    const noDefault = calc.costDish(food(1800), oneLine(4.5, 0.06), { ...SETTINGS, default_packaging: null }, CHANNELS);
    near(noDefault.delivery[0].exVat, 15 / 0.7);
  });

  test('commission close to 1 is finite; 1, negative and missing are n/a', () => {
    const d = calc.deliveryPricing({ priceEx: 15, cost: 4.77, packaging: 0.5, commission: 0.999999, vatRate: 0.2, targetGp: 0.7 });
    assertNoNaN(d);
    near(d.revenueKept, 15.5, 1e-6);
    for (const comm of [1, 1.5, -0.1, null, undefined, '', 'abc', NaN]) {
      const out = calc.deliveryPricing({ priceEx: 15, cost: 4.77, packaging: 0.5, commission: comm, vatRate: 0.2, targetGp: 0.7 });
      assertNoNaN(out);
      assert.equal(out.exVat, null, `commission ${String(comm)}`);
      assert.equal(out.holdTargetExVat, null, `commission ${String(comm)}`);
    }
  });

  test('no menu price: delivery price n/a, hold-target still shown', () => {
    const d = calc.deliveryPricing({ priceEx: null, cost: 4.77, packaging: 0.5, commission: 0.3, vatRate: 0.2, targetGp: 0.7 });
    assert.equal(d.exVat, null);
    assert.equal(d.gpPct, null);
    near(d.holdTargetExVat, 25.095238, 1e-6);
  });

  test('no cost: delivery price shown, GP n/a', () => {
    const d = calc.deliveryPricing({ priceEx: 15, cost: null, packaging: 0.5, commission: 0.3, vatRate: 0.2, targetGp: 0.7 });
    near(d.exVat, 22.142857, 1e-6);
    assert.equal(d.gpMoney, null);
    assert.equal(d.holdTargetExVat, null);
  });
});

describe('markup', () => {
  test('markup is not GP %', () => {
    near(calc.markupPct(15, 4.77), (15 - 4.77) / 4.77);
    near(calc.markupPct(100, 30), 7 / 3);
    const r = calc.costDish(food(1800), oneLine(4.5, 0.06), SETTINGS);
    near(r.markupPct, 10.23 / 4.77);
    assert.notEqual(r.markupPct, r.gpPct);
  });

  test('markup edge cases', () => {
    near(calc.markupPct(30, 30), 0);
    near(calc.markupPct(20, 30), -1 / 3);
    assert.equal(calc.markupPct(10, -1), null);
    assert.equal(calc.markupPct(null, 3), null);
    assert.equal(calc.markupPct(10, null), null);
    near(calc.markupPct(1e9, 1e-6), (1e9 - 1e-6) / 1e-6, 1);
  });
});

describe('units and line costs', () => {
  const flourKg = { name: 'Flour', pack_size: 5, pack_unit: 'kg', pack_price_ex_vat: 12, waste_pct: 0 };
  const milkL = { name: 'Milk', pack_size: 2, pack_unit: 'l', pack_price_ex_vat: 1.5, waste_pct: 0 };
  const milkMl = { ...milkL, pack_size: 2000, pack_unit: 'ml' };
  const eggs = { name: 'Eggs', pack_size: 30, pack_unit: 'each', pack_price_ex_vat: 6, waste_pct: 0 };

  test('kg <-> g and l <-> ml give the same cost', () => {
    near(calc.lineCost({ quantity: 250, unit: 'g' }, flourKg).cost, 0.6);
    near(calc.lineCost({ quantity: 0.25, unit: 'kg' }, flourKg).cost, 0.6);
    near(calc.lineCost({ quantity: 300, unit: 'ml' }, milkL).cost, 0.225);
    near(calc.lineCost({ quantity: 0.3, unit: 'l' }, milkL).cost, 0.225);
    near(calc.lineCost({ quantity: 0.3, unit: 'l' }, milkMl).cost, 0.225);
    near(calc.unitCost(1.5, 2, 'l'), 0.00075);
  });

  test('each', () => {
    near(calc.lineCost({ quantity: 2, unit: 'each' }, eggs).cost, 0.4);
    near(calc.lineCost({ quantity: 0.5, unit: 'each' }, eggs).cost, 0.1, TOL, 'half an egg');
  });

  test('family mismatches are rejected with the brief\'s wording', () => {
    assert.equal(calc.lineCost({ quantity: 100, unit: 'ml' }, flourKg).error, 'Flour is bought by weight; use g or kg');
    assert.equal(calc.lineCost({ quantity: 100, unit: 'g' }, milkL).error, 'Milk is bought by volume; use ml or l');
    assert.equal(calc.lineCost({ quantity: 1, unit: 'kg' }, eggs).error, 'Eggs is bought by the item; use each');
    assert.equal(calc.lineCost({ quantity: 1, unit: 'each' }, flourKg).cost, null);
  });

  test('unknown or wrong-case units are rejected (parsing normalises case first)', () => {
    assert.equal(calc.toBase(1, 'KG'), null);
    assert.equal(calc.lineCost({ quantity: 1, unit: 'bottle' }, eggs).cost, null);
    assert.equal(calc.isUnit('toString'), false, 'prototype keys are not units');
    assert.equal(parseUnit('KG'), 'kg');
    assert.equal(parseUnit(' Litres '), 'l');
    assert.equal(parseUnit('bottle'), null);
  });

  test('bad quantities and packs give an error and n/a cost', () => {
    for (const q of [0, -1, null, undefined, '', 'abc', NaN, Infinity]) {
      const r = calc.lineCost({ quantity: q, unit: 'g' }, flourKg);
      assert.equal(r.cost, null, `quantity ${String(q)}`);
      assert.ok(r.error);
    }
    assert.equal(calc.lineCost({ quantity: 1, unit: 'g' }, { ...flourKg, pack_size: 0 }).cost, null);
    assert.equal(calc.lineCost({ quantity: 1, unit: 'g' }, { ...flourKg, pack_price_ex_vat: -1 }).cost, null);
    assert.equal(calc.lineCost({ quantity: 1, unit: 'g' }, null).error, 'Ingredient not found');
  });

  test('free ingredient (£0 pack) costs 0, not n/a', () => {
    assert.equal(calc.lineCost({ quantity: 10, unit: 'g' }, { ...flourKg, pack_price_ex_vat: 0 }).cost, 0);
  });

  test('tiny and huge quantities', () => {
    near(calc.lineCost({ quantity: 0.001, unit: 'g' }, flourKg).cost, 0.0000024, 1e-12);
    near(calc.lineCost({ quantity: 1e9, unit: 'g' }, flourKg).cost, 2.4e6, 1e-3);
  });
});

describe('waste', () => {
  const ing = (w) => ({ name: 'Veg', pack_size: 1, pack_unit: 'kg', pack_price_ex_vat: 10, waste_pct: w });
  test('0%, 5% and 0.999', () => {
    near(calc.lineCost({ quantity: 100, unit: 'g' }, ing(0)).cost, 1);
    near(calc.lineCost({ quantity: 100, unit: 'g' }, ing(0.05)).cost, 1.05);
    near(calc.lineCost({ quantity: 100, unit: 'g' }, ing(0.999)).cost, 1.999);
  });
  test('missing waste is 0; out-of-range waste is an error', () => {
    near(calc.lineCost({ quantity: 100, unit: 'g' }, ing(null)).cost, 1);
    near(calc.lineCost({ quantity: 100, unit: 'g' }, ing(undefined)).cost, 1);
    for (const w of [1, 1.5, -0.01]) {
      const r = calc.lineCost({ quantity: 100, unit: 'g' }, ing(w));
      assert.equal(r.cost, null, `waste ${w}`);
      assert.equal(r.error, 'Veg has an invalid waste %');
    }
  });
});

describe('yield', () => {
  const lines = oneLine(4.5, 0.06);
  test('1, 4 and fractional portions', () => {
    near(calc.costDish(food(1800, { yield_portions: 1 }), lines, SETTINGS).trueCost, 4.77);
    near(calc.costDish(food(1800, { yield_portions: 4 }), lines, SETTINGS).trueCost, 4.77 / 4);
    near(calc.costDish(food(1800, { yield_portions: 2.5 }), lines, SETTINGS).trueCost, 4.77 / 2.5);
    near(calc.costDish(food(1800, { yield_portions: 0.5 }), lines, SETTINGS).trueCost, 9.54);
    near(calc.costDish(food(1800, { yield_portions: '4' }), lines, SETTINGS).trueCost, 4.77 / 4);
  });
  test('yield missing defaults to 1; zero, negative or text is n/a with no NaN', () => {
    near(calc.costDish(food(1800, { yield_portions: undefined }), lines, SETTINGS).trueCost, 4.77);
    for (const y of [0, -1, 'abc', NaN]) {
      const r = calc.costDish(food(1800, { yield_portions: y }), lines, SETTINGS, CHANNELS);
      assertNoNaN(r);
      assert.equal(r.trueCost, null, `yield ${String(y)}`);
      assert.equal(r.status.key, 'na');
    }
  });
  test('multi-line dish sums every line before dividing', () => {
    const multi = [
      { quantity: 200, unit: 'g', ingredient: { name: 'Flour', pack_size: 5000, pack_unit: 'g', pack_price_ex_vat: 12, waste_pct: 0.06 } },
      { quantity: 2, unit: 'each', ingredient: { name: 'Eggs', pack_size: 30, pack_unit: 'each', pack_price_ex_vat: 6, waste_pct: 0 } },
    ];
    near(calc.costDish(food(1800, { yield_portions: 4 }), multi, SETTINGS).trueCost, (0.5088 + 0.4) / 4);
  });
  test('one bad line makes the whole cost n/a rather than understated', () => {
    const lines2 = [...lines, { quantity: 1, unit: 'g', ingredient: eachIng(1) }];
    const r = calc.costDish(food(1800), lines2, SETTINGS, CHANNELS);
    assertNoNaN(r);
    assert.equal(r.trueCost, null);
    assert.equal(r.errors.length, 1);
  });
});

describe('whole dish: no NaN/Infinity for any messy input', () => {
  const junk = [null, undefined, '', ' ', 'abc', NaN, Infinity, -Infinity, -1, 0, 1e9, 1e-9];
  test('menu price, VAT, target, packaging and settings', () => {
    for (const v of junk) {
      const variants = [
        calc.costDish(food(v), oneLine(4.5, 0.06), SETTINGS, CHANNELS),
        calc.costDish(food(1800, { vat_rate: v }), oneLine(4.5, 0.06), SETTINGS, CHANNELS),
        calc.costDish(food(1800, { target_gp: v }), oneLine(4.5, 0.06), SETTINGS, CHANNELS),
        calc.costDish(food(1800, { packaging: v }), oneLine(4.5, 0.06), SETTINGS, CHANNELS),
        calc.costDish(food(1800), oneLine(v, 0.06), SETTINGS, CHANNELS),
        calc.costDish(food(1800), oneLine(4.5, 0.06), { ...SETTINGS, vat_rate: v, alert_gp: v, round_up_to_pence: v }, CHANNELS),
        calc.costDish(food(1800), oneLine(4.5, 0.06), SETTINGS, [{ id: 1, name: 'J', commission: v }]),
      ];
      variants.forEach((r, i) => assertNoNaN(r, `variant ${i} with ${String(v)}`));
    }
  });
  test('empty settings object', () => {
    const r = calc.costDish(food(1800), oneLine(4.5, 0.06), {}, CHANNELS);
    assertNoNaN(r);
    near(r.priceEx, 18, TOL, 'no VAT setting -> 0');
    assert.equal(r.status.key, 'na', 'no target -> n/a');
  });
});

describe('display formatting (calc.js and format.js)', () => {
  test('money to 2 dp with £ and thousands separators', () => {
    assert.equal(calc.formatGBP(0), '£0.00');
    assert.equal(calc.formatGBP(4.77), '£4.77');
    assert.equal(calc.formatGBP(22.142857), '£22.14');
    assert.equal(calc.formatGBP(26.571429), '£26.57');
    assert.equal(calc.formatGBP(1234.5), '£1,234.50');
    assert.equal(calc.formatGBP(1e9), '£1,000,000,000.00');
    assert.equal(calc.formatGBP(-5), '-£5.00');
    assert.equal(calc.formatGBP('4.5'), '£4.50');
    for (const bad of [null, undefined, '', NaN, Infinity, 'abc']) assert.equal(calc.formatGBP(bad), 'n/a');
  });

  test('percent to 1 dp', () => {
    assert.equal(calc.formatPct(0.682), '68.2%');
    assert.equal(calc.formatPct(0.66), '66.0%');
    assert.equal(calc.formatPct(0.745), '74.5%');
    assert.equal(calc.formatPct(1), '100.0%');
    assert.equal(calc.formatPct(-0.25), '-25.0%');
    assert.equal(calc.formatPct(7 / 3), '233.3%');
    assert.equal(calc.formatPct(NaN), 'n/a');
  });

  test('BUG: tiny negatives do not display as "-£0.00" or "-0.0%"', () => {
    assert.equal(calc.formatGBP(-0.001), '£0.00');
    assert.equal(calc.formatPct(-0.00001), '0.0%');
  });

  test('pounds to pence for 2 dp prices', () => {
    for (let p = 0; p <= 100000; p++) assert.equal(calc.poundsToPence(p / 100), p);
    assert.equal(calc.poundsToPence(null), null);
    assert.equal(calc.poundsToPence('abc'), null);
  });

  test('BUG: a 3 dp price rounds half-up to the penny, the same way it is displayed', () => {
    // parseMoney accepts "1.005", formatGBP shows £1.01, but 100p is stored.
    assert.equal(calc.formatGBP(1.005), '£1.01');
    assert.equal(calc.poundsToPence(1.005), 101);
    assert.equal(calc.poundsToPence(0.285), 29);
  });

  test('form values', () => {
    assert.equal(moneyInput(18), '18.00');
    assert.equal(moneyInput(19.08), '19.08');
    assert.equal(moneyInput(null), '');
    assert.equal(percentInput(0.7), '70');
    assert.equal(percentInput(0.065), '6.5');
    assert.equal(percentInput(0.07), '7', 'no 7.000000000000001');
    assert.equal(percentInput(null), '');
    assert.equal(formatQty(1500), '1,500');
    assert.equal(formatQty(0.25), '0.25');
  });

  test('unit cost label', () => {
    assert.equal(unitCostLabel({ pack_size: 5, pack_unit: 'kg', pack_price_ex_vat: 12 }), '£2.40 per kg');
    assert.equal(unitCostLabel({ pack_size: 5000, pack_unit: 'g', pack_price_ex_vat: 12 }), '£2.40 per kg');
    assert.equal(unitCostLabel({ pack_size: 750, pack_unit: 'ml', pack_price_ex_vat: 6 }), '£8.00 per litre');
    assert.equal(unitCostLabel({ pack_size: 30, pack_unit: 'each', pack_price_ex_vat: 6 }), '£0.20 each');
    assert.equal(unitCostLabel({ pack_size: 0, pack_unit: 'each', pack_price_ex_vat: 6 }), '');
  });
});

describe('input parsing (money / percent fields)', () => {
  test('money', () => {
    assert.equal(parseMoney('£1,234.50'), 1234.5);
    assert.equal(parseMoney(' 18 '), 18);
    assert.equal(parseMoney('-£5'), -5);
    assert.equal(parseMoney('.5'), 0.5);
    assert.equal(parseMoney(''), null);
    assert.equal(parseMoney('abc'), null);
    assert.equal(parseMoney('1e3'), null);
    assert.equal(parseMoney('£'), null);
    assert.equal(parseMoney(null), null);
  });

  test('percent form field is always a percentage', () => {
    near(parsePercentField('70'), 0.7);
    near(parsePercentField('70%'), 0.7);
    near(parsePercentField('6.5'), 0.065);
    assert.equal(parsePercentField(''), null);
    assert.equal(parsePercentField('abc'), null);
  });

  test('flexible CSV percent', () => {
    near(parseFlexiblePercent('6%'), 0.06);
    near(parseFlexiblePercent('6'), 0.06);
    near(parseFlexiblePercent('0.06'), 0.06);
    near(parseFlexiblePercent('0'), 0);
    assert.equal(parseFlexiblePercent(''), null);
  });

  test('BUG: a comma that is not a thousands separator is rejected, not silently dropped', () => {
    assert.equal(parseNumber('5,000'), 5000);
    assert.equal(parseNumber('1,234,567.5'), 1234567.5);
    // "1,5" (a European decimal) currently becomes 15: ten times the quantity.
    assert.equal(parseNumber('1,5'), null);
    assert.equal(parseMoney('£12,5'), null);
  });
});
