const { q } = require('../db');

async function audit(req, action, entity, entityId, details) {
  const user = req.user || null;
  await q(
    'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [user ? user.id : null, user ? user.name : null, action, entity, entityId != null ? String(entityId) : null,
     details ? JSON.stringify(details) : null, req.ip || null]
  );
}

module.exports = { audit };
