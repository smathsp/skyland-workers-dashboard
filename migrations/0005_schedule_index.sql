CREATE INDEX accounts_by_schedule ON accounts(updated_at, id, locked_until, cron_day, successful_day)
  WHERE enabled = 1 AND needs_reauth = 0;
