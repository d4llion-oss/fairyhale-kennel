'use strict';

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).render('error', { title: 'Forbidden', status: 403, message: 'Administrator access is required for that page.' });
}

module.exports = { requireLogin, requireAdmin };
