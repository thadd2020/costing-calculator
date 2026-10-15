// Compares parsed CSV rows with the ingredients already saved. Pure.
import { samePrice } from '../db/ingredients.js';

const key = (name, supplier) => `${name.toLowerCase()}\u0000${supplier.toLowerCase()}`;
// Name and supplier are the match key (case-insensitive), so a change of case alone isn't a change.
const DETAIL_FIELDS = ['category', 'pack_size', 'pack_unit', 'vat_rate', 'waste_pct'];

const sameValue = (a, b) => (typeof a === 'number' || typeof b === 'number'
  ? Math.abs(Number(a) - Number(b)) < 1e-9
  : String(a) === String(b));

// Optional columns whose saved value is kept when the file doesn't have that column.
const KEEP_IF_ABSENT = ['category', 'vat_rate', 'waste_pct'];

// Returns { items, counts }. Each item is { row, action, data, existing?, oldPrice?, newPrice?, changePct? }
// where action is 'new', 'price_changed', 'details_changed' or 'unchanged'.
// `present` lists the columns the file had; null (older batches) means all of them.
export function planImport(rows, existingIngredients, rejectedCount = 0, present = null) {
  const kept = present ? KEEP_IF_ABSENT.filter((c) => !present.includes(c)) : [];
  const byKey = new Map(existingIngredients.map((i) => [key(i.name, i.supplier), i]));
  const items = rows.map(({ row, data }) => {
    const existing = byKey.get(key(data.name, data.supplier));
    if (!existing) return { row, action: 'new', data, newPrice: data.pack_price_ex_vat };
    // Keep the saved spelling of name and supplier.
    const base = {
      row,
      data: {
        ...data,
        ...Object.fromEntries(kept.map((c) => [c, existing[c]])),
        name: existing.name,
        supplier: existing.supplier,
      },
      existingId: existing.id, oldPrice: existing.pack_price_ex_vat, newPrice: data.pack_price_ex_vat,
    };
    if (!samePrice(existing.pack_price_ex_vat, data.pack_price_ex_vat)) {
      const changePct = existing.pack_price_ex_vat > 0
        ? (data.pack_price_ex_vat - existing.pack_price_ex_vat) / existing.pack_price_ex_vat
        : null;
      return { ...base, action: 'price_changed', changePct };
    }
    const changedFields = DETAIL_FIELDS.filter((f) => !sameValue(existing[f], base.data[f]));
    return changedFields.length ? { ...base, action: 'details_changed', changedFields } : { ...base, action: 'unchanged' };
  });
  const counts = { new: 0, price_changed: 0, details_changed: 0, unchanged: 0, rejected: rejectedCount };
  for (const item of items) counts[item.action] += 1;
  return { items, counts };
}
