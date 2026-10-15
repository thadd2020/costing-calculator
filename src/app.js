// Builds the Express app. Kept separate from server.js so tests can create an app
// around a temporary database without opening a port.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { ping } from './db/index.js';
import { DbSessionStore } from './session-store.js';
import { csrfToken, csrfExceptCsvUpload, refuseRepeatedFields, requireLogin } from './security.js';
import { formatGBP, formatPct, STATUS } from './calc/calc.js';
import { formatDate, formatDateTime, formatPackPrice, formatQty, unitCostLabel, moneyInput, percentInput } from './format.js';
import authRoutes from './routes/auth.js';
import dishRoutes from './routes/dishes.js';
import ingredientRoutes from './routes/ingredients.js';
import importRoutes from './routes/import.js';
import exportRoutes from './routes/export.js';
import deliveryRoutes from './routes/delivery.js';
import settingsRoutes from './routes/settings.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOURTEEN_DAYS = 14 * 24 * 3600 * 1000;

export function createApp({ db, config }) {
  const app = express();
  app.set('trust proxy', 1); // behind SiteGround's proxy
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        // Upgrading to https would break plain-http localhost during development.
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
  }));

  // Unauthenticated deploy check: also proves the database is reachable.
  app.get('/healthz', async (req, res) => {
    await ping(db);
    res.type('text').set('Cache-Control', 'no-store').send('ok');
  });

  // The calculation engine, served unchanged so the browser uses the same formulas as the server.
  app.get('/static/calc.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'src/calc/calc.js'));
  });
  // Same for the number parsers, so the live editor reads "£1,250.50" exactly as the server does.
  app.get('/static/input.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'src/input.js'));
  });
  app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: config.isProduction ? '1h' : 0 }));

  app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 5000 }));
  app.use(refuseRepeatedFields);

  const store = new DbSessionStore(db);
  app.locals.sessionStore = store;
  app.use(session({
    name: 'gp.sid',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: FOURTEEN_DAYS },
  }));

  // Values every view can use. Changing assetVersion on each start busts browser caches.
  const assetVersion = crypto.randomBytes(4).toString('hex');
  app.use((req, res, next) => {
    // Visitors who haven't logged in get a short-lived session (just enough for the login form).
    if (!req.session.loggedIn) req.session.cookie.maxAge = 3600 * 1000;
    res.locals.csrfToken = csrfToken(req);
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.loggedIn = Boolean(req.session.loggedIn);
    res.locals.path = req.path;
    res.locals.assetVersion = assetVersion;
    Object.assign(res.locals, { STATUS, formatGBP, formatPct, formatDate, formatDateTime, formatPackPrice, formatQty, unitCostLabel, moneyInput, percentInput });
    res.set('Cache-Control', 'no-store'); // pages hold cost data; don't keep them in shared caches
    next();
  });
  app.use(csrfExceptCsvUpload);

  const deps = { db, config };
  app.use(authRoutes(deps));
  app.use(requireLogin);
  app.use(dishRoutes(deps));
  app.use(ingredientRoutes(deps));
  app.use(importRoutes(deps));
  app.use(exportRoutes(deps));
  app.use(deliveryRoutes(deps));
  app.use(settingsRoutes(deps));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: "That page doesn't exist. It may have been deleted." });
  });

  // Log the error server-side; never show stack traces or details to the browser.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Client mistakes (malformed URL, repeated or too many form fields) are 4xx, not server errors.
    const status = err.status || err.statusCode;
    if (status === 413) {
      return res.status(413).render('error', { title: 'Too much data', message: 'That form was too large to save. Try fewer recipe lines at once.' });
    }
    if (status >= 400 && status < 500) {
      return res.status(status).render('error', { title: 'Bad request', message: "That request couldn't be understood. Go back and try again." });
    }
    console.error(`${req.method} ${req.path} failed:`, err.message);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Nothing was changed. Please try again; if it keeps happening, check the server logs.' });
  });

  return app;
}
