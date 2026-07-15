import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deriveHealth } from '../../lib/health.js';
import type { PollerHealth } from '../../lib/types.js';
import {
  EmptyState,
  ErrorState,
  FailingBanner,
  StaleBanner,
} from '../state/States.tsx';

const NOW = new Date('2026-07-14T18:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

describe('deriveHealth', () => {
  it('flags stale when the last success is older than the threshold', () => {
    const h: PollerHealth = { last_success: iso(30), consecutive_failures: 0, newest_scraped_at: null };
    const s = deriveHealth(h, null, NOW);
    expect(s.stale).toBe(true);
    expect(s.failing).toBe(false);
  });

  it('flags failing when consecutive failures cross the threshold', () => {
    const h: PollerHealth = { last_success: iso(1), consecutive_failures: 5, newest_scraped_at: null };
    const s = deriveHealth(h, null, NOW);
    expect(s.failing).toBe(true);
    expect(s.stale).toBe(false);
  });

  it('falls back to the newest snapshot when last_success is null', () => {
    const h: PollerHealth = { last_success: null, consecutive_failures: 0, newest_scraped_at: iso(10) };
    const s = deriveHealth(h, iso(10), NOW);
    expect(s.stale).toBe(true);
    expect(s.lastDataIso).toBe(iso(10));
  });

  it('is neither stale nor failing when fresh and healthy', () => {
    const h: PollerHealth = { last_success: iso(1), consecutive_failures: 0, newest_scraped_at: iso(1) };
    const s = deriveHealth(h, iso(1), NOW);
    expect(s.stale).toBe(false);
    expect(s.failing).toBe(false);
  });
});

describe('state components', () => {
  it('empty state explains no data yet', () => {
    render(<EmptyState />);
    expect(screen.getByText(/no fares on the board/i)).toBeInTheDocument();
  });

  it('error state retries on click', async () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('stale and failing read as distinct signals', () => {
    const { unmount } = render(<StaleBanner lastDataIso={iso(30)} />);
    expect(screen.getByText(/last confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/delayed/i)).toBeInTheDocument();
    unmount();
    render(<FailingBanner lastDataIso={iso(4)} />);
    expect(screen.getByText(/failed in a row/i)).toBeInTheDocument();
    expect(screen.getByText(/disrupted/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
