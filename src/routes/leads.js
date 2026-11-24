const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');
const { autoAssign, distributeLeads, presentSalesStaff } = require('../lib/distribute');

const router = express.Router();
router.use(requireAuth);

function scopeLeads(req) {
  // المشاهدة: الكل أو المسند إليه فقط
  if (can(req.user.roles, 'leads.view.all')) return { cond: '', params: [] };
  return { cond: 'AND (l.assigned_to=$1 OR l.created_by=$1)', params: [req.user.id] };
}

router.get('/', requireCap('leads.view.all', 'leads.view.own'), async (req, res) => {
  const { cond, params } = scopeLeads(req);
  const filters = []; 
  if (req.query.status) { params.push(req.query.status); filters.push(`l.status=$${params.length}`); }
  if (req.query.source) { params.push(req.query.source); filters.push(`l.source=$${params.length}`); }
  if (req.query.assigned) { params.push(req.query.assigned); filters.push(`l.assigned_to=$${params.length}`); }
  if (req.query.q) { params.push('%' + req.query.q.trim() + '%'); filters.push(`(c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`); }
  if (req.query.followup === 'due') { filters.push(`l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= now() AND l.status IN ('new','no_answer','interested','need_follow_up')`); }
  const where = 'WHERE TRUE ' + cond + (filters.length ? ' AND ' + filters.join(' AND ') : '');
  const { rows } = await q(`
    SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, co.name AS course_name, u.name AS assigned_name,
      (l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= now() AND l.status IN ('new','no_answer','interested','need_follow_up')) AS followup_due
    FROM leads l JOIN customers c ON c.id=l.customer_id
    LEFT JOIN courses co ON co.id=l.course_id LEFT JOIN users u ON u.id=l.assigned_to
    ${where} ORDER BY followup_due DESC, l.id DESC LIMIT 300`, params);
  const salesUsers = can(req.user.roles, 'leads.view.all')
    ? (await q(`SELECT id, name FROM users WHERE (role IN ('sales_manager','sales_team_leader','sales_staff') OR extra_roles && ARRAY['sales_manager','sales_team_leader','sales_staff']::text[]) AND active=TRUE ORDER BY name`)).rows : [];
  res.render('leads/index', { title: 'العملاء المحتملون', nav: 'leads', rows, salesUsers, query: req.query });
});

router.get('/new', requireCap('leads.create'), async (req, res) => {
  const courses = (await q(`SELECT * FROM courses WHERE status='active' ORDER BY name`)).rows;
  res.render('leads/new', { title: 'إضافة عميل محتمل', nav: 'leads', courses, error: null, old: {} });
});

router.post('/', requireCap('leads.create'), async (req, res) => {
  const { name, phone, email, course_id, source, notes } = req.body;
  const courses = (await q(`SELECT * FROM courses WHERE status='active' ORDER BY name`)).rows;
  if (!name || !phone || !source) {
    return res.status(400).render('leads/new', { title: 'إضافة عميل محتمل', nav: 'leads', courses, error: 'الاسم ورقم الهاتف والمصدر حقول إلزامية.', old: req.body });
  }
  const cleanPhone = phone.trim();
  const result = await tx(async (c) => {
    let customerId;
    const existing = await c.query('SELECT id, name FROM customers WHERE phone=$1', [cleanPhone]);
    if (existing.rowCount) {
      customerId = existing.rows[0].id;
    } else {
      const ins = await c.query('INSERT INTO customers (name, phone, email, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [name.trim(), cleanPhone, email || null, req.user.id]);
      customerId = ins.rows[0].id;
    }
    // تنبيه تكرار: فرصة نشطة لنفس الكورس
    const dup = await c.query(`SELECT id FROM leads WHERE customer_id=$1 AND course_id IS NOT DISTINCT FROM $2 AND status NOT IN ('closed_lost','booked_cash','booked_installment')`, [customerId, course_id || null]);
    const lead = await c.query('INSERT INTO leads (customer_id, course_id, source, created_by, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [customerId, course_id || null, source, req.user.id, 'new']);
    return { customerId, leadId: lead.rows[0].id, existed: existing.rowCount > 0, dupOpen: dup.rowCount > 0 };
  });
  const assigned = await autoAssign(result.leadId, req.user.id);
  await audit(req, 'lead_created', 'lead', result.leadId, { customerId: result.customerId, source, existed: result.existed, autoAssigned: !!assigned });
  const notice = [];
  if (result.existed) notice.push('تم ربط الفرصة بملف عميل موجود مسبقًا بنفس رقم الهاتف.');
  if (result.dupOpen) notice.push('تنبيه: توجد فرصة مفتوحة أخرى لنفس العميل والكورس.');
  res.redirect('/leads/' + result.leadId + (notice.length ? '?notice=' + encodeURIComponent(notice.join(' ')) : ''));
});

router.get('/distribution', requireCap('leads.assign'), async (req, res) => {
  const staff = await presentSalesStaff();
  const allSales = (await q(`SELECT u.id, u.name, u.role,
    (SELECT present FROM staff_presence sp WHERE sp.user_id=u.id AND sp.work_date=current_date) AS present,
    (SELECT count(*) FROM leads l WHERE l.assigned_to=u.id AND l.status IN ('new','no_answer','interested','need_follow_up')) AS load
    FROM users u WHERE (u.role IN ('sales_staff','sales_team_leader') OR u.extra_roles && ARRAY['sales_staff','sales_team_leader']::text[]) AND u.active=TRUE ORDER BY u.name`)).rows;
  const unassigned = (await q(`SELECT l.id, c.name AS customer_name, c.phone, co.name AS course_name, l.created_at FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN courses co ON co.id=l.course_id WHERE l.assigned_to IS NULL AND l.status='new' ORDER BY l.id`)).rows;
  res.render('leads/distribution', { title: 'توزيع العملاء', nav: 'dist', allSales, unassigned, presentCount: staff.length, msg: req.query.msg || null });
});

router.post('/distribution/presence', requireCap('leads.assign'), async (req, res) => {
  const presentIds = [].concat(req.body.present || []).map(Number);
  const allSales = (await q(`SELECT id FROM users WHERE (role IN ('sales_staff','sales_team_leader') OR extra_roles && ARRAY['sales_staff','sales_team_leader']::text[]) AND active=TRUE`)).rows;
  await tx(async (c) => {
    for (const u of allSales) {
      await c.query(`INSERT INTO staff_presence (user_id, work_date, present, marked_by) VALUES ($1, current_date, $2, $3)
        ON CONFLICT (user_id, work_date) DO UPDATE SET present=$2, marked_by=$3`, [u.id, presentIds.includes(u.id), req.user.id]);
    }
  });
  await audit(req, 'presence_marked', 'staff_presence', null, { presentIds });
  res.redirect('/leads/distribution?msg=' + encodeURIComponent('تم حفظ حضور فريق المبيعات لليوم.'));
});

router.post('/distribution/run', requireCap('leads.assign'), async (req, res) => {
  const result = await distributeLeads(null, req.user.id, 'توزيع يدوي من صفحة التوزيع');
  await audit(req, 'leads_distributed', 'lead', null, result);
  res.redirect('/leads/distribution?msg=' + encodeURIComponent(result.message || `تم توزيع ${result.moved} عميلًا على ${result.staffCount || 0} موظفين.`));
});

router.get('/monitor', requireCap('leads.monitor'), async (req, res) => {
  const staffStats = (await q(`
    SELECT u.id, u.name, u.role,
      count(l.id) FILTER (WHERE l.status NOT IN ('closed_lost','booked_cash','booked_installment')) AS active_leads,
      count(l.id) FILTER (WHERE l.status='new') AS new_leads,
      count(l.id) FILTER (WHERE l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < now() AND l.status IN ('new','no_answer','interested','need_follow_up')) AS overdue,
      count(l.id) FILTER (WHERE l.status IN ('booked_cash','booked_installment')) AS booked
    FROM users u LEFT JOIN leads l ON l.assigned_to=u.id
    WHERE (u.role IN ('sales_staff','sales_team_leader') OR u.extra_roles && ARRAY['sales_staff','sales_team_leader']::text[]) AND u.active=TRUE
    GROUP BY u.id, u.name, u.role ORDER BY u.name`)).rows;
  const recent = (await q(`
    SELECT a.*, u.name AS user_name, c.name AS customer_name, c.phone AS customer_phone, l.id AS lead_id
    FROM lead_activities a JOIN users u ON u.id=a.user_id JOIN leads l ON l.id=a.lead_id JOIN customers c ON c.id=l.customer_id
    ORDER BY a.id DESC LIMIT 60`)).rows;
  res.render('leads/monitor', { title: 'متابعة فريق المبيعات', nav: 'monitor', staffStats, recent });
});

router.get('/:id', requireCap('leads.view.all', 'leads.view.own'), async (req, res) => {
  const { rows } = await q(`
    SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, co.name AS course_name, u.name AS assigned_name
    FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN courses co ON co.id=l.course_id LEFT JOIN users u ON u.id=l.assigned_to
    WHERE l.id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).render('error', { title: 'غير موجود', message: 'الفرصة غير موجودة.' });
  const lead = rows[0];
  if (!can(req.user.roles, 'leads.view.all') && lead.assigned_to !== req.user.id && lead.created_by !== req.user.id) {
    return res.status(403).render('error', { title: 'غير مسموح', message: 'هذه الفرصة مسندة لموظف آخر.' });
  }
  const activities = (await q(`SELECT a.*, u.name AS user_name FROM lead_activities a JOIN users u ON u.id=a.user_id WHERE a.lead_id=$1 ORDER BY a.id DESC`, [lead.id])).rows;
  const assignments = (await q(`SELECT la.*, f.name AS from_name, t.name AS to_name, b.name AS by_name FROM lead_assignments la
    LEFT JOIN users f ON f.id=la.from_user_id LEFT JOIN users t ON t.id=la.to_user_id LEFT JOIN users b ON b.id=la.assigned_by
    WHERE la.lead_id=$1 ORDER BY la.id DESC`, [lead.id])).rows;
  const salesUsers = can(req.user.roles, 'leads.assign') ? (await q(`SELECT id, name FROM users WHERE (role IN ('sales_staff','sales_team_leader') OR extra_roles && ARRAY['sales_staff','sales_team_leader']::text[]) AND active=TRUE ORDER BY name`)).rows : [];
  res.render('leads/detail', { title: 'فرصة: ' + lead.customer_name, nav: 'leads', lead, activities, assignments, salesUsers, notice: req.query.notice || null });
});

router.post('/:id/activity', requireCap('leads.edit'), async (req, res) => {
  const lead = (await q('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0];
  if (!lead) return res.status(404).render('error', { title: 'غير موجود', message: 'الفرصة غير موجودة.' });
  if (!can(req.user.roles, 'leads.view.all') && lead.assigned_to !== req.user.id && lead.created_by !== req.user.id) {
    return res.status(403).render('error', { title: 'غير مسموح', message: 'هذه الفرصة مسندة لموظف آخر.' });
  }
  const { type, result, notes, next_follow_up_at, status, interest_score, lost_reason } = req.body;
  const score = interest_score ? parseInt(interest_score, 10) : null;
  if (score !== null && (score < 1 || score > 10)) {
    return res.status(400).render('error', { title: 'قيمة غير صالحة', message: 'درجة الاهتمام يجب أن تكون بين 1 و 10.' });
  }
  const validStatus = ['new','no_answer','interested','need_follow_up','closed_lost'];
  await tx(async (c) => {
    await c.query('INSERT INTO lead_activities (lead_id, user_id, type, result, notes, next_follow_up_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [lead.id, req.user.id, ['call','note','follow_up'].includes(type) ? type : 'call', result || null, notes || null, next_follow_up_at || null]);
    const updates = []; const params = [lead.id];
    if (status && validStatus.includes(status)) {
      params.push(status); updates.push(`status=$${params.length}`);
      if (status === 'closed_lost') { params.push(lost_reason || null); updates.push(`lost_reason=$${params.length}`); }
      if (status === 'interested' && score) { params.push(score); updates.push(`interest_score=$${params.length}`); }
      await c.query('INSERT INTO lead_activities (lead_id, user_id, type, result, notes) VALUES ($1,$2,$3,$4,$5)',
        [lead.id, req.user.id, 'status_change', status, notes || null]);
    }
    if (next_follow_up_at) { params.push(next_follow_up_at); updates.push(`next_follow_up_at=$${params.length}`); }
    if (updates.length) await c.query(`UPDATE leads SET ${updates.join(', ')}, updated_at=now() WHERE id=$1`, params);
  });
  await audit(req, 'lead_activity', 'lead', lead.id, { type, status });
  res.redirect('/leads/' + lead.id);
});

router.post('/:id/assign', requireCap('leads.assign'), async (req, res) => {
  const lead = (await q('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0];
  if (!lead) return res.status(404).render('error', { title: 'غير موجود', message: 'الفرصة غير موجودة.' });
  const toId = parseInt(req.body.to_user_id, 10);
  const target = (await q(`SELECT id, name FROM users WHERE id=$1 AND (role IN ('sales_staff','sales_team_leader') OR extra_roles && ARRAY['sales_staff','sales_team_leader']::text[]) AND active=TRUE`, [toId])).rows[0];
  if (!target) return res.status(400).render('error', { title: 'اختيار غير صالح', message: 'الموظف المختار غير صالح.' });
  await tx(async (c) => {
    await c.query('UPDATE leads SET assigned_to=$1, assigned_at=now(), updated_at=now() WHERE id=$2', [toId, lead.id]);
    await c.query('INSERT INTO lead_assignments (lead_id, from_user_id, to_user_id, assigned_by, reason) VALUES ($1,$2,$3,$4,$5)', [lead.id, lead.assigned_to, toId, req.user.id, req.body.reason || 'إسناد يدوي']);
  });
  await audit(req, 'lead_assigned', 'lead', lead.id, { from: lead.assigned_to, to: toId });
  res.redirect('/leads/' + lead.id);
});

module.exports = router;
