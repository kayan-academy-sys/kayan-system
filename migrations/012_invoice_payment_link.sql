ALTER TABLE invoices ADD COLUMN payment_id BIGINT REFERENCES payments(id);
ALTER TABLE invoices ADD COLUMN void_reason TEXT;
ALTER TABLE invoices ADD COLUMN voided_by INT REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN voided_at TIMESTAMPTZ;
CREATE UNIQUE INDEX idx_invoice_payment_once ON invoices(payment_id) WHERE payment_id IS NOT NULL;
