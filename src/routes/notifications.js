const express = require('express');
const { q } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { rows } = await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.render('notifications', { title: 'الإشعارات', rows, nav: '' });
});

router.post('/read-all', async (req, res) => {
  await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  res.redirect('/notifications');
});

module.exports = router;
