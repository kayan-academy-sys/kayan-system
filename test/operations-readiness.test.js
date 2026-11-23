const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
const {q,pool,migrate,resetDb,seedUsers,loginAgent}=require('./helpers');
let ids;
before(async()=>{await migrate();await resetDb();ids=await seedUsers();});after(()=>pool.end());
test('financial entry rejects ambiguous amounts, invalid dates, inactive accounts and fake ids',async()=>{
 const a=await loginAgent('am@test');
 const type=(await q('SELECT id FROM expense_types LIMIT 1')).rows[0].id;
 const inactive=(await q("INSERT INTO financial_accounts(name,type,active) VALUES('inactive-readiness','cash',false) ON CONFLICT(name) DO UPDATE SET active=false RETURNING id")).rows[0].id;
 for(const amount of ['1abc','1.001','Infinity','1e3','-1','0']){
  assert.equal((await a.withCsrf('post','/accounting/expenses',{type_id:type,amount,expense_date:'2026-11-23',account_id:1})).status,400);
  assert.equal((await a.withCsrf('post','/accounting/transfers',{from_account_id:1,to_account_id:2,amount,transfer_date:'2026-11-23'})).status,400);
 }
 for(const account_id of [inactive,999999])assert.equal((await a.withCsrf('post','/accounting/expenses',{type_id:type,amount:'10',expense_date:'2026-11-23',account_id})).status,400);
 assert.equal((await a.withCsrf('post','/accounting/expenses',{type_id:type,amount:'10',expense_date:'2026-02-30',account_id:1})).status,400);
 assert.equal((await a.withCsrf('post','/accounting/transfers',{from_account_id:'01',to_account_id:'1',amount:'10',transfer_date:'2026-11-23'})).status,400);
 assert.equal((await q('SELECT count(*) AS n FROM expenses')).rows[0].n,'0');
 assert.equal((await q('SELECT count(*) AS n FROM transfers')).rows[0].n,'0');
});
test('all primary roles can open intended landing page without template/server failure',async()=>{
 for(const [email,path] of [['admin@test','/admin/backup'],['gs@test','/reports'],['sm@test','/leads/distribution'],['tl@test','/leads/monitor'],['s1@test','/orders'],['am@test','/accounting'],['as@test','/accounting'],['rc@test','/reception'],['cm@test','/groups']]){
  const a=await loginAgent(email);const r=await a.agent.get(path);assert.equal(r.status,200,email+' '+path);
 }
});
test('ordinary sales denied accounting, backup, finance report and user management server-side',async()=>{
 const a=await loginAgent('s1@test');
 for(const path of ['/admin/backup','/admin/backup/download','/admin/users','/accounting','/accounting/expenses','/accounting/transfers','/reports/finance'])assert.equal((await a.agent.get(path)).status,403,path);
});
