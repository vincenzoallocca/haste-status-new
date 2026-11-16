-- D1 Performance Optimization Migration for haste-status
-- 1. Add check_date column to checks table for efficient date queries
-- 2. Add index on (monitor_id, check_date) for daily status queries
-- 3. Add email_normalized column to users for case-insensitive login

-- Add check_date column (stores DATE portion of checked_at)
ALTER TABLE checks ADD COLUMN check_date TEXT;

-- Backfill check_date from existing checked_at values
UPDATE checks SET check_date = DATE(checked_at);

-- Add index for efficient daily status queries
CREATE INDEX IF NOT EXISTS idx_checks_monitor_check_date ON checks(monitor_id, check_date);

-- Add email_normalized column for case-insensitive login without LOWER()
ALTER TABLE users ADD COLUMN email_normalized TEXT;

-- Backfill email_normalized
UPDATE users SET email_normalized = LOWER(email);

-- Add unique index on normalized email
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users(email_normalized);