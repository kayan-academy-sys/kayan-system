const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth, requireCap('groups.view', 'groups.manage'));

async function groupsWithCounts(status) {
  let where = '';
  const params = [];
  if (status) { params.push(status); where = 'WHERE g.status=$1'; }
  return (await q(`SELECT g.*, c.name AS course_name, t.name AS trainer_name,
    (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
    FROM groups g JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
    ${where} ORDER BY g.start_date NULLS LAST, g.id DESC`, params)).rows;
}

router.get('/', async (req, res) => {
  const rows = await groupsWithCounts(req.query.status || null);
  const courses = (await q(`SELECT * FROM courses WHERE status='active' ORDER BY name`)).rows;
  const trainers = (await q(`SELECT * FROM trainers WHERE status='active' ORDER BY name`)).rows;
  res.render('groups/index', { title: 'المجموعات', nav: 'groups', rows, courses, trainers, query: req.query });
});

router.post('/', requireCap('groups.manage'), async (req, res) => {
  const { course_id, trainer_id, name, start_date, end_date, capacity, days_of_week, time_from, time_to, status } = req.body;
  const validStatus = ['draft','open'];
  await q(`INSERT INTO groups (course_id, trainer_id, name, start_date, end_date, capacity, days_of_week, time_from, time_to, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [course_id, trainer_id || null, name.trim(), start_date || null, end_date || null, parseInt(capacity) || 20,
     days_of_week || null, time_from || null, time_to || null, validStatus.includes(status) ? status : 'draft', req.user.id]);
  await audit(req, 'group_created', 'group', null, { name, course_id });
  res.redirect('/groups');
});

router.get('/:id', async (req, res) => {
  const { rows } = await q(`SELECT g.*, c.name AS course_name, t.name AS trainer_name FROM groups g JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id WHERE g.id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).render('error', { title: 'غير موجود', message: 'المجموعة غير موجودة.' });
  const group = rows[0];
  const sessions = (await q(`SELECT s.*, u.name AS postponed_by_name,
    (SELECT count(*) FROM attendance a WHERE a.session_id=s.id AND a.status='present') AS present_count
    FROM sessions s LEFT JOIN users u ON u.id=s.postponed_by WHERE s.group_id=$1 ORDER BY s.session_date, s.start_time`, [group.id])).rows;
  const students = (await q(`SELECT e.id AS enrollment_id, cu.name, cu.phone, e.status, e.created_at FROM enrollments e JOIN customers cu ON cu.id=e.customer_id WHERE e.group_id=$1 AND e.status='active' ORDER BY cu.name`, [group.id])).rows;
  const booked = students.length;
  // تسجيلات نشطة لنفس الكورس لم تُحدد مجموعتها بعد — لإلحاقها بهذه المجموعة من هنا
  let unassigned = [];
  if (can(req.user.role, 'groups.manage') && ['open','nearly_full'].includes(group.status)) {
    unassigned = (await q(`SELECT e.id AS enrollment_id, cu.name, cu.phone, o.id AS order_id
      FROM enrollments e JOIN customers cu ON cu.id=e.customer_id JOIN sales_orders o ON o.id=e.order_id AND o.status='approved'
      WHERE e.course_id=$1 AND e.group_id IS NULL AND e.status='active' ORDER BY cu.name`, [group.course_id])).rows;
  }
  res.render('groups/detail', { title: 'مجموعة ' + group.name, nav: 'groups', group, sessions, students, booked, available: group.capacity - booked, canManage: can(req.user.role, 'groups.manage'), unassigned });
});

// إلحاق تسجيل غير محدد المجموعة بهذه المجموعة (صلاحية إدارة المجموعات + فحص السعة)
router.post('/:id/enroll', requireCap('groups.manage'), async (req, res) => {
  const group = (await q(`SELECT * FROM groups WHERE id=$1 AND status IN ('open','nearly_full')`, [req.params.id])).rows[0];
  if (!group) return res.status(404).render('error', { title: 'غير موجودة', message: 'المجموعة غير موجودة أو غير متاحة للحجز.' });
  const e = (await q(`SELECT e.* FROM enrollments e JOIN sales_orders o ON o.id=e.order_id AND o.status='approved'
    WHERE e.id=$1 AND e.course_id=$2 AND e.group_id IS NULL AND e.status='active'`, [req.body.enrollment_id, group.course_id])).rows[0];
  if (!e) return res.status(400).render('error', { title: 'غير صالح', message: 'التسجيل غير موجود أو حُددت مجموعته بالفعل.' });
  const cnt = (await q(`SELECT count(*) AS n FROM enrollments WHERE group_id=$1 AND status='active'`, [group.id])).rows[0].n;
  if (parseInt(cnt, 10) >= group.capacity) return res.status(409).render('error', { title: 'مكتملة', message: 'المجموعة مكتملة العدد.' });
  await q('UPDATE enrollments SET group_id=$1 WHERE id=$2', [group.id, e.id]);
  await audit(req, 'enrollment_group_assigned', 'enrollment', e.id, { group_id: group.id, order_id: e.order_id });
  res.redirect('/groups/' + group.id);
});

router.post('/:id/edit', requireCap('groups.manage'), async (req, res) => {
  const { trainer_id, name, start_date, end_date, capacity, days_of_week, time_from, time_to, status } = req.body;
  const validStatus = ['draft','open','nearly_full','full','running','finished','cancelled'];
  await q(`UPDATE groups SET trainer_id=$1, name=$2, start_date=$3, end_date=$4, capacity=$5, days_of_week=$6, time_from=$7, time_to=$8, status=$9 WHERE id=$10`,
    [trainer_id || null, name.trim(), start_date || null, end_date || null, parseInt(capacity) || 20, days_of_week || null, time_from || null, time_to || null, validStatus.includes(status) ? status : 'draft', req.params.id]);
  await audit(req, 'group_updated', 'group', req.params.id, { name, status });
  res.redirect('/groups/' + req.params.id);
});

// إضافة محاضرة للمجموعة (سجل مستقل لكل محاضرة)
router.post('/:id/sessions', requireCap('sessions.manage'), async (req, res) => {
  const { session_date, start_time, end_time, topic } = req.body;
  if (!session_date) return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'تاريخ المحاضرة إلزامي.' });
  await q('INSERT INTO sessions (group_id, session_date, start_time, end_time, topic) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, session_date, start_time || null, end_time || null, topic || null]);
  await audit(req, 'session_created', 'session', null, { group_id: req.params.id, session_date });
  res.redirect('/groups/' + req.params.id);
});

module.exports = router;
