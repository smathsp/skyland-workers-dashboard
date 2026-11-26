const minute = 60_000;
const minutesPerDay = 24 * 60;
const day = minutesPerDay * minute;
const chinaOffset = 8 * 60 * minute;
const windowMinutes = 3 * 60;

export const dayInChina = time => new Date(time + chinaOffset).toISOString().slice(0, 10);
export const chinaMinute = time => Math.floor(((time + chinaOffset) % day) / minute);

function nextStart(time, minutes) {
  const localDay = Math.floor((time + chinaOffset) / day) * day;
  const today = localDay - chinaOffset + minutes * minute;
  return today > time ? today : today + day;
}

export function formatTime(minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function parseTime(time) {
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

export function scheduleStatement(db) {
  return db.prepare('SELECT minute_of_day, starts_at FROM daily_schedule WHERE id = 1');
}

export function readSchedule(db) {
  return scheduleStatement(db).first();
}

export function describeSchedule(entry, now = Date.now()) {
  return { time: formatTime(entry.minute_of_day), next_at: Math.max(nextStart(now, entry.minute_of_day), entry.starts_at) };
}

export async function saveSchedule(db, minutes, now = Date.now()) {
  const firstRun = nextStart(now, minutes);
  const entry = await db.prepare(`UPDATE daily_schedule SET minute_of_day = ?, starts_at = ?
    WHERE id = 1 AND minute_of_day <> ? RETURNING minute_of_day, starts_at`).bind(minutes, firstRun, minutes).first();
  return describeSchedule(entry ?? await readSchedule(db), now);
}

export function nextScheduledAccount(db, time, now = Date.now()) {
  const localMinute = chinaMinute(time);
  const today = dayInChina(time);
  const yesterday = dayInChina(time - day);
  // Check the single schedule row first. A window crossing midnight belongs to its start date.
  return db.prepare(`WITH due AS (
      SELECT CASE WHEN minute_of_day > ?1 THEN ?2 ELSE ?3 END AS slot
      FROM daily_schedule WHERE id = 1 AND starts_at <= ?4
        AND (?1 - minute_of_day + 1440) % 1440 < ?5
    )
    SELECT accounts.id, due.slot FROM due CROSS JOIN accounts
    WHERE enabled = 1 AND needs_reauth = 0 AND locked_until <= ?6
      AND cron_day IS NOT due.slot AND successful_day IS NOT ?3
    ORDER BY updated_at, accounts.id LIMIT 1`)
    .bind(localMinute, yesterday, today, time, windowMinutes, now).first();
}
