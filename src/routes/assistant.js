// مساعد كيان: مساعد بحث داخلي يجيب موظفي النظام عن أسئلة تشغيلية محددة من قاعدة البيانات مباشرة.
// ليس نموذج ذكاء اصطناعي: يعمل بمطابقة كلمات مفتاحية على استعلامات جاهزة،
// والواجهة توضح ذلك بصدق. الإجابات مقيدة بصلاحيات الدور: لا يرى الموظف إلا ما تسمح به صلاحياته.
// نقطة ربط خارجية مستقبلية: AI_API_KEY/AI_API_URL (موثقة في README) — لم تُفعَّل.
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

async function answer(question, user) {
  const t = norm(question);
  const has = (...words) => words.some(w => t.includes(norm(w)));
  const rc = (cap) => can(user.roles || [user.role], cap);
  const today = has('اليوم', 'النهارده');
  const finList = rc('installments.view') ? 'full' : rc('installments.view.limited') ? 'limited' : null;
  // نطاق الرؤية: من يملك عرض الكل يرى كل شيء، وغيره يرى ما أُسند إليه أو أنشأه فقط
  const leadScope = rc('leads.view.all') ? { cond: '', params: [] } : { cond: ' AND (l.assigned_to=$1 OR l.created_by=$1)', params: [user.id] };
  const orderScope = rc('orders.view.all') ? { cond: '', params: [] } : { cond: ' AND o.sales_user_id=$1', params: [user.id] };
  try {
    // تحيات وأسئلة عامة
    if (has('السلام عليكم', 'اهلا', 'هاي', 'مرحبا', 'صباح الخير', 'مساء الخير', 'ازيك', 'عامل ايه', 'عامله ايه')) {
      return `أهلًا ${user.name}! 👋\n${CAPABILITIES}`;
    }
    if (has('ايه الاخبار', 'ايه الجديد', 'ملخص اليوم', 'ملخص النهارده', 'احوال النهارده')) {
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
    }
    // الأقساط المتأخرة (بصيغ متعددة: مين متأخر / مين ما دفعش / لسه مدفعش)
    if ((has('متاخر') && has('قسط', 'اقساط', 'دفع')) || has('ما دفعش', 'مدفعش', 'لسه ما دفع', 'لم يدفع', 'ما سددش')) {
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
    }
    // الأقساط المستحقة اليوم (مين المفروض يدفع النهارده / عملاء يمكنهم الدفع اليوم)
    if (today && (has('مستحق', 'يستحق', 'تستحق', 'يدفع', 'يدفعوا', 'الدفع', 'دفع', 'سداد', 'يسدد') || has('قسط', 'اقساط'))) {
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
    }
    // محاضرات اليوم
    if (has('محاضر', 'حصه', 'حصص') && today) {
      if (!(rc('groups.view') || rc('reception.view') || rc('sessions.manage'))) return NO_CAP;
      const { rows } = await q(`SELECT s.start_time, g.name AS g, c.name AS c, t.name AS tr FROM sessions s
        JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
        WHERE s.session_date=current_date AND s.status!='cancelled' ORDER BY s.start_time`);
      if (!rows.length) return 'لا توجد محاضرات مجدولة اليوم.';
      return 'محاضرات اليوم:\n' + rows.map(r => `• ${r.g} (${r.c}) — ${r.start_time ? String(r.start_time).slice(0, 5) : ''} — المدرب: ${r.tr || 'غير محدد'}`).join('\n');
    }
    // حضور اليوم
    if (has('حضور', 'غياب', 'حاضر', 'غايب') && today) {
      if (!rc('attendance.view')) return NO_CAP;
      const { rows } = await q(`SELECT g.name AS g, a.status, count(*) AS n FROM attendance a
        JOIN sessions s ON s.id=a.session_id JOIN groups g ON g.id=s.group_id
        WHERE s.session_date=current_date GROUP BY g.name, a.status ORDER BY g.name, a.status`);
      if (!rows.length) return 'لم يُسجَّل حضور لأي محاضرة اليوم بعد.';
      const L = { present: 'حاضر', absent: 'غائب', late: 'متأخر', excused: 'بعذر' };
      return 'حضور اليوم:\n' + rows.map(r => `• ${r.g}: ${L[r.status] || r.status} ${r.n}`).join('\n');
    }
    // المجموعات المتاحة
    if (has('مجموع') && has('متاح', 'مكان', 'اماكن', 'فاضل', 'فاضي')) {
      if (!rc('groups.view')) return NO_CAP;
      const { rows } = await q(`SELECT g.name, c.name AS course, g.capacity,
        (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
        FROM groups g JOIN courses c ON c.id=g.course_id WHERE g.status IN ('open','nearly_full') ORDER BY g.start_date`);
      if (!rows.length) return 'لا توجد مجموعات متاحة للحجز الآن.';
      return 'المجموعات المتاحة:\n' + rows.map(r => `• ${r.name} (${r.course}): متاح ${r.capacity - Number(r.booked)} من ${r.capacity}`).join('\n');
    }
    // تحصيل اليوم / الأسبوع
    if (has('تحصيل', 'ايراد', 'دخل', 'حصلنا') && (today || has('اسبوع'))) {
      if (!rc('payments.view')) return NO_CAP;
      if (has('اسبوع') && !today) {
        const { rows } = await q(`SELECT COALESCE(sum(amount),0) AS total, count(*) AS n FROM payments WHERE status='active' AND paid_at >= now() - interval '7 days'`);
        return `تحصيل آخر ٧ أيام: ${Number(rows[0].total).toLocaleString('ar-EG')} ج.م عبر ${rows[0].n} عملية.`;
      }
      const { rows } = await q(`SELECT COALESCE(sum(amount),0) AS total, count(*) AS n FROM payments WHERE status='active' AND paid_at::date=current_date`);
      return `تحصيل اليوم: ${Number(rows[0].total).toLocaleString('ar-EG')} ج.م عبر ${rows[0].n} عملية.`;
    }
    // العملاء الجدد
    if (has('عميل', 'عملاء') && has('جديد', 'جدد')) {
      if (!(rc('leads.view.own') || rc('leads.view.all') || rc('leads.view'))) return NO_CAP;
      const { rows } = await q(`SELECT count(*) FILTER (WHERE l.created_at::date=current_date) AS today, count(*) FILTER (WHERE l.created_at >= now() - interval '7 days') AS week FROM leads l WHERE TRUE${leadScope.cond}`, leadScope.params);
      return `العملاء الجدد${rc('leads.view.all') ? '' : ' (ضمن نطاقك)'}: اليوم ${rows[0].today} — آخر ٧ أيام ${rows[0].week}.`;
    }
    // بيانات عميل برقم الهاتف
    const phoneMatch = question.match(/01[0-9]{9}/);
    if (phoneMatch) {
      if (!rc('customers.view')) return NO_CAP;
      const { rows } = await q('SELECT * FROM customers WHERE phone=$1', [phoneMatch[0]]);
      if (!rows.length) return `لا يوجد عميل مسجل بالرقم ${phoneMatch[0]}.`;
      const c = rows[0];
      const seeAllLeads = rc('leads.view.all'), seeAllOrders = rc('orders.view.all');
      const leads = (await q(`SELECT l.status, co.name AS course FROM leads l LEFT JOIN courses co ON co.id=l.course_id WHERE l.customer_id=$1${seeAllLeads ? '' : ' AND (l.assigned_to=$2 OR l.created_by=$2)'} ORDER BY l.id DESC`, seeAllLeads ? [c.id] : [c.id, user.id])).rows;
      const orders = (await q(`SELECT o.id, o.total_price AS total, o.status FROM sales_orders o WHERE o.customer_id=$1${seeAllOrders ? '' : ' AND o.sales_user_id=$2'} ORDER BY o.id DESC`, seeAllOrders ? [c.id] : [c.id, user.id])).rows;
      const scoped = !(seeAllLeads && seeAllOrders);
      return `العميل: ${c.name} (${c.phone})${scoped ? '\n(تُعرض بياناته ضمن نطاق صلاحياتك فقط)' : ''}\nالفرص:\n` + (leads.map(l => `• ${l.course || 'غير محدد'} — ${l.status}`).join('\n') || 'لا توجد فرص ضمن نطاقك')
        + '\nالحجوزات:\n' + (orders.map(o => `• حجز #${o.id} — ${Number(o.total).toLocaleString('ar-EG')} ج.م — ${o.status}`).join('\n') || 'لا توجد حجوزات ضمن نطاقك');
    }
    // خطوات تنفيذ إجراء
    if (has('كيف', 'ازاي', 'طريقه')) {
      if (has('حجز')) return 'لإنشاء حجز: من صفحة العميل المحتمل اضغط «إنشاء حجز»، اختر الكورس أو الباقة والمجموعة، حدد نقدي أو تقسيط، ثم «اعتماد الحجز». السعر يُعتمد تلقائيًا ولا يمكن تعديله من المبيعات. لو اخترت «تحدد المجموعة لاحقًا»، يحددها مسؤول الكورسات من صفحة الحجز نفسها.';
      if (has('قسط') || has('تقسيط')) return 'الأقساط تُدار من قسم الحسابات > الأقساط: يمكن تحصيل قسط أو تأجيله (بصلاحية مدير الحسابات مع تسجيل السبب). المقدم مبلغ مخطط ولا يُعد محصلًا إلا بتسجيله دفعة فعلية.';
      if (has('توزيع')) return 'توزيع العملاء: من «توزيع العملاء» حدّد الحاضرين ثم اضغط «توزيع الآن». العملاء الجدد يُسندون تلقائيًا للحاضرين، وبعد انقضاء مدة الإسناد دون حجز يعاد توزيعهم آليًا.';
      if (has('حضور')) return 'تسجيل الحضور: من صفحة الاستقبال اضغط «تسجيل الحضور» بجانب محاضرة اليوم، اختر حالة كل طالب (حاضر/غائب/متأخر/بعذر)، ثم «حفظ الحضور».';
      return CAPABILITIES;
    }
    return 'لم أفهم السؤال بعد — أسئلتي محددة ومش أي صيغة بتتفهم.\n' + CAPABILITIES;
  } catch (e) {
    return 'حدث خطأ أثناء جلب البيانات. حاول مرة أخرى، ولو تكرر بلّغ مدير النظام.';
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
