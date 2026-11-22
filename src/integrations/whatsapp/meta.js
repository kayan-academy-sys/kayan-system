// جسر Meta WhatsApp Cloud API — التحقق، توقيع، تحويل الرسائل الواردة إلى عملاء محتملين
//
// الربط عند امتلاك الرقم الرسمي:
//   1) META_VERIFY_TOKEN: قيمة عشوائية تضبطها هنا وفي لوحة Meta عند إعداد الwebhook.
//   2) META_APP_SECRET: من لوحة تطبيق Meta (App > Settings > Basic) للتحقق من التوقيع.
//   3) META_PHONE_NUMBER_ID (اختياري): لقبول الرسائل الموجهة لرقمنا فقط عند اشتراك أكثر من رقم.
//   4) في لوحة Meta: Webhook URL = https://<النطاق>/api/webhooks/meta ، وفعّل حقل messages.
//
// ضمانات: التوقيع HMAC-SHA256 إلزامي، إعادة الإرسال (نفس message id) لا تكرر العميل،
// رسائل statuses (تقارير التسليم) والمحادثات غير المرتبطة برقمنا لا تنشئ عملاء أبدًا.
const crypto = require('crypto');
const { q } = require('../../db');
const { ingestWhatsAppLead } = require('./adapter');

// GET: تحدي Meta (hub.mode=subscribe)
function verifyChallenge(query, config) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === config.metaVerifyToken && config.metaVerifyToken) {
    return { ok: true, challenge: query['hub.challenge'] };
  }
  return { ok: false };
}

// التحقق من توقيع x-hub-signature-256 بالمقارنة الآمنة زمنيًا
function validSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST: معالجة الحمولة — يرجع { leadsCreated, duplicates, ignored }
async function handlePayload(body) {
  let leadsCreated = 0, duplicates = 0, ignored = 0;
  const results = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // تقارير التسليم/القراءة: تُتجاهل دائمًا
      if (Array.isArray(value.statuses) && value.statuses.length) ignored += value.statuses.length;
      if (!Array.isArray(value.messages)) continue;
      // ربط الاسم من جهات الاتصال المرافقة
      const contacts = Object.fromEntries((value.contacts || []).map(c => [c.wa_id, c]));
      for (const msg of value.messages) {
        // رقم هاتف مختلف (اشتراك متعدد الأرقام): تجاهل المحادثات غير المرتبطة
        const meta = value.metadata || {};
        if (process.env.META_PHONE_NUMBER_ID && meta.phone_number_id && meta.phone_number_id !== process.env.META_PHONE_NUMBER_ID) {
          ignored++; continue;
        }
        if (!msg.id || !msg.from) { ignored++; continue; }
        // منع التكرار بمعرّف رسالة Meta (إعادة إرسال الwebhook شائعة)
        const dup = await q('SELECT 1 FROM processed_meta_messages WHERE message_id=$1', [msg.id]);
        if (dup.rowCount) { duplicates++; continue; }
        await q('INSERT INTO processed_meta_messages (message_id, phone) VALUES ($1,$2)', [msg.id, msg.from]);
        const name = contacts[msg.from]?.profile?.name || null;
        const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || null;
        const r = await ingestWhatsAppLead({ phone: msg.from, name, text }, null);
        leadsCreated++;
        results.push({ messageId: msg.id, leadId: r.leadId, autoAssigned: r.autoAssigned });
      }
    }
  }
  return { leadsCreated, duplicates, ignored, results };
}

module.exports = { verifyChallenge, validSignature, handlePayload };
