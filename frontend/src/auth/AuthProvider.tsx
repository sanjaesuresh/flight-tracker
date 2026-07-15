// Session context. On mount it asks /api/session whether the httpOnly cookie is
// valid (the SPA can't read the cookie itself). login()/logout() hit the server
// and flip local state; any 401 elsewhere calls markLoggedOut() to drop to login.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError } from '../lib/api.ts';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: AuthStatus;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  markLoggedOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    let active = true;
    api
      .session()
      .then((r) => active && setStatus(r.authenticated ? 'authenticated' : 'anonymous'))
      .catch(() => active && setStatus('anonymous'));
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (password: string) => {
    // let ApiError(401) propagate so the login form can show "wrong password".
    await api.login(password);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* clearing local state matters more than the network result */
    }
    setStatus('anonymous');
  }, []);

  const markLoggedOut = useCallback(() => setStatus('anonymous'), []);

  return (
    <AuthContext.Provider value={{ status, login, logout, markLoggedOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ApiError };
