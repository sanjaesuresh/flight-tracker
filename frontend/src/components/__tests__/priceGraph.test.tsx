import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PriceGraph } from '../PriceGraph.tsx';
import type { GraphSeries, GraphPoint, PriceSnapshot } from '../../lib/types.js';

const snapshot = (p: Partial<PriceSnapshot>): PriceSnapshot => ({
  scraped_at: '2026-07-15T12:00:00Z',
  origin: 'LGA',
  destination: 'YYZ',
  outbound_date: '2026-08-06',
  return_date: '2026-08-09',
  price_usd: 185,
  airline: 'Air Canada',
  stops: 0,
  outbound_dep_time: '08:05',
  outbound_arr_time: '09:42',
  return_dep_time: '18:30',
  return_arr_time: '20:01',
  booking_url: null,
  itinerary_key: null,
  outbound_airline: null,
  return_airline: null,
  outbound_flight_numbers: null,
  return_flight_numbers: null,
  outbound_stops: null,
  return_stops: null,
  return_origin: null,
  return_destination: null,
  ...p,
});

const point = (p: Partial<PriceSnapshot> = {}, priceOverride?: number): GraphPoint => {
  const flight = snapshot(p);
  return {
    outbound_date: flight.outbound_date,
    price_usd: priceOverride ?? flight.price_usd,
    flight,
  };
};

// detailed series: full leg detail on every field the card can render.
const detailedSeries: GraphSeries = {
  key: 'LGA-YYZ',
  origin: 'LGA',
  destination: 'YYZ',
  points: [point()],
};

// sparse series: airline, stops, and all four leg times null — the "omit, don't
// placeholder" path.
const sparseSeries: GraphSeries = {
  key: 'LGA-YUL',
  origin: 'LGA',
  destination: 'YUL',
  points: [
    point({
      origin: 'LGA',
      destination: 'YUL',
      outbound_date: '2026-08-07',
      return_date: '2026-08-10',
      price_usd: 210,
      airline: null,
      stops: null,
      outbound_dep_time: null,
      outbound_arr_time: null,
      return_dep_time: null,
      return_arr_time: null,
    }),
  ],
};

function renderGraph() {
  return render(<PriceGraph series={[detailedSeries, sparseSeries]} />);
}

// the data table (chart alt) renders the same prices/routes/dates as the card, so
// card assertions must be scoped to the card node, not the whole document.
function getCard() {
  const card = document.querySelector('.flight-card');
  if (!card) throw new Error('expected an active flight card');
  return within(card as HTMLElement);
}

function queryCard() {
  return document.querySelector('.flight-card');
}

// hit targets are queried by accessible name, which starts with the route and
// outbound date per the brief.
const detailedName = /^LGA to YYZ, Thu, Aug 6/;
const sparseName = /^LGA to YUL, Fri, Aug 7/;

// jsdom has no matchMedia; stub it to simulate a real device's hover capability for
// the PriceGraph's `supportsHover()` gate.
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('PriceGraph flight card', () => {
  it('hover shows the full flight card', () => {
    renderGraph();
    fireEvent.mouseEnter(screen.getByRole('button', { name: detailedName }));
    const card = getCard();
    expect(card.getByText(/LGA→YYZ/)).toBeInTheDocument();
    expect(card.getByText('$185')).toBeInTheDocument();
    expect(card.getByText(/Thu, Aug 6/)).toBeInTheDocument();
    expect(card.getByText(/Sun, Aug 9/)).toBeInTheDocument();
    expect(card.getByText('Air Canada')).toBeInTheDocument();
    expect(card.getByText('Nonstop')).toBeInTheDocument();
    expect(card.getByText(/out 8:05 AM – 9:42 AM/)).toBeInTheDocument();
    expect(card.getByText(/ret 6:30 PM – 8:01 PM/)).toBeInTheDocument();
  });

  it('mouse leave hides the card', () => {
    renderGraph();
    const target = screen.getByRole('button', { name: detailedName });
    fireEvent.mouseEnter(target);
    expect(queryCard()).not.toBeNull();
    fireEvent.mouseLeave(target);
    expect(queryCard()).toBeNull();
  });

  it('focus shows the card, blur hides it', () => {
    renderGraph();
    const target = screen.getByRole('button', { name: detailedName });
    fireEvent.focus(target);
    expect(queryCard()).not.toBeNull();
    fireEvent.blur(target);
    expect(queryCard()).toBeNull();
  });

  it('Escape dismisses the card', () => {
    renderGraph();
    const target = screen.getByRole('button', { name: detailedName });
    fireEvent.focus(target);
    expect(queryCard()).not.toBeNull();
    fireEvent.keyDown(target, { key: 'Escape' });
    expect(queryCard()).toBeNull();
  });

  it('tapping elsewhere dismisses the card', () => {
    renderGraph();
    const target = screen.getByRole('button', { name: detailedName });
    fireEvent.click(target);
    expect(queryCard()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(queryCard()).toBeNull();
  });

  it('null fields render no placeholder lines', () => {
    renderGraph();
    fireEvent.mouseEnter(screen.getByRole('button', { name: sparseName }));
    const card = getCard();
    expect(card.getByText(/LGA→YUL/)).toBeInTheDocument();
    expect(card.getByText(/Fri, Aug 7/)).toBeInTheDocument();
    expect(card.getByText(/Mon, Aug 10/)).toBeInTheDocument();
    expect(card.getByText('$210')).toBeInTheDocument();
    expect(card.queryByText(/n\/a/i)).toBeNull();
    expect(card.queryByText('Air Canada')).toBeNull();
    expect(card.queryByText(/nonstop/i)).toBeNull();
    expect(card.queryByText(/stop/i)).toBeNull();
    expect(card.queryByText(/out /)).toBeNull();
    expect(card.queryByText(/ret /)).toBeNull();
  });

  it('only one card at a time', () => {
    renderGraph();
    fireEvent.mouseEnter(screen.getByRole('button', { name: detailedName }));
    expect(getCard().getByText('$185')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole('button', { name: sparseName }));
    // exactly one card node in the document, showing the second flight
    expect(document.querySelectorAll('.flight-card')).toHaveLength(1);
    expect(getCard().getByText('$210')).toBeInTheDocument();
    expect(getCard().queryByText('$185')).toBeNull();
  });
});

describe('PriceGraph touch tap-then-click race', () => {
  afterEach(() => {
    // matchMedia is undefined by default in jsdom (hover-capable default) — restore that
    // between tests so the stub in one test can't leak into another.
    // @ts-expect-error test-only cleanup of a stubbed browser API
    delete window.matchMedia;
  });

  it('single tap (real event stream: pointerdown, no-op hover, focus, click) opens the card', () => {
    stubMatchMedia(false);
    renderGraph();
    const target = screen.getByRole('button', { name: detailedName });
    // mousedown on the tabIndex-0 hit target focuses it before click fires, so the real
    // tap order is pointerdown -> (mouseenter no-op under the hover gate) -> focus -> click.
    fireEvent.pointerDown(target);
    fireEvent.mouseEnter(target);
    fireEvent.focus(target);
    fireEvent.click(target);
    expect(queryCard()).not.toBeNull();
  });

  it('a second tap on the same point closes the card on a non-hover device', () => {
    stubMatchMedia(false);
    renderGraph();
    const target = screen.getByRole('button', { name: detailedName });
    fireEvent.pointerDown(target);
    fireEvent.mouseEnter(target);
    fireEvent.focus(target);
    fireEvent.click(target);
    expect(queryCard()).not.toBeNull();
    // a real second tap doesn't re-fire focus (the target is already focused), so this
    // simulates pointerdown -> click only.
    fireEvent.pointerDown(target);
    fireEvent.click(target);
    expect(queryCard()).toBeNull();
  });
});

describe('PriceGraph mixed-route card', () => {
  it('shows a signal-colored ret-airports segment before the times for a mixed flight', () => {
    const mixedSeries: GraphSeries = {
      key: 'LGA-YYZ',
      origin: 'LGA',
      destination: 'YYZ',
      points: [point({ return_origin: 'YTZ', return_destination: 'JFK' })],
    };
    render(<PriceGraph series={[mixedSeries]} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: detailedName }));
    const card = getCard();
    expect(card.getByText(/ret YTZ→JFK/)).toBeInTheDocument();
    expect(card.getByText(/6:30 PM – 8:01 PM/)).toBeInTheDocument();
  });

  it('includes the return pair in the hit target aria-label for a mixed flight, but not a symmetric one', () => {
    const mixedSeries: GraphSeries = {
      key: 'LGA-YYZ-mixed',
      origin: 'LGA',
      destination: 'YYZ',
      points: [point({ return_origin: 'YTZ', return_destination: 'JFK' })],
    };
    render(<PriceGraph series={[mixedSeries, detailedSeries]} />);
    expect(
      screen.getByRole('button', { name: /returns YTZ to JFK/ }),
    ).toBeInTheDocument();
    // detailedSeries is symmetric (no return_origin/destination override) — its name
    // has the same route/date prefix as the mixed one, so pick it out by absence of "returns"
    // rather than reusing detailedName, which would ambiguously match both hit targets here.
    const symmetricLabel = screen
      .getAllByRole('button', { name: detailedName })
      .map((el) => el.getAttribute('aria-label'))
      .find((label) => !label?.includes('returns'));
    expect(symmetricLabel).toBeDefined();
    expect(symmetricLabel).not.toMatch(/returns/);
  });
});

describe('PriceGraph empty states', () => {
  it('an empty series array (nothing tracked/filtered in) says the data is unavailable', () => {
    render(<PriceGraph series={[]} />);
    expect(screen.getByText('No fares match the current filters.')).toBeInTheDocument();
    expect(screen.queryByText(/turn one on above/)).toBeNull();
  });

  it('series present but all toggled off keeps the turn-one-on prompt', () => {
    render(<PriceGraph series={[detailedSeries]} />);
    fireEvent.click(screen.getByRole('button', { name: /LGA→YYZ/ }));
    expect(screen.getByText(/No series selected — turn one on above to see the trend\./)).toBeInTheDocument();
    expect(screen.queryByText('No fares match the current filters.')).toBeNull();
  });
});
