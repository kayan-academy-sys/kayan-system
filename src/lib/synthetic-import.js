const crypto=require('crypto');
const {tx}=require('../db');
function validate(data){
 const students=data['الطلاب'],courses=data['الكورسات'],orders=data['الحجوزات'],payments=data['التحصيلات'],installments=data['الأقساط'];
 if(![students,courses,orders,payments,installments].every(Array.isArray))throw Error('أوراق الملف المطلوبة غير مكتملة');
 if(students.length>100||orders.length>100||payments.length>100||installments.length>1000)throw Error('تجاوز حد تجربة الاستيراد');
 const unique=(rows,key)=>{const v=rows.map(r=>r[key]);if(v.some(x=>!x)||new Set(v).size!==v.length)throw Error('كود ناقص أو مكرر: '+key);};
 unique(students,'student_code');unique(students,'phone');unique(courses,'course_code');unique(courses,'name');unique(orders,'order_code');unique(payments,'payment_code');
 for(const rows of [students,courses,orders,payments,installments])for(const r of rows)if(r.scope!=='وهمي')throw Error('المستورد مخصص للبيانات الوهمية فقط');
 const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&!isNaN(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
 const money=x=>Number.isFinite(Number(x))&&Number(x)>=0&&Math.round(Number(x)*100)===Number(x)*100;
 for(const s of students)if(!String(s.phone).startsWith('TEST-EXCEL-')||!String(s.name).includes('وهمي'))throw Error('بيانات طالب ليست وهمية بوضوح');
 for(const c of courses)if(!money(c.price)||Number(c.price)<=0||!String(c.name).includes('وهمي'))throw Error('كورس غير صالح');
 for(const o of orders){const c=courses.find(x=>x.course_code===o.course_code);if(!students.some(x=>x.student_code===o.student_code)||!c||Number(o.total)!==Number(c.price)||!money(o.down_payment)||!Number.isInteger(o.installments_count)||o.installments_count<1||!money(o.installment_amount)||Number(o.down_payment)+o.installments_count*o.installment_amount!==Number(o.total))throw Error('ربط أو مجموع حجز غير صالح');const ii=installments.filter(x=>x.order_code===o.order_code);if(!date(o.first_due_date))throw Error('تاريخ أول قسط غير صالح');if(ii.find(x=>x.seq===1)?.due_date!==o.first_due_date)throw Error('تاريخ أول قسط غير مطابق');if(ii.length!==o.installments_count||new Set(ii.map(x=>x.seq)).size!==ii.length||ii.some(i=>i.amount!==o.installment_amount||!Number.isInteger(i.seq)||i.seq<1||i.seq>o.installments_count||!date(i.due_date)))throw Error('أقساط غير مطابقة');const pp=payments.filter(p=>p.order_code===o.order_code);if(pp.length!==1||pp[0].amount!==o.down_payment||pp[0].method!=='cash')throw Error('تحصيل المقدم غير مطابق');}
 if(payments.some(p=>!orders.some(o=>o.order_code===p.order_code))||installments.some(i=>!orders.some(o=>o.order_code===i.order_code)))throw Error('سجل يتيم');
 return {students:students.length,orders:orders.length,collected:payments.reduce((a,p)=>a+Number(p.amount),0),total:orders.reduce((a,o)=>a+Number(o.total),0)};
}
async function importSynthetic(data,{actorId,salesId,accountId,preview}){
 if(!preview)throw Error('الاستيراد الوهمي ممنوع خارج المعاينة');
 const summary=validate(data),digest=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
 return tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(72819462)');
  const actor=(await c.query("SELECT role FROM users WHERE id=$1 AND active",[actorId])).rows[0];if(actor?.role!=='admin')throw Error('مسؤول النظام فقط');
  const old=(await c.query('SELECT id,summary FROM preview_import_batches WHERE digest=$1',[digest])).rows[0];if(old)return {duplicate:true,...old};
  const sales=(await c.query("SELECT id FROM users WHERE id=$1 AND active AND role IN ('sales_staff','sales_team_leader','sales_manager')",[salesId])).rows[0];if(!sales)throw Error('مستخدم المبيعات غير صالح');
  if(!(await c.query('SELECT id FROM financial_accounts WHERE id=$1 AND active FOR SHARE',[accountId])).rowCount)throw Error('الحساب المالي غير صالح');
  const ss={},cc={},oo={};
  for(const s of data['الطلاب']){if((await c.query('SELECT id FROM customers WHERE phone=$1',[s.phone])).rowCount)throw Error('هاتف موجود مسبقا، لا دمج صامت');ss[s.student_code]=(await c.query('INSERT INTO customers(name,phone,created_by) VALUES($1,$2,$3) RETURNING id',[s.name,s.phone,actorId])).rows[0].id;}
  for(const x of data['الكورسات']){if((await c.query('SELECT id FROM courses WHERE name=$1',[x.name])).rowCount)throw Error('اسم الكورس موجود مسبقا، لا دمج صامت');cc[x.course_code]=(await c.query('INSERT INTO courses(name,base_price) VALUES($1,$2) RETURNING id',[x.name,x.price])).rows[0].id;}
  for(const o of data['الحجوزات']){
   const id=(await c.query("INSERT INTO sales_orders(customer_id,kind,course_id,total_price,payment_type,sales_user_id,status) VALUES($1,'course',$2,$3,'installments',$4,'approved') RETURNING id",[ss[o.student_code],cc[o.course_code],o.total,salesId])).rows[0].id;oo[o.order_code]=id;
   await c.query('INSERT INTO enrollments(order_id,customer_id,course_id) VALUES($1,$2,$3)',[id,ss[o.student_code],cc[o.course_code]]);
   const plan=(await c.query('INSERT INTO installment_plans(order_id,total,down_payment,count,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',[id,o.total,o.down_payment,o.installments_count,actorId])).rows[0].id;
   for(const i of data['الأقساط'].filter(x=>x.order_code===o.order_code))await c.query('INSERT INTO installments(plan_id,seq,amount,due_date,original_due_date) VALUES($1,$2,$3,$4,$4)',[plan,i.seq,i.amount,i.due_date]);
  }
  for(const p of data['التحصيلات'])await c.query("INSERT INTO payments(order_id,amount,method,account_id,received_by,notes) VALUES($1,$2,'cash',$3,$4,$5)",[oo[p.order_code],p.amount,accountId,actorId,'استيراد إكسيل وهمي فقط: '+p.payment_code]);
  const batch=(await c.query('INSERT INTO preview_import_batches(digest,created_by,summary) VALUES($1,$2,$3) RETURNING id',[digest,actorId,JSON.stringify(summary)])).rows[0].id;
  await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'synthetic_excel_import','preview_import_batch',$2,$3)",[actorId,String(batch),JSON.stringify(summary)]);
  return {batch,summary,orders:oo};
 });
}
module.exports={validate,importSynthetic};
