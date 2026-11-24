CREATE SEQUENCE invoice_serial_seq;
CREATE TABLE invoices (
 id BIGSERIAL PRIMARY KEY,
 serial_no BIGINT NOT NULL UNIQUE DEFAULT nextval('invoice_serial_seq'),
 issue_date DATE NOT NULL DEFAULT current_date,
 customer_name TEXT NOT NULL,
 customer_mobile TEXT,
 amount_pounds INT NOT NULL CHECK(amount_pounds BETWEEN 0 AND 999999999),
 amount_piastres INT NOT NULL DEFAULT 0 CHECK(amount_piastres BETWEEN 0 AND 99),
 purpose TEXT NOT NULL,
 offer_type TEXT,
 terms TEXT NOT NULL,
 terms_version INT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','voided')),
 sales_user_id INT REFERENCES users(id),
 created_by INT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(amount_pounds>0 OR amount_piastres>0)
);
ALTER TABLE invoices ADD COLUMN order_id INT REFERENCES sales_orders(id);
ALTER TABLE invoices ADD COLUMN confirmed_by INT REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN delivered_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN synthetic BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_invoice_sales ON invoices(sales_user_id,status);
ALTER TABLE invoices ADD COLUMN payment_id BIGINT REFERENCES payments(id);
ALTER TABLE invoices ADD COLUMN void_reason TEXT;
ALTER TABLE invoices ADD COLUMN voided_by INT REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN voided_at TIMESTAMPTZ;
CREATE UNIQUE INDEX idx_invoice_payment_once ON invoices(payment_id) WHERE payment_id IS NOT NULL;

INSERT INTO settings(key,value) VALUES ('invoice_terms_version','0'::jsonb),('invoice_terms',to_jsonb(''::text)) ON CONFLICT DO NOTHING;
