// In-process Postgres (WASM) for local dev and tests. Runs the project's real
// db/schema.sql, then seeds synthetic snapshots for one of four scenarios so every
// dashboard state is reachable with `SCENARIO=<name> npm run dev`. Server/test only
// — never imported by client code, so it never reaches the browser bundle.
import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from './http';
import { addDays, nyTodayString } from '../lib/timezone';

export type Scenario = 'normal' | 'empty' | 'stale' | 'failing';

// cwd is the frontend/ dir under both `vite dev` and Vitest; the schema lives one
// level up in the repo. Fall back to a repo-root cwd just in case.
function readSchema(): string {
  const candidates = [
    resolve(process.cwd(), '../db/schema.sql'),
    resolve(process.cwd(), 'db/schema.sql'),
  ];
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8');
  throw new Error(`db/schema.sql not found (looked in: ${candidates.join(', ')})`);
}

const SCHEMA_SQL = readSchema();

const ORIGINS = ['JFK', 'LGA'];
const DESTINATIONS = ['YYZ', 'YTZ'];
const AIRLINES = ['Air Canada', 'United', 'Delta', 'Porter'];
// IATA codes matching AIRLINES by index — itinerary keys use codes like fli does.
const CODES = ['AC', 'UA', 'DL', 'PD'];

// JS Date#getUTCDay() convention (Sun=0…Sat=6) — NOT the poller's Mon=0…Sun=6
// convention used in settingsSchema.ts's DEFAULT_PATTERNS. Thursday=3 there is
// Thursday=4 here; Friday=4 there is Friday=5 here. Keep the conversion explicit
// wherever both worlds meet so this file never silently reintroduces the mismatch.
const JS_THURSDAY = 4;
const JS_FRIDAY = 5;
const JS_SUNDAY = 0;

// Walk forward from `from` (a "YYYY-MM-DD") to find the `occurrence`-th
// (0-indexed) date whose JS UTC weekday is `targetDow`, anchored at noon UTC
// like the rest of timezone.ts so no offset can roll it to an adjacent day.
function nthUpcomingWeekday(from: string, targetDow: number, occurrence: number): string {
  let d = from;
  let seen = 0;
  // 60 days covers the whole rolling window with room to spare; bail out well
  // past that so a bug here fails loudly instead of looping forever.
  for (let i = 0; i < 120; i++) {
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === targetDow) {
      if (seen === occurrence) return d;
      seen++;
    }
    d = addDays(d, 1);
  }
  throw new Error(`nthUpcomingWeekday: no match for dow=${targetDow} within window`);
}

// The two configured trip patterns (settingsSchema.ts DEFAULT_PATTERNS), realized
// as actual upcoming date-pairs instead of arbitrary day offsets: real Thursdays
// paired with that week's Sunday (+3d), real Fridays paired with that week's
// Sunday (+2d). Five pairs total — same row-count order of magnitude as the old
// OUTBOUND_OFFSETS — with both pattern shapes represented.
function seedDatePairs(): Array<{ outboundDate: string; returnDate: string }> {
  const today = nyTodayString();
  const pairs: Array<{ outboundDate: string; returnDate: string }> = [];
  for (let k = 0; k < 3; k++) {
    const thu = nthUpcomingWeekday(today, JS_THURSDAY, k);
    const sun = addDays(thu, 3);
    // guard the exact bug this fix closes: a hardcoded "+3" only lands on
    // Sunday because the outbound is really Thursday — assert it explicitly.
    if (new Date(`${sun}T12:00:00Z`).getUTCDay() !== JS_SUNDAY) {
      throw new Error(`seedDatePairs: Thu+3 (${thu} -> ${sun}) did not land on Sunday`);
    }
    pairs.push({ outboundDate: thu, returnDate: sun });
  }
  for (let k = 0; k < 2; k++) {
    const fri = nthUpcomingWeekday(today, JS_FRIDAY, k);
    const sun = addDays(fri, 2);
    if (new Date(`${sun}T12:00:00Z`).getUTCDay() !== JS_SUNDAY) {
      throw new Error(`seedDatePairs: Fri+2 (${fri} -> ${sun}) did not land on Sunday`);
    }
    pairs.push({ outboundDate: fri, returnDate: sun });
  }
  return pairs;
}

function pricesFor(origin: string, destination: string, offset: number): number {
  // preferred LGA→YYZ trends cheapest so the "preferred" boost is visible.
  const base = origin === 'LGA' && destination === 'YYZ' ? 185 : 235;
  return base + (offset % 7) * 9 + (destination === 'YTZ' ? 20 : 0);
}

// One full snapshot row. All Phase 4 fields are explicit params so both keyed
// (fli-style) and null-key (fast-flights fallback) rows go through one path.
interface SeedRow {
  scrapeAgo: string; // self-authored SQL expression, never user input
  origin: string;
  destination: string;
  outboundDate: string; // "YYYY-MM-DD", already pattern-aligned by seedDatePairs
  returnDate: string; // "YYYY-MM-DD", already pattern-aligned by seedDatePairs
  price: number;
  airline: string | null;
  stops: number | null;
  outDep: string | null;
  outArr: string | null;
  retDep: string | null;
  retArr: string | null;
  booking: string | null;
  itineraryKey: string | null;
  outAirline: string | null;
  retAirline: string | null;
  outFlights: string | null;
  retFlights: string | null;
  outStops: number | null;
  retStops: number | null;
}

async function insertSnapshot(pg: PGlite, r: SeedRow): Promise<void> {
  // scrapeAgo is a constant SQL expression (interval math can't be a bound
  // param), interpolated directly; never user input.
  await pg.query(
    `INSERT INTO price_snapshots
       (scraped_at, origin, destination, outbound_date, return_date, price_usd,
        airline, stops, outbound_dep_time, outbound_arr_time, return_dep_time,
        return_arr_time, booking_url, itinerary_key, outbound_airline,
        return_airline, outbound_flight_numbers, return_flight_numbers,
        outbound_stops, return_stops)
     VALUES (${r.scrapeAgo}, $1, $2, $3::date, $4::date,
       $5, $6, $7, $8::time, $9::time, $10::time, $11::time, $12, $13, $14, $15,
       $16, $17, $18, $19)`,
    [
      r.origin,
      r.destination,
      r.outboundDate,
      r.returnDate,
      r.price,
      r.airline,
      r.stops,
      r.outDep,
      r.outArr,
      r.retDep,
      r.retArr,
      r.booking,
      r.itineraryKey,
      r.outAirline,
      r.retAirline,
      r.outFlights,
      r.retFlights,
      r.outStops,
      r.retStops,
    ],
  );
}

// Seed per date-pair (i indexes the 20 O-D×date-pair combinations):
//   - default: TWO distinct itineraries — a single-carrier one with 6 hourly
//     price points and a mixed-carrier one (different airline per direction)
//     with 3 — so per-option charts and min/max/median have real-looking data,
//     and DISTINCT-ON "latest per pair" picks among competing itineraries.
//     Every i%5==2 pair the mixed itinerary is newest, putting mixed carriers
//     on the board so the per-direction airline filter matters in dev.
//   - i==7: ONE itinerary with a single reading — the detail page's sparse
//     "just started tracking" state, reachable straight from the board.
//   - i==13: a fast-flights fallback row — null itinerary_key, null return
//     times, no per-direction fields — the board's no-detail-link + "n/a" path.
// Phase 1 rule stays intact: booking_url is a real dated Google Flights query
// (never `?ref=`), and the i%7==6 pairs (6 and 13) carry a null booking_url.
async function seedSnapshots(pg: PGlite, agoExpr: string): Promise<void> {
  const datePairs = seedDatePairs();
  let i = 0;
  for (const origin of ORIGINS) {
    for (const destination of DESTINATIONS) {
      for (let pairIdx = 0; pairIdx < datePairs.length; pairIdx++) {
        const { outboundDate, returnDate } = datePairs[pairIdx];
        // pairIdx stands in for the old arbitrary day-offset — still just a
        // spread-the-values knob for pricesFor(), no longer a date input.
        const price = pricesFor(origin, destination, pairIdx);
        const outDep = ['07:15', '12:40', '18:30', '21:05'][i % 4];
        const outArr = ['08:50', '14:10', '20:05', '22:35'][i % 4];
        // return-leg times are REAL now (fli carries them); only the i==13
        // fallback row below keeps them null like old fast-flights rows.
        const retDep = ['09:10', '13:45', '17:05', '20:30'][i % 4];
        const retArr = ['10:40', '15:20', '18:35', '22:00'][i % 4];
        const booking =
          i % 7 === 6
            ? null
            : `https://www.google.com/travel/flights?q=${encodeURIComponent(
                `flights from ${origin} to ${destination} on ${outboundDate} through ${returnDate}`,
              )}`;
        const common = {
          origin,
          destination,
          outboundDate,
          returnDate,
          outDep,
          outArr,
          retDep,
          retArr,
          booking,
        };

        if (i === 13) {
          // fast-flights fallback: no per-option identity, no return times
          for (const [scrapeAgo, p] of [
            [`${agoExpr} - interval '6 hours'`, price + 15],
            [agoExpr, price],
          ] as const) {
            await insertSnapshot(pg, {
              ...common,
              scrapeAgo,
              price: p,
              airline: AIRLINES[i % 4],
              stops: 1,
              retDep: null,
              retArr: null,
              itineraryKey: null,
              outAirline: null,
              retAirline: null,
              outFlights: null,
              retFlights: null,
              outStops: null,
              retStops: null,
            });
          }
        } else if (i === 7) {
          // sparse: one reading so far — the single-point chart state
          await insertSnapshot(pg, {
            ...common,
            scrapeAgo: agoExpr,
            price,
            airline: AIRLINES[i % 4],
            stops: 0,
            itineraryKey: `${CODES[i % 4]}${900 + i}.${outboundDate}|${CODES[i % 4]}${1900 + i}.${returnDate}`,
            outAirline: AIRLINES[i % 4],
            retAirline: AIRLINES[i % 4],
            outFlights: String(900 + i),
            retFlights: String(1900 + i),
            outStops: 0,
            retStops: 0,
          });
        } else {
          const mixedNewest = i % 5 === 2;
          // itinerary A — single carrier both ways, 6 hourly readings
          const codeA = CODES[i % 4];
          const keyA = `${codeA}${1100 + i}.${outboundDate}|${codeA}${2200 + i}.${returnDate}`;
          const dipsA: Array<[number, number]> = [
            [5, 18],
            [4, 12],
            [3, 22],
            [2, 9],
            [1, 6],
            [0, 0],
          ];
          for (const [hoursAgo, delta] of dipsA) {
            // when the mixed itinerary should top the board, A stops an hour early
            if (mixedNewest && hoursAgo === 0) continue;
            await insertSnapshot(pg, {
              ...common,
              scrapeAgo: hoursAgo === 0 ? agoExpr : `${agoExpr} - interval '${hoursAgo} hours'`,
              price: price + delta,
              airline: AIRLINES[i % 4],
              stops: i % 3 === 0 ? 0 : 1,
              itineraryKey: keyA,
              outAirline: AIRLINES[i % 4],
              retAirline: AIRLINES[i % 4],
              outFlights: String(1100 + i),
              retFlights: String(2200 + i),
              outStops: i % 3 === 0 ? 0 : 1,
              retStops: 0,
            });
          }
          // itinerary B — mixed carriers per direction, 3 hourly readings
          const outB = AIRLINES[(i + 1) % 4];
          const retB = AIRLINES[(i + 2) % 4];
          const keyB = `${CODES[(i + 1) % 4]}${3300 + i}.${outboundDate}|${CODES[(i + 2) % 4]}${4400 + i}.${returnDate}`;
          const dipsB: Array<[number, number]> = [
            [4, 32],
            [2, 24],
            [mixedNewest ? 0 : 1, 27],
          ];
          for (const [hoursAgo, delta] of dipsB) {
            await insertSnapshot(pg, {
              ...common,
              scrapeAgo: hoursAgo === 0 ? agoExpr : `${agoExpr} - interval '${hoursAgo} hours'`,
              price: price + delta,
              airline: `${outB} / ${retB}`,
              stops: 1,
              itineraryKey: keyB,
              outAirline: outB,
              retAirline: retB,
              outFlights: String(3300 + i),
              retFlights: String(4400 + i),
              outStops: 1,
              retStops: 0,
            });
          }
        }
        i += 1;
      }
    }
  }
}

async function setPollerState(
  pg: PGlite,
  lastSuccessExpr: string | null,
  failures: number,
): Promise<void> {
  const expr = lastSuccessExpr === null ? 'NULL' : lastSuccessExpr;
  await pg.query(
    `UPDATE poller_state SET last_success = ${expr}, consecutive_failures = $1 WHERE id = 1`,
    [failures],
  );
}

export async function createPgliteDb(scenario: Scenario = 'normal'): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(SCHEMA_SQL);

  switch (scenario) {
    case 'empty':
      // fresh project: poller ran but no snapshots written yet.
      await setPollerState(pg, "now() - interval '20 minutes'", 0);
      break;
    case 'stale':
      // data exists but the last successful poll is well past the threshold.
      await seedSnapshots(pg, "now() - interval '30 hours'");
      await setPollerState(pg, "now() - interval '30 hours'", 0);
      break;
    case 'failing':
      // recent-ish data, but consecutive failures are climbing = actively broken.
      await seedSnapshots(pg, "now() - interval '4 hours'");
      await setPollerState(pg, "now() - interval '4 hours'", 5);
      break;
    case 'normal':
    default:
      await seedSnapshots(pg, "now() - interval '35 minutes'");
      await setPollerState(pg, "now() - interval '35 minutes'", 0);
      break;
  }

  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
      const res = await pg.query<T>(text, params as unknown[]);
      return res.rows;
    },
  };
}
