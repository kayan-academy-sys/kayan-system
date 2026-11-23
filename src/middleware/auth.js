const crypto = require('crypto');
const { q } = require('../db');
const { can, rolesOf } = require('../lib/permissions');

// تحميل المستخدم من الجلسة
async function loadUser(req, res, next) {
  res.locals.user = null;
  req.user = null;
  const uid = req.session && req.session.userId;
  if (uid) {
    const { rows } = await q('SELECT id, name, email, role, extra_roles, active FROM users WHERE id=$1', [uid]);
    if (rows.length && rows[0].active) {
      req.user = rows[0];
      req.user.roles = rolesOf(rows[0]);
      res.locals.user = req.user;
      res.locals.can = (cap) => can(req.user.roles, cap);
    } else {
      req.session = {};
    }
  }
  // CSRF token per session
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.L = require('../lib/labels');
  // إصدار الملفات الثابتة: يُرفع مع كل تعديل على CSS/JS لكسر كاش المتصفح (كاش 7 أيام)
  res.locals.assetV = require('../config').assetVersion;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

function requireCap(...caps) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (caps.some(c => can(req.user.roles, c))) return next();
    res.status(403).render('error', { title: 'غير مسموح', message: 'ليس لديك صلاحية لتنفيذ هذه العملية.' });
  };
}

function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.body._csrf || req.get('x-csrf-token');
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('error', { title: 'خطأ أمان', message: 'رمز التحقق غير صالح. حدّث الصفحة وحاول مرة أخرى.' });
  }
  next();
}

// حد بسيط لمحاولات الدخول
// DB-backed: atomic upsert, consistent across serverless instances and restarts.
// Same policy as before: 10 attempts per 10 minutes per IP+email; the 11th is blocked.
// Client IP: on Netlify only X-Nf-Client-Connection-Ip is edge-set and trustworthy
// (Netlify support: "we make no guarantees on anything except X-Nf-Client-Connection-Ip");
// elsewhere (Render) req.ip is direct. X-Forwarded-For is never trusted here.
function clientKey(req) {
  const ip = req.get('x-nf-client-connection-ip') || req.ip || 'unknown';
  return ip + '|' + (req.body.email || '');
}
async function loginRateLimit(req, res, next) {
  try {
    const key = clientKey(req);
    const { rows } = await q(
      `INSERT INTO login_attempts (key, count, reset_at)
       VALUES ($1, 1, now() + interval '10 minutes')
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN login_attempts.reset_at < now() THEN 1 ELSE login_attempts.count + 1 END,
         reset_at = CASE WHEN login_attempts.reset_at < now() THEN now() + interval '10 minutes' ELSE login_attempts.reset_at END
       RETURNING count`, [key]);
    if (rows[0].count > 10) {
      return res.status(429).render('error', { title: 'محاولات كثيرة', message: 'تم تجاوز عدد محاولات الدخول المسموح. انتظر 10 دقائق وحاول مجددًا.' });
    }
    next();
  } catch (e) { next(e); }
}

module.exports = { loadUser, requireAuth, requireCap, csrfCheck, loginRateLimit };
