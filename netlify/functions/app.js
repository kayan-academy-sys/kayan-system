// Netlify serverless entry: wraps the same Express app (no route changes).
process.env.RUN_CRON = 'false'; // scheduler never runs inside a function; external cron hits /cron/run
process.env.NODE_ENV = process.env.NODE_ENV || 'production'; // set in code: marking it a secret env var trips Netlify's secret scanner (the word appears in source)
const crypto = require('crypto');
const serverless = require('serverless-http');
const app = require('../../src/app');
const { q } = require('../../src/db');

// ---------------------------------------------------------------------------
// Preview gate (form-based, fail-closed).
//
// This wrapper is only used by the Netlify preview deployment. Because the
// preview project's Netlify visibility is PUBLIC, this gate is the only thing
// in front of the app: every dynamic route (pages, API, backup export, cron)
// is proxied through this function by netlify.toml's catch-all redirect, so
// every one of them is gated here. Static files under /static/* are served by
// Netlify's CDN directly and are NOT gated - they contain only branding
// assets (css/icons/logo/manifest/service worker), no data.
//
// Fail-closed: if PREVIEW_GATE_PASS is not set, every request is refused.
//
// Throttling: DB-backed (login_attempts table, same atomic upsert as the app
// login limiter) so it is consistent across serverless instances. Two buckets:
//   - per client IP: 10 attempts / 10 min. The IP comes ONLY from the
//     X-Nf-Client-Connection-Ip header, which Netlify's edge sets (Netlify
//     support: "we make no guarantees on anything except
//     X-Nf-Client-Connection-Ip"). X-Forwarded-For is never read here.
//   - global backstop: 30 attempts / 10 min across all clients, so even a
//     hypothetical IP-spoofing or IP-rotating attacker stays capped.
// ---------------------------------------------------------------------------

const GATE_PASS = process.env.PREVIEW_GATE_PASS || '';
const COOKIE_NAME = 'kayan_gate';
const MAX_AGE_S = 12 * 3600;

function sign(ts) {
  return crypto.createHmac('sha256', GATE_PASS).update('kayan-gate-v1.' + ts).digest('hex');
}

function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '';
}

function clientIp(event) {
  return header(event, 'x-nf-client-connection-ip') || 'unknown';
}

function cookieOk(event) {
  const raw = header(event, 'cookie');
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
  const b = crypto.createHash('sha256').update(GATE_PASS).digest();
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

function gateForm(error, next) {
  const err = error ? '<div class="err">' + error + '</div>' : '';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: htmlPage('نسخة كيان التجريبية',
      '<h1>نظام كيان - نسخة تجريبية</h1><p>هذه نسخة معاينة خاصة. أدخل كلمة مرور المعاينة للمتابعة.</p>' + err +
      '<form method="POST" action="/gate">' +
      '<input type="hidden" name="next" value="' + next.replace(/"/g, '&quot;') + '">' +
      '<input type="password" name="password" autocomplete="current-password" placeholder="كلمة مرور المعاينة" required autofocus>' +
      '<button type="submit">دخول</button></form>')
  };
}

function refuse(statusCode, title, msg) {
  return { statusCode, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: htmlPage(title, '<h1>' + title + '</h1><p>' + msg + '</p>') };
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && next.indexOf('\\') === -1 ? next : '/';
}

async function gate(event) {
  if (!GATE_PASS) {
    return refuse(503, 'المعاينة غير مهيأة', 'بوابة المعاينة غير مضبوطة حاليًا. تواصل مع مدير النظام.');
  }

  const path = event.rawUrl ? new URL(event.rawUrl).pathname : (event.path || '/');

  if (path === '/gate') {
    if (event.httpMethod === 'GET') {
      const next = event.queryStringParameters ? safeNext(event.queryStringParameters.next || '/') : '/';
      return gateForm('', next);
    }
    if (event.httpMethod === 'POST') {
      const ip = clientIp(event);
      try {
        if (await throttle('gate|' + ip, 10) || await throttle('gate|ALL', 30)) {
          return refuse(429, 'محاولات كثيرة', 'تم تجاوز عدد المحاولات المسموح. انتظر 10 دقائق وحاول مجددًا.');
        }
      } catch (e) {
        return refuse(503, 'خطأ مؤقت', 'تعذر التحقق الآن. حاول بعد قليل.');
      }
      let params;
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
        params = new URLSearchParams(raw);
      } catch (e) { params = new URLSearchParams(); }
      if (passOk(params.get('password'))) {
        const ts = String(Date.now());
        return {
          statusCode: 303,
          headers: {
            'Location': safeNext(params.get('next') || '/'),
            'Set-Cookie': COOKIE_NAME + '=' + encodeURIComponent(ts + '.' + sign(ts)) +
              '; Path=/; Max-Age=' + MAX_AGE_S + '; HttpOnly; Secure; SameSite=Lax',
            'Cache-Control': 'no-store'
          },
          body: ''
        };
      }
      return gateForm('كلمة المرور غير صحيحة.', safeNext(params.get('next') || '/'));
    }
    return refuse(405, 'طريقة غير مسموحة', '');
  }

  if (cookieOk(event)) return null; // pass through to the app

  if (event.httpMethod === 'GET' || event.httpMethod === 'HEAD') {
    return { statusCode: 303, headers: { 'Location': '/gate?next=' + encodeURIComponent(path), 'Cache-Control': 'no-store' }, body: '' };
  }
  return refuse(401, 'معاينة محمية', 'انتهت جلسة المعاينة. أعد الدخول من صفحة البوابة.');
}

const handler = serverless(app);
module.exports.handler = async (event, context) => {
  const blocked = await gate(event);
  if (blocked) return blocked;
  return handler(event, context);
};
