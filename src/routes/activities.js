'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin, requireAdmin } = require('../lib/auth');
const { ACTIVITY_TYPES, clean } = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin);

function parseEntry(body) {
  const bulk = body.mode === 'bulk';
  const e = {
    mode: bulk ? 'bulk' : 'single',
    animal_id: bulk ? null : clean(body.animal_id),
    animal_ids: bulk ? [...new Set([].concat(body.animal_ids || []).map(clean).filter(Boolean))] : [],
    activity_type: clean(body.activity_type),
    duration_minutes: parseInt(body.duration_minutes, 10),
    performed_at: clean(body.performed_at),
    notes: clean(body.notes),
  };
  const errors = [];
  if (bulk) {
    if (!e.animal_ids.length) errors.push('Select at least one animal.');
  } else if (!e.animal_id) errors.push('Animal is required.');
  if (!e.activity_type || !ACTIVITY_TYPES.includes(e.activity_type)) errors.push('Choose a valid activity type.');
  if (!Number.isInteger(e.duration_minutes) || e.duration_minutes < 1 || e.duration_minutes > 1440) errors.push('Duration must be between 1 and 1440 minutes.');
  if (e.performed_at) {
    const d = new Date(e.performed_at);
    if (Number.isNaN(d.getTime())) errors.push('Date/time is not valid.');
    else if (d.getTime() > Date.now() + 5 * 60 * 1000) errors.push('Date/time cannot be in the future.');
    else e.performed_at = d.toISOString();
  } else {
    e.performed_at = new Date().toISOString();
  }
  return { e, errors };
}

router.get('/', async (req, res, next) => {
  try {
    const mine = req.query.mine === '1';
    const params = [];
    let where = '';
    if (mine) { params.push(req.session.user.id); where = `WHERE e.user_id=$${params.length}`; }
    const { rows } = await db.query(
      `SELECT e.*, a.name AS animal_name, u.display_name AS user_name
       FROM activity_entries e JOIN animals a ON a.id=e.animal_id JOIN users u ON u.id=e.user_id
       ${where} ORDER BY e.performed_at DESC LIMIT 200`, params
    );
    res.render('activities/index', { title: 'Activity log', entries: rows, mine });
  } catch (e) { next(e); }
});

router.get('/new', async (req, res, next) => {
  try {
    const animals = (await db.query('SELECT id, name, animal_type FROM animals WHERE is_active ORDER BY name')).rows;
    res.render('activities/form', { title: 'Log activity', entry: { animal_id: req.query.animal || '' }, animals, errors: [], types: ACTIVITY_TYPES });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { e, errors } = parseEntry(req.body);
    const animals = (await db.query('SELECT id, name, animal_type FROM animals WHERE is_active ORDER BY name')).rows;
    const byId = new Map(animals.map((a) => [a.id, a]));
    const targets = e.mode === 'bulk' ? e.animal_ids.map((id) => byId.get(id)).filter(Boolean) : [byId.get(e.animal_id)].filter(Boolean);
    if (!errors.length && (e.mode === 'bulk' ? targets.length !== e.animal_ids.length : !targets.length)) errors.push('One or more selected animals were not found or are not active.');
    if (errors.length) return res.status(400).render('activities/form', { title: 'Log activity', entry: e, animals, errors, types: ACTIVITY_TYPES });

    await db.withTransaction(async (c) => {
      for (const animal of targets) {
        const { rows } = await c.query(
          `INSERT INTO activity_entries (animal_id, user_id, activity_type, duration_minutes, performed_at, notes)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [animal.id, req.session.user.id, e.activity_type, e.duration_minutes, e.performed_at, e.notes]
        );
        await audit(req, {
          action: 'create', entityType: 'activity', entityId: rows[0].id,
          summary: `${e.activity_type} · ${e.duration_minutes} min with ${animal.name}${targets.length > 1 ? ` (bulk, ${targets.length} animals)` : ''}`,
          after: rows[0],
        }, c);
      }
    });

    if (targets.length === 1) {
      req.session.flash = { type: 'success', text: `Logged ${e.duration_minutes} min of ${e.activity_type.toLowerCase()} with ${targets[0].name}.` };
      return res.redirect(req.body.return_to === 'animal' ? `/animals/${targets[0].id}` : '/activities');
    }
    req.session.flash = { type: 'success', text: `Logged ${e.duration_minutes} min of ${e.activity_type.toLowerCase()} for ${targets.length} animals: ${targets.map((a) => a.name).join(', ')}.` };
    res.redirect('/activities');
  } catch (e) { next(e); }
});

// Corrections are admin-only and leave a before/after trail in the audit log.
router.post('/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT e.*, a.name AS animal_name FROM activity_entries e JOIN animals a ON a.id=e.animal_id WHERE e.id=$1', [req.params.id]);
    const before = rows[0];
    if (!before) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Entry not found.' });
    await db.withTransaction(async (c) => {
      await c.query('DELETE FROM activity_entries WHERE id=$1', [before.id]);
      await audit(req, { action: 'delete', entityType: 'activity', entityId: before.id, summary: `Removed ${before.activity_type} entry (${before.duration_minutes} min) for ${before.animal_name}`, before }, c);
    });
    req.session.flash = { type: 'success', text: 'Entry removed (recorded in audit log).' };
    res.redirect('/activities');
  } catch (e) { next(e); }
});

module.exports = router;
