// مساعد كيان: مساعد بحث داخلي يجيب موظفي النظام عن أسئلة تشغيلية محددة من قاعدة البيانات مباشرة.
// المطابقة المحلية بالكلمات المفتاحية هي الأساس، وأسئلة الموظفين العادية لا تغادر الخادم أبدًا.
// التصنيف الخارجي عبر Cohere مقيد بوضع اختبار معزول من جهة الخادم: يتطلب COHERE_API_KEY
// وAI_EXTERNAL_TEST=synthetic-fixtures معًا، ويعمل فقط بطلب «تجربة: <id>» حيث id رقم سؤال وهمي
// ثابت محفوظ على الخادم. النص المُرسل للمزوّد هو ذلك النص الثابت فقط (لا يُرسل إدخال المستخدم،
// ولا بيانات من قاعدة البيانات، ولا سجلّ المحادثة). أي عطل أو غياب الإعداد: المطابقة المحلية وحدها.
// الإجابات مقيدة بصلاحيات الدور: لا يرى الموظف إلا ما تسمح به صلاحياته.
const express = require('express');
const config = require('../config');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { can } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth, requireCap('ai.use'));

// تطبيع عربي بسيط حتى تُفهم الصيغ المختلفة لنفس السؤال (أ/إ/آ، ة/ه، ى/ي، تشكيل).
function norm(s) {
  return String(s || '')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

const CAPABILITIES = 'أقدر أجاوبك عن: الأقساط المتأخرة، الأقساط المستحقة اليوم، محاضرات اليوم، حضور اليوم، المجموعات المتاحة، تحصيل اليوم أو الأسبوع، العملاء الجدد، بيانات عميل برقم هاتفه، ملخص اليوم، وخطوات تنفيذ إجراء (حجز، تقسيط، توزيع، حضور...) — كلٌّ حسب صلاحياتك.';
const NO_CAP = 'هذا السؤال خارج نطاق صلاحياتك في النظام. لو محتاجه فعلًا، اسأل مدير القسم المختص.';

// --- التصنيف الذكي عبر Cohere: وضع اختبار معزول بقائمة أسئلة وهمية ثابتة فقط ---
// لا يُرسل أي نص يكتبه المستخدم إلى المزوّد أبدًا. النص الصادر هو سؤال وهمي ثابت محفوظ في الخادم
// (test/assistant-eval-questions.json)، يُختار برقم تعريفه فقط: «تجربة: <id>».
// يتطلب COHERE_API_KEY وAI_EXTERNAL_TEST=synthetic-fixtures معًا، وإلا لا يحدث أي اتصال خارجي.
const LLM_KEY = process.env.COHERE_API_KEY || '';
const LLM_MODEL = process.env.COHERE_MODEL || 'command-a-03-2025';
const LLM_TIMEOUT_MS = 8000;
const LLM_TEST_MODE = process.env.AI_EXTERNAL_TEST === 'synthetic-fixtures';
let EVAL_FIXTURES = {};
try {
  const fxPath = require('path').join(__dirname, '..', '..', 'test', 'assistant-eval-questions.json');
  for (const f of (JSON.parse(require('fs').readFileSync(fxPath, 'utf8')).questions || [])) EVAL_FIXTURES[`q${f.id}`] = f.q;
} catch (e) { EVAL_FIXTURES = {}; }

const INTENT_LIST = [
  ['greeting', 'تحية أو سلام فقط'],
  ['daily_summary', 'ملخص أو أخبار اليوم'],
  ['late_installments', 'الأقساط المتأخرة / مين لم يدفع'],
  ['due_today', 'الأقساط المستحقة اليوم'],
  ['sessions_today', 'محاضرات أو حصص اليوم'],
  ['sessions_other_day', 'محاضرات يوم آخر غير اليوم'],
  ['attendance_today', 'حضور أو غياب اليوم'],
  ['available_groups', 'المجموعات أو الأماكن المتاحة للحجز'],
  ['collections_today', 'تحصيل أو إيراد اليوم'],
  ['collections_week', 'تحصيل أو إيراد الأسبوع'],
  ['new_leads', 'العملاء الجدد'],
  ['customer_by_phone', 'بيانات عميل محدد'],
  ['howto_booking', 'خطوات إنشاء حجز'],
  ['howto_installments', 'خطوات إدارة الأقساط أو التقسيط'],
  ['howto_other', 'خطوات إجراء آخر داخل النظام (توزيع العملاء، تسجيل الحضور)'],
  ['out_of_scope', 'سؤال خارج نطاق مساعد التشغيل الداخلي'],
  ['refusal_bulk_pii', 'طلب بيانات شخصية جماعية مثل أرقام هواتف كل العملاء'],
];
const INTENTS = INTENT_LIST.map(([k]) => k);

async function classifyWithLLM(question) {
  if (!LLM_KEY) return null;
  // حجب أرقام الهواتف وأي أرقام طويلة قبل الإرسال: لا يغادر أي معرّف شخصي.
  const redacted = String(question).replace(/01\d{9}/g, '[رقم هاتف]').replace(/\d{5,}/g, '[رقم]');
  const sys = 'أنت مصنّف أسئلة لمساعد داخلي في نظام إدارة أكاديمية تدريب. صنّف سؤال الموظف إلى فئة واحدة من القائمة:\n' +
    INTENT_LIST.map(([k, d]) => `- ${k} — ${d}`).join('\n') +
    '\nأجب بـ JSON فقط بدون أي نص آخر: {"intent":"<الفئة>"}';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: redacted }] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data.message?.content || []).map(c => c.text || '').join('');
    const m = raw.match(/"intent"\s*:\s*"([a-z_]+)"/);
    const intent = m ? m[1] : null;
    return INTENTS.includes(intent) ? intent : null;
  } catch (e) {
    return null; // أي عطل: نكمل بالمطابقة المحلية
  }
}

async function answer(question, user) {
  const t = norm(question);
  const has = (...words) => words.some(w => t.includes(norm(w)));
  const rc = (cap) => can(user.roles || [user.role], cap);
  const today = has('اليوم', 'النهارده');
  const finList = rc('installments.view') ? 'full' : rc('installments.view.limited') ? 'limited' : null;
  // نطاق الرؤية: من يملك عرض الكل يرى كل شيء، وغيره يرى ما أُسند إليه أو أنشأه فقط
  const leadScope = rc('leads.view.all') ? { cond: '', params: [] } : { cond: ' AND (l.assigned_to=$1 OR l.created_by=$1)', params: [user.id] };
  const orderScope = rc('orders.view.all') ? { cond: '', params: [] } : { cond: ' AND o.sales_user_id=$1', params: [user.id] };
  const phoneMatch = question.match(/01[0-9]{9}/);
  try {
    const handlers = {
      greeting: async () => `أهلًا ${user.name}! 👋\n${CAPABILITIES}`,
      daily_summary: async () => {
        const parts = [];
        if (rc('leads.view.own') || rc('leads.view.all') || rc('leads.view')) {
          const { rows } = await q(`SELECT count(*) AS n FROM leads l WHERE l.created_at::date=current_date${leadScope.cond}`, leadScope.params);
          parts.push(`• عملاء جدد اليوم${rc('leads.view.all') ? '' : ' (ضمن نطاقك)'}: ${rows[0].n}`);
        }
        if (rc('groups.view') || rc('reception.view') || rc('sessions.manage')) {
          const { rows } = await q(`SELECT count(*) AS n FROM sessions WHERE session_date=current_date AND status!='cancelled'`);
          parts.push(`• محاضرات اليوم: ${rows[0].n}`);
        }
        if (rc('payments.view')) {
          const { rows } = await q(`SELECT COALESCE(sum(amount),0) AS total FROM payments WHERE status='active' AND paid_at::date=current_date`);
          parts.push(`• تحصيل اليوم: ${Number(rows[0].total).toLocaleString('ar-EG')} ج.م`);
        }
        if (finList) {
          const { rows } = await q(`SELECT count(*) AS n FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
             WHERE i.status='pending' AND i.due_date <= current_date
             AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount`);
          parts.push(`• أقساط مستحقة ومتأخرة: ${rows[0].n}`);
        }
        if (!parts.length) return 'ملخص اليوم غير متاح لصلاحياتك الحالية.';
        return 'ملخص اليوم:\n' + parts.join('\n');
      },
      late_installments: async () => {
        if (!finList) return NO_CAP;
        if (finList === 'limited') {
          const { rows } = await q(`SELECT count(*) AS n FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
            WHERE i.status='pending' AND i.due_date < current_date
            AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount`);
          return `عدد الأقساط المتأخرة: ${rows[0].n}. الأسماء والمبالغ التفصيلية متاحة لقسم الحسابات.`;
        }
        const { rows } = await q(`SELECT cu.name, cu.phone, i.amount, i.due_date FROM installments i
          JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
          JOIN customers cu ON cu.id=o.customer_id
          WHERE i.status='pending' AND i.due_date < current_date
          AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount
          ORDER BY i.due_date LIMIT 15`);
        if (!rows.length) return 'لا توجد أقساط متأخرة حاليًا. 🎉';
        return 'الأقساط المتأخرة (' + rows.length + '):\n' + rows.map(r => `• ${r.name} (${r.phone}): ${Number(r.amount).toLocaleString('ar-EG')} ج.م — استحقاق ${new Date(r.due_date).toLocaleDateString('ar-EG')}`).join('\n');
      },
      due_today: async () => {
        if (!finList) return NO_CAP;
        const clarify = 'ملحوظة: النظام يعرض الأقساط المستحقة في تاريخ اليوم فقط؛ لا يمكن معرفة نية العميل في السداد من البيانات.';
        if (finList === 'limited') {
          const { rows } = await q(`SELECT count(*) AS n FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
            WHERE i.status='pending' AND i.due_date = current_date
            AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount`);
          return `عدد الأقساط المستحقة اليوم: ${rows[0].n}. الأسماء والمبالغ التفصيلية متاحة لقسم الحسابات.\n${clarify}`;
        }
        const { rows } = await q(`SELECT cu.name, cu.phone,
          (i.amount - (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active')) AS remaining
          FROM installments i
          JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
          JOIN customers cu ON cu.id=o.customer_id
          WHERE i.status='pending' AND i.due_date = current_date
          AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount
          ORDER BY i.due_date LIMIT 15`);
        if (!rows.length) return 'لا توجد أقساط مستحقة اليوم.\n' + clarify;
        return 'الأقساط المستحقة اليوم (' + rows.length + '):\n' + rows.map(r => `• ${r.name} (${r.phone}): ${Number(r.remaining).toLocaleString('ar-EG')} ج.م`).join('\n') + '\n' + clarify;
      },
      sessions_today: async () => {
        if (!(rc('groups.view') || rc('reception.view') || rc('sessions.manage'))) return NO_CAP;
        const { rows } = await q(`SELECT s.start_time, g.name AS g, c.name AS c, t.name AS tr FROM sessions s
          JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
          WHERE s.session_date=current_date AND s.status!='cancelled' ORDER BY s.start_time`);
        if (!rows.length) return 'لا توجد محاضرات مجدولة اليوم.';
        return 'محاضرات اليوم:\n' + rows.map(r => `• ${r.g} (${r.c}) — ${r.start_time ? String(r.start_time).slice(0, 5) : ''} — المدرب: ${r.tr || 'غير محدد'}`).join('\n');
      },
      sessions_other_day: async () => 'المساعد يعرض محاضرات اليوم فقط. لمحاضرات يوم آخر راجع جدول المحاضرات من صفحة المجموعات.',
      attendance_today: async () => {
        if (!rc('attendance.view')) return NO_CAP;
        const { rows } = await q(`SELECT g.name AS g, a.status, count(*) AS n FROM attendance a
          JOIN sessions s ON s.id=a.session_id JOIN groups g ON g.id=s.group_id
          WHERE s.session_date=current_date GROUP BY g.name, a.status ORDER BY g.name, a.status`);
        if (!rows.length) return 'لم يُسجَّل حضور لأي محاضرة اليوم بعد.';
        const L = { present: 'حاضر', absent: 'غائب', late: 'متأخر', excused: 'بعذر' };
        return 'حضور اليوم:\n' + rows.map(r => `• ${r.g}: ${L[r.status] || r.status} ${r.n}`).join('\n');
      },
      available_groups: async () => {
        if (!rc('groups.view')) return NO_CAP;
        const { rows } = await q(`SELECT g.name, c.name AS course, g.capacity,
          (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
          FROM groups g JOIN courses c ON c.id=g.course_id WHERE g.status IN ('open','nearly_full') ORDER BY g.start_date`);
        if (!rows.length) return 'لا توجد مجموعات متاحة للحجز الآن.';
        return 'المجموعات المتاحة:\n' + rows.map(r => `• ${r.name} (${r.course}): متاح ${r.capacity - Number(r.booked)} من ${r.capacity}`).join('\n');
      },
      collections_today: async () => {
        if (!rc('payments.view')) return NO_CAP;
        const { rows } = await q(`SELECT COALESCE(sum(amount),0) AS total, count(*) AS n FROM payments WHERE status='active' AND paid_at::date=current_date`);
        return `تحصيل اليوم: ${Number(rows[0].total).toLocaleString('ar-EG')} ج.م عبر ${rows[0].n} عملية.`;
      },
      collections_week: async () => {
        if (!rc('payments.view')) return NO_CAP;
        const { rows } = await q(`SELECT COALESCE(sum(amount),0) AS total, count(*) AS n FROM payments WHERE status='active' AND paid_at >= now() - interval '7 days'`);
        return `تحصيل آخر ٧ أيام: ${Number(rows[0].total).toLocaleString('ar-EG')} ج.م عبر ${rows[0].n} عملية.`;
      },
      new_leads: async () => {
        if (!(rc('leads.view.own') || rc('leads.view.all') || rc('leads.view'))) return NO_CAP;
        const { rows } = await q(`SELECT count(*) FILTER (WHERE l.created_at::date=current_date) AS today, count(*) FILTER (WHERE l.created_at >= now() - interval '7 days') AS week FROM leads l WHERE TRUE${leadScope.cond}`, leadScope.params);
        return `العملاء الجدد${rc('leads.view.all') ? '' : ' (ضمن نطاقك)'}: اليوم ${rows[0].today} — آخر ٧ أيام ${rows[0].week}.`;
      },
      customer_by_phone: async () => {
        if (!rc('customers.view')) return NO_CAP;
        if (!phoneMatch) return 'ابعت رقم هاتف العميل (يبدأ بـ 01) وسأعرض بياناته ضمن صلاحياتك.';
        const { rows } = await q('SELECT * FROM customers WHERE phone=$1', [phoneMatch[0]]);
        if (!rows.length) return `لا يوجد عميل مسجل بالرقم ${phoneMatch[0]}.`;
        const c = rows[0];
        const seeAllLeads = rc('leads.view.all'), seeAllOrders = rc('orders.view.all');
        const leads = (await q(`SELECT l.status, co.name AS course FROM leads l LEFT JOIN courses co ON co.id=l.course_id WHERE l.customer_id=$1${seeAllLeads ? '' : ' AND (l.assigned_to=$2 OR l.created_by=$2)'} ORDER BY l.id DESC`, seeAllLeads ? [c.id] : [c.id, user.id])).rows;
        const orders = (await q(`SELECT o.id, o.total_price AS total, o.status FROM sales_orders o WHERE o.customer_id=$1${seeAllOrders ? '' : ' AND o.sales_user_id=$2'} ORDER BY o.id DESC`, seeAllOrders ? [c.id] : [c.id, user.id])).rows;
        const scoped = !(seeAllLeads && seeAllOrders);
        return `العميل: ${c.name} (${c.phone})${scoped ? '\n(تُعرض بياناته ضمن نطاق صلاحياتك فقط)' : ''}\nالفرص:\n` + (leads.map(l => `• ${l.course || 'غير محدد'} — ${l.status}`).join('\n') || 'لا توجد فرص ضمن نطاقك')
          + '\nالحجوزات:\n' + (orders.map(o => `• حجز #${o.id} — ${Number(o.total).toLocaleString('ar-EG')} ج.م — ${o.status}`).join('\n') || 'لا توجد حجوزات ضمن نطاقك');
      },
      howto_booking: async () => 'لإنشاء حجز: من صفحة العميل المحتمل اضغط «إنشاء حجز»، اختر الكورس أو الباقة والمجموعة، حدد نقدي أو تقسيط، ثم «اعتماد الحجز». السعر يُعتمد تلقائيًا ولا يمكن تعديله من المبيعات. لو اخترت «تحدد المجموعة لاحقًا»، يحددها مسؤول الكورسات من صفحة الحجز نفسها.',
      howto_installments: async () => 'الأقساط تُدار من قسم الحسابات > الأقساط: يمكن تحصيل قسط أو تأجيله (بصلاحية مدير الحسابات مع تسجيل السبب). المقدم مبلغ مخطط ولا يُعد محصلًا إلا بتسجيله دفعة فعلية.',
      howto_other: async () => {
        if (has('توزيع')) return 'توزيع العملاء: من «توزيع العملاء» حدّد الحاضرين ثم اضغط «توزيع الآن». العملاء الجدد يُسندون تلقائيًا للحاضرين، وبعد انقضاء مدة الإسناد دون حجز يعاد توزيعهم آليًا.';
        if (has('حضور')) return 'تسجيل الحضور: من صفحة الاستقبال اضغط «تسجيل الحضور» بجانب محاضرة اليوم، اختر حالة كل طالب (حاضر/غائب/متأخر/بعذر)، ثم «حفظ الحضور».';
        return CAPABILITIES;
      },
      out_of_scope: async () => 'هذا السؤال خارج نطاق الأسئلة التشغيلية اللي أقدر أساعد فيها.\n' + CAPABILITIES,
      refusal_bulk_pii: async () => 'آسف، لا أقدر أشارك بيانات شخصية أو أرقام هواتف بشكل جماعي.',
      fallback: async () => 'لم أفهم السؤال بعد — أسئلتي محددة ومش أي صيغة بتتفهم.\n' + CAPABILITIES,
    };

    // المطابقة المحلية أولًا (نفس السلوك القائم تمامًا)
    let intent;
    if (has('السلام عليكم', 'اهلا', 'هاي', 'مرحبا', 'صباح الخير', 'مساء الخير', 'ازيك', 'عامل ايه', 'عامله ايه')) intent = 'greeting';
    else if (has('ايه الاخبار', 'ايه الجديد', 'ملخص اليوم', 'ملخص النهارده', 'احوال النهارده', 'اخبار النهارده', 'اخبار اليوم', 'احوال الشغل')) intent = 'daily_summary';
    else if ((has('متاخر') && has('قسط', 'اقساط', 'دفع')) || has('ما دفعش', 'مدفعش', 'لسه ما دفع', 'لم يدفع', 'ما سددش')) intent = 'late_installments';
    else if (today && (has('مستحق', 'يستحق', 'تستحق', 'يدفع', 'يدفعوا', 'الدفع', 'دفع', 'سداد', 'يسدد') || has('قسط', 'اقساط'))) intent = 'due_today';
    else if (has('محاضر', 'حصه', 'حصص') && today) intent = 'sessions_today';
    else if (has('محاضر', 'حصه', 'حصص') && has('امبارح', 'بكره', 'غدا')) intent = 'sessions_other_day';
    else if (has('حضور', 'غياب', 'حاضر', 'غايب') && today) intent = 'attendance_today';
    else if (has('مجموع') && has('متاح', 'مكان', 'اماكن', 'فاضل', 'فاضي')) intent = 'available_groups';
    else if (has('تحصيل', 'ايراد', 'دخل', 'حصلنا') && (today || has('اسبوع'))) intent = has('اسبوع') && !today ? 'collections_week' : 'collections_today';
    else if (has('عميل', 'عملاء') && has('جديد', 'جدد')) intent = 'new_leads';
    else if (phoneMatch) intent = 'customer_by_phone';
    else if (has('بيانات') && has('عميل')) intent = 'customer_by_phone';
    else if (has('كيف', 'ازاي', 'طريقه', 'خطوات')) {
      if (has('حجز')) intent = 'howto_booking';
      else if (has('قسط') || has('تقسيط')) intent = 'howto_installments';
      else if (has('توزيع') || has('حضور')) intent = 'howto_other';
      else intent = 'capabilities_only';
    }
    else intent = 'fallback';

    // سؤال «كيف» العام كان يرجع قائمة القدرات مباشرة
    if (intent === 'capabilities_only') return CAPABILITIES;

    // التصنيف الخارجي مقيد بقائمة أسئلة وهمية ثابتة على الخادم: المستخدم يرسل رقم تعريف فقط،
    // والنص المُرسل للمزوّد هو السؤال الوهمي الثابت المقابل له، وليس أي إدخال من المتصل.
    // أي نص آخر (مسبوقًا بـ«تجربة:» أو لا) يبقى محليًا بالكامل ولا يحدث أي اتصال خارجي.
    if (intent === 'fallback' && LLM_KEY && LLM_TEST_MODE) {
      const fx = question.match(/^تجربة:\s*(q\d{1,2})$/);
      if (fx && EVAL_FIXTURES[fx[1]]) {
        const llm = await classifyWithLLM(EVAL_FIXTURES[fx[1]]);
        if (llm && handlers[llm]) intent = llm;
      }
    }
    return await handlers[intent]();
  } catch (e) {
    return 'حدث خطأ أثناء جلب البيانات. حاول مرة أخرى، ولو تكرر بلّغ مدير النظام.';
  }
}

router.get('/', (req, res) => {
  res.render('assistant', { title: 'مساعد كيان', nav: 'assistant', history: req.session.aiHistory || [], aiExternal: !!(LLM_KEY && LLM_TEST_MODE) });
});

router.post('/', async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) return res.redirect('/assistant');
  const reply = await answer(question, req.user);
  req.session.aiHistory = (req.session.aiHistory || []).concat([{ q: question, a: reply }]).slice(-20);
  res.redirect('/assistant');
});

module.exports = router;
