-- حساب المحاضرين: مبلغ متفق عليه لكل مجموعة يُستحق عند انتهاء المجموعة (حالة finished)
CREATE TABLE trainer_group_terms (
  id SERIAL PRIMARY KEY,
  group_id INT NOT NULL REFERENCES groups(id) UNIQUE,
  trainer_id INT NOT NULL REFERENCES trainers(id),
  agreed_amount NUMERIC(12,2) NOT NULL CHECK (agreed_amount >= 0),
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- مدفوعات المحاضرين المرتبطة بالخزينة في نفس المعاملة
CREATE TABLE trainer_payments (
  id SERIAL PRIMARY KEY,
  trainer_id INT NOT NULL REFERENCES trainers(id),
  group_id INT REFERENCES groups(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  method TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by INT REFERENCES users(id),
  voided_by INT REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_trainer_payments_trainer ON trainer_payments(trainer_id, status);

-- ربط مدفوعات المحاضرين بالخزينة: كل دفعة = مصروف مرتبط، يمنع الازدواج أو الانحراف بين السجلين
INSERT INTO expense_types (name) SELECT 'مستحقات محاضرين' WHERE NOT EXISTS (SELECT 1 FROM expense_types WHERE name='مستحقات محاضرين');
ALTER TABLE trainer_payments ADD COLUMN account_id INT REFERENCES financial_accounts(id);
ALTER TABLE trainer_payments ADD COLUMN expense_id BIGINT UNIQUE REFERENCES expenses(id);

ALTER TABLE trainer_payments ADD COLUMN request_key UUID UNIQUE;
