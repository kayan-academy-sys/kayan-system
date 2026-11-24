// توزيع العملاء المحتملين على موظفي المبيعات الحاضرين بالتساوي
const { q, pool } = require('../db');
const { getSetting } = require('./settings');
const { notify } = require('./notify');

async function presentSalesStaff() {
  const { rows } = await q(`
    SELECT u.id, u.name,
      (SELECT count(*) FROM leads l WHERE l.assigned_to=u.id AND l.status IN ('new','no_answer','interested','need_follow_up')) AS load
    FROM users u
    WHERE (u.role IN ('sales_staff','sales_team_leader') OR u.extra_roles && ARRAY['sales_staff','sales_team_leader']::text[]) AND u.active=TRUE
      AND EXISTS (SELECT 1 FROM staff_presence sp WHERE sp.user_id=u.id AND sp.work_date=current_date AND sp.present=TRUE)
    ORDER BY load ASC, u.id ASC`);
  return rows;
}

// توزيع قائمة من العملاء (أو كل غير المسندين) على الحاضرين
async function distributeLeads(leadIds, assignedBy, reason) {
  const enabled = await getSetting('lead_distribution_enabled', true);
  if (!enabled) return { moved: 0, message: 'التوزيع الآلي معطّل من الإعدادات' };
  const staff = await presentSalesStaff();
  if (!staff.length) return { moved: 0, message: 'لا يوجد موظفو مبيعات حاضرون اليوم' };
  let leadsQuery, params;
  if (leadIds && leadIds.length) {
    params = [leadIds];
    leadsQuery = `SELECT id, assigned_to FROM leads WHERE id = ANY($1::int[]) AND assigned_to IS NULL ORDER BY id`;
  } else {
    params = [];
    leadsQuery = `SELECT id, assigned_to FROM leads WHERE assigned_to IS NULL AND status='new' ORDER BY id`;
  }
  const { rows: leads } = await q(leadsQuery, params);
  const client = await pool.connect();
  let moved = 0;
  try {
    await client.query('BEGIN');
    for (const lead of leads) {
      const target = staff[0];
      await client.query('UPDATE leads SET assigned_to=$1, assigned_at=now(), updated_at=now() WHERE id=$2', [target.id, lead.id]);
      await client.query('INSERT INTO lead_assignments (lead_id, from_user_id, to_user_id, assigned_by, reason) VALUES ($1,$2,$3,$4,$5)',
        [lead.id, lead.assigned_to, target.id, assignedBy || null, reason || 'توزيع آلي']);
      await client.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'lead_assigned','عميل جديد أُسند إليك','تم إسناد عميل جديد إليك ضمن التوزيع.', $2)`, [target.id, `/leads/${lead.id}`]);
      target.load++;
      staff.sort((a, b) => a.load - b.load || a.id - b.id);
      moved++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { moved, staffCount: staff.length };
}

// إسناد تلقائي لعميل واحد عند إنشائه
async function autoAssign(leadId, assignedBy) {
  const enabled = await getSetting('lead_distribution_enabled', true);
  if (!enabled) return null;
  const staff = await presentSalesStaff();
  if (!staff.length) return null;
  const target = staff[0];
  await q('UPDATE leads SET assigned_to=$1, assigned_at=now() WHERE id=$2', [target.id, leadId]);
  await q('INSERT INTO lead_assignments (lead_id, to_user_id, assigned_by, reason) VALUES ($1,$2,$3,$4)', [leadId, target.id, assignedBy || null, 'إسناد تلقائي عند الإنشاء']);
  await notify(target.id, 'lead_assigned', 'عميل جديد أُسند إليك', 'تم إسناد عميل جديد إليك تلقائيًا.', `/leads/${leadId}`);
  return target.id;
}

module.exports = { distributeLeads, autoAssign, presentSalesStaff };
