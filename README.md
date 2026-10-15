# GP Costing Calculator

Cost dishes and drinks, see gross profit live as you type, price to a target GP, and price a delivery menu after platform commission. Built for one UK restaurant owner, phone-first.

## Run locally

Needs Node.js 22 or newer (24 recommended).

```sh
npm install
npm start              # http://localhost:3000, password: password
npm test
```

With no `.env`, the app uses a SQLite file at `./data/gp-costing.db`, a temporary session secret, and the development password `password`. A brand-new database gets the two examples from the spreadsheet (Dish A and the house wine). Copy `.env.example` to `.env` to change anything.

| Command | What it does |
|---|---|
| `npm start` | Runs the app (migrations apply automatically) |
| `npm test` | All tests. Add `TEST_MYSQL_URL=...` to run the database and app tests on MySQL too |
| `npm run set-password` | Prints a bcrypt hash for `ADMIN_PASSWORD_HASH` |
| `npm run seed` | Adds the two spreadsheet examples |
| `npm run migrate` | Applies database migrations without starting the app |
| `npm run restore -- file.json` | Replaces all data with a backup file (asks first; keeps the password) |

To test against MySQL locally:

```sh
docker run -d --name gp-costing-mysql-test -e MYSQL_ROOT_PASSWORD=gp_test_pw -p 127.0.0.1:33306:3306 mysql:8.0
TEST_MYSQL_URL=mysql://root:gp_test_pw@127.0.0.1:33306 npm test
```

## Using it

- **Dishes** (home): every dish with true cost, menu price, GP % and a status dot: ✓ on target, ! under target, ✕ below the alert threshold. Search, filter and sort. Tap a dish to edit it.
- **Dish editor:** name, type, menu price (inc VAT), portions and ingredient lines. GP, status, suggested price and delivery prices update as you type. "Use this price" fills in the price that hits your target GP. Saving recalculates everything on the server.
- **Ingredients:** pack size, unit and price (ex VAT; tick "Includes VAT" to convert a receipt price), waste %, which dishes use it, and recent price changes. Bulk-load with **Import CSV**; download the template from the import page.
- **Delivery:** pick a channel to see each dish's delivery price, GP after commission and packaging, and the price that holds your target GP.
- **Settings:** target GPs, alert threshold, VAT, packaging, price rounding, delivery channels and password. **Export and backup** is linked from here.

## How the numbers work

All maths lives in `src/calc/calc.js` (CLAUDE.md section 6). It's pure functions with no I/O, and the browser loads the same file as `/static/calc.js`. Everything is calculated at full precision and only rounded for display. GP always uses ex-VAT prices. Markup is shown separately and labelled, because 70% GP is a 233% markup.

## Layout

```
server.js            start-up: config checks, migrations, seed, nightly backups
src/calc/calc.js     GP formulas (shared with the browser)
src/db/              ALL database access; sqlite.js and mysql.js drivers; migrations/<driver>/
src/import/          CSV import: parse.js (pure), plan.js (pure), service.js (preview/commit)
src/routes/          Express routes, one file per screen
src/costing.js       joins dishes + ingredients + settings and runs the calc engine
views/               EJS templates (escaped output only)
public/              styles.css and small browser scripts
test/                node:test tests
```

See `DEPLOY.md` for SiteGround, and `DECISIONS.md` for the judgement calls.
