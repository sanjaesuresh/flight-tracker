import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OptionPriceChart } from '../OptionPriceChart.tsx';
import { formatTimestamp } from '../../lib/timezone.js';
import type { HistoryPoint } from '../../lib/types.js';

// hourly readings, all on 2026-07-14 NY-local, spanning enough points that the
// 4-label cap actually kicks in.
const sameDayPoints: HistoryPoint[] = [
  { scraped_at: '2026-07-14T15:00:00Z', price_usd: 200 }, // 11 AM EDT
  { scraped_at: '2026-07-14T16:00:00Z', price_usd: 190 },
  { scraped_at: '2026-07-14T17:00:00Z', price_usd: 180 },
  { scraped_at: '2026-07-14T18:00:00Z', price_usd: 175 },
  { scraped_at: '2026-07-14T19:00:00Z', price_usd: 170 },
  { scraped_at: '2026-07-14T20:00:00Z', price_usd: 185 },
  { scraped_at: '2026-07-14T21:00:00Z', price_usd: 195 },
  { scraped_at: '2026-07-14T22:00:00Z', price_usd: 205 },
];

function axisLabels(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('text.axis-label'));
}

describe('OptionPriceChart x-axis label density', () => {
  it('renders at most 4 x labels, and only the first contains the month', () => {
    const { container } = render(<OptionPriceChart points={sameDayPoints} label="LGA to YYZ" />);
    // x labels sit below the plot area (y attr near the bottom); price labels sit at
    // the left. Distinguish by textAnchor, which x labels set to "middle".
    const xLabels = axisLabels(container).filter((el) => el.getAttribute('text-anchor') === 'middle');
    expect(xLabels.length).toBeLessThanOrEqual(4);
    expect(xLabels.length).toBeGreaterThan(1);
    const withMonth = xLabels.filter((el) => /[A-Za-z]{3} \d/.test(el.textContent ?? ''));
    expect(withMonth).toHaveLength(1);
    expect(xLabels[0].textContent).toMatch(/[A-Za-z]{3} \d/);
    for (const el of xLabels.slice(1)) {
      expect(el.textContent).not.toMatch(/[A-Za-z]{3} \d/);
    }
  });
});

describe('OptionPriceChart cropped-axis honesty cue', () => {
  it('keeps the bottom gridline dollar label even though the y-domain is zoomed', () => {
    const { container } = render(<OptionPriceChart points={sameDayPoints} label="LGA to YYZ" />);
    // price labels right-align (textAnchor "end"); the lowest one is the bottom gridline.
    const priceLabels = axisLabels(container).filter((el) => el.getAttribute('text-anchor') === 'end');
    expect(priceLabels.length).toBeGreaterThan(0);
    for (const el of priceLabels) {
      expect(el.textContent).toMatch(/^\$\d+$/);
    }
  });

  it('renders a break marker on the y-axis when the domain is cropped above zero', () => {
    const { container } = render(<OptionPriceChart points={sameDayPoints} label="LGA to YYZ" />);
    expect(container.querySelector('.axis-break')).not.toBeNull();
  });
});

// four readings, one drop (200 -> 185) and one rise (185 -> 210) between
// consecutive checks, all prices distinct so hit targets can be located by
// their unique dollar amount in the accessible name.
const hoverPoints: HistoryPoint[] = [
  { scraped_at: '2026-07-14T15:00:00Z', price_usd: 200 }, // first reading, no delta
  { scraped_at: '2026-07-14T16:00:00Z', price_usd: 185 }, // drop of $15 -> good
  { scraped_at: '2026-07-14T17:00:00Z', price_usd: 210 }, // rise of $25 -> bad
  { scraped_at: '2026-07-14T18:00:00Z', price_usd: 195 }, // drop of $15 -> good
];

function renderChart() {
  return render(<OptionPriceChart points={hoverPoints} label="LGA to YYZ" />);
}

// the data table (chart alt) renders the same prices/times as the card, so card
// assertions must be scoped to the card node, not the whole document.
function getCard() {
  const card = document.querySelector('.flight-card');
  if (!card) throw new Error('expected an active flight card');
  return within(card as HTMLElement);
}

function queryCard() {
  return document.querySelector('.flight-card');
}

// hit targets are queried by accessible name, which per describePoint always
// contains the reading's own (unique in this fixture) dollar price.
const firstName = /\$200\./;
const dropName = /\$185, down \$15 since the last check\./;
const riseName = /\$210, up \$25 since the last check\./;

// jsdom has no matchMedia; stub it to simulate a real device's hover capability for
// the chart's `supportsHover()` gate (via useChartHoverCard).
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

describe('OptionPriceChart hover card', () => {
  it('hover shows the formatted time, price, and delta', () => {
    renderChart();
    fireEvent.mouseEnter(screen.getByRole('button', { name: dropName }));
    const card = getCard();
    expect(card.getByText(formatTimestamp('2026-07-14T16:00:00Z'))).toBeInTheDocument();
    expect(card.getByText('$185')).toBeInTheDocument();
    expect(card.getByText('down $15 since the last check')).toBeInTheDocument();
  });

  it('a price drop renders the delta with the good styling hook', () => {
    renderChart();
    fireEvent.mouseEnter(screen.getByRole('button', { name: dropName }));
    const delta = getCard().getByText('down $15 since the last check');
    expect(delta).toHaveClass('good');
  });

  it('a price rise renders the delta with the bad styling hook', () => {
    renderChart();
    fireEvent.mouseEnter(screen.getByRole('button', { name: riseName }));
    const delta = getCard().getByText('up $25 since the last check');
    expect(delta).toHaveClass('bad');
  });

  it('the first reading shows no delta line', () => {
    renderChart();
    fireEvent.mouseEnter(screen.getByRole('button', { name: firstName }));
    const card = getCard();
    expect(card.getByText('$200')).toBeInTheDocument();
    expect(card.queryByText(/since the last check/)).toBeNull();
  });

  it('mouse leave hides the card', () => {
    renderChart();
    const target = screen.getByRole('button', { name: dropName });
    fireEvent.mouseEnter(target);
    expect(queryCard()).not.toBeNull();
    fireEvent.mouseLeave(target);
    expect(queryCard()).toBeNull();
  });

  it('focus shows the card, and Escape dismisses it', () => {
    renderChart();
    const target = screen.getByRole('button', { name: dropName });
    fireEvent.focus(target);
    expect(queryCard()).not.toBeNull();
    fireEvent.keyDown(target, { key: 'Escape' });
    expect(queryCard()).toBeNull();
  });

  it('only one card at a time', () => {
    renderChart();
    fireEvent.mouseEnter(screen.getByRole('button', { name: dropName }));
    expect(getCard().getByText('$185')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole('button', { name: riseName }));
    expect(document.querySelectorAll('.flight-card')).toHaveLength(1);
    expect(getCard().getByText('$210')).toBeInTheDocument();
    expect(getCard().queryByText('$185')).toBeNull();
  });
});

describe('OptionPriceChart touch tap-then-click race', () => {
  afterEach(() => {
    // matchMedia is undefined by default in jsdom (hover-capable default) — restore that
    // between tests so the stub in one test can't leak into another.
    // @ts-expect-error test-only cleanup of a stubbed browser API
    delete window.matchMedia;
  });

  it('a real tap sequence (pointerdown, no-op hover, focus, click) opens the card', () => {
    stubMatchMedia(false);
    renderChart();
    const target = screen.getByRole('button', { name: dropName });
    // mousedown on the tabIndex-0 hit target focuses it before click fires, so the real
    // tap order is pointerdown -> (mouseenter no-op under the hover gate) -> focus -> click.
    fireEvent.pointerDown(target);
    fireEvent.mouseEnter(target);
    fireEvent.focus(target);
    fireEvent.click(target);
    expect(queryCard()).not.toBeNull();
  });

  it('repeating the tap on the same point closes the card', () => {
    stubMatchMedia(false);
    renderChart();
    const target = screen.getByRole('button', { name: dropName });
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

describe('OptionPriceChart sparse states', () => {
  it('zero readings renders no hit targets', () => {
    render(<OptionPriceChart points={[]} label="LGA to YYZ" />);
    expect(screen.getByText('No price readings recorded for this option yet.')).toBeInTheDocument();
    expect(document.querySelector('.hit-target')).toBeNull();
  });

  it('one reading renders the just-started-tracking card with no hit targets', () => {
    render(
      <OptionPriceChart
        points={[{ scraped_at: '2026-07-14T15:00:00Z', price_usd: 200 }]}
        label="LGA to YYZ"
      />,
    );
    expect(screen.getByText('Just started tracking')).toBeInTheDocument();
    expect(document.querySelector('.hit-target')).toBeNull();
  });
});
