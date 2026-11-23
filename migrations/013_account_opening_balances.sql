ALTER TABLE financial_accounts ADD COLUMN opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE financial_accounts ADD COLUMN opening_date DATE;
ALTER TABLE financial_accounts ADD COLUMN opening_notes TEXT;
ALTER TABLE financial_accounts ADD COLUMN opening_set_by INT REFERENCES users(id);
ALTER TABLE financial_accounts ADD COLUMN opening_set_at TIMESTAMPTZ;
