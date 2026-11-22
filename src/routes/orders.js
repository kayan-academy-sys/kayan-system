const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');
const { notifyRole } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth, requireCap('orders.create', 'orders.view.all', 'orders.view.own'));

function scopeOrders(req) {
  if (can(req.user.role, 'orders.view.all')) return { cond: '', params: [] };
  return { cond: 'AND o.sales_user_id=$1', params: [req.user.id] };
}

router.get('/', async (req, res) => {
  const { cond, params } = scopeOrders(req);
  const { rows } = await q(`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, co.name AS course_name, p.name AS package_name, u.name AS sales_name,
      (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.order_id=o.id AND pay.status='active') AS paid
    FROM sales_orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN courses co ON co.id=o.course_id LEFT JOIN packages p ON p.id=o.package_id
    LEFT JOIN users u ON u.id=o.sales_user_id
    WHERE TRUE ${cond} ORDER BY o.id DESC LIMIT 300`, params);
  res.render('orders/index', { title: 'الحجوزات', nav: 'orders', rows });
});

router.get('/new', requireCap('orders.create'), async (req, res) => {
  const lead = req.query.lead_id ? (await q(`SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, co.name AS course_name FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN courses co ON co.id=l.course_id WHERE l.id=$1`, [req.query.lead_id])).rows[0] : null;
  const courses = (await q(`SELECT * FROM courses WHERE status='active' ORDER BY name`)).rows;
  const packages = (await q(`SELECT p.*, (SELECT json_agg(pc.course_id) FROM package_courses pc WHERE pc.package_id=p.id) AS course_ids,
    (SELECT json_agg(c.name) FROM package_courses pc JOIN courses c ON c.id=pc.course_id WHERE pc.package_id=p.id) AS course_names
    FROM packages p WHERE p.status='active' ORDER BY p.id`)).rows;
  const groups = (await q(`SELECT g.*, c.name AS course_name, t.name AS trainer_name,
    (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
    FROM groups g JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
    WHERE g.status IN ('open','nearly_full') ORDER BY g.start_date`)).rows;
  const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
  res.render('orders/new', { title: 'حجز جديد', nav: 'orders', lead, courses, packages, groups, accounts, error: null });
});

router.post('/', requireCap('orders.create'), async (req, res) => {
  const { kind, course_id, package_id, payment_type, lead_id, customer_name, customer_phone } = req.body;
  try {
    const result = await tx(async (c) => {
      let customerId, leadRow = null;
      if (lead_id) {
        leadRow = (await c.query('SELECT l.*, cu.id AS cid FROM leads l JOIN customers cu ON cu.id=l.customer_id WHERE l.id=$1', [lead_id])).rows[0];
        if (!leadRow) throw Object.assign(new Error('الفرصة غير موجودة.'), { status: 404 });
        customerId = leadRow.customer_id;
      } else {
        if (!customer_name || !customer_phone) throw Object.assign(new Error('بيانات العميل إلزامية.'), { status: 400 });
        const existing = await c.query('SELECT id FROM customers WHERE phone=$1', [customer_phone.trim()]);
        if (existing.rowCount) customerId = existing.rows[0].id;
        else customerId = (await c.query('INSERT INTO customers (name, phone, created_by) VALUES ($1,$2,$3) RETURNING id', [customer_name.trim(), customer_phone.trim(), req.user.id])).rows[0].id;
      }

      let total, orderCourseId = null, orderPackageId = null, enrollCourses = [];
      if (kind === 'package') {
        const pkg = (await c.query(`SELECT * FROM packages WHERE id=$1 AND status='active'`, [package_id])).rows[0];
        if (!pkg) throw Object.assign(new Error('الباقة غير متاحة.'), { status: 400 });
        total = parseFloat(pkg.price);
        orderPackageId = pkg.id;
        enrollCourses = (await c.query('SELECT course_id FROM package_courses WHERE package_id=$1', [pkg.id])).rows.map(r => r.course_id);
      } else {
        const course = (await c.query(`SELECT * FROM courses WHERE id=$1 AND status='active'`, [course_id])).rows[0];
        if (!course) throw Object.assign(new Error('الكورس غير متاح.'), { status: 400 });
        total = parseFloat(course.base_price);
        orderCourseId = course.id;
        enrollCourses = [course.id];
      }

      // التحقق من سعة المجموعات المختارة لكل كورس
      const groupIds = {};
      for (const cid of enrollCourses) {
        const gid = parseInt(req.body['group_' + cid], 10) || null;
        if (gid) {
          const g = (await c.query(`SELECT id, capacity, status, course_id FROM groups WHERE id=$1 FOR UPDATE`, [gid])).rows[0];
          if (!g || g.course_id !== cid || !['open','nearly_full'].includes(g.status)) {
            throw Object.assign(new Error('المجموعة المختارة غير متاحة للحجز.'), { status: 400 });
          }
          const cnt = (await c.query(`SELECT count(*) AS n FROM enrollments WHERE group_id=$1 AND status='active'`, [gid])).rows[0].n;
          if (parseInt(cnt, 10) >= g.capacity) throw Object.assign(new Error('المجموعة مكتملة العدد.'), { status: 409 });
          groupIds[cid] = gid;
        }
      }

      const order = await c.query(`INSERT INTO sales_orders (customer_id, lead_id, kind, course_id, package_id, total_price, offer_type, payment_type, sales_user_id, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved') RETURNING id`,
        [customerId, lead_id || null, kind === 'package' ? 'package' : 'course', orderCourseId, orderPackageId, total,
         kind === 'package' ? 'package_discount' : 'none', payment_type === 'installments' ? 'installments' : 'cash', req.user.id]);
      const orderId = order.rows[0].id;

      for (const cid of enrollCourses) {
        await c.query('INSERT INTO enrollments (order_id, customer_id, course_id, group_id) VALUES ($1,$2,$3,$4)', [orderId, customerId, cid, groupIds[cid] || null]);
      }

      // خطة التقسيط
      if (payment_type === 'installments') {
        const down = parseFloat(req.body.down_payment) || 0;
        const count = parseInt(req.body.installments_count, 10) || 0;
        const firstDue = req.body.first_due_date;
        const each = parseFloat(req.body.installment_amount) || 0;
        if (count < 1 || each <= 0 || !firstDue) throw Object.assign(new Error('بيانات التقسيط غير مكتملة.'), { status: 400 });
        if (Math.abs(down + each * count - total) > 0.01) {
          throw Object.assign(new Error(`مجموع المقدم (${down}) والأقساط (${each}×${count}) يجب أن يساوي إجمالي السعر (${total}).`), { status: 400 });
        }
        const plan = await c.query('INSERT INTO installment_plans (order_id, total, down_payment, count, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [orderId, total, down, count, req.user.id]);
        const d0 = new Date(firstDue);
        for (let i = 1; i <= count; i++) {
          const d = new Date(d0); d.setMonth(d.getMonth() + (i - 1));
          await c.query('INSERT INTO installments (plan_id, seq, amount, due_date, original_due_date) VALUES ($1,$2,$3,$4,$4)', [plan.rows[0].id, i, each, d.toISOString().slice(0, 10)]);
        }
      }

      // تحديث حالة الفرصة إلى حجز
      if (leadRow) {
        await c.query(`UPDATE leads SET status=$1, updated_at=now() WHERE id=$2`, [payment_type === 'installments' ? 'booked_installment' : 'booked_cash', leadRow.id]);
        await c.query('INSERT INTO lead_activities (lead_id, user_id, type, result, notes) VALUES ($1,$2,$3,$4,$5)',
          [leadRow.id, req.user.id, 'status_change', payment_type === 'installments' ? 'booked_installment' : 'booked_cash', 'تم إنشاء الحجز #' + orderId]);
      }

      // تحديث حالة المجموعات حسب السعة
      for (const gid of Object.values(groupIds)) {
        const g = (await c.query('SELECT capacity FROM groups WHERE id=$1', [gid])).rows[0];
        const cnt = parseInt((await c.query(`SELECT count(*) AS n FROM enrollments WHERE group_id=$1 AND status='active'`, [gid])).rows[0].n, 10);
        if (cnt >= g.capacity) await c.query(`UPDATE groups SET status='full' WHERE id=$1`, [gid]);
      }
      return { orderId, customerId, total };
    });
    await audit(req, 'order_created', 'sales_order', result.orderId, { kind, total: result.total, payment_type });
    await notifyRole('accounting_manager', 'order_created', 'حجز جديد #' + result.orderId, `حجز بقيمة ${result.total} ج.م (${payment_type === 'installments' ? 'تقسيط' : 'نقدي'}).`, '/orders/' + result.orderId);
    res.redirect('/orders/' + result.orderId);
  } catch (e) {
    const status = e.status || 500;
    const lead = lead_id ? (await q(`SELECT l.*, c.name AS customer_name, c.phone AS customer_phone FROM leads l JOIN customers c ON c.id=l.customer_id WHERE l.id=$1`, [lead_id])).rows[0] : null;
    const courses = (await q(`SELECT * FROM courses WHERE status='active' ORDER BY name`)).rows;
    const packages = (await q(`SELECT p.*, (SELECT json_agg(pc.course_id) FROM package_courses pc WHERE pc.package_id=p.id) AS course_ids,
      (SELECT json_agg(c2.name) FROM package_courses pc JOIN courses c2 ON c2.id=pc.course_id WHERE pc.package_id=p.id) AS course_names
      FROM packages p WHERE p.status='active' ORDER BY p.id`)).rows;
    const groups = (await q(`SELECT g.*, c.name AS course_name, t.name AS trainer_name,
      (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
      FROM groups g JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
      WHERE g.status IN ('open','nearly_full') ORDER BY g.start_date`)).rows;
    const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
    res.status(status).render('orders/new', { title: 'حجز جديد', nav: 'orders', lead, courses, packages, groups, accounts, error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const { rows } = await q(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, co.name AS course_name, p.name AS package_name, u.name AS sales_name, cu.name AS cancelled_by_name
    FROM sales_orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN courses co ON co.id=o.course_id
    LEFT JOIN packages p ON p.id=o.package_id LEFT JOIN users u ON u.id=o.sales_user_id LEFT JOIN users cu ON cu.id=o.cancelled_by
    WHERE o.id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).render('error', { title: 'غير موجود', message: 'الحجز غير موجود.' });
  const order = rows[0];
  if (!can(req.user.role, 'orders.view.all') && order.sales_user_id !== req.user.id) {
    return res.status(403).render('error', { title: 'غير مسموح', message: 'هذا الحجز يخص موظف مبيعات آخر.' });
  }
  const enrollments = (await q(`SELECT e.*, c.name AS course_name, g.name AS group_name FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN groups g ON g.id=e.group_id WHERE e.order_id=$1`, [order.id])).rows;
  const payments = (await q(`SELECT p.*, a.name AS account_name, u.name AS received_by_name FROM payments p JOIN financial_accounts a ON a.id=p.account_id LEFT JOIN users u ON u.id=p.received_by WHERE p.order_id=$1 ORDER BY p.id DESC`, [order.id])).rows;
  const plan = (await q('SELECT * FROM installment_plans WHERE order_id=$1', [order.id])).rows[0] || null;
  let installments = [];
  if (plan) {
    installments = (await q(`SELECT i.*, (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') AS paid FROM installments i WHERE i.plan_id=$1 ORDER BY i.seq`, [plan.id])).rows;
  }
  const paid = payments.filter(p => p.status === 'active').reduce((s, p) => s + parseFloat(p.amount), 0);
  const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
  const canManageGroups = can(req.user.role, 'groups.manage') && order.status === 'approved';
  const groupsByCourse = {};
  if (canManageGroups) {
    const gs = (await q(`SELECT g.id, g.name, g.course_id, g.capacity,
      (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
      FROM groups g WHERE g.status IN ('open','nearly_full') ORDER BY g.start_date`)).rows;
    gs.forEach(g => { (groupsByCourse[g.course_id] = groupsByCourse[g.course_id] || []).push({ id: g.id, name: g.name, free: g.capacity - Number(g.booked) }); });
  }
  res.render('orders/detail', { title: 'حجز #' + order.id, nav: 'orders', order, enrollments, payments, plan, installments, paid, remaining: parseFloat(order.total_price) - paid, accounts, canPay: can(req.user.role, 'payments.create'), canCancel: can(req.user.role, 'orders.cancel'), canManageGroups, groupsByCourse });
});

// تحديد/تغيير مجموعة تسجيل بعد الحجز (صلاحية إدارة المجموعات + فحص السعة)
router.post('/:id/enrollments/:eid/group', requireCap('groups.manage'), async (req, res) => {
  const order = (await q('SELECT * FROM sales_orders WHERE id=$1', [req.params.id])).rows[0];
  if (!order) return res.status(404).render('error', { title: 'غير موجود', message: 'الحجز غير موجود.' });
  if (order.status !== 'approved') return res.status(400).render('error', { title: 'غير ممكن', message: 'لا يمكن تحديد المجموعة إلا لحجز معتمد.' });
  const e = (await q(`SELECT * FROM enrollments WHERE id=$1 AND order_id=$2 AND status='active'`, [req.params.eid, order.id])).rows[0];
  if (!e) return res.status(404).render('error', { title: 'غير موجود', message: 'التسجيل غير موجود أو غير نشط.' });
  const gid = parseInt(req.body.group_id, 10);
  const g = (await q(`SELECT * FROM groups WHERE id=$1 AND status IN ('open','nearly_full')`, [gid])).rows[0];
  if (!g || g.course_id !== e.course_id) return res.status(400).render('error', { title: 'غير مناسبة', message: 'المجموعة المختارة غير متاحة لهذا الكورس.' });
  const cnt = (await q(`SELECT count(*) AS n FROM enrollments WHERE group_id=$1 AND status='active' AND id!=$2`, [g.id, e.id])).rows[0].n;
  if (parseInt(cnt, 10) >= g.capacity) return res.status(409).render('error', { title: 'مكتملة', message: 'المجموعة مكتملة العدد.' });
  await q('UPDATE enrollments SET group_id=$1 WHERE id=$2', [g.id, e.id]);
  await audit(req, 'enrollment_group_assigned', 'enrollment', e.id, { order_id: order.id, group_id: g.id });
  res.redirect('/orders/' + order.id);
});

// إلغاء الحجز (صلاحية خاصة + سبب + سجل مراجعة)
router.post('/:id/cancel', requireCap('orders.cancel'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).render('error', { title: 'سبب مطلوب', message: 'سبب الإلغاء إلزامي.' });
  const order = (await q('SELECT * FROM sales_orders WHERE id=$1', [req.params.id])).rows[0];
  if (!order) return res.status(404).render('error', { title: 'غير موجود', message: 'الحجز غير موجود.' });
  if (order.status === 'cancelled') return res.redirect('/orders/' + order.id);
  const activePayments = (await q(`SELECT count(*) AS n FROM payments WHERE order_id=$1 AND status='active'`, [order.id])).rows[0].n;
  await tx(async (c) => {
    await c.query(`UPDATE sales_orders SET status='cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_at=now() WHERE id=$3`, [reason, req.user.id, order.id]);
    await c.query(`UPDATE enrollments SET status='cancelled' WHERE order_id=$1`, [order.id]);
    if (order.lead_id) await c.query(`UPDATE leads SET status='need_follow_up', updated_at=now() WHERE id=$1`, [order.lead_id]);
  });
  await audit(req, 'order_cancelled', 'sales_order', order.id, { reason, hadActivePayments: parseInt(activePayments, 10) > 0 });
  res.redirect('/orders/' + order.id);
});

module.exports = router;
