-- Login sessions (so a restart or deploy doesn't log the owner out) and nightly backups.
CREATE TABLE sessions (
  sid VARCHAR(128) PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data TEXT NOT NULL
);
