const { q } = require('../db');
const { getSetting } = require('./settings');

const RULE_KEY = 'commission_rule_v2';
const DEFAULTS = { target: 50000, threshold_pct: 80, rate_in: 7.5, rate_over: 10, method: null };
const METHOD_LABELS = {
  collection_tier: 'التحصيل حتى التارجت بنسبة ٧٫٥٪ وما فوقه بنسبة ١٠٪',
  invoice_weighted: 'النسبة المرجّحة بمزيج فواتير الشهر (داخل/فوق التارجت) تُطبق على التحصيل'
};

async function getRule() {
  const r = await getSetting(RULE_KEY, {});
  return {
    target: parseFloat(r.target) > 0 ? parseFloat(r.target) : DEFAULTS.target,
    threshold_pct: parseFloat(r.threshold_pct) > 0 ? parseFloat(r.threshold_pct) : DEFAULTS.threshold_pct,
    rate_in: parseFloat(r.rate_in) >= 0 && r.rate_in !== undefined ? parseFloat(r.rate_in) : DEFAULTS.rate_in,
    rate_over: parseFloat(r.rate_over) >= 0 && r.rate_over !== undefined ? parseFloat(r.rate_over) : DEFAULTS.rate_over,
    method: METHOD_LABELS[r.method] ? r.method : null
  };
}

// احتساب شهر واحد لموظف واحد: الفواتير والتحصيلات المنسوبة له (حدود الشهر بتوقيت القاهرة)
async function computeMonth(userId, mkey, rule) {
  const targetRow = (await q('SELECT monthly_target FROM users WHERE id=$1', [userId])).rows[0];
  const target = targetRow && parseFloat(targetRow.monthly_target) > 0 ? parseFloat(targetRow.monthly_target) : rule.target;
  const inv = (await q(`
    SELECT COALESCE(sum(total_price),0) AS t FROM sales_orders
    WHERE sales_user_id=$1 AND status='approved'
      AND created_at >= ($2||'-01')::timestamp AT TIME ZONE 'Africa/Cairo'
      AND created_at < (($2||'-01')::date + interval '1 month')::timestamp AT TIME ZONE 'Africa/Cairo'`, [userId, mkey])).rows[0].t;
  const col = (await q(`
    SELECT COALESCE(sum(p.amount),0) AS t FROM payments p
    JOIN sales_orders o ON o.id=p.order_id
    WHERE o.sales_user_id=$1 AND p.status='active' AND o.status='approved'
      AND p.paid_at >= ($2||'-01')::timestamp AT TIME ZONE 'Africa/Cairo'
      AND p.paid_at < (($2||'-01')::date + interval '1 month')::timestamp AT TIME ZONE 'Africa/Cairo'`, [userId, mkey])).rows[0].t;
  const invoiced = parseFloat(inv), collected = parseFloat(col);
  const eligible = invoiced >= target * (rule.threshold_pct / 100);
  let amount = 0;
  if (eligible && collected > 0) {
    if (rule.method === 'collection_tier') {
      const inPart = Math.min(collected, target);
      const overPart = Math.max(0, collected - target);
      amount = inPart * rule.rate_in / 100 + overPart * rule.rate_over / 100;
    } else {
      // invoice_weighted: مزيج النسبة حسب حصة الفواتير داخل/فوق التارجت
      const inShare = Math.min(invoiced, target) / invoiced;
      const effRate = rule.rate_in * inShare + rule.rate_over * (1 - inShare);
      amount = collected * effRate / 100;
    }
    amount = Math.round(amount * 100) / 100;
  }
  return { target, invoiced, collected, eligible, amount };
}

module.exports = { RULE_KEY, DEFAULTS, METHOD_LABELS, getRule, computeMonth };
