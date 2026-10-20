'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin, requireAdmin } = require('../lib/auth');
const { FREQUENCIES, taskStatus, clean } = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin);

function parseTask(body) {
  const t = { title: clean(body.title), description: clean(body.description), frequency: clean(body.frequency) };
  const errors = [];
  if (!t.title) errors.push('Title is required.');
  if (!t.frequency || !FREQUENCIES[t.frequency]) errors.push('Choose a valid frequency.');
  return { t, errors };
}

const TASK_QUERY = `
  SELECT t.*, c.completed_at AS last_completed_at, u.display_name AS last_completed_by
  FROM kennel_tasks t
  LEFT JOIN LATERAL (SELECT completed_at, user_id FROM task_completions WHERE task_id=t.id ORDER BY completed_at DESC LIMIT 1) c ON true
  LEFT JOIN users u ON u.id=c.user_id`;

router.get('/', async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const { rows } = await db.query(`${TASK_QUERY} ${showAll ? '' : 'WHERE t.is_active'} ORDER BY t.is_active DESC, t.title`);
    const order = { overdue: 0, due_soon: 1, as_needed: 2, ok: 3 };
    const tasks = rows.map((t) => ({ ...t, status: taskStatus(t) })).sort((a, b) => (a.is_active !== b.is_active ? (a.is_active ? -1 : 1) : order[a.status] - order[b.status]));
    res.render('tasks/index', { title: 'Kennel tasks', tasks, showAll, frequencies: FREQUENCIES });
  } catch (e) { next(e); }
});

router.get('/new', requireAdmin, (req, res) => {
  res.render('tasks/form', { title: 'Add task', task: { frequency: 'daily' }, errors: [], frequencies: FREQUENCIES, action: '/tasks' });
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { t, errors } = parseTask(req.body);
    if (errors.length) return res.status(400).render('tasks/form', { title: 'Add task', task: t, errors, frequencies: FREQUENCIES, action: '/tasks' });
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('INSERT INTO kennel_tasks (title, description, frequency, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [t.title, t.description, t.frequency, req.session.user.id]);
      await audit(req, { action: 'create', entityType: 'task', entityId: rows[0].id, summary: `Added task "${t.title}" (${FREQUENCIES[t.frequency]})`, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: 'Task added.' };
    res.redirect('/tasks');
  } catch (e) { next(e); }
});

async function loadTask(id) {
  const { rows } = await db.query('SELECT * FROM kennel_tasks WHERE id=$1', [id]);
  return rows[0];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).render('error', { title: 'Not found', status: 404, message: 'Task not found.' })));

router.get('/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Task not found.' });
    res.render('tasks/form', { title: `Edit task`, task, errors: [], frequencies: FREQUENCIES, action: `/tasks/${task.id}` });
  } catch (e) { next(e); }
});

router.post('/:id', requireAdmin, async (req, res, next) => {
  try {
    const before = await loadTask(req.params.id);
    if (!before) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Task not found.' });
    const { t, errors } = parseTask(req.body);
    if (errors.length) return res.status(400).render('tasks/form', { title: 'Edit task', task: { ...before, ...t }, errors, frequencies: FREQUENCIES, action: `/tasks/${before.id}` });
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('UPDATE kennel_tasks SET title=$1, description=$2, frequency=$3 WHERE id=$4 RETURNING *', [t.title, t.description, t.frequency, before.id]);
      await audit(req, { action: 'update', entityType: 'task', entityId: before.id, summary: `Updated task "${t.title}"`, before, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: 'Task saved.' };
    res.redirect('/tasks');
  } catch (e) { next(e); }
});

router.post('/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    const before = await loadTask(req.params.id);
    if (!before) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Task not found.' });
    const active = req.body.active === '1';
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('UPDATE kennel_tasks SET is_active=$1 WHERE id=$2 RETURNING *', [active, before.id]);
      await audit(req, { action: active ? 'restore' : 'archive', entityType: 'task', entityId: before.id, summary: `${active ? 'Restored' : 'Archived'} task "${before.title}"`, before, after: rows[0] }, c);
    });
    res.redirect('/tasks?all=1');
  } catch (e) { next(e); }
});

// Any signed-in user can mark a task done.
router.post('/:id/complete', async (req, res, next) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task || !task.is_active) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Task not found.' });
    const notes = clean(req.body.notes);
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('INSERT INTO task_completions (task_id, user_id, notes) VALUES ($1,$2,$3) RETURNING *', [task.id, req.session.user.id, notes]);
      await audit(req, { action: 'complete', entityType: 'task', entityId: task.id, summary: `Completed task "${task.title}"${notes ? ` — ${notes}` : ''}`, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: `"${task.title}" marked done.` };
    res.redirect(req.body.return_to === 'dashboard' ? '/' : '/tasks');
  } catch (e) { next(e); }
});

router.get('/:id/history', async (req, res, next) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Task not found.' });
    const { rows } = await db.query('SELECT c.*, u.display_name AS user_name FROM task_completions c JOIN users u ON u.id=c.user_id WHERE c.task_id=$1 ORDER BY c.completed_at DESC LIMIT 200', [task.id]);
    res.render('tasks/history', { title: `${task.title} — history`, task, completions: rows, frequencies: FREQUENCIES });
  } catch (e) { next(e); }
});

module.exports = router;
