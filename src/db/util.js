// Small helpers shared by the query modules.

export const nowIso = () => new Date().toISOString();

// Drivers return numbers for numeric columns, but COUNT/SUM can come back as strings or
// bigints depending on the engine; normalise the named fields to plain numbers.
export function numeric(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) if (out[f] !== null && out[f] !== undefined) out[f] = Number(out[f]);
  return out;
}

// Builds "?, ?, ?" for an IN (...) list. Only placeholders are generated; values stay parameters.
export const placeholders = (n) => Array(n).fill('?').join(', ');

export function isUniqueViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'ER_DUP_ENTRY';
}
