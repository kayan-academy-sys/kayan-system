const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { can } = require('../lib/permissions');
const { accountBalances } = require('../lib/balances');

const router = express.Router();
router.use(requireAuth, requireCap('reports.sales', 'reports.finance'));

function csv(rows, headers) {
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  return '﻿' + [headers.map(h => esc(h.label)).join(',')]
    .concat(rows.map(r => headers.map(h => esc(typeof h.get === 'function' ? h.get(r) : r[h.key])).join(','))).join('\n');
}

router.get('/', async (req, res) => {
  res.render('reports/index', { title: 'التقارير', nav: 'reports', canSales: can(req.user.roles, 'reports.sales'), canFinance: can(req.user.roles, 'reports.finance') });
});

router.get('/sales', requireCap('reports.sales'), async (req, res) => {
  const { from, to, status, source, user_id, format } = req.query;
  const conds = []; const params = [];
  if (from) { params.push(from); conds.push(`l.created_at::date >= $${params.length}`); }
  if (to) { params.push(to); conds.push(`l.created_at::date <= $${params.length}`); }
  if (status) { params.push(status); conds.push(`l.status=$${params.length}`); }
  if (source) { params.push(source); conds.push(`l.source=$${params.length}`); }
  if (user_id) { params.push(user_id); conds.push(`l.assigned_to=$${params.length}`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const { rows } = await q(`SELECT l.*, c.name AS customer_name, c.phone, co.name AS course_name, u.name AS assigned_name
    FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN courses co ON co.id=l.course_id LEFT JOIN users u ON u.id=l.assigned_to
    ${where} ORDER BY l.id DESC LIMIT 2000`, params);
  const stats = (await q(`SELECT
    count(*) AS total,
    count(*) FILTER (WHERE l.status IN ('booked_cash','booked_installment')) AS booked,
    count(*) FILTER (WHERE l.status='closed_lost') AS lost,
    count(*) FILTER (WHERE l.status NOT IN ('closed_lost','booked_cash','booked_installment')) AS active
    FROM leads l ${where}`, params)).rows[0];
  const bySource = (await q(`SELECT l.source, count(*) AS n FROM leads l ${where} GROUP BY l.source ORDER BY n DESC`, params)).rows;
  const salesUsers = (await q(`SELECT id, name FROM users WHERE (role IN ('sales_staff','sales_team_leader','sales_manager') OR extra_roles && ARRAY['sales_staff','sales_team_leader','sales_manager']::text[]) ORDER BY name`)).rows;
  if (format === 'csv' && can(req.user.roles, 'reports.export')) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="sales-report.csv"');
    return res.send(csv(rows, [
      { key: 'id', label: '#' }, { key: 'customer_name', label: 'العميل' }, { key: 'phone', label: 'الهاتف' },
      { key: 'course_name', label: 'الكورس' }, { get: r => r.source, label: 'المصدر' },
      { get: r => r.status, label: 'الحالة' }, { key: 'assigned_name', label: 'الموظف' },
      { get: r => new Date(r.created_at).toISOString().slice(0, 10), label: 'التاريخ' }
    ]));
  }
  res.render('reports/sales', { title: 'تقرير المبيعات', nav: 'reports', rows, stats, bySource, salesUsers, query: req.query, canExport: can(req.user.roles, 'reports.export') });
});

router.get('/finance', requireCap('reports.finance'), async (req, res) => {
  const { from, to, method, type_id, format } = req.query;
  const pConds = [`p.status='active'`]; const params = [];
  if (from) { params.push(from); pConds.push(`p.paid_at::date >= $${params.length}`); }
  if (to) { params.push(to); pConds.push(`p.paid_at::date <= $${params.length}`); }
  if (method) { params.push(method); pConds.push(`p.method=$${params.length}`); }
  const payments = (await q(`SELECT p.*, c.name AS customer_name, a.name AS account_name
    FROM payments p JOIN sales_orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id JOIN financial_accounts a ON a.id=p.account_id
    WHERE ${pConds.join(' AND ')} ORDER BY p.id DESC LIMIT 2000`, params)).rows;
  const eConds = [`e.status='active'`]; const eParams = [];
  if (from) { eParams.push(from); eConds.push(`e.expense_date >= $${eParams.length}`); }
  if (to) { eParams.push(to); eConds.push(`e.expense_date <= $${eParams.length}`); }
  if (type_id) { eParams.push(type_id); eConds.push(`e.type_id=$${eParams.length}`); }
  const expenses = (await q(`SELECT e.*, t.name AS type_name, a.name AS account_name
    FROM expenses e JOIN expense_types t ON t.id=e.type_id JOIN financial_accounts a ON a.id=e.account_id
    WHERE ${eConds.join(' AND ')} ORDER BY e.expense_date DESC LIMIT 2000`, eParams)).rows;
  const totalIn = payments.reduce((s, p) => s + parseFloat(p.amount), 0);
  const totalOut = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
  const balances = await accountBalances();
  const types = (await q('SELECT * FROM expense_types ORDER BY name')).rows;
  const overdue = (await q(`SELECT cu.name AS customer_name, cu.phone, i.amount, i.due_date
    FROM installments i JOIN installment_plans pl ON pl.id=i.plan_id JOIN sales_orders o ON o.id=pl.order_id AND o.status='approved'
    JOIN customers cu ON cu.id=o.customer_id
    WHERE i.status='pending' AND i.due_date < current_date
    AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount
    ORDER BY i.due_date LIMIT 500`)).rows;
  if (format === 'csv' && can(req.user.roles, 'reports.export')) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="finance-report.csv"');
    const rows = payments.map(p => ({ kind: 'إيراد', date: new Date(p.paid_at).toISOString().slice(0, 10), label: p.customer_name, amount: p.amount, account: p.account_name }))
      .concat(expenses.map(e => ({ kind: 'مصروف', date: new Date(e.expense_date).toISOString().slice(0, 10), label: e.type_name, amount: -parseFloat(e.amount), account: e.account_name })));
    return res.send(csv(rows, [
      { key: 'kind', label: 'النوع' }, { key: 'date', label: 'التاريخ' }, { key: 'label', label: 'البيان' },
      { key: 'amount', label: 'المبلغ' }, { key: 'account', label: 'الحساب' }
    ]));
  }
  res.render('reports/finance', { title: 'التقرير المالي', nav: 'reports', payments, expenses, totalIn, totalOut, balances, types, overdue, query: req.query, canExport: can(req.user.roles, 'reports.export') });
});

module.exports = router;
