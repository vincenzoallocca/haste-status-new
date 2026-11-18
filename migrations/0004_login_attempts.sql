-- Audit 2026-11-18 (SEC-S-03 / SEC-U-03): limite ai tentativi di login falliti.
-- Usata da haste-status e da haste-usage (che legge lo stesso database).
-- Reversibile: DROP INDEX idx_login_attempts_key_time; DROP TABLE login_attempts;
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key_time ON login_attempts(attempt_key, attempted_at);
