-- عمولات شهرية لكل موظف مبيعات حسب قواعد كيان (تستبدل النسخة لكل حجز)
DROP TABLE commissions;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_target NUMERIC(12,2);
CREATE TABLE commission_months (
  id SERIAL PRIMARY KEY,
  sales_user_id INT NOT NULL REFERENCES users(id),
  month DATE NOT NULL, -- أول يوم في الشهر
  target NUMERIC(12,2) NOT NULL,
  invoiced NUMERIC(12,2) NOT NULL DEFAULT 0,   -- فواتير/حجوزات الشهر المنسوبة للموظف
  collected NUMERIC(12,2) NOT NULL DEFAULT 0,  -- تحصيلات الشهر المنسوبة له (تشمل متأخرات شهور سابقة)
  eligible BOOLEAN NOT NULL DEFAULT FALSE,     -- بلغ ٨٠٪ من التارجت فواتير
  method TEXT NOT NULL CHECK (method IN ('collection_tier','invoice_weighted')),
  rate_in NUMERIC(6,3) NOT NULL,   -- ٪ داخل التارجت
  rate_over NUMERIC(6,3) NOT NULL, -- ٪ على ما فوق التارجت
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  note TEXT,
  computed_by INT REFERENCES users(id),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  paid_by INT REFERENCES users(id),
  UNIQUE (sales_user_id, month)
);
CREATE INDEX idx_commission_months_user ON commission_months(sales_user_id, month DESC);
