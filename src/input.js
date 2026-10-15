// Forgiving parsers for numbers typed into forms or found in CSV files.
// Each returns a number, or null when the text isn't usable. Empty text is null.

const DECIMAL = /^-?(\d+\.?\d*|\.\d+)$/;

// Plain decimal number; spaces and thousands commas are ignored: "5,000" -> 5000.
export function parseNumber(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).trim().replace(/[\s,]/g, '');
  return DECIMAL.test(cleaned) ? Number(cleaned) : null;
}

// Like parseNumber, but a leading £ is allowed too: "£1,234.50" -> 1234.5.
export function parseMoney(text) {
  if (text === null || text === undefined) return null;
  return parseNumber(String(text).trim().replace(/^(-?)\s*£/, '$1'));
}

// A form field labelled "%": "6" or "6%" -> 0.06. Always treated as a percentage.
export function parsePercentField(text) {
  if (text === null || text === undefined) return null;
  const n = parseNumber(String(text).replace(/%\s*$/, ''));
  return n === null ? null : n / 100;
}

// CSV rule from the brief: "6%", "6" or "0.06" all mean 6%. Values above 1 are percentages.
export function parseFlexiblePercent(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;
  if (s.endsWith('%')) {
    const n = parseNumber(s.slice(0, -1));
    return n === null ? null : n / 100;
  }
  const n = parseNumber(s);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

const TRUE_WORDS = ['y', 'yes', 'true', '1', 'inc', 'inc vat', 'included'];
const FALSE_WORDS = ['n', 'no', 'false', '0', 'ex', 'ex vat', ''];

// Yes/no: returns true, false or null (unrecognised).
export function parseBoolean(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (TRUE_WORDS.includes(s)) return true;
  if (FALSE_WORDS.includes(s)) return false;
  return null;
}

const UNIT_ALIASES = {
  g: 'g', gram: 'g', grams: 'g', gr: 'g', gm: 'g', gms: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  each: 'each', ea: 'each', item: 'each', items: 'each', unit: 'each', units: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each',
};

// "KG", "Litres", "ea" -> canonical unit, or null.
export function parseUnit(text) {
  const s = String(text ?? '').trim().toLowerCase();
  return Object.hasOwn(UNIT_ALIASES, s) ? UNIT_ALIASES[s] : null;
}

export function cleanText(text, maxLength) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// Express gives a string for one value and an array for repeated fields; always get an array.
export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Route ids must be positive integers.
export function parseId(text) {
  return /^\d{1,10}$/.test(String(text)) ? Number(text) : null;
}
