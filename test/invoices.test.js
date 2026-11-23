const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
const {q,pool,migrate,resetDb,seedUsers,loginAgent}=require('./helpers');
before(async()=>{await migrate();await resetDb();await seedUsers();await q(require("fs").readFileSync(require("path").join(__dirname,"../migrations/010_invoices.sql"),"utf8").split("INSERT INTO settings").slice(1).map(x=>"INSERT INTO settings"+x).join(""))});after(()=>pool.end());
test('receipt draft snapshots terms, ignores caller terms, blocks confirmation and unauthorized master edits',async()=>{
 const a=await loginAgent('as@test');
 const before=(await q("SELECT value FROM settings WHERE key='invoice_terms'")).rows[0].value;
 const r=await a.withCsrf('post','/accounting/invoices',{customer_name:'عميل تجريبي وهمي',customer_mobile:'غير حقيقي',amount_pounds:'500',amount_piastres:'25',purpose:'كورس تجريبي وهمي',offer_type:'تجريبي',terms:'untrusted override'});assert.equal(r.status,302);
 const i=(await q('SELECT * FROM invoices ORDER BY id DESC LIMIT 1')).rows[0];assert.equal(i.terms,before);assert.equal(i.status,'draft');
 assert.equal((await a.withCsrf('post',`/accounting/invoices/${i.id}/confirm`,{})).status,409);
 assert.equal((await a.withCsrf('post','/admin/invoice-terms',{terms:'not allowed'})).status,403);
 const admin=await loginAgent('admin@test');assert.equal((await admin.withCsrf('post','/admin/invoice-terms',{terms:'بنود جديدة للاختبار فقط'})).status,302);
 assert.equal((await q('SELECT terms FROM invoices WHERE id=$1',[i.id])).rows[0].terms,before);
 assert.equal((await q("SELECT value FROM settings WHERE key='invoice_terms'")).rows[0].value,'بنود جديدة للاختبار فقط');
 const page=await a.agent.get('/accounting/invoices/'+i.id);assert.equal(page.status,200);assert.match(page.text,/مسودة/);assert.match(page.text,/خمسمائة/);
 // Restore master for other isolated test processes and preview rendering.
 await q("UPDATE settings SET value=to_jsonb($1::text) WHERE key='invoice_terms'",[before]);
});
test('receipt serials are unique; decimal pounds rejected; no financial mutation',async()=>{
 const a=await loginAgent('as@test');const b={customer_name:'عميل وهمي',amount_pounds:'10.5',purpose:'اختبار'};
 assert.equal((await a.withCsrf('post','/accounting/invoices',b)).status,400);
 assert.equal((await q('SELECT count(*) AS c FROM payments')).rows[0].c,'0');
 assert.equal((await q('SELECT count(*) AS c FROM expenses')).rows[0].c,'0');
 const rc=await loginAgent('rc@test');assert.equal((await rc.agent.get('/accounting/invoices')).status,403);
});

test('accounting confirms synthetic receipt exactly once; only attributed salesperson can read it',async()=>{
 process.env.PREVIEW_GATE_REQUIRED='1';
 // Gate disabled only within this isolated local test app via signed test gate cookie would be unnecessary;
 // set it after draft creation for confirmation authorization, but middleware gate also needs bypass.
 process.env.PREVIEW_GATE_REQUIRED='0';
 const ids=(await q("SELECT id,email FROM users WHERE email IN ('s1@test','s2@test')")).rows;const s1=ids.find(x=>x.email==='s1@test').id;
 const cust=(await q("INSERT INTO customers(name,phone) VALUES('عميل ربط وهمي','TST-ORDER') RETURNING id")).rows[0].id;
 const course=(await q('SELECT id FROM courses LIMIT 1')).rows[0].id;
 const order=(await q("INSERT INTO sales_orders(customer_id,kind,course_id,total_price,payment_type,sales_user_id,status) VALUES($1,'course',$2,1000,'cash',$3,'approved') RETURNING id",[cust,course,s1])).rows[0].id;
 const account=(await q('SELECT id FROM financial_accounts LIMIT 1')).rows[0].id;
 const payment=(await q("INSERT INTO payments(order_id,amount,method,account_id) VALUES($1,100,'cash',$2) RETURNING id",[order,account])).rows[0].id;
 const a=await loginAgent('as@test');
 const r=await a.withCsrf('post','/accounting/invoices',{payment_id:payment,customer_name:'لا يؤخذ هذا الاسم',purpose:'تجريبي',amount_pounds:'100',order_id:order});assert.equal(r.status,302);
 const inv=(await q('SELECT * FROM invoices WHERE order_id=$1',[order])).rows[0];assert.equal(inv.customer_name,'عميل ربط وهمي');assert.equal(inv.sales_user_id,s1);
 const before=(await q('SELECT count(*) AS c FROM notifications')).rows[0].c;
 const sales=await loginAgent('s1@test');assert.equal((await sales.agent.get('/accounting/invoices/'+inv.id)).status,404);
 assert.equal((await sales.withCsrf('post',`/accounting/invoices/${inv.id}/confirm`,{})).status,403);
 // Local-only synthetic fixture and signed preview gate cookie, no live grant changes.
 await q('UPDATE invoices SET synthetic=true WHERE id=$1',[inv.id]);
 const crypto=require('crypto');process.env.PREVIEW_GATE_PASS='test-gate-only';process.env.PREVIEW_GATE_REQUIRED='1';
 const ts=String(Date.now());const sig=crypto.createHmac('sha256','test-gate-only').update('kayan-gate-v1.'+ts).digest('hex');
 a.agent.jar.setCookie('kayan_gate='+ts+'.'+sig+'; Path=/');sales.agent.jar.setCookie('kayan_gate='+ts+'.'+sig+'; Path=/');
 try{
  assert.equal((await a.withCsrf('post',`/accounting/invoices/${inv.id}/confirm`,{})).status,302);
  assert.equal((await a.withCsrf('post',`/accounting/invoices/${inv.id}/confirm`,{})).status,302);
  assert.equal(Number((await q('SELECT count(*) AS c FROM notifications')).rows[0].c),Number(before)+1);
  assert.equal((await sales.agent.get('/accounting/invoices/'+inv.id)).status,200);
 }finally{process.env.PREVIEW_GATE_REQUIRED='0';delete process.env.PREVIEW_GATE_PASS;}
 const other=await loginAgent('s2@test');assert.equal((await other.agent.get('/accounting/invoices/'+inv.id)).status,404);
});

test('failed delivery transaction leaves draft and no notification',async()=>{
 const inv=(await q("SELECT * FROM invoices WHERE status='confirmed' LIMIT 1")).rows[0];
 const payment=(await q("INSERT INTO payments(order_id,amount,method,account_id) SELECT order_id,50,method,account_id FROM payments WHERE id=$1 RETURNING id",[inv.payment_id])).rows[0].id;
 const id=(await q("INSERT INTO invoices(customer_name,amount_pounds,purpose,terms,terms_version,order_id,sales_user_id,synthetic,payment_id) VALUES('وهمي',50,'اختبار','بنود',1,$1,$2,true,$3) RETURNING id",[inv.order_id,inv.sales_user_id,payment])).rows[0].id;
 const a=await loginAgent('as@test');process.env.PREVIEW_GATE_REQUIRED='1';process.env.PREVIEW_GATE_PASS='test-gate-only';
 const crypto=require('crypto'),ts=String(Date.now()),sig=crypto.createHmac('sha256','test-gate-only').update('kayan-gate-v1.'+ts).digest('hex');a.agent.jar.setCookie('kayan_gate='+ts+'.'+sig+'; Path=/');
 await q(`CREATE FUNCTION test_reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$`);
 await q('CREATE TRIGGER test_reject_notification BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION test_reject_notification()');
 try{assert.equal((await a.withCsrf('post',`/accounting/invoices/${id}/confirm`,{})).status,500);assert.equal((await q('SELECT status FROM invoices WHERE id=$1',[id])).rows[0].status,'draft');}
 finally{await q('DROP TRIGGER test_reject_notification ON notifications');await q('DROP FUNCTION test_reject_notification()');process.env.PREVIEW_GATE_REQUIRED='0';delete process.env.PREVIEW_GATE_PASS;}
});

test('payment-linked receipt uses payment amount, refuses duplicates and voided collections',async()=>{
 const a=await loginAgent('as@test');const base=(await q('SELECT * FROM payments LIMIT 1')).rows[0];
 const pid=(await q("INSERT INTO payments(order_id,amount,method,account_id) VALUES($1,123.45,'cash',$2) RETURNING id",[base.order_id,base.account_id])).rows[0].id;
 const before=await q("SELECT sum(amount) AS s,count(*) AS n FROM payments WHERE status='active'");
 const body={payment_id:pid,customer_name:'forged',amount_pounds:999,amount_piastres:99,purpose:'اختبار ربط التحصيل'};
 const pair=await Promise.all([a.withCsrf('post','/accounting/invoices',body),a.withCsrf('post','/accounting/invoices',body)]);
 assert.deepEqual(pair.map(x=>x.status).sort(),[302,409]);
 const inv=(await q('SELECT * FROM invoices WHERE payment_id=$1',[pid])).rows[0];assert.equal(inv.amount_pounds,123);assert.equal(inv.amount_piastres,45);assert.notEqual(inv.customer_name,'forged');
 assert.deepEqual((await q("SELECT sum(amount) AS s,count(*) AS n FROM payments WHERE status='active'")).rows,before.rows);
 await q("UPDATE payments SET status='voided' WHERE id=$1",[pid]);
 assert.equal((await a.withCsrf('post','/accounting/invoices',{payment_id:pid,purpose:'test'})).status,409);
});

test('collection, installment, treasury and receipt reversal reconcile atomically; repeated void is safe',async()=>{
 const acc=await loginAgent('as@test'),mgr=await loginAgent('am@test');
 const base=(await q('SELECT * FROM payments LIMIT 1')).rows[0];
 const order=(await q("INSERT INTO sales_orders(customer_id,kind,course_id,total_price,payment_type,sales_user_id,status) SELECT customer_id,kind,course_id,500,'installments',sales_user_id,'approved' FROM sales_orders WHERE id=$1 RETURNING id",[base.order_id])).rows[0].id;
 const plan=(await q('INSERT INTO installment_plans(order_id,total,down_payment,count) VALUES($1,500,0,1) RETURNING id',[order])).rows[0].id;
 const inst=(await q("INSERT INTO installments(plan_id,seq,amount,due_date,original_due_date) VALUES($1,1,500,current_date,current_date) RETURNING id",[plan])).rows[0].id;
 const {accountBalances}=require('../src/lib/balances');const balance=Number((await accountBalances()).find(x=>x.id===base.account_id).balance);
 const b={order_id:order,installment_id:inst,amount:'500.00',method:'cash',account_id:base.account_id};
 assert.equal((await acc.withCsrf('post','/accounting/payments',b)).status,302);
 const pay=(await q('SELECT * FROM payments WHERE order_id=$1',[order])).rows[0];
 assert.equal((await q('SELECT status FROM installments WHERE id=$1',[inst])).rows[0].status,'paid');
 assert.equal(Number((await accountBalances()).find(x=>x.id===base.account_id).balance),balance+500);
 assert.equal((await acc.withCsrf('post','/accounting/invoices',{payment_id:pay.id,purpose:'قسط تجريبي'})).status,302);
 const inv=(await q('SELECT * FROM invoices WHERE payment_id=$1',[pay.id])).rows[0];
 await q('UPDATE invoices SET synthetic=true WHERE id=$1',[inv.id]);
 const crypto=require('crypto'),ts=String(Date.now());process.env.PREVIEW_GATE_PASS='test-gate-only';process.env.PREVIEW_GATE_REQUIRED='1';
 const cookie='kayan_gate='+ts+'.'+crypto.createHmac('sha256','test-gate-only').update('kayan-gate-v1.'+ts).digest('hex')+'; Path=/';acc.agent.jar.setCookie(cookie);mgr.agent.jar.setCookie(cookie);
 try{
  assert.equal((await acc.withCsrf('post',`/accounting/invoices/${inv.id}/confirm`,{})).status,302);
  assert.equal(Number((await accountBalances()).find(x=>x.id===base.account_id).balance),balance+500);
  assert.equal((await acc.withCsrf('post',`/accounting/payments/${pay.id}/void`,{reason:'forbidden'})).status,403);
  await q(`CREATE FUNCTION test_reject_invoice_void() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='voided' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END; $$`);
  await q('CREATE TRIGGER test_reject_invoice_void BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION test_reject_invoice_void()');
  try{
   assert.equal((await mgr.withCsrf('post',`/accounting/payments/${pay.id}/void`,{reason:'اختبار فشل'})).status,500);
   assert.equal((await q('SELECT status FROM payments WHERE id=$1',[pay.id])).rows[0].status,'active');
   assert.equal((await q('SELECT status FROM invoices WHERE id=$1',[inv.id])).rows[0].status,'confirmed');
   assert.equal((await q('SELECT status FROM installments WHERE id=$1',[inst])).rows[0].status,'paid');
  }finally{await q('DROP TRIGGER test_reject_invoice_void ON invoices');await q('DROP FUNCTION test_reject_invoice_void()');}
  const res=await Promise.all([mgr.withCsrf('post',`/accounting/payments/${pay.id}/void`,{reason:'إلغاء تجريبي'}),mgr.withCsrf('post',`/accounting/payments/${pay.id}/void`,{reason:'تكرار'})]);assert.ok(res.every(x=>x.status===302));
  assert.equal((await q('SELECT status FROM invoices WHERE id=$1',[inv.id])).rows[0].status,'voided');
  assert.equal((await q('SELECT status FROM installments WHERE id=$1',[inst])).rows[0].status,'pending');
  assert.equal(Number((await accountBalances()).find(x=>x.id===base.account_id).balance),balance);
  assert.equal((await acc.withCsrf('post',`/accounting/invoices/${inv.id}/confirm`,{})).status,409);
 }finally{process.env.PREVIEW_GATE_REQUIRED='0';delete process.env.PREVIEW_GATE_PASS;}
 const sales=await loginAgent('s1@test');assert.match((await sales.agent.get('/accounting/invoices/'+inv.id)).text,/إيصال ملغي/);
 assert.equal((await q("SELECT count(*) AS n FROM audit_log WHERE action='payment_voided' AND entity_id=$1",[String(pay.id)])).rows[0].n,'1');
 const foreign=(await q('SELECT id FROM sales_orders WHERE id<>$1 LIMIT 1',[order])).rows[0].id;
 assert.equal((await acc.withCsrf('post','/accounting/payments',{...b,order_id:foreign,amount:'1'})).status,400);
 assert.equal((await acc.withCsrf('post','/accounting/payments',{...b,amount:'500.001'})).status,400);
});

test('paid booking cannot be cancelled; resolved booking cancellation is idempotent',async()=>{
 const mgr=await loginAgent('am@test');const p=(await q("SELECT * FROM payments WHERE status='active' LIMIT 1")).rows[0];
 assert.equal((await mgr.withCsrf('post',`/orders/${p.order_id}/cancel`,{reason:'اختبار منع الإلغاء'})).status,409);
 assert.equal((await q('SELECT status FROM sales_orders WHERE id=$1',[p.order_id])).rows[0].status,'approved');
 const o=(await q("INSERT INTO sales_orders(customer_id,kind,course_id,total_price,payment_type,sales_user_id,status) SELECT customer_id,kind,course_id,500,'cash',sales_user_id,'approved' FROM sales_orders WHERE id=$1 RETURNING id",[p.order_id])).rows[0].id;
 const r=await Promise.all([mgr.withCsrf('post',`/orders/${o}/cancel`,{reason:'إلغاء وهمي'}),mgr.withCsrf('post',`/orders/${o}/cancel`,{reason:'تكرار'})]);assert.ok(r.every(x=>x.status===302));
 assert.equal((await q("SELECT count(*) AS n FROM audit_log WHERE action='order_cancelled' AND entity_id=$1",[String(o)])).rows[0].n,'1');
});

test('sales customer lookup cannot bypass ownership; disabling user revokes session without crashing',async()=>{
 const a=await loginAgent('s1@test'),b=await loginAgent('s2@test');
 const customer=(await q("SELECT id FROM customers WHERE name='عميل ربط وهمي'")).rows[0].id;
 assert.equal((await a.agent.get('/customers/'+customer)).status,200);
 assert.equal((await b.agent.get('/customers/'+customer)).status,404);
 assert.doesNotMatch((await b.agent.get('/customers?q=TST-ORDER')).text,/عميل ربط وهمي/);
 assert.equal((await b.withCsrf('post',`/customers/${customer}/edit`,{name:'bad',phone:'bad'})).status,403);
 await q("UPDATE users SET active=false WHERE email='s2@test'");
 const revoked=await b.agent.get('/');assert.equal(revoked.status,302);assert.match(revoked.headers.location,/login/);
});

test('booking from a lead preserves assigned salesperson and hides another salespersons lead',async()=>{
 const sm=await loginAgent('sm@test'),staff=await loginAgent('s1@test');
 const cust=(await q("INSERT INTO customers(name,phone) VALUES('اختبار إسناد وهمي','ATTR-TEST') RETURNING id")).rows[0].id;
 const u=(await q("SELECT id FROM users WHERE email='s1@test'")).rows[0].id;const course=(await q('SELECT id FROM courses LIMIT 1')).rows[0].id;
 const lead=(await q("INSERT INTO leads(customer_id,source,assigned_to,course_id) VALUES($1,'manual',$2,$3) RETURNING id",[cust,u,course])).rows[0].id;
 assert.equal((await sm.withCsrf('post','/orders',{lead_id:lead,kind:'course',course_id:course,payment_type:'cash'})).status,302);
 assert.equal((await q('SELECT sales_user_id FROM sales_orders WHERE lead_id=$1',[lead])).rows[0].sales_user_id,u);
 const other=(await q("SELECT id FROM users WHERE email='s2@test'")).rows[0].id;await q('UPDATE leads SET assigned_to=$1 WHERE id=$2',[other,lead]);
 assert.equal((await staff.agent.get('/orders/new?lead_id='+lead)).status,404);
 const denied=await staff.withCsrf('post','/orders',{lead_id:lead,kind:'course',course_id:course,payment_type:'cash'});assert.equal(denied.status,404);assert.doesNotMatch(denied.text,/اختبار إسناد وهمي/);
});

test('finance totals include records beyond detail cap; export refuses truncated results',async()=>{
 const mgr=await loginAgent('am@test');const p=(await q('SELECT * FROM payments LIMIT 1')).rows[0];
 await q("INSERT INTO payments(order_id,amount,method,account_id) SELECT $1,1,'cash',$2 FROM generate_series(1,2001)",[p.order_id,p.account_id]);
 const total=Number((await q("SELECT sum(amount) AS n FROM payments WHERE status='active'")).rows[0].n);
 const page=await mgr.agent.get('/reports/finance');assert.equal(page.status,200);assert.match(page.text,/الإجماليات تشمل كل الحركات/);assert.ok(page.text.includes(total.toLocaleString('ar-EG')));
 assert.equal((await mgr.agent.get('/reports/finance?format=csv')).status,400);
});

test('manual JSON export is a complete transactional snapshot restricted to backup role',async()=>{
 const admin=await loginAgent('admin@test'),staff=await loginAgent('as@test');
 assert.equal((await staff.agent.get('/admin/backup/download')).status,403);
 const r=await admin.agent.get('/admin/backup/download');assert.equal(r.status,200);assert.equal(r.body.app,'kayan-system');
 assert.equal(r.body.tables.payments.length,Number((await q('SELECT count(*) AS n FROM payments')).rows[0].n));
 assert.ok(r.body.tables.users);assert.ok(r.body.tables.invoices);assert.ok(r.headers['content-disposition'].includes('attachment'));
});

test('opening balance is privileged once-only setup, not revenue; existing movements block it',async()=>{
 const mgr=await loginAgent('am@test'),staff=await loginAgent('as@test');
 const id=(await q("INSERT INTO financial_accounts(name,type) VALUES('افتتاح وهمي','cash') RETURNING id")).rows[0].id;
 assert.equal((await staff.withCsrf('post',`/accounting/accounts/${id}/opening`,{amount:'500',notes:'no'})).status,403);
 const pair=await Promise.all([mgr.withCsrf('post',`/accounting/accounts/${id}/opening`,{amount:'500.25',notes:'مطابقة وهمية'}),mgr.withCsrf('post',`/accounting/accounts/${id}/opening`,{amount:'500.25',notes:'تكرار'})]);assert.deepEqual(pair.map(x=>x.status).sort(),[302,409]);
 const {accountBalances}=require('../src/lib/balances');assert.equal(Number((await accountBalances()).find(x=>x.id===id).balance),500.25);
 assert.equal((await q('SELECT count(*) AS n FROM payments WHERE account_id=$1',[id])).rows[0].n,'0');
 const active=(await q('SELECT account_id FROM payments LIMIT 1')).rows[0].account_id;
 assert.equal((await mgr.withCsrf('post',`/accounting/accounts/${active}/opening`,{amount:'100',notes:'late'})).status,409);
});

test('installment allocation required after down payment; request key prevents double-click collections',async()=>{
 const acc=await loginAgent('as@test');const base=(await q('SELECT * FROM payments LIMIT 1')).rows[0];
 const order=(await q("INSERT INTO sales_orders(customer_id,kind,course_id,total_price,payment_type,sales_user_id,status) SELECT customer_id,kind,course_id,1000,'installments',sales_user_id,'approved' FROM sales_orders WHERE id=$1 RETURNING id",[base.order_id])).rows[0].id;
 const plan=(await q('INSERT INTO installment_plans(order_id,total,down_payment,count) VALUES($1,1000,100,1) RETURNING id',[order])).rows[0].id;
 const inst=(await q('INSERT INTO installments(plan_id,seq,amount,due_date,original_due_date) VALUES($1,1,900,current_date,current_date) RETURNING id',[plan])).rows[0].id;
 const body={order_id:order,amount:'100',method:'cash',account_id:base.account_id,request_key:require('crypto').randomUUID()};
 const r=await Promise.all([acc.withCsrf('post','/accounting/payments',body),acc.withCsrf('post','/accounting/payments',body)]);assert.ok(r.every(x=>x.status===302));
 assert.equal((await q('SELECT count(*) AS n FROM payments WHERE order_id=$1',[order])).rows[0].n,'1');
 assert.equal((await acc.withCsrf('post','/accounting/payments',{...body,request_key:undefined,amount:'50'})).status,400);
 assert.equal((await acc.withCsrf('post','/accounting/payments',{...body,request_key:require('crypto').randomUUID(),installment_id:inst,amount:'50'})).status,302);
 assert.equal((await acc.withCsrf('post','/accounting/payments',{...body,amount:'99'})).status,409);
});

test('preview on-use catchup serializes concurrent runs and suppresses immediate repeats',async()=>{
 await q("DELETE FROM job_runs WHERE job='preview_catchup_complete'");const {catchUpIfDue}=require('../src/lib/automation');
 const a=await Promise.all([catchUpIfDue(),catchUpIfDue()]);assert.ok(a.some(x=>x.skipped==='busy'||x.skipped==='recent'));
 assert.equal((await q("SELECT count(*) AS n FROM job_runs WHERE job='preview_catchup_complete'")).rows[0].n,'1');
 assert.equal((await catchUpIfDue()).skipped,'recent');
});

test('fictional XLSX parser and importer validate totals, restrict role, roll back failures and dedupe',async()=>{
 const fs=require('fs');const {parseWorkbook}=require('../src/routes/import-preview');const {importSynthetic,validate}=require('../src/lib/synthetic-import');
 const data=await parseWorkbook(fs.readFileSync(require('path').join(__dirname,'fixtures/kayan-fictional-import.xlsx')));assert.deepEqual(validate(data),{students:6,orders:6,collected:6000,total:30000});
 const ids=(await q("SELECT id,email FROM users WHERE email IN ('admin@test','as@test','s1@test')")).rows;const get=e=>ids.find(x=>x.email===e).id;
 const account=(await q('SELECT id FROM financial_accounts LIMIT 1')).rows[0].id;
 await assert.rejects(()=>importSynthetic(data,{actorId:get('as@test'),salesId:get('s1@test'),accountId:account,preview:true}));
 const bad=structuredClone(data);bad['الحجوزات'][0].total=1;assert.throws(()=>validate(bad));
 const r=await importSynthetic(data,{actorId:get('admin@test'),salesId:get('s1@test'),accountId:account,preview:true});assert.equal(r.summary.total,30000);
 assert.equal((await importSynthetic(data,{actorId:get('admin@test'),salesId:get('s1@test'),accountId:account,preview:true})).duplicate,true);
 assert.equal((await q("SELECT count(*) AS n FROM customers WHERE phone LIKE 'TEST-EXCEL-%'")).rows[0].n,'6');
 assert.equal((await q("SELECT sum(amount) AS n FROM payments WHERE notes LIKE 'استيراد إكسيل وهمي%'")).rows[0].n,'6000.00');
 const changed=structuredClone(data);changed['الطلاب'][0].name+=' معدل';await assert.rejects(()=>importSynthetic(changed,{actorId:get('admin@test'),salesId:get('s1@test'),accountId:account,preview:true}));
 assert.equal((await q('SELECT count(*) AS n FROM preview_import_batches')).rows[0].n,'1');
});

test('class assignment serializes last seat; attendance rejects cross-group, cancelled and future writes atomically',async()=>{
 const rows=(await q("SELECT e.* FROM enrollments e JOIN customers c ON c.id=e.customer_id WHERE c.phone LIKE 'TEST-EXCEL-%' ORDER BY e.id LIMIT 3")).rows;
 const gid=(await q("INSERT INTO groups(course_id,name,capacity,status) VALUES($1,'فصل وهمي لسعة وحضور',1,'open') RETURNING id",[rows[0].course_id])).rows[0].id;
 const {assignGroup}=require('../src/lib/group-assignment');
 const result=await Promise.allSettled(rows.slice(0,2).map(e=>assignGroup({groupId:gid,enrollmentId:e.id})));
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);
 const adminClass=await loginAgent('admin@test');
 const edit={name:'فصل وهمي لسعة وحضور',capacity:'0',status:'open'};
 assert.equal((await adminClass.withCsrf('post',`/groups/${gid}/edit`,edit)).status,400);
 const third=rows.find(x=>!result[rows.indexOf(x)]||result[rows.indexOf(x)].status==='rejected');
 await q('UPDATE groups SET capacity=2 WHERE id=$1',[gid]);await assignGroup({groupId:gid,enrollmentId:third.id});
 assert.equal((await adminClass.withCsrf('post',`/groups/${gid}/edit`,{...edit,capacity:'1'})).status,409);
 const eid=(await q('SELECT id FROM enrollments WHERE group_id=$1 ORDER BY id LIMIT 1',[gid])).rows[0].id;

 assert.equal((await assignGroup({groupId:gid,enrollmentId:eid})).duplicate,true);
 const sid=(await q("INSERT INTO sessions(group_id,session_date,start_time,end_time) VALUES($1,current_date-1,'10:00','12:00') RETURNING id",[gid])).rows[0].id;
 const rc=await loginAgent('rc@test'),sales=await loginAgent('s1@test');
 assert.equal((await sales.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'present'})).status,403);
 const other=rows[2].id;
 assert.equal((await rc.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'present',['att_'+other]:'absent'})).status,400);
 assert.equal((await q('SELECT count(*) AS n FROM attendance WHERE session_id=$1',[sid])).rows[0].n,'0');
 assert.equal((await rc.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'absent'})).status,302);
 assert.equal((await rc.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'late', ['notes_'+eid]:'تصحيح وهمي'})).status,302);
 assert.equal((await q('SELECT status FROM attendance WHERE session_id=$1',[sid])).rows[0].status,'late');
 assert.equal((await q('SELECT count(*) AS n FROM attendance WHERE session_id=$1',[sid])).rows[0].n,'1');
 const logs=(await q("SELECT details FROM audit_log WHERE action='attendance_recorded' AND entity_id=$1 ORDER BY id DESC LIMIT 1",[String(sid)])).rows[0].details;assert.equal(logs.previous[0].status,'absent');assert.equal(logs.updated[0].status,'late');
 await q("UPDATE sessions SET status='cancelled' WHERE id=$1",[sid]);assert.equal((await rc.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'present'})).status,409);
 await q("UPDATE sessions SET status='scheduled',session_date=current_date+1 WHERE id=$1",[sid]);assert.equal((await rc.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'present'})).status,400);
 await q('UPDATE sessions SET session_date=current_date-1 WHERE id=$1',[sid]);await q("UPDATE sales_orders SET status='cancelled' WHERE id=(SELECT order_id FROM enrollments WHERE id=$1)",[eid]);
 assert.equal((await rc.withCsrf('post',`/reception/sessions/${sid}/attendance`,{['att_'+eid]:'present'})).status,400);
});

test('occupancy state updates immediately after capacity, roster moves and cancellation without automation',async()=>{
 const {assignGroup}=require('../src/lib/group-assignment');
 const c=(await q('SELECT id FROM courses ORDER BY id LIMIT 1')).rows[0].id;
 const groups=(await q("INSERT INTO groups(course_id,name,capacity,status) VALUES($1,'حالة فورية أ',1,'open'),($1,'حالة فورية ب',5,'open') RETURNING id",[c])).rows;
 const cu=(await q("INSERT INTO customers(name,phone) VALUES('حالة وهمية','TEST-STATUS') RETURNING id")).rows[0].id;
 const o=(await q("INSERT INTO sales_orders(customer_id,kind,course_id,total_price,payment_type,status,sales_user_id) VALUES($1,'course',$2,10,'cash','approved',$3) RETURNING id",[cu,c,users.sales1])).rows[0].id;
 const e=(await q('INSERT INTO enrollments(order_id,customer_id,course_id) VALUES($1,$2,$3) RETURNING id',[o,cu,c])).rows[0].id;
 const status=async id=>(await q('SELECT status FROM groups WHERE id=$1',[id])).rows[0].status;
 await assignGroup({groupId:groups[0].id,enrollmentId:e});assert.equal(await status(groups[0].id),'full');
 await q('UPDATE groups SET capacity=10 WHERE id=$1',[groups[0].id]);assert.equal(await status(groups[0].id),'open');
 await q('UPDATE groups SET capacity=1 WHERE id=$1',[groups[0].id]);assert.equal(await status(groups[0].id),'full');
 await assignGroup({groupId:groups[1].id,enrollmentId:e,orderId:o});assert.equal(await status(groups[0].id),'nearly_full');assert.equal(await status(groups[1].id),'open');
 await q('UPDATE groups SET capacity=1 WHERE id=$1',[groups[1].id]);assert.equal(await status(groups[1].id),'full');
 const ad=await loginAgent('admin@test');assert.equal((await ad.withCsrf('post',`/orders/${o}/cancel`,{reason:'اختبار وهمي'})).status,302);assert.equal(await status(groups[1].id),'nearly_full');
 await q("UPDATE groups SET status='running' WHERE id=$1",[groups[1].id]);await q('UPDATE groups SET capacity=20 WHERE id=$1',[groups[1].id]);assert.equal(await status(groups[1].id),'running');
});
