const { q } = require('../db');

async function getSetting(key, fallback) {
  const { rows } = await q('SELECT value FROM settings WHERE key=$1', [key]);
  if (!rows.length) return fallback;
  return rows[0].value;
}

async function setSetting(key, value, userId) {
  await q(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
           ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`, [key, JSON.stringify(value), userId || null]);
}

module.exports = { getSetting, setSetting };
