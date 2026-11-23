process.env.TRAINER_WRITES_APPROVED = 'true'; // isolated test process only
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, resetDb, seedUsers, loginAgent } = require('./helpers');
const { accountBalances } = require('../src/lib/balances');

let users;

async function makeTrainerGroup({ status = 'finished', agreed = 1000 } = {}) {
  const tr = (await q(`INSERT INTO trainers (name) VALUES ($1) RETURNING id`, ['محاضر اختبار ' + Math.random()])).rows[0].id;
  const course = (await q(`INSERT INTO courses (name, base_price) VALUES ($1,0) RETURNING id`, ['كورس اختبار ' + Math.random()])).rows[0].id;
  const g = (await q(`INSERT INTO groups (course_id, trainer_id, name, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    [course, tr, 'GRP-TST-' + Math.random().toString(36).slice(2, 10), status])).rows[0].id;
  if (agreed !== null) {
    await q(`INSERT INTO trainer_group_terms (group_id, trainer_id, agreed_amount) VALUES ($1,$2,$3)`, [g, tr, agreed]);
  }
  return { tr, g };
}
async function makeAccount() {
  return (await q(`INSERT INTO financial_accounts (name, type) VALUES ($1,'cash') RETURNING id`, ['خزنة اختبار ' + Math.random()])).rows[0].id;
}
async function bal(accountId) {
  const b = await accountBalances();
  const row = b.find(x => x.id === accountId);
  return row ? row.balance : null;
}
async function payCount(trainerId) {
  return parseInt((await q(`SELECT count(*) AS c FROM trainer_payments WHERE trainer_id=$1 AND status='active'`, [trainerId])).rows[0].c, 10);
}

before(async () => {
  await migrate();
  await resetDb();
  users = await seedUsers();
});

after(async () => { await pool.end(); });

test('trainer payout: creates linked expense atomically and debits chosen account', async () => {
  const { tr, g } = await makeTrainerGroup({ status: 'finished', agreed: 1000 });
  const acc = await makeAccount();
  const { withCsrf } = await loginAgent('as@test'); // موظف حسابات — expenses.create فقط
  const res = await withCsrf('post', '/accounting/trainers/payments', {
    trainer_id: String(tr), group_id: String(g), amount: '400', method: 'cash', account_id: String(acc), notes: 'اختبار آلي'
  });
  assert.equal(res.status, 302);
  const p = (await q(`SELECT * FROM trainer_payments WHERE trainer_id=$1`, [tr])).rows[0];
  assert.ok(p, 'payment row exists');
  assert.equal(p.status, 'active');
  assert.ok(p.expense_id, 'linked to an expense');
  assert.equal(p.account_id, acc);
  const e = (await q(`SELECT e.*, et.name AS type_name FROM expenses e JOIN expense_types et ON et.id=e.type_id WHERE e.id=$1`, [p.expense_id])).rows[0];
  assert.ok(e, 'expense row exists');
  assert.equal(e.type_name, 'مستحقات محاضرين');
  assert.equal(parseFloat(e.amount), 400);
  assert.equal(e.account_id, acc);
  assert.equal(e.status, 'active');
  assert.equal(await bal(acc), -400, 'treasury truth: account debited exactly once');
});

test('trainer payout: advance beyond earned balance is blocked by default', async () => {
  const { tr, g } = await makeTrainerGroup({ status: 'finished', agreed: 1000 });
  const acc = await makeAccount();
  // مدفوع سابق ٤٠٠ → المتاح ٦٠٠
  await q(`INSERT INTO trainer_payments (trainer_id, group_id, amount, method, account_id) VALUES ($1,$2,400,'cash',$3)`, [tr, g, acc]);
  const before = await payCount(tr);
  const { withCsrf } = await loginAgent('as@test');
  const res = await withCsrf('post', '/accounting/trainers/payments', {
    trainer_id: String(tr), group_id: String(g), amount: '600.01', method: 'cash', account_id: String(acc)
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /الدفعات المقدمة موقوفة/);
  assert.equal(await payCount(tr), before, 'no new payment row');
  assert.equal((await q(`SELECT count(*) AS c FROM expenses WHERE account_id=$1`, [acc])).rows[0].c, '0', 'no orphan expense row');
});

test('trainer payout: blocked entirely while group not finished (earned = 0)', async () => {
  const { tr, g } = await makeTrainerGroup({ status: 'open', agreed: 1000 });
  const acc = await makeAccount();
  const { withCsrf } = await loginAgent('as@test');
  const res = await withCsrf('post', '/accounting/trainers/payments', {
    trainer_id: String(tr), group_id: String(g), amount: '100', method: 'cash', account_id: String(acc)
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /الدفعات المقدمة موقوفة/);
  assert.equal(await payCount(tr), 0);
});

test('trainer payout: authorization — staff without expenses.create and without expenses.void are denied', async () => {
  const { tr, g } = await makeTrainerGroup({ status: 'finished', agreed: 1000 });
  const acc = await makeAccount();
  const staff = await loginAgent('as@test');
  const ok = await staff.withCsrf('post', '/accounting/trainers/payments', {
    trainer_id: String(tr), group_id: String(g), amount: '400', method: 'cash', account_id: String(acc)
  });
  assert.equal(ok.status, 302);
  const p = (await q(`SELECT * FROM trainer_payments WHERE trainer_id=$1`, [tr])).rows[0];

  // موظف الاستقبال لا يملك expenses.create → 403
  const rc = await loginAgent('rc@test');
  const denied = await rc.withCsrf('post', '/accounting/trainers/payments', {
    trainer_id: String(tr), group_id: String(g), amount: '50', method: 'cash', account_id: String(acc)
  });
  assert.equal(denied.status, 403);

  // موظف الحسابات لا يملك expenses.void → 403 والصفوف تبقى فعالة
  const voidDenied = await staff.withCsrf('post', `/accounting/trainers/payments/${p.id}/void`, { reason: 'محاولة بلا صلاحية' });
  assert.equal(voidDenied.status, 403);
  const still = (await q(`SELECT status FROM trainer_payments WHERE id=$1`, [p.id])).rows[0];
  assert.equal(still.status, 'active');
  const expStill = (await q(`SELECT status FROM expenses WHERE id=$1`, [p.expense_id])).rows[0];
  assert.equal(expStill.status, 'active');
  assert.equal(await bal(acc), -400);
});

test('trainer payout void: manager voids payment and linked expense atomically with reason', async () => {
  const { tr, g } = await makeTrainerGroup({ status: 'finished', agreed: 1000 });
  const acc = await makeAccount();
  const staff = await loginAgent('as@test');
  const ok = await staff.withCsrf('post', '/accounting/trainers/payments', {
    trainer_id: String(tr), group_id: String(g), amount: '400', method: 'cash', account_id: String(acc)
  });
  assert.equal(ok.status, 302);
  const p = (await q(`SELECT * FROM trainer_payments WHERE trainer_id=$1`, [tr])).rows[0];
  assert.equal(await bal(acc), -400);

  const mgr = await loginAgent('am@test'); // مدير حسابات — يملك expenses.void
  const noReason = await mgr.withCsrf('post', `/accounting/trainers/payments/${p.id}/void`, {});
  assert.equal(noReason.status, 400, 'reason is mandatory');
  const done = await mgr.withCsrf('post', `/accounting/trainers/payments/${p.id}/void`, { reason: 'إلغاء اختباري' });
  assert.equal(done.status, 302);

  const after1 = (await q(`SELECT status, voided_by FROM trainer_payments WHERE id=$1`, [p.id])).rows[0];
  assert.equal(after1.status, 'void');
  assert.equal(after1.voided_by, users.accManager);
  const expAfter = (await q(`SELECT status, void_reason FROM expenses WHERE id=$1`, [p.expense_id])).rows[0];
  assert.equal(expAfter.status, 'voided');
  assert.equal(expAfter.void_reason, 'إلغاء اختباري');
  assert.equal(await bal(acc), 0, 'void restores the account balance');
});

test('trainer accounts page: negative balance shows explicit advance label, not a bare number', async () => {
  const { tr, g } = await makeTrainerGroup({ status: 'finished', agreed: 100 });
  const acc = await makeAccount();
  // حالة دفعة مقدمة قائمة بالفعل (مثل الدفعة التجريبية على المعاينة): مدفوع ١٥٠ > مستحق ١٠٠
  await q(`INSERT INTO trainer_payments (trainer_id, group_id, amount, method, account_id) VALUES ($1,$2,150,'cash',$3)`, [tr, g, acc]);
  const { agent } = await loginAgent('as@test');
  const page = await agent.get('/accounting/trainers');
  assert.equal(page.status, 200);
  assert.match(page.text, /دفعة مقدمة — المدفوع يتجاوز المستحق/, 'per-trainer advance label');
  // البطاقة الإجمالية تعتمد على أرصدة كل المحاضرين في قاعدة الاختبار المشتركة (تتغير مع ملفات اختبار أخرى)،
  // لذلك يُكتفى هنا بتسمية المحاضر المحددة، ويُتحقق بصريًا من التسمية الإجمالية على المعاينة حيث الرصيد الإجمالي سالب.
});

test('concurrent payouts cannot exceed earned balance', async () => {
 const {tr,g}=await makeTrainerGroup({agreed:1000}); const acc=await makeAccount();
 const a=await loginAgent('as@test'), b=await loginAgent('am@test');
 const body={trainer_id:tr,group_id:g,amount:'700',method:'cash',account_id:acc};
 const out=await Promise.all([a.withCsrf('post','/accounting/trainers/payments',body),b.withCsrf('post','/accounting/trainers/payments',body)]);
 assert.deepEqual(out.map(r=>r.status).sort(),[302,400]);
 assert.equal(await payCount(tr),1);
});

test('failure after expense insertion rolls whole payout back', async () => {
 const {tr,g}=await makeTrainerGroup(); const acc=await makeAccount(); const a=await loginAgent('am@test');
 await q(`CREATE OR REPLACE FUNCTION test_reject_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$`);
 await q(`CREATE TRIGGER test_reject_payment BEFORE INSERT ON trainer_payments FOR EACH ROW EXECUTE FUNCTION test_reject_payment()`);
 try {
  const r=await a.withCsrf('post','/accounting/trainers/payments',{trainer_id:tr,group_id:g,amount:'100',method:'cash',account_id:acc});
  assert.equal(r.status,500); assert.equal(await payCount(tr),0);
  assert.equal((await q('SELECT count(*) AS c FROM expenses WHERE account_id=$1',[acc])).rows[0].c,'0');
 } finally {await q('DROP TRIGGER test_reject_payment ON trainer_payments');await q('DROP FUNCTION test_reject_payment()');}
});

test('linked expense cannot be voided independently; failed linked void rolls back', async () => {
 const {tr,g}=await makeTrainerGroup();const acc=await makeAccount();const a=await loginAgent('am@test');
 await a.withCsrf('post','/accounting/trainers/payments',{trainer_id:tr,group_id:g,amount:'100',method:'cash',account_id:acc});
 const p=(await q('SELECT * FROM trainer_payments WHERE trainer_id=$1',[tr])).rows[0];
 const r=await a.withCsrf('post',`/accounting/expenses/${p.expense_id}/void`,{reason:'test'});assert.equal(r.status,409);
 await q(`CREATE OR REPLACE FUNCTION test_reject_void() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='voided' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END; $$`);
 await q('CREATE TRIGGER test_reject_void BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION test_reject_void()');
 try {
  const v=await a.withCsrf('post',`/accounting/trainers/payments/${p.id}/void`,{reason:'test'});assert.equal(v.status,500);
  assert.equal((await q('SELECT status FROM trainer_payments WHERE id=$1',[p.id])).rows[0].status,'active');
  assert.equal((await q('SELECT status FROM expenses WHERE id=$1',[p.expense_id])).rows[0].status,'active');
 } finally {await q('DROP TRIGGER test_reject_void ON expenses');await q('DROP FUNCTION test_reject_void()');}
});
