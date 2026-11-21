// المرحلة 2: العملاء، منع التكرار، التوزيع، الصلاحيات
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, resetDb, seedUsers, loginAgent } = require('./helpers');
const { distributeLeads } = require('../src/lib/distribute');

let users;
before(async () => { await migrate(); await resetDb(); users = await seedUsers(); });
after(async () => { await pool.end(); });

test('same phone links to existing customer, no duplicate', async () => {
  const { withCsrf } = await loginAgent('s1@test');
  await withCsrf('post', '/leads', { name: 'أحمد', phone: '01012345678', source: 'manual' });
  await withCsrf('post', '/leads', { name: 'أحمد محمد', phone: '01012345678', source: 'facebook', course_id: '1' });
  const cust = await q(`SELECT count(*) AS n FROM customers WHERE phone='01012345678'`);
  assert.equal(cust.rows[0].n, '1');
  const leads = await q(`SELECT count(*) AS n FROM leads l JOIN customers c ON c.id=l.customer_id WHERE c.phone='01012345678'`);
  assert.equal(leads.rows[0].n, '2');
});

test('distribution assigns only to present staff, evenly', async () => {
  const { withCsrf: smPost } = await loginAgent('sm@test');
  // الحاضرون: مبيعات ١ فقط
  await smPost('post', '/leads/distribution/presence', { present: String(users.sales1) });
  for (let i = 0; i < 4; i++) {
    await q('INSERT INTO customers (name, phone) VALUES ($1,$2)', ['عميل ' + i, '0100000000' + i]);
    await q(`INSERT INTO leads (customer_id, source) VALUES ((SELECT id FROM customers WHERE phone=$1), 'manual')`, ['0100000000' + i]);
  }
  const before = await q(`SELECT count(*) AS n FROM leads WHERE assigned_to IS NULL AND status='new'`);
  const result = await distributeLeads(null, users.salesManager, 'اختبار');
  assert.equal(result.moved, parseInt(before.rows[0].n, 10));
  assert.ok(result.moved >= 4);
  const left = await q(`SELECT count(*) AS n FROM leads WHERE assigned_to IS NULL AND status='new'`);
  assert.equal(left.rows[0].n, '0');
  const dist = await q('SELECT assigned_to, count(*) FROM leads WHERE assigned_to IS NOT NULL GROUP BY assigned_to');
  for (const r of dist.rows) assert.equal(r.assigned_to, users.sales1);
});

test('sales staff cannot access monitor or distribution; team leader can monitor', async () => {
  const { agent: s1 } = await loginAgent('s1@test');
  assert.equal((await s1.get('/leads/monitor')).status, 403);
  assert.equal((await s1.get('/leads/distribution')).status, 403);
  const { agent: tl } = await loginAgent('tl@test');
  assert.equal((await tl.get('/leads/monitor')).status, 200);
});

test('activity with interest score validation', async () => {
  const { withCsrf } = await loginAgent('s1@test');
  const lead = (await q(`SELECT l.id FROM leads l JOIN customers c ON c.id=l.customer_id WHERE c.phone='01012345678' LIMIT 1`)).rows[0];
  const bad = await withCsrf('post', `/leads/${lead.id}/activity`, { type: 'call', status: 'interested', interest_score: '50' });
  assert.equal(bad.status, 400);
  const ok = await withCsrf('post', `/leads/${lead.id}/activity`, { type: 'call', status: 'interested', interest_score: '8', notes: 'مكالمة' });
  assert.equal(ok.status, 302);
  const updated = await q('SELECT status, interest_score FROM leads WHERE id=$1', [lead.id]);
  assert.equal(updated.rows[0].status, 'interested');
  assert.equal(updated.rows[0].interest_score, 8);
});
