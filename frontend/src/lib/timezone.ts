// The UI's single date/time authority. Everything is formatted and reasoned about
// in America/New_York (Toronto shares it) regardless of the browser's own zone —
// flight dates, "today", window boundaries, and pattern time windows all live here.
// Intl with an explicit timeZone is deterministic across machines, so this is
// testable without faking the process zone.

export const NY_TZ = 'America/New_York';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Full names for the pattern editor, in the poller's Mon=0…Sun=6 order.
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday] ?? `?${weekday}`;
}

// A date-only string ("YYYY-MM-DD") is a NY-local flight date. Anchor it at noon
// UTC before formatting so no timezone offset can roll it to an adjacent day.
function dateOnlyToDate(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

// "2026-08-06" → "Thu, Aug 6"
export function formatFlightDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(dateOnlyToDate(isoDate));
}

// "2026-08-06" → "Aug 6" (compact, for axis labels)
export function formatShortDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    month: 'short',
    day: 'numeric',
  }).format(dateOnlyToDate(isoDate));
}

// A full timestamp → "Jul 14, 3:05 PM EDT" in NY.
export function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

// A full timestamp → "Jul 14, 3 PM" in NY — compact enough for chart axis ticks.
export function formatShortTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  }).format(new Date(iso));
}

// "18:30" or "18:30:00" → "6:30 PM"; null/empty → "n/a" (return-leg times are
// frequently null and must never crash the render).
export function formatTimeOfDay(value: string | null | undefined): string {
  if (!value) return 'n/a';
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return 'n/a';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return 'n/a';
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${period}`;
}

// Today's date in NY as "YYYY-MM-DD" — the rolling window's start and "today".
export function nyTodayString(now: Date = new Date()): string {
  // en-CA gives ISO-ordered YYYY-MM-DD parts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// Add whole days to a "YYYY-MM-DD" string, returning "YYYY-MM-DD" (window end).
export function addDays(isoDate: string, days: number): string {
  const d = dateOnlyToDate(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Whole hours since an ISO timestamp — drives the stale-data threshold.
export function hoursSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / (1000 * 60 * 60);
}

// "3 hours ago" / "2 days ago" — friendly staleness copy.
export function formatAgo(iso: string | null, now: Date = new Date()): string {
  const hrs = hoursSince(iso, now);
  if (hrs === null) return 'never';
  if (hrs < 1) {
    const mins = Math.max(1, Math.round(hrs * 60));
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  if (hrs < 24) {
    const h = Math.round(hrs);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
