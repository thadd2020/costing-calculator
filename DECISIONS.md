# Decisions log

Calls made where the brief was silent or reality differed. Newest at the bottom.

## Milestone 1

1. **Spreadsheet location.** It was dropped in the repo root; moved to `docs/GP_Costing_Calculator.xlsx` as the brief describes. Its formulas match section 6 exactly.
2. **ES modules throughout** (`"type": "module"`). The calc engine has to be a plain ES module for the browser, so the server uses ESM too and imports the same file.
3. **Calc engine is one file**, `src/calc/calc.js`, served unchanged at `/static/calc.js`. One file means the browser needs no import map or extra requests, and there is truly one source of truth (a test checks the served bytes equal the file).
4. **Invalid recipe line makes the whole dish cost "n/a"**, with the reason listed (e.g. "Flour is bought by weight; use g or kg"). Skipping the bad line would understate cost and overstate GP, which is the dangerous direction.
5. **A dish with no recipe lines** costs £0.00 (valid), so GP is 100% and markup is n/a. The UI will flag "no ingredients yet" rather than hide it.
6. **Status when there's no alert threshold** falls back to "Under target" for anything below target. With no price, status is "n/a".
7. **Price to hold target** on the delivery screen is still calculated when a dish has no menu price (it only needs cost); the delivery price itself is n/a.
8. **Rounding.** `round_up_to_pence` takes 0, 5, 10 or 50. The inc-VAT suggested price is rounded up and the ex-VAT price recalculated from it. A 1e-9 tolerance stops float noise (19.0800000001) bumping an exact price up a step. Property test confirms GP >= target for every step.
9. **No dotenv.** Node's built-in `process.loadEnvFile()` reads a local `.env`; real environment variables still win.
10. **Node version.** `engines: >=22` (better-sqlite3 13 needs Node 22+); developed on Node 24 (`.nvmrc`). SiteGround's public docs say you can choose a Node version but don't list which ones. **Confirmed:** Node 22 is selected in Site Tools and works (see DEPLOY.md).
11. **Express 5** (current major). Its async error handling removes the need for wrapper helpers.
12. **Database file** is `${DATA_DIR}/gp-costing.db`. `busy_timeout` set to 5 s so the nightly backup can't make a request fail with SQLITE_BUSY.
13. **Extra indexes** on `dish_ingredients(dish_id)`, `dish_ingredients(ingredient_id)` and `price_history(ingredient_id, changed_at)` for the "used in N dishes" and "last price change" lookups. Same tables and columns as the brief otherwise.
14. **Test command** uses a glob (`node --test "test/**/*.test.js"`) because Node 24 no longer accepts a bare directory argument.

## Milestone 1b: MySQL in production (15 Oct 2026)

15. **SQLite can't live on SiteGround.** Tested on the live project: every deploy is built into a new folder under `public_html/.nodeapp/` (`1234567890-origin`, `1792072990-r4o9zr`, ...), with a `latest` link pointing at the newest. `./data` therefore starts empty on every deploy, and the home folder is not writable by the app. Following CLAUDE.md section 12, production now uses **the MySQL database that comes with the SiteGround project**. The owner agreed.
16. **Two drivers, one interface.** `src/db/sqlite.js` (better-sqlite3) and `src/db/mysql.js` (mysql2) both expose async `all / get / run / exec / transaction / close`. `DB_CLIENT=mysql` selects MySQL; otherwise SQLite in `DATA_DIR`. SQLite stays for local development and fast tests, so `npm install && npm start` still needs no database server. The whole data layer is now async (it had to be for MySQL).
17. **New dependency: `mysql2`.** The standard, maintained MySQL client for Node, with promise support built in.
18. **Portable SQL only** in `src/db/index.js`: `?` placeholders, backticks for the reserved word `key` (SQLite accepts them too), update-then-insert instead of dialect-specific upserts, `LOWER()` for case-insensitive ordering. Schema differences live only in the two migration folders, `migrations/sqlite/` and `migrations/mysql/`, which must be kept in step (the tests run the same assertions on both).
19. **Case-insensitive ingredient uniqueness on MySQL** comes from the default utf8mb4 collation (case- and accent-insensitive), not a `lower()` functional index. That works on MySQL 8 and MariaDB. Side effect: "Jalapeño" and "Jalapeno" from the same supplier count as the same ingredient, which is what you'd want.
20. **TEXT columns that need a default or an index are VARCHAR on MySQL** (name 200, supplier 200, category 100, notes 2000). The import payload is LONGTEXT (5,000 rows of JSON can exceed 64 KB).
21. **SQLite access is serialised behind a lock** so an awaiting transaction can't have another request's statements slip into it on the shared connection.
22. **mysql2 `query()` rather than `execute()`.** Both are parameterised. `execute()` (server-side prepared statements) has known problems with `LIMIT ?` on MySQL 8.0.22+.
23. **MySQL migrations aren't atomic** (DDL auto-commits). Back up before any deploy that adds a migration; DEPLOY.md says so.
24. **Production guard:** with `NODE_ENV=production` the server refuses to start unless `DB_CLIENT=mysql`, so a misconfigured deploy fails loudly instead of quietly using a database that the next deploy wipes.
25. **Backups (affects milestone 4):** with MySQL there's no database file to copy, and nowhere writable outside the deploy folder. Plan: the manual "backup" download becomes an app-generated export (SQL or JSON) of all tables, and the "second location" nightly copy is SiteGround's own daily backups (Site Tools > Security > Backups). To be confirmed in milestone 4.
26. **Tests against MySQL:** `TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:33306 npm test` runs the database tests on both engines, each in a throwaway database. Without it, only SQLite runs. Locally a `mysql:8.0` Docker container is used.

## Milestones 2-5 (15 Oct 2026)

27. **Login moved forward into milestone 2** (owner agreed). Every push auto-deploys, so no screen with cost data went live without it.
28. **Sessions are stored in the database** (`sessions` table, custom express-session store), so a restart or deploy doesn't log the owner out. Anonymous sessions (login page only) last 1 hour; logged-in sessions 14 days from login.
29. **Change password from Settings** stores a bcrypt hash in the settings table, which takes priority over `ADMIN_PASSWORD_HASH`. The env var can't be changed from inside the app, and the brief asks for a change-password screen. Reset steps are in DEPLOY.md. Changing the password logs out all other devices.
30. **Development password** is `password` when `ADMIN_PASSWORD_HASH` isn't set, so `npm start` works from a clean clone. Production refuses to start without the hash, a 32+ character `SESSION_SECRET`, and MySQL.
31. **CSRF:** one random token per session, in a hidden `_csrf` field (or `x-csrf-token` header), compared in constant time. The CSV upload checks it after multer has parsed the multipart body.
32. **CSP:** `default-src 'self'` with no inline scripts or styles. Data for the live editor is passed in an HTML-escaped `data-json` attribute rather than an inline script.
33. **No web fonts.** System fonts only; numbers use a DIN-style condensed face where installed (Bahnschrift on Windows, DIN Alternate on Apple). That avoids third-party requests from a page full of commercially sensitive data, and CSP stays `'self'`.
34. **Recipe lines name their ingredient by label** ("Plain flour (Brakes)"), picked from a searchable `<datalist>`. The server resolves the label, so the editor also works without JavaScript and a stale hidden id can't silently win over what was typed.
35. **Import counts:** besides new / price changed / unchanged / rejected, the preview shows **other details changed** (pack size, waste, category or VAT changed, price the same). Those rows are updated but don't write price history.
36. **Import matching keeps the saved spelling** of name and supplier; a difference only in capitals is not a change.
37. **New ingredients get a first price_history row** (source manual or import), so "price set on" and history always have a starting point.
38. **Inc-VAT import row with a blank vat_rate is rejected**, not guessed as 20%, because many food items are zero-rated (CLAUDE.md section 6 VAT notes).
39. **VAT rates on ingredients are 0 or 20%** as in the brief. The per-dish sales VAT override accepts any rate from 0 to 99% (e.g. zero-rated cold takeaway).
40. **Delimiter detection:** comma, semicolon or tab, whichever appears most in the header line. Covers European-locale spreadsheet exports.
41. **Duplicate rows within one file:** the first wins and later ones are reported as rejected.
42. **The commit re-plans against current ingredients** in the same transaction, so edits made between preview and confirm are respected, and a batch can only be committed once (`status = 'previewed'` guard).
43. **Dish impact after import** is recorded at commit time: GP before and after for every dish using a re-priced ingredient. Dishes now below the alert threshold are listed first.
44. **Export escaping:** text cells starting with `= + - @`, tab or CR get a leading `'`. The importer strips that quote again, so export → edit → re-import is a no-op (tested). Numbers are never escaped.
45. **Waste and VAT in the ingredients export** are written as percentages ("5%", "20%") so they read naturally in a spreadsheet; prices are exported ex-VAT at full precision.
46. **Backups:** nightly JSON snapshots in a `backups` table (newest 14), checked hourly and taken when the last one is over ~23 hours old (so also shortly after a deploy if overdue). The full backup download is the same JSON. `npm run restore` loads one. The password hash is never included. SiteGround's daily backups are the copy kept in a second location. The brief asked for a backup *file*, and that's impossible here (no persistent writable folder).
47. **Seed on first run:** a brand-new, empty database gets the two spreadsheet examples once (flagged in settings), so deleting them later doesn't bring them back. `npm run seed` does the same on demand.
48. **"Use this price" rounds up to the next penny** (or the configured 5p/10p/50p step), so filling in the suggested price never lands a fraction below target.
49. **Dish list filter "below target only"** includes both "Under target" and "Below alert".
50. **Delivery "Price"** follows formula 8 exactly: it keeps the dine-in GP in pounds after commission and packaging. "For target" is the price that keeps the target GP %. Both are labelled on screen.
51. **Inactive dishes** are hidden from the list by default (toggle "Show inactive") and left out of the delivery screen, but included in exports.
52. **Not done (deliberately):** an in-app restore upload (too risky for a one-click action; use `npm run restore`), rejecting unknown form fields (only known fields are ever read), and a per-request audit log.

## Test and debug pass (15 Oct 2026, branch `test/debug-pass`)

53. **Test runner stays `node:test`** (brief section 2), not Vitest or Jest. The existing fetch-based client in `test/helpers/client.js` already does what supertest would (cookies, CSRF, forms, uploads), so supertest wasn't added.
54. **New devDependency: `playwright`** (Microsoft, actively maintained) for the end-to-end UI suite in `test/e2e/` (`npm run test:e2e`, desktop and 360px). It is never imported by the app. Its browsers are not downloaded on `npm install`; locally run `npx playwright install chromium` once. On SiteGround, `npm install` will still fetch the package itself (a few MB) unless dev dependencies are omitted; that's harmless.
55. **GP status uses a 1e-9 tolerance** at the target and alert lines, so float noise (0.6999999999999998) can't show a dish priced exactly on target as "Under target".
56. **A comma in a number is only a thousands separator** ("1,234.50"). "12,50", "0,500" or "1,2,3" are refused with a message instead of being read as 1250, 500 or 123. UK users type a decimal point; anyone with a European export gets an error rather than a price 100 times too high.
57. **CSV files that aren't UTF-8 are read as Windows-1252** (Excel's plain "CSV (Comma delimited)"), unless the file already contains valid UTF-8 accents or symbols, in which case one stray byte doesn't re-decode the whole file.
58. **A blank optional cell in an import (category, vat_rate, waste_pct) leaves an existing ingredient's saved value alone**, whether the column is missing or the cell is empty. New ingredients still get the defaults (blank, 0%, 5%). Before, a price-only supplier list reset every matched ingredient's VAT and waste. To clear a category, edit the ingredient.
59. **Repeated form fields are refused (400)** for everything except recipe lines (`line_ingredient`, `line_quantity`, `line_unit`). Express turns a repeated field into an array, and `String(['1','000'])` is "1,000".
60. **Post-import dish impact** now covers ingredients whose pack size, pack unit or waste changed, not only their price.
