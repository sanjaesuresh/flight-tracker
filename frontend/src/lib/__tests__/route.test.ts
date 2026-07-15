import { describe, expect, it } from 'vitest';
import { optionHash, optionHashFor, parseOptionHash } from '../route.ts';
import type { OptionParams } from '../route.ts';

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
