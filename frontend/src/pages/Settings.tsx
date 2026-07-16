// Loads the single settings row, then hands it to the form. Loading and error are
// first-class here too, so the settings screen is never a blank flash. Anonymous
// visitors get the same row with alert_email redacted (see handlers.ts); the form
// renders it locked until the auth status flips to authenticated.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api, ApiError } from '../lib/api.js';
import type { Settings } from '../lib/types.js';
import { SettingsForm } from '../components/SettingsForm.tsx';
import { ErrorState, LoadingState } from '../components/state/States.tsx';

export function SettingsPage() {
  const { status: authStatus, markLoggedOut } = useAuth();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [settings, setSettings] = useState<Settings | null>(null);
  // bumps on every successful load; the auth-status effect below fires the
  // instant the session flips (before this fetch resolves), which briefly
  // renders the form with the new `locked` value but still-stale `settings` —
  // keying only on (locked, updated_at) wouldn't force a second remount once
  // the real data lands, because a GET never changes updated_at. loadId does.
  const [loadId, setLoadId] = useState(0);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setSettings(await api.getSettings());
      setLoadId((n) => n + 1);
      setStatus('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        markLoggedOut();
        return;
      }
      setStatus('error');
    }
  }, [markLoggedOut]);

  // reload whenever the auth status flips (e.g. anonymous → authenticated after
  // unlocking) so the unredacted email replaces the null placeholder.
  useEffect(() => {
    void load();
  }, [load, authStatus]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'error' || !settings) return <ErrorState onRetry={() => void load()} />;

  const locked = authStatus !== 'authenticated';
  // key by lock state + load generation so unlocking remounts the form and its
  // internal draft re-seeds from the freshly-loaded, now-unredacted settings.
  return <SettingsForm key={`${locked}-${loadId}`} initial={settings} locked={locked} />;
}
