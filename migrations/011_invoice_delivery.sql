ALTER TABLE invoices ADD COLUMN order_id INT REFERENCES sales_orders(id);
ALTER TABLE invoices ADD COLUMN confirmed_by INT REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN delivered_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_invoice_sales ON invoices(sales_user_id,status);
