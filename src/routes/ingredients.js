import { Router } from 'express';
import {
  listIngredients, getIngredient, createIngredient, updateIngredient, deleteIngredient, recentPriceHistory, listRecentImports,
} from '../db/index.js';
import { exVatFromInc, UNITS } from '../calc/calc.js';
import { parseMoney, parseNumber, parsePercentField, parseUnit, cleanText, parseId } from '../input.js';
import { flash } from '../security.js';

export default function ingredientRoutes({ db }) {
  const router = Router();

  router.get('/ingredients', async (req, res) => {
    const ingredients = await listIngredients(db);
    const q = cleanText(req.query.q, 100).toLowerCase();
    const shown = q
      ? ingredients.filter((i) => `${i.name} ${i.supplier} ${i.category}`.toLowerCase().includes(q))
      : ingredients;
    const history = await recentPriceHistory(db, 4);
    res.render('ingredients/list', {
      title: 'Ingredients', ingredients: shown, total: ingredients.length, q, history,
      units: UNITS, recentImports: await listRecentImports(db, 1),
      openId: parseId(req.query.open), formErrors: null, formValues: null,
    });
  });

  router.post('/ingredients', async (req, res) => {
    const { data, errors } = parseIngredientForm(req.body);
    if (errors.length) return renderWithErrors(req, res, 'new', errors);
    const result = await createIngredient(db, data, 'manual');
    if (result.error === 'duplicate') return renderWithErrors(req, res, 'new', [duplicateMessage(data)]);
    flash(req, `Added ${data.name}.`);
    res.redirect(`/ingredients#ingredient-${result.id}`);
  });

  router.post('/ingredients/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id || !(await getIngredient(db, id))) return next();
    const { data, errors } = parseIngredientForm(req.body);
    if (errors.length) return renderWithErrors(req, res, id, errors);
    const result = await updateIngredient(db, id, data, 'manual');
    if (result.error === 'duplicate') return renderWithErrors(req, res, id, [duplicateMessage(data)]);
    flash(req, result.priceChanged ? `Saved ${data.name}. New price recorded in its history.` : `Saved ${data.name}.`);
    res.redirect(`/ingredients#ingredient-${id}`);
  });

  router.post('/ingredients/:id/delete', async (req, res, next) => {
    const id = parseId(req.params.id);
    const ingredient = id && await getIngredient(db, id);
    if (!ingredient) return next();
    const result = await deleteIngredient(db, id);
    if (!result.deleted) {
      const names = result.dishes.map((d) => d.name).join(', ');
      flash(req, `${ingredient.name} is used in ${result.dishes.length === 1 ? 'a dish' : `${result.dishes.length} dishes`} (${names}). Remove it from ${result.dishes.length === 1 ? 'that dish' : 'those dishes'} first.`, 'error');
      return res.redirect(`/ingredients?open=${id}#ingredient-${id}`);
    }
    flash(req, `Deleted ${ingredient.name}.`);
    res.redirect('/ingredients');
  });

  async function renderWithErrors(req, res, which, errors) {
    const ingredients = await listIngredients(db);
    const history = await recentPriceHistory(db, 4);
    res.status(422).render('ingredients/list', {
      title: 'Ingredients', ingredients, total: ingredients.length, q: '', history,
      units: UNITS, recentImports: await listRecentImports(db, 1),
      openId: which === 'new' ? null : which, formErrors: { which, errors }, formValues: req.body,
    });
  }

  return router;
}

const duplicateMessage = (data) => `There's already an ingredient called ${data.name}${data.supplier ? ` from ${data.supplier}` : ' with no supplier'}. Edit that one instead, or change the name or supplier.`;

// Validates the add/edit ingredient form. Prices may be typed inc-VAT; they're stored ex-VAT.
export function parseIngredientForm(body) {
  const errors = [];
  const name = cleanText(body.name, 200);
  if (!name) errors.push('Enter a name.');
  const supplier = cleanText(body.supplier, 200);
  const category = cleanText(body.category, 100);

  const packSize = parseNumber(body.pack_size);
  if (packSize === null || packSize <= 0) errors.push('Pack size must be a number above 0, like 5 or 2.5.');
  const packUnit = parseUnit(body.pack_unit);
  if (!packUnit) errors.push('Choose the pack unit: g, kg, ml, l or each.');

  const price = parseMoney(body.pack_price);
  if (price === null || price < 0) errors.push('Pack price must be an amount like 12.50.');
  const vatRate = body.vat_rate === '0.2' ? 0.2 : 0;
  const incVat = body.price_includes_vat === '1';

  const wasteText = String(body.waste_pct ?? '').trim();
  const waste = wasteText === '' ? 0.05 : parsePercentField(wasteText);
  if (waste === null || waste < 0 || waste >= 1) errors.push('Waste must be a percentage from 0 to 99, like 5.');

  const data = {
    name, supplier, category, pack_size: packSize, pack_unit: packUnit,
    pack_price_ex_vat: price === null ? null : (incVat ? exVatFromInc(price, vatRate) : price),
    vat_rate: vatRate, waste_pct: waste,
  };
  return { data, errors };
}
