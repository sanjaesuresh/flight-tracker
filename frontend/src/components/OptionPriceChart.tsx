// One option's own price over time (x = scraped_at, y = USD). Same hand-drawn
// SVG approach as PriceGraph — no chart dependency, full control of a11y and
// theming — but a single series on a real time axis, drawn in the board's
// signal color. Sparse history (one reading) is a designed state, not an empty
// axis: the chart degrades to a "just started tracking" card. A data table
// alternative is always available.
import { useMemo } from 'react';
import type { HistoryPoint } from '../lib/types.js';
import { formatShortTimestamp, formatTimestamp, NY_TZ } from '../lib/timezone.js';

const W = 760;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 40, left: 52 };

// NY-local calendar day for same-day comparisons — a sibling to timezone.ts's own
// day-key logic, kept local since it only feeds x-label shortening here.
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
// hour-only, matching formatShortTimestamp's own hour formatting so the two compose
// (full label minus its leading date reads identically to this alone).
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: NY_TZ, hour: 'numeric' });

// full "Jul 14, 3 PM" on the first label of a day, just "9 PM" on repeats of the
// same day — keeps a dense hourly axis from repeating the date on every tick.
function formatXTick(iso: string, prevIso: string | null): string {
  if (prevIso && dayKeyFmt.format(new Date(iso)) === dayKeyFmt.format(new Date(prevIso))) {
    return hourFmt.format(new Date(iso));
  }
  return formatShortTimestamp(iso);
}

export function OptionPriceChart({ points, label }: { points: HistoryPoint[]; label: string }) {
  const model = useMemo(() => {
    if (points.length < 2) return null;
    const pts = [...points].sort((a, b) => a.scraped_at.localeCompare(b.scraped_at));
    const times = pts.map((p) => new Date(p.scraped_at).getTime());
    const prices = pts.map((p) => p.price_usd);
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    // pad the price axis so the line doesn't hug the edges; guard flat series. this
    // zoomed y-domain is deliberate (it's what makes small dips visible), so lo > 0
    // means the axis is cropped above zero — the render below marks that crop rather
    // than hiding it.
    const lo = Math.max(0, Math.floor((minP - 15) / 10) * 10);
    const hi = Math.ceil((maxP + 15) / 10) * 10;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (iso: string) => {
      const t = new Date(iso).getTime();
      // real time scale so uneven polling gaps read as gaps, not equal steps
      if (t1 === t0) return PAD.left + plotW / 2;
      return PAD.left + ((t - t0) / (t1 - t0)) * plotW;
    };
    const y = (price: number) =>
      PAD.top + (hi === lo ? plotH / 2 : (1 - (price - lo) / (hi - lo)) * plotH);
    const ticks = Array.from({ length: 5 }, (_, i) => Math.round(lo + ((hi - lo) * i) / 4));
    // at most 4 x labels, evenly spaced (always including first and last) rather
    // than a fixed step — a step-based pick can add a 5th "always include last"
    // straggler; even spacing at 4 keeps labels from ever crowding closer than
    // their own approximate width
    const maxXLabels = 4;
    const xTicks =
      pts.length <= maxXLabels
        ? pts
        : Array.from({ length: maxXLabels }, (_, i) =>
            pts[Math.round((i * (pts.length - 1)) / (maxXLabels - 1))],
          ).filter((p, i, arr) => arr.findIndex((q) => q.scraped_at === p.scraped_at) === i);
    return { pts, x, y, ticks, xTicks, cropped: lo > 0 };
  }, [points]);

  const ordered = useMemo(
    () => [...points].sort((a, b) => a.scraped_at.localeCompare(b.scraped_at)),
    [points],
  );

  if (points.length === 0) {
    // defensive — the API 404s before an option can have zero readings
    return (
      <p className="muted" role="status">
        No price readings recorded for this option yet.
      </p>
    );
  }

  if (points.length === 1) {
    // single reading = "just started tracking", not a degenerate one-dot axis
    const only = ordered[0];
    return (
      <div className="sparse-history" role="status">
        <span className="field-label">Just started tracking</span>
        <p>
          One price reading so far — <strong className="mono">${only.price_usd}</strong> at{' '}
          {formatTimestamp(only.scraped_at)}. The trend will appear as hourly checks accumulate.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="chart-wrap">
        {model && (
          <svg
            className="chart"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Line chart of the tracked price for ${label} across ${points.length} hourly checks. Full values are in the data table below.`}
          >
            {model.ticks.map((t) => (
              <g key={t}>
                <line
                  className="grid-line"
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={model.y(t)}
                  y2={model.y(t)}
                />
                <text className="axis-label" x={PAD.left - 8} y={model.y(t) + 3} textAnchor="end">
                  ${t}
                </text>
              </g>
            ))}
            {model.xTicks.map((p, i) => (
              <text
                key={p.scraped_at}
                className="axis-label"
                x={model.x(p.scraped_at)}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
              >
                {formatXTick(p.scraped_at, i > 0 ? model.xTicks[i - 1].scraped_at : null)}
              </text>
            ))}
            {model.cropped && (
              // two short diagonal strokes just above the bottom gridline: the honesty
              // cue that this y-axis is deliberately zoomed and doesn't start at zero
              <g className="axis-break" aria-hidden="true">
                <line
                  x1={PAD.left - 6}
                  y1={H - PAD.bottom - 1}
                  x2={PAD.left + 2}
                  y2={H - PAD.bottom - 11}
                />
                <line
                  x1={PAD.left - 1}
                  y1={H - PAD.bottom - 1}
                  x2={PAD.left + 7}
                  y2={H - PAD.bottom - 11}
                />
              </g>
            )}
            <polyline
              className="series-line"
              points={model.pts.map((p) => `${model.x(p.scraped_at)},${model.y(p.price_usd)}`).join(' ')}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {model.pts.map((p) => (
              <circle
                key={p.scraped_at}
                className="series-dot"
                cx={model.x(p.scraped_at)}
                cy={model.y(p.price_usd)}
                r={3}
              >
                <title>
                  {formatTimestamp(p.scraped_at)}: ${p.price_usd}
                </title>
              </circle>
            ))}
          </svg>
        )}
      </div>

      <details style={{ marginTop: '0.6rem' }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.82rem' }}>
          View as data table
        </summary>
        <div className="chart-wrap" style={{ marginTop: '0.5rem' }}>
          <table className="data">
            <caption>Tracked price (USD) by check time for {label}</caption>
            <thead>
              <tr>
                <th scope="col">Checked</th>
                <th scope="col">Price</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((p) => (
                <tr key={p.scraped_at}>
                  <th scope="row">{formatTimestamp(p.scraped_at)}</th>
                  <td className="num">${p.price_usd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
