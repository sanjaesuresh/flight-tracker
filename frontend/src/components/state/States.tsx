// First-class states in the board's own voice: LED status strips for stale/failing,
// and standby / out-of-service screens for empty / error. No decorative icons — the
// LED dot is the board's real status light.
import { formatTimestamp, formatAgo } from '../../lib/timezone.js';
import { STALE_HOURS } from '../../lib/health.js';

export function LoadingState() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading fares…</span>
      <div className="skeleton" style={{ height: 96 }} />
      <div className="skeleton" style={{ height: 200 }} />
      <div className="stack" style={{ gap: '0.5rem' }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 56 }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="state" role="status">
      <div className="state-tag">Standby</div>
      <h2>No fares on the board yet</h2>
      <p>
        Flight watch checks prices about once an hour. The first fares it posts will show up right
        here, cheapest at the top.
      </p>
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="state" role="alert">
      <div className="state-tag state-tag--bad">Out of service</div>
      <h2>Board offline</h2>
      <p>
        Flight watch couldn’t reach the fare database — a free database can take a moment to wake
        from sleep. Try again shortly.
      </p>
      <button className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

// Detail-page miss: the itinerary in the URL has no rows (mistyped link, or the
// option aged out of the keep-N/retention rules). A real state, never a blank.
export function OptionNotFoundState() {
  return (
    <div className="state" role="status">
      <div className="state-tag">Not tracked</div>
      <h2>This option isn’t on the board</h2>
      <p>
        Flight watch has no price history for this itinerary — it may have dropped out of the
        tracked set, or the link is out of date.
      </p>
      <a className="btn" href="#/">
        Back to the board
      </a>
    </div>
  );
}

export function StaleBanner({ lastDataIso }: { lastDataIso: string | null }) {
  return (
    <div className="status warn" role="status">
      <span className="led" aria-hidden="true" />
      <span className="word">Delayed</span>
      <span>
        Fares last confirmed{' '}
        {lastDataIso ? (
          <>
            <strong>{formatAgo(lastDataIso)}</strong> ({formatTimestamp(lastDataIso)})
          </>
        ) : (
          'at an unknown time'
        )}
        . Flight watch usually refreshes within {STALE_HOURS} hours.
      </span>
    </div>
  );
}

export function FailingBanner({ lastDataIso }: { lastDataIso: string | null }) {
  return (
    <div className="status bad" role="alert">
      <span className="led" aria-hidden="true" />
      <span className="word">Disrupted</span>
      <span>
        Several recent checks failed in a row — the fares below are the last that posted
        {lastDataIso ? <> ({formatAgo(lastDataIso)})</> : null}. This is the scraper itself failing,
        not just old data.
      </span>
    </div>
  );
}
