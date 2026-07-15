// Outbound date → lowest matching round-trip price, one line per O-D series, with
// toggle chips. Hand-drawn SVG (no chart dependency) for full control of a11y and
// theming. The chart is never the only way to read the data: a real data table is
// always available as an alternative, and the SVG has a descriptive role/label.
import { useMemo, useState } from 'react';
import type { GraphSeries } from '../lib/types';
import { formatShortDate, formatFlightDate } from '../lib/timezone';

// distinguishable on both light and dark surfaces; not relied on alone (chips +
// table carry labels/values).
// legible on both the light ticket and dark board surfaces; distinct in hue so the
// series read apart without relying on color alone (chips + table carry labels).
const PALETTE = ['#e07b39', '#3aa39c', '#5b8dd6', '#c05fa8', '#8aa63c', '#b0563f'];

const W = 760;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 40, left: 52 };

export function PriceGraph({ series }: { series: GraphSeries[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = series.filter((s) => !hidden.has(s.key));

  const model = useMemo(() => {
    const dates = [...new Set(visible.flatMap((s) => s.points.map((p) => p.outbound_date)))].sort();
    const prices = visible.flatMap((s) => s.points.map((p) => p.price_usd));
    if (dates.length === 0 || prices.length === 0) return null;
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    // pad the price axis so lines don't hug the edges; guard the single-value case.
    const lo = Math.max(0, Math.floor((minP - 20) / 10) * 10);
    const hi = Math.ceil((maxP + 20) / 10) * 10;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (date: string) => {
      const i = dates.indexOf(date);
      if (dates.length === 1) return PAD.left + plotW / 2;
      return PAD.left + (i / (dates.length - 1)) * plotW;
    };
    const y = (price: number) =>
      PAD.top + (hi === lo ? plotH / 2 : (1 - (price - lo) / (hi - lo)) * plotH);
    const ticks = Array.from({ length: 5 }, (_, i) => Math.round(lo + ((hi - lo) * i) / 4));
    const xEvery = Math.ceil(dates.length / 8);
    return { dates, x, y, ticks, xEvery, plotW };
  }, [visible]);

  const allDates = useMemo(
    () => [...new Set(series.flatMap((s) => s.points.map((p) => p.outbound_date)))].sort(),
    [series],
  );

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div>
      <div className="series-toggles" role="group" aria-label="Toggle price series">
        {series.map((s, i) => (
          <button
            key={s.key}
            className="chip"
            aria-pressed={!hidden.has(s.key)}
            onClick={() => toggle(s.key)}
            style={{ color: hidden.has(s.key) ? undefined : PALETTE[i % PALETTE.length] }}
          >
            <span
              className="swatch"
              style={{ background: PALETTE[i % PALETTE.length] }}
              aria-hidden="true"
            />
            {s.origin}→{s.destination}
          </button>
        ))}
      </div>

      <div className="chart-wrap">
        {model ? (
          <svg
            className="chart"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Line chart of lowest round-trip price by outbound date for ${visible
              .map((s) => `${s.origin} to ${s.destination}`)
              .join(', ')}. Full values are in the data table below.`}
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
            {model.dates.map((d, i) =>
              i % model.xEvery === 0 ? (
                <text
                  key={d}
                  className="axis-label"
                  x={model.x(d)}
                  y={H - PAD.bottom + 16}
                  textAnchor="middle"
                >
                  {formatShortDate(d)}
                </text>
              ) : null,
            )}
            {visible.map((s) => {
              const color = PALETTE[series.indexOf(s) % PALETTE.length];
              const pts = [...s.points].sort((a, b) =>
                a.outbound_date.localeCompare(b.outbound_date),
              );
              const d = pts.map((p) => `${model.x(p.outbound_date)},${model.y(p.price_usd)}`);
              return (
                <g key={s.key}>
                  {pts.length > 1 && (
                    <polyline
                      points={d.join(' ')}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  )}
                  {pts.map((p) => (
                    <circle
                      key={p.outbound_date}
                      cx={model.x(p.outbound_date)}
                      cy={model.y(p.price_usd)}
                      r={3}
                      fill={color}
                    >
                      <title>
                        {s.origin}→{s.destination}, {formatFlightDate(p.outbound_date)}: $
                        {p.price_usd}
                      </title>
                    </circle>
                  ))}
                </g>
              );
            })}
          </svg>
        ) : (
          <p className="muted" role="status" style={{ padding: '2rem 0' }}>
            No series selected — turn one on above to see the trend.
          </p>
        )}
      </div>

      <details style={{ marginTop: '0.6rem' }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
          View as data table
        </summary>
        <div className="chart-wrap" style={{ marginTop: '0.5rem' }}>
          <table className="data">
            <caption>Lowest round-trip price (USD) by outbound date</caption>
            <thead>
              <tr>
                <th scope="col">Outbound date</th>
                {series.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.origin}→{s.destination}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allDates.map((d) => (
                <tr key={d}>
                  <th scope="row">{formatFlightDate(d)}</th>
                  {series.map((s) => {
                    const pt = s.points.find((p) => p.outbound_date === d);
                    return (
                      <td className="num" key={s.key}>
                        {pt ? `$${pt.price_usd}` : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
