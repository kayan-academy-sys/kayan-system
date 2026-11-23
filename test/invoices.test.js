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
 const a=await loginAgent('as@test');
 const r=await a.withCsrf('post','/accounting/invoices',{customer_name:'لا يؤخذ هذا الاسم',purpose:'تجريبي',amount_pounds:'100',order_id:order});assert.equal(r.status,302);
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
 const id=(await q("INSERT INTO invoices(customer_name,amount_pounds,purpose,terms,terms_version,order_id,sales_user_id,synthetic) VALUES('وهمي',50,'اختبار','بنود',1,$1,$2,true) RETURNING id",[inv.order_id,inv.sales_user_id])).rows[0].id;
 const a=await loginAgent('as@test');process.env.PREVIEW_GATE_REQUIRED='1';process.env.PREVIEW_GATE_PASS='test-gate-only';
 const crypto=require('crypto'),ts=String(Date.now()),sig=crypto.createHmac('sha256','test-gate-only').update('kayan-gate-v1.'+ts).digest('hex');a.agent.jar.setCookie('kayan_gate='+ts+'.'+sig+'; Path=/');
 await q(`CREATE FUNCTION test_reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$`);
 await q('CREATE TRIGGER test_reject_notification BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION test_reject_notification()');
 try{assert.equal((await a.withCsrf('post',`/accounting/invoices/${id}/confirm`,{})).status,500);assert.equal((await q('SELECT status FROM invoices WHERE id=$1',[id])).rows[0].status,'draft');}
 finally{await q('DROP TRIGGER test_reject_notification ON notifications');await q('DROP FUNCTION test_reject_notification()');process.env.PREVIEW_GATE_REQUIRED='0';delete process.env.PREVIEW_GATE_PASS;}
});
