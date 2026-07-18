import { describe, expect, it } from 'vitest';
import { isMixedReturn, optionHash, optionHashFor, parseOptionHash } from '../route.js';
import type { OptionParams } from '../route.js';
import type { PriceSnapshot } from '../types.js';

const params: OptionParams = {
  origin: 'JFK',
  destination: 'YTZ',
  outbound_date: '2026-08-06',
  return_date: '2026-08-09',
  // real key shape: carrier+number.date, "|" between directions, "+" within one
  itinerary_key: 'UA1023.2026-08-06|AC8811+AC124.2026-08-09',
};

describe('option hash route', () => {
  it('round-trips params through the hash, key punctuation intact', () => {
    expect(parseOptionHash(optionHash(params))).toEqual(params);
  });

  it('returns null for non-option hashes and incomplete params', () => {
    expect(parseOptionHash('')).toBeNull();
    expect(parseOptionHash('#/')).toBeNull();
    expect(parseOptionHash('#/option?origin=JFK')).toBeNull();
  });

  it('optionHashFor yields null for a null itinerary_key (no fabricated route)', () => {
    const row = {
      ...params,
      itinerary_key: null,
    } as unknown as Parameters<typeof optionHashFor>[0];
    expect(optionHashFor(row)).toBeNull();
  });
});

// only the four fields isMixedReturn reads are relevant, so the truth table casts
// a minimal partial rather than building a full PriceSnapshot fixture each time.
const mixedRow = (p: Partial<PriceSnapshot>): PriceSnapshot =>
  ({ origin: 'LGA', destination: 'YYZ', ...p }) as unknown as PriceSnapshot;

describe('isMixedReturn', () => {
  it('is false when both return airports are null', () => {
    expect(isMixedReturn(mixedRow({ return_origin: null, return_destination: null }))).toBe(false);
  });

  it('is false for a mirrored pair (return leg is the exact reverse of the outbound)', () => {
    expect(
      isMixedReturn(mixedRow({ return_origin: 'YYZ', return_destination: 'LGA' })),
    ).toBe(false);
  });

  it('is true when the return origin differs from the outbound destination', () => {
    expect(
      isMixedReturn(mixedRow({ return_origin: 'YTZ', return_destination: 'LGA' })),
    ).toBe(true);
  });

  it('is true when the return destination differs from the outbound origin', () => {
    expect(
      isMixedReturn(mixedRow({ return_origin: 'YYZ', return_destination: 'JFK' })),
    ).toBe(true);
  });
});
