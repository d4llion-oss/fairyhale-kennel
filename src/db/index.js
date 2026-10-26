'use strict';
require('dotenv').config();
const { TZ } = require('../lib/tz');
const { Pool } = require('pg');

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// pg lets sslmode in the connection string override the `ssl` option, so we
// strip it from the URL and decide TLS behaviour explicitly here.
const url = new URL(rawUrl);
const sslmode = url.searchParams.get('sslmode');
url.searchParams.delete('sslmode');
const connectionString = url.toString();

function loadCaCert() {
  const raw = (process.env.DATABASE_CA_CERT || '').trim();
  if (!raw || raw.startsWith('${')) return null; // unset, or an unsubstituted platform placeholder
  if (raw.includes('BEGIN CERTIFICATE')) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded.includes('BEGIN CERTIFICATE') ? decoded : null;
  } catch {
    return null;
  }
}

let ssl = false;
const wantsTls = sslmode && sslmode !== 'disable' || process.env.PGSSLMODE === 'require' || process.env.NODE_ENV === 'production';
if (wantsTls) {
  const ca = loadCaCert();
  if (ca) {
    ssl = { ca, rejectUnauthorized: true };
  } else {
    // Managed Postgres uses a private CA. Without it we still encrypt the
    // connection but cannot verify the server identity.
    ssl = { rejectUnauthorized: false };
    console.warn('DATABASE_CA_CERT not provided; TLS enabled without certificate verification');
  }
}

// All app objects live in their own schema so we never depend on CREATE
// rights on `public` (locked down by default on Postgres 15+ managed DBs).
const SCHEMA = process.env.DATABASE_SCHEMA || 'kennel';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error('DATABASE_SCHEMA must be a simple identifier');

const pool = new Pool({ connectionString, ssl, max: 10, options: `-c search_path=${SCHEMA} -c timezone=${TZ}` });

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
});

module.exports = {
  pool,
  SCHEMA,
  query: (text, params) => pool.query(text, params),
  withTransaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};
