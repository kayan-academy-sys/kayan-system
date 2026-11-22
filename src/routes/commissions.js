const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { setSetting } = require('../lib/settings');
const { can } = require('../lib/permissions');
const { RULE_KEY, DEFAULTS, METHOD_LABELS, getRule, computeMonth } = require('../lib/commissions');

function monthKeyOf(s) {
  return /^(\d{4})-(\d{2})$/.test(s || '') ? s : null;
}
function currentMonthKey() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
}

// ---------- لوحة الحسابات ----------
const accounting = express.Router();
accounting.use(requireAuth, requireCap('commissions.view.all', 'commissions.manage'));

accounting.get('/', async (req, res) => {
  const rule = await getRule();
  const mkey = monthKeyOf(req.query.month) || currentMonthKey();
  const { rows } = await q(`
    SELECT cm.*, u.name AS sales_name, u.role AS sales_role
    FROM commission_months cm JOIN users u ON u.id=cm.sales_user_id
    WHERE cm.month=($1||'-01')::date ORDER BY cm.amount DESC, u.name`, [mkey]);
  const salesUsers = (await q(`SELECT id, name, monthly_target FROM users WHERE role IN ('sales_manager','sales_team_leader','sales_staff') AND active=TRUE ORDER BY name`)).rows;
  res.render('accounting/commissions', {
    title: 'عمولات المبيعات', nav: 'commissions', rows, rule, defaults: DEFAULTS, methodLabels: METHOD_LABELS,
    salesUsers, month: mkey, canManage: can(req.user.role, 'commissions.manage'), saved: req.query.saved === '1'
  });
});

accounting.post('/rule', requireCap('commissions.manage'), async (req, res) => {
  const method = METHOD_LABELS[req.body.method] ? req.body.method : null;
  if (!method) return res.status(400).render('error', { title: 'خطأ', message: 'اختر طريقة توزيع النسبة على ما فوق التارجت.' });
  const rule = {
    target: parseFloat(req.body.target) || DEFAULTS.target,
    threshold_pct: parseFloat(req.body.threshold_pct) || DEFAULTS.threshold_pct,
    rate_in: parseFloat(req.body.rate_in) || DEFAULTS.rate_in,
    rate_over: parseFloat(req.body.rate_over) || DEFAULTS.rate_over,
    method
  };
  await setSetting(RULE_KEY, rule, req.user.id);
  await audit(req, 'commission_rule.set', 'settings', null, rule);
  res.redirect('/accounting/commissions?saved=1');
});

accounting.post('/target', requireCap('commissions.manage'), async (req, res) => {
  const uid = parseInt(req.body.user_id, 10) || 0;
  const t = parseFloat(req.body.monthly_target);
  await q('UPDATE users SET monthly_target=$1 WHERE id=$2', [(t > 0 ? t : null), uid]);
  await audit(req, 'commission_target.set', 'users', uid, { monthly_target: t > 0 ? t : null });
  res.redirect('/accounting/commissions?saved=1');
});

accounting.post('/generate', requireCap('commissions.manage'), async (req, res) => {
  const rule = await getRule();
  if (!rule.method) return res.status(400).render('error', { title: 'خطأ', message: 'حدّد قاعدة العمولة وطريقة التوزيع أولًا.' });
  const mkey = monthKeyOf(req.body.month) || currentMonthKey();
  const result = await tx(async (c) => {
    const { rows: staff } = await c.query(`SELECT id FROM users WHERE role IN ('sales_manager','sales_team_leader','sales_staff') AND active=TRUE`);
    let touched = 0, skipped = 0;
    for (const s of staff) {
      const r = await computeMonth(s.id, mkey, rule);
      if (!r.eligible && r.invoiced === 0 && r.collected === 0) { skipped++; continue; }
      const up = await c.query(`
        INSERT INTO commission_months (sales_user_id, month, target, invoiced, collected, eligible, method, rate_in, rate_over, amount, computed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (sales_user_id, month) DO UPDATE SET
          target=EXCLUDED.target, invoiced=EXCLUDED.invoiced, collected=EXCLUDED.collected,
          eligible=EXCLUDED.eligible, method=EXCLUDED.method, rate_in=EXCLUDED.rate_in, rate_over=EXCLUDED.rate_over,
          amount=EXCLUDED.amount, computed_by=EXCLUDED.computed_by, computed_at=now()
        WHERE commission_months.status='pending'`,
        [s.id, mkey + '-01', r.target, r.invoiced, r.collected, r.eligible, rule.method, rule.rate_in, rule.rate_over, r.amount, req.user.id]);
      if (up.rowCount) touched++;
    }
    return { touched, skipped };
  });
  await audit(req, 'commission.generate', 'commission_months', mkey, { rule, ...result });
  res.redirect('/accounting/commissions?month=' + mkey + '&saved=1');
});

async function setStatus(req, res, id, from, to, markPaid) {
  const params = [to, id, from];
  const extra = markPaid ? ', paid_at=now(), paid_by=$4' : '';
  if (markPaid) params.push(req.user.id);
  const { rowCount } = await q(
    `UPDATE commission_months SET status=$1${extra} WHERE id=$2 AND status=$3`, params);
  if (!rowCount) return res.status(409).render('error', { title: 'خطأ', message: 'حالة العمولة لا تسمح بهذا الإجراء.' });
  await audit(req, 'commission.' + to, 'commission_months', id, null);
  res.redirect(req.get('referer') || '/accounting/commissions');
}

accounting.post('/:id/approve', requireCap('commissions.manage'), (req, res) => setStatus(req, res, req.params.id, 'pending', 'approved', false));
accounting.post('/:id/pay', requireCap('commissions.manage'), (req, res) => setStatus(req, res, req.params.id, 'approved', 'paid', true));
accounting.post('/:id/cancel', requireCap('commissions.manage'), async (req, res) => {
  const { rowCount } = await q(
    `UPDATE commission_months SET status='cancelled', note=$1 WHERE id=$2 AND status IN ('pending','approved')`,
    [req.body.note || null, req.params.id]);
  if (!rowCount) return res.status(409).render('error', { title: 'خطأ', message: 'حالة العمولة لا تسمح بالإلغاء.' });
  await audit(req, 'commission.cancelled', 'commission_months', req.params.id, { note: req.body.note || null });
  res.redirect(req.get('referer') || '/accounting/commissions');
});

// ---------- صفحة "عمولتي" للمبيعات (خادم: صفوف المستخدم الحالي فقط) ----------
const my = express.Router();
my.use(requireAuth, requireCap('commissions.view.own'));

my.get('/', async (req, res) => {
  const { rows } = await q(`
    SELECT * FROM commission_months WHERE sales_user_id=$1 ORDER BY month DESC LIMIT 24`, [req.user.id]);
  const totals = rows.reduce((m, r) => {
    if (r.status !== 'cancelled') m[r.status] = (m[r.status] || 0) + parseFloat(r.amount);
    return m;
  }, {});
  res.render('commissions/my', { title: 'عمولتي', nav: 'mycomm', rows, totals });
});

module.exports = { accounting, my };
