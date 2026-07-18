// Outbound date → lowest matching round-trip price, one line per O-D series, with
// toggle chips. Hand-drawn SVG (no chart dependency) for full control of a11y and
// theming. The chart is never the only way to read the data: a real data table is
// always available as an alternative, and the SVG has a descriptive role/label.
import { useMemo, useState } from 'react';
import type { GraphPoint, GraphSeries } from '../lib/types.js';
import { formatShortDate, formatFlightDate, formatTimeOfDay } from '../lib/timezone.js';
import { isMixedReturn } from '../lib/route.js';
import { useChartHoverCard } from './useChartHoverCard.ts';

// legible on both the light ticket and dark board surfaces; distinct in hue so the
// series read apart without relying on color alone (chips + table carry labels).
const PALETTE = ['#e07b39', '#3aa39c', '#5b8dd6', '#c05fa8', '#8aa63c', '#b0563f'];

const W = 760;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 40, left: 52 };

// same "Nonstop"/"N stops" wording as CheapestList, kept local since the graph's
// aria-label and card need it without importing a whole other component.
function stopsText(stops: number | null): string | null {
  if (stops === null) return null;
  if (stops === 0) return 'Nonstop';
  return `${stops} stop${stops === 1 ? '' : 's'}`;
}

// one plain sentence for the hit target's aria-label: route, both dates, price,
// and — when known — airline/stops. Screen readers get this in place of the
// removed <title>, since the card itself is visual/pointer-inert.
function describePoint(s: GraphSeries, p: GraphPoint): string {
  const parts = [
    `${s.origin} to ${s.destination}`,
    `${formatFlightDate(p.flight.outbound_date)} to ${formatFlightDate(p.flight.return_date)}`,
  ];
  // mixed return (different return-leg airports) is visible in the hover card, so screen
  // reader users need the same fact spoken here rather than just implied by symmetric airports
  if (isMixedReturn(p.flight)) {
    parts.push(`returns ${p.flight.return_origin} to ${p.flight.return_destination}`);
  }
  parts.push(`$${p.price_usd}`);
  if (p.flight.airline) parts.push(p.flight.airline);
  const stops = stopsText(p.flight.stops);
  if (stops) parts.push(stops);
  return `${parts.join(', ')}.`;
}

// active point identity: series key (for stale-card lookups when a series is toggled
// off while its card is open) plus the point itself, sourced from the chart's own model.
type ActivePoint = { key: string; point: GraphPoint };

export function PriceGraph({ series }: { series: GraphSeries[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = series.filter((s) => !hidden.has(s.key));
  const { wrapRef, svgRef, cardRef, active, cardStyle, getHitTargetProps } =
    useChartHoverCard<ActivePoint>();

  const model = useMemo(() => {
    const dates = [...new Set(visible.flatMap((s) => s.points.map((p) => p.outbound_date)))].sort();
    const prices = visible.flatMap((s) => s.points.map((p) => p.price_usd));
    if (dates.length === 0 || prices.length === 0) return null;
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    // pad the price axis so lines don't hug the edges; guard the single-value case.
    // this zoomed y-domain is deliberate (small dips would vanish against a $0 floor),
    // so lo > 0 means the axis is cropped above zero — rendered below as a break marker
    // rather than hidden.
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
    return { dates, x, y, ticks, xEvery, plotW, plotH, cropped: lo > 0 };
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
          >
            <span
              className="swatch"
              /* off state: no inline fill, so the CSS hollow-swatch treatment (transparent
                 + --line border) applies instead of a washed-out palette color */
              style={hidden.has(s.key) ? undefined : { background: PALETTE[i % PALETTE.length] }}
              aria-hidden="true"
            />
            {s.origin}→{s.destination}
          </button>
        ))}
      </div>

      <div className="chart-wrap" ref={wrapRef}>
        {model ? (
          <svg
            ref={svgRef}
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
                      className="trend-line"
                      points={d.join(' ')}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      // feeds CSS currentColor for the dark-mode glow below — stroke is
                      // an SVG paint attribute, not the CSS `color` property, so the
                      // filter can't pick up this series' own hue without it.
                      style={{ color }}
                    />
                  )}
                  {pts.map((p) => (
                    <g key={p.outbound_date}>
                      <circle cx={model.x(p.outbound_date)} cy={model.y(p.price_usd)} r={3} fill={color} />
                      {/* transparent, oversized hit target (r=12 vs the r=3 dot) so touch/mouse/
                          keyboard all get a real target; the card + aria-label replace the old <title> */}
                      <circle
                        className="hit-target"
                        cx={model.x(p.outbound_date)}
                        cy={model.y(p.price_usd)}
                        r={12}
                        fill="transparent"
                        tabIndex={0}
                        role="button"
                        aria-label={describePoint(s, p)}
                        // item key combines series + date (unique within a series) so the hook
                        // can tell distinct points apart for open/close toggling and dismissal.
                        {...getHitTargetProps(
                          `${s.key}:${p.outbound_date}`,
                          { key: s.key, point: p },
                          model.x(p.outbound_date) / W,
                          model.y(p.price_usd) / H,
                        )}
                      />
                    </g>
                  ))}
                </g>
              );
            })}
          </svg>
        ) : series.length === 0 ? (
          // nothing tracked/filtered in at all — distinct from "toggled off" below,
          // since there's no chip here the user could turn back on.
          <p className="muted" role="status" style={{ padding: '2rem 0' }}>
            No fares match the current filters.
          </p>
        ) : (
          <p className="muted" role="status" style={{ padding: '2rem 0' }}>
            No series selected — turn one on above to see the trend.
          </p>
        )}
        {model &&
          active &&
          (() => {
            // stale active point (its series got toggled off while the card was open) — skip.
            const activeSeries = visible.find((s) => s.key === active.key);
            if (!activeSeries) return null;
            const flight = active.point.flight;
            const color = PALETTE[series.indexOf(activeSeries) % PALETTE.length];
            const stops = stopsText(flight.stops);
            // cardStyle's left/top are real px computed from measured geometry in the hook's
            // layout effect (0/0 — and thus finite, not NaN — until that effect has run once,
            // e.g. in jsdom where getBoundingClientRect never reports real size).
            return (
              <div ref={cardRef} className="flight-card" style={cardStyle}>
                <p className="fc-head">
                  <span>
                    {activeSeries.origin}→{activeSeries.destination}
                  </span>
                  <span style={{ color }}>${active.point.price_usd}</span>
                </p>
                <p>
                  {formatFlightDate(flight.outbound_date)} → {formatFlightDate(flight.return_date)}
                </p>
                {(flight.airline || stops) && (
                  <p className="fc-meta">
                    {flight.airline && <span>{flight.airline}</span>}
                    {flight.airline && stops && ' · '}
                    {stops && <span>{stops}</span>}
                  </p>
                )}
                {flight.outbound_dep_time && flight.outbound_arr_time && (
                  <p>
                    out {formatTimeOfDay(flight.outbound_dep_time)} –{' '}
                    {formatTimeOfDay(flight.outbound_arr_time)}
                  </p>
                )}
                {flight.return_dep_time && flight.return_arr_time && (
                  <p>
                    {/* mixed flights get a signal-colored "ret ORIGIN→DEST" segment in place
                        of the plain "ret" word, so the card doesn't imply a symmetric return */}
                    {isMixedReturn(flight) ? (
                      <span className="ret-airports">
                        ret {flight.return_origin}→{flight.return_destination}
                      </span>
                    ) : (
                      'ret'
                    )}{' '}
                    {formatTimeOfDay(flight.return_dep_time)} –{' '}
                    {formatTimeOfDay(flight.return_arr_time)}
                  </p>
                )}
              </div>
            );
          })()}
      </div>

      <details className="chart-disclosure">
        <summary className="muted">View as data table</summary>
        <div className="chart-wrap">
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
