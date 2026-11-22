const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, resetDb, seedUsers, loginAgent } = require('./helpers');

let users;

async function makeOrder(salesUserId, total) {
  const cust = (await q(`INSERT INTO customers (name, phone) VALUES ($1,$2) RETURNING id`, ['عميل ' + Math.random(), '010' + Math.floor(Math.random() * 1e9)])).rows[0].id;
  const course = (await q(`INSERT INTO courses (name, base_price) VALUES ($1,$2) RETURNING id`, ['كورس ' + Math.random(), total])).rows[0].id;
  return (await q(`INSERT INTO sales_orders (customer_id, kind, course_id, total_price, payment_type, sales_user_id, status)
    VALUES ($1,'course',$2,$3,'cash',$4,'approved') RETURNING id`, [cust, course, total, salesUserId])).rows[0].id;
}

before(async () => {
  await migrate();
  await resetDb();
  users = await seedUsers();
});

after(async () => { await pool.end(); });

test('commissions: no rule set -> accounting sees setup prompt, generate rejected', async () => {
  const { agent, withCsrf } = await loginAgent('am@test');
  const page = await agent.get('/accounting/commissions');
  assert.equal(page.status, 200);
  assert.match(page.text, /لم تُحدَّد قاعدة بعد/);
  const res = await withCsrf('post', '/accounting/commissions/generate', {});
  assert.equal(res.status, 400);
});

test('commissions: set percent_booking rule, generate attributes to order sales user only', async () => {
  const { withCsrf } = await loginAgent('am@test');
  let res = await withCsrf('post', '/accounting/commissions/rule', { basis: 'percent_booking', percent: '10', fixed_amount: '' });
  assert.equal(res.status, 302);
  const o1 = await makeOrder(users.sales1, 1000);
  const o2 = await makeOrder(users.sales2, 2000);
  res = await withCsrf('post', '/accounting/commissions/generate', {});
  assert.equal(res.status, 302);
  const { rows } = await q('SELECT * FROM commissions ORDER BY id');
  assert.equal(rows.length, 2);
  const c1 = rows.find(r => r.order_id === o1), c2 = rows.find(r => r.order_id === o2);
  assert.equal(c1.sales_user_id, users.sales1);
  assert.equal(parseFloat(c1.amount), 100);
  assert.equal(c2.sales_user_id, users.sales2);
  assert.equal(parseFloat(c2.amount), 200);
});

test('commissions: salesperson sees only own rows; other routes forbidden', async () => {
  const { agent } = await loginAgent('s1@test');
  const page = await agent.get('/commissions');
  assert.equal(page.status, 200);
  assert.match(page.text, /100/);
  assert.doesNotMatch(page.text, /200 ج\.م|>200</);
  // no cross-user data: only own order id appears
  const ownOrders = (await q('SELECT order_id FROM commissions WHERE sales_user_id=$1', [users.sales1])).rows.map(r => r.order_id);
  const otherOrders = (await q('SELECT order_id FROM commissions WHERE sales_user_id<>$1', [users.sales1])).rows.map(r => r.order_id);
  for (const oid of otherOrders) assert.ok(!page.text.includes('/orders/' + oid), 'other salesperson order leaked');
  assert.ok(ownOrders.every(oid => page.text.includes('/orders/' + oid)));
  // sales cannot access accounting panel or manage
  assert.notEqual((await agent.get('/accounting/commissions')).status, 200);
  const { agent: agent2 } = await loginAgent('s2@test');
  const page2 = await agent2.get('/commissions');
  assert.ok(!page2.text.includes('/orders/' + ownOrders[0]), 'sales1 order leaked to sales2');
  // reception has no commission access at all
  const { agent: agent3 } = await loginAgent('rc@test');
  assert.notEqual((await agent3.get('/commissions')).status, 200);
});

test('commissions: status flow pending -> approved -> paid; regenerate keeps approved untouched', async () => {
  const { withCsrf } = await loginAgent('am@test');
  const row = (await q('SELECT * FROM commissions LIMIT 1')).rows[0];
  let res = await withCsrf('post', `/accounting/commissions/${row.id}/approve`, {});
  assert.equal(res.status, 302);
  // regenerate must not change approved row amount even if rule changes
  await withCsrf('post', '/accounting/commissions/rule', { basis: 'percent_booking', percent: '50', fixed_amount: '' });
  res = await withCsrf('post', '/accounting/commissions/generate', {});
  assert.equal(res.status, 302);
  const after1 = (await q('SELECT * FROM commissions WHERE id=$1', [row.id])).rows[0];
  assert.equal(after1.status, 'approved');
  assert.equal(parseFloat(after1.amount), parseFloat(row.amount));
  res = await withCsrf('post', `/accounting/commissions/${row.id}/pay`, {});
  assert.equal(res.status, 302);
  const after2 = (await q('SELECT * FROM commissions WHERE id=$1', [row.id])).rows[0];
  assert.equal(after2.status, 'paid');
  assert.ok(after2.paid_at);
  // paid row cannot be cancelled
  res = await withCsrf('post', `/accounting/commissions/${row.id}/cancel`, { note: 'x' });
  assert.equal(res.status, 409);
});

test('commissions: fixed rule and percent_collected basis compute correctly', async () => {
  const { withCsrf } = await loginAgent('am@test');
  // fixed
  await withCsrf('post', '/accounting/commissions/rule', { basis: 'fixed', percent: '', fixed_amount: '75' });
  const o3 = await makeOrder(users.sales1, 5000);
  await withCsrf('post', '/accounting/commissions/generate', {});
  const c3 = (await q('SELECT * FROM commissions WHERE order_id=$1', [o3])).rows[0];
  assert.equal(parseFloat(c3.amount), 75);
  // percent_collected on a new order with one active payment of 400 of 1000 at 25%
  await withCsrf('post', '/accounting/commissions/rule', { basis: 'percent_collected', percent: '25', fixed_amount: '' });
  const o4 = await makeOrder(users.sales2, 1000);
  const acc = (await q(`INSERT INTO financial_accounts (name, type) VALUES ('خزنة تست','cash') RETURNING id`)).rows[0].id;
  await q(`INSERT INTO payments (order_id, account_id, amount, method) VALUES ($1,$2,400,'cash')`, [o4, acc]);
  await withCsrf('post', '/accounting/commissions/generate', {});
  const c4 = (await q('SELECT * FROM commissions WHERE order_id=$1', [o4])).rows[0];
  assert.equal(parseFloat(c4.basis_amount), 400);
  assert.equal(parseFloat(c4.amount), 100);
  // a second payment updates the still-pending row
  await q(`INSERT INTO payments (order_id, account_id, amount, method) VALUES ($1,$2,200,'cash')`, [o4, acc]);
  await withCsrf('post', '/accounting/commissions/generate', {});
  const c4b = (await q('SELECT * FROM commissions WHERE order_id=$1', [o4])).rows[0];
  assert.equal(parseFloat(c4b.basis_amount), 600);
  assert.equal(parseFloat(c4b.amount), 150);
});

test('commissions: accounting staff can view but not manage', async () => {
  const { agent, withCsrf } = await loginAgent('as@test');
  assert.equal((await agent.get('/accounting/commissions')).status, 200);
  const res = await withCsrf('post', '/accounting/commissions/rule', { basis: 'fixed', percent: '', fixed_amount: '10' });
  assert.notEqual(res.status, 302);
});
