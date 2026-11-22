const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, resetDb, seedUsers, loginAgent } = require('./helpers');

let users;
const MK = '2026-11'; // شهر الاختبار (الحالي)

async function makeOrder(salesUserId, total, createdAt) {
  const cust = (await q(`INSERT INTO customers (name, phone) VALUES ($1,$2) RETURNING id`, ['عميل ' + Math.random(), '010' + Math.floor(Math.random() * 1e9)])).rows[0].id;
  const course = (await q(`INSERT INTO courses (name, base_price) VALUES ($1,$2) RETURNING id`, ['كورس ' + Math.random(), total])).rows[0].id;
  const id = (await q(`INSERT INTO sales_orders (customer_id, kind, course_id, total_price, payment_type, sales_user_id, status)
    VALUES ($1,'course',$2,$3,'cash',$4,'approved') RETURNING id`, [cust, course, total, salesUserId])).rows[0].id;
  if (createdAt) await q('UPDATE sales_orders SET created_at=$1 WHERE id=$2', [createdAt, id]);
  return id;
}
async function makeAccount() {
  return (await q(`INSERT INTO financial_accounts (name, type) VALUES ($1,'cash') RETURNING id`, ['خزنة ' + Math.random()])).rows[0].id;
}
async function pay(orderId, accountId, amount, paidAt) {
  await q('INSERT INTO payments (order_id, account_id, amount, method, paid_at) VALUES ($1,$2,$3,$4,$5)', [orderId, accountId, amount, 'cash', paidAt]);
}

before(async () => {
  await migrate();
  await resetDb();
  users = await seedUsers();
});

after(async () => { await pool.end(); });

test('commissions: generate blocked until method saved; rule saves', async () => {
  const { agent, withCsrf } = await loginAgent('am@test');
  const page = await agent.get('/accounting/commissions');
  assert.equal(page.status, 200);
  assert.match(page.text, /لم تُحفَظ القاعدة بعد/);
  let res = await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  assert.equal(res.status, 400);
  res = await withCsrf('post', '/accounting/commissions/rule', {
    target: '50000', threshold_pct: '80', rate_in: '7.5', rate_over: '10', method: 'invoice_weighted'
  });
  assert.equal(res.status, 302);
});

test('commissions: Mohamed example - 60k invoiced, 30k collected -> 2,375 (invoice-weighted)', async () => {
  const acc = await makeAccount();
  await makeOrder(users.sales1, 60000, '2026-11-05T10:00:00Z');
  const o = (await q(`SELECT id FROM sales_orders WHERE sales_user_id=$1`, [users.sales1])).rows[0].id;
  await pay(o, acc, 30000, '2026-11-10T10:00:00Z');
  const { withCsrf } = await loginAgent('am@test');
  const res = await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  assert.equal(res.status, 302);
  const cm = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales1])).rows[0];
  assert.ok(cm, 'row exists');
  assert.equal(parseFloat(cm.invoiced), 60000);
  assert.equal(parseFloat(cm.collected), 30000);
  assert.equal(cm.eligible, true);
  assert.equal(parseFloat(cm.amount), 2375); // 30000 × (7.5×50/60 + 10×10/60)%
});

test('commissions: eligibility threshold 80% - 39k invoiced earns zero, 40k earns', async () => {
  const acc = await makeAccount();
  const o1 = await makeOrder(users.sales2, 39000, '2026-11-05T10:00:00Z');
  await pay(o1, acc, 39000, '2026-11-06T10:00:00Z');
  const { withCsrf } = await loginAgent('am@test');
  await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  const cm = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales2])).rows[0];
  assert.equal(cm.eligible, false);
  assert.equal(parseFloat(cm.amount), 0);
  // رفع الفواتير إلى 40 ألف بالضبط يجعله مستحقًا (أقل من التارجت فالنسبة 7.5٪ فقط)
  const o2 = await makeOrder(users.sales2, 1000, '2026-11-07T10:00:00Z');
  await pay(o2, acc, 1000, '2026-11-07T10:00:00Z');
  await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  const cm2 = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales2])).rows[0];
  assert.equal(cm2.eligible, true);
  assert.equal(parseFloat(cm2.invoiced), 40000);
  assert.equal(parseFloat(cm2.collected), 40000);
  assert.equal(parseFloat(cm2.amount), 3000); // 40000 × 7.5%
});

test('commissions: arrears collection counts in the month paid, attributed to order salesperson', async () => {
  const acc = await makeAccount();
  // حجز من شهر سابق (أكتوبر) وسداد متأخر في نوفمبر
  const o = await makeOrder(users.sales1, 20000, '2026-10-15T10:00:00Z');
  await pay(o, acc, 5000, '2026-11-03T10:00:00Z');
  const { withCsrf } = await loginAgent('am@test');
  await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  const cm = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales1])).rows[0];
  assert.equal(parseFloat(cm.invoiced), 60000); // فواتير نوفمبر فقط
  assert.equal(parseFloat(cm.collected), 35000); // 30k + 5k متأخرات
  // دفعة ملغاة لا تُحتسب
  await q(`UPDATE payments SET status='voided' WHERE order_id=$1 AND amount=5000`, [o]);
  await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  const cm2 = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales1])).rows[0];
  assert.equal(parseFloat(cm2.collected), 30000);
});

test('commissions: per-user target override applies', async () => {
  const { withCsrf } = await loginAgent('am@test');
  let res = await withCsrf('post', '/accounting/commissions/target', { user_id: String(users.sales1), monthly_target: '100000' });
  assert.equal(res.status, 302);
  await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  const cm = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales1])).rows[0];
  assert.equal(parseFloat(cm.target), 100000);
  assert.equal(cm.eligible, false); // 60k < 80k
  assert.equal(parseFloat(cm.amount), 0);
  // إعادة التارجت الافتراضي
  await withCsrf('post', '/accounting/commissions/target', { user_id: String(users.sales1), monthly_target: '' });
});

test('commissions: salesperson sees only own months; accounting staff read-only; others blocked', async () => {
  const { agent } = await loginAgent('s1@test');
  const page = await agent.get('/commissions');
  assert.equal(page.status, 200);
  assert.match(page.text, /عمولتي/);
  const { agent: agent2 } = await loginAgent('s2@test');
  const page2 = await agent2.get('/commissions');
  assert.equal(page2.status, 200);
  // صفوف مختلفة: sales2 عنده 3000، sales1 عنده 2375
  assert.match(page2.text, /٣٬٠٠٠|3,000|3000/);
  assert.doesNotMatch(page2.text, /2375|٢٬٣٧٥/);
  assert.notEqual((await agent.get('/accounting/commissions')).status, 200);
  const { agent: agent3 } = await loginAgent('rc@test');
  assert.notEqual((await agent3.get('/commissions')).status, 200);
  const { agent: agent4, withCsrf: w4 } = await loginAgent('as@test');
  assert.equal((await agent4.get('/accounting/commissions')).status, 200);
  // قسم الحسابات يعدّل النسب والأرقام (طلب محمد)
  const res = await w4('post', '/accounting/commissions/rule', { target: '50000', threshold_pct: '80', rate_in: '7.5', rate_over: '10', method: 'invoice_weighted' });
  assert.equal(res.status, 302);
  // لكن الصرف والاعتماد والإلغاء لمدير الحسابات فقط
  const row = (await q('SELECT id FROM commission_months LIMIT 1')).rows[0];
  const res2 = await w4('post', `/accounting/commissions/${row.id}/approve`, {});
  assert.notEqual(res2.status, 302);
});

test('commissions: status flow; approved/paid rows frozen against regenerate', async () => {
  const { withCsrf } = await loginAgent('am@test');
  const row = (await q(`SELECT * FROM commission_months WHERE sales_user_id=$1 AND month='2026-11-01'`, [users.sales2])).rows[0];
  assert.equal(parseFloat(row.amount), 3000);
  let res = await withCsrf('post', `/accounting/commissions/${row.id}/approve`, {});
  assert.equal(res.status, 302);
  // تغيير القاعدة ثم إعادة الاحتساب لا تغيّر المعتمدة
  await withCsrf('post', '/accounting/commissions/rule', { target: '50000', threshold_pct: '80', rate_in: '9', rate_over: '12', method: 'invoice_weighted' });
  await withCsrf('post', '/accounting/commissions/generate', { month: MK });
  const after1 = (await q('SELECT * FROM commission_months WHERE id=$1', [row.id])).rows[0];
  assert.equal(parseFloat(after1.amount), 3000);
  res = await withCsrf('post', `/accounting/commissions/${row.id}/pay`, {});
  assert.equal(res.status, 302);
  const after2 = (await q('SELECT * FROM commission_months WHERE id=$1', [row.id])).rows[0];
  assert.equal(after2.status, 'paid');
  assert.ok(after2.paid_at);
  res = await withCsrf('post', `/accounting/commissions/${row.id}/cancel`, { note: 'x' });
  assert.equal(res.status, 409);
});
