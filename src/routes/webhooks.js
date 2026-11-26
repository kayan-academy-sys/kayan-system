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


// شيت جوجل: رمز مستقل SHEET_FEED_TOKEN (ترويسة Authorization: Bearer). بدون الرمز تُرفض الطلبات (503).
const crypto = require('crypto');
const { tx } = require('../db');
const { audit } = require('../lib/audit');
const { ingestExtractedNumber } = require('../integrations/whatsapp/adapter');
const LOCAL_MOBILE = /^01[0125]\d{8}$/;
const feedAuth = tokenKey => (req, res, next) => {
  const token = config[tokenKey];
  if (!token) return res.status(503).json({ error: 'feed not configured' });
  const h = req.get('authorization') || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
};
// شيت جوجل "ارقام كيان سيستيم": سكريبت داخل الشيت يرسل صفوفًا جديدة (رقم، اسم، مصدر، كورس).
// رمز مستقل SHEET_FEED_TOKEN. الرد لكل صف: created / duplicate / invalid / replay ليعلّم السكريبت الصف.
const SRC_MAP = [[/whats|واتس/i, 'whatsapp'], [/face|فيس/i, 'facebook'], [/insta|انست|إنست/i, 'instagram'], [/tik|تيك/i, 'tiktok'], [/site|web|موقع/i, 'website'], [/manual|يدو/i, 'manual']];
function normEgPhone(v) {
  let d = String(v == null ? '' : v).replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x660)).replace(/[^0-9+]/g, '');
  if (d.startsWith('+20')) d = '0' + d.slice(3); else if (d.startsWith('0020')) d = '0' + d.slice(4); else if (/^20\d{10}$/.test(d)) d = '0' + d.slice(2); else if (/^1[0125]\d{8}$/.test(d)) d = '0' + d;
  return LOCAL_MOBILE.test(d) ? d : null;
}

// خيارات قائمة الكورس في الشيت: تسويق وجرافيك اختصاران لكورسين موجودين، والباقي بنفس اسم الكورس في النظام.
// لا نُنشئ كورسات هنا، والمطابقة غير المؤكدة تُترك فارغة وتبقى في ملاحظة العميل.
const normAr = t => String(t || '').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();
const SHEET_COURSE_MAP = new Map([['تسويق', 'التسويق الرقمي'], ['جرافيك', 'الجرافيك ديزاين']].map(([k, v]) => [normAr(k), v]));
async function matchSheetCourse(c, text) {
  const n = normAr(text);
  if (!n) return null;
  const all = (await c.query("SELECT id, name FROM courses WHERE status='active'")).rows;
  const target = SHEET_COURSE_MAP.get(n);
  const hit = all.filter(x => normAr(x.name) === normAr(target || text));
  return hit.length === 1 ? hit[0] : null;
}
router.post('/sheet-leads', feedAuth('sheetFeedToken'), async (req, res) => {
  const rows = req.body && req.body.rows;
  const okShape = Array.isArray(rows) && rows.length >= 1 && rows.length <= 50 && rows.every(r => r && typeof r === 'object'
    && typeof r.row_key === 'string' && /^[0-9a-f]{64}$/.test(r.row_key));
  if (!okShape) return res.status(400).json({ ok: false, error: 'bad payload' });
  try {
    const results = await tx(async c => {
      const out = [];
      for (const r of rows) {
        const phone = normEgPhone(r.phone);
        if (!phone) { out.push({ row_key: r.row_key, status: 'invalid' }); continue; }
        const ins = await c.query('INSERT INTO processed_meta_messages(message_id, phone) VALUES($1,$2) ON CONFLICT DO NOTHING', ['sheetfeed:' + r.row_key, phone]);
        if (!ins.rowCount) { out.push({ row_key: r.row_key, status: 'replay' }); continue; }
        const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : '';
        const srcText = typeof r.source === 'string' ? r.source.trim().slice(0, 60) : '';
        const courseText = typeof r.course === 'string' ? r.course.trim().slice(0, 80) : '';
        const source = (SRC_MAP.find(([re]) => re.test(srcText)) || [0, 'other'])[1];
        const course = await matchSheetCourse(c, courseText);
        const note = 'من شيت ارقام كيان سيستيم' + (srcText ? ' | المصدر: ' + srcText : '') + (courseText ? ' | الكورس: ' + courseText : '');
        const ex = await ingestExtractedNumber(phone, note, c, { name: name || undefined });
        if (ex.duplicate) { out.push({ row_key: r.row_key, status: 'duplicate' }); continue; }
        await c.query('UPDATE leads SET source=$1, course_id=$2 WHERE id=$3', [source, course ? course.id : null, ex.leadId]);
        out.push({ row_key: r.row_key, status: 'created' });
      }
      await audit({ ip: req.ip }, 'leads_imported_from_sheet', 'lead', null, { rows: rows.length, created: out.filter(o => o.status === 'created').length }, c);
      return out;
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'failed' });
  }
});

module.exports = router;
