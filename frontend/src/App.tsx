// Top-level shell. The dashboard is public: the topbar + Dashboard/Settings
// switch always render, regardless of auth status. "Sign out" only shows once
// authenticated (there's nothing to sign out of otherwise). Settings itself
// decides whether it's locked or editable based on auth status (see Settings.tsx).
// View is local state (this is a two-view personal tool, not a routed app); the
// ONE deep route is the per-option detail page, carried in the URL hash so board
// rows are real links.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

  // an option-detail route is a child of the board, so Dashboard is "current"
  // there too — same condition the Dashboard tab's own aria-current uses below,
  // kept in one place so the sliding indicator can never disagree with it.
  const activeTab: View = view === 'dashboard' || optionRoute ? 'dashboard' : 'settings';
  const dashboardTabRef = useRef<HTMLButtonElement>(null);
  const settingsTabRef = useRef<HTMLButtonElement>(null);
  const tabTrackRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  // measure the active tab's real geometry (not fixed widths — "Dashboard" and
  // "Settings" render at different widths) so the indicator can slide to it.
  // jsdom's getBoundingClientRect always returns an all-zero rect, so this is a
  // no-op (0/0) there rather than throwing — same pattern as useChartHoverCard.
  useLayoutEffect(() => {
    function measure() {
      const track = tabTrackRef.current;
      const btn = activeTab === 'dashboard' ? dashboardTabRef.current : settingsTabRef.current;
      if (!track || !btn) return;
      const trackRect = track.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicator({ left: btnRect.left - trackRect.left, width: btnRect.width });
    }
    measure();
    // the topbar's own responsive rules (brand-name hiding, flex-wrap) can shift
    // tab x-positions without a React re-render, so re-measure on resize too.
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeTab]);

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
            <div className="tab-track" ref={tabTrackRef}>
              <button
                ref={dashboardTabRef}
                className="tab"
                // an option-detail route is a child of the board, so Dashboard stays
                // current there regardless of the last tab-click view
                aria-current={view === 'dashboard' || optionRoute ? 'page' : undefined}
                onClick={() => goTo('dashboard')}
              >
                Dashboard
              </button>
              <button
                ref={settingsTabRef}
                className="tab"
                aria-current={!optionRoute && view === 'settings' ? 'page' : undefined}
                onClick={() => goTo('settings')}
              >
                Settings
              </button>
              {/* the one moving line — position/width are real measured px from the
                  layout effect above, never viewBox-style guesses */}
              <span
                className="tab-indicator"
                aria-hidden="true"
                style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
              />
            </div>
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
