-- Initial schema (CLAUDE.md section 4), MySQL 8 version of sqlite/001_init.sql.
-- Keep the two in step. Differences: VARCHAR instead of TEXT where indexed or defaulted,
-- DOUBLE for REAL, AUTO_INCREMENT ids, and `key` quoted because it's a reserved word.
-- The server's default utf8mb4 collation is case-insensitive, so the plain unique index
-- on (name, supplier) behaves like SQLite's lower(name), lower(supplier) index.

CREATE TABLE settings (
  `key` VARCHAR(64) NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO settings (`key`, value) VALUES
  ('vat_rate', '0.20'),
  ('target_gp_food', '0.70'),
  ('target_gp_drink', '0.70'),
  ('alert_gp', '0.60'),
  ('default_packaging', '0.50'),
  ('round_up_to_pence', '0');

CREATE TABLE ingredients (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  supplier VARCHAR(200) NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT '',
  pack_size DOUBLE NOT NULL,
  pack_unit VARCHAR(8) NOT NULL,
  pack_price_ex_vat DOUBLE NOT NULL,
  vat_rate DOUBLE NOT NULL DEFAULT 0,
  waste_pct DOUBLE NOT NULL DEFAULT 0.05,
  updated_at VARCHAR(30) NOT NULL,
  UNIQUE KEY ux_ingredient (name, supplier),
  CONSTRAINT ck_ing_pack_size CHECK (pack_size > 0),
  CONSTRAINT ck_ing_pack_unit CHECK (pack_unit IN ('g','kg','ml','l','each')),
  CONSTRAINT ck_ing_price CHECK (pack_price_ex_vat >= 0),
  CONSTRAINT ck_ing_waste CHECK (waste_pct >= 0 AND waste_pct < 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE price_history (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ingredient_id INT NOT NULL,
  pack_price_ex_vat DOUBLE NOT NULL,
  changed_at VARCHAR(30) NOT NULL,
  source VARCHAR(10) NOT NULL,
  KEY ix_price_history_ingredient (ingredient_id, changed_at),
  CONSTRAINT fk_ph_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE,
  CONSTRAINT ck_ph_source CHECK (source IN ('manual','import'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE dishes (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(10) NOT NULL,
  menu_price_inc_pence INT NULL,
  vat_rate DOUBLE NULL,
  target_gp DOUBLE NULL,
  yield_portions DOUBLE NOT NULL DEFAULT 1,
  packaging DOUBLE NULL,
  active TINYINT NOT NULL DEFAULT 1,
  notes VARCHAR(2000) NOT NULL DEFAULT '',
  CONSTRAINT ck_dish_type CHECK (type IN ('food','drink')),
  CONSTRAINT ck_dish_yield CHECK (yield_portions > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE dish_ingredients (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dish_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  quantity DOUBLE NOT NULL,
  unit VARCHAR(8) NOT NULL,
  KEY ix_dish_ingredients_dish (dish_id),
  KEY ix_dish_ingredients_ingredient (ingredient_id),
  CONSTRAINT fk_di_dish FOREIGN KEY (dish_id) REFERENCES dishes(id) ON DELETE CASCADE,
  CONSTRAINT fk_di_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE RESTRICT,
  CONSTRAINT ck_di_quantity CHECK (quantity > 0),
  CONSTRAINT ck_di_unit CHECK (unit IN ('g','kg','ml','l','each'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE delivery_channels (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  commission DOUBLE NOT NULL,
  UNIQUE KEY ux_channel_name (name),
  CONSTRAINT ck_channel_commission CHECK (commission >= 0 AND commission < 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO delivery_channels (name, commission) VALUES
  ('Deliveroo', 0.30),
  ('Uber Eats', 0.30),
  ('Just Eat', 0.14),
  ('Own website', 0.02);

CREATE TABLE import_batches (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at VARCHAR(30) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  status VARCHAR(10) NOT NULL,
  payload LONGTEXT NOT NULL,
  summary TEXT NOT NULL,
  CONSTRAINT ck_batch_status CHECK (status IN ('previewed','committed','discarded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
