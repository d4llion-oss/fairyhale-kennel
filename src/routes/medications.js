'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin } = require('../lib/auth');
const { clean } = require('../lib/helpers');
const lookup = require('../lib/conditions');
const { TZ } = require('../lib/reports');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FREQUENCIES = {
  once_daily: { label: 'Once daily', perDay: 1 },
  twice_daily: { label: 'Twice daily', perDay: 2 },
  three_times_daily: { label: 'Three times daily', perDay: 3 },
  every_other_day: { label: 'Every other day', perDay: 1 },
  weekly: { label: 'Weekly', perDay: 1 },
  monthly: { label: 'Monthly', perDay: 1 },
  as_needed: { label: 'As needed', perDay: 1 },
};

/** Medications for an animal with today's doses (in the kennel's timezone). */
async function listForAnimal(animalId) {
  const { rows } = await db.query(
    `SELECT m.*, u.display_name AS added_by,
            COALESCE((SELECT json_agg(json_build_object('id', d.id, 'given_at', d.given_at, 'notes', d.notes, 'given_by', gu.display_name) ORDER BY d.given_at)
                      FROM medication_doses d LEFT JOIN users gu ON gu.id = d.given_by
                      WHERE d.medication_id = m.id AND (d.given_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date), '[]'::json) AS today,
            (SELECT MAX(given_at) FROM medication_doses d WHERE d.medication_id = m.id) AS last_given_at,
            (SELECT COUNT(*)::int FROM medication_doses d WHERE d.medication_id = m.id) AS dose_count
     FROM animal_medications m LEFT JOIN users u ON u.id = m.created_by
     WHERE m.animal_id = $1 ORDER BY m.is_active DESC, m.name`, [animalId, TZ]
  );
  return rows.map((m) => ({ ...m, freq: FREQUENCIES[m.frequency], expectedToday: m.is_active && m.frequency !== 'as_needed' ? FREQUENCIES[m.frequency].perDay : 0 }));
}

// ---- JSON lookups (mounted at /medications) ----
const lookupRouter = express.Router();
lookupRouter.use(requireLogin);
lookupRouter.get('/suggest', async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json(await lookup.suggest(String(req.query.q || '').slice(0, 80), 'medications'));
});
lookupRouter.get('/summary', async (req, res) => {
  const name = clean(String(req.query.name || '').slice(0, 120));
  if (!name) return res.status(400).json({ error: 'name required' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.json(await lookup.summary(name, clean(String(req.query.wiki || '').slice(0, 160)), 'medications'));
});

// ---- Per-animal (mounted at /animals/:id/medications) ----
const perAnimal = express.Router({ mergeParams: true });
perAnimal.use(requireLogin);
perAnimal.param('mid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).end()));
perAnimal.param('did', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).end()));

async function loadAnimal(id) {
  const { rows } = await db.query('SELECT id, name FROM animals WHERE id=$1', [id]);
  return rows[0];
}
async function loadMed(animalId, mid) {
  const { rows } = await db.query('SELECT * FROM animal_medications WHERE id=$1 AND animal_id=$2', [mid, animalId]);
  return rows[0];
}
const back = (animal) => `/animals/${animal.id}#medications`;

perAnimal.post('/', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const name = clean(req.body.name);
    const frequency = FREQUENCIES[req.body.frequency] ? req.body.frequency : null;
    if (!name || name.length > 120 || !frequency) {
      req.session.flash = { type: 'error', text: 'Enter a medication name and choose how often it is given.' };
      return res.redirect(back(animal));
    }
    const wiki = clean(req.body.wiki) || lookup.resolveTitle(name, 'medications');
    const { rows } = await db.query(
      `INSERT INTO animal_medications (animal_id, name, wiki_title, dose, frequency, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [animal.id, lookup.norm(name), wiki, clean(req.body.dose)?.slice(0, 60) || null, frequency, clean(req.body.notes)?.slice(0, 200) || null, req.session.user.id]
    );
    await audit(req, { action: 'medication_add', entityType: 'animal', entityId: animal.id, summary: `Added medication "${rows[0].name}" (${rows[0].dose || 'no dose'}, ${FREQUENCIES[frequency].label}) to ${animal.name}`, after: rows[0] });
    lookup.summary(rows[0].name, wiki, 'medications').catch(() => {});
    req.session.flash = { type: 'success', text: `Added ${rows[0].name}.` };
    res.redirect(back(animal));
  } catch (e) { next(e); }
});

/** Record that a dose was given (the checkbox). */
perAnimal.post('/:mid/doses', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const med = animal && (await loadMed(animal.id, req.params.mid));
    if (!med) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Medication not found.' });
    const notes = clean(req.body.notes)?.slice(0, 200) || null;
    const { rows } = await db.query('INSERT INTO medication_doses (medication_id, animal_id, given_by, notes) VALUES ($1,$2,$3,$4) RETURNING *', [med.id, animal.id, req.session.user.id, notes]);
    await audit(req, { action: 'medication_given', entityType: 'animal', entityId: animal.id, summary: `Gave ${med.name}${med.dose ? ' ' + med.dose : ''} to ${animal.name}${notes ? ' — ' + notes : ''}`, after: rows[0] });
    req.session.flash = { type: 'success', text: `${med.name} marked as given.` };
    res.redirect(back(animal));
  } catch (e) { next(e); }
});

/** Undo a dose recorded by mistake (today only). */
perAnimal.post('/:mid/doses/:did/delete', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const med = animal && (await loadMed(animal.id, req.params.mid));
    if (!med) return res.redirect('/animals');
    const { rows } = await db.query(
      `DELETE FROM medication_doses WHERE id=$1 AND medication_id=$2 AND (given_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date RETURNING *`,
      [req.params.did, med.id, TZ]
    );
    if (rows[0]) {
      await audit(req, { action: 'medication_dose_undo', entityType: 'animal', entityId: animal.id, summary: `Removed a dose record of ${med.name} for ${animal.name} (given ${new Date(rows[0].given_at).toLocaleTimeString('en-US', { timeZone: TZ })})`, before: rows[0] });
      req.session.flash = { type: 'success', text: 'Dose record removed (noted in the audit log).' };
    }
    res.redirect(back(animal));
  } catch (e) { next(e); }
});

perAnimal.post('/:mid/notes', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const med = animal && (await loadMed(animal.id, req.params.mid));
    if (!med) return res.redirect('/animals');
    const notes = clean(req.body.notes)?.slice(0, 200) || null;
    const dose = clean(req.body.dose)?.slice(0, 60) || null;
    const frequency = FREQUENCIES[req.body.frequency] ? req.body.frequency : med.frequency;
    const { rows } = await db.query('UPDATE animal_medications SET notes=$1, dose=$2, frequency=$3 WHERE id=$4 RETURNING *', [notes, dose, frequency, med.id]);
    await audit(req, { action: 'medication_update', entityType: 'animal', entityId: animal.id, summary: `Updated ${med.name} for ${animal.name}`, before: med, after: rows[0] });
    req.session.flash = { type: 'success', text: `${med.name} updated.` };
    res.redirect(back(animal));
  } catch (e) { next(e); }
});

/** Stop (archive) or resume a medication. History is kept. */
perAnimal.post('/:mid/active', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const med = animal && (await loadMed(animal.id, req.params.mid));
    if (!med) return res.redirect('/animals');
    const active = req.body.active === '1';
    const { rows } = await db.query('UPDATE animal_medications SET is_active=$1, ended_at=CASE WHEN $1 THEN NULL ELSE now() END WHERE id=$2 RETURNING *', [active, med.id]);
    await audit(req, { action: active ? 'medication_resume' : 'medication_stop', entityType: 'animal', entityId: animal.id, summary: `${active ? 'Resumed' : 'Stopped'} ${med.name} for ${animal.name}`, before: med, after: rows[0] });
    req.session.flash = { type: 'success', text: `${med.name} ${active ? 'resumed' : 'stopped'}.` };
    res.redirect(back(animal));
  } catch (e) { next(e); }
});

perAnimal.post('/:mid/delete', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const med = animal && (await loadMed(animal.id, req.params.mid));
    if (!med) return res.redirect('/animals');
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM medication_doses WHERE medication_id=$1', [med.id]);
    if (rows[0].n > 0) {
      req.session.flash = { type: 'error', text: `${med.name} has ${rows[0].n} recorded dose${rows[0].n === 1 ? '' : 's'}; stop it instead of deleting so the history is kept.` };
      return res.redirect(back(animal));
    }
    await db.query('DELETE FROM animal_medications WHERE id=$1', [med.id]);
    await audit(req, { action: 'medication_remove', entityType: 'animal', entityId: animal.id, summary: `Removed medication "${med.name}" from ${animal.name}`, before: med });
    req.session.flash = { type: 'success', text: 'Medication removed.' };
    res.redirect(back(animal));
  } catch (e) { next(e); }
});

perAnimal.get('/:mid/history', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const med = animal && (await loadMed(animal.id, req.params.mid));
    if (!med) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Medication not found.' });
    const { rows } = await db.query('SELECT d.*, u.display_name AS given_by_name FROM medication_doses d LEFT JOIN users u ON u.id=d.given_by WHERE d.medication_id=$1 ORDER BY d.given_at DESC LIMIT 500', [med.id]);
    res.render('animals/medication-history', { title: `${med.name} — ${animal.name}`, animal, med: { ...med, freq: FREQUENCIES[med.frequency] }, doses: rows, tz: TZ });
  } catch (e) { next(e); }
});

module.exports = { lookup: lookupRouter, perAnimal, listForAnimal, FREQUENCIES };
