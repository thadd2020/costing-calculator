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

Locally the app uses a SQLite file at `$DATA_DIR/gp-costing.db` (default `./data`). In production it uses MySQL (`DB_CLIENT=mysql` plus `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`). Migrations run automatically on start, or with `npm run migrate`.

To run the database tests against MySQL as well (e.g. a local `mysql:8.0` Docker container):

```sh
docker run -d --name gp-costing-mysql-test -e MYSQL_ROOT_PASSWORD=gp_test_pw -p 127.0.0.1:33306:3306 mysql:8.0
TEST_MYSQL_URL=mysql://root:gp_test_pw@127.0.0.1:33306 npm test
```

## Layout

- `src/calc/calc.js`: the GP formulas. Pure functions, used by the server and served to the browser as `/static/calc.js`.
- `src/db/`: all database access. One async interface with two drivers (`sqlite.js`, `mysql.js`) and a migrations folder for each.
- `test/`: `node:test` tests, including every test vector from the brief.

See `DECISIONS.md` for judgement calls and `DEPLOY.md` for SiteGround notes.
