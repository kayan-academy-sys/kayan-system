// أرصدة الحسابات المالية: مدفوعات واردة - مصروفات ± تحويلات
const { q } = require('../db');

async function accountBalances() {
  const { rows } = await q(`
    SELECT a.id, a.name, a.type,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.account_id=a.id AND p.status='active'),0)
      - COALESCE((SELECT sum(e.amount) FROM expenses e WHERE e.account_id=a.id AND e.status='active'),0)
      - COALESCE((SELECT sum(t.amount) FROM transfers t WHERE t.from_account_id=a.id AND t.status='active'),0)
      + COALESCE((SELECT sum(t.amount) FROM transfers t WHERE t.to_account_id=a.id AND t.status='active'),0) AS balance
    FROM financial_accounts a WHERE a.active=TRUE ORDER BY a.id`);
  return rows;
}

module.exports = { accountBalances };
