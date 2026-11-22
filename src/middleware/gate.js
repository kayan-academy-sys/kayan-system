// بوابة المعاينة (preview gate) - نسخة الخادم طويل التشغيل (Railway/Render).
//
// تُفعَّل فقط عندما PREVIEW_GATE_REQUIRED=1 (وضع معاينة صريح).
// - الوضع غير مطلوب (الإنتاج على Render): لا شيء يتغير إطلاقًا - middleware لا-op.
// - الوضع مطلوب والسر غير مضبوط: fail-closed - رفض كل الطلبات بـ 503.
//   (تفعيل مشروط بوجود السر وحده كان سيكون fail-OPEN عند غيابه - لذلك العَلَم صريح.)
//
// التغطية: كل المسارات عدا /static/* (هوية بصرية فقط، بلا بيانات) - نفس وضع Netlify.
// التقييد: نفس سياسة البوابة على Netlify - لكل IP ‏10/10د + سقف عام 30/10د،
// مخزنة في login_attempts (upsert ذري، يعمل عبر النسخ). IP العميل:
// X-Nf-Client-Connection-Ip عند وجوده (حافة Netlify)، وإلا req.ip
// (على Railway/Render قد يكون قابلًا للتزوير عبر X-Forwarded-For - يعوّضه السقف العام).
const crypto = require('crypto');
const { q } = require('../db');

const COOKIE_NAME = 'kayan_gate';
const MAX_AGE_S = 12 * 3600;

function gatePass() { return process.env.PREVIEW_GATE_PASS || ''; }
function sign(ts) {
  return crypto.createHmac('sha256', gatePass()).update('kayan-gate-v1.' + ts).digest('hex');
}
function clientIp(req) {
  return req.get('x-nf-client-connection-ip') || req.ip || 'unknown';
}
function cookieOk(req) {
  const raw = req.get('cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  if (!m) return false;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return false;
  if (Math.abs(Date.now() - Number(parts[0])) > MAX_AGE_S * 1000) return false;
  const a = Buffer.from(parts[1] || '');
  const b = Buffer.from(sign(parts[0]));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function passOk(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const b = crypto.createHash('sha256').update(gatePass()).digest();
  return crypto.timingSafeEqual(a, b);
}
async function throttle(key, max) {
  const { rows } = await q(
    `INSERT INTO login_attempts (key, count, reset_at)
     VALUES ($1, 1, now() + interval '10 minutes')
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.reset_at < now() THEN 1 ELSE login_attempts.count + 1 END,
       reset_at = CASE WHEN login_attempts.reset_at < now() THEN now() + interval '10 minutes' ELSE login_attempts.reset_at END
     RETURNING count`, [key]);
  return rows[0].count > max;
}
function htmlPage(title, body) {
  return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + '</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f6;font-family:Tahoma,Arial,sans-serif;direction:rtl}' +
    '.card{background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:28px 24px;width:min(92vw,360px);text-align:center}' +
    'h1{font-size:19px;color:#0f5e5c;margin:0 0 6px}p{color:#666;font-size:13px;margin:0 0 16px}' +
    'input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccd;border-radius:9px;font-size:16px;text-align:center;margin-bottom:12px}' +
    'button{width:100%;padding:12px;border:0;border-radius:9px;background:#0f5e5c;color:#fff;font-size:16px;cursor:pointer}' +
    '.err{color:#b3261e;font-size:13px;margin:-6px 0 10px}' +
    '</style></head><body><div class="card">' + body + '</div></body></html>';
}
function gateForm(res, error, next) {
  const err = error ? '<div class="err">' + error + '</div>' : '';
  res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .send(htmlPage('نسخة كيان التجريبية',
      '<h1>نظام كيان - نسخة تجريبية</h1><p>هذه نسخة معاينة خاصة. أدخل كلمة مرور المعاينة للمتابعة.</p>' + err +
      '<form method="POST" action="/gate">' +
      '<input type="hidden" name="next" value="' + next.replace(/"/g, '&quot;') + '">' +
      '<input type="password" name="password" autocomplete="current-password" placeholder="كلمة مرور المعاينة" required autofocus>' +
      '<button type="submit">دخول</button></form>'));
}
function refuse(res, status, title, msg) {
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .send(htmlPage(title, '<h1>' + title + '</h1><p>' + msg + '</p>'));
}
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && next.indexOf('\\') === -1 ? next : '/';
}

module.exports = async function previewGate(req, res, next) {
  if (process.env.PREVIEW_GATE_REQUIRED !== '1') return next(); // غير مفعّلة: لا تغيير إطلاقًا

  if (!gatePass()) {
    return refuse(res, 503, 'المعاينة غير مهيأة', 'بوابة المعاينة غير مضبوطة حاليًا. تواصل مع مدير النظام.'); // fail-closed
  }

  if (req.path === '/gate') {
    if (req.method === 'GET') return gateForm(res, '', safeNext(req.query.next || '/'));
    if (req.method === 'POST') {
      const ip = clientIp(req);
      try {
        if (await throttle('gate|' + ip, 10) || await throttle('gate|ALL', 30)) {
          return refuse(res, 429, 'محاولات كثيرة', 'تم تجاوز عدد المحاولات المسموح. انتظر 10 دقائق وحاول مجددًا.');
        }
      } catch (e) {
        return refuse(res, 503, 'خطأ مؤقت', 'تعذر التحقق الآن. حاول بعد قليل.');
      }
      if (passOk(req.body && req.body.password)) {
        const ts = String(Date.now());
        res.cookie(COOKIE_NAME, ts + '.' + sign(ts), {
          path: '/', maxAge: MAX_AGE_S * 1000, httpOnly: true, secure: true, sameSite: 'lax'
        });
        return res.redirect(303, safeNext(req.body.next || '/'));
      }
      return gateForm(res, 'كلمة المرور غير صحيحة.', safeNext((req.body && req.body.next) || '/'));
    }
    return refuse(res, 405, 'طريقة غير مسموحة', '');
  }

  if (cookieOk(req)) return next(); // مسموح: يكمل للتطبيق
  if (req.path.startsWith('/static/') || req.path === '/sw.js' || req.path === '/manifest.webmanifest') {
    return next(); // هوية بصرية وملفات PWA فقط، بلا بيانات - نفس وضع معاينة Netlify
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(303, '/gate?next=' + encodeURIComponent(req.path));
  }
  return refuse(res, 401, 'معاينة محمية', 'انتهت جلسة المعاينة. أعد الدخول من صفحة البوابة.');
};
