'use strict';
const fs = require('fs');
const path = require('path');
const { pool, SCHEMA } = require('./index');

// Thumbnails were originally square-cropped; rebuild any that still are so
// aspect ratios are preserved. Runs once per row, then is a no-op.
async function regenerateThumbs() {
  const { rows } = await pool.query("SELECT id, data FROM animal_photos WHERE thumb_fit <> 'inside'");
  if (!rows.length) return;
  const sharp = require('sharp');
  for (const r of rows) {
    const thumb = await sharp(r.data).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    await pool.query("UPDATE animal_photos SET thumb=$1, thumb_fit='inside' WHERE id=$2", [thumb, r.id]);
  }
  console.log(`Regenerated ${rows.length} photo thumbnail(s).`);
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await pool.query(sql);
    console.log('Schema applied.');
    await regenerateThumbs();
  } catch (err) {
    console.error('Migration failed:', err.message);
    try {
      const d = await pool.query(`SELECT current_user, session_user, current_database() AS db,
        has_database_privilege(current_database(), 'CREATE') AS db_create,
        has_schema_privilege('public', 'CREATE') AS public_create,
        has_schema_privilege('public', 'USAGE') AS public_usage,
        (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
        (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS db_owner,
        (SELECT string_agg(nspname || ':' || pg_get_userbyid(nspowner), ', ') FROM pg_namespace WHERE nspname NOT LIKE 'pg_%') AS schemas,
        version() AS version`);
      console.error('DB diagnostics:', JSON.stringify(d.rows[0]));
    } catch (e2) { console.error('Diagnostics failed:', e2.message); }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
