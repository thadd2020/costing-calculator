// CSV output with spreadsheet formula-injection protection (CLAUDE.md section 7).
import { stringify } from 'csv-stringify/sync';

// A text cell starting with = + - @ (or tab / carriage return) could run as a formula when
// opened in Excel, so it gets a leading single quote. Numbers are left alone.
export function safeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const s = String(value);
  // Also protect text that really starts with ' plus a formula character, because the
  // importer strips one leading quote from such cells.
  return /^'?[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// The import strips that quote again, so export -> edit -> re-import round-trips.
export function unescapeCell(value) {
  return typeof value === 'string' && /^''?[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

export function toCsv(columns, rows) {
  return stringify([columns, ...rows.map((r) => columns.map((c) => safeCell(r[c])))], { bom: true });
}

// Sends a CSV download. The filename is ours, never user input.
export function sendCsv(res, filename, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(csv);
}
