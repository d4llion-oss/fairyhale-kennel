'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin, requireAdmin } = require('../lib/auth');
const { ANIMAL_TYPES, ACTIVITY_TYPES, clean } = require('../lib/helpers');

const router = express.Router();
router.use(requireLogin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAnimal(body) {
  const dob = clean(body.date_of_birth);
  const est = clean(body.age_years_estimate);
  const a = {
    name: clean(body.name),
    animal_type: clean(body.animal_type),
    breed: clean(body.breed),
    date_of_birth: dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null,
    age_years_estimate: est && !Number.isNaN(Number(est)) ? Number(est) : null,
    dietary_requirements: clean(body.dietary_requirements),
    medications: clean(body.medications),
    notes: clean(body.notes),
  };
  const errors = [];
  if (!a.name) errors.push('Name is required.');
  if (!a.animal_type) errors.push('Type of animal is required.');
  return { a, errors };
}

router.get('/', async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const { rows } = await db.query(
      `SELECT a.*, COALESCE(SUM(e.duration_minutes),0)::int AS total_minutes, MAX(e.performed_at) AS last_activity_at,
              (SELECT p.id FROM animal_photos p WHERE p.animal_id=a.id ORDER BY p.position LIMIT 1) AS photo_id
       FROM animals a LEFT JOIN activity_entries e ON e.animal_id=a.id
       ${showAll ? '' : 'WHERE a.is_active'}
       GROUP BY a.id ORDER BY a.is_active DESC, a.name`
    );
    res.render('animals/index', { title: 'Animals', animals: rows, showAll });
  } catch (e) { next(e); }
});

router.get('/new', (req, res) => {
  res.render('animals/form', { title: 'Add animal', animal: {}, errors: [], types: ANIMAL_TYPES, action: '/animals' });
});

router.post('/', async (req, res, next) => {
  try {
    const { a, errors } = parseAnimal(req.body);
    if (errors.length) return res.status(400).render('animals/form', { title: 'Add animal', animal: a, errors, types: ANIMAL_TYPES, action: '/animals' });
    const row = await db.withTransaction(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO animals (name, animal_type, breed, date_of_birth, age_years_estimate, dietary_requirements, medications, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [a.name, a.animal_type, a.breed, a.date_of_birth, a.age_years_estimate, a.dietary_requirements, a.medications, a.notes, req.session.user.id]
      );
      await audit(req, { action: 'create', entityType: 'animal', entityId: rows[0].id, summary: `Added animal "${a.name}" (${a.animal_type})`, after: rows[0] }, c);
      return rows[0];
    });
    req.session.flash = { type: 'success', text: `${row.name} added.` };
    res.redirect(`/animals/${row.id}`);
  } catch (e) { next(e); }
});

router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' })));

async function loadAnimal(id) {
  const { rows } = await db.query('SELECT * FROM animals WHERE id=$1', [id]);
  return rows[0];
}

router.use('/:id/photos', require('./photos'));

router.get('/:id', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const [entries, totals, photos] = await Promise.all([
      db.query(`SELECT e.*, u.display_name AS user_name FROM activity_entries e JOIN users u ON u.id=e.user_id
                WHERE e.animal_id=$1 ORDER BY e.performed_at DESC LIMIT 100`, [animal.id]),
      db.query(`SELECT activity_type, SUM(duration_minutes)::int AS minutes, COUNT(*)::int AS n
                FROM activity_entries WHERE animal_id=$1 AND performed_at >= now() - interval '7 days'
                GROUP BY activity_type ORDER BY minutes DESC`, [animal.id]),
      db.query('SELECT id, position, caption, width, height, bytes, created_at FROM animal_photos WHERE animal_id=$1 ORDER BY position', [animal.id]),
    ]);
    res.render('animals/show', { title: animal.name, animal, entries: entries.rows, totals: totals.rows, photos: photos.rows, maxPhotos: 5, activityTypes: ACTIVITY_TYPES });
  } catch (e) { next(e); }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    res.render('animals/form', { title: `Edit ${animal.name}`, animal, errors: [], types: ANIMAL_TYPES, action: `/animals/${animal.id}` });
  } catch (e) { next(e); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const before = await loadAnimal(req.params.id);
    if (!before) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const { a, errors } = parseAnimal(req.body);
    if (errors.length) return res.status(400).render('animals/form', { title: `Edit ${before.name}`, animal: { ...before, ...a }, errors, types: ANIMAL_TYPES, action: `/animals/${before.id}` });
    await db.withTransaction(async (c) => {
      const { rows } = await c.query(
        `UPDATE animals SET name=$1, animal_type=$2, breed=$3, date_of_birth=$4, age_years_estimate=$5, dietary_requirements=$6, medications=$7, notes=$8
         WHERE id=$9 RETURNING *`,
        [a.name, a.animal_type, a.breed, a.date_of_birth, a.age_years_estimate, a.dietary_requirements, a.medications, a.notes, before.id]
      );
      await audit(req, { action: 'update', entityType: 'animal', entityId: before.id, summary: `Updated animal "${a.name}"`, before, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: 'Profile saved.' };
    res.redirect(`/animals/${before.id}`);
  } catch (e) { next(e); }
});

// Admins can archive/restore. Hard delete is intentionally not offered: history must remain.
router.post('/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    const before = await loadAnimal(req.params.id);
    if (!before) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const active = req.body.active === '1';
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('UPDATE animals SET is_active=$1 WHERE id=$2 RETURNING *', [active, before.id]);
      await audit(req, { action: active ? 'restore' : 'archive', entityType: 'animal', entityId: before.id, summary: `${active ? 'Restored' : 'Archived'} animal "${before.name}"`, before, after: rows[0] }, c);
    });
    req.session.flash = { type: 'success', text: active ? `${before.name} restored.` : `${before.name} archived.` };
    res.redirect(`/animals/${before.id}`);
  } catch (e) { next(e); }
});

module.exports = router;
