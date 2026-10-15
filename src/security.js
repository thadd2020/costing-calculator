// CSRF protection, login checks and the flash-message helper.
import crypto from 'node:crypto';

// One random token per session, sent back in a hidden _csrf field (forms) or an
// x-csrf-token header (fetch). Compared in constant time.
export function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

export function verifyCsrf(req, res, next) {
  const sent = req.body?._csrf || req.get('x-csrf-token') || '';
  const expected = req.session?.csrf || '';
  const ok = typeof sent === 'string' && expected && sent.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (ok) return next();
  res.status(403).render('error', {
    title: 'Form expired',
    message: 'This form had expired or came from somewhere else, so nothing was saved. Go back, reload the page and try again.',
  });
}

// Applies CSRF to every state-changing request except the CSV upload, which checks it
// after multer has parsed the multipart body (see routes/import.js). Any other multipart
// request has no parsed body, so verifyCsrf refuses it.
export function csrfUnlessMultipart(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.method === 'POST' && req.path === '/import/preview' && req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

// Only same-site paths: "/dishes/3" yes; "//evil.example" or "/\evil.example" (which browsers
// treat as "//") no.
export function isSafeReturnPath(value) {
  return typeof value === 'string' && /^\/(?![\/\\])/.test(value) && !/[\u0000-\u001f\\]/.test(value);
}

export function requireLogin(req, res, next) {
  if (req.session?.loggedIn) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

// flash(req, 'Saved') stores a message shown once on the next page.
export function flash(req, message, kind = 'ok') {
  req.session.flash = { message, kind };
}
