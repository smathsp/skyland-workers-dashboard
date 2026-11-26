CREATE TABLE notification_settings (
  provider TEXT PRIMARY KEY CHECK (provider IN ('serverchan', 'pushplus', 'qmsg')),
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  result_mode TEXT NOT NULL CHECK (result_mode IN ('all', 'failures')),
  include_manual INTEGER NOT NULL CHECK (include_manual IN (0, 1)),
  revision TEXT NOT NULL,
  last_at INTEGER,
  last_status TEXT CHECK (last_status IN ('accepted', 'failed')),
  last_message TEXT,
  last_kind TEXT CHECK (last_kind IN ('test', 'sign'))
);
