// Pure, framework-free snapshot logic: filtering, graph aggregation, and ranking.
// Unit-tested independently of any component. The one rule to remember: a bounded
// time-of-day (or stops) filter treats an UNKNOWN (null) value as a pass, never a
// hide — return-leg times are frequently null and must not silently disappear.
import type {
  FilterState,
  GraphSeries,
  HistoryPoint,
  PriceSnapshot,
  RankedOption,
  Settings,
} from './types.js';

// "18:30", "18:30:00" → minutes since midnight; null/malformed → null (unknown).
function toMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// True if a snapshot leg time falls within [from,to] inclusive. A null (unknown)
// time PASSES — we never hide an option just because a leg time wasn't scraped.
function withinWindow(
  time: string | null,
  from: string | null,
  to: string | null,
): boolean {
  if (!from && !to) return true; // no bound set
  const t = toMinutes(time);
  if (t === null) return true; // unknown time is never excluded by a bound
  const lo = toMinutes(from);
  const hi = toMinutes(to);
  if (lo !== null && t < lo) return false;
  if (hi !== null && t > hi) return false;
  return true;
}

// All carriers on a snapshot, one per direction where known. fli rows can mix
// carriers per direction ("United / Air Canada" combined), so we split the
// per-direction fields (or the combined field on old rows) on the poller's
// " / " join — an airline filter then matches EITHER direction's carrier.
export function snapshotAirlines(s: PriceSnapshot): string[] {
  const raw =
    s.outbound_airline || s.return_airline
      ? [s.outbound_airline, s.return_airline]
      : [s.airline];
  const set = new Set<string>();
  for (const value of raw) {
    if (!value) continue;
    for (const part of value.split(' / ')) {
      const name = part.trim();
      if (name) set.add(name);
    }
  }
  return [...set];
}

export function applyFilters(snapshots: PriceSnapshot[], f: FilterState): PriceSnapshot[] {
  return snapshots.filter((s) => {
    if (f.airlines.length > 0) {
      // an unknown airline can't match a chosen airline, so it's excluded here.
      const carriers = snapshotAirlines(s);
      if (!f.airlines.some((a) => carriers.includes(a))) return false;
    }
    if (f.stops !== null) {
      // unknown stop count passes a bounded stops filter (never hidden). 2 is the
      // "2 or more" bucket; 0 and 1 match exactly.
      if (s.stops !== null) {
        if (f.stops === 2 ? s.stops < 2 : s.stops !== f.stops) return false;
      }
    }
    if (f.priceMin !== null && s.price_usd < f.priceMin) return false;
    if (f.priceMax !== null && s.price_usd > f.priceMax) return false;
    // travel-date windows: outbound_date/return_date are non-null "YYYY-MM-DD",
    // which sort lexicographically, so string compare is a correct date compare.
    if (f.outboundDateFrom && s.outbound_date < f.outboundDateFrom) return false;
    if (f.outboundDateTo && s.outbound_date > f.outboundDateTo) return false;
    if (f.returnDateFrom && s.return_date < f.returnDateFrom) return false;
    if (f.returnDateTo && s.return_date > f.returnDateTo) return false;
    if (!withinWindow(s.outbound_dep_time, f.outboundDepFrom, f.outboundDepTo)) return false;
    if (!withinWindow(s.outbound_arr_time, f.outboundArrFrom, f.outboundArrTo)) return false;
    if (!withinWindow(s.return_dep_time, f.returnDepFrom, f.returnDepTo)) return false;
    if (!withinWindow(s.return_arr_time, f.returnArrFrom, f.returnArrTo)) return false;
    return true;
  });
}

export function odKey(origin: string, destination: string): string {
  return `${origin}-${destination}`;
}

// Graph: per O-D pair, the lowest matching round-trip price for each outbound date.
// Derived from whatever snapshots are passed in (already filtered), so the graph,
// list, and filters stay in sync.
export function buildSeries(snapshots: PriceSnapshot[]): GraphSeries[] {
  const byOd = new Map<string, Map<string, PriceSnapshot>>();
  for (const s of snapshots) {
    const key = odKey(s.origin, s.destination);
    let dateMap = byOd.get(key);
    if (!dateMap) {
      dateMap = new Map();
      byOd.set(key, dateMap);
    }
    const prev = dateMap.get(s.outbound_date);
    // keep the whole snapshot (not just its price) so the graph can describe the
    // winning flight; ties break on scraped_at, ISO strings compare correctly as strings.
    if (
      prev === undefined ||
      s.price_usd < prev.price_usd ||
      (s.price_usd === prev.price_usd && s.scraped_at > prev.scraped_at)
    ) {
      dateMap.set(s.outbound_date, s);
    }
  }
  const series: GraphSeries[] = [];
  for (const [key, dateMap] of byOd) {
    const [origin, destination] = key.split('-');
    const points = [...dateMap.entries()]
      .map(([outbound_date, flight]) => ({ outbound_date, price_usd: flight.price_usd, flight }))
      .sort((a, b) => a.outbound_date.localeCompare(b.outbound_date));
    series.push({ key, origin, destination, points });
  }
  return series.sort((a, b) => a.key.localeCompare(b.key));
}

// Cheapest-now ranking. Preferred O-D (from settings, never hard-coded) is boosted
// to the top as a tiebreak, then price ascending — preferred first, never exclusive.
export function rankOptions(snapshots: PriceSnapshot[], settings: Settings): RankedOption[] {
  return snapshots
    .map((s) => ({
      ...s,
      preferred:
        s.origin === settings.preferred_origin &&
        s.destination === settings.preferred_destination,
    }))
    .sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      return a.price_usd - b.price_usd;
    });
}

export function distinctAirlines(snapshots: PriceSnapshot[]): string[] {
  const set = new Set<string>();
  // per-carrier (not per-combination) so "United / Air Canada" rows appear
  // under both carriers' checkboxes instead of as a third pseudo-airline.
  for (const s of snapshots) for (const a of snapshotAirlines(s)) set.add(a);
  return [...set].sort();
}

// Min / max / median over one option's own history (the detail page's "current
// vs its own history" read). Median of an even count is the mean of the two
// middles, rounded to whole dollars like every other price on the board.
export interface HistoryStats {
  min: number;
  max: number;
  median: number;
  count: number;
}

export function historyStats(points: HistoryPoint[]): HistoryStats | null {
  if (points.length === 0) return null;
  const prices = points.map((p) => p.price_usd).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 1 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
  return {
    min: prices[0],
    max: prices[prices.length - 1],
    median,
    count: prices.length,
  };
}

export function emptyFilter(): FilterState {
  return {
    airlines: [],
    stops: null,
    priceMin: null,
    priceMax: null,
    outboundDateFrom: null,
    outboundDateTo: null,
    returnDateFrom: null,
    returnDateTo: null,
    outboundDepFrom: null,
    outboundDepTo: null,
    outboundArrFrom: null,
    outboundArrTo: null,
    returnDepFrom: null,
    returnDepTo: null,
    returnArrFrom: null,
    returnArrTo: null,
  };
}

// every field is a primitive or an array that's only ever [] when unset, so a
// JSON-string compare against the canonical empty state is an exact equality check.
export function isEmptyFilter(f: FilterState): boolean {
  return JSON.stringify(f) === JSON.stringify(emptyFilter());
}
