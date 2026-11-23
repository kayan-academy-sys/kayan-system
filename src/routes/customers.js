const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const {can}=require('../lib/permissions');
const scoped=u=>u.roles.some(r=>['sales_staff','sales_team_leader'].includes(r))&&!can(u.roles,'leads.view.all')&&!can(u.roles,'orders.view.all')&&!can(u.roles,'payments.view')&&!can(u.roles,'reception.view');
const own="EXISTS(SELECT 1 FROM leads sl WHERE sl.customer_id=c.id AND sl.assigned_to=$2) OR EXISTS(SELECT 1 FROM sales_orders so WHERE so.customer_id=c.id AND so.sales_user_id=$2)";
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth, requireCap('customers.view'));

router.get('/', async (req, res) => {
  const search = (req.query.q || '').trim();
  let rows;
  if (search) {
    rows = (await q(`SELECT c.*, (SELECT count(*) FROM leads l WHERE l.customer_id=c.id) AS leads_count,
      (SELECT count(*) FROM sales_orders o WHERE o.customer_id=c.id AND o.status='approved') AS orders_count
      FROM customers c WHERE (c.name ILIKE $1 OR c.phone ILIKE $1) ${scoped(req.user)?'AND ('+own+')':''} ORDER BY c.id DESC LIMIT 100`, scoped(req.user)?['%'+search+'%',req.user.id]:['%'+search+'%'])).rows;
  } else {
    rows = (await q(`SELECT c.*, (SELECT count(*) FROM leads l WHERE l.customer_id=c.id) AS leads_count,
      (SELECT count(*) FROM sales_orders o WHERE o.customer_id=c.id AND o.status='approved') AS orders_count
      FROM customers c ${scoped(req.user)?'WHERE ('+own.replaceAll('$2','$1')+')':''} ORDER BY c.id DESC LIMIT 100`,scoped(req.user)?[req.user.id]:[])).rows;
  }
  res.render('customers/index', { title: 'العملاء', nav: 'leads', rows, q: search });
});

router.get('/:id', async (req, res) => {
  const { rows } = await q(`SELECT * FROM customers c WHERE id=$1 ${scoped(req.user)?'AND ('+own+')':''}`, scoped(req.user)?[req.params.id,req.user.id]:[req.params.id]);
  if (!rows.length) return res.status(404).render('error', { title: 'غير موجود', message: 'العميل غير موجود.' });
  const customer = rows[0];
  const leads = (await q(`SELECT l.*, c.name AS course_name, u.name AS assigned_name FROM leads l LEFT JOIN courses c ON c.id=l.course_id LEFT JOIN users u ON u.id=l.assigned_to WHERE l.customer_id=$1 ${scoped(req.user)?'AND l.assigned_to=$2':''} ORDER BY l.id DESC`, scoped(req.user)?[customer.id,req.user.id]:[customer.id])).rows;
  const orders = (await q(`SELECT o.*, c.name AS course_name, p.name AS package_name,
    (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.order_id=o.id AND pay.status='active') AS paid
    FROM sales_orders o LEFT JOIN courses c ON c.id=o.course_id LEFT JOIN packages p ON p.id=o.package_id
    WHERE o.customer_id=$1 ${scoped(req.user)?'AND o.sales_user_id=$2':''} ORDER BY o.id DESC`, scoped(req.user)?[customer.id,req.user.id]:[customer.id])).rows;
  const enrollments = (await q(`SELECT e.*, c.name AS course_name, g.name AS group_name FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN groups g ON g.id=e.group_id WHERE e.customer_id=$1 ${scoped(req.user)?'AND EXISTS(SELECT 1 FROM sales_orders so WHERE so.id=e.order_id AND so.sales_user_id=$2)':''} ORDER BY e.id DESC`, scoped(req.user)?[customer.id,req.user.id]:[customer.id])).rows;
  res.render('customers/detail', { title: 'ملف العميل: ' + customer.name, nav: 'leads', customer, leads, orders, enrollments });
});

router.post('/:id/edit', requireCap('customers.edit'), async (req, res) => {
  if(scoped(req.user)&&!(await q(`SELECT id FROM customers c WHERE id=$1 AND (${own})`,[req.params.id,req.user.id])).rowCount)return res.status(404).render('error',{title:'غير موجود',message:'العميل غير موجود.'});
  const { name, phone, email, notes } = req.body;
  const dup = await q('SELECT id FROM customers WHERE phone=$1 AND id<>$2', [(phone || '').trim(), req.params.id]);
  if (dup.rowCount) return res.status(409).render('error', { title: 'رقم مكرر', message: 'رقم الهاتف مسجل لعميل آخر.' });
  await q('UPDATE customers SET name=$1, phone=$2, email=$3, notes=$4 WHERE id=$5', [name.trim(), (phone || '').trim(), email || null, notes || null, req.params.id]);
  await audit(req, 'customer_updated', 'customer', req.params.id, { name, phone });
  res.redirect('/customers/' + req.params.id);
});

module.exports = router;
