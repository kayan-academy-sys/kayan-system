-- منع تكرار رسائل واتساب الرسمية (Meta Cloud API) عند إعادة الإرسال
CREATE TABLE IF NOT EXISTS processed_meta_messages (
  message_id TEXT PRIMARY KEY,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
