import { numeric, isUniqueViolation } from './util.js';

export async function listChannels(q) {
  const rows = await q.all('SELECT id, name, commission FROM delivery_channels ORDER BY LOWER(name)');
  return rows.map((r) => numeric(r, ['id', 'commission']));
}

export async function getChannel(q, id) {
  return numeric(await q.get('SELECT id, name, commission FROM delivery_channels WHERE id = ?', [id]), ['id', 'commission']);
}

// Returns { id } or { error: 'duplicate' }.
export async function createChannel(q, { name, commission }) {
  try {
    const { insertId } = await q.run('INSERT INTO delivery_channels (name, commission) VALUES (?, ?)', [name, commission]);
    return { id: insertId };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: 'duplicate' };
    throw err;
  }
}

export async function updateChannel(q, id, { name, commission }) {
  try {
    await q.run('UPDATE delivery_channels SET name = ?, commission = ? WHERE id = ?', [name, commission, id]);
    return {};
  } catch (err) {
    if (isUniqueViolation(err)) return { error: 'duplicate' };
    throw err;
  }
}

export async function deleteChannel(q, id) {
  await q.run('DELETE FROM delivery_channels WHERE id = ?', [id]);
}
