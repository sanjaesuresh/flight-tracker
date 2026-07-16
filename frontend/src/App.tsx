// Top-level shell. The dashboard is public: the topbar + Dashboard/Settings
// switch always render, regardless of auth status. "Sign out" only shows once
// authenticated (there's nothing to sign out of otherwise). Settings itself
// decides whether it's locked or editable based on auth status (see Settings.tsx).
// View is local state (this is a two-view personal tool, not a routed app); the
// ONE deep route is the per-option detail page, carried in the URL hash so board
// rows are real links.
import { useEffect, useState } from 'react';
import { useAuth } from './auth/AuthProvider.tsx';
import { BrandMark } from './components/BrandMark.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { OptionDetail } from './pages/OptionDetail.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { parseOptionHash } from './lib/route.js';

type View = 'dashboard' | 'settings';

export function App() {
  const { status, logout } = useAuth();
  const [view, setView] = useState<View>('dashboard');
  const [optionRoute, setOptionRoute] = useState(() => parseOptionHash(window.location.hash));

  // hash is the source of truth for the detail route (back/forward just work)
  useEffect(() => {
    const onHashChange = () => setOptionRoute(parseOptionHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // tab clicks always leave the detail route; clearing the hash fires the
  // listener above, so optionRoute needs no manual reset here.
  const goTo = (next: View) => {
    if (optionRoute) window.location.hash = '/';
    setView(next);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">Flight watch</span>
            <span className="route">NYC⇄YYZ</span>
          </div>
          <nav className="nav" aria-label="Primary">
            <button
              className="tab"
              // an option-detail route is a child of the board, so Dashboard stays
              // current there regardless of the last tab-click view
              aria-current={view === 'dashboard' || optionRoute ? 'page' : undefined}
              onClick={() => goTo('dashboard')}
            >
              Dashboard
            </button>
            <button
              className="tab"
              aria-current={!optionRoute && view === 'settings' ? 'page' : undefined}
              onClick={() => goTo('settings')}
            >
              Settings
            </button>
            {status === 'authenticated' && (
              <button className="btn btn-ghost" onClick={() => void logout()}>
                Sign out
              </button>
            )}
          </nav>
        </div>
      </header>
      <main className="main">
        {optionRoute ? (
          // key remounts the page when the target option changes, so state
          // (loading/focus) resets per navigation instead of leaking across
          <OptionDetail key={optionRoute.itinerary_key} params={optionRoute} />
        ) : view === 'dashboard' ? (
          <Dashboard />
        ) : (
          <SettingsPage />
        )}
      </main>
    </div>
  );
}
