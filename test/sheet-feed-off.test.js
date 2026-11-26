// بدون SHEET_FEED_TOKEN: 503 ولا يُكتب شيء
delete process.env.SHEET_FEED_TOKEN;
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const supertest = require('supertest');
const { q, pool, migrate, resetDb, app } = require('./helpers');
before(async () => { await migrate(); await resetDb(); });
after(() => pool.end());
test('غير مفعّل: 503', async () => {
  const body = { rows: [{ row_key: 'a'.repeat(64), phone: '01000000301' }] };
  assert.equal((await supertest(app).post('/api/webhooks/sheet-leads').set('Authorization', 'Bearer x').send(body)).status, 503);
  assert.equal((await supertest(app).post('/api/webhooks/sheet-leads').send(body)).status, 503);
  assert.equal((await q('SELECT count(*)::int n FROM customers')).rows[0].n, 0);
});
