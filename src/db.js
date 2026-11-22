const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  // مهلة إغلاق اتصالات الخمول: على الخطة المجانية لـ Railway تنام الخدمة بعد خمول خارجي،
  // واتصال مفتوح يُبقيها مستيقظة. الافتراضي يظل سلوك pg القياسي ما لم تُضبط POOL_IDLE_MS.
  idleTimeoutMillis: Number(process.env.POOL_IDLE_MS || 30000)
});

async function q(text, params) { return pool.query(text, params); }

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, q, tx };
