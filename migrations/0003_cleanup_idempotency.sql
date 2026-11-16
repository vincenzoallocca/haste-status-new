-- Migration 0003: Add cleanup idempotency tracking table
-- Ensures daily cleanup runs exactly once per day even with consolidated cron

CREATE TABLE IF NOT EXISTS cleanup_runs (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD in UTC
    started_at TEXT NOT NULL,        -- ISO timestamp when cleanup was claimed
    completed_at TEXT,               -- ISO timestamp when cleanup finished successfully
    checks_deleted INTEGER DEFAULT 0,
    daily_status_deleted INTEGER DEFAULT 0,
    error TEXT,                      -- Error message if cleanup failed
    claim_token TEXT                 -- UUID token for lease ownership verification
);

CREATE INDEX IF NOT EXISTS idx_cleanup_runs_completed ON cleanup_runs(completed_at);