'use strict';
const db = require('../db');

/**
 * Append an entry to the immutable audit log.
 * `client` may be a transaction client; otherwise the pool is used.
 */
async function audit(req, { action, entityType, entityId = null, summary, before = null, after = null }, client = db) {
  const user = req.session && req.session.user;
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  await client.query(
    `INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, summary, before_data, after_data, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      user ? user.id : null,
      user ? user.username : null,
      action,
      entityType,
      entityId ? String(entityId) : null,
      summary,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ip && /^[\d.:a-fA-F]+$/.test(ip) ? ip : null,
      (req.get('user-agent') || '').slice(0, 512),
    ]
  );
}

module.exports = { audit };
