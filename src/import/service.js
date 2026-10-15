// The import flow: preview (parse + plan + store the batch) and commit (from the stored batch).
import {
  listIngredients, createIngredient, updateIngredient, createImportBatch, getImportBatch,
  finishImportBatch, discardStaleImports, dishIdsUsingIngredients,
} from '../db/index.js';
import { parseIngredientCsv } from './parse.js';
import { planImport } from './plan.js';
import { costDishes } from '../costing.js';

// A problem to show the owner; anything else is a bug and gets the generic error page.
export class ImportError extends Error {}

// Parses the upload and stores it as a 'previewed' batch. Nothing touches ingredients yet.
// Returns { batchId } or { fatal }.
export async function previewImport(db, { filename, buffer }) {
  const parsed = parseIngredientCsv(buffer);
  if (parsed.fatal) return { fatal: parsed.fatal };
  const plan = planImport(parsed.rows, await listIngredients(db), parsed.errors.length);
  await discardStaleImports(db, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const batchId = await createImportBatch(db, {
    filename,
    payload: { rows: parsed.rows.map(({ row, data }) => ({ row, data })), errors: parsed.errors },
    summary: plan.counts,
  });
  return { batchId };
}

// Re-plans against the ingredients as they are NOW (they may have changed since the preview),
// then writes everything in one transaction. Only rows from the stored batch are used, so the
// confirmation can't be tampered with. Returns { result } or { error }.
export async function commitImport(db, batchId) {
  return db.transaction(async (tx) => {
    const batch = await getImportBatch(tx, batchId);
    if (!batch) return { error: 'not_found' };
    if (batch.status !== 'previewed') return { error: batch.status };

    const plan = planImport(batch.payload.rows, await listIngredients(tx), batch.payload.errors.length);
    const changingIds = plan.items.filter((i) => i.action === 'price_changed').map((i) => i.existingId);
    const affectedDishIds = await dishIdsUsingIngredients(tx, changingIds);
    const before = new Map((await costDishes(tx, { dishIds: affectedDishIds })).map((d) => [d.dish.id, d.result]));
    const priceChangedIds = [];
    for (const item of plan.items) {
      if (item.action === 'new') {
        const res = await createIngredient(tx, item.data, 'import');
        // Only possible if MySQL's accent-insensitive match finds a near-identical name.
        if (res.error) throw new ImportError(`Row ${item.row}: ${item.data.name} clashes with an existing ingredient of almost the same name. Rename one and try again.`);
      } else if (item.action === 'price_changed' || item.action === 'details_changed') {
        await updateIngredient(tx, item.existingId, item.data, 'import');
        if (item.action === 'price_changed') priceChangedIds.push(item.existingId);
      }
    }
    // GP of every dish that uses a re-priced ingredient, before and after.
    const dishImpact = (await costDishes(tx, { dishIds: affectedDishIds })).map(({ dish, result }) => ({
      id: dish.id, name: dish.name, active: dish.active,
      beforePct: before.get(dish.id)?.gpPct ?? null, beforeStatus: before.get(dish.id)?.status.key ?? 'na',
      afterPct: result.gpPct, afterStatus: result.status.key,
    }));
    const summary = { ...plan.counts, dishImpact, committed_at: new Date().toISOString() };
    const finished = await finishImportBatch(tx, batchId, 'committed', summary);
    if (!finished) throw new ImportError('This import was already confirmed.');
    return { result: summary };
  });
}
