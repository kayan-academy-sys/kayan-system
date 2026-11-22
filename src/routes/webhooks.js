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

// جسر Meta WhatsApp Cloud API الرسمي
const meta = require('../integrations/whatsapp/meta');

router.get('/meta', (req, res) => {
  const r = meta.verifyChallenge(req.query, config);
  if (!r.ok) return res.status(403).json({ error: 'forbidden' });
  res.type('text/plain').send(r.challenge);
});

router.post('/meta', async (req, res) => {
  if (!config.metaAppSecret) return res.status(503).json({ error: 'meta not configured' });
  if (!meta.validSignature(req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256') || '', config.metaAppSecret)) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  try {
    const result = await meta.handlePayload(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
