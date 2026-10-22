'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const csrf = require('./lib/csrf');

const { pool } = require('./db');
const helpers = require('./lib/helpers');

const app = express();
const PORT = process.env.PORT || 8080;
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set');
  process.exit(1);
}

app.set('trust proxy', 1); // DigitalOcean App Platform terminates TLS upstream
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'img-src': ["'self'", 'data:'] } } }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1d' : 0 }));

app.use(
  session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET,
    name: 'fh.sid',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 12 * 60 * 60 * 1000 },
  })
);

// CSRF (double-submit cookie); multipart photo uploads validate after multer
app.use(csrf.protect);

// Locals available to every view
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.csrfToken = csrf.generateToken(req, res);
  res.locals.h = helpers;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  next();
});

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/animals', require('./routes/animals'));
app.use('/activities', require('./routes/activities'));
app.use('/tasks', require('./routes/tasks'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', status: 404, message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', { title: 'Form expired', status: 403, message: 'The form token was invalid or expired. Go back and try again.' });
  }
  console.error(err);
  res.status(500).render('error', { title: 'Server error', status: 500, message: isProd ? 'Something went wrong.' : err.message });
});

app.listen(PORT, () => console.log(`FairyHale Kennel listening on :${PORT}`));
