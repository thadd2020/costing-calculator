// Nightly backups (CLAUDE.md section 12). SiteGround gives the app no writable folder that
// survives a deploy, so snapshots are kept in the database's backups table (newest 14) and
// SiteGround's own daily backups are the copy kept elsewhere. See DECISIONS.md.
import { createSnapshot, saveBackup, pruneBackups, latestBackupAt } from './db/index.js';

export const KEEP_BACKUPS = 14;
const DAY = 24 * 3600 * 1000;

// Takes a snapshot if the newest one is more than ~a day old. Safe to call often.
export async function backupIfDue(db, now = Date.now()) {
  const last = await latestBackupAt(db);
  if (last && now - new Date(last).getTime() < DAY - 3600 * 1000) return false;
  const snapshot = await createSnapshot(db);
  await saveBackup(db, snapshot);
  await pruneBackups(db, KEEP_BACKUPS);
  console.log(`Nightly backup saved (${snapshot.tables.ingredients.length} ingredients, ${snapshot.tables.dishes.length} dishes)`);
  return true;
}

// Checks hourly, so a backup happens within an hour of becoming due, including after a deploy.
export function startBackupSchedule(db) {
  const run = () => backupIfDue(db).catch((e) => console.error('Nightly backup failed:', e.message));
  const first = setTimeout(run, 60 * 1000);
  const timer = setInterval(run, 3600 * 1000);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
