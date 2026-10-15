// Deployment-readiness checks for SiteGround (CLAUDE.md section 12, DEPLOY.md).
// Everything runs locally with dummy values: no real .env, no live site.
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, listBackups } from '../src/db/index.js';
import { backupIfDue, startBackupSchedule, KEEP_BACKUPS } from '../src/backup.js';
import { createApp } from '../src/app.js';
import { startApp, TEST_CONFIG } from './helpers/client.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Dummy values only. If any of these ever shows up in output, a secret has leaked into logs.
const DUMMY_SECRET = 'dummy-session-secret-0123456789abcdef-XYZZY';
const DUMMY_SHORT_SECRET = 'shortsecretQWERTY';
const DUMMY_HASH = '$2b$10$dummyhashdummyhashdummyhashdummyhashdummyhashdummyha';
const DUMMY_DB_PASSWORD = 'dummy-db-password-PLUGH';
const SECRETS = [DUMMY_SECRET, DUMMY_SHORT_SECRET, DUMMY_HASH, DUMMY_DB_PASSWORD];

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-deploy-audit-'));

// A clean environment, so nothing from the developer's shell (DB_*, NODE_ENV...) leaks in.
// The child runs in an empty temp folder so config.js finds no .env file.
function cleanEnv(extra) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Runs `node server.js` and resolves when it exits (or kills it after `timeout` ms).
function runServer(env, { timeout = 15000, cwd = tmpDir() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { cwd, env: cleanEnv(env) });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
  });
}

function assertNoSecrets(out) {
  for (const s of SECRETS) assert.ok(!out.includes(s), `output must not contain a secret: ${s.slice(0, 6)}...`);
}

describe('package and start command', () => {
  test('start script is `node server.js`, no build step or install hooks', () => {
    assert.equal(pkg.scripts.start, 'node server.js');
    for (const hook of ['build', 'prestart', 'poststart', 'preinstall', 'install', 'postinstall', 'prepare']) {
      assert.equal(pkg.scripts[hook], undefined, `unexpected "${hook}" script`);
    }
    assert.equal(pkg.type, 'module');
  });

  test('engines allow Node 22 (what SiteGround runs) and .nvmrc satisfies engines', () => {
    const min = Number(/>=\s*(\d+)/.exec(pkg.engines.node)[1]);
    assert.ok(min <= 22, 'SiteGround project is on Node 22; engines must not require more');
    const nvmrc = Number(read('.nvmrc').trim().replace(/^v/, '').split('.')[0]);
    assert.ok(nvmrc >= min, '.nvmrc below engines');
  });

  test('package-lock.json is in step with package.json', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const top = lock.packages[''];
    assert.deepEqual(top.dependencies, pkg.dependencies);
    assert.deepEqual(top.devDependencies || {}, pkg.devDependencies || {});
    assert.deepEqual(top.engines, pkg.engines);
  });
});

describe('runtime imports only use production dependencies', () => {
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(m?js)$/.test(e.name) ? [p] : [];
    });
  }
  const files = [SERVER, ...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
  const specifiers = new Map(); // package name -> files
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const m of src.matchAll(re)) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!specifiers.has(name)) specifiers.set(name, []);
      specifiers.get(name).push(path.relative(ROOT, file));
    }
  }

  test('every bare import is in "dependencies" (never devDependencies)', () => {
    assert.ok(specifiers.size > 0);
    for (const [name, where] of specifiers) {
      assert.ok(pkg.dependencies[name], `${name} (used in ${where.join(', ')}) is not in dependencies`);
      assert.ok(!pkg.devDependencies?.[name], `${name} is a devDependency but used at runtime`);
    }
  });

  test('no dev-only tool (e.g. playwright) is imported by the app', () => {
    for (const name of Object.keys(pkg.devDependencies || {})) {
      assert.ok(!specifiers.has(name), `${name} imported at runtime`);
    }
  });

  test('every dependency is actually used', () => {
    // ejs is loaded by Express itself through app.set('view engine', 'ejs').
    const indirect = new Set(['ejs']);
    for (const name of Object.keys(pkg.dependencies)) {
      if (!indirect.has(name)) assert.ok(specifiers.has(name), `${name} is never imported`);
    }
    assert.match(read('src/app.js'), /set\('view engine', 'ejs'\)/);
  });

  test('better-sqlite3 (native) is only loaded when SQLite is used', {
    todo: 'FINDING: src/db/sqlite.js imports better-sqlite3 statically via src/db/index.js, so production (MySQL) still needs the native build',
  }, () => {
    const index = read('src/db/index.js');
    assert.ok(!/^import .* from '\.\/sqlite\.js'/m.test(index), 'sqlite driver imported eagerly');
  });
});

describe('config from environment', () => {
  // Prints the parsed config from a child process with a controlled env.
  function configWith(env) {
    const code = `const { config } = await import(${JSON.stringify(path.join(ROOT, 'src/config.js'))}); console.log(JSON.stringify(config));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: tmpDir(), env: cleanEnv(env) });
    return JSON.parse(out);
  }

  test('PORT comes from env, default 3000', () => {
    assert.equal(configWith({ PORT: '4321' }).port, 4321);
    assert.equal(configWith({}).port, 3000);
    assert.equal(configWith({ PORT: 'nonsense' }).port, 3000);
  });

  test('DATA_DIR is resolved to an absolute path; SQLite file lives inside it unless DB_CLIENT=mysql', () => {
    const dir = tmpDir();
    const c = configWith({ DATA_DIR: dir });
    assert.equal(c.dataDir, dir);
    assert.deepEqual(c.db, { client: 'sqlite', file: path.join(dir, 'gp-costing.db') });
    assert.ok(path.isAbsolute(configWith({}).dataDir));
    const m = configWith({ DB_CLIENT: 'mysql', DB_HOST: 'db.local', DB_PORT: '3307', DB_USER: 'u', DB_PASSWORD: DUMMY_DB_PASSWORD, DB_NAME: 'n' });
    assert.equal(m.db.client, 'mysql');
    assert.equal(m.db.port, 3307);
  });

  test('.env.example documents every env var config.js reads', () => {
    const used = new Set([...read('src/config.js').matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]));
    const example = read('.env.example');
    for (const name of used) assert.match(example, new RegExp(`^#?\\s*${name}=`, 'm'), `${name} missing from .env.example`);
  });
});

describe('production start-up guard (spawns node server.js)', () => {
  const prod = { NODE_ENV: 'production', PORT: '0' };

  test('refuses to start with nothing set, and says what is missing', async () => {
    const { code, out } = await runServer(prod);
    assert.notEqual(code, 0);
    assert.match(out, /Refusing to start in production/);
    assert.match(out, /DB_CLIENT=mysql/);
    assert.match(out, /SESSION_SECRET/);
    assert.match(out, /ADMIN_PASSWORD_HASH/);
  });

  test('refuses SQLite in production even with good secrets', async () => {
    const { code, out } = await runServer({ ...prod, SESSION_SECRET: DUMMY_SECRET, ADMIN_PASSWORD_HASH: DUMMY_HASH });
    assert.notEqual(code, 0);
    assert.match(out, /DB_CLIENT=mysql/);
    assert.doesNotMatch(out, /SESSION_SECRET \(|ADMIN_PASSWORD_HASH \(/);
    assertNoSecrets(out);
  });

  test('refuses a short SESSION_SECRET without printing it', async () => {
    const { code, out } = await runServer({ ...prod, DB_CLIENT: 'mysql', DB_PASSWORD: DUMMY_DB_PASSWORD, SESSION_SECRET: DUMMY_SHORT_SECRET, ADMIN_PASSWORD_HASH: DUMMY_HASH });
    assert.notEqual(code, 0);
    assert.match(out, /SESSION_SECRET \(at least 32/);
    assertNoSecrets(out);
  });

  test('refuses a missing ADMIN_PASSWORD_HASH', async () => {
    const { code, out } = await runServer({ ...prod, DB_CLIENT: 'mysql', SESSION_SECRET: DUMMY_SECRET });
    assert.notEqual(code, 0);
    assert.match(out, /ADMIN_PASSWORD_HASH/);
    assertNoSecrets(out);
  });

  test('with good config but MySQL unreachable: exits non-zero, no secrets in the error', async () => {
    const closed = await freePort(); // nothing listens here
    const { code, signal, out } = await runServer({
      ...prod, DB_CLIENT: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(closed), DB_USER: 'dummy_user', DB_NAME: 'dummy_db',
      DB_PASSWORD: DUMMY_DB_PASSWORD, SESSION_SECRET: DUMMY_SECRET, ADMIN_PASSWORD_HASH: DUMMY_HASH,
    });
    assert.equal(signal, null, 'should exit by itself, not hang');
    assert.notEqual(code, 0);
    assert.match(out, /ECONNREFUSED/);
    assertNoSecrets(out);
  });
});

describe('development server lifecycle (spawns node server.js)', () => {
  test('starts on PORT with SQLite in DATA_DIR, serves /healthz, logs no secrets, exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const dataDir = tmpDir();
    const child = spawn(process.execPath, [SERVER], {
      cwd: tmpDir(),
      env: cleanEnv({ PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: DUMMY_SECRET, ADMIN_PASSWORD_HASH: DUMMY_HASH }),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      while (!out.includes('listening on port')) {
        if (child.exitCode !== null) assert.fail(`server exited early:\n${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(out, new RegExp(`listening on port ${port}`));
      assert.ok(fs.existsSync(path.join(dataDir, 'gp-costing.db')), 'SQLite file created in DATA_DIR');

      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
      const page = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      assert.equal(page.status, 302, 'dishes need login');

      child.kill('SIGTERM');
      const { code, signal } = await exited;
      assert.equal(signal, null);
      assert.equal(code, 0, `graceful exit expected:\n${out}`);
      assert.match(out, /SIGTERM received, shutting down/);
      assertNoSecrets(out);
    } finally {
      clearTimeout(killer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('app wiring', () => {
  test('trust proxy is 1 (behind SiteGround proxy)', async () => {
    const db = openDb({ client: 'sqlite', file: ':memory:' });
    await migrate(db);
    const app = createApp({ db, config: TEST_CONFIG });
    assert.equal(app.get('trust proxy'), 1);
    app.locals.sessionStore.close();
    await db.close();
  });

  test('/healthz checks the database: 500 (not "ok") when the DB is down, without leaking details', async () => {
    const real = openDb({ client: 'sqlite', file: ':memory:' });
    await migrate(real);
    let down = false;
    const db = { ...real, get: (sql, p) => (down ? Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3306')) : real.get(sql, p)) };
    const errors = mock.method(console, 'error', () => {});
    const app = await startApp(db);
    try {
      assert.equal((await app.client().get('/healthz')).status, 200);
      down = true;
      const res = await app.client().get('/healthz');
      assert.equal(res.status, 500);
      assert.notEqual(res.body, 'ok');
      assert.ok(!String(res.body).includes('ECONNREFUSED'), 'error detail must not reach the browser');
      assert.ok(errors.mock.calls.some((c) => String(c.arguments.join(' ')).includes('/healthz failed')));
    } finally {
      errors.mock.restore();
      await app.close();
      await real.close();
    }
  });
});

describe('migrations', () => {
  const dirs = ['sqlite', 'mysql'].map((d) => path.join(ROOT, 'src/db/migrations', d));
  const tablesIn = (dir) => fs.readdirSync(dir).flatMap((f) =>
    [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?/gi)].map((m) => m[1])).sort();

  test('sqlite and mysql migration sets are in step', () => {
    const [s, m] = dirs.map((d) => fs.readdirSync(d).filter((f) => f.endsWith('.sql')).sort());
    assert.deepEqual(s, m);
    assert.deepEqual(tablesIn(dirs[0]), tablesIn(dirs[1]));
  });

  test('runner is idempotent and tracked in schema_version', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'gp.db');
    let db = openDb({ client: 'sqlite', file });
    const first = await migrate(db);
    assert.ok(first.length >= 3);
    assert.deepEqual(await migrate(db), []);
    await db.close();
    db = openDb({ client: 'sqlite', file }); // as after a restart
    assert.deepEqual(await migrate(db), []);
    const rows = await db.all('SELECT version, name FROM schema_version ORDER BY version');
    assert.deepEqual(rows.map((r) => r.name), first);
    await db.close();
  });
});

describe('nightly backups', () => {
  test(`keeps only the newest ${KEEP_BACKUPS} and skips when not due`, async () => {
    const db = openDb({ client: 'sqlite', file: ':memory:' });
    await migrate(db);
    const log = mock.method(console, 'log', () => {});
    try {
      assert.equal(await backupIfDue(db), true);
      assert.equal(await backupIfDue(db), false, 'not due again straight away');
      for (let i = 1; i <= 20; i++) assert.equal(await backupIfDue(db, Date.now() + i * 2 * 86400000), true);
      assert.equal((await listBackups(db)).length, KEEP_BACKUPS);
    } finally {
      log.mock.restore();
      await db.close();
    }
  });

  test('scheduler survives a database outage (logs, does not throw)', async () => {
    const broken = new Proxy({}, { get: (_, k) => (k === 'client' ? 'mysql' : () => Promise.reject(new Error('DB down'))) });
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const errors = mock.method(console, 'error', () => {});
    try {
      const stop = startBackupSchedule(broken);
      mock.timers.tick(60 * 1000);
      mock.timers.tick(3600 * 1000);
      mock.timers.reset(); // real timers again so the rejection can settle
      await new Promise((r) => setImmediate(r));
      assert.ok(errors.mock.calls.length >= 1);
      assert.match(String(errors.mock.calls[0].arguments.join(' ')), /Nightly backup failed: DB down/);
      stop();
    } finally {
      mock.timers.reset();
      errors.mock.restore();
    }
  });
});

describe('repo hygiene and docs', () => {
  test('.gitignore covers .env, data/, node_modules/', () => {
    const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
    for (const p of ['.env', 'data/', 'node_modules/']) assert.ok(lines.includes(p), `${p} not ignored`);
  });

  test('no .env, database or data/ file is tracked by git', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    const bad = tracked.filter((f) => /(^|\/)\.env$|\.db(-wal|-shm)?$|^data\//.test(f));
    assert.deepEqual(bad, []);
  });

  test('logging never references secrets, the password hash or request bodies', () => {
    const files = [SERVER, ...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
      .filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'src', f))];
    for (const f of files) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const at = line.search(/console\.(log|error|warn|info)\(/);
        if (at < 0) continue;
        // Only what is passed to console (the guard before it may test the value).
        assert.doesNotMatch(line.slice(at), /sessionSecret|adminPasswordHash|DB_PASSWORD|\.password\b|req\.body|req\.file|buffer/i, `${path.relative(ROOT, f)}: ${line.trim()}`);
      }
    }
  });

  test('DEPLOY.md has the copy-paste checklist the brief asks for', () => {
    const d = read('DEPLOY.md');
    for (const [what, re] of [
      ['create the project', /Create the project/i],
      ['connect GitHub', /GitHub/],
      ['env vars', /Environment variables/i],
      ['NODE_ENV=production', /`NODE_ENV`\s*\|\s*`production`/],
      ['DB_CLIENT=mysql', /`DB_CLIENT`\s*\|\s*`mysql`/],
      ['SESSION_SECRET', /SESSION_SECRET/],
      ['first deploy / push', /git push/],
      ['verify /healthz', /\/healthz/],
      ['set the password', /npm run set-password/],
      ['rollback', /## .*Rollback|### Rollback/],
    ]) assert.match(d, re, `DEPLOY.md missing: ${what}`);
  });
});
