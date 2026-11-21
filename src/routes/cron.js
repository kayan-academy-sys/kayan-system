// نقطة تشغيل خارجية للمهام المجدولة (للاستضافة بدون عملية دائمة)
const express = require('express');
const config = require('../config');
const { runAll } = require('../lib/automation');

const router = express.Router();

router.post('/run', async (req, res) => {
  const secret = req.get('x-cron-secret') || req.body.secret;
  if (!config.cronSecret || secret !== config.cronSecret) return res.status(401).json({ error: 'unauthorized' });
  const results = await runAll();
  res.json({ ok: true, results });
});

module.exports = router;
