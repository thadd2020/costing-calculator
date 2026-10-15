// The two examples from the spreadsheet (docs/GP_Costing_Calculator.xlsx), so the app is
// never empty on first run. Each is one "each" line holding the whole ingredient cost.
import { createIngredient, saveDish, getSettings, markSetting, countRows } from './db/index.js';

export async function seedExamples(db) {
  const flour = await createIngredient(db, {
    name: 'Example dish ingredients', supplier: '', category: 'Example', pack_size: 1, pack_unit: 'each',
    pack_price_ex_vat: 4.5, vat_rate: 0, waste_pct: 0.06,
  }, 'manual');
  const wine = await createIngredient(db, {
    name: 'House wine (bottle)', supplier: '', category: 'Example', pack_size: 1, pack_unit: 'each',
    pack_price_ex_vat: 6, vat_rate: 0.2, waste_pct: 0.02,
  }, 'manual');
  if (flour.error || wine.error) return false; // already there
  const dish = { vat_rate: null, target_gp: null, yield_portions: 1, packaging: null, active: 1 };
  await saveDish(db, null, { ...dish, name: 'Example dish', type: 'food', menu_price_inc_pence: 1800,
    notes: 'Example from the GP spreadsheet: £4.50 of ingredients with 6% waste, sold at £18.00. Edit or delete it.' },
  [{ ingredient_id: flour.id, quantity: 1, unit: 'each' }]);
  await saveDish(db, null, { ...dish, name: 'Example house wine (bottle)', type: 'drink', menu_price_inc_pence: 2880,
    notes: 'Example from the GP spreadsheet: a £6.00 bottle with 2% waste, sold at £28.80. Edit or delete it.' },
  [{ ingredient_id: wine.id, quantity: 1, unit: 'each' }]);
  await markSetting(db, 'seeded', new Date().toISOString());
  return true;
}

// Seeds a brand-new database once. Deleting the examples later doesn't bring them back.
export async function seedIfNew(db) {
  if ((await getSettings(db)).seeded) return false;
  const counts = await countRows(db);
  if (counts.ingredients || counts.dishes) {
    await markSetting(db, 'seeded', 'skipped');
    return false;
  }
  return seedExamples(db);
}
