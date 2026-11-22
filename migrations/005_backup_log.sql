-- سجل النسخ الاحتياطية الليلية (تكتبه مهمة GitHub Actions بعد نجاح اختبار الاسترجاع)
CREATE TABLE IF NOT EXISTS backup_log (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  file_name TEXT NOT NULL,
  byte_size BIGINT,
  restore_test BOOLEAN NOT NULL DEFAULT false
);
