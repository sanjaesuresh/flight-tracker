// Composes the dashboard: fetches snapshots + health + settings, derives the ranked
// list and graph series from the *filtered* snapshots (so list, graph, and filters
// always agree), and routes to the loading / error / empty / stale / failing states.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api, ApiError } from '../lib/api.js';
import type { FilterState, PollerHealth, Settings, SnapshotsPayload } from '../lib/types.js';
import { applyFilters, buildSeries, distinctAirlines, emptyFilter, rankOptions } from '../lib/filter.js';
import { deriveHealth } from '../lib/health.js';
import { formatFlightDate } from '../lib/timezone.js';
import { optionHashFor } from '../lib/route.js';
import { CheapestList } from '../components/CheapestList.tsx';
import { Filters } from '../components/Filters.tsx';
import { PriceGraph } from '../components/PriceGraph.tsx';
import {
  EmptyState,
  ErrorState,
  FailingBanner,
  LoadingState,
  StaleBanner,
} from '../components/state/States.tsx';

type Status = 'loading' | 'error' | 'ready';
interface Data {
  snapshots: SnapshotsPayload;
  // health/settings are independently-degradable: null means that call failed
  // (non-401) rather than "no data" — callers must not conflate the two.
  health: PollerHealth | null;
  settings: Settings | null;
}

export function Dashboard() {
  const { markLoggedOut } = useAuth();
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<FilterState>(emptyFilter());

  const load = useCallback(async () => {
    setStatus('loading');
    // settle-all: health/settings are supporting signals, not load-bearing — a
    // hiccup in either degrades gracefully instead of blanking the whole board.
    // snapshots is the one call the board can't render without, so it stays fatal.
    const [snapshotsResult, healthResult, settingsResult] = await Promise.allSettled([
      api.snapshots(),
      api.health(),
      api.getSettings(),
    ]);

    // a 401 from ANY call means the session is dead — drop back to login
    // regardless of which endpoint noticed first (existing sign-out path).
    for (const result of [snapshotsResult, healthResult, settingsResult]) {
      if (result.status === 'rejected' && result.reason instanceof ApiError && result.reason.status === 401) {
        markLoggedOut();
        return;
      }
    }

    if (snapshotsResult.status === 'rejected') {
      setStatus('error');
      return;
    }

    setData({
      snapshots: snapshotsResult.value,
      health: healthResult.status === 'fulfilled' ? healthResult.value : null,
      settings: settingsResult.status === 'fulfilled' ? settingsResult.value : null,
    });
    setStatus('ready');
  }, [markLoggedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const derived = useMemo(() => {
    if (!data) return null;
    const filtered = applyFilters(data.snapshots.latest, filter);
    return {
      // no settings → no preferred pair to flag; fall back to a plain price
      // sort (rankOptions' own tiebreak once "preferred" is always false).
      ranked: data.settings
        ? rankOptions(filtered, data.settings)
        : [...filtered].sort((a, b) => a.price_usd - b.price_usd).map((s) => ({ ...s, preferred: false })),
      series: buildSeries(filtered),
      airlines: distinctAirlines(data.snapshots.latest),
      // a failed health fetch means "no signal", not "known stale" — suppress
      // the banner outright rather than guessing staleness from it.
      health: data.health ? deriveHealth(data.health, data.snapshots.newest_scraped_at) : null,
    };
  }, [data, filter]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState onRetry={() => void load()} />;
  if (!data || !derived) return <ErrorState onRetry={() => void load()} />;

  const hasData = data.snapshots.latest.length > 0;
  const { health } = derived;
  // the board's thesis line: the single cheapest fare among what's currently shown.
  const lowest =
    derived.ranked.length > 0
      ? derived.ranked.reduce((a, b) => (b.price_usd < a.price_usd ? b : a))
      : null;

  return (
    <div className="stack">
      {/* visually hidden — the page has no visible title otherwise (the h2s are
          section-level); still needs to be first in the a11y tree */}
      <h1 className="sr-only">Flight watch — fare dashboard</h1>
      {/* failing takes priority over stale — "broken" and "old" are distinct signals.
          health === null means the health call itself failed, not that we know
          anything is stale/failing, so no banner renders at all. */}
      {health?.failing && <FailingBanner lastDataIso={health.lastDataIso} />}
      {health && !health.failing && health.stale && <StaleBanner lastDataIso={health.lastDataIso} />}

      {!hasData ? (
        <EmptyState />
      ) : (
        <div className="dash-grid">
          <Filters filter={filter} onChange={setFilter} airlines={derived.airlines} />
          <div className="stack">
            {lowest && (
              <div className="hero">
                <div className="field-label" style={{ flexBasis: '100%' }}>
                  Lowest right now
                </div>
                <div className="hero-main">
                  <span className="amount">${lowest.price_usd}</span>
                  <div>
                    <div className="hero-route">
                      {lowest.origin} → {lowest.destination}
                    </div>
                    <div className="hero-meta">
                      {formatFlightDate(lowest.outbound_date)} – {formatFlightDate(lowest.return_date)}
                      {' · '}
                      {lowest.airline ?? 'Airline n/a'}
                      {lowest.stops === 0 ? ' · nonstop' : ''}
                      {/* detail link only when the row has a per-option identity */}
                      {optionHashFor(lowest) && (
                        <>
                          {' · '}
                          <a className="detail-link" href={optionHashFor(lowest)!}>
                            Price history
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                {/* booking_url used verbatim; omitted entirely when the row has none */}
                {lowest.booking_url && (
                  <a
                    className="btn btn-primary hero-book"
                    href={lowest.booking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on Google Flights
                  </a>
                )}
              </div>
            )}

            <section className="panel panel-pad" aria-labelledby="graph-h">
              <div className="section-head">
                <h2 id="graph-h">Price trend</h2>
                <span className="field-label">Lowest round-trip by date</span>
              </div>
              <PriceGraph series={derived.series} />
            </section>

            <section aria-labelledby="list-h">
              <div className="section-head">
                <h2 id="list-h">Fare board</h2>
                {/* count changes on every filter tweak — polite so a screen reader
                    announces the new tally without interrupting current focus */}
                <span className="count" aria-live="polite">
                  {derived.ranked.length} of {data.snapshots.latest.length} shown
                </span>
              </div>
              {/* CheapestList only renders when hasData is true, so an empty ranked
                  list here is always a filter mismatch, never "no board data" —
                  safe to always offer the same reset the sidebar's Reset button uses */}
              <CheapestList options={derived.ranked} onClearFilters={() => setFilter(emptyFilter())} />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
