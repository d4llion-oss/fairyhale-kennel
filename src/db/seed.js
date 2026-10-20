'use strict';
// Creates the initial admin account (idempotent) and, when SEED_DEMO_DATA=true,
// a few sample animals and tasks so the UI is not empty on first run.
const bcrypt = require('bcryptjs');
const { pool } = require('./index');

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

(async () => {
  try {
    if (!ADMIN_PASS) {
      throw new Error('ADMIN_PASSWORD must be set to seed the initial admin account');
    }
    const hash = await bcrypt.hash(ADMIN_PASS, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [ADMIN_USER, 'Administrator', hash]
    );
    if (rows.length) {
      await pool.query(
        `INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, summary)
         VALUES ($1, $2, 'create', 'user', $1::text, 'Initial admin account seeded')`,
        [rows[0].id, ADMIN_USER]
      );
      console.log(`Admin user "${ADMIN_USER}" created.`);
    } else {
      console.log(`Admin user "${ADMIN_USER}" already exists; skipped.`);
    }

    if (process.env.SEED_DEMO_DATA === 'true') {
      const admin = (await pool.query('SELECT id FROM users WHERE username=$1', [ADMIN_USER])).rows[0];
      const { rows: existing } = await pool.query('SELECT count(*)::int AS n FROM animals');
      if (existing[0].n === 0) {
        await pool.query(
          `INSERT INTO animals (name, animal_type, breed, date_of_birth, dietary_requirements, medications, notes, created_by) VALUES
           ('Biscuit', 'Dog', 'Golden Retriever', '2021-04-12', '2 cups kibble AM/PM, no chicken', 'None', 'Friendly, pulls on leash', $1),
           ('Pepper', 'Cat', 'Domestic Shorthair', '2019-09-30', 'Wet food 2x daily', 'Gabapentin 50mg PM', 'Shy with strangers; hides under bed first day', $1),
           ('Clover', 'Rabbit', 'Holland Lop', '2023-02-14', 'Timothy hay unlimited, pellets 1/4 cup', 'None', 'Needs daily floor time', $1)`,
          [admin.id]
        );
        await pool.query(
          `INSERT INTO kennel_tasks (title, description, frequency, created_by) VALUES
           ('Morning kennel clean', 'Spot clean all runs, refresh water bowls, sanitize food bowls', 'daily', $1),
           ('Evening kennel clean', 'Full sweep and mop of main kennel floor', 'daily', $1),
           ('Deep clean & disinfect runs', 'Pressure wash and disinfect all runs; rotate animals to play yard', 'weekly', $1),
           ('Laundry — bedding and towels', 'Wash, dry, and restock bedding', 'twice_daily', $1),
           ('Restock supplies', 'Check food, litter, cleaning supply levels and reorder', 'weekly', $1),
           ('HVAC filter change', 'Replace kennel HVAC filters', 'quarterly', $1)`,
          [admin.id]
        );
        await pool.query(
          `INSERT INTO audit_log (user_id, username, action, entity_type, summary)
           VALUES ($1, $2, 'seed', 'system', 'Demo animals and tasks seeded')`,
          [admin.id, ADMIN_USER]
        );
        console.log('Demo data seeded.');
      } else {
        console.log('Animals already present; demo data skipped.');
      }
    }
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
