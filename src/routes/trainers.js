const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth, requireCap('trainers.manage'));

router.get('/', async (req, res) => {
  const { rows } = await q(`SELECT t.*, (SELECT count(*) FROM groups g WHERE g.trainer_id=t.id AND g.status IN ('open','nearly_full','running')) AS groups_count FROM trainers t ORDER BY t.id`);
  res.render('trainers/index', { title: 'المدربون', nav: 'trainers', rows });
});

router.post('/', async (req, res) => {
  const { name, phone, specialties } = req.body;
  await q('INSERT INTO trainers (name, phone, specialties) VALUES ($1,$2,$3)', [name.trim(), phone || null, specialties || null]);
  await audit(req, 'trainer_created', 'trainer', null, { name });
  res.redirect('/trainers');
});

router.post('/:id/edit', async (req, res) => {
  const { name, phone, specialties, status } = req.body;
  await q('UPDATE trainers SET name=$1, phone=$2, specialties=$3, status=$4 WHERE id=$5',
    [name.trim(), phone || null, specialties || null, status === 'inactive' ? 'inactive' : 'active', req.params.id]);
  await audit(req, 'trainer_updated', 'trainer', req.params.id, { name, status });
  res.redirect('/trainers');
});

module.exports = router;
