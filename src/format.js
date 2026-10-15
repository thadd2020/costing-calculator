// Display helpers for views (server side). Money and % formatting live in calc.js so the
// browser formats identically.
import { formatGBP, num } from './calc/calc.js';

const LONDON = 'Europe/London';
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '';
}

export function formatDateTime(iso) {
  return iso ? dateTimeFmt.format(new Date(iso)) : '';
}

// 1500 -> "1,500"; 0.25 -> "0.25". Up to 3 decimals, no trailing zeros.
export function formatQty(n) {
  const v = num(n);
  return v === null ? '' : v.toLocaleString('en-GB', { maximumFractionDigits: 3 });
}

// "£12.00 for 5 kg"
export function formatPackPrice(ing) {
  return `${formatGBP(ing.pack_price_ex_vat)} for ${formatQty(ing.pack_size)} ${ing.pack_unit}`;
}

// Cost per kg / per litre / each, which is how chefs compare prices.
export function unitCostLabel(ing) {
  const size = num(ing.pack_size);
  const price = num(ing.pack_price_ex_vat);
  if (!size || price === null) return '';
  if (ing.pack_unit === 'each') return `${formatGBP(price / size)} each`;
  const perBase = price / (size * (ing.pack_unit === 'kg' || ing.pack_unit === 'l' ? 1000 : 1));
  const big = ing.pack_unit === 'g' || ing.pack_unit === 'kg' ? 'kg' : 'litre';
  return `${formatGBP(perBase * 1000)} per ${big}`;
}

// Value for a money input: 18 -> "18.00", null -> "".
export function moneyInput(pounds) {
  const v = num(pounds);
  return v === null ? '' : v.toFixed(2);
}

// Value for a % input: 0.7 -> "70", 0.065 -> "6.5".
export function percentInput(fraction) {
  const v = num(fraction);
  return v === null ? '' : String(Number((v * 100).toFixed(4)));
}
