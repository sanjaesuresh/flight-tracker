// The fare board: an aligned, tabular departures-board reading of the latest
// snapshots. Preferred route carries a signal dot; the single lowest fare is lit.
// Every nullable field (airline, stops, all leg times) degrades to "n/a".
import type { RankedOption } from '../lib/types.js';
import { formatFlightDate, formatTimeOfDay } from '../lib/timezone.js';
import { optionHashFor } from '../lib/route.js';

function stopsLabel(stops: number | null): { text: string; nonstop: boolean } {
  if (stops === null) return { text: 'stops n/a', nonstop: false };
  if (stops === 0) return { text: 'Nonstop', nonstop: true };
  return { text: `${stops} stop${stops === 1 ? '' : 's'}`, nonstop: false };
}

function legLine(dep: string | null, arr: string | null): string {
  return `${formatTimeOfDay(dep)} – ${formatTimeOfDay(arr)}`;
}

// a click that lands on a real anchor/button inside the row keeps that
// control's own behavior (open link, submit, etc.) — the row-level handler
// is a large hit-area layered underneath, not a hijack of those controls.
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a, button') !== null;
}

export function CheapestList({
  options,
  onClearFilters,
}: {
  options: RankedOption[];
  // absent when there's nowhere useful to reset to (e.g. board genuinely has no rows)
  onClearFilters?: () => void;
}) {
  if (options.length === 0) {
    return (
      <p className="muted" role="status">
        No fares match the current filters.{' '}
        {onClearFilters && (
          <button className="btn btn-ghost" onClick={onClearFilters}>
            Clear filters
          </button>
        )}
      </p>
    );
  }
  // the single lowest fare on the board gets lit, wherever it ranks.
  const lowest = Math.min(...options.map((o) => o.price_usd));
  let lowestMarked = false;

  return (
    <table className="board">
      <thead>
        <tr>
          <th scope="col">Route</th>
          <th scope="col">Dates</th>
          <th scope="col">Flight</th>
          <th scope="col" className="ta-r">
            Fare
          </th>
        </tr>
      </thead>
      <tbody>
        {options.map((o, i) => {
          const s = stopsLabel(o.stops);
          const isLowest = !lowestMarked && o.price_usd === lowest;
          if (isLowest) lowestMarked = true;
          // null itinerary_key (fast-flights fallback rows) = no per-option
          // history exists, so no detail link is rendered at all.
          const detailHref = optionHashFor(o);
          // only rows with somewhere to go get the row-level click + hover
          // affordance — a dead row shouldn't advertise a hover it can't honor.
          const rowClassName = [isLowest && 'is-lowest', detailHref && 'rowlink']
            .filter(Boolean)
            .join(' ');
          const handleRowClick = detailHref
            ? (e: React.MouseEvent<HTMLTableRowElement>) => {
                if (isInteractiveTarget(e.target)) return;
                window.location.hash = detailHref;
              }
            : undefined;
          return (
            <tr
              key={`${o.origin}${o.destination}${o.outbound_date}${o.return_date}${i}`}
              className={rowClassName || undefined}
              onClick={handleRowClick}
            >
              <td data-label="Route">
                <span className="c-route">
                  <span className="code">{o.origin}</span>
                  <span className="seg">→</span>
                  <span className="code">{o.destination}</span>
                  {o.preferred && (
                    <span className="pref-dot" title="Preferred route" aria-label="preferred route" />
                  )}
                  {isLowest && <span className="flag">Lowest</span>}
                </span>
              </td>
              <td data-label="Dates" className="c-dates">
                <span className="d">{formatFlightDate(o.outbound_date)}</span>
                <span className="muted"> – </span>
                <span className="d">{formatFlightDate(o.return_date)}</span>
              </td>
              <td data-label="Flight" className="c-flight">
                <span className="airline">{o.airline ?? 'Airline n/a'}</span>
                <span className={`tag${s.nonstop ? ' nonstop' : ''}`}>{s.text}</span>
                <div className="times">
                  out {legLine(o.outbound_dep_time, o.outbound_arr_time)} · ret{' '}
                  {legLine(o.return_dep_time, o.return_arr_time)}
                </div>
              </td>
              <td data-label="Fare" className="c-fare">
                <span className="fare">${o.price_usd}</span>
                <div className="fare-actions">
                  {/* aria-label is prefixed with the control name (accessible-name
                      contract for tests) while keeping the route/date context the
                      old "Price history" link carried */}
                  {detailHref ? (
                    <a
                      className="btn-row"
                      href={detailHref}
                      aria-label={`Details: price history for ${o.origin} to ${o.destination}, ${formatFlightDate(o.outbound_date)} to ${formatFlightDate(o.return_date)}`}
                    >
                      Details <span aria-hidden="true">›</span>
                    </a>
                  ) : (
                    <span className="btn-row dead">No history yet</span>
                  )}
                  {/* booking_url is the poller's verbatim Google Flights deep-link; use
                      it as-is, and when it's null show the fare with no link (never
                      fabricate a URL from codes — that lands on a dead no-dates page). */}
                  {o.booking_url ? (
                    <a
                      className="btn-row btn-row-signal"
                      href={o.booking_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Book: ${o.price_usd} US dollars, view on Google Flights`}
                    >
                      Book <span aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    <span className="btn-row dead">no link</span>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
