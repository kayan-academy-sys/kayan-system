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
  res.render('admin/users', { title: 'المستخدمون', users, invites, requests, roles: ROLES, assignableRoles: ASSIGNABLE_ROLES, inviteLink: null, canManage: can(req.user.role, 'users.manage') });
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

module.exports = router;
