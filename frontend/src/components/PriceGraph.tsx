// Outbound date → lowest matching round-trip price, one line per O-D series, with
// toggle chips. Hand-drawn SVG (no chart dependency) for full control of a11y and
// theming. The chart is never the only way to read the data: a real data table is
// always available as an alternative, and the SVG has a descriptive role/label.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphPoint, GraphSeries } from '../lib/types.js';
import { formatShortDate, formatFlightDate, formatTimeOfDay } from '../lib/timezone.js';

// distinguishable on both light and dark surfaces; not relied on alone (chips +
// table carry labels/values).
// legible on both the light ticket and dark board surfaces; distinct in hue so the
// series read apart without relying on color alone (chips + table carry labels).
const PALETTE = ['#e07b39', '#3aa39c', '#5b8dd6', '#c05fa8', '#8aa63c', '#b0563f'];

const W = 760;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 40, left: 52 };

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

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
    `$${p.price_usd}`,
  ];
  if (p.flight.airline) parts.push(p.flight.airline);
  const stops = stopsText(p.flight.stops);
  if (stops) parts.push(stops);
  return `${parts.join(', ')}.`;
}

// active point identity: series key + its outbound date (unique within a series).
type ActivePoint = { key: string; point: GraphPoint };

function isSamePoint(a: ActivePoint | null, key: string, p: GraphPoint): boolean {
  return a !== null && a.key === key && a.point.outbound_date === p.outbound_date;
}

// touch devices synthesize a mouseenter right before click (W3C compat-event order), so a
// naive hover-sets/click-toggles pair fights itself: first tap opens via hover, then the
// click sees it already active and closes it. Gate hover on real hover capability so touch
// relies on click alone; matchMedia is missing in jsdom, so default to hover-capable there.
function supportsHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover)').matches;
}

export function PriceGraph({ series }: { series: GraphSeries[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<ActivePoint | null>(null);
  const visible = series.filter((s) => !hidden.has(s.key));
  // a touch tap's mousedown focuses the (tabIndex 0) hit target, which fires onFocus and
  // opens the card before click's own toggle runs — so toggle-close must key off whether
  // the point was already active at pointerdown time, not at click time.
  const wasActiveOnPointerDownRef = useRef(false);

  // refs for measuring the real, rendered geometry of the card and its container so the
  // flight card can be placed by actual pixels rather than fixed viewBox-percentage rules.
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!active) return;
    // document-level because touch has no mouseleave — this is the only way to
    // dismiss the card when the user taps elsewhere on the page.
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Element && target.closest('.hit-target')) return;
      setActive(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [active]);

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

  // the point's position as a fraction of the viewBox — plain numbers (not the `model`
  // object, which `visible.filter(...)` above recreates on every render regardless of
  // whether anything changed) so the effect below has stable dependencies and doesn't
  // loop: recomputing on every render would re-run the effect, which calls setState,
  // which re-renders, forever.
  const activePointXFrac = model && active ? model.x(active.point.outbound_date) / W : null;
  const activePointYFrac = model && active ? model.y(active.point.price_usd) / H : null;

  // measure the rendered card and its container after the card mounts/updates but before
  // the browser paints, so placement is correct on the first visible frame (no flash of a
  // wrong position). jsdom's getBoundingClientRect always returns all-zero rects, so every
  // input below is 0 there — the arithmetic must (and does) stay finite, never NaN.
  useLayoutEffect(() => {
    if (activePointXFrac === null || activePointYFrac === null) return;
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    const card = cardRef.current;
    if (!wrap || !svg || !card) return;
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const gap = 14; // clearance between the point and the card, matches the old translate offset
    const margin = 8; // keep the card off chart-wrap's own edges even when centered near them
    // convert the point's viewBox-unit position to real px within chart-wrap, using the
    // svg's actual rendered box rather than assuming it fills the container 1:1. left/top
    // (as CSS values) are relative to chart-wrap's unscrolled content origin, but
    // getBoundingClientRect gives the current *visible* (post-scroll) position — chart-wrap
    // scrolls horizontally past its min-width 340px chart on phones under ~340px-wide, so the
    // gap between those two frames (wrap.scrollLeft) has to be added back in, or the card
    // renders scrollLeft px short of the point once the chart has been scrolled.
    const px = svgRect.left - wrapRect.left + activePointXFrac * svgRect.width + wrap.scrollLeft;
    const py = svgRect.top - wrapRect.top + activePointYFrac * svgRect.height;
    // prefer above; only drop below when the card's real height doesn't fit above the
    // container's top edge — replaces the old fixed "top quarter" heuristic.
    const fitsAbove = py - cardRect.height - gap >= 0;
    const rawTop = fitsAbove ? py - cardRect.height - gap : py + gap;
    // final fallback: on a container too short for the card to fit either above or
    // below, clamp top into the container's own bounds rather than let above/below
    // math push it past the bottom (or, in principle, top) edge. The card may then
    // partially cover the point it describes — acceptable; clipped card text is not.
    const maxTop = Math.max(margin, wrapRect.height - cardRect.height - margin);
    const top = clamp(rawTop, margin, maxTop);
    // center on the point, then clamp using the card's real width against the
    // container's real width so it can never clip past either edge. The clamp bounds are
    // shifted by scrollLeft too, to stay in the same content-relative frame as px above —
    // otherwise a scrolled chart-wrap would clamp against the unscrolled window instead of
    // the one the user is actually looking at.
    const minLeft = wrap.scrollLeft + margin;
    const maxLeft = Math.max(minLeft, wrap.scrollLeft + wrapRect.width - cardRect.width - margin);
    const left = clamp(px - cardRect.width / 2, minLeft, maxLeft);
    setCardPos({ left, top });
  }, [activePointXFrac, activePointYFrac]);

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
                      points={d.join(' ')}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
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
                        onMouseEnter={() => { if (supportsHover()) setActive({ key: s.key, point: p }); }}
                        onMouseLeave={() => { if (supportsHover()) setActive(null); }}
                        onFocus={() => setActive({ key: s.key, point: p })}
                        onBlur={() => setActive(null)}
                        onPointerDown={() => {
                          wasActiveOnPointerDownRef.current = isSamePoint(active, s.key, p);
                        }}
                        onClick={() =>
                          setActive(
                            wasActiveOnPointerDownRef.current ? null : { key: s.key, point: p },
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setActive(null);
                        }}
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
            // left/top are real px computed from measured geometry in the layout effect
            // above (0/0 — and thus finite, not NaN — until that effect has run once, e.g.
            // in jsdom where getBoundingClientRect never reports real size).
            return (
              <div
                ref={cardRef}
                className="flight-card"
                style={{ left: `${cardPos.left}px`, top: `${cardPos.top}px` }}
              >
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
                    ret {formatTimeOfDay(flight.return_dep_time)} –{' '}
                    {formatTimeOfDay(flight.return_arr_time)}
                  </p>
                )}
              </div>
            );
          })()}
      </div>

      <details style={{ marginTop: '0.6rem' }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.82rem' }}>
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
