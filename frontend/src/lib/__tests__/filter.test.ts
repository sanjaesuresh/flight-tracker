import { describe, expect, it } from 'vitest';
import { applyFilters, buildSeries, distinctAirlines, historyStats, rankOptions } from '../filter.js';
import type { FilterState, PriceSnapshot, Settings } from '../types.js';
import { emptyFilter, isEmptyFilter } from '../filter.js';

function snap(p: Partial<PriceSnapshot>): PriceSnapshot {
  return {
    scraped_at: '2026-07-14T12:00:00Z',
    origin: 'LGA',
    destination: 'YYZ',
    outbound_date: '2026-08-06',
    return_date: '2026-08-09',
    price_usd: 200,
    airline: 'Air Canada',
    stops: 0,
    outbound_dep_time: '18:30',
    outbound_arr_time: '20:00',
    return_dep_time: null,
    return_arr_time: null,
    booking_url: 'http://x',
    itinerary_key: null,
    outbound_airline: null,
    return_airline: null,
    outbound_flight_numbers: null,
    return_flight_numbers: null,
    outbound_stops: null,
    return_stops: null,
    ...p,
  };
}

const F = (p: Partial<FilterState>): FilterState => ({ ...emptyFilter(), ...p });

describe('applyFilters', () => {
  it('passes everything through with an empty filter', () => {
    const rows = [snap({}), snap({ price_usd: 300 })];
    expect(applyFilters(rows, emptyFilter())).toHaveLength(2);
  });

  it('filters by airline set', () => {
    const rows = [snap({ airline: 'United' }), snap({ airline: 'Delta' })];
    expect(applyFilters(rows, F({ airlines: ['Delta'] }))).toHaveLength(1);
  });

  it('matches a mixed-carrier row on EITHER direction carrier', () => {
    const mixed = snap({
      airline: 'United / Air Canada',
      outbound_airline: 'United',
      return_airline: 'Air Canada',
    });
    // matches via the return leg's carrier
    expect(applyFilters([mixed], F({ airlines: ['Air Canada'] }))).toHaveLength(1);
    // matches via the outbound leg's carrier
    expect(applyFilters([mixed], F({ airlines: ['United'] }))).toHaveLength(1);
    // a carrier on neither direction does not match
    expect(applyFilters([mixed], F({ airlines: ['Porter'] }))).toHaveLength(0);
  });

  it('a return-departure window bites now that return times are real', () => {
    const rows = [
      snap({ price_usd: 100, return_dep_time: '08:00' }), // before window → dropped
      snap({ price_usd: 200, return_dep_time: '19:20' }), // inside → kept
    ];
    const out = applyFilters(rows, F({ returnDepFrom: '17:00', returnDepTo: '23:59' }));
    expect(out.map((s) => s.price_usd)).toEqual([200]);
  });

  it('exact 0-stops bucket keeps stops=0 and unknown, drops stops>=1', () => {
    const rows = [snap({ stops: 0 }), snap({ stops: 1 }), snap({ stops: null })];
    const out = applyFilters(rows, F({ stops: 0 }));
    // stops=0 kept, stops=1 dropped, stops=null (unknown) kept — never hidden
    expect(out).toHaveLength(2);
    expect(out.some((s) => s.stops === null)).toBe(true);
  });

  it('exact 1-stop bucket keeps only stops=1 (and unknown)', () => {
    const rows = [snap({ stops: 0 }), snap({ stops: 1 }), snap({ stops: 2 }), snap({ stops: null })];
    const out = applyFilters(rows, F({ stops: 1 }));
    // exact match on 1, plus the unknown that's never hidden
    expect(out.map((s) => s.stops).sort()).toEqual([1, null]);
  });

  it('2+ bucket keeps stops>=2 (and unknown), drops 0 and 1', () => {
    const rows = [snap({ stops: 0 }), snap({ stops: 1 }), snap({ stops: 2 }), snap({ stops: 3 }), snap({ stops: null })];
    const out = applyFilters(rows, F({ stops: 2 }));
    expect(out.map((s) => s.stops).sort()).toEqual([2, 3, null]);
  });

  it('bounds outbound and return travel dates inclusively', () => {
    const rows = [
      snap({ outbound_date: '2026-08-01', return_date: '2026-08-05' }), // before outbound window
      snap({ outbound_date: '2026-08-10', return_date: '2026-08-14' }), // inside both
      snap({ outbound_date: '2026-08-12', return_date: '2026-08-30' }), // return after window
    ];
    const out = applyFilters(
      rows,
      F({
        outboundDateFrom: '2026-08-06',
        outboundDateTo: '2026-08-15',
        returnDateFrom: '2026-08-06',
        returnDateTo: '2026-08-20',
      }),
    );
    expect(out.map((s) => s.outbound_date)).toEqual(['2026-08-10']);
  });

  it('applies inclusive price bounds', () => {
    const rows = [snap({ price_usd: 150 }), snap({ price_usd: 200 }), snap({ price_usd: 250 })];
    expect(applyFilters(rows, F({ priceMin: 200, priceMax: 250 }))).toHaveLength(2);
  });

  it('a return-arrival window excludes an out-of-range option but KEEPS a null return time', () => {
    const rows = [
      snap({ price_usd: 120, return_arr_time: '23:30' }), // outside 06:00–12:00
      snap({ price_usd: 130, return_arr_time: '10:00' }), // inside
      snap({ price_usd: 110, return_arr_time: null }), // unknown → must be kept
    ];
    const out = applyFilters(rows, F({ returnArrFrom: '06:00', returnArrTo: '12:00' }));
    const prices = out.map((s) => s.price_usd).sort();
    expect(prices).toEqual([110, 130]); // the null-return-time cheap one survives
  });
});

describe('distinctAirlines', () => {
  it('splits mixed-carrier rows into per-carrier entries, deduped and sorted', () => {
    const rows = [
      snap({ airline: 'United / Air Canada', outbound_airline: 'United', return_airline: 'Air Canada' }),
      snap({ airline: 'United' }),
    ];
    expect(distinctAirlines(rows)).toEqual(['Air Canada', 'United']);
  });
});

describe('historyStats', () => {
  const pt = (price_usd: number, i: number) => ({
    scraped_at: `2026-07-15T0${i}:00:00Z`,
    price_usd,
  });

  it('computes min/max/median over an odd-count series', () => {
    expect(historyStats([pt(200, 1), pt(180, 2), pt(240, 3)])).toEqual({
      min: 180,
      max: 240,
      median: 200,
      count: 3,
    });
  });

  it('averages the two middles on an even count and handles a single point', () => {
    expect(historyStats([pt(200, 1), pt(210, 2)])?.median).toBe(205);
    expect(historyStats([pt(199, 1)])).toEqual({ min: 199, max: 199, median: 199, count: 1 });
    expect(historyStats([])).toBeNull();
  });
});

describe('buildSeries', () => {
  it('groups by O-D and takes the min price per outbound date', () => {
    const rows = [
      snap({ origin: 'LGA', destination: 'YYZ', outbound_date: '2026-08-06', price_usd: 210 }),
      snap({ origin: 'LGA', destination: 'YYZ', outbound_date: '2026-08-06', price_usd: 180 }),
      snap({ origin: 'JFK', destination: 'YTZ', outbound_date: '2026-08-06', price_usd: 300 }),
    ];
    const series = buildSeries(rows);
    expect(series).toHaveLength(2);
    const lga = series.find((s) => s.key === 'LGA-YYZ')!;
    expect(lga.points[0].price_usd).toBe(180);
  });
});

describe('buildSeries point.flight', () => {
  it('a point carries the cheapest snapshot for its route and date', () => {
    const rows = [
      snap({ price_usd: 250, airline: 'United' }),
      snap({ price_usd: 199, airline: 'Delta' }),
      snap({ price_usd: 230, airline: 'Air Canada' }),
    ];
    const series = buildSeries(rows);
    const points = series.find((s) => s.key === 'LGA-YYZ')!.points;
    expect(points).toHaveLength(1);
    expect(points[0].price_usd).toBe(199);
    expect(points[0].flight.airline).toBe('Delta');
  });

  it('among equal cheapest prices the most recently scraped snapshot wins', () => {
    const rows = [
      snap({ price_usd: 200, airline: 'Delta', scraped_at: '2026-07-14T18:00:00Z' }),
      snap({ price_usd: 200, airline: 'United', scraped_at: '2026-07-14T10:00:00Z' }),
    ];
    const series = buildSeries(rows);
    const points = series.find((s) => s.key === 'LGA-YYZ')!.points;
    expect(points).toHaveLength(1);
    expect(points[0].flight.scraped_at).toBe('2026-07-14T18:00:00Z');
  });
});

describe('isEmptyFilter', () => {
  it('is true for a freshly-built empty filter', () => {
    expect(isEmptyFilter(emptyFilter())).toBe(true);
  });

  it('is false once any single field is set', () => {
    expect(isEmptyFilter(F({ priceMax: 300 }))).toBe(false);
    expect(isEmptyFilter(F({ airlines: ['Delta'] }))).toBe(false);
    expect(isEmptyFilter(F({ stops: 0 }))).toBe(false);
  });
});

describe('rankOptions', () => {
  const settings = { preferred_origin: 'LGA', preferred_destination: 'YYZ' } as Settings;

  it('boosts the preferred O-D first, then sorts by price', () => {
    const rows = [
      snap({ origin: 'JFK', destination: 'YTZ', price_usd: 150 }), // cheaper, not preferred
      snap({ origin: 'LGA', destination: 'YYZ', price_usd: 220 }), // preferred
    ];
    const ranked = rankOptions(rows, settings);
    expect(ranked[0].preferred).toBe(true); // preferred first despite higher price
    expect(ranked[1].preferred).toBe(false); // non-preferred still present, never hidden
  });
});
