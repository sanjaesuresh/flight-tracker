// The fare board: an aligned, tabular departures-board reading of the latest
// snapshots. Preferred route carries a signal dot; the single lowest fare is lit.
// Every nullable field (airline, stops, all leg times) degrades to "n/a".
import type { RankedOption } from '../lib/types.ts';
import { formatFlightDate, formatTimeOfDay } from '../lib/timezone.ts';
import { optionHashFor } from '../lib/route.ts';

function stopsLabel(stops: number | null): { text: string; nonstop: boolean } {
  if (stops === null) return { text: 'stops n/a', nonstop: false };
  if (stops === 0) return { text: 'Nonstop', nonstop: true };
  return { text: `${stops} stop${stops === 1 ? '' : 's'}`, nonstop: false };
}

function legLine(dep: string | null, arr: string | null): string {
  return `${formatTimeOfDay(dep)} – ${formatTimeOfDay(arr)}`;
}

export function CheapestList({ options }: { options: RankedOption[] }) {
  if (options.length === 0) {
    return (
      <p className="muted" role="status">
        No fares match the current filters.
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
          return (
            <tr
              key={`${o.origin}${o.destination}${o.outbound_date}${o.return_date}${i}`}
              className={isLowest ? 'is-lowest' : undefined}
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
                {detailHref && (
                  <a
                    className="detail-link"
                    href={detailHref}
                    aria-label={`Price history for ${o.origin} to ${o.destination}, ${formatFlightDate(o.outbound_date)} to ${formatFlightDate(o.return_date)}`}
                  >
                    Price history
                  </a>
                )}
              </td>
              <td data-label="Fare" className="c-fare">
                {/* booking_url is the poller's verbatim Google Flights deep-link; use
                    it as-is, and when it's null show the fare with no link (never
                    fabricate a URL from codes — that lands on a dead no-dates page). */}
                {o.booking_url ? (
                  <a
                    className="fare"
                    href={o.booking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${o.price_usd} US dollars, view on Google Flights`}
                  >
                    ${o.price_usd}
                    <span className="book">View</span>
                  </a>
                ) : (
                  <span className="fare">
                    ${o.price_usd}
                    <span className="book dead">no link</span>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
