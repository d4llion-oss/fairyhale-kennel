'use strict';
const express = require('express');
const db = require('../db');
const { audit } = require('../lib/audit');
const { requireLogin } = require('../lib/auth');
const { clean } = require('../lib/helpers');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOOD_TYPES = ['Dry kibble', 'Wet / canned', 'Raw', 'Hay', 'Pellets', 'Fresh / produce', 'Treats', 'Prescription diet', 'Supplement', 'Other'];
const DOG_FOODS = require('../lib/dog-foods-list');
const UNITS = ['lb', 'kg', 'oz', 'g', 'cups', 'cans', 'pouches', 'bags', 'bales', 'bottles'];

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const fmtQty = (q) => { const n = Number(q); return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''); };

/** All foods with the animals that eat them. */
async function allFoods({ includeInactive = false } = {}) {
  const { rows } = await db.query(
    `SELECT f.*,
            COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.name, 'animal_type', a.animal_type, 'portion', af.portion, 'notes', af.notes,
                        'photo_id', (SELECT p.id FROM animal_photos p WHERE p.animal_id = a.id ORDER BY p.position LIMIT 1)) ORDER BY a.name)
                      FROM animal_foods af JOIN animals a ON a.id = af.animal_id WHERE af.food_id = f.id AND a.is_active), '[]'::json) AS eaters,
            (SELECT json_build_object('at', c.changed_at, 'delta', c.delta, 'reason', c.reason, 'by', u.display_name)
               FROM food_stock_changes c LEFT JOIN users u ON u.id = c.changed_by WHERE c.food_id = f.id ORDER BY c.changed_at DESC LIMIT 1) AS last_change
     FROM foods f ${includeInactive ? '' : 'WHERE f.is_active'} ORDER BY f.is_active DESC, f.name`
  );
  return rows.map((f) => ({ ...f, low: f.low_threshold != null && Number(f.quantity) <= Number(f.low_threshold), out: Number(f.quantity) <= 0, qty: fmtQty(f.quantity) }));
}

/** Foods assigned to one animal. */
async function foodsForAnimal(animalId) {
  const { rows } = await db.query(
    `SELECT f.id, f.name, f.brand, f.food_type, f.quantity, f.unit, f.low_threshold, f.is_active, af.portion, af.notes
     FROM animal_foods af JOIN foods f ON f.id = af.food_id WHERE af.animal_id = $1 ORDER BY f.name`, [animalId]
  );
  return rows.map((f) => ({ ...f, low: f.low_threshold != null && Number(f.quantity) <= Number(f.low_threshold), qty: fmtQty(f.quantity) }));
}

async function loadFood(id) { return (await db.query('SELECT * FROM foods WHERE id=$1', [id])).rows[0]; }
async function loadAnimal(id) { return (await db.query('SELECT id, name FROM animals WHERE id=$1', [id])).rows[0]; }

async function findOrCreateFood(req, { name, brand, food_type, unit }, client = db) {
  const existing = (await client.query('SELECT * FROM foods WHERE lower(name)=lower($1)', [name])).rows[0];
  if (existing) return { food: existing, created: false };
  const { rows } = await client.query(
    'INSERT INTO foods (name, brand, food_type, unit, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, brand || null, FOOD_TYPES.includes(food_type) ? food_type : 'Dry kibble', UNITS.includes(unit) ? unit : 'lb', req.session.user.id]
  );
  await audit(req, { action: 'create', entityType: 'food', entityId: rows[0].id, summary: `Added food "${name}"`, after: rows[0] }, client);
  return { food: rows[0], created: true };
}

async function adjustStock(req, food, delta, reason, client = db) {
  const after = Math.max(0, Math.round((Number(food.quantity) + delta) * 100) / 100);
  await client.query('UPDATE foods SET quantity=$1, updated_at=now() WHERE id=$2', [after, food.id]);
  const { rows } = await client.query('INSERT INTO food_stock_changes (food_id, delta, quantity_after, reason, changed_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [food.id, after - Number(food.quantity), after, reason, req.session.user.id]);
  await audit(req, { action: 'stock', entityType: 'food', entityId: food.id, summary: `${food.name}: ${delta >= 0 ? '+' : ''}${fmtQty(delta)} ${food.unit} (${reason || 'adjustment'}) → ${fmtQty(after)} ${food.unit}`, before: { quantity: food.quantity }, after: rows[0] }, client);
  return after;
}

/** Autocomplete against the curated US dog-food list (+ foods already in the pantry). */
function suggestFoods(q, pantry) {
  const fold = (x) => String(x || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  const query = fold(q);
  if (query.length < 2) return [];
  const words = query.split(' ');
  const score = (name, brand) => {
    const n = fold(name), b = fold(brand);
    if (n.startsWith(query)) return 0;
    if (b.startsWith(query)) return 1;
    if (words.every((w) => n.includes(w))) return 2;
    return -1;
  };
  const seen = new Set(); const out = [];
  for (const f of pantry) { const sc = score(f.name, f.brand); if (sc >= 0) { seen.add(fold(f.name)); out.push({ sc: sc - 0.5, name: f.name, brand: f.brand, type: f.food_type, source: 'pantry', id: f.id }); } }
  for (const f of DOG_FOODS) { if (seen.has(fold(f.name))) continue; const sc = score(f.name, f.brand); if (sc >= 0) out.push({ sc, name: f.name, brand: f.brand, type: f.type, source: 'list' }); }
  return out.sort((a, b) => a.sc - b.sc || a.name.localeCompare(b.name)).slice(0, 10).map(({ sc, ...r }) => r);
}

// ---- Food inventory page (mounted at /food) ----
const foods = express.Router();
foods.use(requireLogin);

foods.get('/suggest', async (req, res) => {
  const { rows } = await db.query('SELECT id, name, brand, food_type FROM foods WHERE is_active ORDER BY name');
  res.setHeader('Cache-Control', 'private, max-age=120');
  res.json(suggestFoods(String(req.query.q || '').slice(0, 80), rows));
});
foods.param('fid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).render('error', { title: 'Not found', status: 404, message: 'Food not found.' })));

foods.get('/', async (req, res, next) => {
  try {
    const showAll = req.query.all === '1';
    const [list, animals] = await Promise.all([
      allFoods({ includeInactive: showAll }),
      db.query(`SELECT a.id, a.name, a.animal_type, (SELECT COUNT(*)::int FROM animal_foods af WHERE af.animal_id = a.id) AS food_count FROM animals a WHERE a.is_active ORDER BY a.name`),
    ]);
    res.render('food/index', { title: 'Food', foods: list, showAll, animals: animals.rows, unfed: animals.rows.filter((a) => !a.food_count), foodTypes: FOOD_TYPES, units: UNITS, fmtQty });
  } catch (e) { next(e); }
});

foods.post('/', async (req, res, next) => {
  try {
    const name = clean(req.body.name)?.slice(0, 120);
    if (!name) { req.session.flash = { type: 'error', text: 'Enter a food name.' }; return res.redirect('/food'); }
    const { food, created } = await findOrCreateFood(req, { name, brand: clean(req.body.brand)?.slice(0, 80), food_type: req.body.food_type, unit: req.body.unit });
    if (!created) { req.session.flash = { type: 'error', text: `"${food.name}" is already in the inventory.` }; return res.redirect('/food'); }
    const qty = num(req.body.quantity), low = num(req.body.low_threshold), notes = clean(req.body.notes)?.slice(0, 200) || null;
    await db.query('UPDATE foods SET low_threshold=$1, notes=$2 WHERE id=$3', [low, notes, food.id]);
    if (qty && qty > 0) await adjustStock(req, { ...food, quantity: 0 }, qty, 'initial stock');
    const ids = [].concat(req.body.animal_ids || []).filter((id) => UUID.test(id));
    if (ids.length) {
      const { rows } = await db.query('SELECT id, name FROM animals WHERE id = ANY($1) AND is_active', [ids]);
      for (const a of rows) {
        await db.query('INSERT INTO animal_foods (animal_id, food_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.id, food.id, req.session.user.id]);
        await audit(req, { action: 'eater_add', entityType: 'food', entityId: food.id, summary: `${a.name} now eats ${food.name}`, after: { animal_id: a.id } });
      }
    }
    req.session.flash = { type: 'success', text: `Added ${food.name}.` };
    res.redirect('/food');
  } catch (e) { next(e); }
});

foods.post('/:fid', async (req, res, next) => {
  try {
    const before = await loadFood(req.params.fid);
    if (!before) return res.redirect('/food');
    const name = clean(req.body.name)?.slice(0, 120) || before.name;
    const dup = (await db.query('SELECT 1 FROM foods WHERE lower(name)=lower($1) AND id<>$2', [name, before.id])).rowCount;
    if (dup) { req.session.flash = { type: 'error', text: `Another food is already named "${name}".` }; return res.redirect('/food'); }
    const { rows } = await db.query(
      'UPDATE foods SET name=$1, brand=$2, food_type=$3, unit=$4, low_threshold=$5, notes=$6, updated_at=now() WHERE id=$7 RETURNING *',
      [name, clean(req.body.brand)?.slice(0, 80) || null, FOOD_TYPES.includes(req.body.food_type) ? req.body.food_type : before.food_type, UNITS.includes(req.body.unit) ? req.body.unit : before.unit, num(req.body.low_threshold), clean(req.body.notes)?.slice(0, 200) || null, before.id]
    );
    await audit(req, { action: 'update', entityType: 'food', entityId: before.id, summary: `Updated food "${before.name}"${name !== before.name ? ` → "${name}"` : ''}`, before, after: rows[0] });
    req.session.flash = { type: 'success', text: 'Food saved.' };
    res.redirect('/food');
  } catch (e) { next(e); }
});

/** Adjust stock: mode=add|use|set with amount. */
foods.post('/:fid/stock', async (req, res, next) => {
  try {
    const food = await loadFood(req.params.fid);
    if (!food) return res.redirect('/food');
    const amount = num(req.body.amount);
    if (amount == null || amount < 0) { req.session.flash = { type: 'error', text: 'Enter a valid amount.' }; return res.redirect('/food'); }
    const mode = ['add', 'use', 'set'].includes(req.body.mode) ? req.body.mode : 'add';
    const delta = mode === 'add' ? amount : mode === 'use' ? -amount : amount - Number(food.quantity);
    const reason = clean(req.body.reason)?.slice(0, 120) || (mode === 'add' ? 'restock' : mode === 'use' ? 'used' : 'stock count');
    const after = await adjustStock(req, food, delta, reason);
    req.session.flash = { type: 'success', text: `${food.name}: now ${fmtQty(after)} ${food.unit}.` };
    res.redirect('/food');
  } catch (e) { next(e); }
});

/** Set which animals eat this food (checkboxes). */
foods.post('/:fid/eaters', async (req, res, next) => {
  try {
    const food = await loadFood(req.params.fid);
    if (!food) return res.redirect('/food');
    const wanted = new Set([].concat(req.body.animal_ids || []).filter((id) => UUID.test(id)));
    await db.withTransaction(async (c) => {
      const current = (await c.query('SELECT af.animal_id, a.name FROM animal_foods af JOIN animals a ON a.id=af.animal_id WHERE af.food_id=$1', [food.id])).rows;
      for (const m of current) if (!wanted.has(m.animal_id)) {
        await c.query('DELETE FROM animal_foods WHERE food_id=$1 AND animal_id=$2', [food.id, m.animal_id]);
        await audit(req, { action: 'eater_remove', entityType: 'food', entityId: food.id, summary: `${m.name} no longer eats ${food.name}`, before: { animal_id: m.animal_id } }, c);
      }
      const have = new Set(current.map((m) => m.animal_id));
      const toAdd = [...wanted].filter((id) => !have.has(id));
      if (toAdd.length) {
        const { rows } = await c.query('SELECT id, name FROM animals WHERE id = ANY($1) AND is_active', [toAdd]);
        for (const a of rows) {
          await c.query('INSERT INTO animal_foods (animal_id, food_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.id, food.id, req.session.user.id]);
          await audit(req, { action: 'eater_add', entityType: 'food', entityId: food.id, summary: `${a.name} now eats ${food.name}`, after: { animal_id: a.id } }, c);
        }
      }
    });
    req.session.flash = { type: 'success', text: `Updated who eats ${food.name}.` };
    res.redirect('/food');
  } catch (e) { next(e); }
});

foods.post('/:fid/active', async (req, res, next) => {
  try {
    const before = await loadFood(req.params.fid);
    if (!before) return res.redirect('/food');
    const active = req.body.active === '1';
    const { rows } = await db.query('UPDATE foods SET is_active=$1, updated_at=now() WHERE id=$2 RETURNING *', [active, before.id]);
    await audit(req, { action: active ? 'restore' : 'archive', entityType: 'food', entityId: before.id, summary: `${active ? 'Restored' : 'Archived'} food "${before.name}"`, before, after: rows[0] });
    res.redirect('/food?all=1');
  } catch (e) { next(e); }
});

foods.get('/:fid/history', async (req, res, next) => {
  try {
    const food = await loadFood(req.params.fid);
    if (!food) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Food not found.' });
    const { rows } = await db.query('SELECT c.*, u.display_name AS by_name FROM food_stock_changes c LEFT JOIN users u ON u.id=c.changed_by WHERE c.food_id=$1 ORDER BY c.changed_at DESC LIMIT 300', [food.id]);
    res.render('food/history', { title: `${food.name} — stock history`, food: { ...food, qty: fmtQty(food.quantity) }, changes: rows, fmtQty });
  } catch (e) { next(e); }
});

// ---- Per-animal (mounted at /animals/:id/food) ----
const perAnimal = express.Router({ mergeParams: true });
perAnimal.use(requireLogin);
perAnimal.param('fid', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).end()));

/** Assign a food (existing by id, or new by name) with a portion. */
perAnimal.post('/', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    if (!animal) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Animal not found.' });
    const fid = UUID.test(req.body.food_id || '') ? req.body.food_id : null;
    const name = clean(req.body.name)?.slice(0, 120);
    let food;
    if (fid) food = await loadFood(fid);
    else if (name) food = (await findOrCreateFood(req, { name, brand: clean(req.body.brand)?.slice(0, 80), food_type: req.body.food_type, unit: req.body.unit })).food;
    if (!food) { req.session.flash = { type: 'error', text: 'Choose a food or type a name for a new one.' }; return res.redirect(`/animals/${animal.id}#food`); }
    const portion = clean(req.body.portion)?.slice(0, 80) || null, notes = clean(req.body.notes)?.slice(0, 200) || null;
    const { rowCount } = await db.query(
      `INSERT INTO animal_foods (animal_id, food_id, portion, notes, added_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (animal_id, food_id) DO UPDATE SET portion=EXCLUDED.portion, notes=EXCLUDED.notes`, [animal.id, food.id, portion, notes, req.session.user.id]);
    await audit(req, { action: 'eater_add', entityType: 'food', entityId: food.id, summary: `${animal.name} eats ${food.name}${portion ? ' — ' + portion : ''}`, after: { animal_id: animal.id, portion, notes } });
    req.session.flash = { type: 'success', text: `${food.name} added for ${animal.name}.` };
    res.redirect(`/animals/${animal.id}#food`);
  } catch (e) { next(e); }
});

perAnimal.post('/:fid/remove', async (req, res, next) => {
  try {
    const animal = await loadAnimal(req.params.id);
    const food = animal && (await loadFood(req.params.fid));
    if (!food) return res.redirect('/animals');
    const { rowCount } = await db.query('DELETE FROM animal_foods WHERE animal_id=$1 AND food_id=$2', [animal.id, food.id]);
    if (rowCount) await audit(req, { action: 'eater_remove', entityType: 'food', entityId: food.id, summary: `${animal.name} no longer eats ${food.name}`, before: { animal_id: animal.id } });
    req.session.flash = { type: 'success', text: `${food.name} removed from ${animal.name}.` };
    res.redirect(`/animals/${animal.id}#food`);
  } catch (e) { next(e); }
});

module.exports = { foods, perAnimal, allFoods, foodsForAnimal, FOOD_TYPES, UNITS, fmtQty };
