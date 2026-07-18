// /api/option-history: public like the other read routes, returns one option's
// newest full row plus its own hourly (scraped_at, price_usd) series — proven
// against the real PGlite schema + seed, same as the other server tests.
import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '../pglite.js';
import { dispatch } from '../router.js';
import type { ApiRequest, Db } from '../http.js';
import type { OptionHistoryPayload } from '../../lib/types.js';

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
  expect(res.status).toBe(200);
  const token = res.setCookies?.[0]?.value ?? '';
  return { ft_session: token };
}

interface SeedIdentity {
  itinerary_key: string;
  origin: string;
  destination: string;
  outbound_date: string;
  return_date: string;
  n: number;
}

// pull a real seeded identity (and its row count) straight from the dev DB so
// the test never hard-codes seed internals like key formats or date offsets
async function seededIdentity(db: Db, minRows: number): Promise<SeedIdentity> {
  const rows = await db.query<SeedIdentity>(
    `SELECT itinerary_key, origin, destination,
            to_char(outbound_date,'YYYY-MM-DD') as outbound_date,
            to_char(return_date,'YYYY-MM-DD') as return_date,
            count(*)::int as n
     FROM price_snapshots
     WHERE itinerary_key IS NOT NULL
     GROUP BY 1,2,3,4,5
     HAVING count(*) >= $1
     ORDER BY n DESC LIMIT 1`,
    [minRows],
  );
  expect(rows.length).toBe(1);
  return rows[0];
}

function query(id: SeedIdentity): URLSearchParams {
  return new URLSearchParams({
    origin: id.origin,
    destination: id.destination,
    outbound_date: id.outbound_date,
    return_date: id.return_date,
    itinerary_key: id.itinerary_key,
  });
}

describe('/api/option-history', () => {
  beforeAll(() => {
    process.env.APP_PASSWORD = PW;
    process.env.NODE_ENV = 'test';
  });

  it('serves the option and its series publicly, with no cookie', async () => {
    const db = await createPgliteDb('normal');
    const id = await seededIdentity(db, 2);
    const res = await dispatch(
      req({ path: '/api/option-history', method: 'GET', query: query(id) }),
      db,
    );
    expect(res.status).toBe(200);
    const payload = res.json as OptionHistoryPayload;
    expect(payload.option.itinerary_key).toBe(id.itinerary_key);
    expect(payload.points.length).toBeGreaterThan(0);
  });

  it('returns the option row and its ascending hourly series', async () => {
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);
    const id = await seededIdentity(db, 3);
    const res = await dispatch(
      req({ path: '/api/option-history', method: 'GET', cookies, query: query(id) }),
      db,
    );
    expect(res.status).toBe(200);
    const payload = res.json as OptionHistoryPayload;

    // the option is the newest full row for exactly this identity
    expect(payload.option.itinerary_key).toBe(id.itinerary_key);
    expect(payload.option.origin).toBe(id.origin);
    expect(payload.option.outbound_date).toBe(id.outbound_date);
    // fli-era rows carry real return-leg times and per-direction detail
    expect(payload.option.return_dep_time).toMatch(/^\d{2}:\d{2}$/);
    expect(payload.option.outbound_airline).toBeTruthy();
    expect(payload.option.outbound_flight_numbers).toBeTruthy();
    // symmetric seed itineraries mirror the return leg's real airports
    // (destination/origin reversed) — this identity picks one of the plain
    // A/B itineraries, never the dedicated mixed-route row (too few readings
    // to win the highest-n query above)
    expect(payload.option.return_origin).toBe(id.destination);
    expect(payload.option.return_destination).toBe(id.origin);

    // one point per seeded row for this key, oldest first, numeric prices
    expect(payload.points.length).toBe(id.n);
    expect(payload.points.length).toBeGreaterThanOrEqual(3);
    const times = payload.points.map((p) => p.scraped_at);
    expect([...times].sort()).toEqual(times);
    for (const p of payload.points) {
      expect(p.scraped_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(typeof p.price_usd).toBe('number');
    }
    // the newest point matches the option row's current price
    expect(payload.points[payload.points.length - 1].price_usd).toBe(payload.option.price_usd);
  });

  it('404s for an itinerary_key with no rows', async () => {
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);
    const id = await seededIdentity(db, 2);
    const res = await dispatch(
      req({
        path: '/api/option-history',
        method: 'GET',
        cookies,
        query: query({ ...id, itinerary_key: 'ZZ9999.2099-01-01|ZZ9998.2099-01-04' }),
      }),
      db,
    );
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'option_not_found' });
  });

  it('400s on missing or malformed params instead of hitting the DB cast', async () => {
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);
    // missing everything
    let res = await dispatch(req({ path: '/api/option-history', method: 'GET', cookies }), db);
    expect(res.status).toBe(400);
    // malformed date
    const id = await seededIdentity(db, 2);
    res = await dispatch(
      req({
        path: '/api/option-history',
        method: 'GET',
        cookies,
        query: query({ ...id, outbound_date: 'not-a-date' }),
      }),
      db,
    );
    expect(res.status).toBe(400);
  });
});
