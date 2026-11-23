const express=require('express');
const {q,tx}=require('../db');
const {requireAuth,requireCap}=require('../middleware/auth');
const {audit}=require('../lib/audit');
const {amountInWords}=require('../lib/tafqeet');
const router=express.Router();
router.use(requireAuth,requireCap('expenses.create','expenses.view'));
router.get('/',async(req,res)=>{
 const rows=(await q('SELECT i.*,u.name AS sales_name FROM invoices i LEFT JOIN users u ON u.id=i.sales_user_id ORDER BY i.id DESC LIMIT 100')).rows;
 const sales=(await q("SELECT id,name FROM users WHERE active AND role IN ('sales_staff','sales_team_leader','sales_manager') ORDER BY name")).rows;
 res.render('accounting/invoices',{title:'إيصالات الاستلام',rows,sales});
});
router.post('/',requireCap('expenses.create'),async(req,res)=>{
 const b=req.body;const pounds=Number(b.amount_pounds),piastres=Number(b.amount_piastres||0);
 if(!b.customer_name?.trim()||!b.purpose?.trim()||!Number.isInteger(pounds)||pounds<0||pounds>999999999||!Number.isInteger(piastres)||piastres<0||piastres>99||pounds+piastres===0) return res.status(400).render('error',{title:'بيانات غير صالحة',message:'راجع الاسم والبيان والمبلغ.'});
 let salesId=b.sales_user_id||null;
 if(salesId&&!(await q("SELECT id FROM users WHERE id=$1 AND active AND role IN ('sales_staff','sales_team_leader','sales_manager')",[salesId])).rowCount) return res.status(400).render('error',{title:'سيلز غير صالح',message:'اختر موظف مبيعات نشطًا.'});
 const id=await tx(async c=>{
  const r=(await c.query("SELECT key,value FROM settings WHERE key IN ('invoice_terms','invoice_terms_version') ORDER BY key FOR SHARE")).rows;
  const get=k=>r.find(x=>x.key===k)?.value;
  return (await c.query('INSERT INTO invoices(customer_name,customer_mobile,amount_pounds,amount_piastres,purpose,offer_type,terms,terms_version,sales_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[b.customer_name.trim(),b.customer_mobile||null,pounds,piastres,b.purpose.trim(),b.offer_type||null,get('invoice_terms'),get('invoice_terms_version'),salesId,req.user.id])).rows[0].id;
 });
 await audit(req,'receipt_draft_created','invoice',id,{});res.redirect('/accounting/invoices/'+id);
});
router.post('/:id/confirm',(req,res)=>res.status(409).render('error',{title:'بانتظار الاعتماد',message:'التأكيد والإرسال موقوفان لحين تحديد مسؤول التأكيد ووسيلة الإرسال.'}));
router.get('/:id',async(req,res)=>{
 const inv=(await q('SELECT i.*,u.name AS sales_name FROM invoices i LEFT JOIN users u ON u.id=i.sales_user_id WHERE i.id=$1',[req.params.id])).rows[0];
 if(!inv)return res.status(404).render('error',{title:'غير موجود',message:'الإيصال غير موجود.'});
 res.render('accounting/invoice_print',{title:'إيصال '+inv.serial_no,inv,words:amountInWords(inv.amount_pounds,inv.amount_piastres)});
});
module.exports=router;
