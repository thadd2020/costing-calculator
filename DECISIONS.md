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
10. **Node version.** `engines: >=22` (better-sqlite3 13 needs Node 22+); developed on Node 24 (`.nvmrc`). SiteGround's public docs say you can choose a Node version but don't list which ones. **To confirm in Site Tools before milestone 5.** If only Node 20 is offered, pin better-sqlite3 to 12.x.
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
