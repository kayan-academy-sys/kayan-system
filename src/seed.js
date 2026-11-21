// إنشاء مدير النظام الأصلي عند أول تشغيل فقط
const bcrypt = require('bcryptjs');
const config = require('./config');
const { migrate } = require('./migrate');
const { q, pool } = require('./db');

async function seedAdmin() {
  await migrate();
  const email = config.adminEmail.toLowerCase();
  const { rows } = await q('SELECT id FROM users WHERE email=$1', [email]);
  if (rows.length) { console.log('admin exists:', email); return; }
  const hash = await bcrypt.hash(config.adminPassword, 12);
  await q(`INSERT INTO users (name, email, password_hash, role) VALUES ('مدير النظام', $1, $2, 'admin')`, [email, hash]);
  console.log('admin created:', email);
}

async function seedDemo() {
  // بيانات تجريبية لاختبار النظام قبل التشغيل الفعلي
  const { rows: c } = await q('SELECT id FROM courses ORDER BY id');
  const { rows: admin } = await q(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  const adminId = admin[0] && admin[0].id;
  const { rows: haveCust } = await q('SELECT id FROM customers LIMIT 1');
  if (haveCust.length) { console.log('demo data exists, skipping'); return; }
  const hash = await bcrypt.hash('staff123456', 12);
  const staff = {};
  for (const [name, email, role] of [
    ['أحمد مدير المبيعات', 'sales.manager@kayan.local', 'sales_manager'],
    ['سارة تيم ليدر', 'team.leader@kayan.local', 'sales_team_leader'],
    ['محمد مبيعات ١', 'sales1@kayan.local', 'sales_staff'],
    ['منى مبيعات ٢', 'sales2@kayan.local', 'sales_staff'],
    ['خالد مدير الحسابات', 'acc.manager@kayan.local', 'accounting_manager'],
    ['هبة حسابات', 'acc1@kayan.local', 'accounting_staff'],
    ['ريم استقبال', 'reception@kayan.local', 'reception'],
    ['عمر مسؤول الكورسات', 'courses@kayan.local', 'course_manager'],
    ['ليلى المشرف العام', 'supervisor@kayan.local', 'general_supervisor']
  ]) {
    const r = await q('INSERT INTO users (name,email,password_hash,role,invited_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING RETURNING id', [name, email, hash, role, adminId]);
    staff[email] = r.rows[0] && r.rows[0].id;
  }
  const t = await q(`INSERT INTO trainers (name, phone, specialties) VALUES ('كابتن مصطفى','01000000001','جرافيك ديزاين'),('أ. نورهان','01000000002','تسويق رقمي'),('أ. كريم','01000000003','مونتاج وتصوير') RETURNING id`);
  const g1 = await q(`INSERT INTO groups (course_id, trainer_id, name, start_date, end_date, capacity, days_of_week, time_from, time_to, status) VALUES ($1,$2,'GRP-DM-01', current_date + 7, current_date + 67, 20, 'sat,tue','18:00','20:00','open') RETURNING id`, [c[0].id, t.rows[1].id]);
  const g2 = await q(`INSERT INTO groups (course_id, trainer_id, name, start_date, end_date, capacity, days_of_week, time_from, time_to, status) VALUES ($1,$2,'GRP-GD-01', current_date + 3, current_date + 45, 15, 'sun,wed','17:00','19:00','open') RETURNING id`, [c[1].id, t.rows[0].id]);
  for (let i = 0; i < 6; i++) {
    await q(`INSERT INTO sessions (group_id, session_date, start_time, end_time, topic) VALUES ($1, current_date + 7 + $2 * 3, '18:00','20:00', $3)`, [g1.rows[0].id, i, 'محاضرة ' + (i + 1)]);
  }
  const p = await q(`INSERT INTO packages (name, description, price, terms) VALUES ('باقة التسويق + الجرافيك','كورسان بسعر مخفض', 9000, 'صالحة ٣ أشهر') RETURNING id`);
  await q('INSERT INTO package_courses (package_id, course_id) VALUES ($1,$2),($1,$3)', [p.rows[0].id, c[0].id, c[1].id]);
  const cust = await q(`INSERT INTO customers (name, phone, created_by) VALUES ('عميل تجريبي أول','01011111111',$1),('عميل تجريبي ثانٍ','01022222222',$1),('عميلة تجريبية ثالثة','01033333333',$1) RETURNING id`, [adminId]);
  const salesIds = [staff['sales1@kayan.local'], staff['sales2@kayan.local']].filter(Boolean);
  for (let i = 0; i < cust.rows.length; i++) {
    await q(`INSERT INTO leads (customer_id, course_id, source, status, assigned_to, assigned_at) VALUES ($1,$2,$3,'new',$4, now())`,
      [cust.rows[i].id, c[i % c.length].id, ['whatsapp','facebook','manual'][i], salesIds[i % salesIds.length] || null]);
  }
  console.log('demo data seeded');
}

if (require.main === module) {
  (async () => {
    await seedAdmin();
    if (process.argv.includes('--demo')) await seedDemo();
    await pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { seedAdmin, seedDemo };
