// Typed wrapper over the same-origin /api/* endpoints. The browser only ever talks
// to these routes; it never holds DATABASE_URL. A 401 is surfaced as a typed error
// so the auth layer can drop back to the login screen.
import type {
  OptionHistoryPayload,
  PollerHealth,
  Settings,
  SettingsInput,
  SnapshotsPayload,
} from './types.js';
import type { OptionParams } from './route.js';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    // network failure / server unreachable → distinct from an HTTP error
    throw new ApiError(0, 'network_error');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/session'),
  login: (password: string) =>
    request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  snapshots: () => request<SnapshotsPayload>('/api/snapshots'),
  optionHistory: (p: OptionParams) =>
    request<OptionHistoryPayload>(
      `/api/option-history?${new URLSearchParams({
        origin: p.origin,
        destination: p.destination,
        outbound_date: p.outbound_date,
        return_date: p.return_date,
        itinerary_key: p.itinerary_key,
      })}`,
    ),
  health: () => request<PollerHealth>('/api/health'),
  getSettings: () => request<Settings>('/api/settings'),
  putSettings: (input: SettingsInput) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }),
};
