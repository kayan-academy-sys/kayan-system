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
const { tx } = require('../../db');
const { ingestWhatsAppLead, ingestExtractedNumber } = require('./adapter');
const { extractEgyptianMobiles, senderDigits } = require('../../lib/phone-extract');

// WHATSAPP_NUMBER_SOURCES: أرقام مصدر معتمدة مفصولة بفاصلة. عند ضبطها: لا يُعالَج غيرها،
// ولا يصبح المرسل نفسه عميلًا؛ تُستخرج أرقام الموبايل من نص الرسالة فقط.
function listSources() {
  return (process.env.WHATSAPP_NUMBER_SOURCES || '').split(',').map(senderDigits).filter(Boolean);
}

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
  let leadsCreated = 0, duplicates = 0, ignored = 0, numbersFound = 0, numbersSkipped = 0;
  const sources = listSources();
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
        if (process.env.META_PHONE_NUMBER_ID && meta.phone_number_id !== process.env.META_PHONE_NUMBER_ID) {
          ignored++; continue;
        }
        if (!msg.id || !msg.from) { ignored++; continue; }
        // منع التكرار بمعرّف رسالة Meta (إعادة إرسال الwebhook شائعة)
        if (sources.length) {
          if (!sources.includes(senderDigits(msg.from))) { ignored++; continue; }
          if (msg.type !== 'text' || !msg.text?.body) { ignored++; continue; }
          const ex = extractEgyptianMobiles(msg.text.body);
          const out = await tx(async c => {
            const ins = await c.query('INSERT INTO processed_meta_messages(message_id,phone) VALUES($1,$2) ON CONFLICT(message_id) DO NOTHING RETURNING message_id', [msg.id, msg.from]);
            if (!ins.rowCount) return null;
            const created = [];
            let dup = 0;
            for (const n of ex.numbers) {
              const r = await ingestExtractedNumber(n, 'رقم من رسالة مصدر واتساب معتمد', c);
              if (r.duplicate) dup++; else created.push({ leadId: r.leadId, autoAssigned: r.autoAssigned });
            }
            return { created, dup };
          });
          if (!out) { duplicates++; continue; }
          numbersFound += ex.numbers.length; numbersSkipped += ex.skipped;
          duplicates += out.dup; leadsCreated += out.created.length;
          for (const x of out.created) results.push({ messageId: msg.id, ...x });
          continue;
        }
        const name = contacts[msg.from]?.profile?.name || null;
        const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || null;
        const r = await tx(async c=>{
          const inserted=await c.query('INSERT INTO processed_meta_messages(message_id,phone) VALUES($1,$2) ON CONFLICT(message_id) DO NOTHING RETURNING message_id',[msg.id,msg.from]);
          if(!inserted.rowCount)return null;
          return ingestWhatsAppLead({phone:msg.from,name,text},null,c);
        });
        if(!r){duplicates++;continue;}
        leadsCreated++;
        results.push({messageId:msg.id,leadId:r.leadId,autoAssigned:r.autoAssigned});
      }
    }
  }
  return { leadsCreated, duplicates, ignored, numbersFound, numbersSkipped, results };
}

module.exports = { verifyChallenge, validSignature, handlePayload };
