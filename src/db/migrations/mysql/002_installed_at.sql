-- Records when this database was first created. Used to check that redeploys keep the data.
INSERT INTO settings (`key`, value) VALUES ('installed_at', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'));
