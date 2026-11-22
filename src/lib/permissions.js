// الأدوار والصلاحيات - تُطبق على الواجهة والخادم
const ROLES = {
  admin: 'مدير النظام',
  general_supervisor: 'المشرف العام',
  sales_manager: 'مدير المبيعات',
  sales_team_leader: 'تيم ليدر المبيعات',
  sales_staff: 'موظف مبيعات',
  accounting_manager: 'مدير الحسابات',
  accounting_staff: 'موظف حسابات',
  reception: 'استقبال',
  course_manager: 'مسؤول الكورسات والمجموعات'
};

const SALES_ROLES = ['sales_manager', 'sales_team_leader', 'sales_staff'];

const CAPS = {
  admin: ['*'],
  general_supervisor: [
    'dashboard.view', 'leads.view.all', 'leads.create', 'leads.edit', 'leads.assign', 'leads.monitor',
    'customers.view', 'customers.edit',
    'courses.manage', 'trainers.manage', 'groups.manage', 'sessions.manage', 'packages.manage',
    'orders.view.all', 'orders.create',
    'payments.view', 'installments.view', 'expenses.view', 'accounts.view',
    'reception.view', 'attendance.record', 'attendance.view',
    'reports.sales', 'reports.finance', 'reports.export', 'commissions.view.all',
    'audit.view', 'users.request', 'notifications.view', 'ai.use'
  ],
  sales_manager: [
    'dashboard.view', 'leads.view.all', 'leads.create', 'leads.edit', 'leads.assign', 'leads.monitor',
    'presence.manage', 'customers.view', 'customers.edit',
    'groups.view', 'packages.view', 'courses.view',
    'orders.create', 'orders.view.all',
    'reports.sales', 'reports.export', 'notifications.view', 'ai.use', 'commissions.view.own'
  ],
  sales_team_leader: [
    'dashboard.view', 'leads.view.own', 'leads.create', 'leads.edit', 'leads.monitor',
    'customers.view', 'groups.view', 'packages.view', 'courses.view',
    'orders.create', 'orders.view.own', 'notifications.view', 'ai.use', 'commissions.view.own'
  ],
  sales_staff: [
    'dashboard.view', 'leads.view.own', 'leads.create', 'leads.edit',
    'customers.view', 'groups.view', 'packages.view', 'courses.view',
    'orders.create', 'orders.view.own', 'notifications.view', 'ai.use', 'commissions.view.own'
  ],
  accounting_manager: [
    'dashboard.view', 'payments.view', 'payments.create', 'payments.void',
    'installments.view', 'installments.manage', 'expenses.view', 'expenses.create', 'expenses.void',
    'expense_types.manage', 'accounts.view', 'accounts.manage', 'transfers.create', 'transfers.view',
    'closings.manage', 'orders.view.all', 'orders.cancel', 'commissions.view.all', 'commissions.manage', 'commissions.execute',
    'reports.finance', 'reports.export', 'notifications.view', 'ai.use'
  ],
  accounting_staff: [
    'dashboard.view', 'payments.view', 'payments.create', 'installments.view',
    'expenses.view', 'expenses.create', 'accounts.view', 'transfers.view',
    'orders.view.all', 'reports.finance', 'notifications.view', 'ai.use', 'commissions.view.all', 'commissions.manage'
  ],
  reception: [
    'dashboard.view', 'reception.view', 'attendance.record', 'attendance.view',
    'customers.view', 'students.search', 'installments.view.limited', 'groups.view', 'courses.view',
    'notifications.view', 'ai.use'
  ],
  course_manager: [
    'dashboard.view', 'courses.manage', 'trainers.manage', 'groups.manage', 'sessions.manage',
    'packages.manage', 'attendance.view', 'reception.view', 'reports.sales',
    'notifications.view', 'ai.use'
  ]
};

function can(role, cap) {
  const list = CAPS[role] || [];
  if (list.includes('*')) return true;
  if (list.includes(cap)) return true;
  const ns = cap.split('.')[0] + '.*';
  return list.includes(ns);
}

function canAny(user, caps) { return caps.some(c => can(user.role, c)); }

module.exports = { ROLES, SALES_ROLES, CAPS, can, canAny };
