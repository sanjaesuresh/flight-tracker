// The settings editor. Every field is validated with the shared contract that
// mirrors the poller's parse_settings, and Save is blocked while any error stands —
// so the form can never persist a value the poller would reject. The server
// re-normalizes on PUT as a final defense; this is the friendly first line.
// When `locked` (anonymous visitor), the editable sections sit in a disabled
// fieldset and the Save bar is swapped for a small password prompt that logs in
// in place — no navigation, no full-screen wall.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { api, ApiError } from '../lib/api.js';
import type { Settings, SettingsInput } from '../lib/types.js';
import {
  FIXED_DESTINATIONS,
  FIXED_ORIGINS,
  hasErrors,
  validateForm,
} from '../lib/settingsSchema.js';
import { formatTimestamp } from '../lib/timezone.js';
import { PatternEditor } from './PatternEditor.tsx';

function toInput(s: Settings): SettingsInput {
  // drop the server-managed updated_at so it isn't sent back or diffed against.
  const { updated_at: _ignored, ...rest } = s;
  return rest;
}

function NumberField({
  id,
  label,
  hint,
  value,
  error,
  onChange,
  min,
  step,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  error?: string;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        step={step ?? 1}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
      />
      {hint && !error && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="error" id={`${id}-err`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function SettingsForm({
  initial,
  locked = false,
}: {
  initial: Settings;
  locked?: boolean;
}) {
  const { login, markLoggedOut } = useAuth();
  const [saved, setSaved] = useState<Settings>(initial);
  const [draft, setDraft] = useState<SettingsInput>(toInput(initial));
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // tracks the pending "clear toast" timeout so it can be cancelled if the
  // component unmounts (e.g. navigating away) before the 3.2s delay elapses.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const errors = useMemo(() => validateForm(draft), [draft]);
  const invalid = hasErrors(errors);
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(toInput(saved)),
    [draft, saved],
  );

  const set = (patch: Partial<SettingsInput>) => setDraft((d) => ({ ...d, ...patch }));

  function toggleAirport(kind: 'origins' | 'destinations', code: string) {
    const list = draft[kind];
    const next = list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
    // keep the preferred choice valid if its airport was just removed.
    if (kind === 'origins' && !next.includes(draft.preferred_origin)) {
      set({ origins: next, preferred_origin: next[0] ?? '' });
    } else if (kind === 'destinations' && !next.includes(draft.preferred_destination)) {
      set({ destinations: next, preferred_destination: next[0] ?? '' });
    } else {
      set({ [kind]: next } as Partial<SettingsInput>);
    }
  }

  async function onSave() {
    if (invalid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.putSettings(draft);
      setSaved(result);
      setDraft(toInput(result));
      setToast('Settings saved. The next poll will use them.');
      // clear any prior pending timer first — back-to-back saves shouldn't leak timers
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 3200);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        markLoggedOut();
        return;
      }
      setSaveError('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    setUnlockError(null);
    setUnlocking(true);
    try {
      await login(unlockPassword);
      // AuthProvider flips status to 'authenticated'; the settings page reloads
      // with the real email and remounts this form via its lock-state key.
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // same non-leaky wording the old full-screen login used
        setUnlockError('That password is not right.');
      } else {
        setUnlockError('Could not sign in. Please try again.');
      }
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <div className="stack">
      <div className="section-head">
        <h2>Settings</h2>
        <span className="count">
          {saved.updated_at ? `Saved ${formatTimestamp(saved.updated_at)}` : 'Not yet saved'}
        </span>
      </div>

      {/* one fieldset disables every editable control at once when locked; the
          unlock prompt below stays outside it so it's never disabled by itself */}
      <fieldset disabled={locked} className="fieldset-reset">
      <section className="panel form-section" aria-labelledby="airports-h">
        <h3 id="airports-h">Airports</h3>
        <p className="hint" style={{ margin: '0.2rem 0 0.9rem' }}>
          The fixed set for now is JFK / LGA to YYZ / YTZ. Preferred airports are highlighted and
          ranked first — never shown exclusively.
        </p>
        <div className="form-grid">
          <fieldset className="field fieldset-reset">
            <legend className="legend-label">Origins (NYC)</legend>
            <div className="choice-set">
              {FIXED_ORIGINS.map((code) => (
                <label className="choice" key={code}>
                  <input
                    type="checkbox"
                    checked={draft.origins.includes(code)}
                    onChange={() => toggleAirport('origins', code)}
                  />
                  {code}
                </label>
              ))}
            </div>
            {errors.origins && (
              <span className="error" role="alert">
                {errors.origins}
              </span>
            )}
          </fieldset>

          <fieldset className="field fieldset-reset">
            <legend className="legend-label">Destinations (Toronto)</legend>
            <div className="choice-set">
              {FIXED_DESTINATIONS.map((code) => (
                <label className="choice" key={code}>
                  <input
                    type="checkbox"
                    checked={draft.destinations.includes(code)}
                    onChange={() => toggleAirport('destinations', code)}
                  />
                  {code}
                </label>
              ))}
            </div>
            {errors.destinations && (
              <span className="error" role="alert">
                {errors.destinations}
              </span>
            )}
          </fieldset>

          <div className="field">
            <label htmlFor="pref-o">Preferred origin</label>
            <select
              id="pref-o"
              value={draft.preferred_origin}
              onChange={(e) => set({ preferred_origin: e.target.value })}
            >
              {draft.origins.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {errors.preferred_origin && (
              <span className="error" role="alert">
                {errors.preferred_origin}
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="pref-d">Preferred destination</label>
            <select
              id="pref-d"
              value={draft.preferred_destination}
              onChange={(e) => set({ preferred_destination: e.target.value })}
            >
              {draft.destinations.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {errors.preferred_destination && (
              <span className="error" role="alert">
                {errors.preferred_destination}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="panel form-section" aria-labelledby="patterns-h">
        <h3 id="patterns-h">Trip patterns</h3>
        <p className="hint" style={{ margin: '0.2rem 0 0.9rem' }}>
          Weekday and time windows, in New York local time. A window whose end is before its start
          can’t be saved.
        </p>
        <PatternEditor patterns={draft.patterns} onChange={(patterns) => set({ patterns })} />
      </section>

      <section className="panel form-section" aria-labelledby="alerts-h">
        <h3 id="alerts-h">Window &amp; alert rules</h3>
        <div className="form-grid" style={{ marginTop: '0.8rem' }}>
          <NumberField
            id="window"
            label="Window length (days)"
            hint="How far ahead to watch"
            value={draft.window_days}
            error={errors.window_days}
            min={1}
            onChange={(v) => set({ window_days: v })}
          />
          <NumberField
            id="threshold"
            label="Alert threshold (USD)"
            hint="Alert when a round trip is below this"
            value={draft.threshold_usd}
            error={errors.threshold_usd}
            min={1}
            onChange={(v) => set({ threshold_usd: v })}
          />
          <NumberField
            id="drop"
            label="Drop sensitivity (%)"
            hint="Alert on a drop this far below the baseline"
            value={draft.drop_pct}
            error={errors.drop_pct}
            min={0}
            onChange={(v) => set({ drop_pct: v })}
          />
          <NumberField
            id="minhist"
            label="Min history (days)"
            hint="Baseline needs at least this much history"
            value={draft.min_history_days}
            error={errors.min_history_days}
            min={0}
            onChange={(v) => set({ min_history_days: v })}
          />
          <NumberField
            id="restep-pct"
            label="Re-alert step (%)"
            hint="Re-alert only after a further drop"
            value={draft.realert_step_pct}
            error={errors.realert_step_pct}
            min={0}
            onChange={(v) => set({ realert_step_pct: v })}
          />
          <NumberField
            id="restep-usd"
            label="Re-alert step (USD)"
            hint="…or this many dollars, whichever is larger"
            value={draft.realert_step_dollars}
            error={errors.realert_step_dollars}
            min={0}
            onChange={(v) => set({ realert_step_dollars: v })}
          />
        </div>
      </section>

      <section className="panel form-section" aria-labelledby="delivery-h">
        <h3 id="delivery-h">Delivery</h3>
        <div className="form-grid" style={{ marginTop: '0.8rem' }}>
          <div className="field">
            <label htmlFor="email">Alert email</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={draft.alert_email ?? ''}
              onChange={(e) => set({ alert_email: e.target.value || null })}
              aria-invalid={errors.alert_email ? true : undefined}
              aria-describedby={errors.alert_email ? 'email-err' : undefined}
            />
            {errors.alert_email && (
              <span className="error" id="email-err" role="alert">
                {errors.alert_email}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="dry" id="dry-label">
              Dry run
            </label>
            <label className="toggle" htmlFor="dry">
              <input
                id="dry"
                type="checkbox"
                checked={draft.dry_run}
                onChange={(e) => set({ dry_run: e.target.checked })}
              />
              <span>{draft.dry_run ? 'On — no real emails are sent' : 'Off — emails will send'}</span>
            </label>
          </div>
        </div>
      </section>

      {!locked && (
        <div className="save-bar">
          <button
            className="btn btn-primary"
            onClick={() => void onSave()}
            disabled={saving || invalid || !dirty}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {invalid && <span className="muted">Fix the highlighted fields to save.</span>}
          {!invalid && !dirty && <span className="muted">No unsaved changes.</span>}
          {saveError && (
            <span className="error" role="alert">
              {saveError}
            </span>
          )}
        </div>
      )}
      </fieldset>

      {locked && (
        <form className="save-bar" onSubmit={onUnlock}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="unlock-pw">Password</label>
            <input
              id="unlock-pw"
              type="password"
              autoComplete="current-password"
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
              aria-invalid={unlockError ? true : undefined}
              aria-describedby={unlockError ? 'unlock-pw-err' : undefined}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={unlocking || !unlockPassword}>
            {unlocking ? 'Unlocking…' : 'Unlock to edit'}
          </button>
          {unlockError && (
            <span className="error" id="unlock-pw-err" role="alert">
              {unlockError}
            </span>
          )}
        </form>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
