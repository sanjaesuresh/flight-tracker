// Regression lock for the dev-seed booking_url shape: the seed must never
// fabricate a dead `?ref=` Google Flights link (the original bug) and every
// non-null link must be a real, dated Google Flights query URL. At least one
// row must be null so the dashboard's "fare with no link" path stays exercised.
import { describe, expect, it } from 'vitest';
import { createPgliteDb } from '../pglite';
import { dispatch } from '../router';
import type { ApiRequest, Db } from '../http';
import type { SnapshotsPayload } from '../../lib/types';

const PW = 'correct-horse';

function req(partial: Partial<ApiRequest> & { path: string; method: string }): ApiRequest {
  return {
    query: new URLSearchParams(),
    cookies: {},
    body: undefined,
    ...partial,
  };
}

async function loginCookie(db: Db): Promise<Record<string, string>> {
  const res = await dispatch(
    req({ path: '/api/login', method: 'POST', body: { password: PW } }),
    db,
  );
  const token = res.setCookies?.[0]?.value ?? '';
  return { ft_session: token };
}

describe('seed booking_url contract', () => {
  it('never seeds a fabricated ?ref= link, and every link is a dated Google Flights query', async () => {
    process.env.APP_PASSWORD = PW;
    process.env.NODE_ENV = 'test';
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);
    const res = await dispatch(req({ path: '/api/snapshots', method: 'GET', cookies }), db);
    const payload = res.json as SnapshotsPayload;
    expect(payload.latest.length).toBeGreaterThan(0);

    // the bug: seed built `?ref=${origin}${destination}${offset}`, a dead no-dates page
    expect(payload.latest.some((s) => s.booking_url?.includes('?ref='))).toBe(false);

    const withLink = payload.latest.filter((s) => s.booking_url !== null);
    const withoutLink = payload.latest.filter((s) => s.booking_url === null);
    // omit-when-null path must still be reachable in dev
    expect(withoutLink.length).toBeGreaterThan(0);
    expect(withLink.length).toBeGreaterThan(0);
    for (const s of withLink) {
      expect(s.booking_url).toMatch(/^https:\/\/www\.google\.com\/travel\/flights\?q=/);
      // the query text must name both airports so it resolves to a dated,
      // route-specific results page rather than a generic/blank one
      const decoded = decodeURIComponent(s.booking_url!.split('?q=')[1]);
      expect(decoded).toContain(s.origin);
      expect(decoded).toContain(s.destination);
      expect(decoded).toContain(s.outbound_date);
    }
  });
});

describe('seed date-pair alignment (Thu/Fri -> Sun patterns)', () => {
  it('seeds every outbound_date on Thursday or Friday and every return_date on Sunday', async () => {
    process.env.APP_PASSWORD = PW;
    process.env.NODE_ENV = 'test';
    const db = await createPgliteDb('normal');

    // same noon-UTC anchor as timezone.ts / pglite.ts, so a "YYYY-MM-DD" date-only
    // string can't get rolled to an adjacent day by the runner's local zone.
    // NOTE: this is JS Date#getUTCDay() (Sun=0…Sat=6), NOT the poller's
    // Mon=0…Sun=6 convention — Thursday is 4 here, Friday is 5, Sunday is 0.
    const weekdayOf = (isoDate: string): number =>
      new Date(`${isoDate}T12:00:00Z`).getUTCDay();

    const rows = await db.query<{ outbound_date: string; return_date: string }>(
      `SELECT outbound_date::text, return_date::text FROM price_snapshots`,
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const outDow = weekdayOf(row.outbound_date);
      expect([4, 5]).toContain(outDow); // Thursday or Friday
      expect(weekdayOf(row.return_date)).toBe(0); // Sunday

      // each pattern's fixed trip length must still hold: Thu->Sun is a 3-day
      // trip, Fri->Sun is a 2-day trip (the exact bug this test locks in).
      const expectedLength = outDow === 4 ? 3 : 2;
      const out = new Date(`${row.outbound_date}T12:00:00Z`);
      const ret = new Date(`${row.return_date}T12:00:00Z`);
      const diffDays = Math.round((ret.getTime() - out.getTime()) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(expectedLength);
    }
  });
});

describe('seed per-option history shape (Phase 5)', () => {
  it('seeds multi-hour histories, a sparse key, and a null-key fallback row', async () => {
    process.env.APP_PASSWORD = PW;
    process.env.NODE_ENV = 'test';
    const db = await createPgliteDb('normal');

    // per-key row counts across the whole seed
    const counts = await db.query<{ itinerary_key: string | null; n: number }>(
      `SELECT itinerary_key, count(*)::int as n
       FROM price_snapshots GROUP BY itinerary_key`,
    );
    const keyed = counts.filter((c) => c.itinerary_key !== null);
    // real hourly histories: most keys carry several readings at different times
    expect(keyed.filter((c) => c.n >= 3).length).toBeGreaterThan(10);
    // the sparse "just started tracking" state is reachable in dev
    expect(keyed.some((c) => c.n === 1)).toBe(true);
    // the fast-flights fallback (null key) path stays exercised
    expect(counts.some((c) => c.itinerary_key === null)).toBe(true);

    // several DISTINCT itineraries compete within one date-pair
    const perPair = await db.query<{ keys: number }>(
      `SELECT count(DISTINCT itinerary_key)::int as keys
       FROM price_snapshots
       WHERE itinerary_key IS NOT NULL
       GROUP BY origin, destination, outbound_date, return_date
       ORDER BY keys DESC LIMIT 1`,
    );
    expect(perPair[0].keys).toBeGreaterThanOrEqual(2);

    // return-leg times are populated on keyed (fli-style) rows
    const returnTimes = await db.query<{ n: number }>(
      `SELECT count(*)::int as n FROM price_snapshots
       WHERE itinerary_key IS NOT NULL AND return_dep_time IS NULL`,
    );
    expect(returnTimes[0].n).toBe(0);

    // a keyed history varies over time (the chart has an actual shape) at
    // distinct scraped_at instants
    const variance = await db.query<{ prices: number; times: number }>(
      `SELECT count(DISTINCT price_usd)::int as prices,
              count(DISTINCT scraped_at)::int as times
       FROM price_snapshots
       WHERE itinerary_key = (
         SELECT itinerary_key FROM price_snapshots WHERE itinerary_key IS NOT NULL
         GROUP BY itinerary_key ORDER BY count(*) DESC LIMIT 1
       )`,
    );
    expect(variance[0].prices).toBeGreaterThan(2);
    expect(variance[0].times).toBeGreaterThan(2);
  });
});
