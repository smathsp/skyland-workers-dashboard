CREATE TABLE daily_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
  starts_at INTEGER NOT NULL
);
INSERT INTO daily_schedule (id, minute_of_day, starts_at) VALUES (1, 420, 0);

ALTER TABLE notification_settings RENAME TO notification_settings_previous;
CREATE TABLE notification_settings (
  provider TEXT PRIMARY KEY CHECK (provider IN ('serverchan', 'pushplus', 'qmsg', 'telegram', 'bark', 'wecom', 'feishu', 'discord', 'pushover')),
  secret_enc TEXT NOT NULL,
  extra_enc TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  result_mode TEXT NOT NULL CHECK (result_mode IN ('all', 'failures')),
  include_manual INTEGER NOT NULL CHECK (include_manual IN (0, 1)),
  revision TEXT NOT NULL,
  last_at INTEGER,
  last_status TEXT CHECK (last_status IN ('accepted', 'failed')),
  last_message TEXT,
  last_kind TEXT CHECK (last_kind IN ('test', 'sign'))
);
INSERT INTO notification_settings (provider, secret_enc, enabled, result_mode, include_manual, revision, last_at, last_status, last_message, last_kind)
  SELECT provider, secret_enc, enabled, result_mode, include_manual, revision, last_at, last_status, last_message, last_kind
  FROM notification_settings_previous;
DROP TABLE notification_settings_previous;
