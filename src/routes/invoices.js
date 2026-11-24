const {receiptReleaseAllowed}=require('../lib/receipt-release');
const express=require('express');
const {q,tx}=require('../db');
const {requireAuth,requireCap}=require('../middleware/auth');
const {audit}=require('../lib/audit');
const {can}=require('../lib/permissions');
const isAccounting=u=>can(u.roles,'expenses.create')||can(u.roles,'expenses.view');
const isSales=u=>u.roles.some(r=>['sales_staff','sales_team_leader','sales_manager'].includes(r));
const {amountInWords}=require('../lib/tafqeet');
const router=express.Router();
router.use(requireAuth,(req,res,next)=>process.env.RECEIPTS_ENABLED==='true'?next():res.sendStatus(404));
router.use((req,res,next)=>isAccounting(req.user)||isSales(req.user)?next():res.status(403).render('error',{title:'غير مسموح',message:'ليس لديك صلاحية.'}));
router.get('/',async(req,res)=>{
 const rows=(await q("SELECT i.*,u.name AS sales_name FROM invoices i LEFT JOIN users u ON u.id=i.sales_user_id WHERE $1 OR (i.sales_user_id=$2 AND i.status IN ('confirmed','voided')) ORDER BY i.id DESC LIMIT 100",[isAccounting(req.user),req.user.id])).rows;
 const sales=(await q("SELECT id,name FROM users WHERE active AND (role IN ('sales_staff','sales_team_leader','sales_manager') OR extra_roles && ARRAY['sales_staff','sales_team_leader','sales_manager']::text[]) ORDER BY name")).rows;
 const orders=isAccounting(req.user)?(await q("SELECT o.id,c.name AS customer_name,u.name AS sales_name FROM sales_orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN users u ON u.id=o.sales_user_id WHERE o.status='approved' ORDER BY o.id DESC LIMIT 200")).rows:[];
 const payments=isAccounting(req.user)?(await q(`SELECT p.id,p.amount,p.order_id,c.name AS customer_name,u.name AS sales_name FROM payments p JOIN sales_orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id LEFT JOIN users u ON u.id=o.sales_user_id WHERE p.status='active' AND o.status='approved' AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.payment_id=p.id) ORDER BY p.id DESC LIMIT 200`)).rows:[];
 res.render('accounting/invoices',{payments,title:'إيصالات الاستلام',rows,sales,orders,canCreate:can(req.user.roles,'expenses.create')&&process.env.RECEIPT_WRITES_APPROVED==='true'});
});
router.post('/',requireCap('expenses.create'),async(req,res)=>{
 if(process.env.RECEIPT_WRITES_APPROVED!=='true')return res.status(409).render('error',{title:'الإصدار موقوف',message:'يلزم اعتماد البنود والتفعيل قبل إنشاء إيصال.'});
 if(!/^[1-9]\d*$/.test(String(req.body.payment_id||'')))return res.status(400).render('error',{title:'التحصيل مطلوب',message:'اختر تحصيلا مسجلا، الإيصال لا ينشئ تحصيلا جديدا.'});
 const b=req.body;let pounds=Number(b.amount_pounds),piastres=Number(b.amount_piastres||0);
 if(!b.payment_id&&(!b.customer_name?.trim()||!b.purpose?.trim()||!Number.isInteger(pounds)||pounds<0||pounds>999999999||!Number.isInteger(piastres)||piastres<0||piastres>99||pounds+piastres===0)) return res.status(400).render('error',{title:'بيانات غير صالحة',message:'راجع الاسم والبيان والمبلغ.'});
 let salesId=null,orderId=b.order_id||null;
 if(orderId&&!b.payment_id){const o=(await q("SELECT o.*,cu.name AS payer_name,cu.phone AS payer_phone,l.assigned_to AS lead_sales FROM sales_orders o JOIN customers cu ON cu.id=o.customer_id LEFT JOIN leads l ON l.id=o.lead_id WHERE o.id=$1 AND o.status='approved'",[orderId])).rows[0];
 if(!o||!o.sales_user_id||o.lead_sales&&o.lead_sales!==o.sales_user_id)return res.status(409).render('error',{title:'راجع مسؤول البيع',message:'الحجز غير صالح أو مسؤول البيع غير محدد أو يختلف عن مسؤول العميل. راجع الربط قبل التأكيد.'});salesId=o.sales_user_id;b.customer_name=o.payer_name;b.customer_mobile=o.payer_phone;}
 const synthetic=false;
 let id;try{id=await tx(async c=>{
  if(b.payment_id){
   const pay=(await c.query(`SELECT p.*,o.status AS order_status,o.sales_user_id,l.assigned_to AS lead_sales,cu.name AS payer_name,cu.phone AS payer_phone FROM payments p JOIN sales_orders o ON o.id=p.order_id JOIN customers cu ON cu.id=o.customer_id LEFT JOIN leads l ON l.id=o.lead_id WHERE p.id=$1 FOR UPDATE OF p`,[b.payment_id])).rows[0];
   if(!pay||pay.status!=='active'||pay.order_status!=='approved'||!pay.sales_user_id||(pay.lead_sales&&pay.lead_sales!==pay.sales_user_id))throw Object.assign(new Error('التحصيل غير صالح أو إسناد الحجز يحتاج مراجعة.'),{status:409});
   if((await c.query('SELECT id FROM invoices WHERE payment_id=$1',[pay.id])).rowCount)throw Object.assign(new Error('هذا التحصيل مرتبط بإيصال بالفعل. افتح الإيصال الموجود.'),{status:409});
   const parts=String(pay.amount).split('.');pounds=Number(parts[0]);piastres=Number((parts[1]||'').padEnd(2,'0'));orderId=pay.order_id;salesId=pay.sales_user_id;b.customer_name=pay.payer_name;b.customer_mobile=pay.payer_phone;
  }
  if(!b.purpose?.trim())throw Object.assign(new Error('بيان الإيصال مطلوب.'),{status:400});
  const r=(await c.query("SELECT key,value FROM settings WHERE key IN ('invoice_terms','invoice_terms_version') ORDER BY key FOR SHARE")).rows;
  const get=k=>r.find(x=>x.key===k)?.value;
  if(!receiptReleaseAllowed({synthetic:false,terms:get('invoice_terms'),terms_version:get('invoice_terms_version')}))throw Object.assign(Error('نص البنود أو الإصدار لم يعتمد. الإصدار موقوف.'),{status:409});
  const draft=(await c.query('INSERT INTO invoices(customer_name,customer_mobile,amount_pounds,amount_piastres,purpose,offer_type,terms,terms_version,sales_user_id,created_by,order_id,synthetic,payment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',[b.customer_name.trim(),b.customer_mobile||null,pounds,piastres,b.purpose.trim(),b.offer_type||null,get('invoice_terms'),get('invoice_terms_version'),salesId,req.user.id,orderId,synthetic,b.payment_id||null])).rows[0].id;
 await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'receipt_draft_created','invoice',$2,$3)",[req.user.id,String(draft),JSON.stringify({payment_id:b.payment_id})]);return draft;
 });}catch(e){return res.status(e.status||(e.code==='23505'?409:500)).render('error',{title:'تعذر إعداد الإيصال',message:e.status?e.message:'لم يتم إنشاء الإيصال. راجع التحصيل ولا تكرره.'});}
 res.redirect('/accounting/invoices/'+id);
});
router.post('/:id/confirm',requireCap('expenses.create'),async(req,res)=>{
 try {await tx(async c=>{
  const ref=(await c.query('SELECT payment_id,order_id FROM invoices WHERE id=$1',[req.params.id])).rows[0];
  if(ref?.order_id)await c.query('SELECT id FROM sales_orders WHERE id=$1 FOR SHARE',[ref.order_id]);
  const pay=ref?.payment_id?(await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[ref.payment_id])).rows[0]:null;
  const inv=(await c.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!inv)throw Object.assign(new Error('الإيصال غير موجود'),{status:404});
  if(!pay||pay.status!=='active'||inv.status==='voided'||pay.order_id!==inv.order_id||Math.round(Number(pay.amount)*100)!==inv.amount_pounds*100+inv.amount_piastres)throw Object.assign(new Error('لا يمكن الاعتماد دون تحصيل نشط مطابق. الإيصال لا يسجل تحصيلا جديدا.'),{status:409});
  if(inv.status==='confirmed')return;
  const current=(await c.query("SELECT key,value FROM settings WHERE key IN ('invoice_terms','invoice_terms_version') ORDER BY key FOR SHARE")).rows;
  if(current.find(x=>x.key==='invoice_terms_version')?.value!==inv.terms_version||current.find(x=>x.key==='invoice_terms')?.value!==inv.terms)throw Object.assign(Error('تغيرت البنود منذ إنشاء المسودة. أعد المراجعة قبل الاعتماد.'),{status:409});
  if(!receiptReleaseAllowed(inv))throw Object.assign(new Error('الإصدار الفعلي موقوف حتى مراجعة نص البنود. يمكن اختبار إيصال وهمي معلّم على المعاينة فقط.'),{status:409});
  const o=(await c.query("SELECT o.*,u.active,u.role,u.extra_roles,l.assigned_to AS lead_sales FROM sales_orders o JOIN users u ON u.id=o.sales_user_id LEFT JOIN leads l ON l.id=o.lead_id WHERE o.id=$1 FOR SHARE OF o,u",[inv.order_id])).rows[0];
  if(!o||o.status!=='approved'||!o.active||![o.role,...o.extra_roles].some(r=>['sales_staff','sales_team_leader','sales_manager'].includes(r))||o.sales_user_id!==inv.sales_user_id||(o.lead_sales&&o.lead_sales!==o.sales_user_id))throw Object.assign(new Error('ربط الحجز بالسيلز غير واضح أو تغير. راجع مسؤول البيع.'),{status:409});
  await c.query("UPDATE invoices SET status='confirmed',confirmed_by=$1,confirmed_at=now(),delivered_at=now() WHERE id=$2",[req.user.id,inv.id]);
  await c.query('INSERT INTO notifications(user_id,type,title,body,link) VALUES($1,$2,$3,$4,$5)',[inv.sales_user_id,'invoice_confirmed',(inv.synthetic?'إيصال تجريبي مؤكد رقم ':'إيصال مؤكد رقم ')+inv.serial_no,inv.synthetic?'معاينة وهمية فقط، تم اعتمادها من موظف الحسابات.':'تم اعتماد الإيصال من موظف الحسابات.','/accounting/invoices/'+inv.id]);
  await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'receipt_confirmed','invoice',$2,$3)",[req.user.id,String(inv.id),JSON.stringify({synthetic:inv.synthetic,sales_user_id:inv.sales_user_id,terms_version:inv.terms_version})]);
 });res.redirect('/accounting/invoices/'+req.params.id);}catch(e){res.status(e.status||500).render('error',{title:'تعذر التأكيد',message:e.status?e.message:'لم يتم التأكيد أو الإرسال. لم تتغير السجلات.'});}
});
router.get('/:id',async(req,res)=>{
 const inv=(await q('SELECT i.*,u.name AS sales_name FROM invoices i LEFT JOIN users u ON u.id=i.sales_user_id WHERE i.id=$1',[req.params.id])).rows[0];
 if(!inv||(!isAccounting(req.user)&&!(inv.sales_user_id===req.user.id&&['confirmed','voided'].includes(inv.status))))return res.status(404).render('error',{title:'غير موجود',message:'الإيصال غير موجود.'});
 res.render('accounting/invoice_print',{title:'إيصال '+inv.serial_no,inv,csrf:res.locals.csrf,canConfirm:can(req.user.roles,'expenses.create')&&inv.status==='draft'&&!!inv.payment_id,words:amountInWords(inv.amount_pounds,inv.amount_piastres)});
});
module.exports=router;
