// Joins dishes, recipe lines and settings, and runs them through the calc engine.
// The server always recalculates from saved data; nothing the browser sends is trusted.
import { costDish } from './calc/calc.js';
import { getSettings, listChannels, listDishes, getDish, listDishLines } from './db/index.js';

export async function costingContext(q) {
  return { settings: await getSettings(q), channels: await listChannels(q) };
}

// Returns [{ dish, lines, result }] for every dish (or only `dishIds`).
export async function costDishes(q, { dishIds = null, context = null } = {}) {
  const ctx = context || await costingContext(q);
  const dishes = (await listDishes(q)).filter((d) => !dishIds || dishIds.includes(d.id));
  const lines = await listDishLines(q, dishIds);
  const byDish = new Map(dishes.map((d) => [d.id, []]));
  for (const line of lines) byDish.get(line.dish_id)?.push(line);
  return dishes.map((dish) => {
    const dishLines = byDish.get(dish.id) || [];
    return { dish, lines: dishLines, result: costDish(dish, dishLines, ctx.settings, ctx.channels) };
  });
}

export async function costOneDish(q, id, context = null) {
  const dish = await getDish(q, id);
  if (!dish) return null;
  const ctx = context || await costingContext(q);
  const lines = await listDishLines(q, [id]);
  return { dish, lines, result: costDish(dish, lines, ctx.settings, ctx.channels) };
}
