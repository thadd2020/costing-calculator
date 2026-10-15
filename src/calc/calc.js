// GP calculation engine. Pure functions only: no DOM, no database, no Node APIs.
// This exact file is imported by the server and served to the browser as /static/calc.js,
// so both sides always use the same formulas (CLAUDE.md section 6).
//
// Conventions:
// - Money is in pounds as floating point, at full precision. Round only for display.
// - Rates are fractions (0.20 = 20%).
// - Any result that can't be calculated is null ("n/a"), never NaN or Infinity.

// ---------- Numbers ----------

// Turns form/DB input into a finite number, or null. Empty strings are null, not 0.
export function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    value = Number(trimmed);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const finiteOrNull = (x) => (Number.isFinite(x) ? x : null);

// ---------- Units ----------

export const UNITS = ['g', 'kg', 'ml', 'l', 'each'];

const UNIT_INFO = {
  g: { family: 'mass', factor: 1 },
  kg: { family: 'mass', factor: 1000 },
  ml: { family: 'volume', factor: 1 },
  l: { family: 'volume', factor: 1000 },
  each: { family: 'each', factor: 1 },
};

const FAMILY_UNITS = { mass: ['g', 'kg'], volume: ['ml', 'l'], each: ['each'] };
const FAMILY_WORDS = { mass: 'by weight', volume: 'by volume', each: 'by the item' };

export function isUnit(unit) {
  return Object.hasOwn(UNIT_INFO, unit);
}

export function unitFamily(unit) {
  return isUnit(unit) ? UNIT_INFO[unit].family : null;
}

export function unitsForFamily(family) {
  return FAMILY_UNITS[family] ? [...FAMILY_UNITS[family]] : [];
}

export function unitsCompatible(a, b) {
  return isUnit(a) && isUnit(b) && unitFamily(a) === unitFamily(b);
}

// Converts a quantity to base units (g, ml or each). Returns null for unknown units.
export function toBase(quantity, unit) {
  const q = num(quantity);
  if (q === null || !isUnit(unit)) return null;
  return q * UNIT_INFO[unit].factor;
}

// "Flour is bought by weight; use g or kg"
export function unitMismatchMessage(ingredientName, packUnit) {
  const family = unitFamily(packUnit);
  if (!family) return `${ingredientName} has an unrecognised pack unit`;
  const allowed = FAMILY_UNITS[family];
  const list = allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
  return `${ingredientName} is bought ${FAMILY_WORDS[family]}; use ${list}`;
}

// ---------- VAT ----------

// Price entered inc-VAT, converted using that item's own VAT rate (0 for zero-rated food).
export function exVatFromInc(priceIncVat, vatRate) {
  const p = num(priceIncVat);
  const v = num(vatRate) ?? 0;
  if (p === null || v <= -1) return null;
  return p / (1 + v);
}

// Formula 4
export function priceExVat(menuPriceInc, vatRate) {
  return exVatFromInc(menuPriceInc, vatRate);
}

// ---------- Ingredient costs ----------

// Formula 1: cost per base unit (per g, per ml or per each).
export function unitCost(packPriceExVat, packSize, packUnit) {
  const price = num(packPriceExVat);
  const sizeBase = toBase(packSize, packUnit);
  if (price === null || price < 0 || sizeBase === null || sizeBase <= 0) return null;
  return price / sizeBase;
}

// Formula 2. `line` is { quantity, unit } and `ingredient` is
// { name, pack_size, pack_unit, pack_price_ex_vat, waste_pct }.
// Returns { cost, error }: cost is null whenever error is set.
export function lineCost(line, ingredient) {
  const name = ingredient?.name || 'This ingredient';
  if (!ingredient) return { cost: null, error: 'Ingredient not found' };
  const qty = num(line.quantity);
  if (qty === null || qty <= 0) return { cost: null, error: `Enter a quantity above 0 for ${name}` };
  if (!isUnit(line.unit)) return { cost: null, error: `Choose a unit for ${name}` };
  if (!unitsCompatible(line.unit, ingredient.pack_unit)) {
    return { cost: null, error: unitMismatchMessage(name, ingredient.pack_unit) };
  }
  const perUnit = unitCost(ingredient.pack_price_ex_vat, ingredient.pack_size, ingredient.pack_unit);
  if (perUnit === null) return { cost: null, error: `${name} has an invalid pack size or price` };
  const waste = num(ingredient.waste_pct) ?? 0;
  if (waste < 0 || waste >= 1) return { cost: null, error: `${name} has an invalid waste %` };
  return { cost: toBase(qty, line.unit) * perUnit * (1 + waste), error: null };
}

// Formula 3. `lineCosts` is an array of numbers. Any missing line cost makes the total n/a,
// because a silently understated cost would overstate GP.
export function trueCost(lineCosts, yieldPortions = 1) {
  const portions = num(yieldPortions);
  if (portions === null || portions <= 0) return null;
  let total = 0;
  for (const c of lineCosts) {
    const n = num(c);
    if (n === null) return null;
    total += n;
  }
  return total / portions;
}

// ---------- GP ----------

// Formula 5. Returns { money, pct }; both null when the price is 0 or missing.
export function grossProfit(priceEx, cost) {
  const p = num(priceEx);
  const c = num(cost);
  if (p === null || p <= 0 || c === null) return { money: null, pct: null };
  const money = p - c;
  return { money, pct: money / p };
}

export const STATUS = {
  on: { key: 'on', label: 'On target', icon: '✓' },
  under: { key: 'under', label: 'Under target', icon: '!' },
  below: { key: 'below', label: 'Below alert', icon: '✕' },
  na: { key: 'na', label: 'n/a', icon: '–' },
};

// Formula 6. Returns one of the STATUS entries.
export function gpStatus(gpPct, target, alert) {
  const g = num(gpPct);
  const t = num(target);
  const a = num(alert);
  if (g === null || t === null) return STATUS.na;
  if (g >= t) return STATUS.on;
  if (a === null || g >= a) return STATUS.under;
  return STATUS.below;
}

// Formula 9 (display only; markup is NOT GP%).
export function markupPct(priceEx, cost) {
  const p = num(priceEx);
  const c = num(cost);
  if (p === null || c === null || c <= 0) return null;
  return finiteOrNull((p - c) / c);
}

// ---------- Pricing ----------

export const ROUNDING_STEPS = [0, 5, 10, 50];

// Rounds a pound amount UP to the next multiple of `stepPence` (0 = no rounding).
// The small tolerance stops float noise (e.g. 19.0800000001) bumping an exact price up a step.
export function roundUpToStep(amount, stepPence) {
  const a = num(amount);
  const step = num(stepPence) ?? 0;
  if (a === null) return null;
  if (step <= 0) return a;
  const steps = Math.ceil((a * 100) / step - 1e-9);
  return (steps * step) / 100;
}

// Formula 7. Returns { exVat, incVat } or nulls. With rounding, the inc-VAT price is rounded
// up and the ex-VAT price recalculated from it, so GP can only end at or above target.
export function suggestedPrice(cost, targetGp, vatRate, roundStepPence = 0) {
  const c = num(cost);
  const t = num(targetGp);
  const v = num(vatRate) ?? 0;
  if (c === null || c < 0 || t === null || t >= 1 || v <= -1) return { exVat: null, incVat: null };
  const exVat = c / (1 - t);
  const incVat = exVat * (1 + v);
  if (!(num(roundStepPence) > 0)) return { exVat, incVat };
  const rounded = roundUpToStep(incVat, roundStepPence);
  return { exVat: rounded / (1 + v), incVat: rounded };
}

// Formula 8, for one delivery channel. Every field may be null when it can't be worked out:
// the delivery price needs a menu price, but the price to hold target only needs the cost.
export function deliveryPricing({ priceEx, cost, packaging, commission, vatRate, targetGp }) {
  const p = num(priceEx);
  const c = num(cost);
  const pack = num(packaging) ?? 0;
  const comm = num(commission);
  const v = num(vatRate) ?? 0;
  const t = num(targetGp);
  const out = {
    exVat: null, incVat: null, revenueKept: null, gpMoney: null, gpPct: null,
    holdTargetExVat: null, holdTargetIncVat: null,
  };
  if (comm === null || comm < 0 || comm >= 1) return out;

  if (p !== null && p > 0) {
    out.exVat = (p + pack) / (1 - comm);
    out.incVat = out.exVat * (1 + v);
    out.revenueKept = out.exVat * (1 - comm);
    if (c !== null) {
      out.gpMoney = out.revenueKept - pack - c;
      out.gpPct = out.revenueKept > 0 ? out.gpMoney / out.revenueKept : null;
    }
  }
  if (c !== null && t !== null && t < 1) {
    out.holdTargetExVat = ((c + pack) / (1 - t)) / (1 - comm);
    out.holdTargetIncVat = out.holdTargetExVat * (1 + v);
  }
  return out;
}

// ---------- Whole dish ----------

// Resolves the per-dish overrides against the settings defaults.
export function dishRates(dish, settings) {
  const isDrink = dish.type === 'drink';
  return {
    vatRate: num(dish.vat_rate) ?? num(settings.vat_rate) ?? 0,
    targetGp: num(dish.target_gp) ?? num(isDrink ? settings.target_gp_drink : settings.target_gp_food),
    alertGp: num(settings.alert_gp),
    packaging: num(dish.packaging) ?? num(settings.default_packaging) ?? 0,
    roundStep: num(settings.round_up_to_pence) ?? 0,
  };
}

// Costs one dish end to end.
// dish: { type, menu_price_inc_pence, vat_rate, target_gp, yield_portions, packaging }
// lines: [{ quantity, unit, ingredient: { name, pack_size, pack_unit, pack_price_ex_vat, waste_pct } }]
// settings: the parsed settings object. channels: [{ id, name, commission }]
export function costDish(dish, lines, settings, channels = []) {
  const rates = dishRates(dish, settings);
  const lineResults = lines.map((l) => lineCost(l, l.ingredient));
  const errors = lineResults.map((r) => r.error).filter(Boolean);
  const pence = num(dish.menu_price_inc_pence);
  const menuInc = pence === null ? null : pence / 100;
  const cost = errors.length ? null : trueCost(lineResults.map((r) => r.cost), dish.yield_portions);
  const priceEx = priceExVat(menuInc, rates.vatRate);
  const gp = grossProfit(priceEx, cost);

  return {
    lines: lineResults,
    errors,
    menuInc,
    trueCost: cost,
    priceEx,
    gpMoney: gp.money,
    gpPct: gp.pct,
    markupPct: markupPct(priceEx, cost),
    status: gpStatus(gp.pct, rates.targetGp, rates.alertGp),
    rates,
    suggested: suggestedPrice(cost, rates.targetGp, rates.vatRate, rates.roundStep),
    delivery: channels.map((ch) => ({
      channelId: ch.id,
      channelName: ch.name,
      commission: num(ch.commission),
      ...deliveryPricing({
        priceEx, cost, packaging: rates.packaging, commission: ch.commission,
        vatRate: rates.vatRate, targetGp: rates.targetGp,
      }),
    })),
  };
}

// ---------- Display formatting (rounding happens only here) ----------

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const pct1 = new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatGBP(value) {
  const n = num(value);
  return n === null ? 'n/a' : gbp.format(n);
}

export function formatPct(value) {
  const n = num(value);
  return n === null ? 'n/a' : pct1.format(n);
}

// Pounds to integer pence for storing menu prices. Math.round handles 18.2 * 100 = 1819.9999.
export function poundsToPence(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 100);
}
