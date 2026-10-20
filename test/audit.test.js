'use strict';
// Requires DATABASE_URL pointing at a migrated database.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');

after(() => pool.end());

test('audit_log rejects UPDATE', async () => {
  const { rows } = await pool.query(`INSERT INTO audit_log (action, entity_type, summary) VALUES ('test','test','immutability check') RETURNING id, occurred_at`);
  await assert.rejects(pool.query('UPDATE audit_log SET summary=$1 WHERE id=$2', ['tampered', rows[0].id]), /append-only/);
});

test('audit_log rejects DELETE', async () => {
  const { rows } = await pool.query(`INSERT INTO audit_log (action, entity_type, summary) VALUES ('test','test','delete check') RETURNING id`);
  await assert.rejects(pool.query('DELETE FROM audit_log WHERE id=$1', [rows[0].id]), /append-only/);
});

test('audit_log ignores client-supplied timestamps', async () => {
  const { rows } = await pool.query(`INSERT INTO audit_log (occurred_at, action, entity_type, summary) VALUES ('2000-01-01','test','test','stamp check') RETURNING occurred_at`);
  assert.ok(new Date(rows[0].occurred_at).getFullYear() >= 2026, 'timestamp should be server-assigned');
});
