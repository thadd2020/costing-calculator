// Starts the app on a random port and gives a tiny browser-like client: keeps the session
// cookie, remembers the latest CSRF token, and posts urlencoded forms.
import { createApp } from '../../src/app.js';

export const TEST_CONFIG = {
  env: 'test', isProduction: false, sessionSecret: 'test-secret-test-secret-test-secret!!',
  adminPasswordHash: '', loginRateLimit: 1000,
};

export async function startApp(db, config = {}) {
  const app = createApp({ db, config: { ...TEST_CONFIG, ...config } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    client: () => new Client(base),
    close: () => new Promise((resolve) => { app.locals.sessionStore.close(); server.close(resolve); }),
  };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }

  async request(path, options = {}) {
    const res = await fetch(this.base + path, {
      redirect: 'manual', ...options,
      headers: { ...(options.headers || {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const body = type.includes('text/html') || type.includes('text/plain') || type.includes('csv') || type.includes('json') || type.includes('javascript')
      ? await res.text() : await res.arrayBuffer();
    if (typeof body === 'string') {
      const m = body.match(/name="csrf-token" content="([^"]+)"/);
      if (m) this.csrf = m[1];
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, body };
  }

  get(path) { return this.request(path); }

  // Follows one redirect, like a browser after a form post.
  async post(path, fields = {}, { csrf = true, follow = false } = {}) {
    const form = new URLSearchParams();
    if (csrf) form.append('_csrf', this.csrf);
    for (const [k, v] of Object.entries(fields)) {
      for (const one of Array.isArray(v) ? v : [v]) form.append(k, String(one));
    }
    const res = await this.request(path, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return follow && res.location ? this.get(res.location) : res;
  }

  async upload(path, filename, content, { csrf = true } = {}) {
    const form = new FormData();
    if (csrf) form.append('_csrf', this.csrf);
    form.append('file', new Blob([content], { type: 'text/csv' }), filename);
    return this.request(path, { method: 'POST', body: form });
  }

  async login(password = 'password') {
    await this.get('/login');
    const res = await this.post('/login', { password });
    await this.get('/'); // pick up a fresh CSRF token for the new session
    return res;
  }
}
