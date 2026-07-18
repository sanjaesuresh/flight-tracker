import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { OptionDetail } from '../OptionDetail.tsx';
import { AuthProvider } from '../../auth/AuthProvider.tsx';
import { api, ApiError } from '../../lib/api.js';
import { optionHash, parseOptionHash } from '../../lib/route.js';
import type { OptionParams } from '../../lib/route.js';
import type { OptionHistoryPayload, PriceSnapshot } from '../../lib/types.js';

const params: OptionParams = {
  origin: 'LGA',
  destination: 'YYZ',
  outbound_date: '2026-08-06',
  return_date: '2026-08-09',
  itinerary_key: 'AC1110.2026-08-06|AC2210.2026-08-09',
};

const option = (p: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
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
  return_dep_time: '17:05',
  return_arr_time: '18:35',
  booking_url: 'https://gf.example/lga-yyz-185',
  itinerary_key: params.itinerary_key,
  outbound_airline: 'Air Canada',
  return_airline: 'Porter',
  outbound_flight_numbers: '1110',
  return_flight_numbers: '2210',
  outbound_stops: 0,
  return_stops: 1,
  return_origin: null,
  return_destination: null,
  ...p,
});

const payload = (points: OptionHistoryPayload['points'], p: Partial<PriceSnapshot> = {}) => ({
  option: option(p),
  points,
});

const manyPoints = [
  { scraped_at: '2026-07-15T07:00:00Z', price_usd: 203 },
  { scraped_at: '2026-07-15T08:00:00Z', price_usd: 197 },
  { scraped_at: '2026-07-15T09:00:00Z', price_usd: 207 },
  { scraped_at: '2026-07-15T10:00:00Z', price_usd: 194 },
  { scraped_at: '2026-07-15T11:00:00Z', price_usd: 191 },
  { scraped_at: '2026-07-15T12:00:00Z', price_usd: 185 },
];

function renderDetail() {
  return render(
    <AuthProvider>
      <OptionDetail params={params} />
    </AuthProvider>,
  );
}

describe('OptionDetail', () => {
  beforeEach(() => {
    api.session = vi.fn().mockResolvedValue({ authenticated: true });
  });

  it('shows a loading skeleton while fetching', async () => {
    api.optionHistory = vi.fn().mockReturnValue(new Promise(() => {}));
    renderDetail();
    expect(screen.getByText(/loading price history/i)).toBeInTheDocument();
    // flush the AuthProvider session promise so no state update lands post-test
    await act(async () => {});
  });

  it('renders both legs, real return times, stats, chart, and the verbatim link', async () => {
    api.optionHistory = vi.fn().mockResolvedValue(payload(manyPoints));
    renderDetail();

    // heading + focus target
    const heading = await screen.findByRole('heading', { name: /LGA → YYZ/ });
    expect(heading).toHaveFocus();

    // outbound and return leg cards with wall-clock times
    const outbound = screen.getByRole('region', { name: /outbound leg/i });
    expect(outbound).toHaveTextContent('6:30 PM');
    expect(outbound).toHaveTextContent('Air Canada');
    expect(outbound).toHaveTextContent('1110');
    expect(outbound).toHaveTextContent('Nonstop');
    const ret = screen.getByRole('region', { name: /return leg/i });
    expect(ret).toHaveTextContent('5:05 PM'); // return times render for real now
    expect(ret).toHaveTextContent('Porter');
    expect(ret).toHaveTextContent('1 stop');

    // stats over the option's OWN history: min 185, max 207, median 195(.5→196)
    expect(screen.getByText('Low').nextSibling).toHaveTextContent('$185');
    expect(screen.getByText('High').nextSibling).toHaveTextContent('$207');
    expect(screen.getByText('Median').nextSibling).toHaveTextContent('$196');
    expect(screen.getByText('Checks').nextSibling).toHaveTextContent('6');
    // current price is at the series low → flagged
    expect(screen.getByText('At its low')).toBeInTheDocument();

    // chart present with an accessible description + data-table alternative
    expect(screen.getByRole('img', { name: /line chart of the tracked price/i })).toBeInTheDocument();
    expect(screen.getByText(/view as data table/i)).toBeInTheDocument();

    // booking link verbatim
    expect(screen.getByRole('link', { name: 'View on Google Flights' })).toHaveAttribute(
      'href',
      'https://gf.example/lga-yyz-185',
    );
  });

  it('degrades to "just started tracking" for a single-point history', async () => {
    api.optionHistory = vi
      .fn()
      .mockResolvedValue(payload([{ scraped_at: '2026-07-15T12:00:00Z', price_usd: 185 }]));
    renderDetail();
    expect(await screen.findByText(/just started tracking/i)).toBeInTheDocument();
    expect(screen.getByText(/one price reading so far/i)).toBeInTheDocument();
    // no misleading one-dot chart axis
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders "n/a" (not a crash) when an old row has null return times', async () => {
    api.optionHistory = vi.fn().mockResolvedValue(
      payload(manyPoints, {
        return_dep_time: null,
        return_arr_time: null,
        return_airline: null,
        return_flight_numbers: null,
        return_stops: null,
      }),
    );
    renderDetail();
    const ret = await screen.findByRole('region', { name: /return leg/i });
    expect(ret).toHaveTextContent(/n\/a/);
    expect(ret).toHaveTextContent(/stops n\/a/);
  });

  it('omits the booking link entirely when booking_url is null', async () => {
    api.optionHistory = vi.fn().mockResolvedValue(payload(manyPoints, { booking_url: null }));
    renderDetail();
    await screen.findByRole('heading', { name: /LGA → YYZ/ });
    expect(screen.queryByRole('link', { name: /view on google flights/i })).toBeNull();
  });

  it('shows the not-found state (with a way back) on a 404', async () => {
    api.optionHistory = vi.fn().mockRejectedValue(new ApiError(404, 'option_not_found'));
    renderDetail();
    expect(await screen.findByText(/isn’t on the board/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to the board/i })).toHaveAttribute('href', '#/');
  });

  it('shows the error state with a retry on server failure, and retries', async () => {
    api.optionHistory = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, 'internal_error'))
      .mockResolvedValueOnce(payload(manyPoints));
    renderDetail();
    const retry = await screen.findByRole('button', { name: /try again/i });
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: /LGA → YYZ/ })).toBeInTheDocument();
  });

  // this test must run before any other test in this file calls parseOptionHash: it
  // relies on route.ts's tracking never having seen a hash change, i.e. a fresh page
  // load straight into a deep-linked detail URL, which has no "previous route" at all
  it('back link falls back to the "#/" href when there is no prior route (deep link)', async () => {
    api.optionHistory = vi.fn().mockResolvedValue(payload(manyPoints));
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    renderDetail();
    await screen.findByRole('heading', { name: /LGA → YYZ/ });
    const back = screen.getByRole('link', { name: /back to the board/i });
    expect(back).toHaveAttribute('href', '#/');
    // dispatchEvent (what fireEvent wraps) returns true when nothing called preventDefault,
    // i.e. the browser is left free to follow the href — the desired fallback behavior here
    const notPrevented = fireEvent.click(back);
    expect(notPrevented).toBe(true);
    expect(backSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
  });

  it('back link uses history.back() (not the href) when the user arrived from the board', async () => {
    // simulate what App.tsx does on real navigation: board hash, then this option's hash
    parseOptionHash('#/');
    parseOptionHash(optionHash(params));
    api.optionHistory = vi.fn().mockResolvedValue(payload(manyPoints));
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    renderDetail();
    await screen.findByRole('heading', { name: /LGA → YYZ/ });
    // dispatchEvent returns false when a handler called preventDefault — confirms the
    // onClick suppressed the href navigation instead of letting it fall through
    const notPrevented = fireEvent.click(screen.getByRole('link', { name: /back to the board/i }));
    expect(notPrevented).toBe(false);
    expect(backSpy).toHaveBeenCalledTimes(1);
    backSpy.mockRestore();
  });

  it('shows the header note and Return leg highlight for a mixed option', async () => {
    api.optionHistory = vi.fn().mockResolvedValue(
      payload(manyPoints, { return_origin: 'YTZ', return_destination: 'JFK' }),
    );
    renderDetail();
    await screen.findByRole('heading', { name: /LGA → YYZ/ });

    expect(screen.getByText(/returns YTZ → JFK/)).toBeInTheDocument();

    const outbound = screen.getByRole('region', { name: /outbound leg/i });
    expect(outbound).toHaveTextContent('LGA → YYZ');

    const ret = screen.getByRole('region', { name: /return leg/i });
    expect(ret).toHaveTextContent('YTZ → JFK');
    expect(ret).toHaveTextContent('different airports');
  });

  it('shows neither the header note nor the Return leg highlight for a symmetric option', async () => {
    api.optionHistory = vi.fn().mockResolvedValue(
      payload(manyPoints, { return_origin: 'YYZ', return_destination: 'LGA' }),
    );
    renderDetail();
    await screen.findByRole('heading', { name: /LGA → YYZ/ });

    expect(screen.queryByText(/returns/i)).toBeNull();

    const ret = screen.getByRole('region', { name: /return leg/i });
    expect(ret).toHaveTextContent('YYZ → LGA');
    expect(ret).not.toHaveTextContent('different airports');
  });

  it('back link opens in new tab on cmd/ctrl+click (does not call history.back)', async () => {
    // simulate what App.tsx does on real navigation: board hash, then this option's hash
    parseOptionHash('#/');
    parseOptionHash(optionHash(params));
    api.optionHistory = vi.fn().mockResolvedValue(payload(manyPoints));
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    renderDetail();
    await screen.findByRole('heading', { name: /LGA → YYZ/ });
    // cmd+click should not prevent default, letting the browser open in new tab
    const notPrevented = fireEvent.click(screen.getByRole('link', { name: /back to the board/i }), { metaKey: true });
    expect(notPrevented).toBe(true);
    expect(backSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
  });
});
