// Turns the raw poller-health signal into the dashboard's banner state. Two
// independent conditions the user must be able to tell apart:
//   - stale: the freshest data we have is older than STALE_HOURS (old data).
//   - failing: consecutive poll failures have crossed FAIL_THRESHOLD (actively
//     broken) — a distinct, louder signal than merely stale.
import type { PollerHealth } from './types.ts';
import { hoursSince } from './timezone.ts';

// N-hour staleness threshold. The poller runs ~hourly; 6h means several polls in a
// row produced nothing. Documented in the README and kept near the poller's notion.
export const STALE_HOURS = 6;
// consecutive failures at/above this read as "actively broken", not just stale.
export const FAIL_THRESHOLD = 3;

export interface HealthState {
  failing: boolean;
  stale: boolean;
  // the timestamp the banners quote as "last updated" (last success, else newest row)
  lastDataIso: string | null;
}

export function deriveHealth(
  health: PollerHealth | null,
  newestScrapedAt: string | null,
  now: Date = new Date(),
): HealthState {
  const lastSuccess = health?.last_success ?? null;
  // prefer the poller's own last-success; fall back to the newest snapshot's time.
  const lastDataIso = lastSuccess ?? newestScrapedAt ?? null;
  const hrs = hoursSince(lastDataIso, now);
  return {
    failing: (health?.consecutive_failures ?? 0) >= FAIL_THRESHOLD,
    stale: hrs !== null && hrs > STALE_HOURS,
    lastDataIso,
  };
}
