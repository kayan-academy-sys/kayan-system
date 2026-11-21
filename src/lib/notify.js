const { q } = require('../db');

async function notify(userId, type, title, body, link) {
  await q('INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)',
    [userId, type, title, body || null, link || null]);
}

async function notifyRole(role, type, title, body, link) {
  const { rows } = await q('SELECT id FROM users WHERE role=$1 AND active=TRUE', [role]);
  for (const r of rows) await notify(r.id, type, title, body, link);
}

module.exports = { notify, notifyRole };
