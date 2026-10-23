'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin } = require('../lib/auth');
const { clean } = require('../lib/helpers');
const conditions = require('../lib/conditions');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- JSON lookups (mounted at /conditions) ----
const lookup = express.Router();
lookup.use(requireLogin);

lookup.get('/suggest', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json(await conditions.suggest(q));
});

lookup.get('/summary', async (req, res) => {
  const name = clean(String(req.query.name || '').slice(0, 120));
  const wiki = clean(String(req.query.wiki || '').slice(0, 160));
  if (!name) return res.status(400).json({ error: 'name required' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.json(await conditions.summary(name, wiki));
});

// ---- Per-animal list (mounted at /animals/:id/conditions) ----
const perAnimal = express.Router({ mergeParams: true });
perAnimal.use(requireLogin);
perAnimal.param('cid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).end()));

async function loadAnimal(id) {
  const { rows } = await db.query('SELECT id, name FROM animals WHERE id=$1', [id]);
  return rows[0];
}

perAnimal.post('/', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const name = clean(req.body.name);
    if (!name || name.length > 120) {
      req.session.flash = { type: 'error', text: 'Enter a condition name (up to 120 characters).' };
      return res.redirect(`/animals/${animal.id}`);
    }
    const wiki = clean(req.body.wiki) || conditions.resolveTitle(name);
    const notes = clean(req.body.notes);
    const { rows } = await db.query(
      `INSERT INTO animal_conditions (animal_id, name, wiki_title, notes, created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (animal_id, name) DO NOTHING RETURNING *`,
      [animal.id, conditions.norm(name), wiki, notes, req.session.user.id]
    );
    if (!rows[0]) {
      req.session.flash = { type: 'error', text: `"${name}" is already on ${animal.name}'s list.` };
      return res.redirect(`/animals/${animal.id}`);
    }
    await audit(req, { action: 'condition_add', entityType: 'animal', entityId: animal.id, summary: `Added condition "${rows[0].name}" to ${animal.name}`, after: rows[0] });
    // Warm the summary cache in the background so the first click is instant.
    conditions.summary(rows[0].name, wiki).catch(() => {});
    req.session.flash = { type: 'success', text: `Added ${rows[0].name}.` };
    res.redirect(`/animals/${animal.id}#conditions`);
  } catch (e) { next(e); }
});

perAnimal.post('/:cid/delete', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.redirect('/animals');
    const { rows } = await db.query('DELETE FROM animal_conditions WHERE id=$1 AND animal_id=$2 RETURNING *', [req.params.cid, animal.id]);
    if (rows[0]) await audit(req, { action: 'condition_remove', entityType: 'animal', entityId: animal.id, summary: `Removed condition "${rows[0].name}" from ${animal.name}`, before: rows[0] });
    req.session.flash = { type: 'success', text: 'Condition removed.' };
    res.redirect(`/animals/${animal.id}#conditions`);
  } catch (e) { next(e); }
});

module.exports = { lookup, perAnimal };
