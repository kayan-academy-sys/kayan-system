-- DB-backed login rate limiting (works across serverless instances and restarts)
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_reset_idx ON login_attempts (reset_at);
