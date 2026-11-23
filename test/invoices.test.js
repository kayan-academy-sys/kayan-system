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
