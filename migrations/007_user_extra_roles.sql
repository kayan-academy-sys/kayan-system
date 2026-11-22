-- أدوار متعددة لنفس الحساب: دور أساسي (role) + أدوار إضافية (extra_roles)
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_roles text[] NOT NULL DEFAULT '{}';
