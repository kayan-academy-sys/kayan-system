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
  if(!Number.isInteger(Number(capacity))||Number(capacity)<1)return res.status(400).render('error',{title:'سعة غير صالحة',message:'السعة عدد صحيح موجب.'});
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
  if (can(req.user.roles, 'groups.manage') && ['open','nearly_full'].includes(group.status)) {
    unassigned = (await q(`SELECT e.id AS enrollment_id, cu.name, cu.phone, o.id AS order_id
      FROM enrollments e JOIN customers cu ON cu.id=e.customer_id JOIN sales_orders o ON o.id=e.order_id AND o.status='approved'
      WHERE e.course_id=$1 AND e.group_id IS NULL AND e.status='active' ORDER BY cu.name`, [group.course_id])).rows;
  }
  res.render('groups/detail', { title: 'مجموعة ' + group.name, nav: 'groups', group, sessions, students, booked, available: group.capacity - booked, canManage: can(req.user.roles, 'groups.manage'), unassigned });
});

// إلحاق تسجيل غير محدد المجموعة بهذه المجموعة (صلاحية إدارة المجموعات + فحص السعة)
router.post('/:id/enroll', requireCap('groups.manage'), async (req, res) => {
  try{const e=await require('../lib/group-assignment').assignGroup({groupId:req.params.id,enrollmentId:req.body.enrollment_id});
  await audit(req,'enrollment_group_assigned','enrollment',e.id,{group_id:req.params.id,order_id:e.order_id});res.redirect('/groups/'+req.params.id);
  }catch(e){res.status(e.status||500).render('error',{title:'تعذر الإلحاق',message:e.status?e.message:'لم يتم الإلحاق.'});}
});

router.post('/:id/edit', requireCap('groups.manage'), async (req, res) => {
  const { trainer_id, name, start_date, end_date, capacity, days_of_week, time_from, time_to, status } = req.body;
  const validStatus = ['draft','open','nearly_full','full','running','finished','cancelled'];
  if(!Number.isInteger(Number(capacity))||Number(capacity)<1)return res.status(400).render('error',{title:'سعة غير صالحة',message:'السعة عدد صحيح موجب.'});
  try{await tx(async c=>{
    await c.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE',[req.params.id]);
    const n=Number((await c.query("SELECT count(*) AS n FROM enrollments WHERE group_id=$1 AND status='active'",[req.params.id])).rows[0].n);
    if(Number(capacity)<n)throw Object.assign(Error('لا يمكن خفض السعة عن عدد الطلاب المسجلين.'),{status:409});
  await c.query(`UPDATE groups SET trainer_id=$1, name=$2, start_date=$3, end_date=$4, capacity=$5, days_of_week=$6, time_from=$7, time_to=$8, status=$9 WHERE id=$10`,
    [trainer_id || null, name.trim(), start_date || null, end_date || null, Number(capacity), days_of_week || null, time_from || null, time_to || null, validStatus.includes(status) ? status : 'draft', req.params.id]);
  });}catch(e){return res.status(e.status||500).render('error',{title:'تعذر التعديل',message:e.status?e.message:'لم يتم التعديل.'});}
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
