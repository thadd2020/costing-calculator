// Storage for express-session (see src/session-store.js). Times are epoch milliseconds.

export async function sessionGet(q, sid, now = Date.now()) {
  const row = await q.get('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?', [sid, now]);
  return row ? JSON.parse(row.data) : null;
}

export async function sessionSet(q, sid, data, expiresAt) {
  const json = JSON.stringify(data);
  const { changes } = await q.run('UPDATE sessions SET data = ?, expires_at = ? WHERE sid = ?', [json, expiresAt, sid]);
  if (changes > 0) return;
  try {
    await q.run('INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)', [sid, expiresAt, json]);
  } catch {
    // Another request inserted the same session at the same moment; update it instead.
    await q.run('UPDATE sessions SET data = ?, expires_at = ? WHERE sid = ?', [json, expiresAt, sid]);
  }
}

export async function sessionTouch(q, sid, expiresAt) {
  await q.run('UPDATE sessions SET expires_at = ? WHERE sid = ?', [expiresAt, sid]);
}

export async function sessionDestroy(q, sid) {
  await q.run('DELETE FROM sessions WHERE sid = ?', [sid]);
}

export async function sessionPruneExpired(q, now = Date.now()) {
  await q.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
}
