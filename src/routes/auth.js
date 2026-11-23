const express = require('express');
const bcrypt = require('bcryptjs');
const { q } = require('../db');
const { audit } = require('../lib/audit');
const { loginRateLimit } = require('../middleware/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'تسجيل الدخول', error: null, next: req.query.next || '/' });
});

router.post('/login', loginRateLimit, async (req, res) => {
  const { email, password, next } = req.body;
  const { rows } = await q('SELECT * FROM users WHERE email=$1', [(email || '').trim().toLowerCase()]);
  const user = rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password || '', user.password_hash))) {
    await audit(req, 'login_failed', 'user', user ? user.id : null, { email });
    return res.status(401).render('login', { title: 'تسجيل الدخول', error: 'بيانات الدخول غير صحيحة.', next: next || '/' });
  }
  req.session.userId = user.id;
  await q('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  await audit(req, 'login', 'user', user.id, {});
  res.redirect(next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/');
});

router.post('/logout', async (req, res) => {
  if (req.user) await audit(req, 'logout', 'user', req.user.id, {});
  req.session = null;
  res.redirect('/login');
});

// قبول الدعوة وتعيين كلمة المرور
router.get('/invite/:token', async (req, res) => {
  const { rows } = await q(`SELECT * FROM invites WHERE token=$1 AND status='pending' AND expires_at > now()`, [req.params.token]);
  if (!rows.length) return res.status(410).render('error', { title: 'دعوة غير صالحة', message: 'رابط الدعوة غير صالح أو منتهي. اطلب دعوة جديدة من مدير النظام.' });
  res.render('invite', { title: 'قبول الدعوة', invite: rows[0], error: null });
});

router.post('/invite/:token', async (req, res) => {
  const { rows } = await q(`SELECT * FROM invites WHERE token=$1 AND status='pending' AND expires_at > now()`, [req.params.token]);
  const invite = rows[0];
  if (!invite) return res.status(410).render('error', { title: 'دعوة غير صالحة', message: 'رابط الدعوة غير صالح أو منتهي.' });
  const { password, password2 } = req.body;
  if (!password || password.length < 8 || password !== password2) {
    return res.status(400).render('invite', { title: 'قبول الدعوة', invite, error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل ومتطابقة في الحقلين.' });
  }
  const hash = await bcrypt.hash(password, 12);
  const existing = await q('SELECT id FROM users WHERE email=$1', [invite.email.toLowerCase()]);
  if (existing.rowCount) return res.status(409).render('error', { title: 'حساب موجود', message: 'يوجد حساب بهذا البريد بالفعل. سجّل الدخول مباشرة.' });
  const ins = await q(
    'INSERT INTO users (name, email, password_hash, role, invited_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [invite.name, invite.email.toLowerCase(), hash, invite.role, invite.created_by]
  );
  await q(`UPDATE invites SET status='accepted', accepted_at=now() WHERE id=$1`, [invite.id]);
  req.user = { id: ins.rows[0].id, name: invite.name };
  await audit(req, 'invite_accepted', 'user', ins.rows[0].id, { email: invite.email, role: invite.role });
  req.session.userId = ins.rows[0].id;
  res.redirect('/');
});

module.exports = router;
