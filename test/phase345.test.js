// المراحل 3-5: الحجوزات والسعة والتقسيط والعكس المالي والحضور
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, resetDb, seedUsers, loginAgent } = require('./helpers');

let users, groupId;
before(async () => {
  await migrate(); await resetDb(); users = await seedUsers();
  await q(`UPDATE courses SET base_price=6000 WHERE name='التسويق الرقمي'`);
  const g = await q(`INSERT INTO groups (course_id, name, capacity, status, start_date) VALUES ((SELECT id FROM courses WHERE name='التسويق الرقمي'), 'G-TEST', 1, 'open', current_date+7) RETURNING id`);
  groupId = g.rows[0].id;
});
after(async () => { await pool.end(); });

test('booking creates order+enrollment, updates lead status, enforces capacity', async () => {
  const { withCsrf: smPost } = await loginAgent('sm@test');
  const cust = await q(`INSERT INTO customers (name, phone) VALUES ('حاجز أول','01055500001') RETURNING id`);
  const lead = await q(`INSERT INTO leads (customer_id, course_id, source, assigned_to) VALUES ($1, (SELECT id FROM courses WHERE name='التسويق الرقمي'), 'manual', $2) RETURNING id`, [cust.rows[0].id, users.sales1]);
  // تقسيط بمجموع خاطئ يرفض
  const bad = await smPost('post', '/orders', { lead_id: lead.rows[0].id, kind: 'course', course_id: '1', payment_type: 'installments', down_payment: '1000', installments_count: '3', installment_amount: '1500', first_due_date: '2026-12-01' });
  assert.equal(bad.status, 400);
  // تقسيط صحيح: 1500 + 3×1500 = 6000
  const ok = await smPost('post', '/orders', { lead_id: lead.rows[0].id, kind: 'course', course_id: '1', ['group_1']: String(groupId), payment_type: 'installments', down_payment: '1500', installments_count: '3', installment_amount: '1500', first_due_date: '2026-12-01' });
  assert.equal(ok.status, 302);
  const leadAfter = await q('SELECT status FROM leads WHERE id=$1', [lead.rows[0].id]);
  assert.equal(leadAfter.rows[0].status, 'booked_installment');
  const plan = await q(`SELECT sum(i.amount) AS s, p.down_payment, p.total FROM installments i JOIN installment_plans p ON p.id=i.plan_id GROUP BY p.down_payment, p.total`);
  assert.equal(parseFloat(plan.rows[0].down_payment) + parseFloat(plan.rows[0].s), parseFloat(plan.rows[0].total));
  // السعة = 1: المجموعة امتلأت والحجز الثاني يُرفض
  const g = await q('SELECT status FROM groups WHERE id=$1', [groupId]);
  assert.equal(g.rows[0].status, 'full');
  const over = await smPost('post', '/orders', { kind: 'course', course_id: '1', ['group_1']: String(groupId), payment_type: 'cash', customer_name: 'زيادة', customer_phone: '01055500002' });
  assert.equal(over.status, 400);
});

test('payments: no overpayment, void reverses installment, staff cannot void', async () => {
  const { withCsrf: asPost } = await loginAgent('as@test');
  const order = (await q('SELECT id, total_price FROM sales_orders LIMIT 1')).rows[0];
  const over = await asPost('post', '/accounting/payments', { order_id: order.id, amount: '99999', method: 'cash', account_id: '1' });
  assert.equal(over.status, 400);
  const inst = (await q(`SELECT i.id FROM installments i JOIN installment_plans p ON p.id=i.plan_id WHERE p.order_id=$1 AND i.seq=1`, [order.id])).rows[0];
  const pay = await asPost('post', '/accounting/payments', { order_id: order.id, amount: '1500', method: 'cash', account_id: '1', installment_id: inst.id });
  assert.equal(pay.status, 302);
  let st = (await q('SELECT status FROM installments WHERE id=$1', [inst.id])).rows[0].status;
  assert.equal(st, 'paid');
  const paymentId = (await q('SELECT max(id) AS id FROM payments')).rows[0].id;
  const voidForbidden = await asPost('post', `/accounting/payments/${paymentId}/void`, { reason: 'خطأ' });
  assert.equal(voidForbidden.status, 403);
  const { withCsrf: amPost } = await loginAgent('am@test');
  const voidOk = await amPost('post', `/accounting/payments/${paymentId}/void`, { reason: 'سجلت بالخطأ' });
  assert.equal(voidOk.status, 302);
  st = (await q('SELECT status FROM installments WHERE id=$1', [inst.id])).rows[0].status;
  assert.equal(st, 'pending');
  const pv = (await q('SELECT status, void_reason FROM payments WHERE id=$1', [paymentId])).rows[0];
  assert.equal(pv.status, 'voided');
  assert.ok(pv.void_reason);
});

test('session postpone preserves original; attendance recorded once per student', async () => {
  const { withCsrf: cmPost } = await loginAgent('cm@test');
  // تواريخ ماضية لأن تسجيل الحضور محصور بالمحاضرات التي بدأت فعلًا بتوقيت القاهرة (حارس 5fefa8a)
  const fmt = (d) => d.toISOString().slice(0, 10);
  const d2 = fmt(new Date(Date.now() - 2 * 86400000));
  const d1 = fmt(new Date(Date.now() - 86400000));
  await cmPost('post', `/groups/${groupId}/sessions`, { session_date: d2, start_time: '18:00', end_time: '20:00', topic: 'م1' });
  const sid = (await q('SELECT max(id) AS id FROM sessions')).rows[0].id;
  await cmPost('post', `/sessions/${sid}/postpone`, { new_date: d1, reason: 'اختبار' });
  const s = (await q('SELECT session_date::text AS sd, original_date::text AS od, status FROM sessions WHERE id=$1', [sid])).rows[0];
  assert.equal(s.od, d2);
  assert.equal(s.status, 'postponed');
  const { withCsrf: rcPost, agent: rc } = await loginAgent('rc@test');
  const eid = (await q('SELECT id FROM enrollments WHERE group_id=$1 LIMIT 1', [groupId])).rows[0].id;
  const att = await rcPost('post', `/reception/sessions/${sid}/attendance`, { ['att_' + eid]: 'late' });
  assert.equal(att.status, 302);
  const a = await q('SELECT status FROM attendance WHERE session_id=$1 AND enrollment_id=$1'.replace('AND enrollment_id=$1', 'AND enrollment_id=$2'), [sid, eid]);
  assert.equal(a.rows[0].status, 'late');
  // الاستقبال لا يسجل مدفوعات
  const payForbidden = await rcPost('post', '/accounting/payments', { order_id: 1, amount: '10', method: 'cash', account_id: '1' });
  assert.equal(payForbidden.status, 403);
});

test('whatsapp webhook ingests and distributes; cron endpoint protected', async () => {
  const { supertest, app } = require('./helpers');
  await q(`INSERT INTO staff_presence (user_id, work_date, present) VALUES ($1, current_date, TRUE) ON CONFLICT (user_id, work_date) DO UPDATE SET present=TRUE`, [users.sales2]);
  const noAuth = await supertest(app).post('/api/webhooks/whatsapp').send({ phone: '01099999999', name: 'واتساب', text: 'عايز أسأل' });
  assert.equal(noAuth.status, 401);
  const ok = await supertest(app).post('/api/webhooks/whatsapp').set('x-webhook-secret', 'test-wa').send({ phone: '01099999999', name: 'واتساب', text: 'عايز أسأل' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  const lead = await q(`SELECT l.assigned_to FROM leads l JOIN customers c ON c.id=l.customer_id WHERE c.phone='01099999999'`);
  assert.equal(lead.rows[0].assigned_to, users.sales2);
  const cronNoAuth = await supertest(app).post('/api/cron/run');
  assert.equal(cronNoAuth.status, 401);
  const cronOk = await supertest(app).post('/api/cron/run').set('x-cron-secret', 'test-cron');
  assert.equal(cronOk.status, 200);
});
