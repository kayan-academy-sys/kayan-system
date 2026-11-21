-- نظام كيان: المخطط الكامل لقاعدة البيانات
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','general_supervisor','sales_manager','sales_team_leader','sales_staff','accounting_manager','accounting_staff','reception','course_manager')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  invited_by INT REFERENCES users(id),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('general_supervisor','sales_manager','sales_team_leader','sales_staff','accounting_manager','accounting_staff','reception','course_manager')),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_by INT REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_add_requests (
  id SERIAL PRIMARY KEY,
  requested_by INT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE job_runs (
  id BIGSERIAL PRIMARY KEY,
  job TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','error','skipped')),
  details JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE, -- نص للحفاظ على الأصفار
  email TEXT,
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_name ON customers(name);

CREATE TABLE courses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  duration_weeks INT,
  lectures_count INT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  course_id INT REFERENCES courses(id),
  source TEXT NOT NULL CHECK (source IN ('whatsapp','facebook','instagram','tiktok','website','manual','other')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','no_answer','interested','need_follow_up','closed_lost','booked_cash','booked_installment')),
  interest_score INT CHECK (interest_score BETWEEN 1 AND 10),
  assigned_to INT REFERENCES users(id),
  assigned_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  lost_reason TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_assigned ON leads(assigned_to, status);
CREATE INDEX idx_leads_followup ON leads(next_follow_up_at);

CREATE TABLE lead_assignments (
  id BIGSERIAL PRIMARY KEY,
  lead_id INT NOT NULL REFERENCES leads(id),
  from_user_id INT REFERENCES users(id),
  to_user_id INT REFERENCES users(id),
  assigned_by INT REFERENCES users(id), -- NULL = النظام
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lead_activities (
  id BIGSERIAL PRIMARY KEY,
  lead_id INT NOT NULL REFERENCES leads(id),
  user_id INT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('call','note','follow_up','status_change')),
  result TEXT,
  notes TEXT,
  next_follow_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lead_activities_lead ON lead_activities(lead_id, created_at DESC);

CREATE TABLE staff_presence (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  work_date DATE NOT NULL,
  present BOOLEAN NOT NULL DEFAULT TRUE,
  marked_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)
);

CREATE TABLE trainers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  specialties TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id),
  trainer_id INT REFERENCES trainers(id),
  name TEXT NOT NULL UNIQUE,
  start_date DATE,
  end_date DATE,
  capacity INT NOT NULL DEFAULT 20 CHECK (capacity > 0),
  days_of_week TEXT,
  time_from TIME,
  time_to TIME,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','nearly_full','full','running','finished','cancelled')),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  group_id INT NOT NULL REFERENCES groups(id),
  session_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','done','postponed','cancelled')),
  original_date DATE,
  original_start_time TIME,
  postpone_reason TEXT,
  postponed_by INT REFERENCES users(id),
  postponed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_date ON sessions(session_date);

CREATE TABLE packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL,
  validity TEXT,
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE package_courses (
  package_id INT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  course_id INT NOT NULL REFERENCES courses(id),
  PRIMARY KEY (package_id, course_id)
);

CREATE TABLE sales_orders (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  lead_id INT REFERENCES leads(id),
  kind TEXT NOT NULL CHECK (kind IN ('course','package')),
  course_id INT REFERENCES courses(id),
  package_id INT REFERENCES packages(id),
  total_price NUMERIC(12,2) NOT NULL,
  offer_type TEXT,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('cash','installments')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','cancelled')),
  cancel_reason TEXT,
  cancelled_by INT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  sales_user_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE enrollments (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES sales_orders(id),
  customer_id INT NOT NULL REFERENCES customers(id),
  course_id INT NOT NULL REFERENCES courses(id),
  group_id INT REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_enrollments_group ON enrollments(group_id, status);
CREATE INDEX idx_enrollments_customer ON enrollments(customer_id);

CREATE TABLE financial_accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('cash','bank','instapay','wallet')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE installment_plans (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL UNIQUE REFERENCES sales_orders(id),
  total NUMERIC(12,2) NOT NULL,
  down_payment NUMERIC(12,2) NOT NULL DEFAULT 0,
  count INT NOT NULL CHECK (count > 0),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE installments (
  id BIGSERIAL PRIMARY KEY,
  plan_id INT NOT NULL REFERENCES installment_plans(id),
  seq INT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  due_date DATE NOT NULL,
  original_due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  postpone_reason TEXT,
  postponed_by INT REFERENCES users(id),
  postponed_at TIMESTAMPTZ,
  postpone_approved_by INT REFERENCES users(id),
  UNIQUE (plan_id, seq)
);
CREATE INDEX idx_installments_due ON installments(due_date, status);

CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES sales_orders(id),
  installment_id INT REFERENCES installments(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','instapay','wallet')),
  account_id INT NOT NULL REFERENCES financial_accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason TEXT,
  voided_by INT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  received_by INT REFERENCES users(id),
  notes TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_order ON payments(order_id, status);

CREATE TABLE expense_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE expenses (
  id BIGSERIAL PRIMARY KEY,
  type_id INT NOT NULL REFERENCES expense_types(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL,
  account_id INT NOT NULL REFERENCES financial_accounts(id),
  recorded_by INT REFERENCES users(id),
  notes TEXT,
  receipt_path TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason TEXT,
  voided_by INT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id BIGSERIAL PRIMARY KEY,
  from_account_id INT NOT NULL REFERENCES financial_accounts(id),
  to_account_id INT NOT NULL REFERENCES financial_accounts(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  transfer_date DATE NOT NULL,
  notes TEXT,
  recorded_by INT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason TEXT,
  voided_by INT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE daily_closings (
  id SERIAL PRIMARY KEY,
  closing_date DATE NOT NULL UNIQUE,
  balances JSONB NOT NULL,
  notes TEXT,
  closed_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance (
  id BIGSERIAL PRIMARY KEY,
  session_id INT NOT NULL REFERENCES sessions(id),
  enrollment_id INT NOT NULL REFERENCES enrollments(id),
  status TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
  checked_by INT REFERENCES users(id),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  UNIQUE (session_id, enrollment_id)
);

-- البيانات الأساسية
INSERT INTO expense_types (name) VALUES
 ('إيجار'),('كهرباء'),('مياه'),('إنترنت'),('رواتب'),('إعلانات'),('مستلزمات'),('صيانة'),('ضيافة'),('مواصلات'),('أخرى');

INSERT INTO financial_accounts (name, type) VALUES
 ('الخزينة','cash'),('الحساب البنكي','bank'),('إنستاباي','instapay'),('المحفظة الإلكترونية','wallet');

INSERT INTO courses (name, description, base_price) VALUES
 ('التسويق الرقمي','كورس التسويق الرقمي والإعلانات الممولة',0),
 ('الجرافيك ديزاين','كورس التصميم الجرافيكي',0),
 ('التصوير','كورس التصوير الفوتوغرافي',0),
 ('المونتاج وتحرير الفيديو','كورس المونتاج وتحرير الفيديو',0),
 ('الذكاء الاصطناعي','كورس أدوات وتطبيقات الذكاء الاصطناعي',0);

INSERT INTO settings (key, value) VALUES
 ('lead_reassign_days','90'),
 ('lead_distribution_enabled','true'),
 ('reassign_exempt_statuses','["closed_lost"]'),
 ('nearly_full_threshold','3'),
 ('academy_name','"أكاديمية كيان"'),
 ('academy_phone','"01062346652"');
