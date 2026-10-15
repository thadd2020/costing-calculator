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
