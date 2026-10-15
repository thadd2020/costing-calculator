import { numeric, placeholders } from './util.js';

const DISH_NUM = ['id', 'menu_price_inc_pence', 'vat_rate', 'target_gp', 'yield_portions', 'packaging', 'active'];
const LINE_NUM = ['id', 'dish_id', 'ingredient_id', 'quantity', 'pack_size', 'pack_price_ex_vat', 'waste_pct', 'vat_rate'];
const DISH_COLUMNS = 'id, name, type, menu_price_inc_pence, vat_rate, target_gp, yield_portions, packaging, active, notes';

export async function listDishes(q) {
  const rows = await q.all(`SELECT ${DISH_COLUMNS} FROM dishes ORDER BY LOWER(name)`);
  return rows.map((r) => numeric(r, DISH_NUM));
}

export async function getDish(q, id) {
  return numeric(await q.get(`SELECT ${DISH_COLUMNS} FROM dishes WHERE id = ?`, [id]), DISH_NUM);
}

// Recipe lines, each with the ingredient fields the calc engine needs nested as `ingredient`.
// Pass dishIds to limit to some dishes; omit for all.
export async function listDishLines(q, dishIds = null) {
  if (dishIds && dishIds.length === 0) return [];
  const where = dishIds ? `WHERE di.dish_id IN (${placeholders(dishIds.length)})` : '';
  const rows = await q.all(
    `SELECT di.id, di.dish_id, di.ingredient_id, di.quantity, di.unit,
            i.name, i.supplier, i.pack_size, i.pack_unit, i.pack_price_ex_vat, i.waste_pct, i.vat_rate
     FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id
     ${where}
     ORDER BY di.dish_id, di.id`,
    dishIds || [],
  );
  return rows.map((raw) => {
    const r = numeric(raw, LINE_NUM);
    return {
      id: r.id, dish_id: r.dish_id, ingredient_id: r.ingredient_id, quantity: r.quantity, unit: r.unit,
      ingredient: {
        id: r.ingredient_id, name: r.name, supplier: r.supplier, pack_size: r.pack_size,
        pack_unit: r.pack_unit, pack_price_ex_vat: r.pack_price_ex_vat, waste_pct: r.waste_pct, vat_rate: r.vat_rate,
      },
    };
  });
}

// Dishes that use any of the given ingredients.
export async function dishIdsUsingIngredients(q, ingredientIds) {
  if (!ingredientIds.length) return [];
  const rows = await q.all(
    `SELECT DISTINCT dish_id FROM dish_ingredients WHERE ingredient_id IN (${placeholders(ingredientIds.length)})`,
    ingredientIds,
  );
  return rows.map((r) => Number(r.dish_id));
}

// Creates (id = null) or updates a dish and replaces its recipe lines, in one transaction.
// dish: { name, type, menu_price_inc_pence, vat_rate, target_gp, yield_portions, packaging, active, notes }
// lines: [{ ingredient_id, quantity, unit }]
export async function saveDish(db, id, dish, lines) {
  return db.transaction(async (tx) => {
    const values = [dish.name, dish.type, dish.menu_price_inc_pence, dish.vat_rate, dish.target_gp,
      dish.yield_portions, dish.packaging, dish.active, dish.notes];
    let dishId = id;
    if (dishId === null) {
      ({ insertId: dishId } = await tx.run(
        `INSERT INTO dishes (name, type, menu_price_inc_pence, vat_rate, target_gp, yield_portions, packaging, active, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, values));
    } else {
      const { changes } = await tx.run(
        `UPDATE dishes SET name = ?, type = ?, menu_price_inc_pence = ?, vat_rate = ?, target_gp = ?,
           yield_portions = ?, packaging = ?, active = ?, notes = ? WHERE id = ?`, [...values, dishId]);
      if (changes === 0) return null;
      await tx.run('DELETE FROM dish_ingredients WHERE dish_id = ?', [dishId]);
    }
    for (const line of lines) {
      await tx.run('INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity, unit) VALUES (?, ?, ?, ?)',
        [dishId, line.ingredient_id, line.quantity, line.unit]);
    }
    return dishId;
  });
}

export async function deleteDish(q, id) {
  const { changes } = await q.run('DELETE FROM dishes WHERE id = ?', [id]);
  return changes > 0;
}

export async function countRows(q) {
  const one = async (table) => Number((await q.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
  return { ingredients: await one('ingredients'), dishes: await one('dishes') };
}
