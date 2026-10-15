-- Login sessions (so a restart or deploy doesn't log the owner out) and nightly backups.
CREATE TABLE sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  data MEDIUMTEXT NOT NULL,
  KEY ix_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE backups (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at VARCHAR(30) NOT NULL,
  size_bytes INT NOT NULL,
  data LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
