// نظام كيان - Service Worker
// يجعل التطبيق قابلاً للتثبيت (PWA) ويخزن الملفات الثابتة فقط لتسريع الفتح.
// لا يخزن أي صفحات أو بيانات خاصة بالمستخدمين.
const STATIC_CACHE = 'kayan-static-v1';
const STATIC_RE = /^\/static\//;

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // الملفات الثابتة فقط: كاش أولاً ثم الشبكة
  if (STATIC_RE.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }))
    );
  }
  // كل ما عدا ذلك (الصفحات، البيانات، تسجيل الدخول): الشبكة مباشرة دون تخزين
});
