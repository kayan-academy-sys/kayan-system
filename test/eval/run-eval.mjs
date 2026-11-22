// Eval: local keyword baseline (src/routes/assistant.js) vs OpenRouter free LLM.
// Fictional sanitized questions only. No academy data leaves the machine except the question text itself.
// Usage: OPENROUTER_KEY_FILE=/tmp/or-key2.txt node test/eval/run-eval.mjs
import { readFileSync, writeFileSync } from 'fs';
import Module from 'module';
import path from 'path';

const KEY = readFileSync(process.env.OPENROUTER_KEY_FILE, 'utf8').trim();
const questions = JSON.parse(readFileSync(new URL('../assistant-eval-questions.json', import.meta.url))).questions;

// ---- Load baseline answer() with stubbed deps (test-only, repo untouched) ----
const srcPath = path.resolve('src/routes/assistant.js');
let src = readFileSync(srcPath, 'utf8');
src = src.replace('module.exports = router;', 'module.exports = { answer };');
const m = new Module('assistant-under-test');
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({ use() {}, get() {}, post() {} }) };
  if (request === '../config') return {};
  if (request === '../db') return { q: async () => ({ rows: [] }) };
  if (request === '../middleware/auth') return { requireAuth: (a, b, c) => c(), requireCap: () => (a, b, c) => c() };
  if (request === '../lib/permissions') return { can: () => true };
  return origLoad.call(this, request, ...rest);
};
m._compile(src, srcPath);
Module._load = origLoad;
const baselineAnswer = m.exports.answer;
const stubUser = { id: 1, name: 'مستخدم اختبار', roles: ['admin'] };

function classifyBaseline(reply) {
  if (reply.startsWith('أهلًا ')) return 'greeting';
  if (reply.startsWith('ملخص اليوم')) return 'daily_summary';
  if (reply.includes('الأقساط المتأخرة') || reply.includes('لا توجد أقساط متأخرة')) return 'late_installments';
  if (reply.includes('الأقساط المستحقة اليوم') || reply.includes('لا توجد أقساط مستحقة اليوم')) return 'due_today';
  if (reply.includes('محاضرات اليوم') || reply.includes('لا توجد محاضرات')) return 'sessions_today';
  if (reply.includes('حضور اليوم') || reply.includes('لم يُسجَّل حضور')) return 'attendance_today';
  if (reply.includes('المجموعات المتاحة') || reply.includes('لا توجد مجموعات')) return 'available_groups';
  if (reply.startsWith('تحصيل آخر ٧ أيام')) return 'collections_week';
  if (reply.startsWith('تحصيل اليوم')) return 'collections_today';
  if (reply.startsWith('العملاء الجدد')) return 'new_leads';
  if (reply.startsWith('العميل:') || reply.startsWith('لا يوجد عميل')) return 'customer_by_phone';
  if (reply.startsWith('لإنشاء حجز:')) return 'howto_booking';
  if (reply.startsWith('الأقساط تُدار')) return 'howto_installments';
  if (reply.startsWith('هذا السؤال خارج')) return 'no_cap_refusal';
  if (reply.startsWith('لم أفهم')) return 'fallback';
  if (reply.startsWith('توزيع العملاء:') || reply.startsWith('تسجيل الحضور:')) return 'howto_other';
  if (reply.startsWith('أقدر أجاوبك عن:')) return 'capabilities_only';
  return 'other';
}

// ---- LLM ----
const TAXONOMY = [
  ['greeting', 'تحية أو سلام فقط'],
  ['daily_summary', 'ملخص أو أخبار اليوم'],
  ['late_installments', 'الأقساط المتأخرة / مين لم يدفع'],
  ['due_today', 'الأقساط المستحقة اليوم'],
  ['sessions_today', 'محاضرات أو حصص اليوم'],
  ['sessions_other_day_or_refusal', 'محاضرات يوم آخر غير اليوم'],
  ['attendance_today', 'حضور أو غياب اليوم'],
  ['available_groups', 'المجموعات أو الأماكن المتاحة للحجز'],
  ['collections_today', 'تحصيل أو إيراد اليوم'],
  ['collections_week', 'تحصيل أو إيراد الأسبوع'],
  ['new_leads', 'العملاء الجدد (leads)'],
  ['customer_by_phone', 'بيانات عميل محدد برقم هاتف'],
  ['howto_booking', 'خطوات إنشاء حجز'],
  ['howto_installments', 'خطوات إدارة الأقساط أو التقسيط'],
  ['out_of_scope_or_refusal', 'خارج نطاق مساعد التشغيل الداخلي أو يستوجب الاعتذار'],
  ['refusal_bulk_pii', 'طلب بيانات جماعية أو أرقام هواتف كل العملاء — يجب الرفض'],
];
const MODELS = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callLLM(question) {
  const sys = 'أنت مصنّف أسئلة لمساعد داخلي في نظام إدارة أكاديمية تدريب. صنّف سؤال الموظف إلى فئة واحدة من القائمة، ثم اكتب ردًا مختصرًا طبيعيًا بالعربية كما يجيب مساعد النظام (من غير اختراع أرقام أو بيانات).\nالفئات (التسمية — الوصف):\n' +
    TAXONOMY.map(([k, d]) => `- ${k} — ${d}`).join('\n') +
    '\nأجب بـ JSON فقط بدون أي نص آخر: {"intent":"<التسمية>","answer":"<الرد بالعربية>"}';
  let lastErr = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const model = MODELS[attempt % MODELS.length];
    try {
      const t0 = Date.now();
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: question }],
          max_tokens: 260,
        }),
      });
      const latency = Date.now() - t0;
      const data = await res.json();
      if (data.error) {
        lastErr = `${res.status} ${data.error.code || ''} ${data.error.message}`;
        await sleep(Math.min(60000, 12000 * (attempt + 1)) + Math.random() * 5000);
        continue;
      }
      const raw = data.choices?.[0]?.message?.content || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { lastErr = 'no-json:' + raw.slice(0, 120); await sleep(3000); continue; }
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); } catch { lastErr = 'bad-json:' + raw.slice(0, 120); await sleep(3000); continue; }
      return { intent: String(parsed.intent || '').trim(), answer: String(parsed.answer || ''), model, latency, attempts: attempt + 1, raw: raw.slice(0, 400) };
    } catch (e) {
      lastErr = String(e);
      await sleep(10000);
    }
  }
  return { intent: 'ERROR', answer: '', model: MODELS[0], error: lastErr };
}

function matches(expected, got) {
  if (expected === got) return 'strict';
  if (expected.endsWith('_or_refusal')) {
    const base = expected.replace('_or_refusal', '');
    if (got === base || ['out_of_scope_or_refusal', 'no_cap_refusal', 'fallback', 'refusal_bulk_pii'].includes(got)) return 'acceptable';
  }
  if (expected === 'refusal_bulk_pii' && ['out_of_scope_or_refusal', 'no_cap_refusal'].includes(got)) return 'acceptable';
  if (expected === 'out_of_scope_or_refusal' && ['no_cap_refusal', 'fallback'].includes(got)) return 'acceptable';
  return 'miss';
}

let results = [];
try { results = JSON.parse(readFileSync('/tmp/eval-results.json', 'utf8')); } catch {}
const done = new Set(results.map(r => r.id));
for (const q of questions) {
  if (done.has(q.id)) { console.log(`q${q.id} skip (done)`); continue; }
  const bReply = await baselineAnswer(q.q, stubUser);
  const bLabel = classifyBaseline(bReply);
  const llm = await callLLM(q.q);
  const row = {
    id: q.id, q: q.q, expect: q.expect, difficulty: q.difficulty,
    baseline: { label: bLabel, match: matches(q.expect, bLabel), reply: bReply.slice(0, 160) },
    llm: { label: llm.intent, match: matches(q.expect, llm.intent), model: llm.model, latency_ms: llm.latency, attempts: llm.attempts, answer: llm.answer, error: llm.error },
  };
  results.push(row);
  writeFileSync('/tmp/eval-results.json', JSON.stringify(results, null, 2));
  console.log(`q${q.id} expect=${q.expect} baseline=${bLabel}(${row.baseline.match}) llm=${llm.intent}(${row.llm.match}) model=${llm.model} att=${llm.attempts || '-'}`);
}

const tally = (side) => {
  const t = { strict: 0, acceptable: 0, miss: 0 };
  for (const r of results) t[r[side].match === 'strict' ? 'strict' : r[side].match] = (t[r[side].match] || 0) + 1;
  return t;
};
const summary = { when: new Date().toISOString(), baseline: tally('baseline'), llm: tally('llm') };
writeFileSync('/tmp/eval-summary.json', JSON.stringify(summary, null, 2));
console.log('SUMMARY', JSON.stringify(summary));
