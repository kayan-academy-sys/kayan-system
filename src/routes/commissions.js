const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { getSetting, setSetting } = require('../lib/settings');
const { can } = require('../lib/permissions');

const RULE_KEY = 'commission_rule';
const BASIS_LABELS = {
  percent_booking: 'نسبة من قيمة الحجز',
  percent_collected: 'نسبة من المبلغ المحصّل',
  fixed: 'مبلغ ثابت لكل حجز'
};

async function getRule() {
  const rule = await getSetting(RULE_KEY, null);
  if (!rule || !rule.basis || !BASIS_LABELS[rule.basis]) return null;
  if (rule.basis === 'fixed' && !(parseFloat(rule.fixed_amount) > 0)) return null;
  if (rule.basis !== 'fixed' && !(parseFloat(rule.percent) > 0)) return null;
  return rule;
}

function computeAmount(rule, basisAmount) {
  if (rule.basis === 'fixed') return Math.round(parseFloat(rule.fixed_amount) * 100) / 100;
  return Math.round(basisAmount * parseFloat(rule.percent)) / 100;
}

// ---------- لوحة الحسابات ----------
const accounting = express.Router();
accounting.use(requireAuth, requireCap('commissions.view.all', 'commissions.manage'));

accounting.get('/', async (req, res) => {
  const rule = await getRule();
  const filters = []; const params = [];
  if (req.query.user) { params.push(parseInt(req.query.user, 10) || 0); filters.push(`cm.sales_user_id=$${params.length}`); }
  if (req.query.status) { params.push(req.query.status); filters.push(`cm.status=$${params.length}`); }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  const { rows } = await q(`
    SELECT cm.*, u.name AS sales_name, o.total_price, o.created_at AS order_at, c.name AS customer_name
    FROM commissions cm
    JOIN users u ON u.id=cm.sales_user_id
    JOIN sales_orders o ON o.id=cm.order_id
    JOIN customers c ON c.id=o.customer_id
    ${where} ORDER BY cm.id DESC LIMIT 500`, params);
  const totals = (await q(`SELECT status, COALESCE(sum(amount),0) AS total FROM commissions GROUP BY status`)).rows
    .reduce((m, r) => { m[r.status] = parseFloat(r.total); return m; }, {});
  const salesUsers = (await q(`SELECT id, name FROM users WHERE role IN ('sales_manager','sales_team_leader','sales_staff') AND active=TRUE ORDER BY name`)).rows;
  res.render('accounting/commissions', {
    title: 'عمولات المبيعات', nav: 'commissions', rows, totals, salesUsers, rule,
    rawRule: await getSetting(RULE_KEY, {}), basisLabels: BASIS_LABELS,
    canManage: can(req.user.role, 'commissions.manage'), query: req.query, saved: req.query.saved === '1'
  });
});

accounting.post('/rule', requireCap('commissions.manage'), async (req, res) => {
  const basis = req.body.basis;
  if (!BASIS_LABELS[basis]) return res.status(400).send('قاعدة غير صالحة');
  const rule = { basis, percent: parseFloat(req.body.percent) || 0, fixed_amount: parseFloat(req.body.fixed_amount) || 0 };
  await setSetting(RULE_KEY, rule, req.user.id);
  await audit(req, 'commission_rule.set', 'settings', null, rule);
  res.redirect('/accounting/commissions?saved=1');
});

accounting.post('/generate', requireCap('commissions.manage'), async (req, res) => {
  const rule = await getRule();
  if (!rule) return res.status(400).render('error', { title: 'خطأ', message: 'حدّد قاعدة احتساب العمولة أولًا.' });
  const result = await tx(async (c) => {
    const { rows: orders } = await c.query(`
      SELECT o.id, o.sales_user_id, o.total_price,
        COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.order_id=o.id AND p.status='active'), 0) AS collected
      FROM sales_orders o
      JOIN users u ON u.id=o.sales_user_id
      WHERE o.status='approved' AND o.sales_user_id IS NOT NULL
        AND u.role IN ('sales_manager','sales_team_leader','sales_staff')`);
    let created = 0, updated = 0;
    for (const o of orders) {
      const basisAmount = rule.basis === 'percent_collected' ? parseFloat(o.collected) : parseFloat(o.total_price);
      if (basisAmount <= 0) continue;
      const amount = computeAmount(rule, basisAmount);
      const existing = (await c.query('SELECT id, status FROM commissions WHERE order_id=$1', [o.id])).rows[0];
      if (!existing) {
        await c.query(`INSERT INTO commissions (sales_user_id, order_id, basis, basis_amount, rate, amount, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [o.sales_user_id, o.id, rule.basis, basisAmount, rule.basis === 'fixed' ? null : parseFloat(rule.percent), amount, req.user.id]);
        created++;
      } else if (existing.status === 'pending') {
        await c.query(`UPDATE commissions SET basis=$1, basis_amount=$2, rate=$3, amount=$4, updated_at=now() WHERE id=$5`,
          [rule.basis, basisAmount, rule.basis === 'fixed' ? null : parseFloat(rule.percent), amount, existing.id]);
        updated++;
      }
    }
    return { created, updated };
  });
  await audit(req, 'commission.generate', 'commissions', null, { rule, ...result });
  res.redirect('/accounting/commissions?saved=1');
});

async function setStatus(req, res, id, from, to, markPaid) {
  const params = [to, id, from];
  const extra = markPaid ? ', paid_at=now(), paid_by=$4' : '';
  if (markPaid) params.push(req.user.id);
  const { rowCount } = await q(
    `UPDATE commissions SET status=$1, updated_at=now()${extra} WHERE id=$2 AND status=$3`, params);
  if (!rowCount) return res.status(409).render('error', { title: 'خطأ', message: 'حالة العمولة لا تسمح بهذا الإجراء.' });
  await audit(req, 'commission.' + to, 'commissions', id, null);
  res.redirect('/accounting/commissions');
}

accounting.post('/:id/approve', requireCap('commissions.manage'), (req, res) => setStatus(req, res, req.params.id, 'pending', 'approved', false));
accounting.post('/:id/pay', requireCap('commissions.manage'), (req, res) => setStatus(req, res, req.params.id, 'approved', 'paid', true));
accounting.post('/:id/cancel', requireCap('commissions.manage'), async (req, res) => {
  const { rowCount } = await q(
    `UPDATE commissions SET status='cancelled', note=$1, updated_at=now() WHERE id=$2 AND status IN ('pending','approved')`,
    [req.body.note || null, req.params.id]);
  if (!rowCount) return res.status(409).render('error', { title: 'خطأ', message: 'حالة العمولة لا تسمح بالإلغاء.' });
  await audit(req, 'commission.cancelled', 'commissions', req.params.id, { note: req.body.note || null });
  res.redirect('/accounting/commissions');
});

// ---------- صفحة "عمولتي" للمبيعات (خادم: صفوف المستخدم الحالي فقط) ----------
const my = express.Router();
my.use(requireAuth, requireCap('commissions.view.own'));

my.get('/', async (req, res) => {
  const { rows } = await q(`
    SELECT cm.*, o.total_price, o.created_at AS order_at, c.name AS customer_name
    FROM commissions cm
    JOIN sales_orders o ON o.id=cm.order_id
    JOIN customers c ON c.id=o.customer_id
    WHERE cm.sales_user_id=$1
    ORDER BY cm.id DESC LIMIT 300`, [req.user.id]);
  const totals = rows.reduce((m, r) => {
    m[r.status] = (m[r.status] || 0) + parseFloat(r.amount);
    return m;
  }, {});
  res.render('commissions/my', { title: 'عمولتي', nav: 'mycomm', rows, totals, basisLabels: BASIS_LABELS });
});

module.exports = { accounting, my };
