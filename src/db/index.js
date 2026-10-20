'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// DigitalOcean managed Postgres requires TLS; the CA is provided via DATABASE_CA_CERT
// (base64 or PEM) or you can set PGSSLMODE=require to accept the DO cert chain.
let ssl = false;
if (process.env.DATABASE_CA_CERT) {
  const raw = process.env.DATABASE_CA_CERT;
  const ca = raw.includes('BEGIN CERTIFICATE') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  ssl = { ca, rejectUnauthorized: true };
} else if (/sslmode=require/.test(connectionString) || process.env.PGSSLMODE === 'require') {
  ssl = { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString, ssl, max: 10 });

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
});

module.exports = {
  pool,
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
