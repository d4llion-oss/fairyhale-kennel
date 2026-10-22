'use strict';
const { doubleCsrf } = require('csrf-csrf');

const isProd = process.env.NODE_ENV === 'production';

// Double-submit cookie CSRF. Multipart uploads are exempted from the global
// middleware (the body isn't parsed yet) and validated after multer instead.
const csrf = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET,
  cookieName: isProd ? '__Host-fh.csrf' : 'fh.csrf',
  cookieOptions: { sameSite: 'lax', secure: isProd, path: '/' },
  getTokenFromRequest: (req) => req.body && req.body._csrf,
});

const UPLOAD_PATH = /^\/animals\/[0-9a-f-]{36}\/photos\/?$/i;

function protect(req, res, next) {
  if (req.method === 'POST' && UPLOAD_PATH.test(req.path) && (req.headers['content-type'] || '').startsWith('multipart/form-data')) return next();
  return csrf.doubleCsrfProtection(req, res, next);
}

module.exports = { ...csrf, protect };
