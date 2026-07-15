import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheapestList } from '../CheapestList.tsx';
import type { RankedOption } from '../../lib/types';

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
