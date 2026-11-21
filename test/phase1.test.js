// المرحلة 1: الدخول، الدعوات، الصلاحيات، سجل المراجعة
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { q, pool, migrate, resetDb, seedUsers, loginAgent, supertest, app } = require('./helpers');

let users;
before(async () => { await migrate(); await resetDb(); users = await seedUsers(); });
after(async () => { await pool.end(); });

test('login works and wrong password rejected', async () => {
  const badAgent = supertest.agent(app);
  const page = await badAgent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const bad = await badAgent.post('/login').type('form').send({ _csrf: csrf, email: 'admin@test', password: 'wrong', next: '/' });
  assert.equal(bad.status, 401);
  const agent = supertest.agent(app);
  const p2 = await agent.get('/login');
  const csrf2 = /name="_csrf" value="([^"]+)"/.exec(p2.text)[1];
  const ok = await agent.post('/login').type('form').send({ _csrf: csrf2, email: 'admin@test', password: 'pass12345', next: '/' });
  assert.equal(ok.status, 302);
  const dash = await agent.get('/');
  assert.equal(dash.status, 200);
});

test('invite flow creates user; admin-only user management; supervisor request flow', async () => {
  const { agent: admin, withCsrf: adminPost } = await loginAgent('admin@test');
  const res = await adminPost('post', '/admin/users/invite', { name: 'موظف جديد', email: 'new@test', role: 'sales_staff' });
  assert.equal(res.status, 200);
  const link = /\/invite\/([a-f0-9]{48})/.exec(res.text);
  assert.ok(link, 'invite link rendered');
  const token = link[1];
  const invitee = supertest.agent(app);
  const page = await invitee.get('/invite/' + token);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const acc = await invitee.post('/invite/' + token).type('form').send({ _csrf: csrf, password: 'secret123', password2: 'secret123' });
  assert.equal(acc.status, 302);
  const dash = await invitee.get('/');
  assert.equal(dash.status, 200);
  // الموظف الجديد لا يصل لإدارة المستخدمين
  const forbidden = await invitee.get('/admin/users');
  assert.equal(forbidden.status, 403);
  // المشرف العام يقدم طلبًا فقط
  const { withCsrf: gsPost } = await loginAgent('gs@test');
  const reqRes = await gsPost('post', '/admin/users/request', { name: 'طلب مشرف', email: 'req@test', role: 'reception' });
  assert.equal(reqRes.status, 302);
  const pending = await q(`SELECT * FROM user_add_requests WHERE email='req@test'`);
  assert.equal(pending.rowCount, 1);
  const approve = await adminPost('post', '/admin/users/requests/' + pending.rows[0].id + '/approve', {});
  assert.equal(approve.status, 302);
  const invite = await q(`SELECT * FROM invites WHERE email='req@test'`);
  assert.equal(invite.rowCount, 1);
  // لا يمكن تعطيل المدير الأصلي
  const toggleAdmin = await adminPost('post', '/admin/users/' + users.admin + '/toggle', {});
  assert.equal(toggleAdmin.status, 403);
});

test('CSRF blocks tokenless POST; audit log records sensitive ops', async () => {
  const { agent } = await loginAgent('admin@test');
  const res = await agent.post('/admin/users/invite').type('form').send({ name: 'x', email: 'x@x', role: 'sales_staff' });
  assert.equal(res.status, 403);
  const audit = await q(`SELECT count(*) AS n FROM audit_log WHERE action IN ('login','invite_created','invite_accepted','user_add_approved')`);
  assert.ok(parseInt(audit.rows[0].n, 10) >= 3);
});
