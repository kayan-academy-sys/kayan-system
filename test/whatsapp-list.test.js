// اختبارات مصدر الأرقام المعتمد: بيانات اصطناعية فقط
process.env.META_VERIFY_TOKEN = 'test-verify-token';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_NUMBER_SOURCES = '+20 100 000 0001';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const supertest = require('supertest');
const { migrate } = require('../src/migrate');
const { q, pool } = require('../src/db');
const { extractEgyptianMobiles } = require('../src/lib/phone-extract');
process.env.RUN_CRON = 'false';
const app = require('../src/app');
const agent = supertest.agent(app);
let n = 0;
function msg(from, body, extra = {}) {
  return { from, id: 'wamid.LIST-' + (++n), timestamp: '1763000000', type: 'text', text: { body }, ...extra };
}
async function post(messages) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: 'P' }, contacts: [], messages } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
  return agent.post('/api/webhooks/meta').set('x-hub-signature-256', sig).set('content-type', 'application/json').send(raw);
}
test.before(async () => {
  await migrate();
  await q('TRUNCATE processed_meta_messages, lead_activities, lead_assignments, leads, customers RESTART IDENTITY CASCADE');
});
test.after(() => pool.end());

test('parser: أرقام عربية وفارسية وصيغ دولية', () => {
  assert.deepEqual(extractEgyptianMobiles('٠١٠٠٠٠٠٠٠٠٢ و ۰۱۱۰۰۰۰۰۰۰۳').numbers, ['01000000002', '01100000003']);
  assert.deepEqual(extractEgyptianMobiles('+20 100 000 0004').numbers, ['01000000004']);
  assert.deepEqual(extractEgyptianMobiles('0020-122-000-0005').numbers, ['01220000005']);
  assert.deepEqual(extractEgyptianMobiles('201500000006').numbers, ['01500000006']);
  assert.deepEqual(extractEgyptianMobiles('(0100) 000-0007\n01000000008, 01000000009').numbers, ['01000000007', '01000000008', '01000000009']);
});
test('parser: لا تخمين: خط أرضي/أجنبي/ناقص/بلا صفر، وتكرار داخل الرسالة', () => {
  const r = extractEgyptianMobiles('02 2345 6789 | 01312345678 | 1000000010 | +14155550100 | 01000000011 01000000011');
  assert.deepEqual(r.numbers, ['01000000011']);
  assert.ok(r.skipped >= 3);
  assert.deepEqual(extractEgyptianMobiles('مرحبا بدون أرقام').numbers, []);
});
test('مصدر معتمد: ينشئ عملاء من الأرقام داخل النص، والمرسل نفسه لا يصبح عميلًا', async () => {
  const r = await post([msg('201000000001', 'العملاء:\n٠١٠٠٠٠٠٠٠٢٠\n+20 111 000 0021')]);
  assert.equal(r.status, 200);
  assert.equal(r.body.leadsCreated, 2); assert.equal(r.body.numbersFound, 2);
  const c = await q('SELECT phone FROM customers ORDER BY phone');
  assert.deepEqual(c.rows.map(x => x.phone), ['01000000020', '01110000021']);
  const l = await q("SELECT source FROM leads");
  assert.ok(l.rows.every(x => x.source === 'whatsapp'));
});
test('مرسل غير معتمد يُتجاهل تمامًا', async () => {
  const before = (await q('SELECT count(*)::int n FROM customers')).rows[0].n;
  const r = await post([msg('201000000099', 'رقمي 01000000030')]);
  assert.equal(r.body.leadsCreated, 0); assert.equal(r.body.ignored, 1);
  assert.equal((await q('SELECT count(*)::int n FROM customers')).rows[0].n, before);
});
test('إعادة إرسال نفس الرسالة لا تكرر', async () => {
  const m = msg('201000000001', '01000000040');
  assert.equal((await post([m])).body.leadsCreated, 1);
  const again = await post([m]);
  assert.equal(again.body.leadsCreated, 0); assert.equal(again.body.duplicates, 1);
  assert.equal((await q("SELECT count(*)::int n FROM customers WHERE phone='01000000040'")).rows[0].n, 1);
});
test('نفس الرقم في رسالة جديدة أو بصيغة مختلفة: لا عميل ولا lead ثاني طالما فيه lead مفتوح', async () => {
  const r = await post([msg('201000000001', '+201000000040'), msg('201000000001', '٠١٠٠٠٠٠٠٠٤٠')]);
  assert.equal(r.body.leadsCreated, 0); assert.equal(r.body.duplicates, 2);
  assert.equal((await q('SELECT count(*)::int n FROM leads l JOIN customers c ON c.id=l.customer_id WHERE c.phone IN (\'01000000040\',\'201000000040\',\'+201000000040\')')).rows[0].n, 1);
});
test('عميل موجود بصيغة 20... من مسار قديم: يُعاد استخدامه بدون صف عميل جديد', async () => {
  await q("INSERT INTO customers(name,phone) VALUES('قديم','201000000050')");
  const r = await post([msg('201000000001', '01000000050')]);
  assert.equal(r.body.leadsCreated, 1);
  assert.equal((await q("SELECT count(*)::int n FROM customers WHERE phone LIKE '%1000000050'")).rows[0].n, 1);
});
test('رسائل غير نصية أو بلا أرقام: لا شيء ينشأ', async () => {
  const before = (await q('SELECT count(*)::int n FROM leads')).rows[0].n;
  const r = await post([msg('201000000001', null, { type: 'image', text: undefined }), msg('201000000001', 'شكرًا')]);
  assert.equal(r.body.leadsCreated, 0);
  assert.equal((await q('SELECT count(*)::int n FROM leads')).rows[0].n, before);
});
test('رسالتان متزامنتان بنفس الرقم: عميل محتمل واحد فقط', async () => {
  const rs = await Promise.all([post([msg('201000000001', '01000000060')]), post([msg('201000000001', '01000000060')])]);
  assert.equal(rs.reduce((a, r) => a + r.body.leadsCreated, 0), 1);
});
test('توقيع خاطئ يرفض', async () => {
  const r = await agent.post('/api/webhooks/meta').set('x-hub-signature-256', 'sha256=00').set('content-type', 'application/json').send('{}');
  assert.equal(r.status, 401);
});
