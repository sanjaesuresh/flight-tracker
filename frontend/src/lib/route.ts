// Hash-route helpers for the per-option detail view. The app stays a two-tab
// shell; the one deep route is `#/option?<params>` so board rows can be real
// anchors (back button, middle-click, and copy-link all work) without adding a
// router dependency. itinerary_key can contain `|`/`.`/`+`, so everything goes
// through URLSearchParams encoding.
import type { PriceSnapshot } from './types.js';

// The identity of one flight option: the stable itinerary key plus the exact
// airports and date pair (a key alone is ambiguous across multi-airport pairs).
export interface OptionParams {
  origin: string;
  destination: string;
  outbound_date: string;
  return_date: string;
  itinerary_key: string;
}

const OPTION_PREFIX = '#/option?';

export function optionHash(p: OptionParams): string {
  const q = new URLSearchParams({
    origin: p.origin,
    destination: p.destination,
    out: p.outbound_date,
    ret: p.return_date,
    key: p.itinerary_key,
  });
  return `${OPTION_PREFIX}${q}`;
}

// Convenience for board rows: null when the row has no per-option identity
// (fast-flights fallback rows), so callers can skip the link entirely.
export function optionHashFor(s: PriceSnapshot): string | null {
  if (!s.itinerary_key) return null;
  return optionHash({
    origin: s.origin,
    destination: s.destination,
    outbound_date: s.outbound_date,
    return_date: s.return_date,
    itinerary_key: s.itinerary_key,
  });
}

// App calls parseOptionHash on mount and on every hashchange, so it's the one choke
// point where every route transition passes through — reuse it to remember whether
// the route we're leaving was itself an option route, so the detail page's back link
// can tell "arrived from the board" apart from a deep link / fresh page load.
let hasSeenPriorHash = false;
let priorHashWasOption = false;
let previousWasBoard = false;

export function parseOptionHash(hash: string): OptionParams | null {
  // capture the transition BEFORE recording this call, so it reflects the hash we're
  // arriving from, not the one we're about to parse
  previousWasBoard = hasSeenPriorHash && !priorHashWasOption;

  const parsed = parseOptionHashParams(hash);

  hasSeenPriorHash = true;
  priorHashWasOption = parsed !== null;
  return parsed;
}

function parseOptionHashParams(hash: string): OptionParams | null {
  if (!hash.startsWith(OPTION_PREFIX)) return null;
  const q = new URLSearchParams(hash.slice(OPTION_PREFIX.length));
  const origin = q.get('origin');
  const destination = q.get('destination');
  const out = q.get('out');
  const ret = q.get('ret');
  const key = q.get('key');
  if (!origin || !destination || !out || !ret || !key) return null;
  return {
    origin,
    destination,
    outbound_date: out,
    return_date: ret,
    itinerary_key: key,
  };
}

// true when the hash active immediately before the current one was NOT an option
// route (i.e. the board) — false for a deep link / fresh load, where there is no
// prior hash to compare against.
export function cameFromBoard(): boolean {
  return previousWasBoard;
}
