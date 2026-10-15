// express-session store backed by our database, so logins survive restarts and deploys.
import session from 'express-session';
import { sessionGet, sessionSet, sessionTouch, sessionDestroy, sessionPruneExpired } from './db/index.js';

const expiryOf = (sess) => (sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 3600 * 1000);

export class DbSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    // Clear out expired sessions every hour.
    this.timer = setInterval(() => sessionPruneExpired(db).catch((e) => console.error('Session prune failed:', e.message)), 3600 * 1000);
    this.timer.unref();
  }

  get(sid, cb) { sessionGet(this.db, sid).then((s) => cb(null, s), cb); }
  set(sid, sess, cb) { sessionSet(this.db, sid, sess, expiryOf(sess)).then(() => cb?.(), (e) => cb?.(e)); }
  touch(sid, sess, cb) { sessionTouch(this.db, sid, expiryOf(sess)).then(() => cb?.(), (e) => cb?.(e)); }
  destroy(sid, cb) { sessionDestroy(this.db, sid).then(() => cb?.(), (e) => cb?.(e)); }
  close() { clearInterval(this.timer); }
}
