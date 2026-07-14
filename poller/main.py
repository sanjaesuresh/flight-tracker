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
from poller.data_source.google_flights import GoogleFlightsSource
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
from poller.models import Settings, Trip
from poller.patterns import expand_patterns, trip_matches_windows
from poller.rules import best_per_identity, deal_identity, evaluate
from poller.snapshots import history_for_pair, write_snapshots

NY_TZ = ZoneInfo("America/New_York")
PAIR_HISTORY_DAYS = 14
PATTERN_HISTORY_DAYS = 14

logger = logging.getLogger(__name__)


def _request_key(request):
    """(origin, destination, outbound_date, return_date) -- SearchRequest is
    an unhashable dataclass, so callers key lookups on this tuple instead.
    """
    return (request.origin, request.destination, request.outbound_date, request.return_date)


def _od_code(request) -> str:
    """"JFK->YYZ"-style code for logging -- never the full request/offer."""
    return f"{request.origin}->{request.destination}"


def log_settings_warnings(warnings: list[str]) -> None:
    """Logs fetch_settings' parse warnings. Separated from run_poll so it can
    be exercised (and asserted email-free) without a full poll cycle -- these
    warnings only ever quote a rejected raw pattern/threshold value, never
    settings.alert_email, but that's still worth a dedicated log call/test
    rather than folding it into run_poll's own counts-only summary line.
    """
    for warning in warnings:
        logger.warning("settings warning: %s", warning)


def run_poll(conn, source, settings: Settings, config: Config, now: datetime, transport=None) -> int:
    """Runs one poll cycle and returns the process exit code.

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

    # 1. expand this cycle's candidate requests, keeping a lookup back to each
    # request's originating pattern (needed later to check offer time windows).
    candidates = expand_patterns(settings, today)
    request_list = [request for request, _pattern in candidates]
    pattern_by_key = {_request_key(request): pattern for request, pattern in candidates}

    # 2. confirm a budget-limited slice of the candidates via the rotating cursor.
    poller_state = get_poller_state(conn)
    cursor = poller_state["cursor"]
    results, next_cursor, failed_count = source.confirm_candidates(request_list, cursor)

    # 3. snapshots are price history, independent of alert eligibility -- store
    # everything scraped this cycle regardless of whether it matches a pattern window.
    write_result = write_snapshots(conn, now, results)

    # total failure iff every attempted search raised (see docstring above).
    attempted = len(results)
    is_total_failure = attempted > 0 and failed_count == attempted

    # 4. alert-eligible trips: only offers whose departure times fall inside
    # their originating pattern's window are candidates for an alert at all.
    matching_trips: list[Trip] = []
    for request, offers in results:
        pattern = pattern_by_key.get(_request_key(request))
        if pattern is None:
            continue
        for offer in offers:
            if trip_matches_windows(offer, pattern):
                matching_trips.append(Trip(offer=offer, request=request, pattern=pattern))

    candidates_to_alert = best_per_identity(matching_trips)

    # 5. evaluate each candidate against pair-level history, pattern-level
    # history, and the last alerted price for that same identity (re-alert dedup).
    firing_pairs = []
    for trip in candidates_to_alert:
        pair_history = history_for_pair(
            conn, trip.request.origin, trip.request.destination,
            trip.request.outbound_date, trip.request.return_date, PAIR_HISTORY_DAYS,
        )
        pattern_history = history_for_od(conn, trip.request.origin, trip.request.destination, PATTERN_HISTORY_DAYS)
        last_alert_price = get_last_alert_price(conn, deal_identity(trip))
        decision = evaluate(trip, settings, pair_history, pattern_history, last_alert_price)
        if decision.fires:
            firing_pairs.append((trip, decision))

    # 6. send. transport defaults to the real SMTP path only when the caller
    # didn't inject one (production); tests always inject a stub so no
    # network/SMTP call ever happens under test.
    if transport is None:
        transport = lambda from_addr, to_addr, subject, body: send_smtp(from_addr, to_addr, subject, body, config)
    alert_results = send_alerts(firing_pairs, settings, config, transport)

    # 7. record only alerts that were actually SENT live. Dry-run sends
    # nothing (send_alerts short-circuits before transport), so nothing is
    # recorded for it either -- there is nothing to dedup against next time,
    # which is fine: dry-run previews are meant to repeat every cycle, not
    # be deduped like a real send.
    for (trip, decision), alert_result in zip(firing_pairs, alert_results):
        if alert_result.sent:
            record_alert(conn, trip, decision, now)

    # 8. update poller_state and compute the exit code.
    od_codes = sorted({_od_code(request) for request in request_list})
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
        set_poller_state(conn, consecutive_failures=consecutive_failures, cursor=next_cursor)
        logger.warning("poll cycle TOTAL FAILURE (consecutive_failures=%d)", consecutive_failures)
        return 2 if consecutive_failures >= 3 else 1

    set_poller_state(conn, last_success=now, consecutive_failures=0, cursor=next_cursor)
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    config = load_config()
    conn = None
    try:
        conn = get_connection(config)
        settings, warnings = fetch_settings(conn)
        log_settings_warnings(warnings)

        source = GoogleFlightsSource()
        now = datetime.now(NY_TZ)
        return run_poll(conn, source, settings, config, now)
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
