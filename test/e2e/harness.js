// Browser test harness: starts a real server (node server.js) on a free port with a fresh
// temporary SQLite database, launches headless Chromium, and provides page-level checks
// (console/page errors, failed requests, CSP violations, horizontal scroll, labels,
// inputmode on numeric fields, £x.xx money, tap-target sizes).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const VIEWPORTS = {
  desktop: { name: 'desktop', viewport: { width: 1280, height: 800 } },
  mobile: { name: 'mobile', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

// Screenshots of failures go here.
export const SHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-e2e-shots-'));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Spawns server.js from a temp cwd (so no local .env is ever loaded) with a temp DATA_DIR.
export async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-e2e-data-'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: 'development', PORT: String(port), DATA_DIR: dataDir,
    SESSION_SECRET: 'e2e-session-secret-e2e-session-secret-0123',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start:\n${log}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    log: () => log,
    stop: async () => {
      if (child.exitCode === null) {
        const done = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// One browser context per viewport, with every problem the page reports collected in
// `events` so each test can assert on what happened since its last check.
export async function openSession(vp, base) {
  const browser = await chromium.launch({ headless: true });
  const { name, ...options } = vp;
  const context = await browser.newContext({ ...options, baseURL: base, acceptDownloads: true, locale: 'en-GB', timezoneId: 'Europe/London' });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const session = {
    name, browser, context, page, base,
    events: [],
    dialogs: [],
    dialogAnswer: true, // accept confirm() by default; set false to dismiss
    mark() { session.events = []; },
  };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chrome logs every 4xx/5xx document load to the console; keep the status so intended ones can be allowed.
    const m = msg.text().match(/^Failed to load resource: the server responded with a status of (\d{3})/);
    session.events.push({ kind: 'console', status: m ? Number(m[1]) : undefined, text: msg.text(), url: page.url() });
  });
  page.on('pageerror', (err) => session.events.push({ kind: 'pageerror', text: err.message, url: page.url() }));
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText || '';
    // Downloads started by navigation show up as aborted; that's expected.
    if (/ERR_ABORTED/.test(failure)) return;
    session.events.push({ kind: 'requestfailed', text: `${req.method()} ${req.url()} ${failure}`, url: page.url() });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) session.events.push({ kind: 'http', status: res.status(), text: `${res.request().method()} ${res.url()} -> ${res.status()}`, url: page.url() });
  });
  page.on('dialog', async (dialog) => {
    session.dialogs.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'beforeunload' || session.dialogAnswer) await dialog.accept();
    else await dialog.dismiss();
  });
  session.close = () => browser.close();
  return session;
}

export async function screenshot(session, label) {
  const file = path.join(SHOT_DIR, `${session.name}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  try { await session.page.screenshot({ path: file, fullPage: true }); } catch { return null; }
  return file;
}

// Runs fn; on failure saves a screenshot and adds its path to the error message.
export async function withShot(session, label, fn) {
  try {
    return await fn();
  } catch (err) {
    const file = await screenshot(session, label);
    if (file) err.message += `\n  screenshot: ${file}`;
    throw err;
  }
}

// Non-fatal observations (tap targets etc.) are collected here and printed at the end.
export const notes = [];
export function note(session, text) {
  const line = `[${session.name}] ${text}`;
  if (!notes.includes(line)) notes.push(line);
}

// Collects every problem on the current page. Returns a list of strings (empty = fine).
// allowStatus: HTTP statuses that are intended for this step (e.g. 401 wrong password, 422 validation).
export async function auditPage(session, { allowStatus = [] } = {}) {
  const { page } = session;
  const problems = [];
  for (const e of session.events) {
    if ((e.kind === 'http' || e.kind === 'console') && e.status && allowStatus.includes(e.status)) continue;
    problems.push(`${e.kind}: ${e.text}`);
  }
  const csp = await page.evaluate(() => window.__csp || []);
  for (const c of csp) problems.push(`CSP violation: ${c}`);

  const facts = await page.evaluate(() => {
    const visible = (el) => {
      if (!el.checkVisibility({ opacityProperty: false, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const reallyVisible = (el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.clip !== 'rect(0px, 0px, 0px, 0px)';
    };
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.name ? `[name=${el.name}]` : ''}`;
    const out = { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, unlabelled: [], hiddenLabels: [], noInputmode: [], small: [], badMoney: [] };

    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el.type === 'hidden' || el.type === 'submit' || el.hidden || el.closest('[hidden]')) continue;
      // Radio/checkbox inputs are often visually replaced; judge them by their wrapping label.
      const box = el.type === 'radio' || el.type === 'checkbox' ? (el.closest('label') || el) : el;
      if (!visible(box)) continue;
      const labels = [...(el.labels || [])];
      const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (!labels.length && !aria) out.unlabelled.push(describe(el));
      else if (labels.length && !labels.some((l) => reallyVisible(l) && l.textContent.trim())) out.hiddenLabels.push(describe(el));
      // Numeric fields: anything whose name suggests a number or money.
      const numericName = /price|size|qty|quantity|portion|pct|percent|rate|gp|commission|packaging|waste/i.test(`${el.name} ${el.id}`);
      if (el.tagName === 'INPUT' && ['text', 'number', ''].includes(el.type) && numericName && !/name$/.test(el.name)) {
        const mode = el.getAttribute('inputmode');
        if (!['decimal', 'numeric'].includes(mode) && el.type !== 'number') out.noInputmode.push(describe(el));
      }
    }

    for (const el of document.querySelectorAll('button, a.button, .tabbar a, input[type=submit], summary, .chip-toggle, .dish-row')) {
      if (!visible(el) || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 40) out.small.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }

    // Money: every £ amount in visible text should look like £1,234.56.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const text = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && visible(n.parentElement) && !n.parentElement.closest('script,style,datalist,option')) text.push(n.textContent);
    }
    const all = text.join(' ');
    for (const m of all.matchAll(/£\s*[\d.,]+/g)) {
      const s = m[0].replace(/[.,]+$/, '');
      if (s === '£') continue; // a "£" prefix next to an input
      if (!/^£\d{1,3}(,\d{3})*\.\d{2}$/.test(s)) out.badMoney.push(s);
    }
    return out;
  });

  const isMobile = session.name === 'mobile';
  if (isMobile && facts.scrollWidth > 360) problems.push(`horizontal scroll: scrollWidth ${facts.scrollWidth} > 360`);
  if (!isMobile && facts.scrollWidth > facts.innerWidth) problems.push(`horizontal scroll: scrollWidth ${facts.scrollWidth} > ${facts.innerWidth}`);
  for (const u of facts.unlabelled) problems.push(`input without a label: ${u}`);
  for (const u of facts.noInputmode) problems.push(`numeric field without inputmode=decimal: ${u}`);
  for (const m of [...new Set(facts.badMoney)]) problems.push(`money not shown as £x.xx: "${m}"`);
  const where = new URL(page.url()).pathname;
  for (const h of facts.hiddenLabels) note(session, `${where}: ${h} has only a visually-hidden label (placeholder acts as visible label)`);
  if (isMobile) for (const s of facts.small) note(session, `${where}: tap target under 40px tall: ${s}`);
  session.mark();
  await page.evaluate(() => { window.__csp = []; });
  return problems;
}

// Asserts auditPage found nothing; screenshots on failure.
export async function assertCleanPage(session, label, assert, options = {}) {
  const problems = await auditPage(session, options);
  if (problems.length) {
    const file = await screenshot(session, `${label}-audit`);
    assert.fail(`${label} (${session.page.url()}):\n  - ${problems.join('\n  - ')}${file ? `\n  screenshot: ${file}` : ''}`);
  }
}

// Soft audits: check pages as a flow goes, then fail once at the end with everything found.
export function auditor(session, assert) {
  const found = [];
  return {
    async check(label, options = {}) {
      const problems = await auditPage(session, options);
      if (problems.length) {
        const file = await screenshot(session, `${label}-audit`);
        found.push(`${label} (${new URL(session.page.url()).pathname}):\n    - ${problems.join('\n    - ')}${file ? `\n    screenshot: ${file}` : ''}`);
      }
    },
    done() {
      if (found.length) assert.fail(`Page audit problems:\n  ${found.join('\n  ')}`);
    },
  };
}
