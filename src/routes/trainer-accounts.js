const express=require('express');
const {q}=require('../db');
const {requireAuth,requireCap}=require('../middleware/auth');
const {can}=require('../lib/permissions');
const service=require('../lib/trainer-ledger');
const router=express.Router();
router.use(requireAuth,requireCap('expenses.view','expenses.create','accounts.view'));
router.use((req,res,next)=>{if(process.env.TRAINER_ACCOUNTS_ENABLED!=='true')return res.status(404).end();next();});
function writable(req,res,next){if(process.env.TRAINER_WRITES_APPROVED!=='true')return res.status(409).render('error',{title:'قراءة فقط',message:'تعديل حساب المحاضرين والصرف موقوف لحين الاعتماد.'});next();}
function fail(res,e){return res.status(e.status||500).render('error',{title:'لم تنفذ العملية',message:e.status?e.message:'لم تتغير السجلات. راجع المسؤول قبل إعادة المحاولة.'});}
router.get('/', async (req, res) => {
  const { rows } = await q(`SELECT t.id AS trainer_id, t.name AS trainer_name, t.status AS trainer_status,
      g.id AS group_id, g.name AS group_name, g.status AS group_status, c.name AS course_name,
      s.id AS session_id, s.session_date, s.start_time, s.end_time, s.status AS session_status,
      tm.agreed_amount, tm.notes AS terms_notes
    FROM trainers t
    LEFT JOIN groups g ON g.trainer_id = t.id
    LEFT JOIN courses c ON c.id = g.course_id
    LEFT JOIN sessions s ON s.group_id = g.id
    LEFT JOIN trainer_group_terms tm ON tm.group_id = g.id AND tm.trainer_id=t.id
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
  res.render('accounting/trainers', {title:'حساب المحاضرين',nav:'trainer-accounts',list,totals,pays,accounts,canManage:can(req.user.roles,'expenses.create'),canVoid:can(req.user.roles,'expenses.void'),writesEnabled:process.env.TRAINER_WRITES_APPROVED==='true',requestKey:()=>require('crypto').randomUUID()});
});

router.post('/terms',requireCap('expenses.create'),writable,async(req,res)=>{try{await service.setTerms({...req.body,userId:req.user.id});res.redirect('/accounting/trainers');}catch(e){fail(res,e);}});
router.post('/payments',requireCap('expenses.create'),writable,async(req,res)=>{try{await service.pay({...req.body,userId:req.user.id});res.redirect('/accounting/trainers');}catch(e){fail(res,e);}});
router.post('/payments/:id/void',requireCap('expenses.void'),writable,async(req,res)=>{try{await service.voidPayment({id:req.params.id,reason:req.body.reason,userId:req.user.id});res.redirect('/accounting/trainers');}catch(e){fail(res,e);}});
module.exports=router;
