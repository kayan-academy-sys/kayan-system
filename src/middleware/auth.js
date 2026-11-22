const crypto = require('crypto');
const { q } = require('../db');
const { can } = require('../lib/permissions');

// تحميل المستخدم من الجلسة
async function loadUser(req, res, next) {
  res.locals.user = null;
  req.user = null;
  const uid = req.session && req.session.userId;
  if (uid) {
    const { rows } = await q('SELECT id, name, email, role, active FROM users WHERE id=$1', [uid]);
    if (rows.length && rows[0].active) {
      req.user = rows[0];
      res.locals.user = rows[0];
      res.locals.can = (cap) => can(rows[0].role, cap);
    } else {
      req.session = null;
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
    if (caps.some(c => can(req.user.role, c))) return next();
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
const attempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip + '|' + (req.body.email || '');
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 10 * 60 * 1000; }
  if (rec.count >= 10) {
    return res.status(429).render('error', { title: 'محاولات كثيرة', message: 'تم تجاوز عدد محاولات الدخول المسموح. انتظر 10 دقائق وحاول مجددًا.' });
  }
  rec.count++;
  attempts.set(key, rec);
  next();
}

module.exports = { loadUser, requireAuth, requireCap, csrfCheck, loginRateLimit };
