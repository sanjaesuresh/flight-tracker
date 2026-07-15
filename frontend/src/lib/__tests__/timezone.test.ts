import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatFlightDate,
  formatShortDate,
  formatTimeOfDay,
  formatTimestamp,
  hoursSince,
  nyTodayString,
} from '../timezone';

describe('timezone helpers (America/New_York)', () => {
  it('formats a date-only string without rolling to an adjacent day', () => {
    expect(formatShortDate('2026-08-06')).toBe('Aug 6');
    expect(formatFlightDate('2026-08-06')).toBe('Thu, Aug 6');
  });

  it('interprets "today" in NY, not the browser/UTC zone', () => {
    // 03:30 UTC on Jul 14 is still Jul 13 (23:30) in New York (EDT, UTC-4)
    expect(nyTodayString(new Date('2026-07-14T03:30:00Z'))).toBe('2026-07-13');
    // midday UTC lands on the same NY calendar day
    expect(nyTodayString(new Date('2026-07-14T16:00:00Z'))).toBe('2026-07-14');
  });

  it('adds whole days across a month boundary', () => {
    expect(addDays('2026-07-14', 60)).toBe('2026-09-12');
  });

  it('formats time-of-day in 12h and treats null as n/a', () => {
    expect(formatTimeOfDay('18:30')).toBe('6:30 PM');
    expect(formatTimeOfDay('18:30:00')).toBe('6:30 PM');
    expect(formatTimeOfDay('09:05')).toBe('9:05 AM');
    expect(formatTimeOfDay('00:15')).toBe('12:15 AM');
    expect(formatTimeOfDay('12:00')).toBe('12:00 PM');
    expect(formatTimeOfDay(null)).toBe('n/a');
    expect(formatTimeOfDay('')).toBe('n/a');
  });

  it('reflects the DST rule in the zone abbreviation', () => {
    // EDT in July, EST in November — proves the fixed IANA zone is applied
    expect(formatTimestamp('2026-07-14T12:00:00Z')).toContain('EDT');
    expect(formatTimestamp('2026-11-20T12:00:00Z')).toContain('EST');
  });

  it('computes hours since a timestamp', () => {
    const now = new Date('2026-07-14T12:00:00Z');
    expect(hoursSince('2026-07-14T06:00:00Z', now)).toBe(6);
    expect(hoursSince(null, now)).toBeNull();
  });
});
