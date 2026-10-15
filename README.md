# GP Costing Calculator

Cost dishes and drinks, see gross profit live, price to a target GP, and price a delivery menu after platform commission. Built for one UK restaurant owner, phone-first.

## Run locally

Needs Node.js 22 or newer (24 recommended).

```sh
npm install
cp .env.example .env   # optional for local use
npm start              # http://localhost:3000
npm test
```

The SQLite database is created at `$DATA_DIR/gp-costing.db` (default `./data`). Migrations run automatically on start, or with `npm run migrate`.

## Layout

- `src/calc/calc.js`: the GP formulas. Pure functions, used by the server and served to the browser as `/static/calc.js`.
- `src/db/`: all database access and numbered migrations.
- `test/`: `node:test` tests, including every test vector from the brief.

See `DECISIONS.md` for judgement calls and `DEPLOY.md` for SiteGround notes.
