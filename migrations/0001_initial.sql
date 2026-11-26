CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  token_enc TEXT NOT NULL,
  roles TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  needs_reauth INTEGER NOT NULL DEFAULT 0 CHECK (needs_reauth IN (0, 1)),
  updated_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  cron_day TEXT,
  successful_day TEXT
);

CREATE TABLE scans (
  owner TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  scan_id_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  poll_after INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sign_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'scheduled')),
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'reauth')),
  details TEXT NOT NULL
);
CREATE INDEX runs_by_account ON sign_runs(account_id, at DESC);
CREATE INDEX runs_by_time ON sign_runs(at DESC);
