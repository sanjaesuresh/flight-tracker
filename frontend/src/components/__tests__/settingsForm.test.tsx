import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsForm } from '../SettingsForm.tsx';
import { AuthProvider } from '../../auth/AuthProvider.tsx';
import { api } from '../../lib/api';
import type { Settings } from '../../lib/types';

const base: Settings = {
  origins: ['JFK', 'LGA'],
  destinations: ['YYZ', 'YTZ'],
  preferred_origin: 'LGA',
  preferred_destination: 'YYZ',
  patterns: [
    {
      outbound_weekday: 3,
      outbound_start: '17:00',
      outbound_end: '23:59',
      return_weekday: 6,
      return_start: null,
      return_end: null,
    },
  ],
  window_days: 60,
  threshold_usd: 250,
  drop_pct: 20,
  realert_step_pct: 5,
  realert_step_dollars: 10,
  min_history_days: 5,
  alert_email: null,
  dry_run: true,
  updated_at: '2026-07-14T12:00:00Z',
};

function renderForm() {
  return render(
    <AuthProvider>
      <SettingsForm initial={base} />
    </AuthProvider>,
  );
}

describe('SettingsForm', () => {
  beforeEach(() => {
    // keep AuthProvider's mount session check quiet; override save per test
    api.session = vi.fn().mockResolvedValue({ authenticated: true });
    api.putSettings = vi.fn();
  });

  it('blocks save on an invalid threshold', async () => {
    renderForm();
    const threshold = screen.getByLabelText(/alert threshold/i);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '0');
    expect(await screen.findByText(/greater than 0/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
  });

  it('saves a valid edit with exactly the edited value', async () => {
    (api.putSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...base,
      threshold_usd: 300,
      updated_at: '2026-07-14T13:00:00Z',
    });
    renderForm();
    const threshold = screen.getByLabelText(/alert threshold/i);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '300');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1));
    expect(api.putSettings).toHaveBeenCalledWith(expect.objectContaining({ threshold_usd: 300 }));
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
  });

  it('round-trips the dry-run toggle', async () => {
    renderForm();
    expect(screen.getByText(/no real emails are sent/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /dry run/i }));
    expect(screen.getByText(/emails will send/i)).toBeInTheDocument();
  });

  it('makes an end-before-start window impossible to save', async () => {
    renderForm();
    // <input type="time"> is segmented; set its value directly rather than typing.
    const [obUntil] = screen.getAllByLabelText(/outbound window until/i);
    const [obFrom] = screen.getAllByLabelText(/outbound window from/i);
    fireEvent.change(obFrom, { target: { value: '20:00' } });
    fireEvent.change(obUntil, { target: { value: '08:00' } });
    expect(await screen.findByText(/outbound window end is before/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
  });
});
