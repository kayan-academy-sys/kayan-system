// محول استقبال العملاء من واتساب (نقطة التكامل الموثقة)
//
// الوضع الحالي: webhook عام يستقبل الأرقام من أي مزوّد واتساب (WhatsApp Business API / مزود وسيط).
// عند ربط حساب واتساب الفعلي لاحقًا:
//   1) اضبط WHATSAPP_WEBHOOK_SECRET في متغيرات البيئة.
//   2) وجّه رسائل واتساب الواردة إلى POST /api/webhooks/whatsapp
//      بترويسة x-webhook-secret وبالجسم: { "phone": "010...", "name": "...", "text": "..." }
//   3) يُنشئ النظام عميلًا محتملًا بمصدر whatsapp ويوزعه آليًا حسب قواعد التوزيع.
// الوضع mock للاختبار المحلي فقط.
const { q } = require('../../db');
const { autoAssign } = require('../../lib/distribute');
const { audit } = require('../../lib/audit');

async function ingestWhatsAppLead({ phone, name, text, courseId }, req) {
  if (!phone) throw new Error('phone required');
  const cleanPhone = String(phone).replace(/[^0-9+]/g, '');
  const result = await q('SELECT id FROM customers WHERE phone=$1', [cleanPhone]);
  let customerId;
  if (result.rowCount) customerId = result.rows[0].id;
  else customerId = (await q('INSERT INTO customers (name, phone, notes) VALUES ($1,$2,$3) RETURNING id',
    [name || 'عميل واتساب', cleanPhone, text ? 'رسالة واتساب: ' + String(text).slice(0, 500) : null])).rows[0].id;
  const lead = await q(`INSERT INTO leads (customer_id, course_id, source, status) VALUES ($1,$2,'whatsapp','new') RETURNING id`, [customerId, courseId || null]);
  const assigned = await autoAssign(lead.rows[0].id, null);
  return { customerId, leadId: lead.rows[0].id, autoAssigned: !!assigned };
}

module.exports = { ingestWhatsAppLead };
