// One option's own price over time (x = scraped_at, y = USD). Same hand-drawn
// SVG approach as PriceGraph — no chart dependency, full control of a11y and
// theming — but a single series on a real time axis, drawn in the board's
// signal color. Sparse history (one reading) is a designed state, not an empty
// axis: the chart degrades to a "just started tracking" card. A data table
// alternative is always available.
import { useMemo } from 'react';
import type { HistoryPoint } from '../lib/types.js';
import { formatShortTimestamp, formatTimestamp } from '../lib/timezone.js';

const W = 760;
const H = 280;
const PAD = { top: 16, right: 16, bottom: 40, left: 52 };

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
    // pad the price axis so the line doesn't hug the edges; guard flat series.
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
    // at most ~6 x labels, always including first and last readings
    const step = Math.max(1, Math.ceil(pts.length / 6));
    const xTicks = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    return { pts, x, y, ticks, xTicks };
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
            {model.xTicks.map((p) => (
              <text
                key={p.scraped_at}
                className="axis-label"
                x={model.x(p.scraped_at)}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
              >
                {formatShortTimestamp(p.scraped_at)}
              </text>
            ))}
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
        <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
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
