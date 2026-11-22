const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');
const { accountBalances } = require('../lib/balances');

const router = express.Router();
router.use(requireAuth, requireCap('payments.view', 'payments.create', 'expenses.view', 'expenses.create', 'accounts.view'));

// لوحة الحسابات
router.get('/', async (req, res) => {
  const totals = (await q(`SELECT
    COALESCE(sum(amount) FILTER (WHERE status='active' AND paid_at::date=current_date),0) AS collected_today,
    COALESCE(sum(amount) FILTER (WHERE status='active'),0) AS collected_total
    FROM payments`)).rows[0];
  const outstanding = (await q(`SELECT COALESCE(sum(o.total_price),0) - COALESCE((
    SELECT sum(p.amount) FROM payments p WHERE p.status='active' AND p.order_id IN (SELECT id FROM sales_orders WHERE status='approved')),0) AS due
    FROM sales_orders o WHERE o.status='approved'`)).rows[0];
  const inst = (await q(`SELECT
    count(*) FILTER (WHERE i.due_date=current_date) AS due_today,
    count(*) FILTER (WHERE i.due_date<current_date) AS overdue,
    COALESCE(sum(i.amount) FILTER (WHERE i.due_date<current_date),0) AS overdue_amount
    FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id
    WHERE i.status='pending' AND o.status='approved'
    AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount`)).rows[0];
  const byChannel = (await q(`SELECT method, COALESCE(sum(amount),0) AS total FROM payments WHERE status='active' GROUP BY method ORDER BY method`)).rows;
  const balances = await accountBalances();
  const closingToday = (await q('SELECT * FROM daily_closings WHERE closing_date=current_date')).rows[0] || null;
  const closings = (await q('SELECT c.*, u.name AS closed_by_name FROM daily_closings c LEFT JOIN users u ON u.id=c.closed_by ORDER BY closing_date DESC LIMIT 14')).rows;
  res.render('accounting/dashboard', { title: 'لوحة الحسابات', nav: 'accounting', totals, outstanding, inst, byChannel, balances, closingToday, closings, canClose: can(req.user.roles, 'closings.manage') });
});

// إقفال يومي
router.post('/closings', requireCap('closings.manage'), async (req, res) => {
  const balances = await accountBalances();
  try {
    await q('INSERT INTO daily_closings (closing_date, balances, notes, closed_by) VALUES (current_date, $1, $2, $3)',
      [JSON.stringify(balances), req.body.notes || null, req.user.id]);
    await audit(req, 'daily_closing', 'daily_closings', null, { balances: balances.map(b => ({ account: b.name, balance: b.balance })) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).render('error', { title: 'تم الإقفال', message: 'تم إقفال خزينة اليوم بالفعل.' });
    throw e;
  }
  res.redirect('/accounting');
});

// المدفوعات
router.get('/payments', async (req, res) => {
  const { rows } = await q(`SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, a.name AS account_name, u.name AS received_by_name, v.name AS voided_by_name
    FROM payments p JOIN sales_orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id
    JOIN financial_accounts a ON a.id=p.account_id LEFT JOIN users u ON u.id=p.received_by LEFT JOIN users v ON v.id=p.voided_by
    ORDER BY p.id DESC LIMIT 300`);
  res.render('accounting/payments', { title: 'المدفوعات', nav: 'payments', rows, canVoid: can(req.user.roles, 'payments.void') });
});

router.post('/payments', requireCap('payments.create'), async (req, res) => {
  const { order_id, amount, method, account_id, installment_id, notes } = req.body;
  const amt = parseFloat(amount);
  if (!order_id || !amt || amt <= 0 || !account_id || !['cash','bank_transfer','instapay','wallet'].includes(method)) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من رقم الحجز والمبلغ وطريقة الدفع والحساب.' });
  }
  try {
    const paymentId = await tx(async (c) => {
      const order = (await c.query(`SELECT * FROM sales_orders WHERE id=$1 AND status='approved' FOR UPDATE`, [order_id])).rows[0];
      if (!order) throw Object.assign(new Error('الحجز غير موجود أو ملغي.'), { status: 404 });
      const paidSoFar = parseFloat((await c.query(`SELECT COALESCE(sum(amount),0) AS s FROM payments WHERE order_id=$1 AND status='active'`, [order_id])).rows[0].s);
      if (amt > parseFloat(order.total_price) - paidSoFar + 0.001) {
        throw Object.assign(new Error(`المبلغ يتجاوز المتبقي على الحجز (${(parseFloat(order.total_price) - paidSoFar).toLocaleString('ar-EG')} ج.م).`), { status: 400 });
      }
      const ins = await c.query(`INSERT INTO payments (order_id, installment_id, amount, method, account_id, received_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [order_id, installment_id || null, amt, method, account_id, req.user.id, notes || null]);
      if (installment_id) {
        const i = (await c.query(`SELECT i.*, p.order_id FROM installments i JOIN installment_plans p ON p.id=i.plan_id WHERE i.id=$1 FOR UPDATE`, [installment_id])).rows[0];
        if (i && i.order_id === parseInt(order_id, 10)) {
          const paidInst = parseFloat((await c.query(`SELECT COALESCE(sum(amount),0) AS s FROM payments WHERE installment_id=$1 AND status='active'`, [installment_id])).rows[0].s);
          if (paidInst >= parseFloat(i.amount)) await c.query(`UPDATE installments SET status='paid' WHERE id=$1`, [installment_id]);
        }
      }
      return ins.rows[0].id;
    });
    await audit(req, 'payment_created', 'payment', paymentId, { order_id, amount: amt, method });
    res.redirect('/orders/' + order_id);
  } catch (e) {
    res.status(e.status || 500).render('error', { title: 'تعذر تسجيل الدفعة', message: e.message });
  }
});

// إلغاء دفعة (عكس مالي) - لا حذف نهائي
router.post('/payments/:id/void', requireCap('payments.void'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).render('error', { title: 'سبب مطلوب', message: 'سبب إلغاء الدفعة إلزامي ويُسجل في سجل المراجعة.' });
  const p = (await q('SELECT * FROM payments WHERE id=$1', [req.params.id])).rows[0];
  if (!p) return res.status(404).render('error', { title: 'غير موجودة', message: 'الدفعة غير موجودة.' });
  if (p.status === 'voided') return res.redirect('/accounting/payments');
  await tx(async (c) => {
    await c.query(`UPDATE payments SET status='voided', void_reason=$1, voided_by=$2, voided_at=now() WHERE id=$3`, [reason, req.user.id, p.id]);
    if (p.installment_id) {
      const i = (await c.query('SELECT * FROM installments WHERE id=$1', [p.installment_id])).rows[0];
      const paidInst = parseFloat((await c.query(`SELECT COALESCE(sum(amount),0) AS s FROM payments WHERE installment_id=$1 AND status='active'`, [p.installment_id])).rows[0].s);
      if (i && paidInst < parseFloat(i.amount)) await c.query(`UPDATE installments SET status='pending' WHERE id=$1`, [p.installment_id]);
    }
  });
  await audit(req, 'payment_voided', 'payment', p.id, { reason, amount: p.amount });
  res.redirect('/accounting/payments');
});

// الأقساط
router.get('/installments', async (req, res) => {
  const filter = req.query.f || 'all';
  let cond = '';
  if (filter === 'today') cond = 'AND i.due_date=current_date';
  if (filter === 'overdue') cond = 'AND i.due_date<current_date';
  if (filter === 'upcoming') cond = 'AND i.due_date>current_date';
  const { rows } = await q(`SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, o.id AS order_id, o.total_price,
    (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') AS paid
    FROM installments i JOIN installment_plans p ON p.id=i.plan_id
    JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
    JOIN customers c ON c.id=o.customer_id
    WHERE TRUE ${cond} ORDER BY i.due_date LIMIT 300`);
  res.render('accounting/installments', { title: 'الأقساط', nav: 'installments', rows, filter, canManage: can(req.user.roles, 'installments.manage'), canPay: can(req.user.roles, 'payments.create') });
});

// تأجيل قسط: الاحتفاظ بالتاريخ الأصلي والسبب والموافقة
router.post('/installments/:id/postpone', requireCap('installments.manage'), async (req, res) => {
  const { new_date, reason } = req.body;
  if (!new_date || !reason) return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'التاريخ الجديد وسبب التأجيل إلزاميان.' });
  const i = (await q('SELECT * FROM installments WHERE id=$1', [req.params.id])).rows[0];
  if (!i) return res.status(404).render('error', { title: 'غير موجود', message: 'القسط غير موجود.' });
  await q(`UPDATE installments SET due_date=$1, postpone_reason=$2, postponed_by=$3, postponed_at=now(), postpone_approved_by=$3 WHERE id=$4`,
    [new_date, reason, req.user.id, i.id]);
  await audit(req, 'installment_postponed', 'installment', i.id, { from: i.due_date, to: new_date, reason });
  res.redirect('/accounting/installments');
});

// المصروفات
router.get('/expenses', async (req, res) => {
  const { rows } = await q(`SELECT e.*, t.name AS type_name, a.name AS account_name, u.name AS recorded_by_name, v.name AS voided_by_name
    FROM expenses e JOIN expense_types t ON t.id=e.type_id JOIN financial_accounts a ON a.id=e.account_id
    LEFT JOIN users u ON u.id=e.recorded_by LEFT JOIN users v ON v.id=e.voided_by
    ORDER BY e.expense_date DESC, e.id DESC LIMIT 300`);
  const types = (await q('SELECT * FROM expense_types ORDER BY name')).rows;
  const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
  res.render('accounting/expenses', { title: 'المصروفات', nav: 'expenses', rows, types, accounts, canManage: can(req.user.roles, 'expenses.void'), canTypes: can(req.user.roles, 'expense_types.manage') });
});

router.post('/expenses', requireCap('expenses.create'), async (req, res) => {
  const { type_id, amount, expense_date, account_id, notes } = req.body;
  const amt = parseFloat(amount);
  if (!type_id || !amt || amt <= 0 || !expense_date || !account_id) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من نوع المصروف والقيمة والتاريخ والحساب.' });
  }
  const ins = await q('INSERT INTO expenses (type_id, amount, expense_date, account_id, recorded_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [type_id, amt, expense_date, account_id, req.user.id, notes || null]);
  await audit(req, 'expense_created', 'expense', ins.rows[0].id, { type_id, amount: amt });
  res.redirect('/accounting/expenses');
});

router.post('/expenses/:id/void', requireCap('expenses.void'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).render('error', { title: 'سبب مطلوب', message: 'سبب الإلغاء إلزامي.' });
  await q(`UPDATE expenses SET status='voided', void_reason=$1, voided_by=$2, voided_at=now() WHERE id=$3 AND status='active'`, [reason, req.user.id, req.params.id]);
  await audit(req, 'expense_voided', 'expense', req.params.id, { reason });
  res.redirect('/accounting/expenses');
});

router.post('/expense-types', requireCap('expense_types.manage'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'اسم النوع مطلوب.' });
  await q('INSERT INTO expense_types (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  await audit(req, 'expense_type_created', 'expense_type', null, { name });
  res.redirect('/accounting/expenses');
});

// التحويلات بين الحسابات (ليست مصروفًا ولا إيرادًا)
router.get('/transfers', requireCap('transfers.view', 'transfers.create', 'accounts.view'), async (req, res) => {
  const { rows } = await q(`SELECT t.*, f.name AS from_name, tt.name AS to_name, u.name AS recorded_by_name
    FROM transfers t JOIN financial_accounts f ON f.id=t.from_account_id JOIN financial_accounts tt ON tt.id=t.to_account_id
    LEFT JOIN users u ON u.id=t.recorded_by ORDER BY t.id DESC LIMIT 200`);
  const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
  res.render('accounting/transfers', { title: 'التحويلات بين الحسابات', nav: 'accounting', rows, accounts, canCreate: can(req.user.roles, 'transfers.create') });
});

router.post('/transfers', requireCap('transfers.create'), async (req, res) => {
  const { from_account_id, to_account_id, amount, transfer_date, notes } = req.body;
  const amt = parseFloat(amount);
  if (!from_account_id || !to_account_id || from_account_id === to_account_id || !amt || amt <= 0 || !transfer_date) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من الحسابين والمبلغ والتاريخ.' });
  }
  const ins = await q('INSERT INTO transfers (from_account_id, to_account_id, amount, transfer_date, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [from_account_id, to_account_id, amt, transfer_date, notes || null, req.user.id]);
  await audit(req, 'transfer_created', 'transfer', ins.rows[0].id, { from_account_id, to_account_id, amount: amt });
  res.redirect('/accounting/transfers');
});

module.exports = router;
