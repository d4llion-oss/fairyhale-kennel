'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin } = require('../lib/auth');
const { clean } = require('../lib/helpers');
const { TZ } = require('../lib/reports');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PALETTE = 8; // number of badge colours defined in app.css (.pg-0 … .pg-7)

/** All groups with their active members (sorted), for list pages and pickers. */
async function allGroups() {
  const { rows } = await db.query(
    `SELECT g.*,
            COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'animal_type', a.animal_type, 'breed', a.breed,
                        'photo_id', (SELECT p.id FROM animal_photos p WHERE p.animal_id = a.id ORDER BY p.position LIMIT 1)) ORDER BY a.name)
                      FROM potty_group_members m JOIN animals a ON a.id = m.animal_id WHERE m.group_id = g.id AND a.is_active), '[]'::json) AS members,
            (SELECT json_build_object('at', o.let_out_at, 'by', u.display_name) FROM potty_outings o LEFT JOIN users u ON u.id = o.let_out_by
              WHERE o.group_id = g.id ORDER BY o.let_out_at DESC LIMIT 1) AS last_outing,
            (SELECT COUNT(*)::int FROM potty_outings o WHERE o.group_id = g.id AND (o.let_out_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) AS outings_today
     FROM potty_groups g ORDER BY g.sort_order, g.name`, [TZ]
  );
  return rows;
}

/** Groups a given animal belongs to, each with the OTHER active members. */
async function groupsForAnimal(animalId) {
  const groups = await allGroups();
  return groups
    .filter((g) => g.members.some((m) => m.id === animalId))
    .map((g) => ({ ...g, others: g.members.filter((m) => m.id !== animalId) }));
}

async function findOrCreateGroup(req, name, client = db) {
  const existing = (await client.query('SELECT * FROM potty_groups WHERE lower(name) = lower($1)', [name])).rows[0];
  if (existing) return { group: existing, created: false };
  const { rows: cnt } = await client.query('SELECT COUNT(*)::int AS n, COALESCE(MAX(sort_order), -1) + 1 AS next FROM potty_groups');
  const { rows } = await client.query('INSERT INTO potty_groups (name, color, sort_order, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [name, cnt[0].n % PALETTE, cnt[0].next, req.session.user.id]);
  await audit(req, { action: 'create', entityType: 'potty_group', entityId: rows[0].id, summary: `Created potty group "${name}"`, after: rows[0] }, client);
  return { group: rows[0], created: true };
}

async function addMember(req, group, animal, client = db) {
  const { rowCount } = await client.query('INSERT INTO potty_group_members (group_id, animal_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [group.id, animal.id, req.session.user.id]);
  if (rowCount) await audit(req, { action: 'member_add', entityType: 'potty_group', entityId: group.id, summary: `Added ${animal.name} to potty group "${group.name}"`, after: { animal_id: animal.id } }, client);
  return rowCount > 0;
}

async function removeMember(req, group, animal, client = db) {
  const { rowCount } = await client.query('DELETE FROM potty_group_members WHERE group_id=$1 AND animal_id=$2', [group.id, animal.id]);
  if (rowCount) await audit(req, { action: 'member_remove', entityType: 'potty_group', entityId: group.id, summary: `Removed ${animal.name} from potty group "${group.name}"`, before: { animal_id: animal.id } }, client);
  return rowCount > 0;
}

// ---- Groups page (mounted at /potty-groups) ----
const groups = express.Router();
groups.use(requireLogin);
groups.param('gid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).render('error', { title: 'Not found', status: 404, message: 'Group not found.' })));

groups.get('/', async (req, res, next) => {
  try {
    const [list, animals] = await Promise.all([
      allGroups(),
      db.query(`SELECT a.id, a.name, a.animal_type, a.breed,
                       (SELECT p.id FROM animal_photos p WHERE p.animal_id = a.id ORDER BY p.position LIMIT 1) AS photo_id,
                       COALESCE((SELECT json_agg(g.name ORDER BY g.name) FROM potty_group_members m JOIN potty_groups g ON g.id = m.group_id WHERE m.animal_id = a.id), '[]'::json) AS group_names
                FROM animals a WHERE a.is_active ORDER BY a.name`),
    ]);
    res.render('potty-groups/index', { title: 'Potty groups', groups: list, animals: animals.rows, ungrouped: animals.rows.filter((a) => !a.group_names.length) });
  } catch (e) { next(e); }
});

groups.post('/', async (req, res, next) => {
  try {
    const name = clean(req.body.name)?.slice(0, 60);
    if (!name) { req.session.flash = { type: 'error', text: 'Enter a group name.' }; return res.redirect('/potty-groups'); }
    const { group, created } = await findOrCreateGroup(req, name);
    const notes = clean(req.body.notes)?.slice(0, 200) || null;
    if (notes) await db.query('UPDATE potty_groups SET notes=$1, updated_at=now() WHERE id=$2', [notes, group.id]);
    const ids = [].concat(req.body.animal_ids || []).filter((id) => UUID.test(id));
    let added = 0;
    if (ids.length) {
      const { rows } = await db.query('SELECT id, name FROM animals WHERE id = ANY($1) AND is_active', [ids]);
      for (const a of rows) if (await addMember(req, group, a)) added += 1;
    }
    req.session.flash = { type: created ? 'success' : 'error', text: created ? `Created "${group.name}"${added ? ` with ${added} animal${added === 1 ? '' : 's'}` : ''}.` : `A group named "${group.name}" already exists${added ? `; added ${added} animal${added === 1 ? '' : 's'} to it` : ''}.` };
    res.redirect('/potty-groups');
  } catch (e) { next(e); }
});

groups.post('/:gid', async (req, res, next) => {
  try {
    const before = (await db.query('SELECT * FROM potty_groups WHERE id=$1', [req.params.gid])).rows[0];
    if (!before) return res.redirect('/potty-groups');
    const name = clean(req.body.name)?.slice(0, 60) || before.name;
    const notes = clean(req.body.notes)?.slice(0, 200) || null;
    const color = Number.isInteger(+req.body.color) && +req.body.color >= 0 && +req.body.color < PALETTE ? +req.body.color : before.color;
    const dup = (await db.query('SELECT 1 FROM potty_groups WHERE lower(name)=lower($1) AND id<>$2', [name, before.id])).rowCount;
    if (dup) { req.session.flash = { type: 'error', text: `Another group is already named "${name}".` }; return res.redirect('/potty-groups'); }
    const { rows } = await db.query('UPDATE potty_groups SET name=$1, notes=$2, color=$3, updated_at=now() WHERE id=$4 RETURNING *', [name, notes, color, before.id]);
    await audit(req, { action: 'update', entityType: 'potty_group', entityId: before.id, summary: `Updated potty group "${before.name}"${name !== before.name ? ` → "${name}"` : ''}`, before, after: rows[0] });
    req.session.flash = { type: 'success', text: 'Group saved.' };
    res.redirect('/potty-groups');
  } catch (e) { next(e); }
});

/** Set the full membership of a group from checkboxes. */
groups.post('/:gid/members', async (req, res, next) => {
  try {
    const group = (await db.query('SELECT * FROM potty_groups WHERE id=$1', [req.params.gid])).rows[0];
    if (!group) return res.redirect('/potty-groups');
    const wanted = new Set([].concat(req.body.animal_ids || []).filter((id) => UUID.test(id)));
    await db.withTransaction(async (c) => {
      const current = (await c.query('SELECT m.animal_id, a.name FROM potty_group_members m JOIN animals a ON a.id=m.animal_id WHERE m.group_id=$1', [group.id])).rows;
      for (const m of current) if (!wanted.has(m.animal_id)) await removeMember(req, group, { id: m.animal_id, name: m.name }, c);
      const have = new Set(current.map((m) => m.animal_id));
      const toAdd = [...wanted].filter((id) => !have.has(id));
      if (toAdd.length) {
        const { rows } = await c.query('SELECT id, name FROM animals WHERE id = ANY($1) AND is_active', [toAdd]);
        for (const a of rows) await addMember(req, group, a, c);
      }
    });
    req.session.flash = { type: 'success', text: `Members of "${group.name}" updated.` };
    res.redirect('/potty-groups');
  } catch (e) { next(e); }
});

groups.post('/:gid/delete', async (req, res, next) => {
  try {
    const { rows } = await db.query('DELETE FROM potty_groups WHERE id=$1 RETURNING *', [req.params.gid]);
    if (rows[0]) await audit(req, { action: 'delete', entityType: 'potty_group', entityId: rows[0].id, summary: `Deleted potty group "${rows[0].name}"`, before: rows[0] });
    req.session.flash = { type: 'success', text: 'Group deleted.' };
    res.redirect('/potty-groups');
  } catch (e) { next(e); }
});

/** Move a group up or down in the let-out order. */
groups.post('/:gid/move', async (req, res, next) => {
  try {
    const dir = req.body.dir === 'up' ? -1 : 1;
    await db.withTransaction(async (c) => {
      const { rows } = await c.query('SELECT id, name, sort_order FROM potty_groups ORDER BY sort_order, name FOR UPDATE');
      const i = rows.findIndex((g) => g.id === req.params.gid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j], rows[i]];
      for (let k = 0; k < rows.length; k++) await c.query('UPDATE potty_groups SET sort_order=$1 WHERE id=$2', [k, rows[k].id]);
      await audit(req, { action: 'reorder', entityType: 'potty_group', entityId: req.params.gid, summary: `Moved potty group "${rows[j].name}" ${dir < 0 ? 'up' : 'down'} to position ${j + 1}`, after: { order: rows.map((g) => g.name) } }, c);
    });
    res.redirect(req.body.return_to === 'dashboard' ? '/' : '/potty-groups');
  } catch (e) { next(e); }
});

/** Record that a group was just let out. */
groups.post('/:gid/let-out', async (req, res, next) => {
  try {
    const group = (await db.query('SELECT * FROM potty_groups WHERE id=$1', [req.params.gid])).rows[0];
    if (!group) return res.redirect('/');
    const notes = clean(req.body.notes)?.slice(0, 140) || null;
    const { rows } = await db.query('INSERT INTO potty_outings (group_id, let_out_by, notes) VALUES ($1,$2,$3) RETURNING *', [group.id, req.session.user.id, notes]);
    const members = (await db.query('SELECT a.name FROM potty_group_members m JOIN animals a ON a.id=m.animal_id WHERE m.group_id=$1 AND a.is_active ORDER BY a.name', [group.id])).rows.map((r) => r.name);
    await audit(req, { action: 'let_out', entityType: 'potty_group', entityId: group.id, summary: `Let out "${group.name}" (${members.join(', ') || 'no animals'})${notes ? ' — ' + notes : ''}`, after: rows[0] });
    req.session.flash = { type: 'success', text: `"${group.name}" let out.` };
    res.redirect(req.body.return_to === 'groups' ? '/potty-groups' : '/#potty-rotation');
  } catch (e) { next(e); }
});

// ---- Per-animal (mounted at /animals/:id/potty-groups) ----
const perAnimal = express.Router({ mergeParams: true });
perAnimal.use(requireLogin);
perAnimal.param('gid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).end()));

async function loadAnimal(id) {
  const { rows } = await db.query('SELECT id, name FROM animals WHERE id=$1', [id]);
  return rows[0];
}

/** Add this animal to an existing group by id, or to a new/existing group by name. */
perAnimal.post('/', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const gid = UUID.test(req.body.group_id || '') ? req.body.group_id : null;
    const name = clean(req.body.name)?.slice(0, 60);
    let group;
    if (gid) group = (await db.query('SELECT * FROM potty_groups WHERE id=$1', [gid])).rows[0];
    else if (name) group = (await findOrCreateGroup(req, name)).group;
    if (!group) { req.session.flash = { type: 'error', text: 'Choose a group or type a name for a new one.' }; return res.redirect(`/animals/${animal.id}#potty-groups`); }
    const added = await addMember(req, group, animal);
    req.session.flash = { type: added ? 'success' : 'error', text: added ? `${animal.name} added to "${group.name}".` : `${animal.name} is already in "${group.name}".` };
    res.redirect(`/animals/${animal.id}#potty-groups`);
  } catch (e) { next(e); }
});

perAnimal.post('/:gid/remove', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const group = animal && (await db.query('SELECT * FROM potty_groups WHERE id=$1', [req.params.gid])).rows[0];
    if (!group) return res.redirect('/animals');
    await removeMember(req, group, animal);
    req.session.flash = { type: 'success', text: `${animal.name} removed from "${group.name}".` };
    res.redirect(`/animals/${animal.id}#potty-groups`);
  } catch (e) { next(e); }
});

module.exports = { groups, perAnimal, allGroups, groupsForAnimal };
