// محرك الأتمتة الداخلي: مهام مجدولة بدون n8n
const { q, pool } = require('../db');
const { getSetting } = require('./settings');
const { notify, notifyRole } = require('./notify');

async function runJob(name, fn) {
  const { rows } = await q('INSERT INTO job_runs (job, status) VALUES ($1, $2) RETURNING id', [name, 'success']);
  const runId = rows[0].id;
  try {
    const details = await fn();
    await q(`UPDATE job_runs SET status='success', details=$2, finished_at=now() WHERE id=$1`, [runId, JSON.stringify(details || {})]);
    return { ok: true, details };
  } catch (e) {
    await q(`UPDATE job_runs SET status='error', details=$2, finished_at=now() WHERE id=$1`, [runId, JSON.stringify({ error: e.message })]);
    console.error('job failed', name, e);
    return { ok: false, error: e.message };
  }
}

// 1) تذكير بمواعيد المتابعة المستحقة والمتأخرة
async function followupReminders() {
  return runJob('followup_reminders', async () => {
    const { rows } = await q(`
      SELECT l.id, l.assigned_to, c.name AS customer_name, l.next_follow_up_at
      FROM leads l JOIN customers c ON c.id=l.customer_id
      WHERE l.status IN ('new','no_answer','interested','need_follow_up')
        AND l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= now() + interval '6 hours'
        AND l.assigned_to IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id=l.assigned_to AND n.type='follow_up'
                        AND n.link=('/leads/' || l.id) AND n.created_at > now() - interval '12 hours')`);
    for (const r of rows) {
      await notify(r.assigned_to, 'follow_up', 'موعد متابعة مستحق', `العميل ${r.customer_name} لديه موعد متابعة الآن.`, `/leads/${r.id}`);
    }
    return { notified: rows.length };
  });
}

// 2) تحويل العملاء بعد انقضاء مدة الإسناد دون حجز (90 يومًا افتراضيًا)
async function reassignStaleLeads() {
  return runJob('reassign_stale_leads', async () => {
    const days = parseInt(await getSetting('lead_reassign_days', 90), 10);
    const exempt = await getSetting('reassign_exempt_statuses', ['closed_lost']);
    const { rows: stale } = await q(`
      SELECT l.*, c.name AS customer_name FROM leads l JOIN customers c ON c.id=l.customer_id
      WHERE l.assigned_to IS NOT NULL
        AND l.assigned_at < now() - ($1 || ' days')::interval
        AND NOT (l.status = ANY($2::text[]))
        AND l.status NOT IN ('booked_cash','booked_installment')
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type='reassign_skip' AND n.link=('/leads/'||l.id) AND n.created_at > now() - interval '1 day')
      `, [String(days), exempt]);
    const { rows: staff } = await q(`
      SELECT u.id, (SELECT count(*) FROM leads l WHERE l.assigned_to=u.id AND l.status IN ('new','no_answer','interested','need_follow_up')) AS load
      FROM users u WHERE u.role IN ('sales_staff','sales_team_leader') AND u.active=TRUE
        AND EXISTS (SELECT 1 FROM staff_presence sp WHERE sp.user_id=u.id AND sp.work_date=current_date AND sp.present=TRUE)
      ORDER BY load ASC`);
    let moved = 0;
    for (const lead of stale) {
      const candidates = staff.filter(s => s.id !== lead.assigned_to);
      if (!candidates.length) {
        await notifyRole('sales_manager', 'reassign_skip', 'عميل متجاوز للمدة بدون بديل', `العميل ${lead.customer_name} تجاوز ${days} يومًا دون حجز ولا يوجد موظف حاضر بديل.`, `/leads/${lead.id}`);
        continue;
      }
      const nextStaff = candidates[0];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE leads SET assigned_to=$1, assigned_at=now(), updated_at=now() WHERE id=$2`, [nextStaff.id, lead.id]);
        await client.query(`INSERT INTO lead_assignments (lead_id, from_user_id, to_user_id, assigned_by, reason) VALUES ($1,$2,$3,NULL,$4)`,
          [lead.id, lead.assigned_to, nextStaff.id, `تحويل تلقائي بعد ${days} يومًا دون حجز`]);
        await client.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'reassign',$2,$3,$4)`,
          [nextStaff.id, 'عميل محوّل إليك', `تم تحويل العميل ${lead.customer_name} إليك تلقائيًا بعد ${days} يومًا دون حجز. راجع تاريخه السابق مع الموظف السابق.`, `/leads/${lead.id}`]);
        await client.query('COMMIT');
        nextStaff.load++;
        moved++;
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
    return { stale: stale.length, moved };
  });
}

// 3) تنبيه الأقساط المستحقة اليوم والمتأخرة
async function installmentAlerts() {
  return runJob('installment_alerts', async () => {
    const { rows } = await q(`
      SELECT i.id, i.due_date, i.amount, cu.name AS customer_name,
        i.due_date < current_date AS overdue
      FROM installments i
      JOIN installment_plans p ON p.id=i.plan_id
      JOIN sales_orders o ON o.id=p.order_id AND o.status='approved'
      JOIN customers cu ON cu.id=o.customer_id
      WHERE i.status='pending' AND i.due_date <= current_date + 1
        AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type='installment_due' AND n.link=('/accounting/installments') AND n.created_at::date=current_date AND n.body LIKE '%' || cu.name || '%')`);
    let count = 0;
    for (const r of rows) {
      for (const role of ['accounting_manager', 'accounting_staff']) {
        const { rows: us } = await q('SELECT id FROM users WHERE role=$1 AND active=TRUE', [role]);
        for (const u of us) {
          await notify(u.id, 'installment_due', r.overdue ? 'قسط متأخر' : 'قسط مستحق قريبًا',
            `${r.customer_name}: قسط بقيمة ${r.amount} ج.م ${r.overdue ? 'متأخر منذ ' + new Date(r.due_date).toLocaleDateString('ar-EG') : 'يستحق ' + new Date(r.due_date).toLocaleDateString('ar-EG')}`, '/accounting/installments');
          count++;
        }
      }
    }
    return { alerts: count };
  });
}

// 4) المجموعات التي قاربت على الاكتمال
async function groupFullnessAlerts() {
  return runJob('group_fullness', async () => {
    const threshold = parseInt(await getSetting('nearly_full_threshold', 3), 10);
    const { rows } = await q(`
      SELECT g.id, g.name, g.capacity,
        (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS booked
      FROM groups g WHERE g.status IN ('open','nearly_full')`);
    let changed = 0;
    for (const g of rows) {
      const avail = g.capacity - g.booked;
      let target = null;
      if (avail <= 0) target = 'full';
      else if (avail <= threshold) target = 'nearly_full';
      if (target && target !== g.status) {
        await q('UPDATE groups SET status=$1 WHERE id=$2', [target, g.id]);
        if (target === 'nearly_full') await notifyRole('course_manager', 'group_nearly_full', 'مجموعة قاربت على الاكتمال', `المجموعة ${g.name}: متبقي ${avail} أماكن فقط.`, `/groups/${g.id}`);
        changed++;
      }
    }
    return { changed };
  });
}

const JOBS = { followup_reminders: followupReminders, reassign_stale_leads: reassignStaleLeads, installment_alerts: installmentAlerts, group_fullness: groupFullnessAlerts };

async function runAll() {
  const results = {};
  for (const [name, fn] of Object.entries(JOBS)) results[name] = await fn();
  return results;
}

let timer = null;
function startScheduler() {
  if (timer) return;
  // يعمل كل 15 دقيقة داخل العملية
  timer = setInterval(() => { runAll().catch(e => console.error('scheduler error', e)); }, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(() => runAll().catch(() => {}), 30 * 1000).unref?.();
  console.log('automation scheduler started (15 min interval)');
}

// Preview on-use catch-up. One database lock across instances and at most every15min.
async function catchUpIfDue(){
 const c=await pool.connect();let locked=false;
 try{
  locked=(await c.query('SELECT pg_try_advisory_lock(72819461) AS locked')).rows[0].locked;
  if(!locked)return {skipped:'busy'};
  const last=(await c.query("SELECT max(finished_at) AS at FROM job_runs WHERE job='preview_catchup_complete' AND status='success'")).rows[0].at;
  if(last&&Date.now()-new Date(last).getTime()<15*60*1000)return {skipped:'recent'};
  const results=await runAll();
  if(Object.values(results).every(r=>r.ok))await c.query("INSERT INTO job_runs(job,status,finished_at,details) VALUES('preview_catchup_complete','success',now(),$1)",[JSON.stringify({mode:'on_use_not_clock'})]);
  return results;
 }finally{if(locked)await c.query('SELECT pg_advisory_unlock(72819461)');c.release();}
}
module.exports = { JOBS, runAll, runJob, startScheduler,catchUpIfDue };
