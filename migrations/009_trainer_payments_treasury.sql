-- ربط مدفوعات المحاضرين بالخزينة: كل دفعة = مصروف مرتبط، يمنع الازدواج أو الانحراف بين السجلين
INSERT INTO expense_types (name) SELECT 'مستحقات محاضرين' WHERE NOT EXISTS (SELECT 1 FROM expense_types WHERE name='مستحقات محاضرين');
ALTER TABLE trainer_payments ADD COLUMN account_id INT REFERENCES financial_accounts(id);
ALTER TABLE trainer_payments ADD COLUMN expense_id BIGINT UNIQUE REFERENCES expenses(id);
