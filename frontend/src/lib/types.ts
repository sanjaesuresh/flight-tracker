// Types mirror db/schema.sql exactly. This is the single place the DB row shapes
// are described on the client; every other module imports from here.

// Weekday integers follow the poller's convention (Python): Mon=0 … Sun=6.
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// A trip pattern, as stored in settings.patterns (jsonb). Time windows are local
// "HH:MM" wall-clock strings (America/New_York) or null (unbounded), matching
// poller/db.py _parse_pattern.
export interface Pattern {
  outbound_weekday: number;
  outbound_start: string | null;
  outbound_end: string | null;
  return_weekday: number;
  return_start: string | null;
  return_end: string | null;
}

// The single settings row (id = 1).
export interface Settings {
  origins: string[];
  destinations: string[];
  preferred_origin: string;
  preferred_destination: string;
  patterns: Pattern[];
  window_days: number;
  threshold_usd: number;
  drop_pct: number;
  realert_step_pct: number;
  realert_step_dollars: number;
  min_history_days: number;
  alert_email: string | null;
  dry_run: boolean;
  updated_at: string | null;
}

// The editable subset the settings form sends on PUT. updated_at is server-set.
export type SettingsInput = Omit<Settings, 'updated_at'>;

// One price_snapshots row. airline/stops and all four leg times are nullable —
// old fast-flights rows lack return-leg times; fli rows carry them all.
export interface PriceSnapshot {
  scraped_at: string;
  origin: string;
  destination: string;
  outbound_date: string;
  return_date: string;
  price_usd: number;
  airline: string | null;
  stops: number | null;
  outbound_dep_time: string | null;
  outbound_arr_time: string | null;
  return_dep_time: string | null;
  return_arr_time: string | null;
  booking_url: string | null;
  // Phase 4 additions — null on fast-flights fallback rows. itinerary_key is the
  // stable per-round-trip identity; null means "no per-option history exists".
  itinerary_key: string | null;
  outbound_airline: string | null;
  return_airline: string | null;
  outbound_flight_numbers: string | null;
  return_flight_numbers: string | null;
  outbound_stops: number | null;
  return_stops: number | null;
}

// poller_state (id = 1), the health/staleness signal.
export interface PollerHealth {
  last_success: string | null;
  consecutive_failures: number;
  // newest price_snapshots.scraped_at, the degrade path when last_success is null
  newest_scraped_at: string | null;
}

// ---- Derived UI types ----

// One row in the cheapest-now list: a latest snapshot plus whether its airports
// are the preferred pair (computed from settings, never hard-coded).
export interface RankedOption extends PriceSnapshot {
  preferred: boolean;
}

// A single point on the price graph: an outbound date and the lowest matching
// round-trip price for a series.
export interface GraphPoint {
  outbound_date: string;
  price_usd: number;
}

// One toggleable series on the graph, keyed by O-D pair.
export interface GraphSeries {
  key: string; // e.g. "LGA-YYZ"
  origin: string;
  destination: string;
  points: GraphPoint[];
}

export interface SnapshotsPayload {
  latest: PriceSnapshot[];
  newest_scraped_at: string | null;
}

// One hourly reading in a single option's price history (x = scraped_at).
export interface HistoryPoint {
  scraped_at: string;
  price_usd: number;
}

// /api/option-history response: the option's newest full row (leg detail +
// booking_url) plus its own hourly series, oldest first.
export interface OptionHistoryPayload {
  option: PriceSnapshot;
  points: HistoryPoint[];
}

// Filter state driving the pure filter function (times are "HH:MM" NY local).
export interface FilterState {
  airlines: string[]; // empty = all
  maxStops: number | null; // null = any; 0 = non-stop only
  priceMin: number | null;
  priceMax: number | null;
  outboundDepFrom: string | null;
  outboundDepTo: string | null;
  outboundArrFrom: string | null;
  outboundArrTo: string | null;
  returnDepFrom: string | null;
  returnDepTo: string | null;
  returnArrFrom: string | null;
  returnArrTo: string | null;
}
