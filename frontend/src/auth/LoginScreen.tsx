// Logged-out screen, styled as a boarding pass. One password field for the single
// user; a wrong password gets a clear but non-leaky message.
import { useState } from 'react';
import { useAuth, ApiError } from './AuthProvider.tsx';
import { BrandMark } from '../components/BrandMark.tsx';

export function LoginScreen() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('That password is not right.');
      } else {
        setError('Could not sign in. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="pass">
        <div className="pass-stub">
          <div className="brand">
            <BrandMark size={18} />
            Flight watch
          </div>
          <span className="gate">NYC⇄YYZ</span>
        </div>
        <div className="pass-body">
          <div className="row">BOARDING PASS · PRIVATE · ONE PASSENGER</div>
          <form onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input
                id="pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'pw-error' : undefined}
                autoFocus
              />
              {error && (
                <span className="error" id="pw-error" role="alert">
                  {error}
                </span>
              )}
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
