const express = require('express');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { can } = require('../lib/permissions');
const { accountBalances } = require('../lib/balances');

const router = express.Router();
router.use(requireAuth, requireCap('payments.view', 'payments.create', 'expenses.view', 'expenses.create', 'accounts.view'));

// لوحة الحسابات
router.get('/', async (req, res) => {
  const totals = (await q(`SELECT
    COALESCE(sum(amount) FILTER (WHERE status='active' AND paid_at::date=current_date),0) AS collected_today,
    COALESCE(sum(amount) FILTER (WHERE status='active'),0) AS collected_total
    FROM payments`)).rows[0];
  const outstanding = (await q(`SELECT COALESCE(sum(o.total_price),0) - COALESCE((
    SELECT sum(p.amount) FROM payments p WHERE p.status='active' AND p.order_id IN (SELECT id FROM sales_orders WHERE status='approved')),0) AS due
    FROM sales_orders o WHERE o.status='approved'`)).rows[0];
  const inst = (await q(`SELECT
    count(*) FILTER (WHERE i.due_date=current_date) AS due_today,
    count(*) FILTER (WHERE i.due_date<current_date) AS overdue,
    COALESCE(sum(i.amount) FILTER (WHERE i.due_date<current_date),0) AS overdue_amount
    FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN sales_orders o ON o.id=p.order_id
    WHERE i.status='pending' AND o.status='approved'
    AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount`)).rows[0];
  const byChannel = (await q(`SELECT method, COALESCE(sum(amount),0) AS total FROM payments WHERE status='active' GROUP BY method ORDER BY method`)).rows;
  const balances = await accountBalances();
  const closingToday = (await q('SELECT * FROM daily_closings WHERE closing_date=current_date')).rows[0] || null;
  const closings = (await q('SELECT c.*, u.name AS closed_by_name FROM daily_closings c LEFT JOIN users u ON u.id=c.closed_by ORDER BY closing_date DESC LIMIT 14')).rows;
  res.render('accounting/dashboard', { title: 'لوحة الحسابات', nav: 'accounting', totals, outstanding, inst, byChannel, balances, closingToday, closings, canManageAccounts:can(req.user.roles,'accounts.manage'),canClose: can(req.user.roles, 'closings.manage') });
});

// Opening balances: one-time setup before the first movement, never a fake collection.
router.get('/accounts',requireCap('accounts.manage'),async(req,res)=>{
 const rows=(await q(`SELECT a.*,(EXISTS(SELECT 1 FROM payments p WHERE p.account_id=a.id) OR EXISTS(SELECT 1 FROM expenses e WHERE e.account_id=a.id) OR EXISTS(SELECT 1 FROM transfers t WHERE t.from_account_id=a.id OR t.to_account_id=a.id)) AS has_movements FROM financial_accounts a ORDER BY a.id`)).rows;
 res.render('accounting/accounts',{title:'إعداد الحسابات والأرصدة الافتتاحية',nav:'accounting',rows});
});
router.post('/accounts/:id/opening',requireCap('accounts.manage'),async(req,res)=>{
 const {amount,notes}=req.body;
 if(!/^-?\d+(?:\.\d{1,2})?$/.test(String(amount))||!notes?.trim())return res.status(400).render('error',{title:'بيانات ناقصة',message:'أدخل رصيدًا بدقة قرش ومرجع المراجعة.'});
 try{await tx(async c=>{
  await c.query('LOCK TABLE payments,expenses,transfers IN SHARE ROW EXCLUSIVE MODE');
  const a=(await c.query('SELECT * FROM financial_accounts WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!a||a.opening_set_at)throw Object.assign(new Error('الحساب غير موجود أو تم اعتماد رصيده الافتتاحي بالفعل.'),{status:409});
  const exists=(await c.query(`SELECT EXISTS(SELECT 1 FROM payments WHERE account_id=$1) OR EXISTS(SELECT 1 FROM expenses WHERE account_id=$1) OR EXISTS(SELECT 1 FROM transfers WHERE from_account_id=$1 OR to_account_id=$1) AS n`,[a.id])).rows[0].n;
  if(exists)throw Object.assign(new Error('بدأت حركات على الحساب. لا يمكن تعديل أساس الرصيد بعد التشغيل.'),{status:409});
  await c.query('UPDATE financial_accounts SET opening_balance=$1,opening_date=current_date,opening_notes=$2,opening_set_by=$3,opening_set_at=now() WHERE id=$4',[amount,notes.trim(),req.user.id,a.id]);
  await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'account_opening_set','financial_account',$2,$3)",[req.user.id,String(a.id),JSON.stringify({amount,notes})]);
 });res.redirect('/accounting/accounts');}catch(e){res.status(e.status||500).render('error',{title:'لم يعتمد الرصيد',message:e.status?e.message:'لم يتغير الرصيد.'});}
});

// إقفال يومي
router.post('/closings', requireCap('closings.manage'), async (req, res) => {
  const balances = await accountBalances();
  try {
    await q('INSERT INTO daily_closings (closing_date, balances, notes, closed_by) VALUES (current_date, $1, $2, $3)',
      [JSON.stringify(balances), req.body.notes || null, req.user.id]);
    await audit(req, 'daily_closing', 'daily_closings', null, { balances: balances.map(b => ({ account: b.name, balance: b.balance })) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).render('error', { title: 'تم الإقفال', message: 'تم إقفال خزينة اليوم بالفعل.' });
    throw e;
  }
  res.redirect('/accounting');
});

// سياسة الدفعات المقدمة للمحاضرين: قرار المالك معلّق حتى الآن.
// المسار الافتراضي (false): يمنع أي دفعة تتجاوز الرصيد المستحق (المتفق عليه للمجموعات المنتهية − المدفوع).
// المسار البديل جاهز: إذا اعتمد المالك الدفعات المقدمة صراحة يُغيَّر هذا الثابت إلى true فتُسمح بها.
const ALLOW_TRAINER_ADVANCES = false;

// This setup creates only new fictional rows, never reclassifies existing records.
router.post('/trainers/preview-fixture', async(req,res)=>{
 if(process.env.PREVIEW_GATE_REQUIRED!=='1'||req.user.role!=='admin')return res.status(403).render('error',{title:'غير مسموح',message:'اختبار المعاينة لمسؤول النظام فقط.'});
 await tx(async c=>{
  await c.query('LOCK TABLE trainer_preview_fixture IN EXCLUSIVE MODE');
  if((await c.query('SELECT id FROM trainer_preview_fixture')).rowCount)return;
  const t=(await c.query("INSERT INTO trainers(name) VALUES('محاضر وهمي - قبول ربط المصروف') RETURNING id")).rows[0].id;
  const course=(await c.query("INSERT INTO courses(name,base_price) VALUES('كورس وهمي - قبول المحاضر',0) RETURNING id")).rows[0].id;
  const g=(await c.query("INSERT INTO groups(course_id,trainer_id,name,status,created_by) VALUES($1,$2,'SYNTHETIC-TRAINER-ACCEPTANCE','finished',$3) RETURNING id",[course,t,req.user.id])).rows[0].id;
  const a=(await c.query("INSERT INTO financial_accounts(name,type) VALUES('خزنة وهمية معزولة - قبول المحاضر','cash') RETURNING id")).rows[0].id;
  await c.query('INSERT INTO trainer_group_terms(group_id,trainer_id,agreed_amount,notes,created_by) VALUES($1,$2,1000,$3,$4)',[g,t,'وهمي فقط، لا مستحقات حقيقية',req.user.id]);
  await c.query('INSERT INTO trainer_preview_fixture(id,trainer_id,group_id,account_id,created_by) VALUES(1,$1,$2,$3,$4)',[t,g,a,req.user.id]);
 });
 await audit(req,'trainer_preview_fixture_ready','trainer_preview_fixture',1,{synthetic:true});
 res.redirect('/accounting/trainers');
});
// حساب المحاضرين — مبلغ متفق عليه لكل مجموعة يُستحق عند انتهائها (حالة finished)
router.get('/trainers', async (req, res) => {
  const { rows } = await q(`SELECT t.id AS trainer_id, t.name AS trainer_name, t.status AS trainer_status,
      g.id AS group_id, g.name AS group_name, g.status AS group_status, c.name AS course_name,
      s.id AS session_id, s.session_date, s.start_time, s.end_time, s.status AS session_status,
      tm.agreed_amount, tm.notes AS terms_notes
    FROM trainers t
    LEFT JOIN groups g ON g.trainer_id = t.id
    LEFT JOIN courses c ON c.id = g.course_id
    LEFT JOIN sessions s ON s.group_id = g.id
    LEFT JOIN trainer_group_terms tm ON tm.group_id = g.id
    ORDER BY t.id, g.id NULLS LAST, s.session_date NULLS LAST, s.start_time NULLS LAST`);
  const pays = (await q(`SELECT p.*, g.name AS group_name, u.name AS created_by_name, a.name AS account_name FROM trainer_payments p
    LEFT JOIN groups g ON g.id=p.group_id LEFT JOIN users u ON u.id=p.created_by LEFT JOIN financial_accounts a ON a.id=p.account_id
    WHERE p.status='active' ORDER BY p.created_at DESC`)).rows;
  const trainers = {};
  for (const r of rows) {
    if (!trainers[r.trainer_id]) trainers[r.trainer_id] = { id: r.trainer_id, name: r.trainer_name, status: r.trainer_status, groups: {}, doneCount: 0, doneMinutes: 0, monthCount: 0, monthMinutes: 0, nextSession: null, agreedTotal: 0, earned: 0, paid: 0 };
    const T = trainers[r.trainer_id];
    if (!r.group_id) continue;
    if (!T.groups[r.group_id]) {
      const agreed = r.agreed_amount !== null ? parseFloat(r.agreed_amount) : null;
      T.groups[r.group_id] = { id: r.group_id, name: r.group_name, course: r.course_name, status: r.group_status, agreed, terms_notes: r.terms_notes, sessions: [] };
      if (agreed !== null) { T.agreedTotal += agreed; if (r.group_status === 'finished') T.earned += agreed; }
    }
    if (!r.session_id) continue;
    T.groups[r.group_id].sessions.push(r);
    if (r.session_status === 'done') {
      T.doneCount++;
      let mins = 0;
      if (r.start_time && r.end_time) {
        const [h1,m1] = String(r.start_time).split(':').map(Number);
        const [h2,m2] = String(r.end_time).split(':').map(Number);
        mins = Math.max(0, (h2*60+m2) - (h1*60+m1));
      }
      T.doneMinutes += mins;
      const d = new Date(r.session_date);
      const now = new Date();
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) { T.monthCount++; T.monthMinutes += mins; }
    } else if (r.session_status === 'scheduled') {
      if (!T.nextSession || new Date(r.session_date) < new Date(T.nextSession.session_date)) T.nextSession = r;
    }
  }
  for (const p of pays) { const T = trainers[p.trainer_id]; if (T) T.paid += parseFloat(p.amount); }
  const list = Object.values(trainers).map(T => ({ ...T, groups: Object.values(T.groups), balance: T.earned - T.paid }));
  const totals = list.reduce((a, T) => ({ agreed: a.agreed + T.agreedTotal, earned: a.earned + T.earned, paid: a.paid + T.paid }), { agreed: 0, earned: 0, paid: 0 });
  totals.balance = totals.earned - totals.paid;
  const accounts = (await q('SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id')).rows;
  const fixture=process.env.PREVIEW_GATE_REQUIRED==='1'?(await q('SELECT * FROM trainer_preview_fixture WHERE id=1')).rows[0]:null;
  const fixtureBalance=fixture?(await accountBalances()).find(a=>a.id===fixture.account_id)?.balance:null;
  const fixtureProof=fixture?(await q("SELECT p.id,p.amount,p.status,p.expense_id,e.status AS expense_status FROM trainer_payments p JOIN expenses e ON e.id=p.expense_id WHERE p.trainer_id=$1 ORDER BY p.id DESC",[fixture.trainer_id])).rows:[];
  res.render('accounting/trainers', { fixture,fixtureBalance,fixtureProof,title: 'حساب المحاضرين', nav: 'trainer-accounts', list, totals, pays, accounts, canManage: can(req.user.roles, 'expenses.create'), canVoid: can(req.user.roles, 'expenses.void') });
});

// تحديد/تعديل المبلغ المتفق عليه لمجموعة
router.post('/trainers/terms', requireCap('expenses.create'), async (req, res) => {
  const amount = parseFloat(req.body.agreed_amount);
  if (!(amount >= 0)) return res.status(400).render('error', { title: 'قيمة غير صالحة', message: 'المبلغ المتفق عليه غير صالح.' });
  const g = (await q('SELECT id, trainer_id, name FROM groups WHERE id=$1', [req.body.group_id])).rows[0];
  if (!g) return res.status(404).render('error', { title: 'غير موجودة', message: 'المجموعة غير موجودة.' });
  if (!g.trainer_id) return res.status(400).render('error', { title: 'بلا محاضر', message: 'عيّن محاضرًا للمجموعة أولًا من صفحة المجموعات.' });
  await q(`INSERT INTO trainer_group_terms (group_id, trainer_id, agreed_amount, notes, created_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (group_id) DO UPDATE SET agreed_amount=$3, notes=$4, trainer_id=$2, updated_at=now()`,
    [g.id, g.trainer_id, amount, req.body.notes || null, req.user.id]);
  await audit(req, 'trainer_terms_set', 'group', g.id, { group: g.name, agreed_amount: amount });
  res.redirect('/accounting/trainers');
});

// تسجيل دفعة لمحاضر — تُنشئ مصروفًا مرتبطًا في نفس المعاملة فيخصم من الحساب المختار
router.post('/trainers/payments', requireCap('expenses.create'), async (req, res) => {
  const synthetic=req.body.synthetic==='on'&&process.env.PREVIEW_GATE_REQUIRED==='1';
  if (process.env.TRAINER_WRITES_APPROVED !== 'true'&&!synthetic) return res.status(409).render('error', {title:'معاينة فقط', message:'تسجيل دفعات المحاضرين موقوف مؤقتًا لحين اكتمال التحقق.'});
  const amount = parseFloat(req.body.amount);
  const method = req.body.method;
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(req.body.amount)) || !(amount > 0) || !['cash','bank_transfer','instapay','wallet'].includes(method) || !req.body.account_id) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من المبلغ وطريقة الدفع والحساب.' });
  }
  const t = (await q('SELECT id, name FROM trainers WHERE id=$1', [req.body.trainer_id])).rows[0];
  if (!t) return res.status(404).render('error', { title: 'غير موجود', message: 'المحاضر غير موجود.' });
  let groupId = req.body.group_id || null;
  if (groupId) {
    const g = (await q('SELECT id, trainer_id FROM groups WHERE id=$1', [groupId])).rows[0];
    if (!g || g.trainer_id !== t.id) return res.status(400).render('error', { title: 'قيمة غير صالحة', message: 'المجموعة لا تتبع هذا المحاضر.' });
  }
  try {
    const paymentId = await tx(async (c) => {
      await c.query('SELECT id FROM trainers WHERE id=$1 FOR UPDATE', [t.id]);
      const fixture=(await c.query('SELECT * FROM trainer_preview_fixture WHERE id=1 FOR SHARE')).rows[0];
      if(synthetic){
       const g=(await c.query('SELECT * FROM groups WHERE id=$1 FOR SHARE',[groupId])).rows[0];
       if(!fixture||fixture.trainer_id!==t.id||fixture.group_id!==Number(groupId)||fixture.account_id!==Number(req.body.account_id)||!g||g.trainer_id!==t.id||g.status!=='finished'||method!=='cash')throw Object.assign(new Error('الاختبار الوهمي يتطلب المحاضر والمجموعة المنتهية والخزنة المعزولة المحددة فقط.'),{status:409});
      }else if(fixture&&(fixture.trainer_id===t.id||fixture.group_id===Number(groupId)||fixture.account_id===Number(req.body.account_id))){throw Object.assign(new Error('سجلات الاختبار المعزولة تتطلب علامة وهمي.'),{status:409});}

  if (!ALLOW_TRAINER_ADVANCES) {
    const earned = parseFloat((await c.query(`SELECT COALESCE(sum(tm.agreed_amount),0) AS s FROM trainer_group_terms tm JOIN groups g ON g.id=tm.group_id WHERE tm.trainer_id=$1 AND g.status='finished'`, [t.id])).rows[0].s);
    const paid = parseFloat((await c.query(`SELECT COALESCE(sum(amount),0) AS s FROM trainer_payments WHERE trainer_id=$1 AND status='active'`, [t.id])).rows[0].s);
    const available = earned - paid;
    if (amount > available + 1e-9) {
      throw Object.assign(new Error(`المبلغ يتجاوز الرصيد المستحق المتاح (${available.toLocaleString('ar-EG')} ج.م). الدفعات المقدمة موقوفة لحين اعتماد المالك قاعدتها.`), {status:400});
    }
  }
      const type = (await c.query(`SELECT id FROM expense_types WHERE name='مستحقات محاضرين'`)).rows[0];
      const exp = await c.query(`INSERT INTO expenses (type_id, amount, expense_date, account_id, recorded_by, notes) VALUES ($1,$2,current_date,$3,$4,$5) RETURNING id`,
        [type.id, amount, req.body.account_id, req.user.id, ('دفعة محاضر: ' + t.name) + (req.body.notes ? ' — ' + req.body.notes : '')]);
      const ins = await c.query('INSERT INTO trainer_payments (trainer_id, group_id, amount, method, account_id, expense_id, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [t.id, groupId, amount, method, req.body.account_id, exp.rows[0].id, req.body.notes || null, req.user.id]);
      return ins.rows[0].id;
    });
    await audit(req, 'trainer_payment_recorded', 'trainer_payment', paymentId, { trainer: t.name, amount, method, account_id: req.body.account_id, group_id: groupId });
    res.redirect('/accounting/trainers');
  } catch (e) {
    res.status(e.status || 500).render('error', { title: 'تعذر تسجيل الدفعة', message: e.message });
  }
});

// إلغاء دفعة لمحاضر — يلغي المصروف المرتبط في نفس المعاملة
router.post('/trainers/payments/:id/void', requireCap('expenses.void'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).render('error', { title: 'سبب مطلوب', message: 'سبب الإلغاء إلزامي ويُسجل في سجل المراجعة.' });
  const p = (await q('SELECT * FROM trainer_payments WHERE id=$1', [req.params.id])).rows[0];
  if (!p) return res.status(404).render('error', { title: 'غير موجودة', message: 'الدفعة غير موجودة.' });
  if (p.status !== 'active') return res.redirect('/accounting/trainers');
  try {
  await tx(async (c) => {
    await c.query(`UPDATE trainer_payments SET status='void', voided_by=$1, voided_at=now() WHERE id=$2`, [req.user.id, p.id]);
    if (p.expense_id) await c.query(`UPDATE expenses SET status='voided', void_reason=$1, voided_by=$2, voided_at=now() WHERE id=$3 AND status='active'`, [reason, req.user.id, p.expense_id]);
  });
  } catch (e) { return res.status(500).render('error', {title:'تعذر الإلغاء', message:'لم يتم إلغاء الدفعة. لم تتغير السجلات المرتبطة.'}); }
  await audit(req, 'trainer_payment_voided', 'trainer_payment', p.id, { reason, amount: p.amount, expense_id: p.expense_id });
  res.redirect('/accounting/trainers');
});

// المدفوعات
router.get('/payments', async (req, res) => {
  const { rows } = await q(`SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, a.name AS account_name, u.name AS received_by_name, v.name AS voided_by_name
    FROM payments p JOIN sales_orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id
    JOIN financial_accounts a ON a.id=p.account_id LEFT JOIN users u ON u.id=p.received_by LEFT JOIN users v ON v.id=p.voided_by
    ORDER BY p.id DESC LIMIT 300`);
  res.render('accounting/payments', { title: 'المدفوعات', nav: 'payments', rows, canVoid: can(req.user.roles, 'payments.void') });
});

router.post('/payments', requireCap('payments.create'), async (req, res) => {
  const { order_id, amount, method, account_id, installment_id, notes } = req.body;
  const requestKey=req.body.request_key||null;
  if(requestKey&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey))return res.status(400).send('Invalid request key');
  const amt = Number(amount);
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(amount)) || !order_id || !amt || amt <= 0 || !account_id || !['cash','bank_transfer','instapay','wallet'].includes(method)) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من رقم الحجز والمبلغ وطريقة الدفع والحساب.' });
  }
  try {
    const paymentId = await tx(async (c) => {
      const order = (await c.query(`SELECT * FROM sales_orders WHERE id=$1 AND status='approved' FOR UPDATE`, [order_id])).rows[0];
      if (!order) throw Object.assign(new Error('الحجز غير موجود أو ملغي.'), { status: 404 });
      if(requestKey){const prior=(await c.query('SELECT * FROM payments WHERE request_key=$1',[requestKey])).rows[0];if(prior){if(prior.order_id!==Number(order_id)||Number(prior.amount)!==amt||prior.account_id!==Number(account_id)||prior.method!==method||String(prior.installment_id||'')!==String(installment_id||'')||prior.received_by!==req.user.id)throw Object.assign(new Error('رمز العملية مستخدم لبيانات مختلفة.'),{status:409});return prior.id;}}
      const paidSoFar = parseFloat((await c.query(`SELECT COALESCE(sum(amount),0) AS s FROM payments WHERE order_id=$1 AND status='active'`, [order_id])).rows[0].s);
      if (amt > parseFloat(order.total_price) - paidSoFar + 0.001) {
        throw Object.assign(new Error(`المبلغ يتجاوز المتبقي على الحجز (${(parseFloat(order.total_price) - paidSoFar).toLocaleString('ar-EG')} ج.م).`), { status: 400 });
      }
      if(order.payment_type==='installments'&&!installment_id){
        const plan=(await c.query('SELECT down_payment FROM installment_plans WHERE order_id=$1',[order_id])).rows[0];
        const downPaid=Number((await c.query("SELECT COALESCE(sum(amount),0) AS n FROM payments WHERE order_id=$1 AND installment_id IS NULL AND status='active'",[order_id])).rows[0].n);
        if(!plan||amt>Number(plan.down_payment)-downPaid+0.001)throw Object.assign(new Error('اختر القسط المطلوب تحصيله، التحصيل بدون قسط مخصص للمقدم فقط.'),{status:400});
      }
      const account=(await c.query('SELECT id FROM financial_accounts WHERE id=$1 AND active FOR SHARE',[account_id])).rows[0];
      if(!account)throw Object.assign(new Error('الحساب المالي غير متاح.'),{status:400});
      if(installment_id){
        const inst=(await c.query('SELECT i.*,p.order_id FROM installments i JOIN installment_plans p ON p.id=i.plan_id WHERE i.id=$1 FOR UPDATE OF i',[installment_id])).rows[0];
        if(!inst||inst.order_id!==Number(order_id))throw Object.assign(new Error('القسط لا يتبع هذا الحجز.'),{status:400});
        const paid=Number((await c.query("SELECT COALESCE(sum(amount),0) AS n FROM payments WHERE installment_id=$1 AND status='active'",[installment_id])).rows[0].n);
        if(amt>Number(inst.amount)-paid+0.001)throw Object.assign(new Error('المبلغ يتجاوز المتبقي على القسط.'),{status:400});
      }
      const ins = await c.query(`INSERT INTO payments (order_id, installment_id, amount, method, account_id, received_by, notes,request_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [order_id, installment_id || null, amt, method, account_id, req.user.id, notes || null,requestKey]);
      if (installment_id) {
        const i = (await c.query(`SELECT i.*, p.order_id FROM installments i JOIN installment_plans p ON p.id=i.plan_id WHERE i.id=$1 FOR UPDATE`, [installment_id])).rows[0];
        if (i && i.order_id === parseInt(order_id, 10)) {
          const paidInst = parseFloat((await c.query(`SELECT COALESCE(sum(amount),0) AS s FROM payments WHERE installment_id=$1 AND status='active'`, [installment_id])).rows[0].s);
          if (paidInst >= parseFloat(i.amount)) await c.query(`UPDATE installments SET status='paid' WHERE id=$1`, [installment_id]);
        }
      }
      return ins.rows[0].id;
    });
    await audit(req, 'payment_created', 'payment', paymentId, { order_id, amount: amt, method });
    res.redirect('/orders/' + order_id);
  } catch (e) {
    res.status(e.status || 500).render('error', { title: 'تعذر تسجيل الدفعة', message: e.message });
  }
});

// إلغاء دفعة (عكس مالي) - لا حذف نهائي
router.post('/payments/:id/void', requireCap('payments.void'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).render('error', { title: 'سبب مطلوب', message: 'سبب إلغاء الدفعة إلزامي ويُسجل في سجل المراجعة.' });
  try {await tx(async c=>{
    const ref=(await c.query('SELECT order_id FROM payments WHERE id=$1',[req.params.id])).rows[0];
    if(!ref)throw Object.assign(new Error('الدفعة غير موجودة.'),{status:404});
    // Serialize with collections on the same booking, then receipt confirmation on payment row.
    await c.query('SELECT id FROM sales_orders WHERE id=$1 FOR UPDATE',[ref.order_id]);
    const p=(await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(p.status==='voided')return;
    await c.query("UPDATE payments SET status='voided',void_reason=$1,voided_by=$2,voided_at=now() WHERE id=$3",[reason,req.user.id,p.id]);
    await c.query("UPDATE invoices SET status='voided',void_reason=$1,voided_by=$2,voided_at=now() WHERE payment_id=$3",[reason,req.user.id,p.id]);
    if(p.installment_id){
      const i=(await c.query('SELECT * FROM installments WHERE id=$1 FOR UPDATE',[p.installment_id])).rows[0];
      const paid=Number((await c.query("SELECT COALESCE(sum(amount),0) AS n FROM payments WHERE installment_id=$1 AND status='active'",[p.installment_id])).rows[0].n);
      if(i&&paid<Number(i.amount))await c.query("UPDATE installments SET status='pending' WHERE id=$1",[i.id]);
    }
    await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'payment_voided','payment',$2,$3)",[req.user.id,String(p.id),JSON.stringify({reason,amount:p.amount,linked_receipt_voided:true})]);
  });res.redirect('/accounting/payments');}catch(e){res.status(e.status||500).render('error',{title:'تعذر إلغاء التحصيل',message:e.status?e.message:'لم يتغير التحصيل أو الإيصال. أعد المحاولة بعد المراجعة.'});}
});

// الأقساط
router.get('/installments', async (req, res) => {
  const filter = req.query.f || 'all';
  let cond = '';
  if (filter === 'today') cond = 'AND i.due_date=current_date';
  if (filter === 'overdue') cond = 'AND i.due_date<current_date';
  if (filter === 'upcoming') cond = 'AND i.due_date>current_date';
  const { rows } = await q(`SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, o.id AS order_id, o.total_price,
    (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') AS paid
    FROM installments i JOIN installment_plans p ON p.id=i.plan_id
    JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
    JOIN customers c ON c.id=o.customer_id
    WHERE TRUE ${cond} ORDER BY i.due_date LIMIT 300`);
  const accounts=(await q('SELECT id,name FROM financial_accounts WHERE active ORDER BY id')).rows;
  res.render('accounting/installments', {accounts, title: 'الأقساط', nav: 'installments', rows, filter, canManage: can(req.user.roles, 'installments.manage'), canPay: can(req.user.roles, 'payments.create') });
});

// تأجيل قسط: الاحتفاظ بالتاريخ الأصلي والسبب والموافقة
router.post('/installments/:id/postpone', requireCap('installments.manage'), async (req, res) => {
  const { new_date, reason } = req.body;
  if (!new_date || !reason) return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'التاريخ الجديد وسبب التأجيل إلزاميان.' });
  const i = (await q('SELECT * FROM installments WHERE id=$1', [req.params.id])).rows[0];
  if (!i) return res.status(404).render('error', { title: 'غير موجود', message: 'القسط غير موجود.' });
  await q(`UPDATE installments SET due_date=$1, postpone_reason=$2, postponed_by=$3, postponed_at=now(), postpone_approved_by=$3 WHERE id=$4`,
    [new_date, reason, req.user.id, i.id]);
  await audit(req, 'installment_postponed', 'installment', i.id, { from: i.due_date, to: new_date, reason });
  res.redirect('/accounting/installments');
});

// المصروفات
router.get('/expenses', async (req, res) => {
  const { rows } = await q(`SELECT e.*, t.name AS type_name, a.name AS account_name, u.name AS recorded_by_name, v.name AS voided_by_name
    FROM expenses e JOIN expense_types t ON t.id=e.type_id JOIN financial_accounts a ON a.id=e.account_id
    LEFT JOIN users u ON u.id=e.recorded_by LEFT JOIN users v ON v.id=e.voided_by
    ORDER BY e.expense_date DESC, e.id DESC LIMIT 300`);
  const types = (await q('SELECT * FROM expense_types ORDER BY name')).rows;
  const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
  res.render('accounting/expenses', { title: 'المصروفات', nav: 'expenses', rows, types, accounts, canManage: can(req.user.roles, 'expenses.void'), canTypes: can(req.user.roles, 'expense_types.manage') });
});

router.post('/expenses', requireCap('expenses.create'), async (req, res) => {
  const { type_id, amount, expense_date, account_id, notes } = req.body;
  const amt = parseFloat(amount);
  if (!type_id || !amt || amt <= 0 || !expense_date || !account_id) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من نوع المصروف والقيمة والتاريخ والحساب.' });
  }
  const ins = await q('INSERT INTO expenses (type_id, amount, expense_date, account_id, recorded_by, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [type_id, amt, expense_date, account_id, req.user.id, notes || null]);
  await audit(req, 'expense_created', 'expense', ins.rows[0].id, { type_id, amount: amt });
  res.redirect('/accounting/expenses');
});

router.post('/expenses/:id/void', requireCap('expenses.void'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).render('error', { title: 'سبب مطلوب', message: 'سبب الإلغاء إلزامي.' });
  if ((await q('SELECT id FROM trainer_payments WHERE expense_id=$1', [req.params.id])).rowCount) return res.status(409).render('error', {title:'مصروف مرتبط', message:'يجب إلغاء هذه الدفعة من حساب المحاضرين ليتم إلغاء السجلين معًا.'});
  await q(`UPDATE expenses SET status='voided', void_reason=$1, voided_by=$2, voided_at=now() WHERE id=$3 AND status='active'`, [reason, req.user.id, req.params.id]);
  await audit(req, 'expense_voided', 'expense', req.params.id, { reason });
  res.redirect('/accounting/expenses');
});

router.post('/expense-types', requireCap('expense_types.manage'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'اسم النوع مطلوب.' });
  await q('INSERT INTO expense_types (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  await audit(req, 'expense_type_created', 'expense_type', null, { name });
  res.redirect('/accounting/expenses');
});

// التحويلات بين الحسابات (ليست مصروفًا ولا إيرادًا)
router.get('/transfers', requireCap('transfers.view', 'transfers.create', 'accounts.view'), async (req, res) => {
  const { rows } = await q(`SELECT t.*, f.name AS from_name, tt.name AS to_name, u.name AS recorded_by_name
    FROM transfers t JOIN financial_accounts f ON f.id=t.from_account_id JOIN financial_accounts tt ON tt.id=t.to_account_id
    LEFT JOIN users u ON u.id=t.recorded_by ORDER BY t.id DESC LIMIT 200`);
  const accounts = (await q(`SELECT * FROM financial_accounts WHERE active=TRUE ORDER BY id`)).rows;
  res.render('accounting/transfers', { title: 'التحويلات بين الحسابات', nav: 'accounting', rows, accounts, canCreate: can(req.user.roles, 'transfers.create') });
});

router.post('/transfers', requireCap('transfers.create'), async (req, res) => {
  const { from_account_id, to_account_id, amount, transfer_date, notes } = req.body;
  const amt = parseFloat(amount);
  if (!from_account_id || !to_account_id || from_account_id === to_account_id || !amt || amt <= 0 || !transfer_date) {
    return res.status(400).render('error', { title: 'بيانات غير صالحة', message: 'تأكد من الحسابين والمبلغ والتاريخ.' });
  }
  const ins = await q('INSERT INTO transfers (from_account_id, to_account_id, amount, transfer_date, notes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [from_account_id, to_account_id, amt, transfer_date, notes || null, req.user.id]);
  await audit(req, 'transfer_created', 'transfer', ins.rows[0].id, { from_account_id, to_account_id, amount: amt });
  res.redirect('/accounting/transfers');
});

module.exports = router;
