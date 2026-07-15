import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS,
  DEFAULT_THRESHOLD_USD,
  normalize,
  patternError,
  validateForm,
} from '../settingsSchema.ts';
import type { Pattern, SettingsInput } from '../types.ts';

const pat = (p: Partial<Pattern>): Pattern => ({
  outbound_weekday: 3,
  outbound_start: '17:00',
  outbound_end: '23:59',
  return_weekday: 6,
  return_start: null,
  return_end: null,
  ...p,
});

const input = (p: Partial<SettingsInput>): SettingsInput => ({
  origins: ['JFK', 'LGA'],
  destinations: ['YYZ', 'YTZ'],
  preferred_origin: 'LGA',
  preferred_destination: 'YYZ',
  patterns: [pat({})],
  window_days: 60,
  threshold_usd: 250,
  drop_pct: 20,
  realert_step_pct: 5,
  realert_step_dollars: 10,
  min_history_days: 5,
  alert_email: null,
  dry_run: true,
  ...p,
});

// These mirror poller/db.py:parse_settings so the form and poller stay in lockstep.
describe('patternError (mirrors _parse_pattern)', () => {
  it('accepts a valid pattern', () => {
    expect(patternError(pat({}))).toBeNull();
  });
  it('rejects an outbound window whose end is before its start', () => {
    expect(patternError(pat({ outbound_start: '20:00', outbound_end: '08:00' }))).toMatch(/before/i);
  });
  it('rejects a return window whose end is before its start', () => {
    expect(patternError(pat({ return_start: '18:00', return_end: '09:00' }))).toMatch(/before/i);
  });
  it('rejects a bad weekday and a malformed time', () => {
    expect(patternError(pat({ outbound_weekday: 9 }))).toBeTruthy();
    expect(patternError(pat({ outbound_start: '25:99' }))).toBeTruthy();
  });
});

describe('validateForm (blocking errors)', () => {
  it('is clean for valid input', () => {
    expect(Object.keys(validateForm(input({})))).toHaveLength(0);
  });
  it('flags a non-positive threshold', () => {
    expect(validateForm(input({ threshold_usd: 0 })).threshold_usd).toBeTruthy();
    expect(validateForm(input({ threshold_usd: -5 })).threshold_usd).toBeTruthy();
  });
  it('flags an airport outside the fixed set and a preferred not in the list', () => {
    expect(validateForm(input({ origins: ['EWR'] })).origins).toBeTruthy();
    expect(validateForm(input({ preferred_origin: 'JFK', origins: ['LGA'] })).preferred_origin)
      .toBeTruthy();
  });
  it('flags an implausible email but allows empty', () => {
    expect(validateForm(input({ alert_email: 'nope' })).alert_email).toBeTruthy();
    expect(validateForm(input({ alert_email: null })).alert_email).toBeUndefined();
  });
  it('blocks an end-before-start pattern', () => {
    expect(
      validateForm(input({ patterns: [pat({ outbound_start: '20:00', outbound_end: '08:00' })] }))
        .patterns,
    ).toBeTruthy();
  });
});

describe('normalize (server-side, mirrors parse_settings)', () => {
  it('falls back to the two default patterns when none are valid', () => {
    const out = normalize(input({ patterns: [] }));
    expect(out.patterns).toHaveLength(DEFAULT_PATTERNS.length);
    const allInvalid = normalize(
      input({ patterns: [pat({ outbound_start: '20:00', outbound_end: '08:00' })] }),
    );
    expect(allInvalid.patterns).toHaveLength(2);
  });
  it('drops only the invalid pattern, keeping valid ones', () => {
    const out = normalize(
      input({
        patterns: [pat({}), pat({ outbound_start: '20:00', outbound_end: '08:00' })],
      }),
    );
    expect(out.patterns).toHaveLength(1);
  });
  it('replaces a non-positive threshold with the default', () => {
    expect(normalize(input({ threshold_usd: -5 })).threshold_usd).toBe(DEFAULT_THRESHOLD_USD);
    expect(normalize(input({ threshold_usd: 0 })).threshold_usd).toBe(DEFAULT_THRESHOLD_USD);
  });
  it('preserves intentional zeros (not coerced to defaults)', () => {
    const out = normalize(input({ drop_pct: 0, realert_step_pct: 0, min_history_days: 0 }));
    expect(out.drop_pct).toBe(0);
    expect(out.realert_step_pct).toBe(0);
    expect(out.min_history_days).toBe(0);
  });
  it('strips airports outside the fixed set and repairs the preferred choice', () => {
    const out = normalize(input({ origins: ['EWR', 'LGA'], preferred_origin: 'EWR' }));
    expect(out.origins).toEqual(['LGA']);
    expect(out.preferred_origin).toBe('LGA');
  });
});
