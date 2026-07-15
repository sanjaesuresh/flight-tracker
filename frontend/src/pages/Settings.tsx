// Loads the single settings row, then hands it to the form. Loading and error are
// first-class here too, so the settings screen is never a blank flash.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api, ApiError } from '../lib/api.js';
import type { Settings } from '../lib/types.js';
import { SettingsForm } from '../components/SettingsForm.tsx';
import { ErrorState, LoadingState } from '../components/state/States.tsx';

export function SettingsPage() {
  const { markLoggedOut } = useAuth();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [settings, setSettings] = useState<Settings | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setSettings(await api.getSettings());
      setStatus('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        markLoggedOut();
        return;
      }
      setStatus('error');
    }
  }, [markLoggedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'error' || !settings) return <ErrorState onRetry={() => void load()} />;
  // key by updated_at so a fresh load re-seeds the form's internal draft state.
  return <SettingsForm key={settings.updated_at ?? 'initial'} initial={settings} />;
}
