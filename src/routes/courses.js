const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth, requireCap('courses.view', 'courses.manage'));

router.get('/', async (req, res) => {
  const { rows } = await q(`SELECT c.*,
    (SELECT count(*) FROM groups g WHERE g.course_id=c.id AND g.status IN ('open','nearly_full','running')) AS groups_count
    FROM courses c ORDER BY c.id`);
  res.render('courses/index', { title: 'الكورسات', nav: 'courses', rows, error: null });
});

router.post('/', requireCap('courses.manage'), async (req, res) => {
  const { name, description, base_price, duration_weeks, lectures_count, status } = req.body;
  await q('INSERT INTO courses (name, description, base_price, duration_weeks, lectures_count, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [name.trim(), description || null, parseFloat(base_price) || 0, parseInt(duration_weeks) || null, parseInt(lectures_count) || null, status === 'inactive' ? 'inactive' : 'active']);
  await audit(req, 'course_created', 'course', null, { name, base_price });
  res.redirect('/courses');
});

router.post('/:id/edit', requireCap('courses.manage'), async (req, res) => {
  const { name, description, base_price, duration_weeks, lectures_count, status } = req.body;
  const old = (await q('SELECT * FROM courses WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).render('error', { title: 'غير موجود', message: 'الكورس غير موجود.' });
  await q('UPDATE courses SET name=$1, description=$2, base_price=$3, duration_weeks=$4, lectures_count=$5, status=$6 WHERE id=$7',
    [name.trim(), description || null, parseFloat(base_price) || 0, parseInt(duration_weeks) || null, parseInt(lectures_count) || null, status === 'inactive' ? 'inactive' : 'active', req.params.id]);
  if (String(old.base_price) !== String(parseFloat(base_price))) {
    await audit(req, 'course_price_changed', 'course', req.params.id, { from: old.base_price, to: base_price });
  } else {
    await audit(req, 'course_updated', 'course', req.params.id, { name });
  }
  res.redirect('/courses');
});

module.exports = router;
