CREATE TABLE admin_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  totp_secret_enc TEXT,
  enabled_at INTEGER,
  last_step INTEGER NOT NULL DEFAULT -1,
  short_window INTEGER NOT NULL DEFAULT -1,
  short_attempts INTEGER NOT NULL DEFAULT 0,
  day_window INTEGER NOT NULL DEFAULT -1,
  day_attempts INTEGER NOT NULL DEFAULT 0,
  pending_id TEXT,
  pending_owner TEXT,
  pending_secret_enc TEXT,
  pending_expires_at INTEGER NOT NULL DEFAULT 0,
  pending_attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO admin_auth (id) VALUES (1);
