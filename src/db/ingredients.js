import { nowIso, numeric, isUniqueViolation } from './util.js';

const NUM_FIELDS = ['id', 'pack_size', 'pack_price_ex_vat', 'vat_rate', 'waste_pct', 'used_in'];
const COLUMNS = 'i.id, i.name, i.supplier, i.category, i.pack_size, i.pack_unit, i.pack_price_ex_vat, i.vat_rate, i.waste_pct, i.updated_at';

// All ingredients, with how many dishes use each and when its price last changed.
export async function listIngredients(q) {
  const rows = await q.all(`
    SELECT ${COLUMNS},
      (SELECT COUNT(DISTINCT di.dish_id) FROM dish_ingredients di WHERE di.ingredient_id = i.id) AS used_in,
      (SELECT MAX(ph.changed_at) FROM price_history ph WHERE ph.ingredient_id = i.id) AS last_price_change
    FROM ingredients i
    ORDER BY LOWER(i.name), LOWER(i.supplier)`);
  return rows.map((r) => numeric(r, NUM_FIELDS));
}

export async function getIngredient(q, id) {
  return numeric(await q.get(`SELECT ${COLUMNS} FROM ingredients i WHERE i.id = ?`, [id]), NUM_FIELDS);
}

// Matches the import's natural key: name + supplier, ignoring case.
export async function findIngredientByKey(q, name, supplier) {
  const row = await q.get(`SELECT ${COLUMNS} FROM ingredients i WHERE LOWER(i.name) = LOWER(?) AND LOWER(i.supplier) = LOWER(?)`, [name, supplier]);
  return numeric(row, NUM_FIELDS);
}

export async function priceHistory(q, ingredientId, limit = 5) {
  const rows = await q.all(
    'SELECT pack_price_ex_vat, changed_at, source FROM price_history WHERE ingredient_id = ? ORDER BY changed_at DESC, id DESC LIMIT ?',
    [ingredientId, limit],
  );
  return rows.map((r) => numeric(r, ['pack_price_ex_vat']));
}

async function addPriceHistory(q, ingredientId, price, source, at) {
  await q.run('INSERT INTO price_history (ingredient_id, pack_price_ex_vat, changed_at, source) VALUES (?, ?, ?, ?)', [ingredientId, price, at, source]);
}

// Prices are floats; treat differences below a hundredth of a penny as "unchanged".
export const samePrice = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

// data: { name, supplier, category, pack_size, pack_unit, pack_price_ex_vat, vat_rate, waste_pct }
// Returns { id } or { error: 'duplicate' }.
export async function createIngredient(q, data, source = 'manual') {
  const at = nowIso();
  try {
    const { insertId } = await q.run(
      `INSERT INTO ingredients (name, supplier, category, pack_size, pack_unit, pack_price_ex_vat, vat_rate, waste_pct, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.name, data.supplier, data.category, data.pack_size, data.pack_unit, data.pack_price_ex_vat, data.vat_rate, data.waste_pct, at],
    );
    await addPriceHistory(q, insertId, data.pack_price_ex_vat, source, at);
    return { id: insertId };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: 'duplicate' };
    throw err;
  }
}

// Writes a price_history row when the price changes. Returns { priceChanged } or { error }.
export async function updateIngredient(q, id, data, source = 'manual') {
  const existing = await getIngredient(q, id);
  if (!existing) return { error: 'not_found' };
  const at = nowIso();
  try {
    await q.run(
      `UPDATE ingredients SET name = ?, supplier = ?, category = ?, pack_size = ?, pack_unit = ?,
         pack_price_ex_vat = ?, vat_rate = ?, waste_pct = ?, updated_at = ? WHERE id = ?`,
      [data.name, data.supplier, data.category, data.pack_size, data.pack_unit, data.pack_price_ex_vat, data.vat_rate, data.waste_pct, at, id],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { error: 'duplicate' };
    throw err;
  }
  const priceChanged = !samePrice(existing.pack_price_ex_vat, data.pack_price_ex_vat);
  if (priceChanged) await addPriceHistory(q, id, data.pack_price_ex_vat, source, at);
  return { priceChanged, previous: existing };
}

export async function dishesUsingIngredient(q, ingredientId) {
  const rows = await q.all(
    `SELECT DISTINCT d.id, d.name FROM dishes d JOIN dish_ingredients di ON di.dish_id = d.id
     WHERE di.ingredient_id = ? ORDER BY d.name`,
    [ingredientId],
  );
  return rows.map((r) => numeric(r, ['id']));
}

// Refuses (with the dish names) while any dish uses the ingredient.
export async function deleteIngredient(q, id) {
  const dishes = await dishesUsingIngredient(q, id);
  if (dishes.length) return { deleted: false, dishes };
  const { changes } = await q.run('DELETE FROM ingredients WHERE id = ?', [id]);
  return { deleted: changes > 0, dishes: [] };
}

// Recent price history for every ingredient in one query: Map(ingredientId -> newest `perIngredient` rows).
export async function recentPriceHistory(q, perIngredient = 4) {
  const rows = await q.all('SELECT ingredient_id, pack_price_ex_vat, changed_at, source FROM price_history ORDER BY ingredient_id, changed_at DESC, id DESC');
  const out = new Map();
  for (const raw of rows) {
    const r = numeric(raw, ['ingredient_id', 'pack_price_ex_vat']);
    const list = out.get(r.ingredient_id) || [];
    if (list.length < perIngredient) list.push(r);
    out.set(r.ingredient_id, list);
  }
  return out;
}
