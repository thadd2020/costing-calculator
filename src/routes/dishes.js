import { Router } from 'express';
import {
  getDish, listDishLines, listIngredients, saveDish, deleteDish,
} from '../db/index.js';
import { costDishes, costOneDish, costingContext } from '../costing.js';
import { costDish, unitsCompatible, unitMismatchMessage, isUnit, poundsToPence } from '../calc/calc.js';
import { parseMoney, parseNumber, parsePercentField, cleanText, asArray, parseId } from '../input.js';
import { flash } from '../security.js';

const SORTS = {
  name: (a, b) => a.dish.name.localeCompare(b.dish.name, 'en-GB', { sensitivity: 'base' }),
  gp: (a, b) => (a.result.gpPct ?? Infinity) - (b.result.gpPct ?? Infinity),
  cost: (a, b) => (b.result.trueCost ?? -Infinity) - (a.result.trueCost ?? -Infinity),
  price: (a, b) => (b.result.menuInc ?? -Infinity) - (a.result.menuInc ?? -Infinity),
};

export default function dishRoutes({ db }) {
  const router = Router();

  // Home: every dish with cost, price, GP and status. Filters work without JavaScript.
  router.get('/', async (req, res) => {
    const filters = {
      q: cleanText(req.query.q, 100),
      type: ['food', 'drink'].includes(req.query.type) ? req.query.type : '',
      below: req.query.below === '1',
      sort: Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'name',
      inactive: req.query.inactive === '1',
    };
    const all = await costDishes(db);
    const needle = filters.q.toLowerCase();
    const rows = all
      .filter(({ dish }) => filters.inactive || dish.active)
      .filter(({ dish }) => !filters.type || dish.type === filters.type)
      .filter(({ dish }) => !needle || dish.name.toLowerCase().includes(needle))
      .filter(({ result }) => !filters.below || result.status.key === 'under' || result.status.key === 'below')
      .sort(SORTS[filters.sort]);
    const counts = { total: all.length, below: all.filter((r) => r.dish.active && r.result.status.key === 'below').length };
    res.render('dishes/list', { title: 'Dishes', rows, filters, counts });
  });

  router.get('/dishes/new', async (req, res) => {
    const type = req.query.type === 'drink' ? 'drink' : 'food';
    const dish = { id: null, name: '', type, menu_price_inc_pence: null, vat_rate: null, target_gp: null, yield_portions: 1, packaging: null, active: 1, notes: '' };
    await renderEditor(res, { dish, lines: [], errors: [] });
  });

  router.post('/dishes', (req, res) => saveFromForm(req, res, null));

  router.get('/dishes/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    const dish = id && await getDish(db, id);
    if (!dish) return next();
    const lines = (await listDishLines(db, [id])).map((l) => ({ ingredient_id: l.ingredient_id, quantity: l.quantity, unit: l.unit }));
    await renderEditor(res, { dish, lines, errors: [] });
  });

  router.post('/dishes/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id || !(await getDish(db, id))) return next();
    await saveFromForm(req, res, id);
  });

  router.post('/dishes/:id/delete', async (req, res, next) => {
    const id = parseId(req.params.id);
    const dish = id && await getDish(db, id);
    if (!dish) return next();
    await deleteDish(db, id);
    flash(req, `Deleted ${dish.name}.`);
    res.redirect('/');
  });

  async function saveFromForm(req, res, id) {
    const ingredients = await listIngredients(db);
    const { dish, lines, errors } = parseDishForm(req.body, ingredients);
    dish.id = id;
    if (errors.length) {
      res.status(422);
      return renderEditor(res, { dish, lines, errors, ingredients });
    }
    const savedId = await saveDish(db, id, dish, lines);
    // Re-cost from what was actually saved, never from figures the browser showed.
    const saved = await costOneDish(db, savedId);
    const gp = saved.result.gpPct === null ? '' : ` GP is now ${res.locals.formatPct(saved.result.gpPct)}.`;
    flash(req, `Saved ${dish.name}.${gp}`);
    res.redirect(`/dishes/${savedId}`);
  }

  // Server-side render includes the full costing, so the page is correct even before
  // (or without) the live-update script.
  async function renderEditor(res, { dish, lines, errors, ingredients = null }) {
    const ings = ingredients || await listIngredients(db);
    const ctx = await costingContext(db);
    const byId = new Map(ings.map((i) => [i.id, i]));
    // Lines keep their positions so line N's cost and error line up with row N in the form.
    const costLines = lines.map((l) => ({ ...l, ingredient: byId.get(l.ingredient_id) }));
    const result = costDish(dish, costLines, ctx.settings, ctx.channels);
    res.render('dishes/edit', {
      title: dish.id ? dish.name : 'New dish',
      dish, lines, errors, result, ingredients: ings, settings: ctx.settings, channels: ctx.channels,
      // Data for the live calculator, read by public/js/dish-editor.js.
      editorData: {
        ingredients: ings.map(({ id, name, supplier, pack_size, pack_unit, pack_price_ex_vat, waste_pct }) =>
          ({ id, name, supplier, pack_size, pack_unit, pack_price_ex_vat, waste_pct })),
        settings: ctx.settings,
        channels: ctx.channels,
      },
    });
  }

  return router;
}

export const ingredientLabel = (i) => (i.supplier ? `${i.name} (${i.supplier})` : i.name);

// Validates the editor form. Returns { dish, lines, errors }; dish and lines echo what was
// typed so the form can be shown again with messages.
export function parseDishForm(body, ingredients) {
  const errors = [];
  // Each recipe line names its ingredient by label, e.g. "Plain flour (Brakes)".
  const byLabel = new Map(ingredients.map((i) => [ingredientLabel(i).toLowerCase(), i]));

  const name = cleanText(body.name, 200);
  if (!name) errors.push('Give the dish a name.');
  const type = body.type === 'drink' ? 'drink' : 'food';

  const priceText = String(body.menu_price ?? '').trim();
  const menuPrice = parseMoney(priceText);
  if (priceText && (menuPrice === null || menuPrice < 0 || menuPrice > 100000)) errors.push('Menu price must be an amount like 18.50, or left blank.');

  const yieldText = String(body.yield_portions ?? '').trim();
  const yieldPortions = yieldText === '' ? 1 : parseNumber(yieldText);
  if (yieldPortions === null || yieldPortions <= 0) errors.push('Portions must be a number above 0 (use 1 for a single serving).');

  const optionalPercent = (field, label, max) => {
    const text = String(body[field] ?? '').trim();
    if (text === '') return null;
    const v = parsePercentField(text);
    if (v === null || v < 0 || v >= max) {
      errors.push(`${label} must be a percentage from 0 to ${Math.round(max * 100) - 1}, or left blank to use the default.`);
      return null;
    }
    return v;
  };
  const vatRate = optionalPercent('vat_rate', 'VAT rate', 1);
  const targetGp = optionalPercent('target_gp', 'Target GP', 1);

  const packText = String(body.packaging ?? '').trim();
  const packaging = packText === '' ? null : parseMoney(packText);
  if (packText && (packaging === null || packaging < 0)) errors.push('Packaging must be an amount like 0.50, or left blank to use the default.');

  const labels = asArray(body.line_ingredient);
  const qtys = asArray(body.line_quantity);
  const units = asArray(body.line_unit);
  const lines = [];
  for (let i = 0; i < Math.max(labels.length, qtys.length); i++) {
    const labelText = cleanText(labels[i], 420).toLowerCase();
    const qtyText = String(qtys[i] ?? '').trim();
    if (!labelText && !qtyText) continue; // blank row left in the form
    const n = lines.length + 1;
    const ingredient = byLabel.get(labelText);
    const ingredientId = ingredient ? ingredient.id : null;
    const quantity = parseNumber(qtyText);
    const unit = String(units[i] ?? '');
    lines.push({ ingredient_id: ingredientId, quantity: quantity ?? qtyText, unit });
    if (!ingredient) {
      errors.push(labelText ? `Line ${n}: "${labels[i].trim()}" isn't in your ingredient list. Pick one from the suggestions, or add it on the Ingredients page.` : `Line ${n}: choose an ingredient.`);
      lines[lines.length - 1].label = String(labels[i] ?? '');
      continue;
    }
    if (quantity === null || quantity <= 0) errors.push(`Line ${n}: enter a quantity of ${ingredient.name} above 0.`);
    if (!isUnit(unit)) errors.push(`Line ${n}: choose a unit for ${ingredient.name}.`);
    else if (!unitsCompatible(unit, ingredient.pack_unit)) errors.push(`Line ${n}: ${unitMismatchMessage(ingredient.name, ingredient.pack_unit)}.`);
  }
  if (lines.length > 200) errors.push('A dish can have up to 200 ingredient lines.');

  const dish = {
    name, type,
    menu_price_inc_pence: menuPrice === null ? null : poundsToPence(menuPrice),
    vat_rate: vatRate,
    target_gp: targetGp,
    yield_portions: yieldPortions ?? 1,
    packaging,
    active: body.active === '1' ? 1 : 0,
    notes: String(body.notes ?? '').trim().slice(0, 2000),
  };
  return { dish, lines, errors };
}
