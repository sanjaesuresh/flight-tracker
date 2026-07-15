"""Poll orchestration: wires every already-tested module into one cycle and
enforces the CI exit-code contract (see run_poll's docstring for the exact
rule). No new business logic lives here -- this module only sequences calls
into patterns/db/snapshots/rules/emailer and decides what counts as success.
"""
import logging
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from poller.config import Config, load_config
from poller.data_source.fli_source import FliSource

# GoogleFlightsSource (fast-flights) stays importable as the documented
# fallback -- see RUNBOOK.md's degrade path if fli's reverse-engineered API
# breaks. Not wired up as the default below (Phase 2: fli is the default).
from poller.data_source.google_flights import GoogleFlightsSource  # noqa: F401
from poller.db import (
    fetch_settings,
    get_connection,
    get_last_alert_price,
    get_poller_state,
    history_for_od,
    record_alert,
    set_poller_state,
)
from poller.emailer import send_alerts, send_smtp
from poller.models import SearchRequest, Trip
from poller.patterns import expand_patterns, trip_matches_windows
from poller.rules import best_per_identity, deal_identity, evaluate
from poller.snapshots import history_for_pair, prune_snapshots, write_snapshots

NY_TZ = ZoneInfo("America/New_York")
PAIR_HISTORY_DAYS = 14
PATTERN_HISTORY_DAYS = 14

logger = logging.getLogger(__name__)


def _date_pair_key(request):
    """(outbound_date, return_date) -- Phase 3: expand_patterns now emits one
    matrix candidate per date-pair (not per O-D pair), so pattern lookup must
    key on dates alone; airports no longer identify a candidate.
    """
    return (request.outbound_date, request.return_date)


def _od_code(origin: str, destination: str) -> str:
    """"JFK->YYZ"-style code for logging -- never the full request/offer/dates."""
    return f"{origin}->{destination}"


def log_settings_warnings(warnings: list[str]) -> None:
    """Logs fetch_settings' parse warnings. Separated from run_poll so it can
    be exercised (and asserted email-free) without a full poll cycle -- these
    warnings only ever quote a rejected raw pattern/threshold value, never
    settings.alert_email, but that's still worth a dedicated log call/test
    rather than folding it into run_poll's own counts-only summary line.
    """
    for warning in warnings:
        logger.warning("settings warning: %s", warning)


def run_poll(config: Config, source, now: datetime, connect=get_connection, transport=None) -> int:
    """Runs one poll cycle and returns the process exit code.

    Connection lifecycle (bracketing fix for the Neon-idle-timeout bug):
    `source.confirm_candidates` (the fli scrape) takes ~12 minutes and does NO
    database work, but Neon's free-tier compute suspends after ~5 minutes of
    connection idle -- a single connection held open across that gap is dead
    by the time the write/evaluate phase needs it. So run_poll never holds a
    connection across the scrape. It owns two short-lived connections instead
    of one long one:
      1. a READ connection: settings + poller_state, then closed.
      2. the scrape itself, with NO connection open at all.
      3. a fresh WRITE connection (which also wakes Neon's compute back up)
         for write_snapshots, prune, the evaluate loop, alert send/record, and
         the final poller_state update -- then closed.
    `connect` defaults to poller.db.get_connection but is injectable so tests
    can hand back fakes without a real DB.

    Exit-code / success rule (see the module contract in the Task 10 brief):
    total failure iff every attempted search raised. confirm_candidates
    reports this directly as failed_count (see google_flights.py) rather
    than via offer counts -- a healthy source can legitimately find zero
    offers for every candidate in a slice (e.g. nothing on sale right now),
    and that is a SUCCESSFUL poll, not a failure: last_success updates and
    consecutive_failures resets. Only "the source raised on every single
    attempted candidate" counts as a TOTAL failure. Anything else (at least
    one search didn't raise, regardless of how many offers it returned) is
    success, and exits 0 -- write_snapshots' own per-request commit already
    guarantees whatever DID succeed is durable even if other requests in the
    same slice failed.
    """
    today = now.astimezone(NY_TZ).date()

    # 1. READ BURST: open a short-lived connection just long enough to read
    # settings + poller_state, then close it before the long scrape starts.
    read_conn = connect(config)
    try:
        settings, warnings = fetch_settings(read_conn)
        log_settings_warnings(warnings)
        poller_state = get_poller_state(read_conn)
    finally:
        read_conn.close()

    # 2. expand this cycle's candidate requests, keeping a lookup back to each
    # request's originating pattern (needed later to check offer time windows).
    candidates = expand_patterns(settings, today)
    request_list = [request for request, _pattern in candidates]
    pattern_by_key = {_date_pair_key(request): pattern for request, pattern in candidates}

    # 3. confirm a budget-limited slice of the candidates via the rotating
    # cursor. NO connection is open during this call -- that's the fix.
    cursor = poller_state["cursor"]
    results, next_cursor, failed_count = source.confirm_candidates(request_list, cursor)

    # 4. WRITE BURST: open a fresh connection (this also wakes Neon's compute
    # back up) for everything else, then close it once the cycle is done.
    write_conn = connect(config)
    try:
        # 4a. snapshots are price history, independent of alert eligibility --
        # store everything scraped this cycle regardless of whether it
        # matches a pattern window.
        write_result = write_snapshots(write_conn, now, results)

        # 4b. retention is best-effort maintenance, not part of the poll's
        # success contract -- a prune error must never turn a successful poll
        # into a failure, so it's caught and logged (no PII) rather than
        # propagated.
        try:
            prune_snapshots(write_conn, now)
        except Exception as exc:
            logger.warning("snapshot prune failed: %s", type(exc).__name__)

        # total failure iff every attempted search raised (see docstring above).
        attempted = len(results)
        is_total_failure = attempted > 0 and failed_count == attempted

        # 4c. alert-eligible trips: only offers whose departure times fall
        # inside their originating pattern's window are candidates for an
        # alert at all.
        matching_trips: list[Trip] = []
        for request, offers in results:
            pattern = pattern_by_key.get(_date_pair_key(request))
            if pattern is None:
                continue
            for offer in offers:
                if trip_matches_windows(offer, pattern):
                    # Phase 3: a matrix request's offers can each land on
                    # different ACTUAL airports -- build a concrete per-offer
                    # request carrying the offer's true origin/destination (not
                    # the matrix request's representative pair) so downstream
                    # history_for_pair, deal_identity, and record_alert all key
                    # on the real airports. Falls back to the request's
                    # representative pair only if the offer left them unset
                    # (legacy null case).
                    offer_request = SearchRequest(
                        origin=offer.origin or request.origin,
                        destination=offer.destination or request.destination,
                        outbound_date=request.outbound_date,
                        return_date=request.return_date,
                    )
                    matching_trips.append(Trip(offer=offer, request=offer_request, pattern=pattern))

        candidates_to_alert = best_per_identity(matching_trips)

        # 4d. evaluate each candidate against pair-level history, pattern-level
        # history, and the last alerted price for that same identity (re-alert dedup).
        firing_pairs = []
        for trip in candidates_to_alert:
            pair_history = history_for_pair(
                write_conn, trip.request.origin, trip.request.destination,
                trip.request.outbound_date, trip.request.return_date, PAIR_HISTORY_DAYS,
            )
            pattern_history = history_for_od(
                write_conn, trip.request.origin, trip.request.destination, PATTERN_HISTORY_DAYS
            )
            last_alert_price = get_last_alert_price(write_conn, deal_identity(trip))
            decision = evaluate(trip, settings, pair_history, pattern_history, last_alert_price)
            if decision.fires:
                firing_pairs.append((trip, decision))

        # 4e. send. transport defaults to the real SMTP path only when the
        # caller didn't inject one (production); tests always inject a stub
        # so no network/SMTP call ever happens under test.
        if transport is None:
            transport = lambda from_addr, to_addr, subject, text_body, html_body: send_smtp(
                from_addr, to_addr, subject, text_body, html_body, config
            )
        alert_results = send_alerts(firing_pairs, settings, config, transport)

        # 4f. record only alerts that were actually SENT live. Dry-run sends
        # nothing (send_alerts short-circuits before transport), so nothing is
        # recorded for it either -- there is nothing to dedup against next
        # time, which is fine: dry-run previews are meant to repeat every
        # cycle, not be deduped like a real send.
        for (trip, decision), alert_result in zip(firing_pairs, alert_results):
            if alert_result.sent:
                record_alert(write_conn, trip, decision, now)

        # 4g. update poller_state and compute the exit code.
        # Phase 3: a matrix request's representative O-D code is no longer
        # informative on its own (candidates now carry whole airport lists) --
        # log the DISTINCT ACTUAL O-D pairs seen across this cycle's results
        # instead, falling back to the request's representative pair for any
        # offer that left its own airports unset. Dates/email are never logged.
        od_codes = sorted(
            {
                _od_code(offer.origin or request.origin, offer.destination or request.destination)
                for request, offers in results
                for offer in offers
            }
        )
        logger.info(
            "poll cycle: %d candidates, %d requests processed, %d failed (raised), "
            "%d snapshot rows written (%d request(s) failed to write), "
            "%d alerts fired, %d alerts sent, pairs=%s",
            len(request_list), len(results), failed_count,
            write_result.written, write_result.failed_requests,
            len(firing_pairs), sum(1 for r in alert_results if r.sent), od_codes,
        )

        if is_total_failure:
            consecutive_failures = poller_state["consecutive_failures"] + 1
            set_poller_state(write_conn, consecutive_failures=consecutive_failures, cursor=next_cursor)
            logger.warning("poll cycle TOTAL FAILURE (consecutive_failures=%d)", consecutive_failures)
            return 2 if consecutive_failures >= 3 else 1

        set_poller_state(write_conn, last_success=now, consecutive_failures=0, cursor=next_cursor)
        return 0
    finally:
        write_conn.close()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    config = load_config()
    source = FliSource()
    now = datetime.now(NY_TZ)
    return run_poll(config, source, now, connect=get_connection)


if __name__ == "__main__":
    sys.exit(main())
