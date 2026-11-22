process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5433/kayan_test';
process.env.SESSION_SECRET = 'test-secret';
process.env.RUN_CRON = 'false';
process.env.CRON_SECRET = 'test-cron';
process.env.WHATSAPP_WEBHOOK_SECRET = 'test-wa';

const { migrate } = require('../src/migrate');
const { q, pool } = require('../src/db');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const supertest = require('supertest');

async function resetDb() {
  await q(`TRUNCATE commission_months, trainer_payments, trainer_group_terms, attendance, payments, installments, installment_plans, transfers, expenses, enrollments, sales_orders,
    login_attempts,
    package_courses, packages, sessions, groups, trainers, lead_activities, lead_assignments, staff_presence, leads,
    customers, notifications, job_runs, user_add_requests, invites, audit_log, users RESTART IDENTITY CASCADE`);
}

async function seedUsers() {
  const hash = await bcrypt.hash('pass12345', 4);
  const mk = async (name, email, role) => (await q('INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id', [name, email, hash, role])).rows[0].id;
  return {
    admin: await mk('المدير', 'admin@test', 'admin'),
    salesManager: await mk('مدير مبيعات', 'sm@test', 'sales_manager'),
    teamLeader: await mk('تيم ليدر', 'tl@test', 'sales_team_leader'),
    sales1: await mk('مبيعات ١', 's1@test', 'sales_staff'),
    sales2: await mk('مبيعات ٢', 's2@test', 'sales_staff'),
    accManager: await mk('مدير حسابات', 'am@test', 'accounting_manager'),
    accStaff: await mk('حسابات', 'as@test', 'accounting_staff'),
    reception: await mk('استقبال', 'rc@test', 'reception'),
    courseManager: await mk('كورسات', 'cm@test', 'course_manager'),
    supervisor: await mk('مشرف عام', 'gs@test', 'general_supervisor')
  };
}

async function loginAgent(email) {
  const agent = supertest.agent(app);
  const page = await agent.get('/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  await agent.post('/login').type('form').send({ _csrf: csrf, email, password: 'pass12345', next: '/' });
  const withCsrf = async (method, path, body) => {
    const p = await agent.get('/'); // نفس الجلسة، نفس الرمز
    const token = /name="_csrf" value="([^"]+)"/.exec(p.text) ? /name="_csrf" value="([^"]+)"/.exec(p.text)[1] : csrf;
    return agent[method](path).type('form').send({ _csrf: token, ...body });
  };
  return { agent, withCsrf };
}

module.exports = { app, q, pool, migrate, resetDb, seedUsers, loginAgent, supertest };
