const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const { loadUser, csrfCheck } = require('./middleware/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieSession({
  name: 'kayan_sid',
  keys: [config.sessionSecret],
  maxAge: 12 * 60 * 60 * 1000, // 12 ساعة
  httpOnly: true,
  sameSite: 'lax',
  secure: config.env === 'production'
}));

// ترويسات أمان
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// ملفات PWA في الجذر: الـ Service Worker يحتاج نطاق / ليعمل على كل الصفحات
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => res.redirect('/static/manifest.webmanifest'));
// ربط تطبيق أندرويد (TWA) بالنطاق حتى يفتح بملء الشاشة بدون شريط المتصفح
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json').sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});
app.use(loadUser);

// Webhook واتساب ونقطة cron لا يحتاجان CSRF (محميان بأسرار خاصة)
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/cron', require('./routes/cron'));

app.use(csrfCheck);
if(process.env.LOCAL_BACKUP_ENABLED==='true')app.use('/local-backup',require('./routes/local-backup')({pool:require('./db').pool,q:require('./db').q}));

app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/dashboard'));
app.use('/leads', require('./routes/leads'));
app.use('/customers', require('./routes/customers'));
app.use('/courses', require('./routes/courses'));
app.use('/trainers', require('./routes/trainers'));
app.use('/groups', require('./routes/groups'));
app.use('/sessions', require('./routes/sessions'));
app.use('/packages', require('./routes/packages'));
app.use('/orders', require('./routes/orders'));
app.use('/accounting/trainers', require('./routes/trainer-accounts'));
app.use('/accounting', require('./routes/accounting'));
const commissionsRoutes = require('./routes/commissions');
app.use('/accounting/commissions', commissionsRoutes.accounting);
app.use('/commissions', commissionsRoutes.my);
app.use('/leaderboard', commissionsRoutes.leaderboard);
app.use('/reception', require('./routes/reception'));
app.use('/reports', require('./routes/reports'));
app.use('/automation', require('./routes/automation'));
app.use('/assistant', require('./routes/assistant'));

// إشعارات المستخدم
app.use('/notifications', require('./routes/notifications'));

app.use((req, res) => res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة المطلوبة غير موجودة.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'خطأ', message: 'حدث خطأ غير متوقع. تم تسجيله.' });
});

module.exports = app;
