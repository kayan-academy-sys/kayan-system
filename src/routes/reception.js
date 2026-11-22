const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth, requireCap('reception.view'));

router.get('/', async (req, res) => {
  const todaySessions = (await q(`
    SELECT s.*, g.name AS group_name, g.capacity, c.name AS course_name, t.name AS trainer_name,
      (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS students,
      (SELECT count(*) FROM attendance a WHERE a.session_id=s.id) AS marked
    FROM sessions s JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
    WHERE s.session_date=current_date AND s.status != 'cancelled' ORDER BY s.start_time`)).rows;
  const upcoming = (await q(`
    SELECT s.session_date, s.start_time, g.name AS group_name, c.name AS course_name
    FROM sessions s JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id
    WHERE s.session_date > current_date AND s.session_date <= current_date + 3 AND s.status IN ('scheduled','postponed')
    ORDER BY s.session_date, s.start_time LIMIT 10`)).rows;
  const startingGroups = (await q(`
    SELECT name, start_date FROM groups WHERE status IN ('open','nearly_full') AND start_date BETWEEN current_date AND current_date + 7 ORDER BY start_date`)).rows;
  const absentLast = (await q(`
    SELECT a.id, cu.name AS student_name, cu.phone, g.name AS group_name, s.session_date
    FROM attendance a
    JOIN enrollments e ON e.id=a.enrollment_id
    JOIN customers cu ON cu.id=e.customer_id
    JOIN sessions s ON s.id=a.session_id
    JOIN groups g ON g.id=s.group_id
    WHERE a.status='absent' AND s.session_date >= current_date - 7
    ORDER BY s.session_date DESC LIMIT 10`)).rows;
  const dueAmounts = (await q(`
    SELECT cu.name AS customer_name, cu.phone, i.due_date, i.amount
    FROM installments i JOIN installment_plans p ON p.id=i.plan_id
    JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
    JOIN customers cu ON cu.id=o.customer_id
    WHERE i.status='pending' AND i.due_date <= current_date
    AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount
    ORDER BY i.due_date LIMIT 10`)).rows;
  res.render('reception/index', { title: 'لوحة الاستقبال', nav: 'reception', todaySessions, upcoming, startingGroups, absentLast, dueAmounts });
});

// بحث الطالب بالاسم أو الهاتف
router.get('/students', async (req, res) => {
  const search = (req.query.q || '').trim();
  let rows = [];
  if (search) {
    rows = (await q(`SELECT DISTINCT cu.id, cu.name, cu.phone FROM customers cu
      JOIN enrollments e ON e.customer_id=cu.id
      WHERE cu.name ILIKE $1 OR cu.phone ILIKE $1 ORDER BY cu.name LIMIT 50`, ['%' + search + '%'])).rows;
  }
  res.render('reception/students', { title: 'بحث الطلاب', nav: 'reception', rows, q: search });
});

router.get('/students/:id', async (req, res) => {
  const student = (await q('SELECT * FROM customers WHERE id=$1', [req.params.id])).rows[0];
  if (!student) return res.status(404).render('error', { title: 'غير موجود', message: 'الطالب غير موجود.' });
  const enrollments = (await q(`SELECT e.*, c.name AS course_name, g.name AS group_name, g.days_of_week, g.time_from, g.time_to, t.name AS trainer_name,
    (SELECT count(*) FROM attendance a JOIN sessions s ON s.id=a.session_id WHERE a.enrollment_id=e.id AND a.status='present') AS attended,
    (SELECT count(*) FROM attendance a JOIN sessions s ON s.id=a.session_id WHERE a.enrollment_id=e.id AND a.status='absent') AS absent
    FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN groups g ON g.id=e.group_id LEFT JOIN trainers t ON t.id=g.trainer_id
    WHERE e.customer_id=$1 ORDER BY e.id DESC`, [student.id])).rows;
  // الحالة المالية في حدود الحاجة التشغيلية
  const finances = (await q(`SELECT o.id, o.total_price, o.status, o.kind,
    COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.order_id=o.id AND p.status='active'),0) AS paid
    FROM sales_orders o WHERE o.customer_id=$1 AND o.status='approved'`, [student.id])).rows;
  res.render('reception/student', { title: 'ملف الطالب', nav: 'reception', student, enrollments, finances });
});

// صفحة تسجيل حضور محاضرة
router.get('/sessions/:id/attendance', requireCap('attendance.record', 'attendance.view'), async (req, res) => {
  const s = (await q(`SELECT s.*, g.name AS group_name, c.name AS course_name FROM sessions s JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id WHERE s.id=$1`, [req.params.id])).rows[0];
  if (!s) return res.status(404).render('error', { title: 'غير موجودة', message: 'المحاضرة غير موجودة.' });
  const students = (await q(`SELECT e.id AS enrollment_id, cu.name, cu.phone,
    (SELECT json_build_object('status',a.status,'notes',a.notes,'checked_at',a.checked_at) FROM attendance a WHERE a.session_id=$1 AND a.enrollment_id=e.id) AS att
    FROM enrollments e JOIN customers cu ON cu.id=e.customer_id
    WHERE e.group_id=$2 AND e.status='active' ORDER BY cu.name`, [s.id, s.group_id])).rows;
  res.render('reception/attendance', { title: 'حضور: ' + s.group_name, nav: 'reception', s, students, canRecord: can(req.user.roles, 'attendance.record') });
});

router.post('/sessions/:id/attendance', requireCap('attendance.record'), async (req, res) => {
  const s = (await q('SELECT * FROM sessions WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).render('error', { title: 'غير موجودة', message: 'المحاضرة غير موجودة.' });
  const valid = ['present','absent','late','excused'];
  const entries = Object.entries(req.body).filter(([k]) => k.startsWith('att_'));
  for (const [k, status] of entries) {
    if (!valid.includes(status)) continue;
    const enrollmentId = parseInt(k.slice(4), 10);
    const notes = req.body['notes_' + enrollmentId] || null;
    await q(`INSERT INTO attendance (session_id, enrollment_id, status, checked_by, notes) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (session_id, enrollment_id) DO UPDATE SET status=$3, checked_by=$4, checked_at=now(), notes=$5`,
      [s.id, enrollmentId, status, req.user.id, notes]);
  }
  await audit(req, 'attendance_recorded', 'session', s.id, { count: entries.length });
  res.redirect('/reception/sessions/' + s.id + '/attendance');
});

module.exports = router;
