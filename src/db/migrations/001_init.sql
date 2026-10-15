-- Initial schema (CLAUDE.md section 4).

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES
  ('vat_rate', '0.20'),
  ('target_gp_food', '0.70'),
  ('target_gp_drink', '0.70'),
  ('alert_gp', '0.60'),
  ('default_packaging', '0.50'),
  ('round_up_to_pence', '0');

CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  pack_size REAL NOT NULL CHECK (pack_size > 0),
  pack_unit TEXT NOT NULL CHECK (pack_unit IN ('g','kg','ml','l','each')),
  pack_price_ex_vat REAL NOT NULL CHECK (pack_price_ex_vat >= 0),
  vat_rate REAL NOT NULL DEFAULT 0,
  waste_pct REAL NOT NULL DEFAULT 0.05 CHECK (waste_pct >= 0 AND waste_pct < 1),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_ingredient ON ingredients (lower(name), lower(supplier));

CREATE TABLE price_history (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  pack_price_ex_vat REAL NOT NULL,
  changed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','import'))
);
CREATE INDEX ix_price_history_ingredient ON price_history (ingredient_id, changed_at);

CREATE TABLE dishes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('food','drink')),
  menu_price_inc_pence INTEGER,
  vat_rate REAL,
  target_gp REAL,
  yield_portions REAL NOT NULL DEFAULT 1 CHECK (yield_portions > 0),
  packaging REAL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE dish_ingredients (
  id INTEGER PRIMARY KEY,
  dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL CHECK (unit IN ('g','kg','ml','l','each'))
);
CREATE INDEX ix_dish_ingredients_dish ON dish_ingredients (dish_id);
CREATE INDEX ix_dish_ingredients_ingredient ON dish_ingredients (ingredient_id);

CREATE TABLE delivery_channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  commission REAL NOT NULL CHECK (commission >= 0 AND commission < 1)
);
INSERT INTO delivery_channels (name, commission) VALUES
  ('Deliveroo', 0.30),
  ('Uber Eats', 0.30),
  ('Just Eat', 0.14),
  ('Own website', 0.02);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed','committed','discarded')),
  payload TEXT NOT NULL,
  summary TEXT NOT NULL
);
