const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth, requireCap('packages.view', 'packages.manage'));

router.get('/', async (req, res) => {
  const { rows } = await q(`SELECT p.*,
    (SELECT json_agg(c.name) FROM package_courses pc JOIN courses c ON c.id=pc.course_id WHERE pc.package_id=p.id) AS course_names
    FROM packages p ORDER BY p.id DESC`);
  const courses = (await q(`SELECT * FROM courses WHERE status='active' ORDER BY name`)).rows;
  res.render('packages/index', { title: 'الباقات والدبلومات', nav: 'packages', rows, courses });
});

router.post('/', requireCap('packages.manage'), async (req, res) => {
  const { name, description, price, validity, terms } = req.body;
  const courseIds = [].concat(req.body.course_ids || []).map(Number).filter(Boolean);
  if (!name || !price || !courseIds.length) {
    return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'اسم الباقة وسعرها وكورس واحد على الأقل مطلوبة.' });
  }
  await tx(async (c) => {
    const ins = await c.query('INSERT INTO packages (name, description, price, validity, terms, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name.trim(), description || null, parseFloat(price), validity || null, terms || null, req.user.id]);
    for (const cid of courseIds) await c.query('INSERT INTO package_courses (package_id, course_id) VALUES ($1,$2)', [ins.rows[0].id, cid]);
  });
  await audit(req, 'package_created', 'package', null, { name, price, courseIds });
  res.redirect('/packages');
});

router.post('/:id/edit', requireCap('packages.manage'), async (req, res) => {
  const { name, description, price, validity, terms, status } = req.body;
  const courseIds = [].concat(req.body.course_ids || []).map(Number).filter(Boolean);
  const old = (await q('SELECT * FROM packages WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).render('error', { title: 'غير موجود', message: 'الباقة غير موجودة.' });
  await tx(async (c) => {
    await c.query('UPDATE packages SET name=$1, description=$2, price=$3, validity=$4, terms=$5, status=$6 WHERE id=$7',
      [name.trim(), description || null, parseFloat(price), validity || null, terms || null, status === 'inactive' ? 'inactive' : 'active', req.params.id]);
    if (courseIds.length) {
      await c.query('DELETE FROM package_courses WHERE package_id=$1', [req.params.id]);
      for (const cid of courseIds) await c.query('INSERT INTO package_courses (package_id, course_id) VALUES ($1,$2)', [req.params.id, cid]);
    }
  });
  if (String(old.price) !== String(parseFloat(price))) {
    await audit(req, 'package_price_changed', 'package', req.params.id, { from: old.price, to: price });
  } else {
    await audit(req, 'package_updated', 'package', req.params.id, { name });
  }
  res.redirect('/packages');
});

module.exports = router;
