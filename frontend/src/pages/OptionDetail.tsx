// Per-option detail: one tracked itinerary (keyed by itinerary_key + airports +
// date pair) with both legs' particulars, the verbatim booking link, and the
// option's own hourly price history (chart + min/median/max). Fetches through
// the authenticated /api/option-history route — the browser never sees the DB.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api, ApiError } from '../lib/api.js';
import { cameFromBoard, type OptionParams } from '../lib/route.js';
import type { OptionHistoryPayload, PriceSnapshot } from '../lib/types.js';
import { historyStats } from '../lib/filter.js';
import { formatFlightDate, formatTimeOfDay, formatTimestamp } from '../lib/timezone.js';
import { OptionPriceChart } from '../components/OptionPriceChart.tsx';
import { ErrorState, OptionNotFoundState } from '../components/state/States.tsx';

type Status = 'loading' | 'error' | 'not_found' | 'ready';

function stopsText(stops: number | null): string {
  if (stops === null) return 'stops n/a';
  if (stops === 0) return 'Nonstop';
  return `${stops} stop${stops === 1 ? '' : 's'}`;
}

// One direction's card. Every field degrades to "n/a" — old fast-flights rows
// carry nulls for return times and all per-direction columns.
function LegCard({
  title,
  date,
  dep,
  arr,
  airline,
  flightNumbers,
  stops,
}: {
  title: string;
  date: string;
  dep: string | null;
  arr: string | null;
  airline: string | null;
  flightNumbers: string | null;
  stops: number | null;
}) {
  return (
    <section className="panel panel-pad leg-card" aria-label={`${title} leg`}>
      <div className="section-head" style={{ marginBottom: '0.6rem' }}>
        <h3>{title}</h3>
        <span className="field-label">{formatFlightDate(date)}</span>
      </div>
      <div className="leg-times-line mono">
        {formatTimeOfDay(dep)} <span className="seg">→</span> {formatTimeOfDay(arr)}
      </div>
      <dl className="leg-facts">
        <div>
          <dt>Airline</dt>
          <dd>{airline ?? 'n/a'}</dd>
        </div>
        <div>
          <dt>Flight</dt>
          <dd className="mono">{flightNumbers ? flightNumbers.split('+').join(' · ') : 'n/a'}</dd>
        </div>
        <div>
          <dt>Stops</dt>
          <dd>{stopsText(stops)}</dd>
        </div>
      </dl>
    </section>
  );
}

function LoadingDetail() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading price history…</span>
      <div className="skeleton" style={{ height: 96 }} />
      <div className="skeleton" style={{ height: 140 }} />
      <div className="skeleton" style={{ height: 240 }} />
    </div>
  );
}

export function OptionDetail({ params }: { params: OptionParams }) {
  const { markLoggedOut } = useAuth();
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<OptionHistoryPayload | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const payload = await api.optionHistory(params);
      setData(payload);
      setStatus('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        markLoggedOut();
        return;
      }
      // a stale or mistyped link is its own state, distinct from "server down"
      if (err instanceof ApiError && err.status === 404) {
        setStatus('not_found');
        return;
      }
      setStatus('error');
    }
  }, [params, markLoggedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  // route-change focus management: land keyboard/AT users on the page heading
  useEffect(() => {
    if (status === 'ready') headingRef.current?.focus();
  }, [status]);

  if (status === 'loading') return <LoadingDetail />;
  if (status === 'not_found') return <OptionNotFoundState />;
  if (status === 'error' || !data) return <ErrorState onRetry={() => void load()} />;

  const o: PriceSnapshot = data.option;
  const stats = historyStats(data.points);
  const label = `${o.origin} to ${o.destination}, ${formatFlightDate(o.outbound_date)} to ${formatFlightDate(o.return_date)}`;
  const first = data.points[0] ?? null;
  const last = data.points[data.points.length - 1] ?? null;

  return (
    <div className="stack">
      <nav aria-label="Breadcrumb">
        {/* real history.back() restores the board's scroll position; the href stays
            so middle-click/open-in-new-tab still work, and deep links fall through to it */}
        <a
          className="back-link"
          href="#/"
          onClick={(e) => {
            // modified clicks must keep native open-in-new-tab behavior
            if (cameFromBoard() && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              window.history.back();
            }
          }}
        >
          ← Back to the board
        </a>
      </nav>

      <div className="hero">
        <div className="field-label" style={{ flexBasis: '100%' }}>
          Tracked option
        </div>
        <div className="hero-main">
          <span className="amount">${o.price_usd}</span>
          <div>
            <h1 className="hero-route" tabIndex={-1} ref={headingRef}>
              {o.origin} → {o.destination}
            </h1>
            <div className="hero-meta">
              {formatFlightDate(o.outbound_date)} – {formatFlightDate(o.return_date)}
              {' · '}
              {o.airline ?? 'Airline n/a'}
            </div>
          </div>
        </div>
        {/* booking_url used verbatim; omitted entirely when the row has none */}
        {o.booking_url && (
          <a
            className="btn btn-primary hero-book"
            href={o.booking_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on Google Flights
          </a>
        )}
      </div>

      <div className="legs-grid">
        <LegCard
          title="Outbound"
          date={o.outbound_date}
          dep={o.outbound_dep_time}
          arr={o.outbound_arr_time}
          airline={o.outbound_airline ?? o.airline}
          flightNumbers={o.outbound_flight_numbers}
          stops={o.outbound_stops}
        />
        <LegCard
          title="Return"
          date={o.return_date}
          dep={o.return_dep_time}
          arr={o.return_arr_time}
          airline={o.return_airline ?? o.airline}
          flightNumbers={o.return_flight_numbers}
          stops={o.return_stops}
        />
      </div>

      <section className="panel panel-pad" aria-labelledby="history-h">
        <div className="section-head">
          <h2 id="history-h">Price history</h2>
          {last && (
            <span className="field-label">last checked {formatTimestamp(last.scraped_at)}</span>
          )}
        </div>

        {stats && (
          <dl className="stat-grid">
            <div className="stat">
              <dt className="field-label">Now</dt>
              <dd className="stat-val signal">
                ${o.price_usd}
                {o.price_usd <= stats.min && stats.count > 1 && <span className="flag">At its low</span>}
              </dd>
            </div>
            <div className="stat">
              <dt className="field-label">Low</dt>
              <dd className="stat-val">${stats.min}</dd>
            </div>
            <div className="stat">
              <dt className="field-label">Median</dt>
              <dd className="stat-val">${stats.median}</dd>
            </div>
            <div className="stat">
              <dt className="field-label">High</dt>
              <dd className="stat-val">${stats.max}</dd>
            </div>
            <div className="stat">
              <dt className="field-label">Checks</dt>
              <dd className="stat-val">{stats.count}</dd>
            </div>
          </dl>
        )}

        <OptionPriceChart points={data.points} label={label} />

        {first && (
          <p className="muted" style={{ fontSize: '0.75rem', marginTop: '0.7rem' }}>
            Tracked since {formatTimestamp(first.scraped_at)}. Times shown are each airport’s
            local wall-clock values; prices in USD.
          </p>
        )}
      </section>
    </div>
  );
}
