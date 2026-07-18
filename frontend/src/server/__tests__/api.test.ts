// End-to-end server test: real PGlite (real schema), real handlers, real auth.
// Proves the whole data path the SPA depends on before any UI is built on it.
import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '../pglite.js';
import { dispatch } from '../router.js';
import type { ApiRequest, Db } from '../http.js';
import type { PollerHealth, Settings, SnapshotsPayload } from '../../lib/types.js';

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

describe('api server path', () => {
  beforeAll(() => {
    process.env.APP_PASSWORD = PW;
    process.env.NODE_ENV = 'test';
  });

  it('serves the four read routes anonymously (no cookie)', async () => {
    const db = await createPgliteDb('normal');
    expect((await dispatch(req({ path: '/api/snapshots', method: 'GET' }), db)).status).toBe(200);
    expect((await dispatch(req({ path: '/api/health', method: 'GET' }), db)).status).toBe(200);
    expect((await dispatch(req({ path: '/api/settings', method: 'GET' }), db)).status).toBe(200);

    // option-history needs a real identity's query params to reach 200 rather
    // than the 400 (invalid_params) an empty query gets — same identity lookup
    // as optionHistory.test.ts.
    const [row] = await db.query<{
      itinerary_key: string;
      origin: string;
      destination: string;
      outbound_date: string;
      return_date: string;
    }>(
      `SELECT itinerary_key, origin, destination,
              to_char(outbound_date,'YYYY-MM-DD') as outbound_date,
              to_char(return_date,'YYYY-MM-DD') as return_date
       FROM price_snapshots WHERE itinerary_key IS NOT NULL LIMIT 1`,
    );
    const query = new URLSearchParams({
      origin: row.origin,
      destination: row.destination,
      outbound_date: row.outbound_date,
      return_date: row.return_date,
      itinerary_key: row.itinerary_key,
    });
    const historyRes = await dispatch(
      req({ path: '/api/option-history', method: 'GET', query }),
      db,
    );
    expect(historyRes.status).toBe(200);
  });

  it('rejects an anonymous settings write', async () => {
    const db = await createPgliteDb('normal');
    const res = await dispatch(req({ path: '/api/settings', method: 'PUT', body: {} }), db);
    expect(res.status).toBe(401);
  });

  it('redacts alert_email for an anonymous settings read, reveals it once authenticated', async () => {
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);

    // set a real email via an authenticated write first
    const before = (await dispatch(req({ path: '/api/settings', method: 'GET', cookies }), db))
      .json as Settings;
    const written = await dispatch(
      req({
        path: '/api/settings',
        method: 'PUT',
        cookies,
        body: { ...before, alert_email: 'me@example.com' },
      }),
      db,
    );
    expect((written.json as Settings).alert_email).toBe('me@example.com');

    // anonymous read of the same row: every field is public except the email
    const anon = await dispatch(req({ path: '/api/settings', method: 'GET' }), db);
    expect(anon.status).toBe(200);
    const anonSettings = anon.json as Settings;
    expect(anonSettings.alert_email).toBeNull();
    expect(anonSettings.threshold_usd).toBe(before.threshold_usd);

    // authenticated read reveals the real value
    const authed = await dispatch(req({ path: '/api/settings', method: 'GET', cookies }), db);
    expect((authed.json as Settings).alert_email).toBe('me@example.com');
  });

  it('rejects a wrong password', async () => {
    const db = await createPgliteDb('normal');
    const res = await dispatch(
      req({ path: '/api/login', method: 'POST', body: { password: 'nope' } }),
      db,
    );
    expect(res.status).toBe(401);
    expect(res.setCookies).toBeUndefined();
  });

  it('serves snapshots after login (latest per date-pair, in-window)', async () => {
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);
    const res = await dispatch(req({ path: '/api/snapshots', method: 'GET', cookies }), db);
    expect(res.status).toBe(200);
    const payload = res.json as SnapshotsPayload;
    // 4 O-D pairs × 5 outbound offsets = 20 latest date-pairs
    expect(payload.latest.length).toBe(20);
    expect(payload.newest_scraped_at).toBeTruthy();
    // return times are REAL now (fli rows); only the fast-flights fallback row
    // keeps nulls — both shapes must survive serialization
    expect(payload.latest.some((s) => s.return_arr_time !== null)).toBe(true);
    expect(payload.latest.some((s) => s.return_arr_time === null)).toBe(true);
    // Phase 4 identity: most rows carry a key, the fallback row a null one
    expect(payload.latest.some((s) => s.itinerary_key !== null)).toBe(true);
    expect(payload.latest.some((s) => s.itinerary_key === null)).toBe(true);
    // dates come back as plain YYYY-MM-DD strings
    expect(payload.latest[0].outbound_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // mixed-route visibility: the seeded mixed option (out LGA->YYZ, back
    // YTZ->JFK) carries its real return-leg airports; the fast-flights
    // fallback row keeps both null, same as the rest of its nullable fields
    expect(
      payload.latest.some((s) => s.return_origin === 'YTZ' && s.return_destination === 'JFK'),
    ).toBe(true);
    expect(
      payload.latest.some((s) => s.return_origin === null && s.return_destination === null),
    ).toBe(true);
  });

  it('reads and normalizes settings on PUT (drops end-before-start pattern)', async () => {
    const db = await createPgliteDb('normal');
    const cookies = await loginCookie(db);

    const before = (await dispatch(req({ path: '/api/settings', method: 'GET', cookies }), db))
      .json as Settings;
    expect(before.threshold_usd).toBe(250);
    expect(before.patterns.length).toBe(2);

    const res = await dispatch(
      req({
        path: '/api/settings',
        method: 'PUT',
        cookies,
        body: {
          ...before,
          threshold_usd: -5, // invalid → normalized to 250
          patterns: [
            {
              outbound_weekday: 3,
              outbound_start: '20:00',
              outbound_end: '08:00', // end before start → dropped
              return_weekday: 6,
              return_start: null,
              return_end: null,
            },
          ],
        },
      }),
      db,
    );
    expect(res.status).toBe(200);
    const after = res.json as Settings;
    expect(after.threshold_usd).toBe(250);
    // the only pattern was invalid → fell back to the two seed defaults
    expect(after.patterns.length).toBe(2);
    expect(after.updated_at).toBeTruthy();
  });

  it('reports poller health for the failing scenario', async () => {
    const db = await createPgliteDb('failing');
    const cookies = await loginCookie(db);
    const res = await dispatch(req({ path: '/api/health', method: 'GET', cookies }), db);
    const health = res.json as PollerHealth;
    expect(health.consecutive_failures).toBe(5);
    expect(health.last_success).toBeTruthy();
  });

  it('returns empty snapshots for the empty scenario', async () => {
    const db = await createPgliteDb('empty');
    const cookies = await loginCookie(db);
    const res = await dispatch(req({ path: '/api/snapshots', method: 'GET', cookies }), db);
    const payload = res.json as SnapshotsPayload;
    expect(payload.latest.length).toBe(0);
    expect(payload.newest_scraped_at).toBeNull();
  });
});
