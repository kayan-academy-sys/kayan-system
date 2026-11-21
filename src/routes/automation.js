const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { runAll, JOBS } = require('../lib/automation');
const { audit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth, requireCap('settings.manage'));

router.get('/', async (req, res) => {
  const { rows } = await q('SELECT * FROM job_runs ORDER BY id DESC LIMIT 100');
  res.render('automation', { title: 'الأتمتة والمهام المجدولة', rows, nav: 'automation', ran: req.query.ran === '1' });
});

router.post('/run', async (req, res) => {
  const results = await runAll();
  await audit(req, 'automation_run', 'job_runs', null, { results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? 'success' : 'error'])) });
  res.redirect('/automation?ran=1');
});

module.exports = router;
