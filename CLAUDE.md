# GP Costing Calculator — Build Brief

Read this whole file before writing code. Build in the milestone order at the bottom. Ask me only if something is genuinely ambiguous; otherwise make a sensible call and log it in `DECISIONS.md`.

## 1. What we're building

A web app for a UK restaurant owner to cost dishes and drinks, see gross profit (GP) live, price menu items to hit a target GP, price a delivery menu after platform commission, and bulk-load ingredients from a CSV.

- One user (the owner) for v1. Mobile-first: it must work well on a phone in a kitchen.
- Hosted on SiteGround as a Node.js project, deployed from GitHub.
- Reference for the maths: `docs/GP_Costing_Calculator.xlsx` (I will drop it in the repo) and the Jelly article https://blog.getjelly.co.uk/gp-margin-calculator-food-beverage/. Where this brief and the spreadsheet disagree, this brief wins.

Non-goals for v1 (design so they can be added later, don't build): POS integration, invoice scanning, multi-location, multiple user accounts, sub-recipes.

## 2. Stack (decided)

- Node.js (use the newest version SiteGround supports — check their Node.js docs first, see section 12), Express.
- SQLite via `better-sqlite3`. ALL database access goes through one module (`src/db/`) so swapping to MySQL later only touches that folder.
- Server-rendered pages with EJS plus small vanilla JS for live recalculation. No bundler, no build step, no frontend framework. `npm install && npm start` must be enough to run it.
- Plain CSS (one stylesheet, CSS variables, light and dark mode, mobile-first). Use the `frontend-design` skill for UI decisions.
- Tests with the built-in `node:test` runner. No heavy test framework.
- Dependencies: keep them few and well-maintained (express, better-sqlite3, ejs, multer, csv-parse, csv-stringify, helmet, express-rate-limit, bcryptjs, express-session or signed cookies). Justify anything else in `DECISIONS.md`.

## 3. Architecture

```
Browser (phone/PC)
   |
Express server (routes, auth, views)
   |-- Calculation engine  (src/calc/)  pure functions, no I/O, fully unit-tested
   |-- CSV importer        (src/import/)  parse -> validate -> preview -> commit
   |
SQLite database (one file, path from DATA_DIR env var)
```

Rules:
- The calculation engine is pure functions with no database or Express imports. The browser uses the same formulas for live recalculation, so expose them as a plain ES module served to the client (`/static/calc.js`) and imported by the server too. One source of truth.
- Calculate at full floating-point precision. Round only for display (2 dp for money, 1 dp for percentages).
- Never trust client-side numbers: the server recalculates on save and on every page render.

## 4. Data model

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys and defaults:
--   vat_rate=0.20, target_gp_food=0.70, target_gp_drink=0.70,
--   alert_gp=0.60, default_packaging=0.50, round_up_to_pence=0

CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  supplier TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  pack_size REAL NOT NULL CHECK (pack_size > 0),
  pack_unit TEXT NOT NULL CHECK (pack_unit IN ('g','kg','ml','l','each')),
  pack_price_ex_vat REAL NOT NULL CHECK (pack_price_ex_vat >= 0),  -- pounds, ex-VAT
  vat_rate REAL NOT NULL DEFAULT 0,        -- 0 or 0.20 (many UK food items are zero-rated)
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

CREATE TABLE dishes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('food','drink')),
  menu_price_inc_pence INTEGER,            -- current menu price inc-VAT, integer pence
  vat_rate REAL,                           -- NULL = use settings.vat_rate
  target_gp REAL,                          -- NULL = use the food/drink default
  yield_portions REAL NOT NULL DEFAULT 1 CHECK (yield_portions > 0),
  packaging REAL,                          -- NULL = use settings.default_packaging (delivery only)
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

CREATE TABLE delivery_channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  commission REAL NOT NULL CHECK (commission >= 0 AND commission < 1)
);
-- seed: Deliveroo 0.30, Uber Eats 0.30, Just Eat 0.14, Own website 0.02

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed','committed','discarded')),
  payload TEXT NOT NULL,                   -- JSON of parsed rows + validation result
  summary TEXT NOT NULL                    -- JSON: counts of new / changed / unchanged / rejected
);
```

Use a simple migration runner (numbered `.sql` files in `src/db/migrations/`, applied in order, tracked in a `schema_version` table). Enable `PRAGMA foreign_keys = ON` and WAL mode.

An ingredient cannot be deleted while a dish uses it (RESTRICT); show a friendly message listing the dishes.

## 5. Units

Base units: grams (g), millilitres (ml), each. Conversions: kg = 1000 g, l = 1000 ml. A recipe line's unit must be in the same family as the ingredient's pack unit (mass, volume or each); reject mismatches with a clear message ("Flour is bought by weight; use g or kg").

## 6. Formulas (the core — implement exactly, with the test vectors)

Inputs: `VAT` = vat rate (0.20), waste as a fraction (0.06 = 6%).

1. Unit cost (per base unit): `unit_cost = pack_price_ex_vat / (pack_size converted to base units)`
2. Line cost: `line_cost = quantity_in_base_units * unit_cost * (1 + waste_pct)`
3. Dish true cost per portion: `true_cost = sum(line_cost) / yield_portions`
4. Price ex-VAT: `price_ex_vat = menu_price_inc / (1 + dish_vat_rate)`
5. GP money and GP %: `gp_money = price_ex_vat - true_cost`, `gp_pct = gp_money / price_ex_vat` (if price_ex_vat is 0 or missing, GP is "n/a", never divide by zero)
6. Status: `gp_pct >= target` is "On target"; `alert <= gp_pct < target` is "Under target"; `gp_pct < alert` is "Below alert". Use green, amber, red, and ALSO text/icons (never colour alone).
7. Suggested price: `suggested_ex_vat = true_cost / (1 - target_gp)`, `suggested_inc = suggested_ex_vat * (1 + vat)`. Optional rounding setting: round the inc-VAT price UP to the next 5p / 10p / 50p. Only ever round up, so GP never ends below target.
8. Delivery (per channel):
   - `delivery_ex_vat = (price_ex_vat + packaging) / (1 - commission)`
   - `delivery_inc_vat = delivery_ex_vat * (1 + vat)`
   - `revenue_kept = delivery_ex_vat * (1 - commission)`
   - `delivery_gp_money = revenue_kept - packaging - true_cost`
   - `delivery_gp_pct = delivery_gp_money / revenue_kept`
   - `price_to_hold_target_ex_vat = ((true_cost + packaging) / (1 - target_gp)) / (1 - commission)`, then `* (1 + vat)` for inc-VAT
9. Markup (display only, labelled clearly as different from GP%): `markup_pct = (price_ex_vat - true_cost) / true_cost`

VAT notes: sales VAT defaults to 20% (settings, overridable per dish). Ingredient VAT is per ingredient (0% or 20%) and is only used when a price is entered or imported as VAT-inclusive: `ex_vat = inc_vat / (1 + ingredient_vat_rate)`. Do NOT blindly divide every supplier price by 1.20.

### Test vectors (must pass, tolerance 1e-6 unless noted)

| Case | Inputs | Expected |
|---|---|---|
| Unit cost | £12.00 pack, 5000 g | 0.0024 per g |
| Line cost | 200 g, unit cost 0.0024, waste 6% | 0.5088 |
| Dish A | ingredient cost £4.50 (single line, qty 1 each at £4.50), waste 6%, menu £18.00 inc, VAT 20% | true cost 4.77; price ex-VAT 15.00; GP £10.23; GP % 0.682; status "Under target" at 70% |
| Dish A suggested | target 70% | ex-VAT 15.90; inc-VAT 19.08 |
| Wine | cost £6.00, waste 2%, menu £28.80 inc | true cost 6.12; ex-VAT 24.00; GP £17.88; GP % 0.745; "On target" at 70%; suggested ex-VAT 20.40, inc 24.48 |
| Delivery (Dish A, 30% commission, £0.50 packaging) | | delivery ex-VAT 22.142857; inc-VAT 26.571429; kept 15.50; GP £10.23; GP % 0.66; hold-target ex-VAT 25.095238; inc 30.114286 |
| Markup | 70% GP, cost 30, price 100 | 2.3333 |
| Edge cases | price 0, price missing, waste 0, yield 4, mismatched units, commission 0 | no NaN/Infinity anywhere; sensible "n/a" |

Add property-style tests: raising any ingredient price never raises GP%; raising menu price never lowers GP%; suggested price always yields GP >= target.

## 7. CSV bulk import

Goal: owner uploads a supplier price list or a spreadsheet export and loads/updates many ingredients at once.

Template columns (provide a downloadable template with one example row):
`name, supplier, category, pack_size, pack_unit, pack_price, price_includes_vat, vat_rate, waste_pct`

Rules:
- Required: `name`, `pack_size`, `pack_unit`, `pack_price`. Others optional with defaults (`supplier` blank, `price_includes_vat` = no, `vat_rate` = 0, `waste_pct` = 5%).
- Be forgiving on input: UTF-8 with or without BOM; header names case-insensitive and trimmed, with a few aliases (e.g. `price`, `unit`, `size`); strip `£` and thousands commas from prices; accept `6%`, `6` or `0.06` for waste (treat values > 1 as percentages); `Y/yes/true/1` for booleans; units case-insensitive (`KG`, `Kg`).
- If `price_includes_vat` is yes, convert to ex-VAT using that row's `vat_rate`.
- Match existing ingredients on lower(name) + lower(supplier). Matched rows update; unmatched rows are created.
- Validate every row; collect errors with row number and reason ("Row 14: pack_unit 'bottle' not recognised — use g, kg, ml, l or each"). Bad rows are skipped, good rows continue.
- Two-step flow: upload → PREVIEW screen showing counts (new / price changed / unchanged / rejected), a table of changes with old vs new price and the percentage change, and the list of rejected rows (downloadable as CSV). Nothing is written until the user clicks Confirm. Store the parsed batch in `import_batches` and commit from that, so the confirmation can't be tampered with.
- On commit: do it in ONE transaction; write a `price_history` row whenever a price changes; the import is all-or-nothing for the good rows.
- After commit, show which dishes are now below their alert threshold because of price changes.
- Limits: CSV only, max 2 MB, max 5,000 rows, memory storage (no files written to disk).
- Also provide "Export all ingredients to CSV" in the same format (so export → edit → re-import works), and escape formula injection on export (prefix any cell starting with `=`, `+`, `-` or `@` with a single quote).

## 8. Screens (mobile-first, then scale up)

1. Dishes (home): searchable/sortable list showing name, type, true cost, price inc-VAT, GP %, status chip. Filters: food/drink, below target only. Tapping a dish opens the editor.
2. Dish editor: name, type, menu price, yield portions; add ingredient lines (search ingredient, quantity, unit); the cost, GP £, GP %, status, suggested price and delivery prices update LIVE as the user types (client-side with the shared calc module), and are re-verified by the server on save. Show a "Use suggested price" button.
3. Ingredients: searchable table/cards, inline edit, last price change, "used in N dishes". Bulk import button.
4. Import wizard: upload → preview → confirm → result (section 7).
5. Delivery: pick a channel, see every dish's delivery price (ex and inc VAT), delivery GP %, and price needed to hold target GP.
6. Settings: VAT rate, target GP (food/drink), alert threshold, default packaging, price rounding, delivery channels (add/edit commission), change password.
7. Export/backup: download ingredients CSV, dishes CSV, and a full database backup file.

UI quality bar: large tap targets, numeric keyboards on numeric fields (`inputmode="decimal"`), no horizontal scrolling on a 360px-wide phone, light/dark mode, clear empty states, helpful validation messages, GBP formatting with `Intl.NumberFormat('en-GB', {style:'currency', currency:'GBP'})`, dates in Europe/London. Visible labels on every input, keyboard-accessible, sufficient contrast.

## 9. Auth and security

This is commercially sensitive cost data, so it must not be public.
- Single owner login: password hash (bcrypt) from the `ADMIN_PASSWORD_HASH` env var; provide `npm run set-password` that prints a hash. Session secret from `SESSION_SECRET`.
- Secure, httpOnly, sameSite=lax session cookie; `secure` in production; sessions expire after 14 days.
- Rate-limit login (e.g. 10 attempts per 15 minutes per IP).
- `helmet` with a sensible CSP, CSRF token on every state-changing form/request, parameterised SQL only (no string-built queries), escape all output (EJS `<%= %>`, never `<%- %>` on user data), validate every input server-side.
- No secrets in the repo. Provide `.env.example`. `.gitignore` must exclude `.env`, `data/`, `node_modules/`.
- Behind SiteGround's proxy: set `app.set('trust proxy', 1)`.

## 10. Routes (sketch)

```
GET  /login            POST /login       POST /logout
GET  /                 (dishes list)
GET  /dishes/new       POST /dishes      GET /dishes/:id      POST /dishes/:id     POST /dishes/:id/delete
GET  /ingredients      POST /ingredients POST /ingredients/:id   POST /ingredients/:id/delete
GET  /import           POST /import/preview     GET /import/:batchId     POST /import/:batchId/commit     GET /import/:batchId/errors.csv
GET  /import/template.csv        GET /export/ingredients.csv     GET /export/dishes.csv     GET /export/backup
GET  /delivery         GET /settings     POST /settings
GET  /healthz          (unauthenticated, returns 200 "ok" — for deploy checks)
```

## 11. Seed data and tests

- `npm run seed` loads the two spreadsheet examples (Dish A and the house wine) so the app is never empty on first run.
- Unit tests for section 6 (all vectors), unit conversion, CSV parsing/validation (BOM, £ signs, bad rows, aliases, VAT conversion), and one end-to-end import test against a temp database.
- `npm test` must pass before every commit.

## 12. Deployment (SiteGround Node.js project, from GitHub)

I have NOT verified SiteGround's current Node.js requirements. Before writing deploy config, read SiteGround's official Node.js documentation and confirm: supported Node versions, how the start command and port are set, which environment variables they inject, how deploys from GitHub work, and — critically — WHERE persistent files live and whether files outside the repo survive redeploys. Summarise your findings in `DEPLOY.md`.

Design now for what we know we need:
- `PORT` from env; start script is `node server.js` (no build step).
- Database path from `DATA_DIR` (default `./data`). Production must point this at a location that survives redeploys; if SiteGround can't guarantee that, STOP and propose the MySQL alternative via the `src/db/` module rather than shipping a database that gets wiped.
- Nightly automatic backup of the database file to a second location, keep the last 14, plus the manual backup download.
- `/healthz` for checking a deploy worked; log to stdout; never log secrets or full CSV contents.
- `DEPLOY.md` must contain a short copy-paste checklist: create the project, connect the GitHub repo, set env vars, first deploy, verify `/healthz`, set the password, rollback steps.

## 13. Milestones (stop and summarise after each; commit per milestone)

1. Scaffold, config, migrations, calculation engine with ALL section 6 tests green.
2. Ingredients CRUD + CSV import/export with preview, price history and tests.
3. Dishes list + dish editor with live calculation and recipe lines.
4. Delivery view, settings, backups/exports.
5. Auth, security hardening, README/DEPLOY.md, deploy to SiteGround and verify.

## 14. Working rules

- UK English, £, Europe/London time zone.
- Small, readable code with plain comments only where the reason isn't obvious. No cleverness.
- Commit small and often with clear messages. Never commit secrets or the database.
- If a requirement here conflicts with reality (library, hosting limit), say so, propose the smallest change, and log it in `DECISIONS.md`.
- Definition of done for each milestone: tests pass, `npm start` runs from a clean clone, no console errors, works at 360px wide.
