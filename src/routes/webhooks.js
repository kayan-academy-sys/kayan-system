const express = require('express');
const config = require('../config');
const { ingestWhatsAppLead } = require('../integrations/whatsapp/adapter');

const router = express.Router();

// استقبال أرقام العملاء من واتساب وتوزيعها آليًا على المبيعات بالتساوي
router.post('/whatsapp', async (req, res) => {
  const secret = req.get('x-webhook-secret');
  if (!config.whatsappWebhookSecret || secret !== config.whatsappWebhookSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await ingestWhatsAppLead(req.body || {}, req);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
