// Parses and validates an ingredient CSV (CLAUDE.md section 7). Pure: takes a Buffer,
// returns rows and errors, writes nothing.
import { parse } from 'csv-parse/sync';
import { parseMoney, parseNumber, parseFlexiblePercent, parseBoolean, parseUnit, cleanText } from '../input.js';
import { exVatFromInc } from '../calc/calc.js';
import { unescapeCell } from '../csv.js';

export const TEMPLATE_COLUMNS = ['name', 'supplier', 'category', 'pack_size', 'pack_unit', 'pack_price', 'price_includes_vat', 'vat_rate', 'waste_pct'];
export const MAX_ROWS = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;
const REQUIRED = ['name', 'pack_size', 'pack_unit', 'pack_price'];
// Optional fields where a blank means "no change" for an ingredient that already exists.
const OPTIONAL_KEPT = ['category', 'vat_rate', 'waste_pct'];

// Header aliases, after lower-casing and turning spaces/dashes into underscores.
const HEADER_ALIASES = {
  name: 'name', ingredient: 'name', item: 'name', product: 'name', description: 'name',
  supplier: 'supplier', vendor: 'supplier',
  category: 'category', type: 'category',
  pack_size: 'pack_size', size: 'pack_size', pack: 'pack_size', quantity: 'pack_size', qty: 'pack_size',
  pack_unit: 'pack_unit', unit: 'pack_unit', units: 'pack_unit', uom: 'pack_unit',
  pack_price: 'pack_price', price: 'pack_price', cost: 'pack_price', unit_price: 'pack_price', pack_cost: 'pack_price',
  price_includes_vat: 'price_includes_vat', includes_vat: 'price_includes_vat', inc_vat: 'price_includes_vat', vat_included: 'price_includes_vat',
  vat_rate: 'vat_rate', vat: 'vat_rate',
  waste_pct: 'waste_pct', waste: 'waste_pct', waste_percent: 'waste_pct', 'waste_%': 'waste_pct',
};

export const normaliseHeader = (h) => String(h).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

// Picks the delimiter that appears most in the header line: comma, semicolon or tab.
function detectDelimiter(text) {
  const firstLine = text.match(/[^\r\n]*\S[^\r\n]*/)?.[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

// Excel's plain "CSV (Comma delimited)" saves as Windows-1252, not UTF-8. If the bytes aren't
// valid UTF-8 and contain no UTF-8 accents or symbols at all, read them as Windows-1252 so
// "Crème" and "£" survive. A UTF-8 file with one stray bad byte stays UTF-8.
function decode(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('\uFFFD') || /[^\u0000-\u007F\uFFFD\uFEFF]/.test(utf8)) return utf8;
  return new TextDecoder('windows-1252').decode(buffer);
}

const key = (name, supplier) => `${name.toLowerCase()}\u0000${supplier.toLowerCase()}`;

// Returns { rows, errors, fatal, columns }.
//   rows:   [{ row, data: { name, supplier, category, pack_size, pack_unit, pack_price_ex_vat, vat_rate, waste_pct }, blank, raw }]
//           blank lists the optional fields left empty (or with no column at all); for an
//           ingredient that already exists, those keep their saved values (see plan.js)
//   errors: [{ row, field, message, raw }]
//   fatal:  string when the whole file is unusable (then rows and errors are empty)
// `row` is the line number in the file, counting the header as row 1, like a spreadsheet.
export function parseIngredientCsv(buffer) {
  const empty = (fatal) => ({ rows: [], errors: [], fatal, columns: [] });
  if (!buffer || buffer.length === 0) return empty('The file is empty.');
  if (buffer.length > MAX_BYTES) return empty('The file is larger than 2 MB. Split it into smaller files.');
  const text = decode(buffer).replace(/^﻿/, '');
  if (text.includes('\u0000')) return empty("This doesn't look like a CSV file. Save the spreadsheet as CSV (UTF-8) and try again.");

  let records;
  try {
    records = parse(text, {
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      skip_empty_lines: true,
      // A stray quote inside a field (12" pizza base) is kept as text, not a whole-file error.
      relax_quotes: true,
      trim: true,
      info: true,
    });
  } catch (err) {
    return empty(`The file couldn't be read as CSV (${err.message.split('\n')[0]}).`);
  }
  if (records.length === 0) return empty('The file is empty.');

  const header = records[0].record.map(normaliseHeader);
  const columns = header.map((h) => HEADER_ALIASES[h] || null);
  const missing = REQUIRED.filter((c) => !columns.includes(c));
  if (missing.length) {
    return empty(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. The first row must be the column names; download the template to see them.`);
  }
  const dataRecords = records.slice(1).filter(({ record }) => record.some((cell) => cell !== ''));
  if (dataRecords.length > MAX_ROWS) return empty(`The file has ${dataRecords.length} rows; the limit is ${MAX_ROWS}. Split it into smaller files.`);

  const rows = [];
  const errors = [];
  const seen = new Map();
  for (const { record, info } of dataRecords) {
    // info.lines is the line a record ends on; a quoted value can span lines, and the owner
    // needs the row where it starts.
    const innerBreaks = record.join('').match(/\r\n|\r|\n/g)?.length ?? 0;
    const rowNumber = info.lines - innerBreaks;
    const raw = {};
    columns.forEach((col, i) => { if (col && raw[col] === undefined) raw[col] = unescapeCell(record[i] ?? ''); });
    const result = validateRow(raw, rowNumber);
    if (result.error) {
      errors.push({ row: rowNumber, ...result.error, raw });
      continue;
    }
    const k = key(result.data.name, result.data.supplier);
    if (seen.has(k)) {
      errors.push({ row: rowNumber, field: 'name', message: `Row ${rowNumber}: same name and supplier as row ${seen.get(k)}; only the first is used`, raw });
      continue;
    }
    seen.set(k, rowNumber);
    const blank = OPTIONAL_KEPT.filter((f) => String(raw[f] ?? '').trim() === '');
    rows.push({ row: rowNumber, data: result.data, blank, raw });
  }
  return { rows, errors, fatal: null, columns: TEMPLATE_COLUMNS };
}

function validateRow(raw, row) {
  const fail = (field, message) => ({ error: { field, message: `Row ${row}: ${message}` } });

  const name = cleanText(raw.name, 200);
  if (!name) return fail('name', 'name is blank');
  const supplier = cleanText(raw.supplier, 200);
  const category = cleanText(raw.category, 100);

  const packSize = parseNumber(raw.pack_size);
  if (packSize === null || packSize <= 0) return fail('pack_size', `pack_size '${raw.pack_size ?? ''}' must be a number above 0`);

  const unit = parseUnit(raw.pack_unit);
  if (!unit) return fail('pack_unit', `pack_unit '${raw.pack_unit ?? ''}' not recognised — use g, kg, ml, l or each`);

  const price = parseMoney(raw.pack_price);
  if (price === null || price < 0) return fail('pack_price', `pack_price '${raw.pack_price ?? ''}' must be a price like 12.50`);

  const incVat = parseBoolean(raw.price_includes_vat);
  if (incVat === null) return fail('price_includes_vat', `price_includes_vat '${raw.price_includes_vat}' should be yes or no`);

  let vatRate = 0;
  if (String(raw.vat_rate ?? '').trim() !== '') {
    vatRate = parseFlexiblePercent(raw.vat_rate);
    // Floats: 20% may arrive as 0.2 or 20/100; snap to the two allowed rates.
    if (vatRate !== null && Math.abs(vatRate - 0.2) < 1e-9) vatRate = 0.2;
    if (vatRate !== 0 && vatRate !== 0.2) return fail('vat_rate', `vat_rate '${raw.vat_rate}' must be 0 or 20%`);
  }
  if (incVat && vatRate === 0 && String(raw.vat_rate ?? '').trim() === '') {
    // Inc-VAT with no rate given: nothing to strip, so the price stays as entered. Flag it
    // rather than guess 20%, because many food items are zero-rated.
    return fail('vat_rate', 'price_includes_vat is yes but vat_rate is blank; enter 0 or 20%');
  }

  let waste = 0.05;
  if (String(raw.waste_pct ?? '').trim() !== '') {
    waste = parseFlexiblePercent(raw.waste_pct);
    if (waste === null || waste < 0 || waste >= 1) return fail('waste_pct', `waste_pct '${raw.waste_pct}' must be between 0% and 99%`);
  }

  return {
    data: {
      name, supplier, category, pack_size: packSize, pack_unit: unit,
      pack_price_ex_vat: incVat ? exVatFromInc(price, vatRate) : price,
      vat_rate: vatRate, waste_pct: waste,
    },
  };
}
