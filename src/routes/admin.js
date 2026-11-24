const express = require('express');
const crypto = require('crypto');
const { q, tx } = require('../db');
const { requireAuth, requireCap } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const { ROLES, can } = require('../lib/permissions');
const { getSetting, setSetting } = require('../lib/settings');

const router = express.Router();
router.use(requireAuth);

const ASSIGNABLE_ROLES = Object.keys(ROLES).filter(r => r !== 'admin');

// إدارة المستخدمين (مدير النظام فقط)
router.get('/users', requireCap('users.manage', 'users.request'), async (req, res) => {
  const { rows: users } = await q(`SELECT u.*, i.name AS invited_by_name FROM users u LEFT JOIN users i ON i.id=u.invited_by ORDER BY u.id`);
  const { rows: invites } = await q(`SELECT v.*, u.name AS created_by_name FROM invites v LEFT JOIN users u ON u.id=v.created_by ORDER BY v.id DESC`);
  const { rows: requests } = await q(`SELECT r.*, u.name AS requested_by_name FROM user_add_requests r JOIN users u ON u.id=r.requested_by ORDER BY r.id DESC`);
  res.render('admin/users', { title: 'المستخدمون', users, invites, requests, roles: ROLES, assignableRoles: ASSIGNABLE_ROLES, inviteLink: null, canManage: can(req.user.roles, 'users.manage') });
});

router.post('/users/invite', requireCap('users.manage'), async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email || !ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'تأكد من الاسم والبريد والدور.' });
  }
  const exists = await q('SELECT 1 FROM users WHERE email=$1', [email.trim().toLowerCase()]);
  if (exists.rowCount) return res.status(409).render('error', { title: 'بريد مسجل', message: 'يوجد مستخدم بهذا البريد بالفعل.' });
  const token = crypto.randomBytes(24).toString('hex');
  await q(`INSERT INTO invites (email, name, role, token, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')`,
    [email.trim().toLowerCase(), name.trim(), role, token, req.user.id]);
  await audit(req, 'invite_created', 'invite', token.slice(0, 8), { email, role, name });
  const inviteLink = `${req.protocol}://${req.get('host')}/invite/${token}`;
  const { rows: users } = await q(`SELECT u.*, i.name AS invited_by_name FROM users u LEFT JOIN users i ON i.id=u.invited_by ORDER BY u.id`);
  const { rows: invites } = await q(`SELECT v.*, u.name AS created_by_name FROM invites v LEFT JOIN users u ON u.id=v.created_by ORDER BY v.id DESC`);
  const { rows: requests } = await q(`SELECT r.*, u.name AS requested_by_name FROM user_add_requests r JOIN users u ON u.id=r.requested_by ORDER BY r.id DESC`);
  res.render('admin/users', { title: 'المستخدمون', users, invites, requests, roles: ROLES, assignableRoles: ASSIGNABLE_ROLES, inviteLink, canManage: true });
});

router.post('/users/:id/roles', requireCap('users.manage'), async(req,res)=>{
 const role=String(req.body.role||'');let extras=req.body.extra_roles||[];if(!Array.isArray(extras))extras=[extras];
 if(!ASSIGNABLE_ROLES.includes(role)||extras.some(x=>!ASSIGNABLE_ROLES.includes(x)))return res.status(400).render('error',{title:'دور غير صالح',message:'اختر أدوارا صحيحة، لا يمكن إضافة مدير النظام.'});
 extras=[...new Set(extras)].filter(x=>x!==role).sort();
 try{await tx(async c=>{const t=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
 if(!t)throw Object.assign(Error('المستخدم غير موجود.'),{status:404});
 if(t.role==='admin'||t.extra_roles.includes('admin'))throw Object.assign(Error('لا يمكن تعديل مدير النظام الأصلي.'),{status:403});
 await c.query('UPDATE users SET role=$1,extra_roles=$2,updated_at=now() WHERE id=$3',[role,extras,t.id]);
 await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'user_roles_changed','user',$2,$3)",[req.user.id,String(t.id),JSON.stringify({before:{role:t.role,extra_roles:t.extra_roles},after:{role,extra_roles:extras}})]);
 });res.redirect('/admin/users');}catch(e){res.status(e.status||500).render('error',{title:'تعذر تعديل الصلاحيات',message:e.status?e.message:'لم يتم الحفظ.'});}
});

router.post('/users/:id/toggle', requireCap('users.manage'), async (req, res) => {
  const target = await q('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!target.rowCount) return res.status(404).render('error', { title: 'غير موجود', message: 'المستخدم غير موجود.' });
  if (target.rows[0].role === 'admin') {
    return res.status(403).render('error', { title: 'غير مسموح', message: 'لا يمكن تعطيل مدير النظام الأصلي.' });
  }
  await q('UPDATE users SET active = NOT active, updated_at=now() WHERE id=$1', [req.params.id]);
  await audit(req, 'user_toggled', 'user', req.params.id, { active: !target.rows[0].active });
  res.redirect('/admin/users');
});

// المشرف العام يطلب إضافة مستخدم - يحتاج موافقة المدير
router.post('/users/request', requireCap('users.request'), async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email || !ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).render('error', { title: 'بيانات ناقصة', message: 'تأكد من الاسم والبريد والدور.' });
  }
  await q('INSERT INTO user_add_requests (requested_by, name, email, role) VALUES ($1,$2,$3,$4)', [req.user.id, name.trim(), email.trim().toLowerCase(), role]);
  await audit(req, 'user_add_requested', 'user_add_request', null, { email, role });
  res.redirect('/admin/users');
});

router.post('/users/requests/:id/approve', requireCap('users.manage'), async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM user_add_requests WHERE id=$1 AND status='pending' FOR UPDATE`, [req.params.id]);
    if (!rows.length) throw new Error('request not found');
    const r = rows[0];
    const token = crypto.randomBytes(24).toString('hex');
    await c.query(`INSERT INTO invites (email, name, role, token, created_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')`,
      [r.email, r.name, r.role, token, req.user.id]);
    await c.query(`UPDATE user_add_requests SET status='approved', reviewed_by=$1, reviewed_at=now() WHERE id=$2`, [req.user.id, r.id]);
  });
  await audit(req, 'user_add_approved', 'user_add_request', req.params.id, {});
  res.redirect('/admin/users');
});

router.post('/users/requests/:id/reject', requireCap('users.manage'), async (req, res) => {
  await q(`UPDATE user_add_requests SET status='rejected', reviewed_by=$1, reviewed_at=now() WHERE id=$2 AND status='pending'`, [req.user.id, req.params.id]);
  await audit(req, 'user_add_rejected', 'user_add_request', req.params.id, {});
  res.redirect('/admin/users');
});

// سجل المراجعة
router.get('/audit', requireCap('audit.view'), async (req, res) => {
  const { entity, user_id } = req.query;
  const conds = []; const params = [];
  if (entity) { params.push(entity); conds.push(`entity=$${params.length}`); }
  if (user_id) { params.push(user_id); conds.push(`user_id=$${params.length}`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const { rows } = await q(`SELECT a.*, u.name AS uname FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.id DESC LIMIT 500`, params);
  res.render('admin/audit', { title: 'سجل المراجعة', rows });
});

// الإعدادات
router.get('/settings', requireCap('settings.manage'), async (req, res) => {
  const { rows } = await q('SELECT key, value FROM settings ORDER BY key');
  res.render('admin/settings', { title: 'الإعدادات', settings: rows, saved: req.query.saved === '1' });
});

router.post('/invoice-terms',requireCap('settings.manage'),async(req,res)=>{
 const terms=String(req.body.terms||'').trim();if(!terms||terms.length>20000)return res.status(400).render('error',{title:'بنود غير صالحة',message:'أدخل نص البنود الكامل، بحد أقصى ٢٠ ألف حرف.'});
 await tx(async c=>{await c.query("INSERT INTO settings(key,value) VALUES ('invoice_terms_version','0'::jsonb),('invoice_terms',to_jsonb(''::text)) ON CONFLICT DO NOTHING");const rows=(await c.query("SELECT key,value FROM settings WHERE key IN ('invoice_terms','invoice_terms_version') ORDER BY key FOR UPDATE")).rows;const version=Number(rows.find(r=>r.key==='invoice_terms_version').value)+1;
 await c.query("UPDATE settings SET value=to_jsonb($1::text),updated_by=$2,updated_at=now() WHERE key='invoice_terms'",[terms,req.user.id]);await c.query("UPDATE settings SET value=to_jsonb($1::int),updated_by=$2,updated_at=now() WHERE key='invoice_terms_version'",[version,req.user.id]);
 await c.query("INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,'receipt_terms_changed','settings','invoice_terms',$2)",[req.user.id,JSON.stringify({version,sha256:require('node:crypto').createHash('sha256').update(terms,'utf8').digest('hex')})]);});res.redirect('/admin/settings?saved=1');
});

router.post('/settings', requireCap('settings.manage'), async (req, res) => {
  const days = parseInt(req.body.lead_reassign_days, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return res.status(400).render('error', { title: 'قيمة غير صالحة', message: 'مدة التحويل يجب أن تكون رقمًا بين 1 و 365 يومًا.' });
  }
  await setSetting('lead_reassign_days', days, req.user.id);
  await setSetting('lead_distribution_enabled', req.body.lead_distribution_enabled === 'on', req.user.id);
  const exempt = (req.body.reassign_exempt_statuses || '').split(',').map(s => s.trim()).filter(Boolean);
  await setSetting('reassign_exempt_statuses', exempt.length ? exempt : ['closed_lost'], req.user.id);
  await setSetting('nearly_full_threshold', Math.max(1, parseInt(req.body.nearly_full_threshold || '3', 10)), req.user.id);
  await setSetting('academy_phone', req.body.academy_phone || '', req.user.id);
  await audit(req, 'settings_updated', 'settings', null, { lead_reassign_days: days });
  res.redirect('/admin/settings?saved=1');
});

// ---------- النسخ الاحتياطي (مدير النظام فقط) ----------
router.get('/backup', requireCap('backups.manage'), async (req, res) => {
  let backups = [];
  try {
    backups = (await q('SELECT * FROM backup_log ORDER BY created_at DESC LIMIT 20')).rows;
  } catch (e) { /* الجدول قد لا يكون وُجد بعد */ }
  res.render('admin/backup', {
    title: 'النسخ الاحتياطي', nav: 'backup', backups,
    ghConfigured: !!process.env.BACKUP_GH_TOKEN,
    triggered: req.query.triggered === '1', err: req.query.err || null
  });
});

router.post('/backup/run', requireCap('backups.manage'), async (req, res) => {
  const token = process.env.BACKUP_GH_TOKEN;
  if (!token) return res.redirect('/admin/backup?err=not_configured');
  try {
    const r = await fetch('https://api.github.com/repos/kayan-academy-sys/kayan-backups/actions/workflows/backup.yml/dispatches', {
      method: 'POST',
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'kayan-app'
      },
      body: JSON.stringify({ ref: 'main' })
    });
    if (!r.ok) throw new Error('github ' + r.status);
    await audit(req, 'backup.manual_trigger', 'backup', null, {});
    res.redirect('/admin/backup?triggered=1');
  } catch (e) {
    res.redirect('/admin/backup?err=dispatch_failed');
  }
});

// تنزيل نسخة كاملة من كل البيانات بصيغة JSON (نسخة يدوية يحتفظ بها المدير)
router.get('/backup/download', requireCap('backups.manage'), async (req, res) => {
  const tables = (await q(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
  )).rows.map(r => r.table_name).filter(t => t !== '_migrations');
  const out = { app: 'kayan-system', format: 'json-export-v1', generated_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const ident = '"' + t.replace(/"/g, '""') + '"';
    out.tables[t] = (await q(`SELECT row_to_json(x) AS j FROM ${ident} x`)).rows.map(r => r.j);
  }
  await audit(req, 'backup.download', 'backup', null, { tables: tables.length });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kayan-backup-${stamp}.json"`);
  res.send(JSON.stringify(out));
});

module.exports = router;
