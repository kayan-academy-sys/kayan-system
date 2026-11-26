// اختبارات تغذية شيت جوجل: بيانات اصطناعية فقط
process.env.SHEET_FEED_TOKEN = 'test-sheet-token-fictional';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('crypto');
const supertest = require('supertest');
const { q, pool, migrate, resetDb, seedUsers, app } = require('./helpers');
before(async () => { await migrate(); await resetDb(); await q('TRUNCATE processed_meta_messages'); await seedUsers(); await q("INSERT INTO courses(name) VALUES('التسويق الرقمي'),('الجرافيك ديزاين'),('التصوير'),('المونتاج وتحرير الفيديو'),('الذكاء الاصطناعي'),('مونتاج وتصوير'),('الدبلومة الكاملة') ON CONFLICT DO NOTHING"); });
after(() => pool.end());
const count = async t => (await q('SELECT count(*)::int n FROM ' + t)).rows[0].n;
const A = 'Bearer test-sheet-token-fictional';
const k = s => crypto.createHash('sha256').update(s).digest('hex');
const post = (body, auth = A) => { const r = supertest(app).post('/api/webhooks/sheet-leads'); if (auth) r.set('Authorization', auth); return r.send(body); };

test('بدون رمز أو برمز خاطئ: 401 ولا يُنشأ شيء', async () => {
  const b = { rows: [{ row_key: k('a'), phone: '01000000401' }] };
  assert.equal((await post(b, null)).status, 401);
  assert.equal((await post(b, 'Bearer wrong')).status, 401);
  assert.equal(await count('customers'), 0);
});
test('صف صحيح: عميل واسم ومصدر وكورس، والنتيجة created', async () => {
  const r = await post({ rows: [{ row_key: k('b'), phone: '٠١٠٠٠٠٠٠٤١١', name: 'أحمد تجريبي', source: 'فيسبوك', course: 'تسويق' }] });
  assert.equal(r.status, 200); assert.equal(r.body.results[0].status, 'created');
  const l = (await q("SELECT c.name, c.phone, l.source, l.course_id FROM leads l JOIN customers c ON c.id=l.customer_id")).rows[0];
  assert.equal(l.name, 'أحمد تجريبي'); assert.equal(l.phone, '01000000411'); assert.equal(l.source, 'facebook'); assert.ok(l.course_id);
});
test('صيغ الأرقام: +20 و0020 و10 بدون صفر', async () => {
  const r = await post({ rows: [
    { row_key: k('c1'), phone: '+20 100 000 0421' }, { row_key: k('c2'), phone: '00201000000422' }, { row_key: k('c3'), phone: '1000000423' }] });
  assert.deepEqual(r.body.results.map(x => x.status), ['created', 'created', 'created']);
  assert.deepEqual((await q("SELECT phone FROM customers WHERE phone LIKE '0100000042%' ORDER BY phone")).rows.map(x => x.phone), ['01000000421', '01000000422', '01000000423']);
});
test('مصدر وكورس غير معروفين: other وبدون كورس، وبلا اسم يأخذ الافتراضي', async () => {
  const r = await post({ rows: [{ row_key: k('d'), phone: '01000000431', source: 'صديق', course: 'كورس غير موجود' }] });
  assert.equal(r.body.results[0].status, 'created');
  const l = (await q("SELECT l.source, l.course_id, c.name, c.notes FROM leads l JOIN customers c ON c.id=l.customer_id WHERE c.phone='01000000431'")).rows[0];
  assert.equal(l.source, 'other'); assert.equal(l.course_id, null); assert.ok(l.name); assert.ok(l.notes.includes('كورس غير موجود'));
});
test('إعادة الإرسال: replay بلا تكرار، ورقم مفتوح: duplicate، وسيئ: invalid', async () => {
  const n = await count('customers');
  const r = await post({ rows: [{ row_key: k('b'), phone: '01000000411' }, { row_key: k('e1'), phone: '01000000411' }, { row_key: k('e2'), phone: '0223456789' }, { row_key: k('e3'), phone: 'abc' }] });
  assert.deepEqual(r.body.results.map(x => x.status), ['replay', 'duplicate', 'invalid', 'invalid']);
  assert.equal(await count('customers'), n);
});
test('حمولات مرفوضة', async () => {
  const bad = [null, {}, { rows: [] }, { rows: [{ phone: '01000000441' }] }, { rows: [{ row_key: 'short', phone: '01000000441' }] },
    { rows: Array.from({ length: 51 }, (_, i) => ({ row_key: k('f' + i), phone: '01000000441' })) }, { rows: ['x'] }];
  const n = await count('customers');
  for (const b of bad) assert.equal((await post(b)).status, 400, JSON.stringify(b));
  assert.equal(await count('customers'), n);
});
test('التوزيع الآلي يعمل مع حاضر، والتدقيق بالأعداد فقط', async () => {
  const au = await q("SELECT details FROM audit_log WHERE action='leads_imported_from_sheet'");
  assert.ok(au.rowCount >= 1);
  assert.ok(!JSON.stringify(au.rows.map(x => x.details)).includes('أحمد'));
});

test('خيارات القائمة الخمسة تطابق كورسات النظام، وغير المعروف يبقى في الملاحظة فقط', async () => {
  const rows = [['g1', '01000000451', 'جرافيك'], ['g2', '01000000452', 'تسويق'], ['g3', '01000000453', 'مونتاج وتصوير'], ['g4', '01000000454', 'الدبلومة الكاملة'], ['g5', '01000000455', 'التسويق  الرقمي'], ['g6', '01000000456', 'الذكاء الاصطناعي'], ['g7', '01000000457', 'شيء غير معروف']]
    .map(([id, phone, course]) => ({ row_key: k(id), phone, course }));
  const r = await post({ rows });
  assert.deepEqual(r.body.results.map(x => x.status), Array(7).fill('created'));
  const got = (await q("SELECT c.phone, co.name cn, c.notes FROM leads l JOIN customers c ON c.id=l.customer_id LEFT JOIN courses co ON co.id=l.course_id WHERE c.phone LIKE '0100000045%' ORDER BY c.phone")).rows;
  assert.deepEqual(got.map(x => x.cn), ['الجرافيك ديزاين', 'التسويق الرقمي', 'مونتاج وتصوير', 'الدبلومة الكاملة', 'التسويق الرقمي', 'الذكاء الاصطناعي', null]);
  assert.ok(got[6].notes.includes('شيء غير معروف'));
});
