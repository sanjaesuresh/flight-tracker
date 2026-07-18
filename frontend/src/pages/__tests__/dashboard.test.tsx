import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '../Dashboard.tsx';
import { AuthProvider } from '../../auth/AuthProvider.tsx';
import { api } from '../../lib/api.js';
import type { PriceSnapshot } from '../../lib/types.js';

const snap = (p: Partial<PriceSnapshot>): PriceSnapshot => ({
  scraped_at: '2026-07-15T12:00:00Z',
  origin: 'LGA',
  destination: 'YYZ',
  outbound_date: '2026-08-06',
  return_date: '2026-08-09',
  price_usd: 185,
  airline: 'Air Canada',
  stops: 0,
  outbound_dep_time: '18:30',
  outbound_arr_time: '20:00',
  return_dep_time: null,
  return_arr_time: null,
  booking_url: 'https://gf.example/lga-yyz-185',
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

const settings = {
  origins: ['JFK', 'LGA'],
  destinations: ['YYZ', 'YTZ'],
  preferred_origin: 'LGA',
  preferred_destination: 'YYZ',
  patterns: [],
  window_days: 60,
  threshold_usd: 250,
  drop_pct: 20,
  realert_step_pct: 5,
  realert_step_dollars: 10,
  min_history_days: 5,
  alert_email: null,
  dry_run: true,
  updated_at: null,
};

describe('Dashboard fare board', () => {
  beforeEach(() => {
    api.session = vi.fn().mockResolvedValue({ authenticated: true });
    api.health = vi.fn().mockResolvedValue({
      last_success: '2026-07-15T11:30:00Z',
      consecutive_failures: 0,
      newest_scraped_at: '2026-07-15T11:30:00Z',
    });
    api.getSettings = vi.fn().mockResolvedValue(settings);
    api.snapshots = vi.fn().mockResolvedValue({
      latest: [
        snap({ origin: 'LGA', destination: 'YYZ', price_usd: 185, booking_url: 'https://gf.example/lga-yyz-185' }),
        snap({ origin: 'JFK', destination: 'YTZ', price_usd: 150, booking_url: 'https://gf.example/jfk-ytz-150', itinerary_key: 'DL0404.2026-08-06|DL0440.2026-08-09' }),
        snap({ origin: 'LGA', destination: 'YTZ', price_usd: 500, booking_url: null }),
      ],
      newest_scraped_at: '2026-07-15T11:30:00Z',
    });
  });

  it('renders the hero with the lowest fare and a verbatim booking link', async () => {
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    expect(await screen.findByText(/lowest right now/i)).toBeInTheDocument();
    expect(screen.getByText('$150', { selector: '.amount' })).toBeInTheDocument();
    // hero CTA uses the stored booking_url verbatim — never a fabricated URL
    const heroLink = screen.getByRole('link', { name: 'View on Google Flights' });
    expect(heroLink).toHaveAttribute('href', 'https://gf.example/jfk-ytz-150');
    // the keyed hero fare also links to its per-option detail route
    const detail = screen.getByRole('link', { name: 'Price history' });
    expect(detail.getAttribute('href')).toContain('#/option?');
    expect(detail.getAttribute('href')).toContain(
      encodeURIComponent('DL0404.2026-08-06|DL0440.2026-08-09'),
    );
  });

  it('lights the lowest fare, marks the preferred route, and links each fare verbatim', async () => {
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    await screen.findByText(/fare board/i);
    // preferred O-D (LGA→YYZ from settings) is flagged
    expect(screen.getByLabelText('preferred route')).toBeInTheDocument();
    // the single cheapest fare is lit
    expect(screen.getByText('Lowest')).toBeInTheDocument();
    // each row's link is the exact stored deep-link
    const pref = screen.getByRole('link', { name: /185 US dollars, view on google flights/i });
    expect(pref).toHaveAttribute('href', 'https://gf.example/lga-yyz-185');
    // a row with no booking_url shows the fare but no link
    expect(screen.getByText('no link')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /500 US dollars/i })).toBeNull();
  });
});

describe('Dashboard fetch resilience', () => {
  beforeEach(() => {
    api.session = vi.fn().mockResolvedValue({ authenticated: true });
    api.health = vi.fn().mockResolvedValue({
      last_success: '2026-07-15T11:30:00Z',
      consecutive_failures: 0,
      newest_scraped_at: '2026-07-15T11:30:00Z',
    });
    api.getSettings = vi.fn().mockResolvedValue(settings);
    api.snapshots = vi.fn().mockResolvedValue({
      latest: [
        snap({ origin: 'LGA', destination: 'YYZ', price_usd: 185, booking_url: 'https://gf.example/lga-yyz-185' }),
        snap({ origin: 'JFK', destination: 'YTZ', price_usd: 150, booking_url: 'https://gf.example/jfk-ytz-150' }),
        snap({ origin: 'LGA', destination: 'YTZ', price_usd: 500, booking_url: null }),
      ],
      newest_scraped_at: '2026-07-15T11:30:00Z',
    });
  });

  it('(a) a health-only failure still renders the board with no error page and no health banner', async () => {
    api.health = vi.fn().mockRejectedValue(new Error('health unreachable'));
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    await screen.findByText(/fare board/i);
    expect(screen.getByText('$150', { selector: '.fare' })).toBeInTheDocument();
    expect(screen.queryByText(/board offline/i)).toBeNull();
    expect(screen.queryByText(/disrupted/i)).toBeNull();
    expect(screen.queryByText(/delayed/i)).toBeNull();
  });

  it('(b) a settings-only (non-401) failure still renders the board with no preferred dots', async () => {
    api.getSettings = vi.fn().mockRejectedValue(new Error('settings unreachable'));
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    await screen.findByText(/fare board/i);
    expect(screen.getByText('$150', { selector: '.fare' })).toBeInTheDocument();
    expect(screen.queryByLabelText('preferred route')).toBeNull();
  });

  it('(c) a snapshots failure still surfaces the board-offline error state with retry', async () => {
    api.snapshots = vi.fn().mockRejectedValue(new Error('db unreachable'));
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    expect(await screen.findByText(/board offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('(d) renders a screen-reader-only level-1 heading', async () => {
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    await screen.findByText(/fare board/i);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('(e) the fares count is announced via aria-live=polite', async () => {
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    const count = await screen.findByText(/shown/i);
    expect(count).toHaveAttribute('aria-live', 'polite');
  });

  it('(f) an active filter matching nothing shows a Clear filters button that restores the rows', async () => {
    render(
      <AuthProvider>
        <Dashboard />
      </AuthProvider>,
    );
    await screen.findByText(/fare board/i);
    // scope to the fare-board region: the price graph has its own "no fares
    // match" empty state and would otherwise collide with the same text
    const board = screen.getByRole('region', { name: /fare board/i });
    // a max price below every fare on the board excludes all rows
    await userEvent.type(screen.getByLabelText(/maximum price/i), '1');
    expect(await within(board).findByText(/no fares match/i)).toBeInTheDocument();
    const clear = within(board).getByRole('button', { name: /clear filters/i });
    await userEvent.click(clear);
    expect(await within(board).findByText('$150', { selector: '.fare' })).toBeInTheDocument();
    expect(within(board).queryByText(/no fares match/i)).toBeNull();
  });
});
