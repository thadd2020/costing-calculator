-- Records when this database file was first created. Used to check whether the
-- database survives a redeploy: if this time changes, the file was recreated.
INSERT INTO settings (key, value) VALUES ('installed_at', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
