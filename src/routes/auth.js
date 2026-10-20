'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin } = require('../lib/auth');

const router = express.Router();

// Simple in-memory throttle per IP+username (adequate for a single instance; swap for Redis if you scale out).
const attempts = new Map();
function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { attempts.delete(key); return false; }
  return rec.count >= 10;
}
function recordAttempt(key) {
  const rec = attempts.get(key) || { count: 0, first: Date.now() };
  rec.count += 1;
  attempts.set(key, rec);
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const key = `${req.ip}|${username}`;
    if (tooManyAttempts(key)) {
      return res.status(429).render('login', { title: 'Sign in', error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const u = rows[0];
    const ok = u && u.is_active && (await bcrypt.compare(password, u.password_hash));
    if (!ok) {
      recordAttempt(key);
      await audit(req, { action: 'login_failed', entityType: 'auth', entityId: username, summary: `Failed sign-in for "${username}"` });
      return res.status(401).render('login', { title: 'Sign in', error: 'Invalid username or password.' });
    }
    attempts.delete(key);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
      audit(req, { action: 'login', entityType: 'auth', entityId: u.id, summary: `${u.username} signed in` }).catch(console.error);
      const dest = req.session.returnTo || '/';
      delete req.session.returnTo;
      req.session.save(() => res.redirect(dest));
    });
  } catch (e) { next(e); }
});

router.post('/logout', requireLogin, async (req, res) => {
  await audit(req, { action: 'logout', entityType: 'auth', entityId: req.session.user.id, summary: `${req.session.user.username} signed out` });
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account', requireLogin, (req, res) => {
  res.render('account', { title: 'My account', error: null });
});

router.post('/account/password', requireLogin, async (req, res, next) => {
  try {
    const { current, password, confirm } = req.body;
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.session.user.id]);
    if (!(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
      return res.status(400).render('account', { title: 'My account', error: 'Current password is incorrect.' });
    }
    if (!password || password.length < 10) {
      return res.status(400).render('account', { title: 'My account', error: 'New password must be at least 10 characters.' });
    }
    if (password !== confirm) {
      return res.status(400).render('account', { title: 'My account', error: 'Passwords do not match.' });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.session.user.id]);
    await audit(req, { action: 'password_change', entityType: 'user', entityId: req.session.user.id, summary: `${req.session.user.username} changed their password` });
    req.session.flash = { type: 'success', text: 'Password updated.' };
    res.redirect('/account');
  } catch (e) { next(e); }
});

module.exports = router;
