import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App.tsx';
import { AuthProvider } from '../AuthProvider.tsx';
import { api, ApiError } from '../../lib/api.js';

const redactedSettings = {
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
  alert_email: null, // anonymous read: the server redacts this
  dry_run: true,
  updated_at: null,
};

const unlockedSettings = { ...redactedSettings, alert_email: 'me@example.com' };

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

describe('public dashboard / gated settings', () => {
  beforeEach(() => {
    api.login = vi.fn().mockResolvedValue({ ok: true });
    api.logout = vi.fn().mockResolvedValue({ ok: true });
    api.snapshots = vi.fn().mockResolvedValue({ latest: [], newest_scraped_at: null });
    api.health = vi
      .fn()
      .mockResolvedValue({ last_success: null, consecutive_failures: 0, newest_scraped_at: null });
    // anonymous by default; individual tests override where they need a session
    api.session = vi.fn().mockResolvedValue({ authenticated: false });
    api.getSettings = vi.fn().mockResolvedValue(redactedSettings);
  });

  it('renders the dashboard for an anonymous visitor with no password prompt', async () => {
    renderApp();
    expect(await screen.findByText(/no fares on the board/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    // no session yet → nothing to sign out of
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('shows a locked settings form with an "Unlock to edit" prompt', async () => {
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /^settings$/i }));

    expect(await screen.findByRole('button', { name: /unlock to edit/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save settings$/i })).not.toBeInTheDocument();
    // the editable fieldset is disabled — the dry-run toggle is one of its controls
    expect(screen.getByRole('checkbox', { name: /dry run/i })).toBeDisabled();
  });

  it('unlocks the form for editing on the correct password', async () => {
    // getSettings' return depends on whether login has resolved yet, rather than
    // on call count — the auth-status effect can refire more than once on the
    // loading→anonymous→authenticated path, and the real server keys off the
    // session cookie the same way, not off "which fetch number this is".
    let authenticated = false;
    api.login = vi.fn().mockImplementation(async () => {
      authenticated = true;
      return { ok: true };
    });
    api.getSettings = vi
      .fn()
      .mockImplementation(async () => (authenticated ? unlockedSettings : redactedSettings));

    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    await screen.findByRole('button', { name: /unlock to edit/i });

    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /unlock to edit/i }));

    // the session flips, settings reload with the real email, and the form
    // remounts editable (Save bar back, dry-run toggle enabled).
    expect(await screen.findByRole('button', { name: /^save settings$/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/alert email/i)).toHaveValue('me@example.com'));
    expect(screen.getByRole('checkbox', { name: /dry run/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('shows a clear message on a wrong password', async () => {
    api.login = vi.fn().mockRejectedValue(new ApiError(401, 'invalid_credentials'));
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    await screen.findByRole('button', { name: /unlock to edit/i });

    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /unlock to edit/i }));
    expect(await screen.findByText(/not right/i)).toBeInTheDocument();
    // a failed unlock leaves the form locked
    expect(screen.getByRole('checkbox', { name: /dry run/i })).toBeDisabled();
  });
});
