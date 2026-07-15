// Core API handlers — framework-free (ApiRequest + Db in, ApiResponse out). The
// same functions run under Vite dev, Vercel, and Vitest. All timestamp/date/time
// columns are cast to strings in SQL so PGlite and the Neon HTTP driver return
// identical JSON shapes (no driver-dependent Date objects).
import type { ApiRequest, ApiResponse, Db } from './http.js';
import type {
  HistoryPoint,
  OptionHistoryPayload,
  PollerHealth,
  PriceSnapshot,
  Settings,
  SnapshotsPayload,
} from '../lib/types.js';
import { normalize } from '../lib/settingsSchema.js';
import {
  checkPassword,
  clearSessionCookie,
  createSessionCookie,
  isAuthenticated,
} from './auth.js';

const UNAUTHORIZED: ApiResponse = { status: 401, json: { error: 'unauthorized' } };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---- auth routes (no session required) ----

export async function login(ctx: ApiRequest): Promise<ApiResponse> {
  const body = (ctx.body ?? {}) as { password?: unknown };
  if (!checkPassword(body.password)) {
    // generic message — never reveal whether the password was close/long/etc.
    return { status: 401, json: { error: 'invalid_credentials' } };
  }
  return { status: 200, json: { ok: true }, setCookies: [createSessionCookie(nowSeconds())] };
}

export async function logout(): Promise<ApiResponse> {
  return { status: 200, json: { ok: true }, setCookies: [clearSessionCookie()] };
}

export async function session(ctx: ApiRequest): Promise<ApiResponse> {
  return { status: 200, json: { authenticated: isAuthenticated(ctx, nowSeconds()) } };
}

// ---- data routes (session required) ----

const SNAPSHOT_COLS = `
  to_char(scraped_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as scraped_at,
  origin, destination,
  to_char(outbound_date,'YYYY-MM-DD') as outbound_date,
  to_char(return_date,'YYYY-MM-DD') as return_date,
  price_usd, airline, stops,
  to_char(outbound_dep_time,'HH24:MI') as outbound_dep_time,
  to_char(outbound_arr_time,'HH24:MI') as outbound_arr_time,
  to_char(return_dep_time,'HH24:MI') as return_dep_time,
  to_char(return_arr_time,'HH24:MI') as return_arr_time,
  booking_url,
  itinerary_key, outbound_airline, return_airline,
  outbound_flight_numbers, return_flight_numbers,
  outbound_stops, return_stops`;

// Latest snapshot per (origin,destination,outbound_date,return_date) within the
// rolling window [NY today, NY today + window_days]. DISTINCT ON keeps the newest.
const LATEST_SQL = `
  SELECT DISTINCT ON (origin, destination, outbound_date, return_date)
  ${SNAPSHOT_COLS}
  FROM price_snapshots
  WHERE outbound_date >= (now() at time zone 'America/New_York')::date
    AND outbound_date <= (now() at time zone 'America/New_York')::date + $1::int
  ORDER BY origin, destination, outbound_date, return_date, scraped_at DESC`;

const NEWEST_SQL = `
  SELECT to_char(max(scraped_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as newest
  FROM price_snapshots`;

export async function snapshots(ctx: ApiRequest, db: Db): Promise<ApiResponse> {
  if (!isAuthenticated(ctx, nowSeconds())) return UNAUTHORIZED;
  const settings = await readSettingsRow(db);
  const latest = (await db.query<PriceSnapshot>(LATEST_SQL, [settings.window_days])) as PriceSnapshot[];
  const newestRows = await db.query<{ newest: string | null }>(NEWEST_SQL);
  const payload: SnapshotsPayload = {
    latest,
    newest_scraped_at: newestRows[0]?.newest ?? null,
  };
  return { status: 200, json: payload };
}

// ---- per-option history (Phase 5 detail page) ----

// The option's identity is itinerary_key + the exact date pair + airports; the
// route columns lead the WHERE so price_snapshots_itinerary_scraped_idx applies.
const OPTION_WHERE = `
  WHERE origin = $1 AND destination = $2
    AND outbound_date = $3::date AND return_date = $4::date
    AND itinerary_key = $5`;

const OPTION_LATEST_SQL = `
  SELECT ${SNAPSHOT_COLS}
  FROM price_snapshots
  ${OPTION_WHERE}
  ORDER BY scraped_at DESC LIMIT 1`;

// Series bounded to the retention window (90 days) so a driver-side surprise
// can never return unbounded history; oldest first for direct charting.
const OPTION_SERIES_SQL = `
  SELECT
    to_char(scraped_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as scraped_at,
    price_usd
  FROM price_snapshots
  ${OPTION_WHERE}
    AND scraped_at >= now() - interval '90 days'
  ORDER BY scraped_at ASC`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AIRPORT_RE = /^[A-Z]{3}$/;

export async function optionHistory(ctx: ApiRequest, db: Db): Promise<ApiResponse> {
  if (!isAuthenticated(ctx, nowSeconds())) return UNAUTHORIZED;
  const origin = ctx.query.get('origin') ?? '';
  const destination = ctx.query.get('destination') ?? '';
  const outboundDate = ctx.query.get('outbound_date') ?? '';
  const returnDate = ctx.query.get('return_date') ?? '';
  const itineraryKey = ctx.query.get('itinerary_key') ?? '';
  // validate before the ::date casts so a malformed request is a 400, not a 500
  if (
    !AIRPORT_RE.test(origin) ||
    !AIRPORT_RE.test(destination) ||
    !DATE_RE.test(outboundDate) ||
    !DATE_RE.test(returnDate) ||
    itineraryKey.length === 0
  ) {
    return { status: 400, json: { error: 'invalid_params' } };
  }
  const params = [origin, destination, outboundDate, returnDate, itineraryKey];
  const latest = await db.query<PriceSnapshot>(OPTION_LATEST_SQL, params);
  if (latest.length === 0) return { status: 404, json: { error: 'option_not_found' } };
  const rows = await db.query<HistoryPoint>(OPTION_SERIES_SQL, params);
  const payload: OptionHistoryPayload = {
    option: latest[0],
    // price_usd may arrive as a string from the HTTP driver — normalize once here
    points: rows.map((r) => ({ scraped_at: r.scraped_at, price_usd: Number(r.price_usd) })),
  };
  return { status: 200, json: payload };
}

const HEALTH_SQL = `
  SELECT
    to_char(last_success at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_success,
    consecutive_failures
  FROM poller_state WHERE id = 1`;

export async function health(ctx: ApiRequest, db: Db): Promise<ApiResponse> {
  if (!isAuthenticated(ctx, nowSeconds())) return UNAUTHORIZED;
  const rows = await db.query<{ last_success: string | null; consecutive_failures: number }>(
    HEALTH_SQL,
  );
  const newestRows = await db.query<{ newest: string | null }>(NEWEST_SQL);
  const row = rows[0];
  const payload: PollerHealth = {
    last_success: row?.last_success ?? null,
    consecutive_failures: Number(row?.consecutive_failures ?? 0),
    newest_scraped_at: newestRows[0]?.newest ?? null,
  };
  return { status: 200, json: payload };
}

// ---- settings ----

const SETTINGS_SQL = `
  SELECT origins, destinations, preferred_origin, preferred_destination, patterns,
         window_days, threshold_usd, drop_pct, realert_step_pct, realert_step_dollars,
         min_history_days, alert_email, dry_run,
         to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
  FROM settings WHERE id = 1`;

// Parse a Postgres text[] that a driver returned as a literal string ("{JFK,LGA}")
// rather than a JS array. Codes are simple, so a light split is enough.
function pgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') {
    const inner = value.replace(/^\{|\}$/g, '').trim();
    if (!inner) return [];
    return inner.split(',').map((s) => s.replace(/^"|"$/g, '').trim());
  }
  return [];
}

// Raw row → typed Settings, coercing numerics (numeric columns arrive as strings
// from both drivers) and ensuring patterns is an array.
function rowToSettings(row: Record<string, unknown>): Settings {
  const patterns = Array.isArray(row.patterns)
    ? row.patterns
    : typeof row.patterns === 'string'
      ? JSON.parse(row.patterns)
      : [];
  return {
    origins: pgArray(row.origins),
    destinations: pgArray(row.destinations),
    preferred_origin: String(row.preferred_origin ?? 'LGA'),
    preferred_destination: String(row.preferred_destination ?? 'YYZ'),
    patterns,
    window_days: Number(row.window_days ?? 60),
    threshold_usd: Number(row.threshold_usd ?? 250),
    drop_pct: Number(row.drop_pct ?? 20),
    realert_step_pct: Number(row.realert_step_pct ?? 5),
    realert_step_dollars: Number(row.realert_step_dollars ?? 10),
    min_history_days: Number(row.min_history_days ?? 5),
    alert_email: (row.alert_email as string | null) ?? null,
    dry_run: Boolean(row.dry_run),
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

async function readSettingsRow(db: Db): Promise<Settings> {
  const rows = await db.query<Record<string, unknown>>(SETTINGS_SQL);
  return rowToSettings(rows[0] ?? {});
}

export async function getSettings(ctx: ApiRequest, db: Db): Promise<ApiResponse> {
  if (!isAuthenticated(ctx, nowSeconds())) return UNAUTHORIZED;
  return { status: 200, json: await readSettingsRow(db) };
}

// text[] and jsonb are passed as literal strings with explicit casts so the Neon
// HTTP driver and PGlite serialize params identically (neither is relied on to
// auto-convert a JS array/object).
const UPDATE_SETTINGS_SQL = `
  UPDATE settings SET
    origins = $1::text[], destinations = $2::text[], preferred_origin = $3,
    preferred_destination = $4, patterns = $5::jsonb, window_days = $6,
    threshold_usd = $7, drop_pct = $8, realert_step_pct = $9,
    realert_step_dollars = $10, min_history_days = $11, alert_email = $12,
    dry_run = $13, updated_at = now()
  WHERE id = 1`;

// codes come from normalize()'s fixed set, so a simple quoted literal is safe.
function toPgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/"/g, '')}"`).join(',')}}`;
}

export async function putSettings(ctx: ApiRequest, db: Db): Promise<ApiResponse> {
  if (!isAuthenticated(ctx, nowSeconds())) return UNAUTHORIZED;
  // final defense mirroring parse_settings: drops invalid patterns, applies
  // defaults, preserves intentional zeros — regardless of what the form sent.
  const clean = normalize((ctx.body ?? {}) as Record<string, unknown>);
  await db.query(UPDATE_SETTINGS_SQL, [
    toPgArray(clean.origins),
    toPgArray(clean.destinations),
    clean.preferred_origin,
    clean.preferred_destination,
    JSON.stringify(clean.patterns),
    clean.window_days,
    clean.threshold_usd,
    clean.drop_pct,
    clean.realert_step_pct,
    clean.realert_step_dollars,
    clean.min_history_days,
    clean.alert_email,
    clean.dry_run,
  ]);
  return { status: 200, json: await readSettingsRow(db) };
}
