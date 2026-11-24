// مساعد كيان: يجيب موظفي النظام عن أي سؤال متعلق بالنظام من قاعدة البيانات مباشرة.
// نقطة ربط خارجية: إذا ضُبط AI_API_KEY/AI_API_URL يمكن إرسال السياق لنموذج خارجي (موثق في README).
const express = require('express');
const config = require('../config');
const { q } = require('../db');
const { can } = require('../lib/permissions');
const { requireAuth, requireCap } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireCap('ai.use'));
router.use((req,res,next)=>{
  const scope=String(req.user.id)+':'+req.user.roles.slice().sort().join(',');
  if(req.session.aiScope!==scope) req.session.aiHistory=[];
  req.session.aiScope=scope;
  next();
});

async function answer(question, user) {
  const t = question.trim();
  const has = (...words) => words.some(w => t.includes(w));
  const rc = cap => can(user.roles || [user.role], cap);
  const denied = 'هذا السؤال خارج نطاق صلاحياتك في النظام.';
  try {
    if (has('متأخر') && has('قسط', 'أقساط', 'اقساط')) {
      if (!rc('installments.view')) return denied;
      const { rows } = await q(`SELECT cu.name, cu.phone, i.amount, i.due_date FROM installments i
        JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
        JOIN customers cu ON cu.id=o.customer_id
        WHERE i.status='pending' AND i.due_date < current_date
        AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount
        ORDER BY i.due_date LIMIT 15`);
      if (!rows.length) return 'لا توجد أقساط متأخرة حاليًا. 🎉';
      return 'الأقساط المتأخرة (' + rows.length + '):\n' + rows.map(r => `• ${r.name} (${r.phone}): ${Number(r.amount).toLocaleString('ar-EG')} ج.م — استحقاق ${new Date(r.due_date).toLocaleDateString('ar-EG')}`).join('\n');
    }
    if (has('محاضر', 'حصة', 'حصص') && has('اليوم', 'النهاردة', 'النهارده')) {
      if (!(rc('groups.view') || rc('reception.view') || rc('sessions.manage'))) return denied;
      const { rows } = await q(`SELECT s.start_time, g.name AS g, c.name AS c, t.name AS tr FROM sessions s
        JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
        WHERE s.session_date=current_date AND s.status!='cancelled' ORDER BY s.start_time`);
      if (!rows.length) return 'لا توجد محاضرات مجدولة اليوم.';
      return 'محاضرات اليوم:\n' + rows.map(r => `• ${r.g} (${r.c}) — ${r.start_time ? String(r.start_time).slice(0, 5) : ''} — المدرب: ${r.tr || 'غير محدد'}`).join('\n');
    }
    if (has('مجموع', 'مجموعات') && has('متاح', 'مكان', 'أماكن', 'اماكن', 'فاضل')) {
      if (!(rc('groups.view') || rc('groups.manage'))) return denied;
      const { rows } = await q(`SELECT g.name, c.name AS course, g.capacity,
        (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
        FROM groups g JOIN courses c ON c.id=g.course_id WHERE g.status IN ('open','nearly_full') ORDER BY g.start_date`);
      if (!rows.length) return 'لا توجد مجموعات متاحة للحجز الآن.';
      return 'المجموعات المتاحة:\n' + rows.map(r => `• ${r.name} (${r.course}): متاح ${r.capacity - Number(r.booked)} من ${r.capacity}`).join('\n');
    }
    if (has('تحصيل', 'إيراد', 'ايراد', 'دخل') && has('اليوم', 'النهاردة', 'النهارده')) {
      if (!rc('payments.view')) return denied;
      const { rows } = await q(`SELECT COALESCE(sum(amount),0) AS total, count(*) AS n FROM payments WHERE status='active' AND paid_at::date=current_date`);
      return `تحصيل اليوم: ${Number(rows[0].total).toLocaleString('ar-EG')} ج.م عبر ${rows[0].n} عملية.`;
    }
    if (has('عميل', 'عملاء') && has('جديد', 'جدد', 'جديدة')) {
      if (!(rc('leads.view.all') || rc('leads.view.own'))) return denied;
      const all=rc('leads.view.all');
      const { rows } = await q(`SELECT count(*) FILTER (WHERE created_at::date=current_date) AS today, count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS week FROM leads${all ? '' : ' WHERE assigned_to=$1 OR created_by=$1'}`, all ? [] : [user.id]);
      return `العملاء الجدد: اليوم ${rows[0].today} — آخر ٧ أيام ${rows[0].week}.`;
    }
    const phoneMatch = t.match(/01[0-9]{9}/);
    if (phoneMatch) {
      if (!rc('customers.view')) return denied;
      const all=rc('leads.view.all') || rc('orders.view.all') || rc('payments.view') || rc('reception.view');
      const { rows } = await q(`SELECT c.* FROM customers c WHERE c.phone=$1${all ? '' : ' AND (EXISTS(SELECT 1 FROM leads l WHERE l.customer_id=c.id AND (l.assigned_to=$2 OR l.created_by=$2)) OR EXISTS(SELECT 1 FROM sales_orders o WHERE o.customer_id=c.id AND o.sales_user_id=$2))'}`, all ? [phoneMatch[0]] : [phoneMatch[0],user.id]);
      if (!rows.length) return `لا يوجد عميل مسجل بالرقم ${phoneMatch[0]}.`;
      const c = rows[0];
      const leads = (await q(`SELECT l.status, co.name AS course FROM leads l LEFT JOIN courses co ON co.id=l.course_id WHERE l.customer_id=$1${rc('leads.view.all') ? '' : ' AND (l.assigned_to=$2 OR l.created_by=$2)'} ORDER BY l.id DESC`, rc('leads.view.all') ? [c.id] : [c.id,user.id])).rows;
      return `العميل: ${c.name} (${c.phone})\nالفرص:\n` + (leads.map(l => `• ${l.course || 'غير محدد'} — ${l.status}`).join('\n') || 'لا توجد فرص');
    }
    if (has('كيف', 'ازاي', 'إزاي', 'طريقة')) {
      if (has('حجز')) return 'لإنشاء حجز: من صفحة العميل المحتمل اضغط «إنشاء حجز»، اختر الكورس أو الباقة والمجموعة، حدد نقدي أو تقسيط، ثم «اعتماد الحجز». السعر يُعتمد تلقائيًا ولا يمكن تعديله من المبيعات.';
      if (has('قسط') || has('تقسيط')) return 'الأقساط تُدار من قسم الحسابات > الأقساط: يمكن تحصيل قسط أو تأجيله (بصلاحية مدير الحسابات مع تسجيل السبب).';
      if (has('توزيع')) return 'توزيع العملاء: من «توزيع العملاء» حدّد الحاضرين ثم اضغط «توزيع الآن». العملاء الجدد يُسندون تلقائيًا للحاضرين، وبعد انقضاء مدة الإسناد دون حجز يعاد توزيعهم آليًا.';
      return 'أستطيع مساعدتك في: الأقساط المتأخرة، محاضرات اليوم، المجموعات المتاحة، تحصيل اليوم، العملاء الجدد، بيانات عميل برقمه، وخطوات العمل على النظام (حجز، تقسيط، توزيع...).';
    }
    return 'لم أفهم السؤال بعد. جرّب: «الأقساط المتأخرة»، «محاضرات اليوم»، «المجموعات المتاحة»، «تحصيل اليوم»، أو أرسل رقم هاتف عميل.';
  } catch (e) {
    return 'حدث خطأ أثناء جلب البيانات. حاول مرة أخرى أو راجع مدير النظام.';
  }
}

router.get('/', (req, res) => {
  res.render('assistant', { title: 'مساعد كيان', nav: 'assistant', history: req.session.aiHistory || [], aiExternal: !!config.aiApiKey });
});

router.post('/', async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) return res.redirect('/assistant');
  const reply = await answer(question, req.user);
  req.session.aiHistory = (req.session.aiHistory || []).concat([{ q: question, a: reply }]).slice(-20);
  res.redirect('/assistant');
});

module.exports = router;
