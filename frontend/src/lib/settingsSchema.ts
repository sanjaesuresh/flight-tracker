// Shared settings-validation contract. Mirrors poller/db.py:parse_settings so the
// form never persists a value the poller would then reject or silently drop.
//
// Two layers:
//   - validateForm(): blocking, per-field errors the form renders inline and that
//     disable Save (e.g. an end-before-start window must be impossible to submit).
//   - normalize(): the poller-mirroring final defense the server applies on PUT —
//     drops invalid patterns, falls back to defaults, preserves intentional zeros.
import type { Pattern, SettingsInput } from './types.js';

export const DEFAULT_THRESHOLD_USD = 250;
export const DEFAULT_WINDOW_DAYS = 60;
export const DEFAULT_DROP_PCT = 20;
export const DEFAULT_REALERT_STEP_PCT = 5;
export const DEFAULT_REALERT_STEP_DOLLARS = 10;
export const DEFAULT_MIN_HISTORY_DAYS = 5;
export const DEFAULT_PREFERRED_ORIGIN = 'LGA';
export const DEFAULT_PREFERRED_DESTINATION = 'YYZ';

// The fixed airport set for now (design-spec: {JFK,LGA} × {YYZ,YTZ}). Rendered as
// data, but the allowed set is fixed until a schema/settings change adds a fifth.
export const FIXED_ORIGINS = ['JFK', 'LGA'] as const;
export const FIXED_DESTINATIONS = ['YYZ', 'YTZ'] as const;

// The two seed patterns (Thu ≥17:00 → Sun any; Fri any → Sun any), matching the
// schema seed and poller DEFAULT_PATTERNS.
export const DEFAULT_PATTERNS: Pattern[] = [
  {
    outbound_weekday: 3,
    outbound_start: '17:00',
    outbound_end: '23:59',
    return_weekday: 6,
    return_start: null,
    return_end: null,
  },
  {
    outbound_weekday: 4,
    outbound_start: null,
    outbound_end: null,
    return_weekday: 6,
    return_start: null,
    return_end: null,
  },
];

// "HH:MM" (or "H:MM") → minutes since midnight, or null for empty/unbounded.
// Returns NaN for a malformed string so callers can reject it.
export function timeToMinutes(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return NaN;
  return h * 60 + min;
}

function normHHMM(value: string | null | undefined): string | null {
  const mins = timeToMinutes(value);
  if (mins === null) return null;
  if (Number.isNaN(mins)) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Returns a human-readable error string if the pattern is invalid, else null.
// Mirrors _parse_pattern: bad weekday / malformed time / end-before-start = invalid.
export function patternError(p: Pattern): string | null {
  for (const wd of [p.outbound_weekday, p.return_weekday]) {
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return 'Weekday must be Mon–Sun.';
  }
  const os = timeToMinutes(p.outbound_start);
  const oe = timeToMinutes(p.outbound_end);
  const rs = timeToMinutes(p.return_start);
  const re = timeToMinutes(p.return_end);
  for (const t of [os, oe, rs, re]) {
    if (typeof t === 'number' && Number.isNaN(t)) return 'Time must be HH:MM (24h).';
  }
  if (os !== null && oe !== null && (oe as number) < (os as number)) {
    return 'Outbound window end is before its start.';
  }
  if (rs !== null && re !== null && (re as number) < (rs as number)) {
    return 'Return window end is before its start.';
  }
  return null;
}

export function emailError(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email === '') return null; // optional
  // deliberately loose: a plausible address, not RFC-perfect.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  return null;
}

export type FieldErrors = Partial<{
  origins: string;
  destinations: string;
  preferred_origin: string;
  preferred_destination: string;
  patterns: string;
  window_days: string;
  threshold_usd: string;
  drop_pct: string;
  realert_step_pct: string;
  realert_step_dollars: string;
  min_history_days: string;
  alert_email: string;
}>;

function nonNegNumberError(v: unknown, label: string): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${label} must be a number.`;
  if (v < 0) return `${label} cannot be negative.`;
  return null;
}

// Blocking form validation. Anything returned here disables Save and shows inline.
export function validateForm(input: SettingsInput): FieldErrors {
  const errors: FieldErrors = {};

  if (!input.origins.length || input.origins.some((o) => !FIXED_ORIGINS.includes(o as never))) {
    errors.origins = 'Pick from JFK / LGA.';
  }
  if (
    !input.destinations.length ||
    input.destinations.some((d) => !FIXED_DESTINATIONS.includes(d as never))
  ) {
    errors.destinations = 'Pick from YYZ / YTZ.';
  }
  if (!input.origins.includes(input.preferred_origin)) {
    errors.preferred_origin = 'Preferred origin must be one of the selected origins.';
  }
  if (!input.destinations.includes(input.preferred_destination)) {
    errors.preferred_destination = 'Preferred destination must be one of the selected destinations.';
  }

  // A pattern with an end-before-start window (or malformed) must block save,
  // rather than being silently dropped like the poller does on read.
  for (const p of input.patterns) {
    const err = patternError(p);
    if (err) {
      errors.patterns = err;
      break;
    }
  }

  // threshold ≤ 0 is invalid (poller falls back to 250); block it in the form.
  if (typeof input.threshold_usd !== 'number' || !Number.isFinite(input.threshold_usd)) {
    errors.threshold_usd = 'Threshold must be a number.';
  } else if (input.threshold_usd <= 0) {
    errors.threshold_usd = 'Threshold must be greater than 0.';
  }

  const wd = nonNegNumberError(input.window_days, 'Window length');
  if (wd) errors.window_days = wd;
  else if (input.window_days < 1) errors.window_days = 'Window length must be at least 1 day.';

  const dp = nonNegNumberError(input.drop_pct, 'Drop %');
  if (dp) errors.drop_pct = dp;
  const rp = nonNegNumberError(input.realert_step_pct, 'Re-alert step %');
  if (rp) errors.realert_step_pct = rp;
  const rd = nonNegNumberError(input.realert_step_dollars, 'Re-alert step $');
  if (rd) errors.realert_step_dollars = rd;
  const mh = nonNegNumberError(input.min_history_days, 'Min history days');
  if (mh) errors.min_history_days = mh;

  const ee = emailError(input.alert_email);
  if (ee) errors.alert_email = ee;

  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

// Server-side final normalization — the poller-mirroring defense on PUT. Drops
// invalid patterns, falls back to defaults, preserves intentional zeros. This is
// what actually gets persisted, regardless of what the form sent.
export function normalize(input: Partial<SettingsInput>): SettingsInput {
  const rawPatterns = Array.isArray(input.patterns) ? input.patterns : [];
  const patterns: Pattern[] = [];
  for (const p of rawPatterns) {
    if (patternError(p) === null) {
      patterns.push({
        outbound_weekday: p.outbound_weekday,
        outbound_start: normHHMM(p.outbound_start),
        outbound_end: normHHMM(p.outbound_end),
        return_weekday: p.return_weekday,
        return_start: normHHMM(p.return_start),
        return_end: normHHMM(p.return_end),
      });
    }
  }
  const finalPatterns = patterns.length ? patterns : DEFAULT_PATTERNS.map((p) => ({ ...p }));

  // threshold ≤ 0 or non-number → 250 (mirrors parse_settings).
  const threshold =
    typeof input.threshold_usd === 'number' &&
    Number.isFinite(input.threshold_usd) &&
    input.threshold_usd > 0
      ? Math.round(input.threshold_usd)
      : DEFAULT_THRESHOLD_USD;

  // `?? default` (not `|| default`) so an intentional 0 is preserved.
  const num = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt;

  const origins = (input.origins ?? [...FIXED_ORIGINS]).filter((o) =>
    FIXED_ORIGINS.includes(o as never),
  );
  const destinations = (input.destinations ?? [...FIXED_DESTINATIONS]).filter((d) =>
    FIXED_DESTINATIONS.includes(d as never),
  );
  const safeOrigins = origins.length ? origins : [...FIXED_ORIGINS];
  const safeDestinations = destinations.length ? destinations : [...FIXED_DESTINATIONS];

  const preferredOrigin = safeOrigins.includes(input.preferred_origin ?? '')
    ? (input.preferred_origin as string)
    : safeOrigins.includes(DEFAULT_PREFERRED_ORIGIN)
      ? DEFAULT_PREFERRED_ORIGIN
      : safeOrigins[0];
  const preferredDestination = safeDestinations.includes(input.preferred_destination ?? '')
    ? (input.preferred_destination as string)
    : safeDestinations.includes(DEFAULT_PREFERRED_DESTINATION)
      ? DEFAULT_PREFERRED_DESTINATION
      : safeDestinations[0];

  const email =
    typeof input.alert_email === 'string' && emailError(input.alert_email) === null && input.alert_email !== ''
      ? input.alert_email
      : null;

  return {
    origins: safeOrigins,
    destinations: safeDestinations,
    preferred_origin: preferredOrigin,
    preferred_destination: preferredDestination,
    patterns: finalPatterns,
    window_days: Math.round(num(input.window_days, DEFAULT_WINDOW_DAYS)),
    threshold_usd: threshold,
    drop_pct: num(input.drop_pct, DEFAULT_DROP_PCT),
    realert_step_pct: num(input.realert_step_pct, DEFAULT_REALERT_STEP_PCT),
    realert_step_dollars: num(input.realert_step_dollars, DEFAULT_REALERT_STEP_DOLLARS),
    min_history_days: Math.round(num(input.min_history_days, DEFAULT_MIN_HISTORY_DAYS)),
    alert_email: email,
    dry_run: typeof input.dry_run === 'boolean' ? input.dry_run : true,
  };
}
