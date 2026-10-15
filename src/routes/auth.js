import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { checkPassword } from '../auth.js';
import { isSafeReturnPath } from '../security.js';

export default function authRoutes({ db, config }) {
  const router = Router();

  // 10 attempts per 15 minutes per IP (successful logins don't count).
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginRateLimit ?? 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('login', {
      error: 'Too many attempts. Wait 15 minutes and try again.',
    }),
  });

  router.get('/login', (req, res) => {
    if (req.session.loggedIn) return res.redirect('/');
    res.render('login', { error: null });
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    const ok = await checkPassword(db, config, req.body.password);
    if (!ok) return res.status(401).render('login', { error: "That password isn't right." });
    const returnTo = isSafeReturnPath(req.session.returnTo) ? req.session.returnTo : '/';
    // New session id on login, so a session id seen before login is useless afterwards.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.loggedIn = true;
      req.session.cookie.maxAge = 14 * 24 * 3600 * 1000;
      req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect(returnTo)));
    });
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('gp.sid');
      res.redirect('/login');
    });
  });

  return router;
}
