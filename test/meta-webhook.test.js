// اختبارات جسر Meta بتركيبات اصطناعية فقط — بلا رقم حقيقي وبلا اتصال خارجي
process.env.META_VERIFY_TOKEN = 'test-verify-token';
process.env.META_APP_SECRET = 'test-app-secret';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const supertest = require('supertest');
const { migrate } = require('../src/migrate');
const { q, pool } = require('../src/db');

process.env.RUN_CRON = 'false';
const app = require('../src/app');
const agent = supertest.agent(app);

function sign(payloadObj) {
  const raw = JSON.stringify(payloadObj);
  return { raw, sig: 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex') };
}

// تركيبة رسالة واردة من Meta
function payload(overrides = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '1555000111', phone_number_id: 'PNID1' },
      contacts: [{ profile: { name: 'عميل اختبار' }, wa_id: '201001234567' }],
      messages: [{ from: '201001234567', id: 'wamid.TEST-001', timestamp: '1763000000',
        text: { body: 'عايز أعرف عن كورساتكم' }, type: 'text' }],
      ...overrides.value
    }, ...overrides.change }], ...overrides.entry }]
  };
}

test.before(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5433/kayan_test';
  await migrate();
  await q('TRUNCATE processed_meta_messages, lead_activities, lead_assignments, leads, customers RESTART IDENTITY CASCADE');
});
test.after(() => pool.end());

test('GET challenge: يرجع hub.challenge عند توكن صحيح', async () => {
  const r = await agent.get('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CH123');
  assert.equal(r.status, 200);
  assert.equal(r.text, 'CH123');
});

test('GET challenge: 403 عند توكن خاطئ', async () => {
  const r = await agent.get('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CH123');
  assert.equal(r.status, 403);
});

test('POST بتوقيع صحيح: ينشئ عميلًا محتملًا ويوزعه', async () => {
  const { raw, sig } = sign(payload({}));
  const r = await agent.post('/api/webhooks/meta').set('x-hub-signature-256', sig)
    .set('content-type', 'application/json').send(raw);
  assert.equal(r.status, 200);
  assert.equal(r.body.leadsCreated, 1);
  const leads = await q("SELECT l.*, c.name FROM leads l JOIN customers c ON c.id=l.customer_id WHERE l.source='whatsapp'");
  assert.equal(leads.rowCount, 1);
  assert.equal(leads.rows[0].name, 'عميل اختبار');
});

test('POST بتوقيع خاطئ: 401 وبلا عميل', async () => {
  const { raw } = sign(payload({ value: { messages: [{ from: '201009999999', id: 'wamid.BAD-1', type: 'text', text: { body: 'x' } }] } }));
  const r = await agent.post('/api/webhooks/meta').set('x-hub-signature-256', 'sha256=deadbeef')
    .set('content-type', 'application/json').send(raw);
  assert.equal(r.status, 401);
  const c = await q("SELECT 1 FROM customers WHERE phone='201009999999'");
  assert.equal(c.rowCount, 0);
});

test('إعادة إرسال نفس الرسالة: لا تكرار (dedupe بالمعرف)', async () => {
  const { raw, sig } = sign(payload({}));
  const r = await agent.post('/api/webhooks/meta').set('x-hub-signature-256', sig)
    .set('content-type', 'application/json').send(raw);
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicates, 1);
  assert.equal(r.body.leadsCreated, 0);
  const leads = await q("SELECT 1 FROM leads WHERE source='whatsapp'");
  assert.equal(leads.rowCount, 1); // لا يزال واحدًا فقط
});

test('ردود الحالة statuses: لا تنشئ عملاء أبدًا', async () => {
  const p = payload({ value: {
    contacts: [], messages: undefined,
    statuses: [{ id: 'wamid.TEST-001', status: 'delivered', timestamp: '1763000100', recipient_id: '201001234567' }]
  } });
  delete p.entry[0].changes[0].value.messages;
  const { raw, sig } = sign(p);
  const r = await agent.post('/api/webhooks/meta').set('x-hub-signature-256', sig)
    .set('content-type', 'application/json').send(raw);
  assert.equal(r.status, 200);
  assert.equal(r.body.leadsCreated, 0);
  const leads = await q("SELECT 1 FROM leads WHERE source='whatsapp'");
  assert.equal(leads.rowCount, 1);
});

test('محادثة رقم مختلف (phone_number_id آخر): تُتجاهل', async () => {
  process.env.META_PHONE_NUMBER_ID = 'PNID1';
  const p = payload({ value: {
    metadata: { display_phone_number: '999', phone_number_id: 'OTHER' },
    contacts: [{ profile: { name: 'شخص آخر' }, wa_id: '201112223334' }],
    messages: [{ from: '201112223334', id: 'wamid.OTHER-1', type: 'text', text: { body: 'hi' } }]
  } });
  const { raw, sig } = sign(p);
  const r = await agent.post('/api/webhooks/meta').set('x-hub-signature-256', sig)
    .set('content-type', 'application/json').send(raw);
  assert.equal(r.body.leadsCreated, 0);
  assert.ok(r.body.ignored >= 1);
  const c = await q("SELECT 1 FROM customers WHERE phone='201112223334'");
  assert.equal(c.rowCount, 0);
  delete process.env.META_PHONE_NUMBER_ID;
});
