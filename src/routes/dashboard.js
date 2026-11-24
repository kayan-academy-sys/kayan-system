const express = require('express');
const { q } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { can } = require('../lib/permissions');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const role = req.user.roles;
  const data = { role };
  const one = async (sql, params) => (await q(sql, params)).rows[0];

  if (can(role, 'leads.view.all') || can(role, 'leads.view.own')) {
    const ownOnly = !can(role, 'leads.view.all');
    const scope = ownOnly ? 'AND l.assigned_to=$1' : '';
    const params = ownOnly ? [req.user.id] : [];
    data.leads = await one(`SELECT
      count(*) FILTER (WHERE l.status='new') AS new_leads,
      count(*) FILTER (WHERE l.status NOT IN ('closed_lost','booked_cash','booked_installment')) AS active_leads,
      count(*) FILTER (WHERE l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < now() AND l.status IN ('new','no_answer','interested','need_follow_up')) AS overdue_followups,
      count(*) FILTER (WHERE l.status IN ('booked_cash','booked_installment') AND l.updated_at::date=current_date) AS bookings_today
      FROM leads l WHERE TRUE ${scope}`, params);
  }
  if (can(role, 'payments.view') || can(role, 'payments.create')) {
    data.finance = await one(`SELECT
      COALESCE(sum(amount) FILTER (WHERE paid_at::date=current_date AND status='active'),0) AS collected_today,
      COALESCE(sum(amount) FILTER (WHERE status='active'),0) AS collected_total
      FROM payments`);
    data.installments = await one(`SELECT
      count(*) FILTER (WHERE i.due_date=current_date) AS due_today,
      count(*) FILTER (WHERE i.due_date<current_date) AS overdue
      FROM installments i JOIN installment_plans p ON p.id=i.plan_id
      JOIN sales_orders o ON o.id=p.order_id
      WHERE i.status='pending' AND o.status='approved'
      AND (SELECT COALESCE(sum(pay.amount),0) FROM payments pay WHERE pay.installment_id=i.id AND pay.status='active') < i.amount`);
    data.expenses_month = await one(`SELECT COALESCE(sum(amount),0) AS total FROM expenses WHERE status='active' AND date_trunc('month', expense_date)=date_trunc('month', current_date)`);
  }
  if (can(role, 'groups.view') || can(role, 'groups.manage')) {
    data.groups = await one(`SELECT
      count(*) FILTER (WHERE status IN ('open','nearly_full','running')) AS active_groups,
      count(*) FILTER (WHERE status='nearly_full') AS nearly_full
      FROM groups`);
    data.today_sessions = (await q(`
      SELECT s.id, s.session_date, s.start_time, s.end_time, s.status, g.name AS group_name, c.name AS course_name, t.name AS trainer_name,
        (SELECT count(*) FROM enrollments e WHERE e.group_id=g.id AND e.status='active') AS students
      FROM sessions s JOIN groups g ON g.id=s.group_id JOIN courses c ON c.id=g.course_id LEFT JOIN trainers t ON t.id=g.trainer_id
      WHERE s.session_date=current_date AND s.status != 'cancelled' ORDER BY s.start_time`)).rows;
  }
  const unread = await one('SELECT count(*) AS c FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  data.unreadCount = parseInt(unread.c, 10);
  res.render('dashboard', { title: 'لوحة التحكم', nav: 'dash', data });
});

module.exports = router;
