// Composes the dashboard: fetches snapshots + health + settings, derives the ranked
// list and graph series from the *filtered* snapshots (so list, graph, and filters
// always agree), and routes to the loading / error / empty / stale / failing states.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api, ApiError } from '../lib/api.ts';
import type { FilterState, PollerHealth, Settings, SnapshotsPayload } from '../lib/types.ts';
import { applyFilters, buildSeries, distinctAirlines, emptyFilter, rankOptions } from '../lib/filter.ts';
import { deriveHealth } from '../lib/health.ts';
import { formatFlightDate } from '../lib/timezone.ts';
import { optionHashFor } from '../lib/route.ts';
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
  health: PollerHealth;
  settings: Settings;
}

export function Dashboard() {
  const { markLoggedOut } = useAuth();
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<FilterState>(emptyFilter());

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [snapshots, health, settings] = await Promise.all([
        api.snapshots(),
        api.health(),
        api.getSettings(),
      ]);
      setData({ snapshots, health, settings });
      setStatus('ready');
    } catch (err) {
      // an expired session anywhere drops the whole app back to login.
      if (err instanceof ApiError && err.status === 401) {
        markLoggedOut();
        return;
      }
      setStatus('error');
    }
  }, [markLoggedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const derived = useMemo(() => {
    if (!data) return null;
    const filtered = applyFilters(data.snapshots.latest, filter);
    return {
      ranked: rankOptions(filtered, data.settings),
      series: buildSeries(filtered),
      airlines: distinctAirlines(data.snapshots.latest),
      health: deriveHealth(data.health, data.snapshots.newest_scraped_at),
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
      {/* failing takes priority over stale — "broken" and "old" are distinct signals */}
      {health.failing && <FailingBanner lastDataIso={health.lastDataIso} />}
      {!health.failing && health.stale && <StaleBanner lastDataIso={health.lastDataIso} />}

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
                <span className="count">
                  {derived.ranked.length} of {data.snapshots.latest.length} shown
                </span>
              </div>
              <CheapestList options={derived.ranked} />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
