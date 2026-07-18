import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CheapestList } from '../CheapestList.tsx';
import { optionHashFor } from '../../lib/route.js';
import type { RankedOption } from '../../lib/types.js';

const option = (p: Partial<RankedOption>): RankedOption => ({
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
  preferred: false,
  ...p,
});

describe('CheapestList fare links', () => {
  it('links each fare using the item booking_url verbatim', () => {
    render(
      <CheapestList
        options={[
          option({ price_usd: 185, booking_url: 'https://gf.example/lga-yyz-185' }),
          option({ origin: 'JFK', destination: 'YTZ', price_usd: 150, booking_url: 'https://gf.example/jfk-ytz-150' }),
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: /185 US dollars, view on google flights/i });
    expect(link).toHaveAttribute('href', 'https://gf.example/lga-yyz-185');
    const link2 = screen.getByRole('link', { name: /150 US dollars, view on google flights/i });
    expect(link2).toHaveAttribute('href', 'https://gf.example/jfk-ytz-150');
  });

  it('renders the fare with no anchor when booking_url is null', () => {
    render(<CheapestList options={[option({ price_usd: 500, booking_url: null })]} />);
    expect(screen.getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('no link')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /500 US dollars/i })).toBeNull();
  });
});

describe('CheapestList detail links', () => {
  it('links a keyed row to its detail route, carrying key + airports + dates', () => {
    render(
      <CheapestList
        options={[option({ itinerary_key: 'AC1123.2026-08-06|AC2211.2026-08-09' })]}
      />,
    );
    const link = screen.getByRole('link', { name: /price history for LGA to YYZ/i });
    const href = link.getAttribute('href')!;
    expect(href.startsWith('#/option?')).toBe(true);
    const q = new URLSearchParams(href.slice('#/option?'.length));
    expect(q.get('key')).toBe('AC1123.2026-08-06|AC2211.2026-08-09');
    expect(q.get('origin')).toBe('LGA');
    expect(q.get('destination')).toBe('YYZ');
    expect(q.get('out')).toBe('2026-08-06');
    expect(q.get('ret')).toBe('2026-08-09');
  });

  it('renders NO detail link when itinerary_key is null (fallback rows)', () => {
    render(<CheapestList options={[option({ itinerary_key: null })]} />);
    expect(screen.queryByRole('link', { name: /price history/i })).toBeNull();
  });
});

describe('CheapestList row affordances', () => {
  it('(a) renders a Details link, accessible name containing "Details", hrefed to the option hash', () => {
    const o = option({ itinerary_key: 'AC1123.2026-08-06|AC2211.2026-08-09' });
    render(<CheapestList options={[o]} />);
    const link = screen.getByRole('link', { name: /details/i });
    expect(link).toHaveAttribute('href', optionHashFor(o)!);
  });

  it('(b) renders a Book link, accessible name containing "Book", exact booking_url href, new tab, noopener', () => {
    const o = option({ booking_url: 'https://gf.example/lga-yyz-185' });
    render(<CheapestList options={[o]} />);
    const link = screen.getByRole('link', { name: /book/i });
    expect(link).toHaveAttribute('href', 'https://gf.example/lga-yyz-185');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel') ?? '').toContain('noopener');
  });

  it('(c) renders the price as plain text, never inside an anchor', () => {
    render(<CheapestList options={[option({ price_usd: 222 })]} />);
    const priceText = screen.getByText('$222');
    expect(priceText.closest('a')).toBeNull();
  });

  it('(d) renders "No history yet" in the Details slot when itinerary_key is null', () => {
    render(<CheapestList options={[option({ itinerary_key: null })]} />);
    expect(screen.getByText('No history yet')).toBeInTheDocument();
  });

  it('(e) renders "no link" and no Book link when booking_url is null', () => {
    render(<CheapestList options={[option({ booking_url: null })]} />);
    expect(screen.getByText('no link')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /book/i })).toBeNull();
  });

  it('(f) clicking anywhere on a row with a details href navigates by setting window.location.hash', () => {
    const o = option({ itinerary_key: 'AC1123.2026-08-06|AC2211.2026-08-09' });
    render(<CheapestList options={[o]} />);
    window.location.hash = '';
    // click on plain cell text, not on any anchor/button, to prove the whole row is live
    fireEvent.click(screen.getByText(o.airline!));
    expect(window.location.hash).toBe(optionHashFor(o)!);
  });

  it('(g) clicking the Book link does not hijack row navigation (hash stays put)', () => {
    const o = option({
      itinerary_key: 'AC1123.2026-08-06|AC2211.2026-08-09',
      booking_url: 'https://gf.example/lga-yyz-185',
    });
    render(<CheapestList options={[o]} />);
    window.location.hash = '';
    fireEvent.click(screen.getByRole('link', { name: /book/i }));
    expect(window.location.hash).toBe('');
  });
});

describe('CheapestList mixed-route ret line', () => {
  it('renders a ret line with the return airports for a mixed option', () => {
    const { container } = render(
      <CheapestList options={[option({ return_origin: 'YTZ', return_destination: 'JFK' })]} />,
    );
    const retLine = container.querySelector('.route-ret');
    expect(retLine).not.toBeNull();
    expect(retLine).toHaveTextContent('ret');
    expect(retLine).toHaveTextContent('YTZ');
    expect(retLine).toHaveTextContent('JFK');
  });

  it('renders NO ret line for a symmetric option (mirrored return pair)', () => {
    const { container } = render(
      <CheapestList options={[option({ return_origin: 'YYZ', return_destination: 'LGA' })]} />,
    );
    expect(container.querySelector('.route-ret')).toBeNull();
  });
});

describe('CheapestList empty state', () => {
  it('shows no Clear filters button when onClearFilters is not provided', () => {
    render(<CheapestList options={[]} />);
    expect(screen.getByText(/no fares match/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull();
  });

  it('shows a Clear filters button when onClearFilters is provided, and clicking it calls the handler', () => {
    const onClearFilters = vi.fn();
    render(<CheapestList options={[]} onClearFilters={onClearFilters} />);
    const clear = screen.getByRole('button', { name: /clear filters/i });
    fireEvent.click(clear);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
