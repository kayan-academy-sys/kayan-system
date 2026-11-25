// محول استقبال العملاء من واتساب (نقطة التكامل الموثقة)
//
// الوضع الحالي: webhook عام يستقبل الأرقام من أي مزوّد واتساب (WhatsApp Business API / مزود وسيط).
// عند ربط حساب واتساب الفعلي لاحقًا:
//   1) اضبط WHATSAPP_WEBHOOK_SECRET في متغيرات البيئة.
//   2) وجّه رسائل واتساب الواردة إلى POST /api/webhooks/whatsapp
//      بترويسة x-webhook-secret وبالجسم: { "phone": "010...", "name": "...", "text": "..." }
//   3) يُنشئ النظام عميلًا محتملًا بمصدر whatsapp ويوزعه آليًا حسب قواعد التوزيع.
// الوضع mock للاختبار المحلي فقط.
const { tx } = require('../../db');
const { autoAssign } = require('../../lib/distribute');
const { audit } = require('../../lib/audit');

async function ingestWhatsAppLead({ phone, name, text, courseId }, req, client) {
  if (!phone) throw new Error('phone required');
  const cleanPhone = String(phone).replace(/[^0-9+]/g, '');
  if (!/^\+?\d{7,15}$/.test(cleanPhone)) throw new Error('invalid phone');
  const ingest=async c=>{
    const customerId=(await c.query(`INSERT INTO customers(name,phone,notes) VALUES($1,$2,$3)
      ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id`,[name||'عميل واتساب',cleanPhone,text?'رسالة واتساب: '+String(text).slice(0,500):null])).rows[0].id;
    const leadId=(await c.query("INSERT INTO leads(customer_id,course_id,source,status) VALUES($1,$2,'whatsapp','new') RETURNING id",[customerId,courseId||null])).rows[0].id;
    // Serialize load balancing across concurrent webhook deliveries.
    await c.query("SELECT pg_advisory_xact_lock(170133,1)");
    const setting=(await c.query("SELECT value FROM settings WHERE key='lead_distribution_enabled'")).rows[0];
    let target=null;
    if(!setting || !['false','0'].includes(String(setting.value))){
      target=(await c.query(`SELECT u.id FROM users u WHERE u.active=true
        AND (u.role IN ('sales_staff','sales_team_leader') OR u.extra_roles && ARRAY['sales_staff','sales_team_leader']::text[])
        AND EXISTS(SELECT 1 FROM staff_presence sp WHERE sp.user_id=u.id AND sp.work_date=current_date AND sp.present=true)
        ORDER BY (SELECT count(*) FROM leads l WHERE l.assigned_to=u.id AND l.status IN ('new','no_answer','interested','need_follow_up')),u.id LIMIT 1`)).rows[0];
      if(target){
        await c.query('UPDATE leads SET assigned_to=$1,assigned_at=now() WHERE id=$2',[target.id,leadId]);
        await c.query("INSERT INTO lead_assignments(lead_id,to_user_id,reason) VALUES($1,$2,'إسناد تلقائي عند الإنشاء')",[leadId,target.id]);
        await c.query("INSERT INTO notifications(user_id,type,title,body,link) VALUES($1,'lead_assigned','عميل جديد أُسند إليك','تم إسناد عميل جديد إليك تلقائيًا.',$2)",[target.id,'/leads/'+leadId]);
      }
    }
    return {customerId,leadId,autoAssigned:!!target};
  };
  return client?ingest(client):tx(ingest);
}
module.exports = { ingestWhatsAppLead };
