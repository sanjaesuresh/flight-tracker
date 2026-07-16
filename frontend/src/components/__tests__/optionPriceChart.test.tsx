import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { OptionPriceChart } from '../OptionPriceChart.tsx';
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
