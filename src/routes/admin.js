'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin, requireAdmin } = require('../lib/auth');
const { clean } = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin, requireAdmin);

// ---- Users -------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY is_active DESC, username');
    res.render('admin/users', { title: 'Users', users: rows, errors: [], form: {} });
  } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const form = { username: clean(req.body.username)?.toLowerCase(), display_name: clean(req.body.display_name), role: req.body.role === 'admin' ? 'admin' : 'user' };
    const password = String(req.body.password || '');
    const errors = [];
    if (!form.username || !/^[a-z0-9._-]{3,32}$/.test(form.username)) errors.push('Username must be 3–32 characters: letters, numbers, dot, dash, underscore.');
    if (!form.display_name) errors.push('Display name is required.');
    if (password.length < 10) errors.push('Password must be at least 10 characters.');
    if (!errors.length) {
      const exists = await db.query('SELECT 1 FROM users WHERE username=$1', [form.username]);
      if (exists.rowCount) errors.push('That username is already taken.');
    }
    if (errors.length) {
      const users = (await db.query('SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY is_active DESC, username')).rows;
      return res.status(400).render('admin/users', { title: 'Users', users, errors, form });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role, is_active', [form.username, form.display_name, hash, form.role]);
      await audit(req, { action: 'create', entityType: 'user', entityId: rows[0].id, summary: `Created ${form.role} account "${form.username}"`, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: `User ${form.username} created.` };
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

async function loadUser(id) {
  const { rows } = await db.query('SELECT id, username, display_name, role, is_active FROM users WHERE id=$1', [id]);
  return rows[0];
}

router.post('/users/:id/role', async (req, res, next) => {
  try {
    const before = await loadUser(req.params.id);
    if (!before) return res.redirect('/admin/users');
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    if (before.id === req.session.user.id && role !== 'admin') {
      req.session.flash = { type: 'error', text: 'You cannot remove your own admin role.' };
      return res.redirect('/admin/users');
    }
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING id, username, display_name, role, is_active', [role, before.id]);
      await audit(req, { action: 'update', entityType: 'user', entityId: before.id, summary: `Changed role of "${before.username}" to ${role}`, before, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: 'Role updated.' };
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

router.post('/users/:id/active', async (req, res, next) => {
  try {
    const before = await loadUser(req.params.id);
    if (!before) return res.redirect('/admin/users');
    const active = req.body.active === '1';
    if (before.id === req.session.user.id && !active) {
      req.session.flash = { type: 'error', text: 'You cannot deactivate your own account.' };
      return res.redirect('/admin/users');
    }
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('UPDATE users SET is_active=$1 WHERE id=$2 RETURNING id, username, display_name, role, is_active', [active, before.id]);
      if (!active) await c.query(`DELETE FROM session WHERE sess->'user'->>'id' = $1`, [before.id]);
      await audit(req, { action: active ? 'activate' : 'deactivate', entityType: 'user', entityId: before.id, summary: `${active ? 'Activated' : 'Deactivated'} account "${before.username}"`, before, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: active ? 'Account activated.' : 'Account deactivated and signed out.' };
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

router.post('/users/:id/password', async (req, res, next) => {
  try {
    const before = await loadUser(req.params.id);
    if (!before) return res.redirect('/admin/users');
    const password = String(req.body.password || '');
    if (password.length < 10) {
      req.session.flash = { type: 'error', text: 'Password must be at least 10 characters.' };
      return res.redirect('/admin/users');
    }
    const hash = await bcrypt.hash(password, 12);
    await db.withTransaction(async (c) => {
      await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, before.id]);
      await c.query(`DELETE FROM session WHERE sess->'user'->>'id' = $1 AND sid <> $2`, [before.id, req.sessionID]);
      await audit(req, { action: 'password_reset', entityType: 'user', entityId: before.id, summary: `Reset password for "${before.username}"` }, c);
    });
    req.session.flash = { type: 'success', text: `Password reset for ${before.username}.` };
    res.redirect('/admin/users');
  } catch (e) { next(e); }
});

// ---- Audit log ---------------------------------------------------
router.get('/audit', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 50;
    const filters = [];
    const params = [];
    if (clean(req.query.entity)) { params.push(req.query.entity); filters.push(`entity_type = $${params.length}`); }
    if (clean(req.query.user)) { params.push(req.query.user); filters.push(`username = $${params.length}`); }
    if (clean(req.query.q)) { params.push(`%${req.query.q}%`); filters.push(`summary ILIKE $${params.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const count = (await db.query(`SELECT count(*)::int AS n FROM audit_log ${where}`, params)).rows[0].n;
    params.push(perPage, (page - 1) * perPage);
    const { rows } = await db.query(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const [entities, users] = await Promise.all([
      db.query('SELECT DISTINCT entity_type FROM audit_log ORDER BY 1'),
      db.query('SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY 1'),
    ]);
    res.render('admin/audit', {
      title: 'Audit log',
      entries: rows,
      page,
      pages: Math.max(1, Math.ceil(count / perPage)),
      total: count,
      query: { entity: req.query.entity || '', user: req.query.user || '', q: req.query.q || '' },
      entities: entities.rows.map((r) => r.entity_type),
      users: users.rows.map((r) => r.username),
    });
  } catch (e) { next(e); }
});

router.get('/audit/export.csv', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, occurred_at, username, action, entity_type, entity_id, summary, ip_address FROM audit_log ORDER BY id');
    await audit(req, { action: 'export', entityType: 'audit', summary: `Exported audit log (${rows.length} rows)` });
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['id', 'occurred_at', 'username', 'action', 'entity_type', 'entity_id', 'summary', 'ip_address'].join(',')];
    for (const r of rows) lines.push([r.id, r.occurred_at.toISOString(), r.username, r.action, r.entity_type, r.entity_id, r.summary, r.ip_address].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) { next(e); }
});

// ---- Reports -----------------------------------------------------
router.get('/reports', async (req, res, next) => {
  try {
    const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
    const [byAnimal, byUser, byType] = await Promise.all([
      db.query(`SELECT a.id, a.name, a.animal_type, SUM(e.duration_minutes)::int AS minutes, COUNT(*)::int AS entries
                FROM activity_entries e JOIN animals a ON a.id=e.animal_id
                WHERE e.performed_at >= now() - ($1 || ' days')::interval GROUP BY a.id ORDER BY minutes DESC`, [days]),
      db.query(`SELECT u.display_name, SUM(e.duration_minutes)::int AS minutes, COUNT(*)::int AS entries
                FROM activity_entries e JOIN users u ON u.id=e.user_id
                WHERE e.performed_at >= now() - ($1 || ' days')::interval GROUP BY u.id ORDER BY minutes DESC`, [days]),
      db.query(`SELECT activity_type, SUM(duration_minutes)::int AS minutes, COUNT(*)::int AS entries
                FROM activity_entries WHERE performed_at >= now() - ($1 || ' days')::interval GROUP BY activity_type ORDER BY minutes DESC`, [days]),
    ]);
    res.render('admin/reports', { title: 'Reports', days, byAnimal: byAnimal.rows, byUser: byUser.rows, byType: byType.rows });
  } catch (e) { next(e); }
});

module.exports = router;
