const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { notifyRole } = require('../lib/notify');

const router = express.Router();
router.use(requireAuth, requireCap('sessions.manage'));

// تأجيل محاضرة: يحتفظ بالموعد الأصلي ويسجل السبب والمنفذ
router.post('/:id/postpone', async (req, res) => {
  const { new_date, new_start_time, new_end_time, reason } = req.body;
  if (!new_date || !reason) return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'الموعد الجديد وسبب التأجيل إلزاميان.' });
  const s = (await q('SELECT * FROM sessions WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).render('error', { title: 'غير موجود', message: 'المحاضرة غير موجودة.' });
  await q(`UPDATE sessions SET
      original_date = COALESCE(original_date, session_date),
      original_start_time = COALESCE(original_start_time, start_time),
      session_date=$1, start_time=$2, end_time=$3,
      status='postponed', postpone_reason=$4, postponed_by=$5, postponed_at=now()
    WHERE id=$6`, [new_date, new_start_time || s.start_time, new_end_time || s.end_time, reason, req.user.id, s.id]);
  await audit(req, 'session_postponed', 'session', s.id, { from: s.session_date, to: new_date, reason });
  await notifyRole('reception', 'session_postponed', 'محاضرة مؤجلة', `تم تأجيل محاضرة من ${s.session_date} إلى ${new_date}. السبب: ${reason}`, `/groups/${s.group_id}`);
  res.redirect('/groups/' + s.group_id);
});

router.post('/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!['scheduled','done','cancelled'].includes(status)) return res.status(400).render('error', { title: 'قيمة غير صالحة', message: 'حالة غير صالحة.' });
  const s = (await q('SELECT * FROM sessions WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).render('error', { title: 'غير موجود', message: 'المحاضرة غير موجودة.' });
  await q('UPDATE sessions SET status=$1 WHERE id=$2', [status, s.id]);
  await audit(req, 'session_status', 'session', s.id, { status });
  res.redirect('/groups/' + s.group_id);
});

module.exports = router;
