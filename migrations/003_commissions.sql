-- عمولات المبيعات
CREATE TABLE commissions (
  id SERIAL PRIMARY KEY,
  sales_user_id INT NOT NULL REFERENCES users(id),
  order_id INT NOT NULL REFERENCES sales_orders(id),
  basis TEXT NOT NULL CHECK (basis IN ('percent_booking','percent_collected','fixed')),
  basis_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate NUMERIC(8,3),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  note TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  paid_by INT REFERENCES users(id),
  UNIQUE (order_id)
);
CREATE INDEX idx_commissions_user ON commissions(sales_user_id, status);
