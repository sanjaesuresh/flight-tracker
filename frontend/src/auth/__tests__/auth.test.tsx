import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App.tsx';
import { AuthProvider } from '../AuthProvider.tsx';
import { api, ApiError } from '../../lib/api.js';

const emptySettings = {
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

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

describe('auth gate', () => {
  beforeEach(() => {
    api.login = vi.fn().mockResolvedValue({ ok: true });
    api.logout = vi.fn().mockResolvedValue({ ok: true });
    api.snapshots = vi.fn().mockResolvedValue({ latest: [], newest_scraped_at: null });
    api.health = vi
      .fn()
      .mockResolvedValue({ last_success: null, consecutive_failures: 0, newest_scraped_at: null });
    api.getSettings = vi.fn().mockResolvedValue(emptySettings);
  });

  it('shows the login screen when the session is invalid', async () => {
    api.session = vi.fn().mockResolvedValue({ authenticated: false });
    renderApp();
    expect(await screen.findByLabelText(/password/i)).toBeInTheDocument();
  });

  it('signs in and reveals the dashboard shell, then signs out', async () => {
    api.session = vi.fn().mockResolvedValue({ authenticated: false });
    renderApp();
    await userEvent.type(await screen.findByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // authenticated shell: nav tabs + the empty dashboard state
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(await screen.findByText(/no fares on the board/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(await screen.findByLabelText(/password/i)).toBeInTheDocument();
  });

  it('shows a clear message on a wrong password', async () => {
    api.session = vi.fn().mockResolvedValue({ authenticated: false });
    api.login = vi.fn().mockRejectedValue(new ApiError(401, 'invalid_credentials'));
    renderApp();
    await userEvent.type(await screen.findByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/not right/i)).toBeInTheDocument();
  });

  it('wordmark text is wrapped in a hideable span', async () => {
    api.session = vi.fn().mockResolvedValue({ authenticated: false });
    renderApp();
    await userEvent.type(await screen.findByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // the wordmark span needs a stable class so CSS can hide it below 680px
    const wordmark = await screen.findByText('Flight watch');
    expect(wordmark.className).toBe('brand-name');
  });
});
