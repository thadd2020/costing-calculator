import { nowIso, numeric } from './util.js';

const parse = (row) => row && { ...numeric(row, ['id']), payload: JSON.parse(row.payload), summary: JSON.parse(row.summary) };

export async function createImportBatch(q, { filename, payload, summary }) {
  const { insertId } = await q.run(
    "INSERT INTO import_batches (created_at, filename, status, payload, summary) VALUES (?, ?, 'previewed', ?, ?)",
    [nowIso(), filename, JSON.stringify(payload), JSON.stringify(summary)],
  );
  return insertId;
}

export async function getImportBatch(q, id) {
  return parse(await q.get('SELECT id, created_at, filename, status, payload, summary FROM import_batches WHERE id = ?', [id]));
}

// Moves a batch from 'previewed' to a final status. Returns false if it was no longer
// 'previewed' (already committed or discarded), which stops a double commit.
export async function finishImportBatch(q, id, status, summary) {
  const { changes } = await q.run(
    "UPDATE import_batches SET status = ?, summary = ? WHERE id = ? AND status = 'previewed'",
    [status, JSON.stringify(summary), id],
  );
  return changes > 0;
}

// Previews nobody confirmed within a day are discarded and their rows dropped.
export async function discardStaleImports(q, olderThanIso) {
  await q.run(
    "UPDATE import_batches SET status = 'discarded', payload = '{}' WHERE status = 'previewed' AND created_at < ?",
    [olderThanIso],
  );
}

export async function listRecentImports(q, limit = 5) {
  const rows = await q.all(
    "SELECT id, created_at, filename, status, summary FROM import_batches WHERE status = 'committed' ORDER BY id DESC LIMIT ?",
    [limit],
  );
  return rows.map((r) => ({ ...numeric(r, ['id']), summary: JSON.parse(r.summary) }));
}
