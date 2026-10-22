'use strict';
const db = require('../db');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = process.env.REPORT_TIMEZONE || 'America/Chicago';

function isoDate(d) { return d.toISOString().slice(0, 10); }

/** Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD&animal=<uuid>; defaults to the last 30 days. */
function parseRange(query) {
  const today = new Date();
  const dflt = new Date(today.getTime() - 29 * 86400000);
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
  let from = valid(query.from) ? query.from : isoDate(dflt);
  let to = valid(query.to) ? query.to : isoDate(today);
  if (from > to) [from, to] = [to, from];
  const animalId = UUID.test(query.animal || '') ? query.animal : null;
  return { from, to, animalId };
}

/**
 * Detailed report: every activity entry in the range, grouped
 * animal → day → entries, with per-day, per-animal and grand totals.
 */
async function buildReport({ from, to, animalId }) {
  const params = [from, to, TZ];
  let animalFilter = '';
  if (animalId) { params.push(animalId); animalFilter = `AND a.id = $${params.length}`; }

  const [entries, animalsRes] = await Promise.all([
    db.query(
      `SELECT e.id, e.animal_id, a.name AS animal_name, a.animal_type, a.breed,
              e.activity_type, e.duration_minutes, e.notes, e.performed_at,
              (e.performed_at AT TIME ZONE $3)::date AS day,
              u.display_name AS user_name
       FROM activity_entries e
       JOIN animals a ON a.id = e.animal_id
       JOIN users u ON u.id = e.user_id
       WHERE (e.performed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ${animalFilter}
       ORDER BY a.name, day, e.performed_at`, params),
    animalId
      ? db.query('SELECT id, name, animal_type, breed FROM animals WHERE id = $1', [animalId])
      : db.query('SELECT id, name, animal_type, breed FROM animals ORDER BY is_active DESC, name'),
  ]);

  const animalsById = new Map();
  for (const row of entries.rows) {
    let animal = animalsById.get(row.animal_id);
    if (!animal) {
      animal = { id: row.animal_id, name: row.animal_name, animal_type: row.animal_type, breed: row.breed, days: new Map(), minutes: 0, entries: 0, byType: new Map() };
      animalsById.set(row.animal_id, animal);
    }
    const dayKey = isoDate(new Date(row.day));
    let day = animal.days.get(dayKey);
    if (!day) { day = { date: dayKey, entries: [], minutes: 0 }; animal.days.set(dayKey, day); }
    day.entries.push(row);
    day.minutes += row.duration_minutes;
    animal.minutes += row.duration_minutes;
    animal.entries += 1;
    animal.byType.set(row.activity_type, (animal.byType.get(row.activity_type) || 0) + row.duration_minutes);
  }

  const animals = [...animalsById.values()].map((a) => ({
    ...a,
    days: [...a.days.values()],
    byType: [...a.byType.entries()].map(([type, minutes]) => ({ type, minutes })).sort((x, y) => y.minutes - x.minutes),
  }));

  const totals = {
    minutes: animals.reduce((s, a) => s + a.minutes, 0),
    entries: animals.reduce((s, a) => s + a.entries, 0),
    animals: animals.length,
    days: new Set(entries.rows.map((r) => isoDate(new Date(r.day)))).size,
  };

  return {
    from, to, timezone: TZ,
    animal: animalId ? animalsRes.rows[0] || null : null,   // the selected animal (per-animal report)
    allAnimals: animalId ? null : animalsRes.rows,          // for the picker on the global page
    animals, totals,
  };
}

module.exports = { parseRange, buildReport, TZ };
